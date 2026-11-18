import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chargeBudget, getRunnerStageRunById } from '@factory/database';
import { InjectedFault } from '@factory/test-support';
import { renderJob } from '../src/index.ts';
import { createEnv, hex, sleep, type Env, type Instance, type Stage } from './harness.ts';
import { uniqueViolation, foreignPod } from './pods.ts';

let e: Env;
beforeAll(async () => { e = await createEnv('w017_start'); });
afterAll(async () => { await e.close(); });

const start = (inst: Instance, s: Stage, workspaceId?: string, over: Record<string, unknown> = {}) => inst.runner.startOrAttach(e.ctx(e.a), e.input(e.a, s, { ...(workspaceId ? { workspaceId } : {}), ...over }), hex('e'));
// Ends an allocation through its start deadline: stopping, then the proof, then terminated.
async function terminateByDeadline(inst: Instance, allocationId: string): Promise<void> {
  await e.backdate(e.a, allocationId, { leaseUntilSecondsAgo: 1 });
  await inst.runner.reconcileOne(e.a.orgId, allocationId, 5000);
  const a = await e.allocation(e.a, allocationId);
  if (a.state !== 'terminated') throw new Error(`expected terminated, got ${a.state}`);
}

describe('W-017 start-or-attach', () => {
  it('each refusal writes nothing and has an accepted twin: a paused task, a superseded stage run, a missing or settled budget reservation, a full pool, a wall cap over the bound', async () => {
    const inst = e.newRunner();
    // paused task
    {
      const s = await e.newStage(e.a);
      await e.q(e.a, "UPDATE factory.task SET status = 'paused' WHERE id = $1", [e.a.taskId]);
      const before = await e.tables(e.a);
      await expect(start(inst, s)).rejects.toMatchObject({ code: 'task_not_running' });
      expect(await e.tables(e.a)).toBe(before);
      expect(inst.kube.writes).toHaveLength(0);
      await e.q(e.a, "UPDATE factory.task SET status = 'running' WHERE id = $1", [e.a.taskId]);
      await expect(start(inst, s)).resolves.toMatchObject({ state: 'accepted' });
    }
    // superseded stage run (needs plan version 2 to point at)
    {
      const s = await e.newStage(e.a);
      await e.q(e.a, "INSERT INTO factory.execution_plan (org_id, id, task_id, version, spec_version, plan_ref, policy_ref, plan_hash, template_id, template_version, template_ref) VALUES ($1,$2,$3,2,1,'{}','{}',$4,'existing_feature','3.0.0','{}') ON CONFLICT DO NOTHING", [e.a.orgId, randomUUID(), e.a.taskId, hex('d')]);
      await e.q(e.a, 'UPDATE factory.stage_run SET superseded_at = now(), superseded_by_plan_version = 2 WHERE logical_id = $1', [s.logicalId]);
      const before = await e.tables(e.a);
      await expect(start(inst, s)).rejects.toMatchObject({ code: 'stage_run_not_current' });
      expect(await e.tables(e.a)).toBe(before);
      const twin = await e.newStage(e.a); // control: a current stage run of the same task is accepted
      await expect(start(inst, twin)).resolves.toMatchObject({ state: 'accepted' });
    }
    // missing reservation, then the twin once it exists
    {
      const s = await e.newStage(e.a, 'implementer', { reserve: false });
      const before = await e.tables(e.a);
      await expect(start(inst, s)).rejects.toMatchObject({ code: 'budget_not_reserved' });
      expect(await e.tables(e.a)).toBe(before);
      await e.db.withTenant({ orgId: e.a.orgId }, async (tx) => { const { reserveBudget } = await import('@factory/database'); await reserveBudget(tx, { orgId: e.a.orgId, accountId: e.a.accountId, operationKey: s.logicalId, amountMicroUsd: 10 }); });
      await expect(start(inst, s)).resolves.toMatchObject({ state: 'accepted' });
    }
    // settled budget (the stage was charged): refused; control is the plain case above
    {
      const s = await e.newStage(e.a);
      await e.db.withTenant({ orgId: e.a.orgId }, (tx) => chargeBudget(tx, { orgId: e.a.orgId, accountId: e.a.accountId, operationKey: s.logicalId, actualMicroUsd: 5 }));
      const before = await e.tables(e.a);
      const w = inst.kube.writes.length;
      await expect(start(inst, s)).rejects.toMatchObject({ code: 'budget_settled' });
      expect(await e.tables(e.a)).toBe(before);
      expect(inst.kube.writes).toHaveLength(w);
    }
    // a wall cap over the bound is refused before anything is read (the twin is the cap itself)
    {
      const s = await e.newStage(e.a, 'implementer', { limits: { wallSeconds: 7201 } });
      await expect(start(inst, s)).rejects.toMatchObject({ code: 'limits_exceed_cap' });
      const ok = await e.newStage(e.a, 'implementer', { limits: { wallSeconds: 7200 } });
      await expect(start(inst, ok)).resolves.toMatchObject({ state: 'accepted' });
    }
    // a full pool: one slot, the second is refused with nothing written, and succeeds once the first is terminated
    {
      const small = e.newRunner({ config: { pools: { authoring: 1, verifier: 1 } } });
      const first = await e.newStage(e.b);
      const second = await e.newStage(e.b);
      const ctxB = e.ctx(e.b);
      await small.runner.startOrAttach(ctxB, e.input(e.b, first), hex('e'));
      const before = await e.q(e.b, 'SELECT count(*) AS n FROM factory.capacity_reservation');
      await expect(small.runner.startOrAttach(ctxB, e.input(e.b, second), hex('e'))).rejects.toMatchObject({ code: 'capacity_unavailable' });
      expect(await e.q(e.b, 'SELECT count(*) AS n FROM factory.capacity_reservation')).toEqual(before);
      expect(await e.q(e.b, 'SELECT 1 FROM factory.execution_allocation a JOIN factory.stage_run s ON s.id = a.stage_run_id WHERE s.logical_id = $1', [second.logicalId])).toHaveLength(0);
      const firstAlloc = (await e.q<{ id: string }>(e.b, 'SELECT a.id FROM factory.execution_allocation a JOIN factory.stage_run s ON s.id = a.stage_run_id WHERE s.logical_id = $1', [first.logicalId]))[0]?.id as string;
      await e.backdate(e.b, firstAlloc, { leaseUntilSecondsAgo: 1 });
      await small.runner.reconcileOne(e.b.orgId, firstAlloc, 5000);
      await expect(small.runner.startOrAttach(ctxB, e.input(e.b, second), hex('e'))).resolves.toMatchObject({ state: 'accepted' });
    }
  });

  it('a fault at after_allocate_commit kills A; B, which never saw the request, renders the same manifest from the rows and creates the Job', async () => {
    const a = e.newRunner({ ownPool: true });
    const b = e.newRunner({ ownPool: true, kube: a.kube });
    const s = await e.newStage(e.a);
    const ws = await e.newWorkspace(e.a, s, a);
    a.faults.throwAt('runner.after_allocate_commit');
    const died: unknown[] = [];
    a.deps.onError = (x) => died.push(x);
    expect(await start(a, s, ws)).toMatchObject({ state: 'accepted' }); // committed: the call answers, and the failed pass is reported
    expect(died[0]).toBeInstanceOf(InjectedFault);
    await a.db.close();
    const row = (await e.allocations(e.a, s))[0] as NonNullable<Awaited<ReturnType<typeof e.allocations>>[number]>;
    expect(row.state).toBe('desired');
    expect(a.kube.jobs.size).toBe(0);
    await b.runner.reconcileOne(e.a.orgId, row.id);
    const job = [...a.kube.jobs.values()][0];
    expect(job?.metadata.name).toBe(row.jobName);
    const stage = await e.db.withTenant({ orgId: e.a.orgId }, (tx) => getRunnerStageRunById(tx, e.a.orgId, row.stageRunId));
    const rendered = renderJob({ allocation: row, stage: stage as never, workspace: await e.workspace(e.a, ws), request: { kind: 'remote', target: { orgId: e.a.orgId, workspaceId: ws, generation: 1 }, taskId: e.a.taskId, cloneUrl: 'https://git.example.test/org/repo.git', commit: 'c'.repeat(40), branch: `factory/${e.a.taskId}/main`, subpath: '' }, config: b.config });
    expect(job?.spec).toEqual(rendered.spec);
    expect(job?.metadata.annotations).toEqual(rendered.metadata.annotations);
  });

  it('the claim is created first and the Job while the claim is still Pending (never waits for Bound); a second call after the permit attaches without error; suspect reports reconciling and allocates nothing', async () => {
    const inst = e.newRunner();
    inst.kube.autoPod = false; // no pod is scheduled, so the claim can only be Pending
    const s = await e.newStage(e.a);
    const ws = await e.newWorkspace(e.a, s, inst);
    await start(inst, s, ws);
    expect(inst.kube.writes.filter((w) => /^create(Pvc|Job) /.test(w)).map((w) => w.split(' ')[0])).toEqual(['createPvc', 'createJob']);
    expect([...inst.kube.pvcs.values()][0]?.status.phase).toBe('Pending');
    expect(inst.kube.jobs.size).toBe(1);

    const s2 = await e.newStage(e.a);
    const run = await e.runningAllocation(e.a, s2, e.newRunner());
    const other = e.newRunner();
    expect(await other.runner.startOrAttach(e.ctx(e.a), e.input(e.a, s2), hex('e'))).toMatchObject({ state: 'running', generation: 1 });
    await e.backdate(e.a, run.allocationId, { heartbeatSecondsAgo: 40 });
    const inst2 = e.newRunner();
    await e.db.withTenant({ orgId: e.a.orgId }, (tx) => tx.query("UPDATE factory.execution_allocation SET state = 'suspect' WHERE id = $1", [run.allocationId]));
    const w = other.kube.writes.length;
    expect(await inst2.runner.startOrAttach(e.ctx(e.a), e.input(e.a, s2), hex('e'))).toMatchObject({ state: 'reconciling', generation: 1 });
    expect(await e.allocations(e.a, s2)).toHaveLength(1);
    expect(other.kube.writes).toHaveLength(w);
  });

  it('after terminated the next call fences through replaceWriter exactly once and lands on generation 2 with new names; a crash between the fence and the insert is finished without a second fence', async () => {
    const inst = e.newRunner();
    const s = await e.newStage(e.a);
    const ws = await e.newWorkspace(e.a, s, inst);
    await start(inst, s, ws);
    const g1 = (await e.allocations(e.a, s))[0] as NonNullable<Awaited<ReturnType<typeof e.allocations>>[number]>;
    await terminateByDeadline(inst, g1.id);
    expect(await e.workspace(e.a, ws)).toMatchObject({ generation: 1, ownerEpoch: 1, state: 'allocated' });
    const h = await start(inst, s, ws);
    expect(h).toMatchObject({ generation: 2, epoch: 2, state: 'accepted' });
    const g2 = (await e.allocations(e.a, s))[1] as NonNullable<Awaited<ReturnType<typeof e.allocations>>[number]>;
    expect(g2.jobName).not.toBe(g1.jobName);
    expect(g2.jobName).toBe(inst.kube.jobs.get(g2.jobName)?.metadata.name);
    expect(await e.workspace(e.a, ws)).toMatchObject({ generation: 2, ownerEpoch: 2 }); // one fence, not two
    expect(inst.kube.pvcs.size).toBe(2); // the old generation's claim stays (D15)
    // The crash case: the fence commits, the process dies before the insert.
    await terminateByDeadline(inst, g2.id);
    await inst.workspaces.replaceWriter(e.runnerCtx(e.a), ws, 2);
    expect(await e.workspace(e.a, ws)).toMatchObject({ generation: 3, ownerEpoch: 3 });
    expect(await start(inst, s, ws)).toMatchObject({ generation: 3, epoch: 3 });
    expect(await e.workspace(e.a, ws)).toMatchObject({ generation: 3, ownerEpoch: 3 }); // no second fence
    // Generation 4 is generation_limit, and the workspace's epoch is unchanged by the refusal.
    const g3 = (await e.allocations(e.a, s))[2] as NonNullable<Awaited<ReturnType<typeof e.allocations>>[number]>;
    await terminateByDeadline(inst, g3.id);
    const before = { ws: await e.workspace(e.a, ws), tables: await e.tables(e.a), kube: inst.kube.snapshot() };
    await expect(start(inst, s, ws)).rejects.toMatchObject({ code: 'generation_limit' });
    expect(await e.workspace(e.a, ws)).toEqual(before.ws);
    expect(await e.tables(e.a)).toBe(before.tables);
    expect(inst.kube.snapshot()).toBe(before.kube);
  });

  it('after quarantined the next call fences the same way, an audit row records the re-allocation, and the quarantined row keeps its capacity slot', async () => {
    const inst = e.newRunner();
    const s = await e.newStage(e.a);
    const run = await e.runningAllocation(e.a, s, inst, { withWorkspace: true });
    // The writer's pod is lost and a foreign-owned pod keeps the proof open until the stop deadline.
    inst.kube.driver.losePod(run.podName);
    foreignPod(inst.kube, run.allocationId, { name: 'imposter', owner: { kind: 'Job', name: 'someone-elses', uid: 'u-other' } });
    await inst.runner.reconcileOne(e.a.orgId, run.allocationId, 5000);
    expect((await e.allocation(e.a, run.allocationId)).state).toBe('stopping');
    await e.backdate(e.a, run.allocationId, { leaseUntilSecondsAgo: 1 });
    await inst.runner.reconcileOne(e.a.orgId, run.allocationId, 5000);
    expect((await e.allocation(e.a, run.allocationId)).state).toBe('quarantined');
    expect(await e.workspace(e.a, run.workspaceId as string)).toMatchObject({ state: 'quiescing' });
    const slots = await e.q<{ state: string; pool_key: string }>(e.a, 'SELECT state, pool_key FROM factory.capacity_reservation WHERE pool_key = $1 AND stage_run_id = (SELECT id FROM factory.stage_run WHERE logical_id = $2)', ['authoring/g1', s.logicalId]);
    expect(slots).toEqual([{ state: 'active', pool_key: 'authoring/g1' }]); // nothing proved the pod stopped: it still counts
    const h = await start(inst, s, run.workspaceId);
    expect(h).toMatchObject({ generation: 2, epoch: 2 });
    expect(await e.auditCount(e.a, "action = 'runner.reallocate_after_quarantine'")).toBeGreaterThanOrEqual(1);
    expect((await e.q<{ pool_key: string }>(e.a, "SELECT pool_key FROM factory.capacity_reservation WHERE stage_run_id = (SELECT id FROM factory.stage_run WHERE logical_id = $1) ORDER BY pool_key", [s.logicalId])).map((r) => r.pool_key)).toEqual(['authoring/g1', 'authoring/g2']);
  });

  it('a unique violation restarts and still answers conflict for a different specHash; four forced restarts give allocation_contended (three do not)', async () => {
    const inst = e.newRunner();
    // Three restarts are tolerated (control)...
    const s = await e.newStage(e.a);
    inst.faults.throwAt('runner.in_allocate_tx', { times: 3, error: uniqueViolation() });
    await expect(start(inst, s)).resolves.toMatchObject({ state: 'accepted' });
    expect(inst.faults.hits('runner.in_allocate_tx')).toBe(4);
    // ...the fourth is allocation_contended, retryable, with nothing written.
    const s2 = await e.newStage(e.a);
    inst.faults.throwAt('runner.in_allocate_tx', { times: 4, error: uniqueViolation() });
    const before = await e.tables(e.a);
    const err = await start(inst, s2).catch((x: unknown) => x as { code: string; retryable: boolean });
    expect(err).toMatchObject({ code: 'allocation_contended', retryable: true });
    expect(await e.tables(e.a)).toBe(before);
    expect((await start(inst, s2))).toMatchObject({ state: 'accepted' });
    // The restart repeats every check: while A is held in its transaction a competing insert (another controller's
    // allocation with a different specHash) is queued behind its stage run lock; A's simulated unique violation rolls
    // it back, the competitor commits first (lock queue order), and A's second attempt answers conflict.
    const s3 = await e.newStage(e.a);
    const other = e.newRunner({ ownPool: true });
    const hold = inst.faults.holdAt('runner.in_allocate_tx', { thenThrow: uniqueViolation() });
    const pending = start(inst, s3).catch((x: unknown) => x as { code: string });
    await hold.reached;
    const stageRowId = (await e.q<{ id: string }>(e.a, 'SELECT id FROM factory.stage_run WHERE logical_id = $1', [s3.logicalId]))[0]?.id as string;
    const competitor = other.db.withTenant({ orgId: e.a.orgId }, (tx) => tx.query(`INSERT INTO factory.execution_allocation (org_id, id, stage_run_id, generation, owner_epoch, spec_hash, job_name, namespace, supervisor_identity, state)
      VALUES ($1,$2,$3,1,1,$4,'factory-competitor-g1','factory-exec-local','sa','terminated')`, [e.a.orgId, randomUUID(), stageRowId, hex('f')]));
    for (let i = 0; i < 100; i += 1) { // wait until the competitor is queued on a lock
      const waiting = await e.q<{ n: string }>(e.a, 'SELECT count(*) AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE NOT l.granted AND a.datname = current_database()');
      if (Number(waiting[0]?.n) > 0) break;
      await sleep(20);
    }
    hold.release(); // the held visit fails with the simulated violation, which rolls the transaction back
    await competitor;
    const result = await pending;
    expect(result).toMatchObject({ code: 'conflict' });
    await other.db.close();
  });

  it('limits that differ only in key order are equal; a workspace with a checkpoint_ref gives restore_unavailable and writes nothing', async () => {
    const inst = e.newRunner();
    const s = await e.newStage(e.a);
    const reordered = Object.fromEntries(Object.entries(s.limits).reverse());
    await expect(start(inst, s, undefined, { limits: reordered })).resolves.toMatchObject({ state: 'accepted' });
    const s2 = await e.newStage(e.a);
    const ws = await e.newWorkspace(e.a, s2, inst);
    const ckpt = await e.putArtifact(e.a, Buffer.from('{"checkpoint":1}'), 'checkpoint/x');
    await e.db.withTenant({ orgId: e.a.orgId }, (tx) => tx.query('UPDATE factory.workspace SET checkpoint_ref = $3 WHERE org_id = $1 AND id = $2', [e.a.orgId, ws, JSON.stringify(ckpt)]));
    const before = { tables: await e.tables(e.a), w: inst.kube.writes.length };
    await expect(start(inst, s2, ws)).rejects.toMatchObject({ code: 'restore_unavailable' });
    expect(await e.tables(e.a)).toBe(before.tables);
    expect(inst.kube.writes).toHaveLength(before.w);
  });
});
