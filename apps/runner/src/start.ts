// Start-or-attach, cancel and the read side of the Runner (section 5, "Interfaces").
import type { AuthContext } from '@factory/artifacts';
import type { ArtifactRef } from '@factory/contracts';
import { validateContract, type StageInput, type StageResult } from '@factory/contracts';
import {
  budgetReservationState, getAllocation, getRunnerStageRun, getWorkspace, insertAllocation, isUniqueViolation, latestAllocationReason, listAllocationsOfStageRun,
  lockAllocation, lockRunnerStageRun, lockWorkspace, transitionAllocation, type AllocationRow, type RunnerStageRun, type WorkspaceRow,
} from '@factory/database';
import { canonicalHash, canonicalJson } from '@factory/domain';
import { WorkspaceError } from '@factory/workspace';
import { reserveCapacity } from './capacity-standin.ts';
import { supervisorSubject } from './config.ts';
import {
  HEX64, UUID, authorizeCaller, bounded, faultsOf, liveAllocation, lockOr, refuseScope, reportError, runnerCtx, viewOf, writeCancelRecord, type RunnerDeps,
} from './core.ts';
import { RunnerError } from './errors.ts';
import { allocationId, jobName } from './names.ts';
import { auditAllocation, reconcileOne } from './reconcile.ts';
import { handleState, type RunHandle } from './states.ts';

const MAX_INPUT_BYTES = 256 * 1024;
const MAX_REASON_BYTES = 1024;
const MAX_LOGICAL_ID = 256;

export type DescribedRun = { handle: RunHandle; allocationId?: string; state?: AllocationRow['state']; needsOperator: boolean; stopReason?: string; cancelled: boolean };

// ---------------------------------------------------------------- wire validation

export function validateStartRequest(d: RunnerDeps, ctx: AuthContext, input: StageInput, specHash: string): void {
  const bad = (m: string): never => { throw new RunnerError('invalid_request', m); };
  // Length tests and anchored fixed-length patterns only: nothing backtracks.
  let serialized: string;
  try { serialized = JSON.stringify(input); } catch { return bad('input is not serializable'); }
  if (Buffer.byteLength(serialized) > MAX_INPUT_BYTES) bad(`input is larger than ${String(MAX_INPUT_BYTES)} bytes`);
  const checked = validateContract('StageInput', input);
  if (!checked.ok) bad(`input does not match the StageInput contract: ${checked.errors[0]?.message ?? 'invalid'}`);
  if (typeof specHash !== 'string' || !HEX64.test(specHash)) bad('specHash must be 64 hex characters');
  if (typeof input.stageRunId !== 'string' || input.stageRunId.length > MAX_LOGICAL_ID) bad('stageRunId is too long');
  if (!HEX64.test(input.inputHash)) bad('inputHash must be 64 hex characters');
  if (input.inputHash !== canonicalHash(input.inputBinding)) bad('inputHash is not the hash of the input binding');
  if (input.limits.wallSeconds > d.config.maxWallSeconds) throw new RunnerError('limits_exceed_cap', `wallSeconds is above the cap of ${String(d.config.maxWallSeconds)}`);
  if (input.workspaceId !== undefined && !UUID.test(input.workspaceId)) bad('workspaceId must be a UUID');
}

// Only the binding is hashed, so nothing else in the request may be used: the other fields must equal the row's.
function sameRequest(stage: RunnerStageRun, input: StageInput): boolean {
  return stage.inputHash === input.inputHash && stage.role === input.role && stage.nodeId === input.nodeId && stage.semanticAttempt === input.semanticAttempt
    && canonicalJson(stage.limits) === canonicalJson(input.limits);
}

type Allocate =
  | { kind: 'handle'; handle: RunHandle }
  | { kind: 'created'; allocation: AllocationRow }
  | { kind: 'fence'; workspaceId: string; epoch: number }
  | { kind: 'restart' };

async function allocateOnce(d: RunnerDeps, ctx: AuthContext, input: StageInput, specHash: string, taskId: string): Promise<Allocate> {
  const org = ctx.orgId;
  return d.db.withTenant({ orgId: org }, async (tx): Promise<Allocate> => {
    await bounded(tx);
    const stage = await lockOr('stage_run_busy', () => lockRunnerStageRun(tx, org, input.stageRunId));
    if (!stage) throw new RunnerError('unknown_stage_run', 'unknown stage run');
    await faultsOf(d).hit('runner.in_allocate_tx');
    if (stage.taskId !== taskId || input.taskId !== taskId) throw new RunnerError('forbidden', 'the stage run belongs to another task');
    if (!sameRequest(stage, input)) throw new RunnerError('conflict', 'the request differs from the stage run it names (input hash, role, node, attempt or limits)');
    const view = await viewOf(tx, d, stage);
    // A terminal result exists: the handle of the allocation that produced it. A finished run never answers run_cancelled.
    if (stage.resultRef !== null && view) return { kind: 'handle', handle: view.handle };
    if (view?.cancelled) throw new RunnerError('run_cancelled', 'the stage run was cancelled');
    if (stage.taskStatus !== 'running') throw new RunnerError('task_not_running', `the task is ${stage.taskStatus}`);
    if (stage.superseded || !['pending', 'ready', 'running'].includes(stage.status)) throw new RunnerError('stage_run_not_current', `the stage run is ${stage.superseded ? 'superseded' : stage.status}`);
    const all = await listAllocationsOfStageRun(tx, org, stage.id);
    // SI-11's run-level comparison, over live and finished allocations alike.
    if (all.some((a) => a.specHash !== specHash)) throw new RunnerError('conflict', 'the specHash differs from the one this stage run was allocated with');
    const live = all.find((a) => a.state === 'desired' || a.state === 'starting' || a.state === 'running' || a.state === 'suspect' || a.state === 'stopping' || a.state === 'finalizing');
    if (live) return { kind: 'handle', handle: { stageRunId: stage.logicalId, generation: live.generation, epoch: live.ownerEpoch, state: handleState(live.state, false) } };
    const budget = await budgetReservationState(tx, org, stage.taskId, stage.logicalId);
    if (budget === 'missing') throw new RunnerError('budget_not_reserved', 'no budget reservation exists for this stage run');
    if (budget === 'settled') throw new RunnerError('budget_settled', 'the stage run\'s budget was charged or released');

    const last = all.at(-1);
    let ws: WorkspaceRow | undefined;
    if (input.workspaceId !== undefined) {
      const wid = input.workspaceId;
      ws = await lockOr('workspace_busy', () => lockWorkspace(tx, org, wid, 'share'));
      if (!ws || ws.taskId !== stage.taskId || ws.stageRunId !== stage.id) throw new RunnerError('conflict', 'the workspace does not belong to this stage run');
      if (ws.state === 'releasing' || ws.state === 'released' || ws.state === 'quarantined') throw new RunnerError('workspace_unavailable', `the workspace is ${ws.state}`);
      if (ws.checkpointRef !== null) throw new RunnerError('restore_unavailable', 'a workspace with a checkpoint needs a restore, which arrives with W-020');
      // The limit is checked before anything is fenced.
      if (last && ws.generation <= last.generation) {
        if (ws.generation + 1 > d.config.maxGenerations) throw new RunnerError('generation_limit', `a stage run may use at most ${String(d.config.maxGenerations)} generations`);
        return { kind: 'fence', workspaceId: ws.id, epoch: ws.ownerEpoch };
      }
      if (ws.state !== 'allocated') throw new RunnerError('workspace_unavailable', `the workspace is ${ws.state}, not allocated`);
    }
    const generation = ws ? ws.generation : (last?.generation ?? 0) + 1;
    const epoch = ws ? ws.ownerEpoch : generation;
    if (generation > d.config.maxGenerations) throw new RunnerError('generation_limit', `a stage run may use at most ${String(d.config.maxGenerations)} generations`);
    await reserveCapacity(tx, d.config, { orgId: org, taskId: stage.taskId, stageRunId: stage.id, role: stage.role, generation });
    const created = await insertAllocation(tx, {
      orgId: org, id: allocationId(org, stage.logicalId, generation), stageRunId: stage.id, workspaceId: ws ? ws.id : null, generation, ownerEpoch: epoch, specHash,
      jobName: jobName(org, stage.logicalId, generation), namespace: d.config.namespace, supervisorIdentity: supervisorSubject(d.config), startDeadlineSeconds: d.config.startDeadlineSeconds });
    if (all.some((a) => a.state === 'quarantined')) await auditAllocation(tx, d, created, 'runner.reallocate_after_quarantine', 'a new generation follows a quarantined one (06-runner-workspaces.md:25)');
    return { kind: 'created', allocation: created };
  });
}

export async function startOrAttach(d: RunnerDeps, ctx: AuthContext, input: StageInput, specHash: string): Promise<RunHandle> {
  const taskId = await authorizeCaller(d, ctx, 'runner.start_or_attach', typeof input.stageRunId === 'string' ? input.stageRunId : 'unknown');
  validateStartRequest(d, ctx, input, specHash);
  if (input.orgId !== ctx.orgId) return refuseScope(d, ctx, 'runner.start_or_attach', input.stageRunId, 'organization');
  if (input.taskId !== taskId) return refuseScope(d, ctx, 'runner.start_or_attach', input.stageRunId, 'task_scope');
  // Prepare, unlocked: nothing is rendered and W-018 is asked for nothing.
  const prepared = await d.db.withTenant({ orgId: ctx.orgId }, async (tx) => {
    const stage = await getRunnerStageRun(tx, ctx.orgId, input.stageRunId);
    const ws = stage && input.workspaceId !== undefined ? await getWorkspace(tx, ctx.orgId, input.workspaceId) : undefined;
    return { stage, ws };
  });
  if (!prepared.stage) throw new RunnerError('unknown_stage_run', 'unknown stage run');
  if (prepared.stage.taskId !== taskId) return refuseScope(d, ctx, 'runner.start_or_attach', input.stageRunId, 'task_scope');
  if (input.workspaceId !== undefined && (!prepared.ws || prepared.ws.taskId !== taskId || prepared.ws.stageRunId !== prepared.stage.id)) throw new RunnerError('conflict', 'the workspace does not belong to this stage run');

  let restarts = 0;
  const restart = (): void => { restarts += 1; if (restarts > d.config.allocateRestarts) throw new RunnerError('allocation_contended', 'the allocation kept changing under the request; retry'); };
  for (;;) {
    let r: Allocate;
    try { r = await allocateOnce(d, ctx, input, specHash, taskId); } catch (e) {
      if (isUniqueViolation(e)) { restart(); continue; } // another controller inserted the same row: repeat every check
      throw e;
    }
    if (r.kind === 'restart') { restart(); continue; }
    if (r.kind === 'handle') return r.handle;
    if (r.kind === 'fence') {
      // Its own transaction: the fence commits first. A racing replaceWriter is a restart, not an error.
      try { await d.workspaces.replaceWriter(runnerCtx(d, ctx.orgId, taskId, ctx.correlationId), r.workspaceId, r.epoch); } catch (e) {
        if (!(e instanceof WorkspaceError && (e.code === 'stale_epoch' || e.code === 'publish_in_progress'))) throw e;
      }
      restart();
      continue;
    }
    // After the commit: one reconcile pass with a 20 s budget; the handle is whatever it achieved. The row is committed, so
    // nothing that goes wrong in the pass may fail the call: the loop finishes the rest.
    try {
      await faultsOf(d).hit('runner.after_allocate_commit');
      await reconcileOne(d, ctx.orgId, r.allocation.id, d.config.inlineReconcileBudgetMs);
    } catch (e) { reportError(d, e); }
    const after = await d.db.withTenant({ orgId: ctx.orgId }, (tx) => getAllocation(tx, ctx.orgId, r.allocation.id)).catch(() => undefined);
    const a = after ?? r.allocation;
    return { stageRunId: input.stageRunId, generation: a.generation, epoch: a.ownerEpoch, state: handleState(a.state, false) };
  }
}

export async function cancel(d: RunnerDeps, ctx: AuthContext, stageRunId: string, commandId: string, reason: string): Promise<RunHandle> {
  const taskId = await authorizeCaller(d, ctx, 'runner.cancel', typeof stageRunId === 'string' ? stageRunId : 'unknown');
  if (typeof stageRunId !== 'string' || stageRunId === '' || stageRunId.length > MAX_LOGICAL_ID) throw new RunnerError('invalid_request', 'stageRunId is empty or too long');
  if (typeof commandId !== 'string' || !UUID.test(commandId)) throw new RunnerError('invalid_request', 'commandId must be a UUID');
  if (typeof reason !== 'string' || Buffer.byteLength(reason) > MAX_REASON_BYTES) throw new RunnerError('invalid_request', `reason is longer than ${String(MAX_REASON_BYTES)} bytes`);
  const known = await d.db.withTenant({ orgId: ctx.orgId }, (tx) => getRunnerStageRun(tx, ctx.orgId, stageRunId));
  if (!known) throw new RunnerError('unknown_stage_run', 'unknown stage run');
  if (known.taskId !== taskId) return refuseScope(d, ctx, 'runner.cancel', stageRunId, 'task_scope');

  const out = await d.db.withTenant({ orgId: ctx.orgId }, async (tx) => {
    await bounded(tx);
    const stage = await lockOr('stage_run_busy', () => lockRunnerStageRun(tx, ctx.orgId, stageRunId));
    if (!stage) throw new RunnerError('unknown_stage_run', 'unknown stage run');
    // A cancel after a terminal result writes nothing.
    if (stage.resultRef === null) {
      await writeCancelRecord(tx, d, ctx.orgId, stageRunId, commandId, reason);
      // Under the stage run's lock no allocation can be inserted, so the live one (if any) is stable; but its state is
      // not: a reconcile pass or a permit moves it under its own row lock. So lock the row first and decide on the
      // locked row's state, never on a read made before the lock.
      const live = await liveAllocation(tx, ctx.orgId, stage.id);
      if (live) {
        const locked = await lockAllocation(tx, ctx.orgId, live.id);
        if (locked && ['desired', 'starting', 'running', 'suspect'].includes(locked.state)) {
          const next = await transitionAllocation(tx, { orgId: ctx.orgId, id: locked.id, ownerEpoch: locked.ownerEpoch, from: [locked.state], to: 'stopping', leaseSeconds: d.config.stopDeadlineSeconds });
          if (next) await auditAllocation(tx, d, locked, 'runner.allocation_stopping', 'cancel');
        }
      }
    }
    const view = await viewOf(tx, d, stage);
    return { view, liveId: stage.resultRef === null ? (await liveAllocation(tx, ctx.orgId, stage.id))?.id : undefined };
  });
  // The record is committed: a cancel succeeds from here on, whatever the pass does.
  if (out.liveId !== undefined) { try { await reconcileOne(d, ctx.orgId, out.liveId); } catch (e) { reportError(d, e); } }
  const final = await d.db.withTenant({ orgId: ctx.orgId }, async (tx) => { const s = await getRunnerStageRun(tx, ctx.orgId, stageRunId); return s ? viewOf(tx, d, s) : undefined; }).catch(() => undefined);
  const handle = final?.handle ?? out.view?.handle;
  if (!handle) throw new RunnerError('not_found', 'no run');
  return handle;
}

// ---------------------------------------------------------------- reads

async function loadStage(d: RunnerDeps, ctx: AuthContext, stageRunId: string, action: string): Promise<RunnerStageRun> {
  const taskId = await authorizeCaller(d, ctx, action, typeof stageRunId === 'string' ? stageRunId : 'unknown');
  if (typeof stageRunId !== 'string' || stageRunId === '' || stageRunId.length > MAX_LOGICAL_ID) throw new RunnerError('invalid_request', 'stageRunId is empty or too long');
  const stage = await d.db.withTenant({ orgId: ctx.orgId }, (tx) => getRunnerStageRun(tx, ctx.orgId, stageRunId));
  if (!stage) throw new RunnerError('unknown_stage_run', 'unknown stage run');
  if (stage.taskId !== taskId) return refuseScope(d, ctx, action, stageRunId, 'task_scope');
  return stage;
}

export async function getRun(d: RunnerDeps, ctx: AuthContext, stageRunId: string): Promise<RunHandle> {
  const stage = await loadStage(d, ctx, stageRunId, 'runner.get_run');
  const view = await d.db.withTenant({ orgId: ctx.orgId }, (tx) => viewOf(tx, d, stage));
  if (!view) throw new RunnerError('not_found', 'the stage run has no allocation yet');
  return view.handle;
}

export async function describeRun(d: RunnerDeps, ctx: AuthContext, stageRunId: string): Promise<DescribedRun> {
  const stage = await loadStage(d, ctx, stageRunId, 'runner.describe_run');
  return d.db.withTenant({ orgId: ctx.orgId }, async (tx) => {
    const view = await viewOf(tx, d, stage);
    if (!view) throw new RunnerError('not_found', 'the stage run has no allocation yet');
    const a = view.allocation;
    const reason = a ? await latestAllocationReason(tx, ctx.orgId, a.id) : undefined;
    return { handle: view.handle, ...(a ? { allocationId: a.id, state: a.state } : {}), needsOperator: a?.state === 'quarantined', ...(reason === undefined ? {} : { stopReason: reason }), cancelled: view.cancelled };
  });
}

export async function getResult(d: RunnerDeps, ctx: AuthContext, stageRunId: string): Promise<StageResult | null> {
  const stage = await loadStage(d, ctx, stageRunId, 'runner.get_result');
  if (stage.resultRef === null) return null;
  if (!d.artifacts) throw new RunnerError('not_supported', 'no artifact service is configured');
  // Read under the caller's own scope; the runner never builds a result.
  const body = await d.artifacts.readVerified(ctx, stage.resultRef as unknown as ArtifactRef);
  const parsed = validateContract('StageResult', JSON.parse(body.toString('utf8')) as unknown);
  if (!parsed.ok) throw new RunnerError('invalid_request', 'the stored result is not a StageResult');
  return parsed.value;
}

