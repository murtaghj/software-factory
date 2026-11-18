// The Runner service as an object (section 5): the reference Runner interface plus describeRun, the workspace
// facade, the permit calls and the reconciler. There is no network listener (D12): every input is validated as
// if it had come off the wire, so W-019's and W-023's listeners are thin.
import type { AuthContext } from '@factory/artifacts';
import type { ServiceInterfaces, StageInput, StageResult, WorkspaceRecord } from '@factory/contracts';
import type { RunHandle } from './states.ts';
import type { ReleaseOutcome, WorkspaceSpec } from '@factory/workspace';
import type { RunnerDeps } from './core.ts';
import { RunnerError } from './errors.ts';
import { PermitService, type PermitRequest, type PermitResult } from './permit.ts';
import { stopAck, type StopAckResult } from './stop-ack.ts';
import { reconcileOne, reconcileOnce, startReconcileLoop, sweepJobs, type LoopHandle, type PassSummary } from './reconcile.ts';
import { cancel, describeRun, getResult, getRun, startOrAttach, type DescribedRun } from './start.ts';
import { allocateWorkspace, releaseWorkspace } from './workspaces.ts';

export interface RunnerService extends Omit<ServiceInterfaces.Runner, 'watchEvents' | 'cancel'> {
  // Assignable to the reference interface: the fifth argument is optional.
  cancel(ctx: AuthContext, stageRunId: string, commandId: string, reason: string, opts?: { urgent?: boolean }): Promise<RunHandle>;
  describeRun(ctx: AuthContext, stageRunId: string): Promise<DescribedRun>;
  watchEvents(ctx: AuthContext, stageRunId: string, cursor?: string): never;
  // The workspace facade (SI-26)
  allocateWorkspace(ctx: AuthContext, id: string, spec: WorkspaceSpec): Promise<WorkspaceRecord>;
  releaseWorkspace(ctx: AuthContext, id: string, expectedEpoch: number): Promise<ReleaseOutcome>;
  // The permit service: its caller is the supervisor (W-019); in W-017 the callers are tests.
  acquireStartPermit(req: PermitRequest): Promise<PermitResult>;
  renewPermit(req: PermitRequest): Promise<PermitResult>;
  // The stop acknowledgement (pod-facing): `repeat` says the record already existed, so the caller starts no second pass.
  stopAck(req: PermitRequest): Promise<StopAckResult>;
  permitRefusals(): Record<string, number>;
  reviewRate(): { perSecond: number; burst: number }; // the shared TokenReview budget as sized by the last pass
  refusalCounts(): Record<string, number>; // callers refused before the database (identity not configured)
  // The reconciler
  reconcileOnce(): Promise<PassSummary>;
  reconcileOne(orgId: string, allocationId: string, budgetMs?: number): Promise<void>;
  sweepJobs(): Promise<number>;
  startLoop(onPass?: (s: PassSummary) => void): LoopHandle;
  readonly deps: RunnerDeps;
}

export function createRunner(deps: RunnerDeps): RunnerService {
  deps.counters ??= new Map();
  const permits = new PermitService(deps);
  deps.onLiveWriters ??= (n) => { permits.guard.setLiveWriters(n); };
  return {
    deps,
    startOrAttach: (ctx: AuthContext, input: StageInput, specHash: string) => startOrAttach(deps, ctx, input, specHash),
    getRun: (ctx, stageRunId) => getRun(deps, ctx, stageRunId),
    describeRun: (ctx, stageRunId) => describeRun(deps, ctx, stageRunId),
    cancel: (ctx, stageRunId, commandId, reason, opts) => cancel(deps, ctx, stageRunId, commandId, reason, opts),
    getResult: (ctx, stageRunId): Promise<StageResult | null> => getResult(deps, ctx, stageRunId),
    watchEvents: () => { throw new RunnerError('not_supported', 'watchEvents and log chunks wait for a harness adapter and storage the schema does not have: W-023 with W-077 (D26)'); },
    allocateWorkspace: (ctx, id, spec) => allocateWorkspace(deps, ctx, id, spec),
    releaseWorkspace: (ctx, id, epoch) => releaseWorkspace(deps, ctx, id, epoch),
    acquireStartPermit: (req) => permits.acquireStartPermit(req),
    renewPermit: (req) => permits.renewPermit(req),
    stopAck: (req) => stopAck(deps, permits.guard, req),
    permitRefusals: () => permits.counters(),
    reviewRate: () => permits.guard.reviewRate(),
    refusalCounts: () => Object.fromEntries(deps.counters ?? []),
    reconcileOnce: () => reconcileOnce(deps),
    reconcileOne: (orgId, id, budget) => reconcileOne(deps, orgId, id, budget),
    sweepJobs: () => sweepJobs(deps),
    startLoop: (onPass) => startReconcileLoop(deps, onPass),
  };
}
