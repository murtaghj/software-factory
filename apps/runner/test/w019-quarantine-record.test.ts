// The quarantine record (W-019, D25): written in the transaction of every move to `quarantined`; the move reads the proof link under the row lock (rule 6).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listLinksByPurpose } from '@factory/database';
import { quarantineRecord } from '@factory/workspace';
import { pvcName } from '../src/names.ts';
import { recordDeps, toQuarantined } from '../src/testing.ts';
import { createEnv, type Env, type Instance, type Stage } from './harness.ts';
import { foreignPod } from './pods.ts';

let e: Env;
beforeAll(async () => { e = await createEnv('w019_quarantine', { config: { podRate: { burst: 1000, intervalMs: 1 } } }); });
afterAll(async () => { await e.close(); });

const cancel = (inst: Instance, s: Stage) => inst.runner.cancel(e.ctx(e.a), s.logicalId, randomUUID(), 'stop');
const state = async (id: string) => (await e.allocation(e.a, id)).state;
const qlinks = (id: string) => e.db.withTenant({ orgId: e.a.orgId }, (tx) => listLinksByPurpose(tx, e.a.orgId, `quarantine_record/${id}`));
const plinks = (id: string) => e.db.withTenant({ orgId: e.a.orgId }, (tx) => listLinksByPurpose(tx, e.a.orgId, `quiescence_proof/${id}`));
const pass = (inst: Instance, id: string) => inst.runner.reconcileOne(e.a.orgId, id).catch((err: unknown) => err);
async function run(inst: Instance) {
  const s = await e.newStage(e.a);
  const x = await e.runningAllocation(e.a, s, inst, { withWorkspace: true });
  return { s, x };
}
// A pod of someone else's Job on the allocation's label keeps the proof open.
const imposter = (inst: Instance, id: string) => foreignPod(inst.kube, id, { name: `imposter-${id.slice(0, 6)}`, owner: { kind: 'Job', name: 'not-ours', uid: 'u-x' } });
async function stuck(inst: Instance) {
  const r = await run(inst);
  const pod = imposter(inst, r.x.allocationId);
  await cancel(inst, r.s);
  expect(await state(r.x.allocationId)).toBe('stopping');
  await e.backdate(e.a, r.x.allocationId, { leaseUntilSecondsAgo: 1 });
  return { ...r, pod };
}

describe('W-019 the quarantine record', () => {
  it('a stop with no proof by the deadline: the record is written in the move\'s transaction, restricted, with no container text; a fault after the put leaves neither, and the retry leaves both', async () => {
    const inst = e.newRunner();
    const r = await stuck(inst);
    inst.faults.throwAt('runner.after_quarantine_put');
    await pass(inst, r.x.allocationId);
    expect(await state(r.x.allocationId)).toBe('stopping');
    expect(await qlinks(r.x.allocationId)).toHaveLength(0);
    await pass(inst, r.x.allocationId);
    expect(await state(r.x.allocationId)).toBe('quarantined');
    const l = await qlinks(r.x.allocationId);
    expect(l).toHaveLength(1);
    expect(l[0]?.classification).toBe('restricted');
    const rec = await quarantineRecord.readChecked(recordDeps(inst.deps), e.a.orgId, e.a.taskId, r.x.allocationId);
    expect(rec.kind).toBe('present');
    const b = rec.kind === 'present' ? rec.body : {};
    expect(b).toMatchObject({ schema: 'factory-quarantine-record/1', source: 'stopping', obligation: { kind: 'quarantined_allocation', owner: 'platform-operator', needsOperator: true } });
    expect(b['reason']).toBe('no_proof_of_quiescence:pod_not_finished');
    expect(JSON.stringify(b)).not.toMatch(/message/i);
  });

  it('the other two sources (desired, starting) write the record too, through the same move', async () => {
    const inst = e.newRunner();
    const s1 = await e.newStage(e.a);
    inst.faults.throwAt('runner.after_allocate_commit'); // the row is committed and the pass never runs: still `desired`
    await inst.runner.startOrAttach(e.ctx(e.a), e.input(e.a, s1), 'e'.repeat(64));
    const d = (await e.allocations(e.a, s1))[0] as NonNullable<Awaited<ReturnType<typeof e.allocations>>[number]>;
    expect(d.state).toBe('desired');
    expect(await toQuarantined(inst.deps, d, 'pvc_not_ours')).toMatchObject({ state: 'quarantined' });
    expect(await qlinks(d.id)).toHaveLength(1);
    const s2 = await e.newStage(e.a);
    await inst.runner.startOrAttach(e.ctx(e.a), e.input(e.a, s2), 'e'.repeat(64));
    const st = (await e.allocations(e.a, s2))[0] as NonNullable<Awaited<ReturnType<typeof e.allocations>>[number]>;
    expect(st.state).toBe('starting');
    expect(await toQuarantined(inst.deps, st, 'job_replaced')).toMatchObject({ state: 'quarantined' });
    expect(await qlinks(st.id)).toHaveLength(1);
    const body = await quarantineRecord.readChecked(recordDeps(inst.deps), e.a.orgId, e.a.taskId, st.id);
    expect(body.kind === 'present' && body.body['source']).toBe('starting');
  });

  it('describeRun returns the ref and needsOperator; a pass reports the open quarantine once its escalation time is backdated; release is refused and the PVC is the same before and after; the next startOrAttach lands on generation 2 with a new claim, citing the record, and generation 1\'s claim is in no manifest and no delete', async () => {
    const inst = e.newRunner();
    // Not a cancel (a cancelled stage run is never allocated again): a lost lease, then a stop that cannot be proved by its deadline.
    const r = await run(inst);
    imposter(inst, r.x.allocationId);
    await e.backdate(e.a, r.x.allocationId, { leaseUntilSecondsAgo: 1 });
    await pass(inst, r.x.allocationId);
    expect(await state(r.x.allocationId)).toBe('stopping');
    await e.backdate(e.a, r.x.allocationId, { leaseUntilSecondsAgo: 1 });
    const claim1 = pvcName(e.a.orgId, r.x.workspaceId as string, 1);
    const uidBefore = inst.kube.pvcs.get(claim1)?.metadata.uid;
    expect(uidBefore).toBeDefined();
    await pass(inst, r.x.allocationId);
    expect(await state(r.x.allocationId)).toBe('quarantined');
    const d = await inst.runner.describeRun(e.ctx(e.a), r.s.logicalId);
    expect(d).toMatchObject({ needsOperator: true, state: 'quarantined' });
    expect(d.quarantineRecord?.artifactId).toBe((await qlinks(r.x.allocationId))[0]?.artifactId);
    expect((await inst.runner.reconcileOnce()).openQuarantines).toBe(0); // control: not yet past its escalation time
    await e.db.withTenant({ orgId: e.a.orgId }, (tx) => tx.query("UPDATE factory.execution_allocation SET updated_at = clock_timestamp() - interval '2 days' WHERE id = $1", [r.x.allocationId]));
    expect((await inst.runner.reconcileOnce()).openQuarantines).toBeGreaterThanOrEqual(1);
    await expect(inst.runner.releaseWorkspace(e.ctx(e.a), r.x.workspaceId as string, 1)).rejects.toMatchObject({ code: 'allocation_quarantined' });
    expect(inst.kube.pvcs.get(claim1)?.metadata.uid).toBe(uidBefore);
    const callsBefore = inst.kube.calls.length;
    await inst.runner.startOrAttach(e.ctx(e.a), e.input(e.a, r.s, { workspaceId: r.x.workspaceId as string }), 'e'.repeat(64));
    const all = await e.allocations(e.a, r.s);
    expect(all.map((a) => a.generation)).toEqual([1, 2]);
    expect(inst.kube.pvcs.has(pvcName(e.a.orgId, r.x.workspaceId as string, 2))).toBe(true);
    expect(inst.kube.pvcs.get(claim1)?.metadata.uid).toBe(uidBefore);
    expect(inst.kube.writes.filter((w) => w.startsWith('deletePvc'))).toEqual([]);
    expect(inst.kube.calls.slice(callsBefore).filter((c) => c.includes(claim1) && c.startsWith('create'))).toEqual([]);
    const cited = await e.q<{ refs: string[] }>(e.a, "SELECT details_ref->'quarantineRecords' AS refs FROM factory.audit_event WHERE action = 'runner.reallocate_after_quarantine' AND resource_id = $1", [all[1]?.id]);
    expect(cited[0]?.refs).toEqual([(await qlinks(r.x.allocationId))[0]?.artifactId]);
  });

  it('forced interleaving (B3): B judges "not proved" past the deadline and is held at the move; A sees the pod gone and registers a proof; B is released: not quarantined, no quarantine link, and B ends terminated with the workspace retained. Control: with no proof registered the same hold ends quarantined with the workspace quiescing', async () => {
    const a = e.newRunner();
    const b = e.newRunner({ kube: a.kube, ownPool: true });
    const r = await stuck(a);
    const hold = b.faults.holdAt('runner.before_quarantine_move');
    const bPass = pass(b, r.x.allocationId);
    await hold.reached;
    a.kube.pods.delete(r.pod.metadata.name); // the pod is gone
    a.faults.throwAt('runner.after_proof_registered');
    await pass(a, r.x.allocationId); // A stores the proof and dies before `terminated`
    expect(await plinks(r.x.allocationId)).toHaveLength(1);
    expect(await state(r.x.allocationId)).toBe('stopping');
    hold.release();
    await bPass;
    expect(await state(r.x.allocationId)).toBe('terminated');
    expect(await qlinks(r.x.allocationId)).toHaveLength(0);
    expect((await e.workspace(e.a, r.x.workspaceId as string)).state).toBe('retained');
    // control
    const c = await stuck(a);
    const hold2 = b.faults.holdAt('runner.before_quarantine_move');
    const cPass = pass(b, c.x.allocationId);
    await hold2.reached;
    hold2.release();
    await cPass;
    expect(await state(c.x.allocationId)).toBe('quarantined');
    expect((await e.workspace(e.a, c.x.workspaceId as string)).state).toBe('quiescing');
  });

  it('the mirror: B\'s move commits first and A\'s register writes no link; the end state is never both', async () => {
    const a = e.newRunner();
    const b = e.newRunner({ kube: a.kube, ownPool: true });
    const r = await stuck(a);
    // A will find the pod gone and prove the stop, but is held between its put and its registration.
    a.kube.pods.delete(r.pod.metadata.name);
    const hold = a.faults.holdAt('runner.after_proof_put');
    const aPass = pass(a, r.x.allocationId);
    await hold.reached;
    // B, which judged on the earlier state, quarantines: put the pod back for B's view, then take it away again.
    imposter(b, r.x.allocationId);
    await pass(b, r.x.allocationId);
    expect(await state(r.x.allocationId)).toBe('quarantined');
    hold.release();
    await aPass;
    expect(await plinks(r.x.allocationId)).toHaveLength(0);
    expect(await qlinks(r.x.allocationId)).toHaveLength(1);
    expect(await state(r.x.allocationId)).toBe('quarantined');
  });
});
