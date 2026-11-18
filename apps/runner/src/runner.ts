// The Runner service as an object (section 5): the reference Runner interface plus describeRun, the workspace
// facade, the permit calls and the reconciler. There is no network listener (D12): every input is validated as
// if it had come off the wire, so W-019's and W-023's listeners are thin.
import type { AuthContext } from '@factory/artifacts';
import type { ServiceInterfaces, StageInput, StageResult, WorkspaceRecord } from '@factory/contracts';
import type { ReleaseOutcome, WorkspaceSpec } from '@factory/workspace';
import type { RunnerDeps } from './core.ts';
import { RunnerError } from './errors.ts';
import { PermitService, type PermitRequest, type PermitResult } from './permit.ts';
import { reconcileOne, reconcileOnce, startReconcileLoop, sweepJobs, type LoopHandle, type PassSummary } from './reconcile.ts';
import { cancel, describeRun, getResult, getRun, startOrAttach, type DescribedRun } from './start.ts';
import { allocateWorkspace, releaseWorkspace } from './workspaces.ts';

export interface RunnerService extends Omit<ServiceInterfaces.Runner, 'watchEvents'> {
  describeRun(ctx: AuthContext, stageRunId: string): Promise<DescribedRun>;
  watchEvents(ctx: AuthContext, stageRunId: string, cursor?: string): never;
  // The workspace facade (SI-26)
  allocateWorkspace(ctx: AuthContext, id: string, spec: WorkspaceSpec): Promise<WorkspaceRecord>;
  releaseWorkspace(ctx: AuthContext, id: string, expectedEpoch: number): Promise<ReleaseOutcome>;
  // The permit service: its caller is the supervisor (W-019); in W-017 the callers are tests.
  acquireStartPermit(req: PermitRequest): Promise<PermitResult>;
  renewPermit(req: PermitRequest): Promise<PermitResult>;
  permitRefusals(): Record<string, number>;
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
  return {
    deps,
    startOrAttach: (ctx: AuthContext, input: StageInput, specHash: string) => startOrAttach(deps, ctx, input, specHash),
    getRun: (ctx, stageRunId) => getRun(deps, ctx, stageRunId),
    describeRun: (ctx, stageRunId) => describeRun(deps, ctx, stageRunId),
    cancel: (ctx, stageRunId, commandId, reason) => cancel(deps, ctx, stageRunId, commandId, reason),
    getResult: (ctx, stageRunId): Promise<StageResult | null> => getResult(deps, ctx, stageRunId),
    watchEvents: () => { throw new RunnerError('not_supported', 'watchEvents arrives with the supervisor (W-019)'); },
    allocateWorkspace: (ctx, id, spec) => allocateWorkspace(deps, ctx, id, spec),
    releaseWorkspace: (ctx, id, epoch) => releaseWorkspace(deps, ctx, id, epoch),
    acquireStartPermit: (req) => permits.acquireStartPermit(req),
    renewPermit: (req) => permits.renewPermit(req),
    permitRefusals: () => permits.counters(),
    refusalCounts: () => Object.fromEntries(deps.counters ?? []),
    reconcileOnce: () => reconcileOnce(deps),
    reconcileOne: (orgId, id, budget) => reconcileOne(deps, orgId, id, budget),
    sweepJobs: () => sweepJobs(deps),
    startLoop: (onPass) => startReconcileLoop(deps, onPass),
  };
}
