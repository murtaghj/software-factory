// The pod call guard (W-019, rule 4): every route that grants or changes state carries the lease clause in its own locked statement, and a fenced
// writer is refused. Every refusal has, in the same setup, the accepted case.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tokenAudience } from '../src/index.ts';
import { renewAllocationLease } from '@factory/database';
import { KubeError } from '../src/index.ts';
import { createEnv, hex, type Env, type Instance } from './harness.ts';

let e: Env;
beforeAll(async () => { e = await createEnv('w019_guard', { config: { podRate: { burst: 1000, intervalMs: 1 } } }); });
afterAll(async () => { await e.close(); });

const req = (token: string, allocationId: string, epoch = 1) => ({ token, orgId: e.a.orgId, allocationId, epoch });
const tok = (inst: Instance, pod: Parameters<Instance['kube']['mintToken']>[0], allocationId: string) => inst.kube.mintToken(pod, tokenAudience(e.a.orgId, allocationId));
const sql = (sqlText: string, params: unknown[] = []) => e.db.withTenant({ orgId: e.a.orgId }, (tx) => tx.query(sqlText, params));
const leaseMs = async (id: string): Promise<number> => (await e.allocation(e.a, id)).leaseRemainingMs ?? 0;
async function started(inst: Instance, o: { receipt?: boolean; workspace?: boolean } = {}) {
  const s = await e.newStage(e.a);
  const ws = o.workspace === false ? undefined : await e.newWorkspace(e.a, s, inst);
  await inst.runner.startOrAttach(e.ctx(e.a), e.input(e.a, s, ws ? { workspaceId: ws } : {}), hex('e'));
  const a = (await e.allocations(e.a, s)).at(-1) as NonNullable<Awaited<ReturnType<typeof e.allocations>>[number]>;
  const pod = inst.kube.driver.podsOf(a.jobName)[0] as NonNullable<ReturnType<typeof inst.kube.driver.podsOf>[number]>;
  if (o.receipt !== false) { if (ws) inst.kube.driver.initFinished(pod.metadata.name, { exitCode: 0, message: e.receiptMessage() }); else inst.kube.driver.startPod(pod.metadata.name); }
  return { s, ws, a, pod, token: tok(inst, pod, a.id) };
}
const running = async (inst: Instance, o: { workspace?: boolean } = {}) => {
  const x = await started(inst, o);
  expect(await inst.runner.acquireStartPermit(req(x.token, x.a.id))).toMatchObject({ granted: true });
  return x;
};
const stopped = async (inst: Instance, x: { a: { id: string } }) => { await sql("UPDATE factory.execution_allocation SET state = 'stopping', updated_at = clock_timestamp() WHERE id = $1", [x.a.id]); };

describe('W-019 the pod call guard', () => {
  it('for each route: a token for another allocation, another pod\'s token, a pod being deleted, a wrong epoch and a state outside the route are each their own denial; the right call is accepted', async () => {
    const inst = e.newRunner();
    const x = await running(inst);
    const y = await started(inst, { workspace: false }); // another allocation, and its pod
    // renew
    expect(await inst.runner.renewPermit(req(tok(inst, y.pod, y.a.id), x.a.id))).toMatchObject({ code: 'unauthenticated', reason: 'local_audience_mismatch' }); // another allocation's token
    expect(await inst.runner.renewPermit(req(tok(inst, x.pod, x.a.id), x.a.id, 2))).toMatchObject({ code: 'stale_epoch' });
    expect(await inst.runner.renewPermit(req(tok(inst, y.pod, y.a.id), y.a.id))).toMatchObject({ code: 'not_renewable', reason: 'starting' }); // a state outside the route: y has no permit yet
    // a duplicate pod of the same allocation is not the writer
    const dup = inst.kube.driver.addDuplicatePod(x.a.jobName);
    inst.kube.driver.initFinished(dup.metadata.name, { exitCode: 0, message: e.receiptMessage() });
    expect(await inst.runner.renewPermit(req(tok(inst, dup, x.a.id), x.a.id))).toMatchObject({ code: 'not_renewable', reason: 'not_the_writer' });
    expect(await inst.runner.acquireStartPermit(req(tok(inst, dup, x.a.id), x.a.id))).toMatchObject({ code: 'duplicate_writer', reason: 'running' }); // a duplicate while the writer runs, whatever the timing
    // stop-ack: only while stopping, only for the writer
    expect(await inst.runner.stopAck(req(tok(inst, x.pod, x.a.id), x.a.id))).toMatchObject({ code: 'not_renewable', reason: 'running' });
    // a pod with a deletion timestamp
    const live = inst.kube.pods.get(x.pod.metadata.name) as NonNullable<ReturnType<typeof inst.kube.pods.get>>;
    live.metadata.deletionTimestamp = inst.kube.now();
    expect(await inst.runner.renewPermit(req(tok(inst, x.pod, x.a.id), x.a.id))).toMatchObject({ code: 'not_this_job', reason: 'pod' });
    delete live.metadata.deletionTimestamp;
    // control: the right call is granted
    expect(await inst.runner.renewPermit(req(tok(inst, x.pod, x.a.id), x.a.id))).toMatchObject({ granted: true, harness: { state: 'running' } });
    // a call with no token writes nothing
    const rows = JSON.stringify(await e.tables(e.a));
    expect(await inst.runner.renewPermit(req('', x.a.id))).toMatchObject({ code: 'invalid_request' });
    expect(JSON.stringify(await e.tables(e.a))).toBe(rows);
  });

  it('a fenced writer: replaceWriter while the allocation runs; the next renewal is stale_epoch (not lease_expired), the lease does not move, and the next pass stops it with workspace_fenced', async () => {
    const inst = e.newRunner();
    const x = await running(inst);
    // control, a moment before the fence: granted
    expect(await inst.runner.renewPermit(req(tok(inst, x.pod, x.a.id), x.a.id))).toMatchObject({ granted: true });
    await sql('UPDATE factory.execution_allocation SET controller_lease_until = clock_timestamp() + interval \'20 seconds\' WHERE id = $1', [x.a.id]);
    const before = await leaseMs(x.a.id);
    await inst.workspaces.replaceWriter(e.runnerCtx(e.a), x.ws as string, 1);
    const denied = await inst.runner.renewPermit(req(tok(inst, x.pod, x.a.id), x.a.id));
    expect(denied).toMatchObject({ granted: false, code: 'stale_epoch' });
    expect(await leaseMs(x.a.id)).toBeLessThanOrEqual(before); // not extended
    await inst.runner.reconcileOne(e.a.orgId, x.a.id);
    expect((await e.allocation(e.a, x.a.id)).state).not.toBe('running');
    expect(await e.q(e.a, "SELECT details_ref->>'reason' AS r FROM factory.audit_event WHERE resource_id = $1 AND action = 'runner.allocation_stopping'", [x.a.id])).toEqual([{ r: 'workspace_fenced' }]);
  });

  it('lease, retry: the first acquire is granted, the lease is backdated past expiry, the same pod\'s retry is denied and nothing is extended; control: a retry on a fresh lease is granted and moves the lease', async () => {
    const inst = e.newRunner();
    const x = await running(inst, { workspace: false });
    await sql("UPDATE factory.execution_allocation SET controller_lease_until = clock_timestamp() + interval '5 seconds' WHERE id = $1", [x.a.id]);
    const near = await leaseMs(x.a.id);
    expect(await inst.runner.acquireStartPermit(req(tok(inst, x.pod, x.a.id), x.a.id))).toMatchObject({ granted: true }); // control
    expect(await leaseMs(x.a.id)).toBeGreaterThan(near + 30_000); // moved forward: the retry is the renewal statement
    await e.backdate(e.a, x.a.id, { leaseUntilSecondsAgo: 1 });
    expect(await inst.runner.acquireStartPermit(req(tok(inst, x.pod, x.a.id), x.a.id))).toMatchObject({ granted: false, code: 'not_startable', reason: 'lease_expired' });
    expect((await e.allocation(e.a, x.a.id)).leaseExpired).toBe(true); // nothing was extended
  });

  it('two acquires of one pod at once: the one held before its last transaction finds the row running under the lock, and its grant comes from the renewal statement (the lease moved again)', async () => {
    const inst = e.newRunner();
    const x = await started(inst, { workspace: false });
    const hold = inst.faults.holdAt('runner.before_permit_commit');
    const first = inst.runner.acquireStartPermit(req(tok(inst, x.pod, x.a.id), x.a.id));
    await hold.reached;
    expect(await inst.runner.acquireStartPermit(req(tok(inst, x.pod, x.a.id), x.a.id))).toMatchObject({ granted: true }); // the second commits first
    await sql("UPDATE factory.execution_allocation SET controller_lease_until = clock_timestamp() + interval '5 seconds' WHERE id = $1", [x.a.id]);
    hold.release();
    expect(await first).toMatchObject({ granted: true });
    expect(await leaseMs(x.a.id)).toBeGreaterThan(30_000); // refreshed by the held call's renewal statement
    expect(await e.q(e.a, "SELECT count(*)::int AS n FROM factory.audit_event WHERE action = 'runner.writer_start' AND resource_id = $1", [x.a.id])).toEqual([{ n: 1 }]);
  });

  it('lease, first commit: with the start deadline backdated the acquire is not_startable and the row stays starting, with no writer started; control: a fresh deadline is granted', async () => {
    const inst = e.newRunner();
    const late = await started(inst);
    await e.backdate(e.a, late.a.id, { leaseUntilSecondsAgo: 1 });
    expect(await inst.runner.acquireStartPermit(req(late.token, late.a.id))).toMatchObject({ granted: false, code: 'not_startable', reason: 'start_deadline' });
    expect((await e.allocation(e.a, late.a.id)).state).toBe('starting');
    expect((await e.workspace(e.a, late.ws as string)).state).not.toBe('active'); // no writer started
    const ok = await started(inst);
    expect(await inst.runner.acquireStartPermit(req(ok.token, ok.a.id))).toMatchObject({ granted: true });
  });

  it('stopping: a renewal for a stopping allocation whose workspace is already quiescing answers not_renewable with the state; stop-ack is accepted with the workspace active and with it quiescing, and refused in running', async () => {
    const inst = e.newRunner();
    const x = await running(inst);
    expect(await inst.runner.stopAck(req(tok(inst, x.pod, x.a.id), x.a.id))).toMatchObject({ granted: false, code: 'not_renewable' }); // refused in running
    await stopped(inst, x);
    // control for duplicate_writer: a second pod of a stopping allocation is merely not startable (exit 66)
    const dup = inst.kube.driver.addDuplicatePod(x.a.jobName);
    inst.kube.driver.initFinished(dup.metadata.name, { exitCode: 0, message: e.receiptMessage() });
    expect(await inst.runner.acquireStartPermit(req(tok(inst, dup, x.a.id), x.a.id))).toMatchObject({ granted: false, code: 'not_startable', reason: 'stopping' });
    expect(await inst.runner.stopAck(req(tok(inst, x.pod, x.a.id), x.a.id))).toEqual({ acknowledged: true, repeat: false }); // the workspace is active
    expect(await inst.runner.stopAck(req(tok(inst, x.pod, x.a.id), x.a.id))).toEqual({ acknowledged: true, repeat: true }); // a repeat finds the record
    await inst.workspaces.markWriterQuiescing(e.runnerCtx(e.a), x.ws as string, 1, x.pod.metadata.uid);
    expect(await inst.runner.stopAck(req(tok(inst, x.pod, x.a.id), x.a.id))).toMatchObject({ acknowledged: true }); // quiescing
    expect(await inst.runner.renewPermit(req(tok(inst, x.pod, x.a.id), x.a.id))).toMatchObject({ granted: false, code: 'not_renewable', reason: 'stopping' });
    expect(await e.q(e.a, "SELECT count(*)::int AS n FROM factory.audit_event WHERE action = 'runner.stop_ack' AND resource_id = $1", [x.a.id])).toEqual([{ n: 1 }]);
  });

  it('the statements carry the clauses themselves, not only the guard that read the row first: the renewal statement refuses a fenced workspace, and the first commit refuses a start deadline that passed after the claim', async () => {
    const inst = e.newRunner();
    const x = await running(inst);
    const renew = () => e.db.withTenant({ orgId: e.a.orgId }, (tx) => renewAllocationLease(tx, { orgId: e.a.orgId, id: x.a.id, ownerEpoch: 1, podUid: x.pod.metadata.uid, leaseSeconds: 60 }));
    expect(await renew()).toBeDefined(); // control: before the fence
    await inst.workspaces.replaceWriter(e.runnerCtx(e.a), x.ws as string, 1);
    expect(await renew()).toBeUndefined(); // no guard in front of it: the statement alone says no
    // the deadline passes between the claim and the last commit
    const y = await started(inst);
    const hold = inst.faults.holdAt('runner.before_permit_commit');
    const permit = inst.runner.acquireStartPermit(req(y.token, y.a.id));
    await hold.reached;
    await e.backdate(e.a, y.a.id, { leaseUntilSecondsAgo: 1 });
    hold.release();
    expect(await permit).toMatchObject({ granted: false, code: 'not_startable', reason: 'start_deadline' });
    expect((await e.allocation(e.a, y.a.id)).state).toBe('starting');
    const z = await started(inst); // control: no deadline problem, same hold, granted
    const hold2 = inst.faults.holdAt('runner.before_permit_commit');
    const ok = inst.runner.acquireStartPermit(req(z.token, z.a.id));
    await hold2.reached;
    hold2.release();
    expect(await ok).toMatchObject({ granted: true });
  });

  it('a duplicate that arrives after the winner\'s markWriterStarted is a duplicate_writer (the supervisor\'s exit 65), not a pod that is merely not startable; control: the winner is granted', async () => {
    const inst = e.newRunner();
    const x = await started(inst);
    const hold = inst.faults.holdAt('runner.after_writer_started'); // the winner has claimed the pod and started the workspace, and has not committed
    const winner = inst.runner.acquireStartPermit(req(x.token, x.a.id));
    await hold.reached;
    const dup = inst.kube.driver.addDuplicatePod(x.a.jobName);
    inst.kube.driver.initFinished(dup.metadata.name, { exitCode: 0, message: e.receiptMessage() });
    expect(await inst.runner.acquireStartPermit(req(tok(inst, dup, x.a.id), x.a.id))).toMatchObject({ granted: false, code: 'duplicate_writer' });
    hold.release();
    expect(await winner).toMatchObject({ granted: true });
    // and after the commit, too: the race's timing against the winner's commit does not change the answer
    expect(await inst.runner.acquireStartPermit(req(tok(inst, dup, x.a.id), x.a.id))).toMatchObject({ granted: false, code: 'duplicate_writer', reason: 'running' });
  });

  it('a request answered during a key-set outage is charged to its source like an unknown key id; control: a request whose token verifies locally is not', async () => {
    const inst = e.newRunner();
    const x = await running(inst, { workspace: false });
    const charged: Array<string | undefined> = [];
    inst.deps.admitSource = (src) => { charged.push(src); return true; };
    const fresh = e.newRunner({ kube: inst.kube }); // an empty key cache: the next verification must fetch the key set
    fresh.deps.admitSource = inst.deps.admitSource;
    inst.kube.failNext('getServiceAccountJwks', new KubeError(503, 'InternalError', 'key set unavailable'));
    expect(await fresh.runner.renewPermit({ ...req(tok(inst, x.pod, x.a.id), x.a.id), source: 'outage' })).toMatchObject({ code: 'review_unavailable' });
    expect(charged).toEqual(['outage']);
    const healthy = e.newRunner({ kube: inst.kube }); // the key cache of the first one backs off after a failed fetch
    healthy.deps.admitSource = inst.deps.admitSource;
    expect(await healthy.runner.renewPermit({ ...req(tok(inst, x.pod, x.a.id), x.a.id), source: 'healthy' })).toMatchObject({ granted: true });
    expect(charged).toEqual(['outage']); // the verified request was not charged
  });

  it('resizing the review budget from a pass keeps the tokens it has left instead of refilling it', async () => {
    let now = 0;
    const inst = e.newRunner({ nowMs: () => now, config: { review: { perSecond: 20, burst: 40 }, podRate: { burst: 1000, intervalMs: 1 } } });
    const x = await running(inst, { workspace: false });
    const renew = () => inst.runner.renewPermit(req(tok(inst, x.pod, x.a.id), x.a.id));
    for (let i = 0; i < 39; i += 1) expect(await renew()).toMatchObject({ granted: true }); // 40 reviews with the acquire's: the budget is empty
    expect(await renew()).toMatchObject({ code: 'throttled' });
    inst.deps.onLiveWriters?.(2); // a pass: same rate (the floor), new bucket in the old code
    expect(await renew()).toMatchObject({ code: 'throttled' });
    now += 1000;
    expect(await renew()).toMatchObject({ granted: true }); // control: time still refills it
  });

  it('a pod\'s denied calls are audited under a bucket keyed by the pod UID, and an identical denial from another pod is audited too', async () => {
    const inst = e.newRunner({ config: { refusalAudit: { perSecond: 1, burst: 3 }, podRate: { burst: 1000, intervalMs: 1 } } });
    const x = await running(inst, { workspace: false });
    const y = await running(inst, { workspace: false });
    const wrong = (p: typeof x) => inst.runner.renewPermit(req(tok(inst, p.pod, p.a.id), p.a.id, 2)); // stale_epoch, a typed denial after a good review
    for (let i = 0; i < 6; i += 1) expect(await wrong(x)).toMatchObject({ code: 'stale_epoch' });
    expect(await e.q(e.a, "SELECT count(*)::int AS n FROM factory.audit_event WHERE action = 'runner.permit.renew' AND resource_id = $1 AND outcome = 'denied'", [x.a.id])).toEqual([{ n: 3 }]);
    expect(inst.runner.permitRefusals()['denial_audit_capped']).toBe(3);
    expect(await wrong(y)).toMatchObject({ code: 'stale_epoch' }); // another pod: its own bucket
    expect(await e.q(e.a, "SELECT count(*)::int AS n FROM factory.audit_event WHERE action = 'runner.permit.renew' AND resource_id = $1 AND outcome = 'denied'", [y.a.id])).toEqual([{ n: 1 }]);
  });
});
