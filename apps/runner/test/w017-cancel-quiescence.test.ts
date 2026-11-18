import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cancelRecordId, evaluateQuiescence, jobName, renderJob, tokenAudience } from '../src/index.ts';
import { FakeKubelet, toStopping } from '../src/testing.ts';
import { createEnv, hex, until, sleep, type Env, type Instance, type Stage } from './harness.ts';
import { foreignPod } from './pods.ts';

let e: Env;
const kubelets: FakeKubelet[] = [];
beforeAll(async () => { e = await createEnv('w017_cancel'); });
afterEach(async () => { for (const k of kubelets.splice(0)) await k.close(); });
afterAll(async () => { await e.close(); });

const start = (inst: Instance, s: Stage, workspaceId?: string) => inst.runner.startOrAttach(e.ctx(e.a), e.input(e.a, s, workspaceId ? { workspaceId } : {}), hex('e'));
const cancel = (inst: Instance, s: Stage, reason = 'because') => inst.runner.cancel(e.ctx(e.a), s.logicalId, randomUUID(), reason);
const alloc = async (s: Stage, n = 0) => (await e.allocations(e.a, s))[n] as NonNullable<Awaited<ReturnType<typeof e.allocations>>[number]>;

// An instance whose cluster has a kubelet: the supervisor stub exits on TERM, the harness stub ignores it.
function withKubelet(graceMs = 600): { inst: Instance; kubelet: FakeKubelet } {
  const inst = e.newRunner({ config: { images: { supervisor: 'factory-stub:local', harness: 'factory-stub-ignore-term:local', materializer: 'factory-materializer:local' } } });
  const kubelet = new FakeKubelet(inst.kube, { graceMs });
  kubelet.register('factory-materializer:local', () => ({ command: process.execPath, args: ['-e', "require('fs').writeFileSync(process.env.TERMINATION_MESSAGE_PATH, process.argv[1] ?? '')", e.receiptMessage(1)] }));
  kubelets.push(kubelet);
  return { inst, kubelet };
}
// A workspace allocation whose pod is really up under the fake kubelet, with its permit granted.
async function liveWithKubelet(inst: Instance, s: Stage) {
  const ws = await e.newWorkspace(e.a, s, inst);
  await start(inst, s, ws);
  const a = await alloc(s);
  await until('pod running', () => inst.kube.driver.podsOf(a.jobName).some((p) => p.status.phase === 'Running'));
  const pod = inst.kube.driver.podsOf(a.jobName)[0] as NonNullable<ReturnType<typeof inst.kube.driver.podsOf>[number]>;
  const r = await inst.runner.acquireStartPermit({ token: inst.kube.mintToken(pod, tokenAudience(e.a.orgId, a.id)), orgId: e.a.orgId, allocationId: a.id, epoch: a.ownerEpoch });
  expect(r.granted).toBe(true);
  return { ws, a, pod };
}
const settle = async (inst: Instance, id: string, ms = 10_000): Promise<void> => {
  await until(`allocation ${id} terminal`, async () => { await inst.runner.reconcileOne(e.a.orgId, id, 2000); return ['terminated', 'quarantined'].includes((await e.allocation(e.a, id)).state); }, ms);
};

describe('W-017 cancel and the quiescence proof', () => {
  it('cancel with a TERM-ignoring container: the allocation stays stopping and the workspace quiescing while the pod terminates; after KILL the workspace is retained and then the allocation terminated', async () => {
    const { inst, kubelet } = withKubelet();
    const s = await e.newStage(e.a);
    const { ws, a, pod } = await liveWithKubelet(inst, s);
    expect(await e.workspace(e.a, ws)).toMatchObject({ state: 'active', ownerPodUid: pod.metadata.uid });
    const w0 = inst.kube.writes.length;
    expect(await cancel(inst, s)).toMatchObject({ state: 'reconciling' });
    expect(inst.kube.writes.slice(w0).some((w) => w === `deleteJob ${a.jobName}`)).toBe(true); // the port always sends Background
    expect((await e.allocation(e.a, a.id)).state).toBe('stopping');
    expect((await e.workspace(e.a, ws)).state).toBe('quiescing');
    const mid = inst.kube.pods.get(pod.metadata.name);
    expect(mid?.metadata.deletionTimestamp).toBeDefined(); // still listed, Terminating
    expect(mid?.status.containerStatuses?.find((c) => c.name === 'harness')?.state.running).toBeDefined();
    await inst.runner.reconcileOne(e.a.orgId, a.id, 2000);
    expect((await e.allocation(e.a, a.id)).state).toBe('stopping'); // control: an unproved stop is not terminated
    await until('the pod is gone after KILL', () => !inst.kube.pods.has(pod.metadata.name));
    expect(kubelet.processOf(pod.metadata.uid, 'harness')?.alive()).toBe(false);
    await settle(inst, a.id);
    expect(await e.allocation(e.a, a.id)).toMatchObject({ state: 'terminated', terminated: true });
    expect((await e.workspace(e.a, ws)).state).toBe('retained');
    expect((await inst.runner.getRun(e.ctx(e.a), s.logicalId)).state).toBe('cancelled');
  });

  it('controls: a raw Job delete leaves the pod running, and a force delete leaves the process alive after the object is gone', async () => {
    const { inst, kubelet } = withKubelet();
    const s = await e.newStage(e.a);
    await start(inst, s);
    const a = await alloc(s);
    await until('pod running', () => inst.kube.driver.podsOf(a.jobName).some((p) => p.status.phase === 'Running'));
    const pod = inst.kube.driver.podsOf(a.jobName)[0] as NonNullable<ReturnType<typeof inst.kube.driver.podsOf>[number]>;
    inst.kube.driver.rawDeleteJob(a.jobName);
    await sleep(200);
    expect(inst.kube.pods.get(pod.metadata.name)?.status.phase).toBe('Running');
    expect(inst.kube.pods.get(pod.metadata.name)?.metadata.ownerReferences ?? []).toHaveLength(0);
    inst.kube.driver.forceDeletePod(pod.metadata.name);
    expect(inst.kube.pods.has(pod.metadata.name)).toBe(false);
    expect(kubelet.processOf(pod.metadata.uid, 'harness')?.alive()).toBe(true);
  });

  it('a Job marked Failed while a container still runs stays stopping: the proof reads pod status and never Job conditions', async () => {
    const { inst } = withKubelet(500);
    const s = await e.newStage(e.a);
    await start(inst, s);
    const a = await alloc(s);
    await until('pod running', () => inst.kube.driver.podsOf(a.jobName).some((p) => p.status.phase === 'Running'));
    inst.kube.driver.markJobFailed(a.jobName);
    expect(inst.kube.jobs.get(a.jobName)?.status.conditions?.some((c) => c.type === 'Failed')).toBe(true); // the Job says Failed...
    expect(inst.kube.driver.podsOf(a.jobName).some((p) => p.status.phase === 'Running')).toBe(true);        // ...while a container still runs
    await cancel(inst, s);
    expect((await e.allocation(e.a, a.id)).state).toBe('stopping'); // the Job is gone; its pod's harness still runs
    const mid = [...inst.kube.pods.values()];
    expect(mid).toHaveLength(1);
    expect(evaluateQuiescence({ jobAbsent: true, pods: mid, podsTruncated: false, jobUidRecorded: true, stoppingForMs: 0, requestDeadlineMs: 10_000 })).toMatchObject({ proved: false, reason: 'pod_not_finished' });
    await until('pod gone', () => inst.kube.pods.size === 0);
    await settle(inst, a.id);
    expect((await e.allocation(e.a, a.id)).state).toBe('terminated');
    // The function itself: a Job that is still there is never proved, whatever it says.
    expect(evaluateQuiescence({ jobAbsent: false, pods: [], podsTruncated: false, jobUidRecorded: true, stoppingForMs: 0, requestDeadlineMs: 10_000 })).toMatchObject({ proved: false, reason: 'job_present' });
    expect(evaluateQuiescence({ jobAbsent: true, pods: [], podsTruncated: false, jobUidRecorded: true, stoppingForMs: 0, requestDeadlineMs: 10_000 })).toMatchObject({ proved: true });
  });

  it('a labelled pod with no owner is counted and deleted; one with a foreign owner keeps the proof open, then quarantined with needsOperator, and the workspace stays quiescing', async () => {
    const inst = e.newRunner();
    const s = await e.newStage(e.a);
    const run = await e.runningAllocation(e.a, s, inst, { withWorkspace: true });
    foreignPod(inst.kube, run.allocationId, { name: 'orphan' }); // no owner
    inst.kube.delayDeletes = true; // deletes are accepted and the pod stays visible, Terminating, until the kubelet reaps it
    await cancel(inst, s);
    expect(inst.kube.writes).toContain('deletePod orphan'); // counted and deleted
    expect(inst.kube.pods.get('orphan')?.metadata.deletionTimestamp).toBeDefined();
    expect((await e.allocation(e.a, run.allocationId)).state).toBe('stopping'); // still Running and Terminating: it keeps the proof open
    inst.kube.driver.finishDeletes();
    await inst.runner.reconcileOne(e.a.orgId, run.allocationId);
    expect((await e.allocation(e.a, run.allocationId)).state).toBe('terminated');
    inst.kube.delayDeletes = false;
    // The foreign owner.
    const s2 = await e.newStage(e.a);
    const run2 = await e.runningAllocation(e.a, s2, inst, { withWorkspace: true });
    foreignPod(inst.kube, run2.allocationId, { name: 'imposter', owner: { kind: 'Job', name: 'not-ours', uid: 'u-x' } });
    await cancel(inst, s2);
    expect(inst.kube.pods.has('imposter')).toBe(true); // left alone
    expect((await e.allocation(e.a, run2.allocationId)).state).toBe('stopping');
    expect((await e.workspace(e.a, run2.workspaceId as string)).state).toBe('quiescing');
    await e.backdate(e.a, run2.allocationId, { leaseUntilSecondsAgo: 1 });
    await inst.runner.reconcileOne(e.a.orgId, run2.allocationId, 3000);
    expect((await e.allocation(e.a, run2.allocationId)).state).toBe('quarantined');
    expect((await e.workspace(e.a, run2.workspaceId as string)).state).toBe('quiescing'); // nothing showed the writer stopped
    expect(await inst.runner.describeRun(e.ctx(e.a), s2.logicalId)).toMatchObject({ needsOperator: true, state: 'quarantined' });
    expect(inst.kube.pvcs.size).toBeGreaterThan(0); // the PVC is untouched
    await expect(inst.runner.releaseWorkspace(e.ctx(e.a), run2.workspaceId as string, 1)).rejects.toMatchObject({ code: 'writer_active' }); // release is refused, rightly
  });

  it('a pod list at its cap is not proved; control: a list just under it is', async () => {
    const inst = e.newRunner();
    for (const [count, expected] of [[501, 'stopping'], [500, 'terminated']] as const) {
      const s = await e.newStage(e.a);
      await start(inst, s);
      const a = await alloc(s);
      for (let i = 0; i < count; i += 1) foreignPod(inst.kube, a.id, { name: `done-${a.id.slice(0, 6)}-${String(i)}`, phase: 'Succeeded' });
      await cancel(inst, s);
      await inst.runner.reconcileOne(e.a.orgId, a.id, 5000);
      expect((await e.allocation(e.a, a.id)).state, `${String(count)} finished pods`).toBe(expected);
    }
  });

  it('with no job_uid a Job found by name is validated and deleted by its UID, and terminated waits until updated_at is 10 s old; a Job that fails validation is not ours', async () => {
    const a = e.newRunner({ ownPool: true });
    const b = e.newRunner({ ownPool: true, kube: a.kube });
    const s = await e.newStage(e.a);
    a.faults.throwAt('runner.after_job_create');
    await start(a, s).catch(() => undefined);
    await a.db.close();
    const row = await alloc(s);
    expect(row).toMatchObject({ state: 'desired', jobUid: null });
    expect(a.kube.jobs.size).toBe(1);
    await cancel(b, s);
    expect(a.kube.jobs.size).toBe(0); // found by name, validated, deleted by the UID just read
    expect((await e.allocation(e.a, row.id)).state).toBe('stopping'); // the proof waits: a create may have been in flight
    await e.backdate(e.a, row.id, { updatedSecondsAgo: 11 });
    await b.runner.reconcileOne(e.a.orgId, row.id, 3000);
    expect((await e.allocation(e.a, row.id)).state).toBe('terminated');
    // Not ours: a foreign Job under the name.
    const s2 = await e.newStage(e.a);
    const c = e.newRunner();
    await c.kube.createJob({ apiVersion: 'batch/v1', kind: 'Job', metadata: { name: jobName(e.a.orgId, s2.logicalId, 1), namespace: c.kube.namespace, labels: {}, annotations: {} },
      spec: { backoffLimit: 0, activeDeadlineSeconds: 10, template: { metadata: { labels: {}, annotations: {} }, spec: { restartPolicy: 'Never', terminationGracePeriodSeconds: 15, serviceAccountName: 'x', automountServiceAccountToken: false, shareProcessNamespace: false, securityContext: {}, containers: [], volumes: [] } } } });
    await start(c, s2); // quarantined at once (AlreadyExists, not ours)
    expect((await alloc(s2)).state).toBe('quarantined');
    expect(c.kube.jobs.size).toBe(1); // the foreign Job is untouched
  });

  it('a cancel that waits for the allocation row stops it from the state it finds after the lock: desired moved to starting, and starting moved to running, while it waited', async () => {
    for (const moved of ['starting', 'running'] as const) {
      const inst = e.newRunner();
      const s = await e.newStage(e.a);
      inst.faults.throwAt('runner.after_allocate_commit'); // the row is committed; the pass that would have gone on is cut off
      await start(inst, s);
      const a = await alloc(s);
      expect(a.state).toBe('desired');
      const client = await e.db.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('factory.org_id', $1, true)", [e.a.orgId]);
        await client.query('SELECT 1 FROM factory.execution_allocation WHERE id = $1 FOR UPDATE', [a.id]);
        const waiting = cancel(inst, s);
        await until('the cancel to queue on the allocation row', async () => (await e.waiters()) >= 1);
        // While it waits, another controller moves the row (a reconcile bind; a permit).
        await client.query('UPDATE factory.execution_allocation SET state = $2, job_uid = $3, pod_uid = $4 WHERE id = $1', [a.id, moved, 'uid-job', moved === 'running' ? 'uid-pod' : null]);
        await client.query('COMMIT');
        await waiting;
      } finally { client.release(); }
      expect(['stopping', 'terminated'], `desired moved to ${moved} under the cancel`).toContain((await e.allocation(e.a, a.id)).state);
      expect(await e.auditCount(e.a, "action = 'runner.allocation_stopping' AND resource_id = $1", [a.id])).toBe(1);
    }
  });

  it('a permit is refused when the run has a cancel record, whatever state the row is in (control: without the record it is granted)', async () => {
    const inst = e.newRunner();
    const s = await e.newStage(e.a);
    const run = await e.runningAllocation(e.a, s, inst); // granted: the control
    expect(run.allocationId).toBeDefined();
    const s2 = await e.newStage(e.a);
    await start(inst, s2);
    const a = await alloc(s2);
    const pod = inst.kube.driver.podsOf(a.jobName)[0] as NonNullable<ReturnType<typeof inst.kube.driver.podsOf>[number]>;
    inst.kube.driver.startPod(pod.metadata.name);
    // A record with the allocation still `starting` (as if the stop had not been written yet).
    await e.q(e.a, "INSERT INTO factory.audit_event (org_id, id, actor_id, action, resource_kind, resource_id, outcome, correlation_id, request_digest) VALUES ($1,$2,'runner:factory','runner.cancel','stage_run',$3,'accepted','c',$4)", [e.a.orgId, cancelRecordId(e.a.orgId, s2.logicalId), s2.logicalId, hex('a')]);
    const r = await inst.runner.acquireStartPermit({ token: inst.kube.mintToken(pod, tokenAudience(e.a.orgId, a.id)), orgId: e.a.orgId, allocationId: a.id, epoch: 1 });
    expect(r).toMatchObject({ granted: false, code: 'not_startable' });
    expect((await e.allocation(e.a, a.id))).toMatchObject({ state: 'starting', podUid: null });
  });

  it('a cancel succeeds once its record is committed even when the pass after it fails', async () => {
    const inst = e.newRunner();
    const s = await e.newStage(e.a);
    await start(inst, s);
    const seen: unknown[] = [];
    inst.deps.onError = (x) => seen.push(x);
    inst.kube.failNext('deleteJob', new Error('the cluster is down'), 5);
    expect(await cancel(inst, s)).toMatchObject({ state: 'reconciling' }); // the record is there, the stop is under way
    expect(seen).toHaveLength(1);
    expect((await e.allocations(e.a, s))[0]?.state).toBe('stopping');
    await expect(start(inst, s)).rejects.toMatchObject({ code: 'run_cancelled' });
  });

  it('cancel before start returns generation 0, and a later startOrAttach is run_cancelled with no row and no request at the cluster', async () => {
    const inst = e.newRunner();
    const s = await e.newStage(e.a);
    expect(await cancel(inst, s)).toEqual({ stageRunId: s.logicalId, generation: 0, epoch: 0, state: 'cancelled' });
    const before = await e.tables(e.a);
    await expect(start(inst, s)).rejects.toMatchObject({ code: 'run_cancelled' });
    expect(await e.allocations(e.a, s)).toHaveLength(0);
    expect(inst.kube.calls).toHaveLength(0);
    expect(await e.tables(e.a)).toBe(before);
    expect(await cancel(inst, s, 'again')).toEqual({ stageRunId: s.logicalId, generation: 0, epoch: 0, state: 'cancelled' }); // a second cancel changes nothing
    expect(await e.auditCount(e.a, "id = $1", [cancelRecordId(e.a.orgId, s.logicalId)])).toBe(1);
  });

  it('with the start and the cancel held at the stage run\'s lock, in either order, the result is a stopped allocation or no allocation, never a running one', async () => {
    // Order 1: the start holds the lock; the cancel queues behind it; the allocation exists and is then stopped.
    const inst = e.newRunner({ ownPool: true });
    const s = await e.newStage(e.a);
    const hold = inst.faults.holdAt('runner.in_allocate_tx');
    const starting = start(inst, s);
    await hold.reached;
    const cancelling = cancel(e.newRunner({ kube: inst.kube }), s);
    await until('the cancel to queue on the lock', async () => (await e.waiters()) >= 1);
    hold.release();
    await starting.catch(() => undefined);
    await cancelling;
    const [only] = await e.allocations(e.a, s);
    expect(['stopping', 'terminated']).toContain(only?.state);
    // Order 2: the cancel is first on the lock; the start queues behind it and finds the record.
    const s2 = await e.newStage(e.a);
    const stageRow = (await e.q<{ id: string }>(e.a, 'SELECT id FROM factory.stage_run WHERE logical_id = $1', [s2.logicalId]))[0]?.id as string;
    const client = await e.db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('factory.org_id', $1, true)", [e.a.orgId]);
      await client.query('SELECT 1 FROM factory.stage_run WHERE id = $1 FOR UPDATE', [stageRow]);
      const c2 = cancel(e.newRunner(), s2);
      await until('cancel queued', async () => (await e.waiters()) >= 1);
      const st2 = start(e.newRunner(), s2).catch((x: unknown) => x);
      await until('start queued', async () => (await e.waiters()) >= 2);
      await client.query('COMMIT');
      await c2;
      expect(await st2).toMatchObject({ code: 'run_cancelled' });
    } finally { client.release(); }
    expect(await e.allocations(e.a, s2)).toHaveLength(0);
    // Control: with no cancel the same start is accepted.
    const s3 = await e.newStage(e.a);
    await expect(start(e.newRunner(), s3)).resolves.toMatchObject({ state: 'accepted' });
  });

  it('a Job created late is deleted by the next pass when its allocation is terminated, stopping or quarantined; an unrecorded Job of a desired allocation is bound instead', async () => {
    const inst = e.newRunner();
    const lateJob = async (s: Stage) => {
      const a = await alloc(s);
      const stage = await e.q(e.a, 'SELECT * FROM factory.stage_run WHERE logical_id = $1', [s.logicalId]);
      expect(stage).toHaveLength(1);
      return renderJob({ allocation: a, stage: { orgId: e.a.orgId, id: a.stageRunId, taskId: e.a.taskId, logicalId: s.logicalId, nodeId: s.nodeId, semanticAttempt: 1, role: s.role, status: 'running', inputHash: s.inputHash, limits: s.limits, resultRef: null, superseded: false, taskStatus: 'running' }, workspace: undefined, request: undefined, config: inst.config });
    };
    for (const state of ['terminated', 'stopping', 'quarantined'] as const) {
      const s = await e.newStage(e.a);
      await start(inst, s);
      const a = await alloc(s);
      if (state === 'terminated') { await cancel(inst, s); await e.backdate(e.a, a.id, { updatedSecondsAgo: 11 }); await inst.runner.reconcileOne(e.a.orgId, a.id); }
      else { await e.db.withTenant({ orgId: e.a.orgId }, (tx) => tx.query('UPDATE factory.execution_allocation SET state = $2, job_uid = NULL WHERE id = $1', [a.id, state])); inst.kube.jobs.delete(a.jobName); inst.kube.pods.clear(); }
      expect((await e.allocation(e.a, a.id)).state).toBe(state);
      const late = await inst.kube.createJob(await lateJob(s)); // the paused controller wakes up and creates it
      expect(inst.kube.jobs.has(a.jobName)).toBe(true);
      expect(await inst.runner.sweepJobs()).toBeGreaterThanOrEqual(1);
      expect(inst.kube.jobs.has(a.jobName), `${state}: the late Job ${late.metadata.uid} is gone`).toBe(false);
    }
    // desired: the unrecorded Job is the normal crash between create and record: bound, not deleted.
    const s = await e.newStage(e.a);
    inst.faults.throwAt('runner.after_job_create');
    await start(inst, s).catch(() => undefined);
    expect(inst.kube.jobs.size).toBeGreaterThan(0);
    const a = await alloc(s);
    expect(a).toMatchObject({ state: 'desired', jobUid: null });
    await inst.runner.sweepJobs();
    expect(inst.kube.jobs.has(a.jobName)).toBe(true);
    await inst.runner.reconcileOne(e.a.orgId, a.id);
    expect((await e.allocation(e.a, a.id)).state).toBe('starting');
  });

  it('the cancel record has the pinned id and fields; a denied cancel leaves a row the lookup does not count; a foreign row at the pinned id is a hard error', async () => {
    const inst = e.newRunner();
    const s = await e.newStage(e.a);
    const commandId = randomUUID();
    await inst.runner.cancel(e.ctx(e.a), s.logicalId, commandId, 'stop it');
    const row = (await e.q<Record<string, string>>(e.a, 'SELECT * FROM factory.audit_event WHERE id = $1', [cancelRecordId(e.a.orgId, s.logicalId)]))[0];
    expect(row).toMatchObject({ actor_id: 'runner:factory', action: 'runner.cancel', resource_kind: 'stage_run', resource_id: s.logicalId, outcome: 'accepted', correlation_id: commandId });
    expect(row?.['request_digest']).toMatch(/^[0-9a-f]{64}$/);
    // A denied cancel (an identity that is not configured) is a row with a random id, outcome denied.
    const s2 = await e.newStage(e.a);
    await expect(inst.runner.cancel(e.ctx(e.a, { taskId: e.b.taskId }), s2.logicalId, randomUUID(), 'x')).rejects.toMatchObject({ code: 'forbidden' });
    expect(await e.auditCount(e.a, "action = 'runner.cancel' AND outcome = 'denied' AND resource_id = $1", [s2.logicalId])).toBe(1);
    // An identity that is not configured writes nothing at all: it is counted in memory.
    const rowsBefore = await e.auditCount(e.a, 'true');
    await expect(inst.runner.cancel(e.ctx(e.a, { actorId: 'service:intruder' }), s2.logicalId, randomUUID(), 'x')).rejects.toMatchObject({ code: 'forbidden' });
    expect(await e.auditCount(e.a, 'true')).toBe(rowsBefore);
    expect(inst.runner.refusalCounts()).toMatchObject({ identity_not_configured: 1 });
    await expect(inst.runner.getRun(e.ctx(e.a), s2.logicalId)).rejects.toMatchObject({ code: 'not_found' }); // not read as a cancel
    await expect(start(inst, s2)).resolves.toMatchObject({ state: 'accepted' });
    // A foreign row at the pinned id.
    const s3 = await e.newStage(e.a);
    await e.q(e.a, "INSERT INTO factory.audit_event (org_id, id, actor_id, action, resource_kind, resource_id, outcome, correlation_id, request_digest) VALUES ($1,$2,'someone','runner.cancel','stage_run',$3,'denied','c',$4)", [e.a.orgId, cancelRecordId(e.a.orgId, s3.logicalId), s3.logicalId, hex('a')]);
    await expect(inst.runner.cancel(e.ctx(e.a), s3.logicalId, randomUUID(), 'x')).rejects.toMatchObject({ code: 'cancel_record_conflict' });
    // A record written under another runner identity (a rename) is still a cancel, not a conflict.
    const s4 = await e.newStage(e.a);
    await e.q(e.a, "INSERT INTO factory.audit_event (org_id, id, actor_id, action, resource_kind, resource_id, outcome, correlation_id, request_digest) VALUES ($1,$2,'runner:old-name','runner.cancel','stage_run',$3,'accepted','c',$4)", [e.a.orgId, cancelRecordId(e.a.orgId, s4.logicalId), s4.logicalId, hex('a')]);
    await expect(start(inst, s4)).rejects.toMatchObject({ code: 'run_cancelled' });
    expect(await inst.runner.getRun(e.ctx(e.a), s4.logicalId)).toMatchObject({ state: 'cancelled' });
    await expect(start(inst, s3)).rejects.toMatchObject({ code: 'cancel_record_conflict' });
    await expect(inst.runner.getRun(e.ctx(e.a), s3.logicalId)).rejects.toMatchObject({ code: 'cancel_record_conflict' });
  });

  it('a cancel after a terminal result writes no record, and both getRun and startOrAttach answer completed', async () => {
    const inst = e.newRunner();
    const s = await e.newStage(e.a);
    await start(inst, s);
    const a = await alloc(s);
    await e.db.withTenant({ orgId: e.a.orgId }, async (tx) => {
      await tx.query("UPDATE factory.execution_allocation SET state = 'completed' WHERE id = $1", [a.id]);
      await tx.query("UPDATE factory.stage_run SET status = 'passed', result_ref = $2 WHERE logical_id = $1", [s.logicalId, JSON.stringify({ artifactId: randomUUID(), sha256: hex('9'), mediaType: 'application/json', schemaVersion: '2.0', sizeBytes: 2 })]);
    });
    const done = { stageRunId: s.logicalId, generation: 1, epoch: 1, state: 'completed' };
    expect(await cancel(inst, s)).toEqual(done);
    expect(await e.auditCount(e.a, 'id = $1', [cancelRecordId(e.a.orgId, s.logicalId)])).toBe(0);
    expect(await inst.runner.getRun(e.ctx(e.a), s.logicalId)).toEqual(done);
    expect(await start(inst, s)).toEqual(done);
    // Control: a run with no result does get its record.
    const s2 = await e.newStage(e.a);
    await cancel(inst, s2);
    expect(await e.auditCount(e.a, 'id = $1', [cancelRecordId(e.a.orgId, s2.logicalId)])).toBe(1);
  });

  it('a transition that waited for the row lock stamps updated_at after the wait, not before', async () => {
    const inst = e.newRunner();
    const s = await e.newStage(e.a);
    await start(inst, s);
    const a = await alloc(s);
    const client = await e.db.pool.connect();
    let released: Date | undefined;
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('factory.org_id', $1, true)", [e.a.orgId]);
      await client.query('SELECT 1 FROM factory.execution_allocation WHERE id = $1 FOR UPDATE', [a.id]);
      const t0 = new Date();
      const moving = toStopping(inst.deps, a, 'test');
      await until('the transition to queue', async () => (await e.waiters()) >= 1);
      await sleep(1200);
      released = ((await client.query<{ t: Date }>('SELECT clock_timestamp() AS t')).rows[0] as { t: Date }).t;
      await client.query('COMMIT');
      await moving;
      const stamped = (await e.q<{ t: Date }>(e.a, 'SELECT updated_at AS t FROM factory.execution_allocation WHERE id = $1', [a.id]))[0]?.t as Date;
      expect(stamped.getTime()).toBeGreaterThanOrEqual(released.getTime()); // stamped after the wait
      expect(stamped.getTime() - t0.getTime()).toBeGreaterThanOrEqual(1100);
    } finally { client.release(); }
    expect((await e.allocation(e.a, a.id)).state).toBe('stopping');
  });
});
