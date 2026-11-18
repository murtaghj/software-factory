// The capacity stand-in (A-30), inside the allocate transaction. One pool per organization and role class,
// one row per allocation: the table allows one row per stage run and pool key, and the runtime role cannot
// update `slots`, so the key is `<pool>/g<generation>` and a pool's count is the rows whose key starts with
// `<pool>/`. W-088 replaces all of it.
import { randomUUID } from 'node:crypto';
import { countCapacityInUse, insertCapacity, lockCapacityPool, setCapacityState, type Tx } from '@factory/database';
import { poolOf, type RunnerConfig } from './config.ts';
import { RunnerError } from './errors.ts';

export const poolKey = (pool: string, generation: number): string => `${pool}/g${String(generation)}`;

// Takes the pool's advisory lock, counts unexpired reserved and active rows, refuses at the limit (nothing
// written, nothing queued), otherwise inserts the row as `reserved`. It expires at the wall cap plus 300 s
// plus the start deadline, so a lost allocation cannot hold a slot forever.
export async function reserveCapacity(tx: Tx, c: RunnerConfig, input: { orgId: string; taskId: string; stageRunId: string; role: string; generation: number }): Promise<void> {
  const { pool, limit } = poolOf(c, input.role);
  await lockCapacityPool(tx, input.orgId, pool);
  if ((await countCapacityInUse(tx, input.orgId, pool)) >= limit) throw new RunnerError('capacity_unavailable', `the ${pool} pool is at its limit of ${String(limit)}`, { pool, limit });
  await insertCapacity(tx, { orgId: input.orgId, id: randomUUID(), taskId: input.taskId, stageRunId: input.stageRunId, poolKey: poolKey(pool, input.generation),
    expiresInSeconds: c.maxWallSeconds + c.jobDeadlineSlackSeconds + c.startDeadlineSeconds });
}
export async function activateCapacity(tx: Tx, c: RunnerConfig, input: { orgId: string; stageRunId: string; role: string; generation: number }): Promise<void> {
  await setCapacityState(tx, { orgId: input.orgId, stageRunId: input.stageRunId, poolKey: poolKey(poolOf(c, input.role).pool, input.generation), from: ['reserved'], to: 'active' });
}
export async function releaseCapacity(tx: Tx, c: RunnerConfig, input: { orgId: string; stageRunId: string; role: string; generation: number }): Promise<void> {
  await setCapacityState(tx, { orgId: input.orgId, stageRunId: input.stageRunId, poolKey: poolKey(poolOf(c, input.role).pool, input.generation), from: ['reserved', 'active'], to: 'released' });
}
