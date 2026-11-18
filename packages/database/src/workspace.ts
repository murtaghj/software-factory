// Workspace rows (chapter 06, W-018). Tx-taking row operations only: insert, lock, guarded
// transitions and the few lookups the workspace manager needs. No filesystem, no Git.
//
// Every transition is a compare-and-swap on owner_epoch (and, where asked, generation) under the
// caller's row lock. Time is never taken from the caller: anything stored uses the database clock.
import type { Tx } from './db.ts';

export const WORKSPACE_STATES = ['allocated', 'active', 'quiescing', 'checkpointed', 'retained', 'releasing', 'released', 'quarantined'] as const;
export type WorkspaceState = (typeof WORKSPACE_STATES)[number];

export type WorkspaceRow = {
  orgId: string; id: string; taskId: string; repositoryId: string;
  stageRunId: string; stageRunLogicalId: string; role: string; branch: string | null;
  baseCommit: string; candidateCommit: string | null; state: WorkspaceState;
  generation: number; ownerEpoch: number; ownerPodUid: string | null;
  setupProfileRef: Record<string, unknown>; checkpointRef: Record<string, unknown> | null;
};

type RawRow = {
  org_id: string; id: string; task_id: string; repository_id: string; stage_run_id: string; logical_id: string; role: string; branch: string | null;
  base_commit: string; candidate_commit: string | null; state: WorkspaceState; generation: number; owner_epoch: string;
  owner_pod_uid: string | null; setup_profile_ref: Record<string, unknown>; checkpoint_ref: Record<string, unknown> | null;
};

const SELECT = `SELECT w.org_id, w.id, w.task_id, w.repository_id, w.stage_run_id, s.logical_id, w.role, w.branch, w.base_commit, w.candidate_commit,
  w.state, w.generation, w.owner_epoch, w.owner_pod_uid, w.setup_profile_ref, w.checkpoint_ref
  FROM factory.workspace w JOIN factory.stage_run s ON s.org_id = w.org_id AND s.id = w.stage_run_id`;

const toRow = (r: RawRow): WorkspaceRow => ({
  orgId: r.org_id, id: r.id, taskId: r.task_id, repositoryId: r.repository_id, stageRunId: r.stage_run_id, stageRunLogicalId: r.logical_id,
  role: r.role, branch: r.branch, baseCommit: r.base_commit, candidateCommit: r.candidate_commit, state: r.state,
  generation: r.generation, ownerEpoch: Number(r.owner_epoch), ownerPodUid: r.owner_pod_uid,
  setupProfileRef: r.setup_profile_ref, checkpointRef: r.checkpoint_ref,
});

export const LOCK_NOT_AVAILABLE = '55P03';
export const isLockTimeout = (e: unknown): boolean => typeof e === 'object' && e !== null && (e as { code?: unknown }).code === LOCK_NOT_AVAILABLE;

export async function insertWorkspace(tx: Tx, input: {
  orgId: string; id: string; taskId: string; repositoryId: string; stageRunId: string; role: string; branch?: string;
  baseCommit: string; candidateCommit?: string; setupProfileRef: Record<string, unknown>;
}): Promise<boolean> {
  const r = await tx.query(`INSERT INTO factory.workspace (org_id, id, task_id, repository_id, stage_run_id, role, branch, base_commit, candidate_commit, state, generation, owner_epoch, setup_profile_ref)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'allocated',1,1,$10) ON CONFLICT (org_id, id) DO NOTHING`,
    [input.orgId, input.id, input.taskId, input.repositoryId, input.stageRunId, input.role, input.branch ?? null, input.baseCommit, input.candidateCommit ?? null, JSON.stringify(input.setupProfileRef)]);
  return (r.rowCount ?? 0) > 0;
}

export async function getWorkspace(tx: Tx, orgId: string, id: string): Promise<WorkspaceRow | undefined> {
  const r = await tx.query<RawRow>(`${SELECT} WHERE w.org_id = $1 AND w.id = $2`, [orgId, id]);
  return r.rows[0] ? toRow(r.rows[0]) : undefined;
}

// 'update' for anything that changes the row; 'share' for a publisher that must keep the row from
// being replaced while it pushes. A bounded lock wait turns a stuck holder into a retryable error.
export async function lockWorkspace(tx: Tx, orgId: string, id: string, mode: 'update' | 'share', lockTimeoutMs?: number): Promise<WorkspaceRow | undefined> {
  if (lockTimeoutMs !== undefined) await tx.query("SELECT set_config('lock_timeout', $1, true)", [`${String(Math.floor(lockTimeoutMs))}ms`]);
  const r = await tx.query<RawRow>(`${SELECT} WHERE w.org_id = $1 AND w.id = $2 FOR ${mode === 'update' ? 'UPDATE' : 'SHARE'} OF w`, [orgId, id]);
  return r.rows[0] ? toRow(r.rows[0]) : undefined;
}

export type WorkspacePatch = {
  state?: WorkspaceState; ownerPodUid?: string | null; candidateCommit?: string | null;
  checkpointRef?: Record<string, unknown> | null; generation?: number; ownerEpoch?: number;
};

// Guarded transition: applies only when the epoch, the state and (if given) the generation still
// match. Returns the new row, or undefined when the guard failed and nothing changed.
export async function transitionWorkspace(tx: Tx, input: {
  orgId: string; id: string; expectedEpoch: number; from: readonly WorkspaceState[]; expectedGeneration?: number; patch: WorkspacePatch;
}): Promise<WorkspaceRow | undefined> {
  const sets: string[] = [];
  const params: unknown[] = [input.orgId, input.id, input.expectedEpoch, [...input.from]];
  const add = (column: string, value: unknown, cast = ''): void => { params.push(value); sets.push(`${column} = $${String(params.length)}${cast}`); };
  const p = input.patch;
  if (p.state !== undefined) add('state', p.state);
  if (p.ownerPodUid !== undefined) add('owner_pod_uid', p.ownerPodUid);
  if (p.candidateCommit !== undefined) add('candidate_commit', p.candidateCommit);
  if (p.checkpointRef !== undefined) add('checkpoint_ref', p.checkpointRef === null ? null : JSON.stringify(p.checkpointRef), '::jsonb');
  if (p.generation !== undefined) add('generation', p.generation);
  if (p.ownerEpoch !== undefined) add('owner_epoch', p.ownerEpoch);
  let guard = '';
  if (input.expectedGeneration !== undefined) { params.push(input.expectedGeneration); guard = ` AND generation = $${String(params.length)}`; }
  const r = await tx.query(`UPDATE factory.workspace SET ${sets.length ? `${sets.join(', ')}, ` : ''}updated_at = now()
    WHERE org_id = $1 AND id = $2 AND owner_epoch = $3 AND state = ANY($4)${guard} RETURNING id`, params);
  if ((r.rowCount ?? 0) === 0) return undefined;
  return getWorkspace(tx, input.orgId, input.id);
}

export type StageRunLookup = { id: string; taskId: string; role: string; status: string; superseded: boolean };
export async function findStageRunByLogicalId(tx: Tx, orgId: string, logicalId: string): Promise<StageRunLookup | undefined> {
  const r = await tx.query<{ id: string; task_id: string; role: string; status: string; superseded_at: Date | null }>(
    'SELECT id, task_id, role, status, superseded_at FROM factory.stage_run WHERE org_id = $1 AND logical_id = $2', [orgId, logicalId]);
  const row = r.rows[0];
  return row ? { id: row.id, taskId: row.task_id, role: row.role, status: row.status, superseded: row.superseded_at !== null } : undefined;
}

// Clone source for a workspace: the repository row and the application link, never the caller.
export async function resolveRepositorySource(tx: Tx, orgId: string, taskId: string, repositoryId: string):
  Promise<{ cloneUrl: string; defaultBranch: string; subpaths: string[] } | undefined> {
  const repo = await tx.query<{ clone_url: string; default_branch: string }>('SELECT clone_url, default_branch FROM factory.repository WHERE org_id = $1 AND id = $2', [orgId, repositoryId]);
  const row = repo.rows[0];
  if (!row) return undefined;
  const links = await tx.query<{ subpath: string }>(
    `SELECT DISTINCT ar.subpath FROM factory.application_repository ar JOIN factory.task t ON t.org_id = ar.org_id AND t.primary_application_id = ar.application_id
     WHERE ar.org_id = $1 AND ar.repository_id = $2 AND t.id = $3 ORDER BY ar.subpath`, [orgId, repositoryId, taskId]);
  return { cloneUrl: row.clone_url, defaultBranch: row.default_branch, subpaths: links.rows.map((l) => l.subpath) };
}

export type ArtifactLinkLookup = { artifactId: string; sha256: string; mediaType: string; schemaVersion: string; sizeBytes: number };
// The artifact linked to a task under an exact purpose, if any (receipts and candidate bindings).
export async function findLinkedArtifact(tx: Tx, orgId: string, taskId: string, purpose: string): Promise<ArtifactLinkLookup | undefined> {
  const r = await tx.query<{ artifact_id: string; sha256: string; media_type: string; schema_version: string; size_bytes: string }>(
    `SELECT l.artifact_id, a.sha256, a.media_type, a.schema_version, a.size_bytes FROM factory.artifact_link l
     JOIN factory.artifact a ON a.org_id = l.org_id AND a.id = l.artifact_id
     WHERE l.org_id = $1 AND l.task_id = $2 AND l.purpose = $3 ORDER BY l.created_at, l.id LIMIT 1`, [orgId, taskId, purpose]);
  const row = r.rows[0];
  return row ? { artifactId: row.artifact_id, sha256: row.sha256, mediaType: row.media_type, schemaVersion: row.schema_version, sizeBytes: Number(row.size_bytes) } : undefined;
}

// Links an existing artifact (a candidate manifest) to a task, stage run and candidate under a
// purpose. Idempotent on (task, purpose).
export async function linkWorkspaceCandidate(tx: Tx, input: { orgId: string; taskId: string; artifactId: string; stageRunId: string; candidateId: string; purpose: string }): Promise<void> {
  const existing = await findLinkedArtifact(tx, input.orgId, input.taskId, input.purpose);
  if (existing) return;
  await tx.query(`INSERT INTO factory.artifact_link (org_id, id, artifact_id, task_id, stage_run_id, candidate_id, purpose, retain_until)
    SELECT $1, gen_random_uuid(), a.id, $3, $4, $5, $6, a.retention_until FROM factory.artifact a WHERE a.org_id = $1 AND a.id = $2`,
    [input.orgId, input.artifactId, input.taskId, input.stageRunId, input.candidateId, input.purpose]);
}

export type CandidateLookup = { id: string; taskId: string; manifestRef: Record<string, unknown> };
export async function findCandidateByManifest(tx: Tx, orgId: string, manifestArtifactId: string): Promise<CandidateLookup | undefined> {
  const r = await tx.query<{ id: string; task_id: string; manifest_ref: Record<string, unknown> }>(
    "SELECT id, task_id, manifest_ref FROM factory.candidate WHERE org_id = $1 AND manifest_ref->>'artifactId' = $2 ORDER BY created_at LIMIT 1", [orgId, manifestArtifactId]);
  const row = r.rows[0];
  return row ? { id: row.id, taskId: row.task_id, manifestRef: row.manifest_ref } : undefined;
}

export async function findCandidateById(tx: Tx, orgId: string, candidateId: string): Promise<CandidateLookup | undefined> {
  const r = await tx.query<{ id: string; task_id: string; manifest_ref: Record<string, unknown> }>(
    'SELECT id, task_id, manifest_ref FROM factory.candidate WHERE org_id = $1 AND id = $2', [orgId, candidateId]);
  const row = r.rows[0];
  return row ? { id: row.id, taskId: row.task_id, manifestRef: row.manifest_ref } : undefined;
}

export async function recordWorkspaceAudit(tx: Tx, input: { orgId: string; actorId: string; action: string; resourceId: string; outcome: 'allowed' | 'denied'; correlationId: string; requestDigest: string }): Promise<void> {
  await tx.query('INSERT INTO factory.audit_event (org_id, id, actor_id, action, resource_kind, resource_id, outcome, correlation_id, request_digest) VALUES ($1, gen_random_uuid(), $2,$3,$4,$5,$6,$7,$8)',
    [input.orgId, input.actorId, input.action, 'workspace', input.resourceId, input.outcome, input.correlationId, input.requestDigest]);
}

// Is this checkpoint artifact registered, matching, and still inside its retention window (Postgres clock)?
export async function checkpointRetained(tx: Tx, orgId: string, ref: Record<string, unknown>): Promise<boolean> {
  if (typeof ref['artifactId'] !== 'string' || typeof ref['sha256'] !== 'string') return false;
  const r = await tx.query('SELECT 1 FROM factory.artifact WHERE org_id = $1 AND id = $2 AND sha256 = $3 AND retention_until > now()', [orgId, ref['artifactId'], ref['sha256']]);
  return (r.rowCount ?? 0) > 0;
}
