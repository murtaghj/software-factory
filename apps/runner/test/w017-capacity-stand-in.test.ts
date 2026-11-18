import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEnv, hex, type Env, type Stage } from './harness.ts';

let e: Env;
beforeAll(async () => { e = await createEnv('w017_capacity', { config: { pools: { authoring: 10, verifier: 10 } } }); });
afterAll(async () => { await e.close(); });

const rows = (orgT: typeof e.a) => e.q<{ pool_key: string; state: string }>(orgT, 'SELECT pool_key, state FROM factory.capacity_reservation ORDER BY pool_key, created_at');
const start = (inst: ReturnType<typeof e.newRunner>, s: Stage) => inst.runner.startOrAttach(e.ctx(e.a), e.input(e.a, s), hex('e'));

describe('W-017 capacity stand-in (A-30)', () => {
  it('twelve concurrent calls on a pool of ten: exactly ten succeed; the eleventh is capacity_unavailable with nothing written, and succeeds after one allocation is terminated; the verifier pool is separate', async () => {
    const a = e.newRunner({ ownPool: true });
    const b = e.newRunner({ ownPool: true, kube: a.kube });
    const stages = await Promise.all(Array.from({ length: 12 }, () => e.newStage(e.a)));
    const results = await Promise.allSettled(stages.map((s, i) => start(i % 2 === 0 ? a : b, s)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(10);
    const refused = results.flatMap((r, i) => (r.status === 'rejected' ? [{ i, code: (r.reason as { code: string }).code }] : []));
    expect(refused).toHaveLength(2);
    expect(refused.every((r) => r.code === 'capacity_unavailable')).toBe(true);
    expect(await rows(e.a)).toHaveLength(10);
    const loser = stages[refused[0]?.i as number] as Stage;
    expect(await e.allocations(e.a, loser)).toHaveLength(0); // nothing written for it
    const jobsBefore = a.kube.jobs.size;
    // The pool is full: still refused (control that the refusal is about capacity)
    await expect(start(a, loser)).rejects.toMatchObject({ code: 'capacity_unavailable' });
    expect(a.kube.jobs.size).toBe(jobsBefore);
    // A verifier stage uses its own pool.
    const verifier = await e.newStage(e.a, 'verifier');
    await expect(start(a, verifier)).resolves.toMatchObject({ state: 'accepted' });
    // One allocation terminates: its slot is released in the same transaction, and the refused call now succeeds.
    const done = (await e.allocations(e.a, stages.find((_, i) => !refused.some((r) => r.i === i)) as Stage))[0] as NonNullable<Awaited<ReturnType<typeof e.allocations>>[number]>;
    await e.backdate(e.a, done.id, { leaseUntilSecondsAgo: 1 });
    await a.runner.reconcileOne(e.a.orgId, done.id, 5000);
    expect((await e.allocation(e.a, done.id)).state).toBe('terminated');
    expect((await rows(e.a)).filter((r) => r.state === 'released')).toHaveLength(1);
    await expect(start(a, loser)).resolves.toMatchObject({ state: 'accepted' });
  });

  it('the slot is reserved at allocation and active with the permit; after a quarantined generation the next generation has its own row and the pool counts both', async () => {
    const inst = e.newRunner({ config: { pools: { authoring: 2, verifier: 2 } } });
    const s = await e.newStage(e.b);
    const run = await e.runningAllocation(e.b, s, inst);
    const keys = () => e.q<{ pool_key: string; state: string }>(e.b, "SELECT pool_key, state FROM factory.capacity_reservation WHERE stage_run_id = (SELECT id FROM factory.stage_run WHERE logical_id = $1) ORDER BY pool_key", [s.logicalId]);
    expect(await keys()).toEqual([{ pool_key: 'authoring/g1', state: 'active' }]);
    // Quarantine it: nothing proved the pod stopped, so its slot is left to expire and still counts.
    await e.db.withTenant({ orgId: e.b.orgId }, (tx) => tx.query("UPDATE factory.execution_allocation SET state = 'quarantined' WHERE id = $1", [run.allocationId]));
    await inst.runner.startOrAttach(e.ctx(e.b), e.input(e.b, s), hex('e'));
    expect(await keys()).toEqual([{ pool_key: 'authoring/g1', state: 'active' }, { pool_key: 'authoring/g2', state: 'reserved' }]);
    // The pool of two is now full (both generations count): another stage run is refused.
    const other = await e.newStage(e.b);
    await expect(inst.runner.startOrAttach(e.ctx(e.b), e.input(e.b, other), hex('e'))).rejects.toMatchObject({ code: 'capacity_unavailable' });
    expect(await e.q(e.b, 'SELECT 1 FROM factory.execution_allocation a JOIN factory.stage_run s ON s.id = a.stage_run_id WHERE s.logical_id = $1', [other.logicalId])).toHaveLength(0);
    // An expired quarantined slot stops counting.
    await e.q(e.b, "UPDATE factory.capacity_reservation SET expires_at = now() - interval '1 second' WHERE pool_key = 'authoring/g1'");
    await expect(inst.runner.startOrAttach(e.ctx(e.b), e.input(e.b, other), hex('e'))).resolves.toMatchObject({ state: 'accepted' });
  });
});
