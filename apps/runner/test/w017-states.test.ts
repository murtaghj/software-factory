import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ALLOCATION_STATES, insertAllocation, transitionAllocation, type AllocationRow, type AllocationState } from '@factory/database';
import { EDGES, handleState, isLegalEdge, jobName } from '../src/index.ts';
import { move, passOnce } from '../src/testing.ts';
import { createEnv, hex, type Env, type Stage, type Tenant } from './harness.ts';

let e: Env;
beforeAll(async () => { e = await createEnv('w017_states'); });
afterAll(async () => { await e.close(); });
afterEach(() => { vi.useRealTimers(); });

// A bare allocation in the given state (a row only: no Job), one per stage run so `one_active_allocation` never gets in the way.
async function seed(t: Tenant, state: AllocationState): Promise<{ row: AllocationRow; stage: Stage }> {
  const stage = await e.newStage(t);
  const row = await e.db.withTenant({ orgId: t.orgId }, async (tx) => {
    const sr = (await tx.query<{ id: string }>('SELECT id FROM factory.stage_run WHERE logical_id = $1', [stage.logicalId])).rows[0]?.id as string;
    const made = await insertAllocation(tx, { orgId: t.orgId, id: randomUUID(), stageRunId: sr, workspaceId: null, generation: 1, ownerEpoch: 1, specHash: hex('e'), jobName: jobName(t.orgId, stage.logicalId, 1),
      namespace: e.config.namespace, supervisorIdentity: 'sa', startDeadlineSeconds: 600 });
    await tx.query('UPDATE factory.execution_allocation SET state = $3 WHERE org_id = $1 AND id = $2', [t.orgId, made.id, state]);
    return { ...made, state };
  });
  return { row, stage };
}

describe('W-017 allocation edges', () => {
  it('every legal edge succeeds in the database, with a stale epoch refused on each, and every other pair is refused by the edge check before the database is touched (the database itself enforces the state and epoch compare-and-swap, not the table)', async () => {
    const inst = e.newRunner();
    const from = ['none', ...ALLOCATION_STATES] as const;
    let legal = 0;
    for (const f of from) {
      for (const to of ALLOCATION_STATES) {
        const isEdge = EDGES.some(([a, b]) => a === f && b === to);
        expect(isLegalEdge(f, to)).toBe(isEdge);
        if (f === 'none') continue; // the insert itself is `none → desired`, shown by every seed above
        const { row } = await seed(e.a, f);
        if (isEdge) {
          legal += 1;
          const next = await move(inst.deps, row, to);
          expect(next?.state, `${f} -> ${to}`).toBe(to);
          // A stale epoch is refused on each edge: nothing changes.
          const again = await seed(e.a, f);
          const stale = await e.db.withTenant({ orgId: e.a.orgId }, (tx) => transitionAllocation(tx, { orgId: e.a.orgId, id: again.row.id, ownerEpoch: again.row.ownerEpoch + 1, from: [f], to }));
          expect(stale, `${f} -> ${to} at a stale epoch`).toBeUndefined();
          expect((await e.allocation(e.a, again.row.id)).state).toBe(f);
        } else {
          await expect(move(inst.deps, row, to), `${f} -> ${to}`).rejects.toThrow(/illegal allocation transition/);
          expect((await e.allocation(e.a, row.id)).state).toBe(f);
        }
      }
    }
    expect(legal).toBe(EDGES.length - 1); // every table row but `none → desired`
  });

  it('a `finalizing` row is unchanged by a pass (W-019 and W-020 own it)', async () => {
    const inst = e.newRunner();
    const { row } = await seed(e.a, 'finalizing');
    expect(await passOnce(inst.deps, e.a.orgId, row.id)).toBe(false);
    expect((await e.allocation(e.a, row.id)).state).toBe('finalizing');
    // Control: a `desired` row is not left alone.
    const { row: d } = await seed(e.a, 'desired');
    expect(await passOnce(inst.deps, e.a.orgId, d.id)).toBe(true);
  });

  it('the RunHandle mapping, including both meanings of `terminated`', async () => {
    expect(handleState('desired', false)).toBe('accepted');
    expect(handleState('starting', false)).toBe('accepted');
    expect(handleState('running', false)).toBe('running');
    for (const s of ['suspect', 'stopping', 'quarantined'] as const) expect(handleState(s, false)).toBe('reconciling');
    expect(handleState('finalizing', false)).toBe('finalizing');
    expect(handleState('completed', false)).toBe('completed');
    expect(handleState('terminated', true)).toBe('cancelled');
    expect(handleState('terminated', false)).toBe('reconciling');
    // Through the service: the same terminated row reads `reconciling`, and `cancelled` once the run has a cancel record.
    const inst = e.newRunner();
    const s = await e.newStage(e.a);
    await inst.runner.startOrAttach(e.ctx(e.a), e.input(e.a, s), hex('e'));
    const alloc = (await e.allocations(e.a, s))[0] as AllocationRow;
    await e.db.withTenant({ orgId: e.a.orgId }, (tx) => tx.query("UPDATE factory.execution_allocation SET state = 'terminated', terminated_at = now() WHERE id = $1", [alloc.id]));
    expect((await inst.runner.getRun(e.ctx(e.a), s.logicalId)).state).toBe('reconciling');
    await inst.runner.cancel(e.ctx(e.a), s.logicalId, randomUUID(), 'stop');
    expect((await inst.runner.getRun(e.ctx(e.a), s.logicalId)).state).toBe('cancelled');
  });

  it('heartbeat ages of 29, 31 and 61 s give running, suspect and stopping, judged on the database clock', async () => {
    const inst = e.newRunner();
    const results: string[] = [];
    for (const [age, expected] of [[29, 'running'], [31, 'suspect'], [61, 'stopping']] as const) {
      const s = await e.newStage(e.a);
      const run = await e.runningAllocation(e.a, s, inst);
      expect((await e.allocation(e.a, run.allocationId)).state).toBe('running');
      await e.backdate(e.a, run.allocationId, { heartbeatSecondsAgo: age, ...(age >= 60 ? { leaseUntilSecondsAgo: 1 } : {}) });
      await passOnce(inst.deps, e.a.orgId, run.allocationId);
      results.push((await e.allocation(e.a, run.allocationId)).state);
      expect(results.at(-1)).toBe(expected);
    }
    // With the process clock an hour ahead the same three results hold. First show the two clocks really differ.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 3_600_000);
    const dbNow = (await e.q<{ t: Date }>(e.a, 'SELECT clock_timestamp() AS t'))[0]?.t.getTime() as number;
    expect(Date.now() - dbNow).toBeGreaterThan(3_000_000);
    for (const [age, expected] of [[29, 'running'], [31, 'suspect'], [61, 'stopping']] as const) {
      const s = await e.newStage(e.a);
      const run = await e.runningAllocation(e.a, s, inst);
      await e.backdate(e.a, run.allocationId, { heartbeatSecondsAgo: age, ...(age >= 60 ? { leaseUntilSecondsAgo: 1 } : {}) });
      await passOnce(inst.deps, e.a.orgId, run.allocationId);
      expect((await e.allocation(e.a, run.allocationId)).state).toBe(expected);
    }
  });

  it('a suspect allocation becomes running again only through a heartbeat from the writer\'s pod, with the lease still in force', async () => {
    const inst = e.newRunner();
    const s = await e.newStage(e.a);
    const run = await e.runningAllocation(e.a, s, inst);
    await e.backdate(e.a, run.allocationId, { heartbeatSecondsAgo: 40 });
    await passOnce(inst.deps, e.a.orgId, run.allocationId);
    expect((await e.allocation(e.a, run.allocationId)).state).toBe('suspect');
    const a = await e.allocation(e.a, run.allocationId);
    const r = await inst.runner.renewPermit({ token: run.token, orgId: e.a.orgId, allocationId: run.allocationId, epoch: a.ownerEpoch });
    expect(r.granted).toBe(true);
    expect((await e.allocation(e.a, run.allocationId)).state).toBe('running');
  });
});
