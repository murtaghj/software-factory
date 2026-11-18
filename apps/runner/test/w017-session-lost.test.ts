import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tokenAudience } from '../src/index.ts';
import { createEnv, hex, until, type Env } from './harness.ts';
import { uniqueViolation } from './pods.ts';

let e: Env;
beforeAll(async () => { e = await createEnv('w017_session'); });
afterAll(async () => { await e.close(); });

const sessionCodes = (err: unknown): Array<string | undefined> => [(err as { code?: string }).code, (err as { cause?: { code?: string } }).cause?.code];
const terminateBackends = (where: string): Promise<number> => e.db.withoutTenant(async (tx) => {
  const r = await tx.query<{ pid: number }>(`SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND ${where}`);
  for (const row of r.rows) await tx.query('SELECT pg_terminate_backend($1)', [row.pid]);
  return r.rows.length;
});

describe('W-017 lost sessions', () => {
  it('the allocate transaction\'s backend is terminated while a fault point holds it open: the call fails with the session\'s error, no row exists, the cluster saw no request, and the retry succeeds', async () => {
    const inst = e.newRunner({ ownPool: true });
    const s = await e.newStage(e.a);
    const hold = inst.faults.holdAt('runner.in_allocate_tx');
    const call = inst.runner.startOrAttach(e.ctx(e.a), e.input(e.a, s), hex('e')).catch((x: unknown) => x);
    await hold.reached;
    expect(await terminateBackends("state = 'idle in transaction' AND query ILIKE '%FROM factory.stage_run s%'")).toBe(1);
    hold.release();
    const err = await call;
    expect(err).toBeInstanceOf(Error);
    // The session's own error (57P01), as the error itself or as the cause of the driver's "connection terminated" wrapper.
    expect(sessionCodes(err)).toContain('57P01');
    expect(await e.allocations(e.a, s)).toHaveLength(0);
    expect(inst.kube.calls).toHaveLength(0);
    expect(await inst.runner.startOrAttach(e.ctx(e.a), e.input(e.a, s), hex('e'))).toMatchObject({ state: 'accepted', generation: 1 }); // safe to retry
    expect(await e.allocations(e.a, s)).toHaveLength(1);
  });

  it('the same in the permit: the claim transaction loses its session while waiting for the row, pod_uid stays null, and the retry is granted', async () => {
    const inst = e.newRunner({ ownPool: true });
    const s = await e.newStage(e.a);
    await inst.runner.startOrAttach(e.ctx(e.a), e.input(e.a, s), hex('e'));
    const a = (await e.allocations(e.a, s))[0] as NonNullable<Awaited<ReturnType<typeof e.allocations>>[number]>;
    const pod = inst.kube.driver.podsOf(a.jobName)[0] as NonNullable<ReturnType<typeof inst.kube.driver.podsOf>[number]>;
    inst.kube.driver.startPod(pod.metadata.name);
    const token = inst.kube.mintToken(pod, tokenAudience(e.a.orgId, a.id));
    const holder = await e.db.pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query("SELECT set_config('factory.org_id', $1, true)", [e.a.orgId]);
      await holder.query('SELECT 1 FROM factory.execution_allocation WHERE id = $1 FOR UPDATE', [a.id]);
      const call = inst.runner.acquireStartPermit({ token, orgId: e.a.orgId, allocationId: a.id, epoch: 1 }).catch((x: unknown) => x);
      await until('the claim to wait on the row', async () => (await e.waiters()) >= 1);
      expect(await terminateBackends("wait_event_type = 'Lock' AND query ILIKE '%execution_allocation%'")).toBe(1);
      await holder.query('COMMIT');
      const err = await call;
      expect(err).toBeInstanceOf(Error);
      expect(sessionCodes(err)).toContain('57P01'); // the server's own error, itself or as the cause of the driver's wrapper
    } finally { holder.release(); }
    expect((await e.allocation(e.a, a.id))).toMatchObject({ podUid: null, state: 'starting' });
    // Fresh token: the first one was spent on a call that died before any answer.
    expect(await inst.runner.acquireStartPermit({ token: inst.kube.mintToken(pod, tokenAudience(e.a.orgId, a.id)), orgId: e.a.orgId, allocationId: a.id, epoch: 1 })).toMatchObject({ granted: true });
  });

  it('a pass whose database session is really terminated fails and says so, and the pass goes on to the next allocation', async () => {
    const inst = e.newRunner({ ownPool: true });
    const stages = [await e.newStage(e.b), await e.newStage(e.b)];
    for (const s of stages) { inst.faults.throwAt('runner.after_allocate_commit'); await inst.runner.startOrAttach(e.ctx(e.b), e.input(e.b, s), hex('e')); } // two committed rows, no pass yet
    const rows = await Promise.all(stages.map(async (s) => (await e.q<{ id: string; state: string }>(e.b, 'SELECT a.id, a.state FROM factory.execution_allocation a JOIN factory.stage_run s ON s.id = a.stage_run_id WHERE s.logical_id = $1', [s.logicalId]))[0] as { id: string; state: string }));
    expect(rows.map((r) => r.state)).toEqual(['desired', 'desired']);
    // The first allocation's row is locked from outside, so its pass waits inside a transaction; that session is then killed.
    const holder = await e.db.pool.connect();
    let summary;
    try {
      await holder.query('BEGIN');
      await holder.query("SELECT set_config('factory.org_id', $1, true)", [e.b.orgId]);
      await holder.query('SELECT 1 FROM factory.execution_allocation WHERE id = $1 FOR UPDATE', [rows[0]?.id]);
      const pass = inst.runner.reconcileOnce();
      await until('the first pass to wait on its row', async () => (await e.waiters()) >= 1);
      expect(await terminateBackends("wait_event_type = 'Lock' AND query ILIKE '%execution_allocation%'")).toBe(1);
      await holder.query('COMMIT');
      summary = await pass;
    } finally { holder.release(); }
    expect(summary.errors).toHaveLength(1); // the pass failed, and said so
    expect(sessionCodes(summary.errors[0])).toContain('57P01');
    expect((await e.allocation(e.b, rows[0]?.id as string)).state).toBe('desired'); // nothing half-done: the row did not move
    expect((await e.allocation(e.b, rows[1]?.id as string)).state).toBe('starting'); // and the next allocation went on
    // The next pass finishes the first one: the Job its dead pass left behind is validated and bound.
    expect((await inst.runner.reconcileOnce()).errors).toHaveLength(0);
    expect((await e.allocation(e.b, rows[0]?.id as string)).state).toBe('starting');
  });

  it('a pass that fails does not stop the loop', async () => {
    const inst = e.newRunner({ config: { reconcileIntervalMs: 20 } });
    const s = await e.newStage(e.b);
    inst.faults.throwAt('runner.after_allocate_commit');
    await inst.runner.startOrAttach(e.ctx(e.b), e.input(e.b, s), hex('e'));
    inst.faults.throwAt('runner.after_job_create', { error: Object.assign(new Error('terminating connection'), { code: '57P01' }) });
    const seen: Array<{ errors: unknown[] }> = [];
    const loop = inst.runner.startLoop((p) => seen.push(p));
    await until('three passes', () => seen.length >= 3, 5000);
    await loop.stop();
    expect(seen[0]?.errors).toHaveLength(1); // the first pass failed...
    expect(seen.slice(1).some((p) => p.errors.length === 0)).toBe(true); // ...and a later one ran clean
    expect(uniqueViolation).toBeDefined();
    expect((await e.q<{ state: string }>(e.b, 'SELECT state FROM factory.execution_allocation a JOIN factory.stage_run s ON s.id = a.stage_run_id WHERE s.logical_id = $1', [s.logicalId]))[0]?.state).toBe('starting');
  });
});
