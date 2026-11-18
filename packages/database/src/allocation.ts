// Execution allocation rows (chapter 06, W-017): insert, lock, guarded transitions, heartbeat and
// deadlines, capacity rows, the per-stage-run cancel record, and runner audit rows. Tx-taking row
// operations only: no Kubernetes, no filesystem.
//
// Time is never taken from the caller or from the process. Every age and expiry is computed here, in SQL, on
// clock_timestamp() (not now(), which is the transaction's start and is stale after a lock wait). Writes stamp
// updated_at after the row lock is held (the caller locks in its own statement first). The age and expiry columns
// that `getAllocation` returns are read without a lock unless the caller locked first (`lockAllocation` does); a
// judgement made on an unlocked read is safe only because the write that follows is a compare-and-swap on the
// state, the epoch and the writer claim, so a stale judgement changes nothing.
import type { Tx } from './db.ts';

export const ALLOCATION_STATES = ['desired', 'starting', 'running', 'suspect', 'stopping', 'finalizing', 'terminated', 'completed', 'quarantined'] as const;
export type AllocationState = (typeof ALLOCATION_STATES)[number];

export type AllocationRow = {
  orgId: string; id: string; stageRunId: string; stageRunLogicalId: string; taskId: string; workspaceId: string | null;
  generation: number; ownerEpoch: number; specHash: string; jobName: string; jobUid: string | null; podUid: string | null;
  namespace: string; supervisorIdentity: string; state: AllocationState;
  // Judgements made in SQL on clock_timestamp(), after the row lock (when one was taken).
  leaseExpired: boolean; leaseRemainingMs: number | null; heartbeatAgeMs: number | null; sinceUpdateMs: number; terminated: boolean;
  // How long before the last transition the last heartbeat fell (null: no heartbeat ever). `updated_at` is written only by a transition in the stopping state.
  heartbeatBeforeUpdateMs: number | null;
};

type RawAllocation = {
  org_id: string; id: string; stage_run_id: string; logical_id: string; task_id: string; workspace_id: string | null; generation: number; owner_epoch: string;
  spec_hash: string; job_name: string; job_uid: string | null; pod_uid: string | null; namespace: string; supervisor_identity: string; state: AllocationState;
  lease_expired: boolean; lease_remaining_ms: string | null; heartbeat_age_ms: string | null; since_update_ms: string; terminated: boolean; hb_before_update_ms: string | null;
};

const SELECT = `SELECT a.org_id, a.id, a.stage_run_id, s.logical_id, s.task_id, a.workspace_id, a.generation, a.owner_epoch, a.spec_hash, a.job_name, a.job_uid, a.pod_uid,
  a.namespace, a.supervisor_identity, a.state,
  (a.controller_lease_until IS NOT NULL AND a.controller_lease_until <= clock_timestamp()) AS lease_expired,
  floor(extract(epoch FROM (a.controller_lease_until - clock_timestamp())) * 1000)::bigint AS lease_remaining_ms,
  floor(extract(epoch FROM (clock_timestamp() - a.last_heartbeat_at)) * 1000)::bigint AS heartbeat_age_ms,
  floor(extract(epoch FROM (clock_timestamp() - a.updated_at)) * 1000)::bigint AS since_update_ms,
  (a.terminated_at IS NOT NULL) AS terminated,
  floor(extract(epoch FROM (a.updated_at - a.last_heartbeat_at)) * 1000)::bigint AS hb_before_update_ms
  FROM factory.execution_allocation a JOIN factory.stage_run s ON s.org_id = a.org_id AND s.id = a.stage_run_id`;

const num = (v: string | null): number | null => (v === null ? null : Number(v));
const toRow = (r: RawAllocation): AllocationRow => ({
  orgId: r.org_id, id: r.id, stageRunId: r.stage_run_id, stageRunLogicalId: r.logical_id, taskId: r.task_id, workspaceId: r.workspace_id,
  generation: r.generation, ownerEpoch: Number(r.owner_epoch), specHash: r.spec_hash, jobName: r.job_name, jobUid: r.job_uid, podUid: r.pod_uid,
  namespace: r.namespace, supervisorIdentity: r.supervisor_identity, state: r.state,
  leaseExpired: r.lease_expired, leaseRemainingMs: num(r.lease_remaining_ms), heartbeatAgeMs: num(r.heartbeat_age_ms), sinceUpdateMs: Number(r.since_update_ms), terminated: r.terminated,
  heartbeatBeforeUpdateMs: num(r.hb_before_update_ms),
});

export const UNIQUE_VIOLATION = '23505';
export const isUniqueViolation = (e: unknown): boolean => typeof e === 'object' && e !== null && (e as { code?: unknown }).code === UNIQUE_VIOLATION;

// A bounded wait for the next lock statements of this transaction; 55P03 on expiry.
export async function setLockWait(tx: Tx, ms: number): Promise<void> {
  await tx.query("SELECT set_config('lock_timeout', $1, true)", [`${String(Math.floor(ms))}ms`]);
}

// ---------------------------------------------------------------- stage runs (what the runner needs)

export type RunnerStageRun = {
  orgId: string; id: string; taskId: string; logicalId: string; nodeId: string; semanticAttempt: number; role: string; status: string;
  inputHash: string; limits: Record<string, unknown>; resultRef: Record<string, unknown> | null; superseded: boolean; taskStatus: string;
};
type RawStage = { org_id: string; id: string; task_id: string; logical_id: string; node_id: string; semantic_attempt: number; role: string; status: string; input_hash: string; limits: Record<string, unknown>; result_ref: Record<string, unknown> | null; superseded: boolean; task_status: string };
const STAGE_SELECT = `SELECT s.org_id, s.id, s.task_id, s.logical_id, s.node_id, s.semantic_attempt, s.role, s.status, s.input_hash, s.limits, s.result_ref,
  (s.superseded_at IS NOT NULL) AS superseded, t.status AS task_status
  FROM factory.stage_run s JOIN factory.task t ON t.org_id = s.org_id AND t.id = s.task_id`;
const toStage = (r: RawStage): RunnerStageRun => ({ orgId: r.org_id, id: r.id, taskId: r.task_id, logicalId: r.logical_id, nodeId: r.node_id, semanticAttempt: r.semantic_attempt, role: r.role,
  status: r.status, inputHash: r.input_hash, limits: r.limits, resultRef: r.result_ref, superseded: r.superseded, taskStatus: r.task_status });

export async function getRunnerStageRun(tx: Tx, orgId: string, logicalId: string): Promise<RunnerStageRun | undefined> {
  const r = await tx.query<RawStage>(`${STAGE_SELECT} WHERE s.org_id = $1 AND s.logical_id = $2`, [orgId, logicalId]);
  return r.rows[0] ? toStage(r.rows[0]) : undefined;
}
export async function getRunnerStageRunById(tx: Tx, orgId: string, id: string): Promise<RunnerStageRun | undefined> {
  const r = await tx.query<RawStage>(`${STAGE_SELECT} WHERE s.org_id = $1 AND s.id = $2`, [orgId, id]);
  return r.rows[0] ? toStage(r.rows[0]) : undefined;
}
// FOR UPDATE on the stage run: the first lock of the allocate and cancel steps. The caller sets the wait first.
export async function lockRunnerStageRun(tx: Tx, orgId: string, logicalId: string): Promise<RunnerStageRun | undefined> {
  const l = await tx.query('SELECT 1 FROM factory.stage_run WHERE org_id = $1 AND logical_id = $2 FOR UPDATE', [orgId, logicalId]);
  if ((l.rowCount ?? 0) === 0) return undefined;
  return getRunnerStageRun(tx, orgId, logicalId);
}

// 'reserved' (and nothing else), 'missing', or 'settled' (a row of any other kind exists for the key).
export async function budgetReservationState(tx: Tx, orgId: string, taskId: string, operationKey: string): Promise<'reserved' | 'missing' | 'settled'> {
  const r = await tx.query<{ kind: string }>(`SELECT l.kind FROM factory.budget_ledger l JOIN factory.budget_account a ON a.org_id = l.org_id AND a.id = l.account_id
    WHERE l.org_id = $1 AND a.task_id = $2 AND l.operation_key = $3`, [orgId, taskId, operationKey]);
  const kinds = r.rows.map((x) => x.kind);
  if (!kinds.includes('reservation')) return 'missing';
  return kinds.length === 1 ? 'reserved' : 'settled';
}

// ---------------------------------------------------------------- allocations

export async function getAllocation(tx: Tx, orgId: string, id: string): Promise<AllocationRow | undefined> {
  const r = await tx.query<RawAllocation>(`${SELECT} WHERE a.org_id = $1 AND a.id = $2`, [orgId, id]);
  return r.rows[0] ? toRow(r.rows[0]) : undefined;
}

// Locks the row in its own statement, then reads it, so every clock judgement in the row is made after the lock.
export async function lockAllocation(tx: Tx, orgId: string, id: string): Promise<AllocationRow | undefined> {
  const l = await tx.query('SELECT 1 FROM factory.execution_allocation WHERE org_id = $1 AND id = $2 FOR UPDATE', [orgId, id]);
  if ((l.rowCount ?? 0) === 0) return undefined;
  return getAllocation(tx, orgId, id);
}

export async function listAllocationsOfStageRun(tx: Tx, orgId: string, stageRunId: string): Promise<AllocationRow[]> {
  const r = await tx.query<RawAllocation>(`${SELECT} WHERE a.org_id = $1 AND a.stage_run_id = $2 ORDER BY a.generation LIMIT 64`, [orgId, stageRunId]);
  return r.rows.map(toRow);
}
export async function listAllocationsOfWorkspace(tx: Tx, orgId: string, workspaceId: string): Promise<AllocationRow[]> {
  const r = await tx.query<RawAllocation>(`${SELECT} WHERE a.org_id = $1 AND a.workspace_id = $2 ORDER BY a.generation LIMIT 64`, [orgId, workspaceId]);
  return r.rows.map(toRow);
}
// The reconciler's work list: live allocations it drives (finalizing is left to W-019 and W-020), oldest touch first.
export async function listReconcilableAllocationIds(tx: Tx, orgId: string, limit: number): Promise<string[]> {
  const r = await tx.query<{ id: string }>(`SELECT id FROM factory.execution_allocation WHERE org_id = $1 AND state IN ('desired','starting','running','suspect','stopping')
    ORDER BY updated_at, id LIMIT $2`, [orgId, limit]);
  return r.rows.map((x) => x.id);
}

export async function insertAllocation(tx: Tx, input: {
  orgId: string; id: string; stageRunId: string; workspaceId: string | null; generation: number; ownerEpoch: number; specHash: string;
  jobName: string; namespace: string; supervisorIdentity: string; startDeadlineSeconds: number;
}): Promise<AllocationRow> {
  await tx.query(`INSERT INTO factory.execution_allocation (org_id, id, stage_run_id, workspace_id, generation, owner_epoch, spec_hash, job_name, namespace, supervisor_identity, state, controller_lease_until, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'desired', clock_timestamp() + make_interval(secs => $11::double precision), clock_timestamp())`,
    [input.orgId, input.id, input.stageRunId, input.workspaceId, input.generation, input.ownerEpoch, input.specHash, input.jobName, input.namespace, input.supervisorIdentity, input.startDeadlineSeconds]);
  const row = await getAllocation(tx, input.orgId, input.id);
  if (!row) throw new Error('allocation not persisted');
  return row;
}

export type AllocationTransition = {
  orgId: string; id: string; ownerEpoch: number; from: readonly AllocationState[]; to: AllocationState;
  // null: the deadline is cleared; a number: the phase deadline is that many seconds ahead; absent: unchanged.
  leaseSeconds?: number | null;
  heartbeat?: boolean;
  jobUid?: string;      // set only while job_uid is still null
  terminated?: boolean; // terminated_at = clock_timestamp()
  // The row's deadline must not have passed, judged in this statement on clock_timestamp() (the lease clause of `starting → running`).
  leaseUnexpired?: boolean;
};

// Guarded transition: compare-and-swap on id, owner_epoch and the expected states. The caller holds the
// row lock. Every write stamps updated_at with clock_timestamp(). Returns the new row or undefined.
export async function transitionAllocation(tx: Tx, t: AllocationTransition): Promise<AllocationRow | undefined> {
  const params: unknown[] = [t.orgId, t.id, t.ownerEpoch, [...t.from], t.to];
  const sets = ['state = $5', 'updated_at = clock_timestamp()'];
  let guard = '';
  if (t.leaseSeconds === null) sets.push('controller_lease_until = NULL');
  else if (t.leaseSeconds !== undefined) { params.push(t.leaseSeconds); sets.push(`controller_lease_until = clock_timestamp() + make_interval(secs => $${String(params.length)}::double precision)`); }
  if (t.heartbeat === true) sets.push('last_heartbeat_at = clock_timestamp()');
  if (t.terminated === true) sets.push('terminated_at = clock_timestamp()');
  if (t.jobUid !== undefined) { params.push(t.jobUid); sets.push(`job_uid = $${String(params.length)}`); guard = ' AND job_uid IS NULL'; }
  if (t.leaseUnexpired === true) guard += ' AND controller_lease_until IS NOT NULL AND controller_lease_until > clock_timestamp()';
  const r = await tx.query(`UPDATE factory.execution_allocation SET ${sets.join(', ')} WHERE org_id = $1 AND id = $2 AND owner_epoch = $3 AND state = ANY($4)${guard}`, params);
  if ((r.rowCount ?? 0) === 0) return undefined;
  return getAllocation(tx, t.orgId, t.id);
}

// The writer claim: pod_uid null to a value, in the states where a permit can be granted. Nothing else changes.
export async function claimWriterPod(tx: Tx, input: { orgId: string; id: string; ownerEpoch: number; podUid: string }): Promise<AllocationRow | undefined> {
  const r = await tx.query(`UPDATE factory.execution_allocation SET pod_uid = $4, updated_at = clock_timestamp()
    WHERE org_id = $1 AND id = $2 AND owner_epoch = $3 AND pod_uid IS NULL AND state IN ('starting','running')`, [input.orgId, input.id, input.ownerEpoch, input.podUid]);
  if ((r.rowCount ?? 0) === 0) return undefined;
  return getAllocation(tx, input.orgId, input.id);
}

// One UPDATE: epoch and writer pod equal, state running or suspect, lease not passed on clock_timestamp(), and the
// workspace (when there is one) still at this epoch, owned by this pod and `active`. A fenced writer is therefore never renewed (C11).
export async function renewAllocationLease(tx: Tx, input: { orgId: string; id: string; ownerEpoch: number; podUid: string; leaseSeconds: number }): Promise<AllocationRow | undefined> {
  const r = await tx.query(`UPDATE factory.execution_allocation SET last_heartbeat_at = clock_timestamp(), updated_at = clock_timestamp(), state = 'running',
    controller_lease_until = clock_timestamp() + make_interval(secs => $5::double precision)
    WHERE org_id = $1 AND id = $2 AND owner_epoch = $3 AND pod_uid = $4 AND state IN ('running','suspect')
    AND controller_lease_until IS NOT NULL AND controller_lease_until > clock_timestamp()
    AND (workspace_id IS NULL OR EXISTS (SELECT 1 FROM factory.workspace w WHERE w.org_id = execution_allocation.org_id AND w.id = execution_allocation.workspace_id
      AND w.owner_epoch = execution_allocation.owner_epoch AND w.owner_pod_uid = $4 AND w.state = 'active'))`, [input.orgId, input.id, input.ownerEpoch, input.podUid, input.leaseSeconds]);
  if ((r.rowCount ?? 0) === 0) return undefined;
  return getAllocation(tx, input.orgId, input.id);
}

// Allocations the pass should stop because their workspace is no longer at the allocation's epoch with this pod as owner (a fenced writer).
export async function workspaceFenced(tx: Tx, orgId: string, id: string): Promise<boolean> {
  const r = await tx.query<{ ok: boolean }>(`SELECT (a.workspace_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM factory.workspace w WHERE w.org_id = a.org_id AND w.id = a.workspace_id
    AND w.owner_epoch = a.owner_epoch AND w.owner_pod_uid = a.pod_uid AND w.state = 'active')) AS ok FROM factory.execution_allocation a WHERE a.org_id = $1 AND a.id = $2`, [orgId, id]);
  return r.rows[0]?.ok === true;
}

// Writers the review budget is sized from (running and suspect), and quarantines that waited too long, for one organization.
export async function countLiveWriters(tx: Tx, orgId: string): Promise<number> {
  const r = await tx.query<{ n: string }>("SELECT count(*) AS n FROM factory.execution_allocation WHERE org_id = $1 AND state IN ('running','suspect')", [orgId]);
  return Number(r.rows[0]?.n ?? 0);
}
export async function countQuarantinedOlderThan(tx: Tx, orgId: string, seconds: number): Promise<number> {
  const r = await tx.query<{ n: string }>(`SELECT count(*) AS n FROM factory.execution_allocation WHERE org_id = $1 AND state = 'quarantined'
    AND updated_at <= clock_timestamp() - make_interval(secs => $2::double precision)`, [orgId, seconds]);
  return Number(r.rows[0]?.n ?? 0);
}

// The Postgres clock, as ISO text: the observation time of a proof is read here, in the unlocked phase, before the object is put.
export async function readDbClock(tx: Tx): Promise<string> {
  const r = await tx.query<{ t: string }>("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS t");
  return r.rows[0]?.t ?? '';
}

// ---------------------------------------------------------------- capacity (A-30)

export async function lockCapacityPool(tx: Tx, orgId: string, pool: string): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`factory-capacity/${orgId}/${pool}`]);
}
// Unexpired reserved and active rows whose key starts with `<pool>/`.
export async function countCapacityInUse(tx: Tx, orgId: string, pool: string): Promise<number> {
  const r = await tx.query<{ n: string }>(`SELECT count(*) AS n FROM factory.capacity_reservation WHERE org_id = $1 AND starts_with(pool_key, $2)
    AND state IN ('reserved','active') AND expires_at > clock_timestamp()`, [orgId, `${pool}/`]);
  return Number(r.rows[0]?.n ?? 0);
}
export async function insertCapacity(tx: Tx, input: { orgId: string; id: string; taskId: string; stageRunId: string; poolKey: string; expiresInSeconds: number }): Promise<void> {
  await tx.query(`INSERT INTO factory.capacity_reservation (org_id, id, task_id, stage_run_id, pool_key, slots, state, expires_at, updated_at)
    VALUES ($1,$2,$3,$4,$5,1,'reserved', clock_timestamp() + make_interval(secs => $6::double precision), clock_timestamp())`,
    [input.orgId, input.id, input.taskId, input.stageRunId, input.poolKey, input.expiresInSeconds]);
}
export async function setCapacityState(tx: Tx, input: { orgId: string; stageRunId: string; poolKey: string; from: Array<'reserved' | 'active'>; to: 'active' | 'released' }): Promise<boolean> {
  const r = await tx.query(`UPDATE factory.capacity_reservation SET state = $4, updated_at = clock_timestamp() WHERE org_id = $1 AND stage_run_id = $2 AND pool_key = $3 AND state = ANY($5)`,
    [input.orgId, input.stageRunId, input.poolKey, input.to, [...input.from]]);
  return (r.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------- audit rows (runner)

export type RunnerAudit = {
  orgId: string; id?: string; actorId: string; action: string; resourceKind: string; resourceId: string;
  outcome: 'accepted' | 'denied' | 'allowed'; correlationId: string; requestDigest: string; details?: Record<string, unknown>;
};
// With a fixed id the insert is idempotent (ON CONFLICT DO NOTHING); true when a row was written.
export async function recordRunnerAudit(tx: Tx, a: RunnerAudit): Promise<boolean> {
  const r = await tx.query(`INSERT INTO factory.audit_event (org_id, id, actor_id, action, resource_kind, resource_id, outcome, correlation_id, request_digest, details_ref)
    VALUES ($1, COALESCE($2::uuid, gen_random_uuid()), $3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (org_id, id) DO NOTHING`,
    [a.orgId, a.id ?? null, a.actorId, a.action, a.resourceKind, a.resourceId, a.outcome, a.correlationId, a.requestDigest, a.details === undefined ? null : JSON.stringify(a.details)]);
  return (r.rowCount ?? 0) > 0;
}

export type AuditLookup = { actorId: string; action: string; resourceKind: string; resourceId: string; outcome: string };
export async function getAuditEvent(tx: Tx, orgId: string, id: string): Promise<AuditLookup | undefined> {
  const r = await tx.query<{ actor_id: string; action: string; resource_kind: string; resource_id: string; outcome: string }>(
    'SELECT actor_id, action, resource_kind, resource_id, outcome FROM factory.audit_event WHERE org_id = $1 AND id = $2', [orgId, id]);
  const row = r.rows[0];
  return row ? { actorId: row.actor_id, action: row.action, resourceKind: row.resource_kind, resourceId: row.resource_id, outcome: row.outcome } : undefined;
}

export type AuditLookupWithDetails = AuditLookup & { details: Record<string, unknown> | null };
export async function getAuditEventWithDetails(tx: Tx, orgId: string, id: string): Promise<AuditLookupWithDetails | undefined> {
  const r = await tx.query<{ actor_id: string; action: string; resource_kind: string; resource_id: string; outcome: string; details_ref: Record<string, unknown> | null }>(
    'SELECT actor_id, action, resource_kind, resource_id, outcome, details_ref FROM factory.audit_event WHERE org_id = $1 AND id = $2', [orgId, id]);
  const row = r.rows[0];
  return row ? { actorId: row.actor_id, action: row.action, resourceKind: row.resource_kind, resourceId: row.resource_id, outcome: row.outcome, details: row.details_ref } : undefined;
}

// ---------------------------------------------------------------- controller-artifact links (the proof and the quarantine record)
export type ControllerLink = { artifactId: string; producerId: string; sha256: string; mediaType: string; schemaVersion: string; sizeBytes: number; classification: string };
// Every link with this purpose; with `producerId`, only that producer's (filtered in SQL, so a foreign link cannot crowd the runner's out of the page). `artifact_link` has no unique key, so more than one is possible.
export async function listLinksByPurpose(tx: Tx, orgId: string, purpose: string, producerId?: string): Promise<ControllerLink[]> {
  const r = await tx.query<{ artifact_id: string; producer_id: string; sha256: string; media_type: string; schema_version: string; size_bytes: string; classification: string }>(
    `SELECT l.artifact_id, a.producer_id, a.sha256, a.media_type, a.schema_version, a.size_bytes, a.classification FROM factory.artifact_link l
     JOIN factory.artifact a ON a.org_id = l.org_id AND a.id = l.artifact_id WHERE l.org_id = $1 AND l.purpose = $2 AND ($3::text IS NULL OR a.producer_id = $3) ORDER BY l.created_at, l.id LIMIT 8`, [orgId, purpose, producerId ?? null]);
  return r.rows.map((x) => ({ artifactId: x.artifact_id, producerId: x.producer_id, sha256: x.sha256, mediaType: x.media_type, schemaVersion: x.schema_version, sizeBytes: Number(x.size_bytes), classification: x.classification }));
}

// The latest diagnostic stop or quarantine reason recorded for an allocation, if any.
export async function latestAllocationReason(tx: Tx, orgId: string, allocationId: string): Promise<string | undefined> {
  const r = await tx.query<{ reason: string | null }>(`SELECT details_ref->>'reason' AS reason FROM factory.audit_event WHERE org_id = $1 AND resource_kind = 'execution_allocation'
    AND resource_id = $2 AND action IN ('runner.allocation_stopping','runner.allocation_quarantined') ORDER BY created_at DESC, id DESC LIMIT 1`, [orgId, allocationId]);
  return r.rows[0]?.reason ?? undefined;
}

// Organizations the reconciler walks (an intentionally unscoped lookup, like the dispatcher's).
export async function listActiveOrganizationIds(tx: Tx): Promise<string[]> {
  const r = await tx.query<{ id: string }>("SELECT id FROM factory.organization WHERE status = 'active' ORDER BY id LIMIT 1000");
  return r.rows.map((x) => x.id);
}
