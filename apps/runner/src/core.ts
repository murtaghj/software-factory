// Shared pieces of the runner service: its dependencies, the caller check, refusal audit rows, the cancel
// record and the RunHandle built from rows. Nothing here calls Kubernetes.
import { createHash, randomUUID } from 'node:crypto';
import type { ArtifactService, AuthContext } from '@factory/artifacts';
import {
  getAllocation, getAuditEvent, listAllocationsOfStageRun, recordRunnerAudit, setLockWait, isLockTimeout,
  type AllocationRow, type Database, type RunnerStageRun, type Tx,
} from '@factory/database';
import { canonicalJson } from '@factory/domain';
import type { WorkspaceManagerService } from '@factory/workspace';
import type { RunnerConfig } from './config.ts';
import { RunnerError } from './errors.ts';
import { NO_FAULTS, type FaultHook } from './faults.ts';
import type { KubeApi } from './kube/api.ts';
import { cancelRecordId } from './names.ts';
import { handleState, isLive, type RunHandle } from './states.ts';

export type RunnerDeps = {
  db: Database; kube: KubeApi; workspaces: WorkspaceManagerService; config: RunnerConfig;
  artifacts?: ArtifactService; // getResult only
  faults?: FaultHook;
  // A monotonic millisecond clock for the review rate cap and the failed-token memory only. Every age and
  // deadline that decides an allocation is computed in SQL on clock_timestamp().
  monotonicNowMs?: () => number;
  // Seconds since the epoch, for the `exp` of a service-account token only (never for an allocation's deadline).
  wallClockSeconds?: () => number;
  // An error that happened after a commit and was not allowed to fail the call (the post-commit reconcile pass). When
  // absent it is logged as a warning, never dropped.
  onError?: (e: unknown) => void;
  // A deadline for one reconcile pass; list calls stop paging when it fires.
  deadline?: AbortSignal;
  // Refusals counted in memory by reason (callers that are not configured never reach the database).
  counters?: Map<string, number>;
  // A per-source cap hook for the permit listener (W-019): return false to refuse before any review budget is spent.
  admitSource?: (source: string | undefined) => boolean;
};
export const reportError = (d: RunnerDeps, e: unknown): void => { (d.onError ?? ((x: unknown): void => { console.warn('[runner] an error after a commit did not fail the call:', x); }))(e); };
export const countRefusal = (d: RunnerDeps, reason: string): void => { const c = d.counters; if (c) c.set(reason, (c.get(reason) ?? 0) + 1); };
export const faultsOf = (d: RunnerDeps): FaultHook => d.faults ?? NO_FAULTS;

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const HEX64 = /^[0-9a-f]{64}$/;

// The runner calls the workspace manager with its own identity and the task scope it was given; never wider.
export const runnerCtx = (d: RunnerDeps, orgId: string, taskId: string, correlationId: string = randomUUID()): AuthContext =>
  ({ orgId, actorId: d.config.runnerIdentity, actorKind: 'service', taskId, grantIds: [], correlationId });

// A configured identity's denied calls are audited, but not without bound: a token bucket per identity (bounded table).
const auditBuckets = new WeakMap<RunnerDeps, Map<string, { tokens: number; at: number }>>();
function auditAllowed(d: RunnerDeps, actorId: string): boolean {
  let table = auditBuckets.get(d);
  if (!table) { table = new Map(); auditBuckets.set(d, table); }
  const now = (d.monotonicNowMs ?? ((): number => performance.now()))();
  const { perSecond, burst } = d.config.refusalAudit;
  const cur = table.get(actorId) ?? { tokens: burst, at: now };
  cur.tokens = Math.min(burst, cur.tokens + ((now - cur.at) / 1000) * perSecond);
  cur.at = now;
  const ok = cur.tokens >= 1;
  if (ok) cur.tokens -= 1;
  table.delete(actorId); table.set(actorId, cur); // most recently used last
  if (table.size > 1024) { const oldest = table.keys().next().value; if (oldest !== undefined) table.delete(oldest); }
  return ok;
}

export async function auditRefusal(d: RunnerDeps, ctx: AuthContext, action: string, resourceId: string, reason: string): Promise<void> {
  if (!auditAllowed(d, ctx.actorId)) { countRefusal(d, 'audit_capped'); return; }
  try {
    await d.db.withTenant({ orgId: ctx.orgId }, (tx) => recordRunnerAudit(tx, {
      orgId: ctx.orgId, actorId: ctx.actorId, action, resourceKind: 'stage_run', resourceId: resourceId.slice(0, 256), outcome: 'denied', correlationId: ctx.correlationId,
      requestDigest: sha256(canonicalJson({ action, resourceId, reason })), details: { reason } }));
  } catch { /* an organization that does not exist cannot hold an audit row; the refusal still stands */ }
}

// The caller must be a configured control-plane identity with a task scope. Returns once the identity and
// scope are fine; the task and organization are compared by the caller when the row is known.
export async function authorizeCaller(d: RunnerDeps, ctx: AuthContext, action: string, resourceId: string): Promise<string> {
  // An identity that is not configured is counted in memory and writes nothing: it could otherwise make the runner
  // write an audit row, in an organization of its choosing, per attempt. Only a configured identity is audited.
  if (ctx.actorKind !== 'service' || !d.config.controlPlaneIdentities.includes(ctx.actorId)) {
    countRefusal(d, 'identity_not_configured');
    throw new RunnerError('forbidden', `${action} is limited to the configured control-plane identities`);
  }
  const bound = d.config.identityOrgs?.[ctx.actorId];
  if (bound !== undefined && bound !== ctx.orgId) {
    countRefusal(d, 'identity_other_organization');
    throw new RunnerError('forbidden', `${action}: the identity is bound to another organization`);
  }
  if (ctx.taskId === undefined) {
    await auditRefusal(d, ctx, action, resourceId, 'no_task_scope');
    throw new RunnerError('forbidden', `${action} needs a task-scoped caller`);
  }
  return ctx.taskId;
}
export async function refuseScope(d: RunnerDeps, ctx: AuthContext, action: string, resourceId: string, reason: string): Promise<never> {
  await auditRefusal(d, ctx, action, resourceId, reason);
  throw new RunnerError('forbidden', `${action}: ${reason}`);
}

export async function lockOr<T>(code: 'stage_run_busy' | 'workspace_busy', f: () => Promise<T>): Promise<T> {
  try { return await f(); } catch (e) {
    if (isLockTimeout(e)) throw new RunnerError(code, 'could not take the row lock in time; retry');
    throw e;
  }
}
export const LOCK_WAIT_MS = 5_000;
export const bounded = (tx: Tx): Promise<void> => setLockWait(tx, LOCK_WAIT_MS);

// ---------------------------------------------------------------- the cancel record (D18)
const CANCEL = { action: 'runner.cancel', resourceKind: 'stage_run', outcome: 'accepted' } as const;

export async function writeCancelRecord(tx: Tx, d: RunnerDeps, orgId: string, logicalId: string, commandId: string, reason: string): Promise<void> {
  const id = cancelRecordId(orgId, logicalId);
  await recordRunnerAudit(tx, { orgId, id, actorId: d.config.runnerIdentity, ...CANCEL, resourceId: logicalId, correlationId: commandId, requestDigest: sha256(canonicalJson({ commandId, reason })) });
  if (!(await readCancelRecord(tx, d, orgId, logicalId))) throw new RunnerError('cancel_record_conflict', 'the cancel record could not be read back');
}
// A primary-key read. It counts only if action, resource kind, resource id and outcome match; a row at that id with other fields is a hard error.
export async function readCancelRecord(tx: Tx, d: RunnerDeps, orgId: string, logicalId: string): Promise<boolean> {
  const row = await getAuditEvent(tx, orgId, cancelRecordId(orgId, logicalId));
  if (!row) return false;
  // The actor is not compared: a rename of the runner identity must not turn old records into hard conflicts. The
  // id is a SHA-256 of the organization and the run, and the other four fields must match.
  if (row.action !== CANCEL.action || row.resourceKind !== CANCEL.resourceKind || row.resourceId !== logicalId || row.outcome !== CANCEL.outcome) {
    throw new RunnerError('cancel_record_conflict', 'a foreign row sits at this stage run\'s cancel record id');
  }
  return true;
}

// ---------------------------------------------------------------- handles
export type RunView = { handle: RunHandle; allocation: AllocationRow | undefined; cancelled: boolean };

// The latest generation's handle. A terminal result names the allocation that produced it (the completed one).
export async function viewOf(tx: Tx, d: RunnerDeps, stage: RunnerStageRun): Promise<RunView | undefined> {
  const cancelled = await readCancelRecord(tx, d, stage.orgId, stage.logicalId);
  const all = await listAllocationsOfStageRun(tx, stage.orgId, stage.id);
  const completed = [...all].reverse().find((a) => a.state === 'completed');
  const latest = stage.resultRef !== null ? (completed ?? all.at(-1)) : all.at(-1);
  if (stage.resultRef !== null) {
    return { handle: { stageRunId: stage.logicalId, generation: latest?.generation ?? 0, epoch: latest?.ownerEpoch ?? 0, state: 'completed' }, allocation: latest, cancelled };
  }
  if (!latest) return cancelled ? { handle: { stageRunId: stage.logicalId, generation: 0, epoch: 0, state: 'cancelled' }, allocation: undefined, cancelled } : undefined;
  return { handle: { stageRunId: stage.logicalId, generation: latest.generation, epoch: latest.ownerEpoch, state: handleState(latest.state, cancelled) }, allocation: latest, cancelled };
}

export async function liveAllocation(tx: Tx, orgId: string, stageRunId: string): Promise<AllocationRow | undefined> {
  return (await listAllocationsOfStageRun(tx, orgId, stageRunId)).find((a) => isLive(a.state));
}
export { getAllocation };
