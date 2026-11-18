// The workspace facade (SI-26) and `settleWorkspace`, the one helper that calls D17's two transitions.
import type { AuthContext } from '@factory/artifacts';
import { getRunnerStageRun, getWorkspace, listAllocationsOfWorkspace, type AllocationRow } from '@factory/database';
import { WorkspaceError, type ReleaseOutcome, type WorkspaceSpec } from '@factory/workspace';
import type { WorkspaceRecord } from '@factory/contracts';
import { authorizeCaller, refuseScope, runnerCtx, type RunnerDeps } from './core.ts';
import { RunnerError } from './errors.ts';
import { isLive } from './states.ts';

export type SettlePhase = 'stopping' | 'proof';

// `stopping`: if the workspace is `active` at this allocation's epoch with this allocation's pod as owner,
// `markWriterQuiescing`. `proof`: that, then `markWriterStopped`. A workspace that has moved to a later
// epoch, or that another pod owns, is left alone. Both calls are repeats-safe.
export async function settleWorkspace(d: RunnerDeps, a: AllocationRow, phase: SettlePhase): Promise<void> {
  if (a.workspaceId === null || a.podUid === null) return;
  const ws = await d.db.withTenant({ orgId: a.orgId }, (tx) => getWorkspace(tx, a.orgId, a.workspaceId as string));
  if (!ws || ws.ownerEpoch !== a.ownerEpoch || ws.ownerPodUid !== a.podUid) return;
  if (ws.state !== 'active' && ws.state !== 'quiescing') return;
  const ctx = runnerCtx(d, a.orgId, a.taskId);
  try {
    if (ws.state === 'active') await d.workspaces.markWriterQuiescing(ctx, ws.id, a.ownerEpoch, a.podUid);
    if (phase === 'proof') await d.workspaces.markWriterStopped(ctx, ws.id, a.ownerEpoch, a.podUid);
  } catch (e) {
    if (e instanceof WorkspaceError && e.code === 'stale_epoch') return; // moved to a later epoch: not ours any more
    throw e;
  }
}

// W-023's Activity calls this before `startOrAttach` (SI-26). The role must be the stage run's: W-018 does not compare it.
export async function allocateWorkspace(d: RunnerDeps, ctx: AuthContext, id: string, spec: WorkspaceSpec): Promise<WorkspaceRecord> {
  const taskId = await authorizeCaller(d, ctx, 'runner.workspace.allocate', id);
  const stage = await d.db.withTenant({ orgId: ctx.orgId }, (tx) => getRunnerStageRun(tx, ctx.orgId, spec.stageRunId));
  if (!stage) throw new RunnerError('unknown_stage_run', 'unknown stage run');
  if (stage.taskId !== taskId) return refuseScope(d, ctx, 'runner.workspace.allocate', id, 'task_scope');
  if (spec.role !== stage.role) throw new RunnerError('conflict', 'the workspace role is not the stage run\'s role');
  return d.workspaces.allocateOrAttach(runnerCtx(d, ctx.orgId, taskId, ctx.correlationId), id, spec);
}

// Release through the facade after `terminated`. A live allocation is a retryable `allocation_live`. A
// permit whose markWriterStarted landed after `terminated` is settled here before W-018's release runs.
export async function releaseWorkspace(d: RunnerDeps, ctx: AuthContext, id: string, expectedEpoch: number): Promise<ReleaseOutcome> {
  const taskId = await authorizeCaller(d, ctx, 'runner.workspace.release', id);
  const found = await d.db.withTenant({ orgId: ctx.orgId }, async (tx) => {
    const ws = await getWorkspace(tx, ctx.orgId, id);
    return ws ? { ws, allocations: await listAllocationsOfWorkspace(tx, ctx.orgId, id) } : undefined;
  });
  if (!found) throw new RunnerError('not_found', 'unknown workspace');
  if (found.ws.taskId !== taskId) return refuseScope(d, ctx, 'runner.workspace.release', id, 'task_scope');
  if (found.allocations.some((a) => isLive(a.state))) throw new RunnerError('allocation_live', 'the workspace has a live allocation; cancel it and wait for terminated');
  // Nothing proved a quarantined allocation's pod stopped, so its volume is untouched until an operator has dealt with it ("quarantined means PVC untouched").
  if (found.allocations.some((a) => a.state === 'quarantined')) throw new RunnerError('allocation_quarantined', 'the workspace has a quarantined allocation; an operator must resolve it before release', { needsOperator: true });
  for (const a of found.allocations) if (a.state === 'terminated') await settleWorkspace(d, a, 'proof');
  return d.workspaces.release(runnerCtx(d, ctx.orgId, taskId, ctx.correlationId), id, expectedEpoch);
}
