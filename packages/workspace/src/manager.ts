// WorkspaceManager (W-018, part one of four): rows, generations, epochs, state, fencing and accepted
// receipts. Postgres only. It never touches a filesystem: a Git clone happens elsewhere (the
// GitMaterializer), and the manager only builds the request for it and accepts its receipt.
import { createHash } from 'node:crypto';
import type { ArtifactService, AuthContext } from '@factory/artifacts';
import type { ArtifactRef, CandidateManifest, Role, ServiceInterfaces, WorkspaceRecord } from '@factory/contracts';
import { canonicalJson } from '@factory/domain';
import {
  type Database, type Tx, type WorkspaceRow, type WorkspaceState,
  checkpointRetained, findCandidateByManifest, findLinkedArtifact, findStageRunByLogicalId, getWorkspace, insertWorkspace, isLockTimeout,
  linkWorkspaceCandidate, lockWorkspace, recordWorkspaceAudit, transitionWorkspace,
} from '@factory/database';
import { assertTaskBranch } from './branch.ts';
import { WorkspaceError } from './errors.ts';
import type { GitMaterializer, MaterializeReceipt, MaterializeRequest } from './materializer.ts';
import { assertNoCallerSuppliedSource, isUuid, resolveSource } from './paths.ts';

export type WorkspaceSpec = {
  repositoryId: string; baseCommit: string; branch?: string; role: WorkspaceRecord['role'];
  stageRunId: string; setupProfileRef: ArtifactRef; specHash: string;
};
export type CandidateBinding = { stageRunId: string; setupProfileRef: ArtifactRef };
export type CandidateSource = { bundle: ArtifactRef; commit: string; expectedTreeDigest: string; bytes?: Uint8Array };
export type MaterializationRequestResult =
  | { ok: true; request: MaterializeRequest }
  | { ok: false; code: 'restore_unavailable' | 'not_materializable' };
export type ReplaceWriterOutcome = { record: WorkspaceRecord; generation: number; ownerEpoch: number; next: 'materialize' | 'restore_required' };
export type ReleaseOutcome = { state: 'released' | 'retained' | 'quarantined' | 'releasing'; needsOperator?: boolean };

// The reference WorkspaceManager, plus what the runner needs for two-phase materialization.
export interface WorkspaceManagerService extends ServiceInterfaces.WorkspaceManager {
  materializeCandidate(ctx: AuthContext, candidateRef: ArtifactRef, role: 'reviewer' | 'verifier', binding?: CandidateBinding): Promise<WorkspaceRecord[]>;
  materializationRequest(ctx: AuthContext, id: string, expectedEpoch: number): Promise<MaterializationRequestResult>;
  acceptMaterialization(ctx: AuthContext, id: string, expectedEpoch: number, receipt: MaterializeReceipt): Promise<WorkspaceRecord>;
  markWriterStarted(ctx: AuthContext, id: string, expectedEpoch: number, podUid: string): Promise<WorkspaceRecord>;
  replaceWriter(ctx: AuthContext, id: string, expectedEpoch: number): Promise<ReplaceWriterOutcome>;
  release(ctx: AuthContext, id: string, expectedEpoch: number): Promise<ReleaseOutcome>;
}

// What LocalWorkspaceHost needs and nothing else may call: it holds the row lock across the clone, so
// it must stay in one transaction. Reached only through hostInternals(), which index.ts does not export.
export type HostInternals = {
  isRunner(ctx: AuthContext): boolean;
  probe(ctx: AuthContext, id: string): Promise<'ready' | 'not_materializable' | 'restore_unavailable'>;
  resolveCandidateSource(ctx: AuthContext, id: string, withBytes: boolean): Promise<CandidateSource | undefined>;
  requestInTx(tx: Tx, row: WorkspaceRow, source?: CandidateSource): Promise<MaterializationRequestResult>;
  acceptInTx(tx: Tx, row: WorkspaceRow, receipt: MaterializeReceipt, source?: CandidateSource): Promise<'accepted' | 'unchanged'>;
};
const internals = new WeakMap<object, HostInternals>();
export function hostInternals(manager: WorkspaceManagerService): HostInternals {
  const found = internals.get(manager);
  if (!found) throw new WorkspaceError('invalid_request', 'not a workspace manager made by createWorkspaceManager');
  return found;
}

export type WorkspaceManagerOptions = { db: Database; artifacts: ArtifactService; runnerIdentity: string; materializer?: GitMaterializer; lockWaitMs?: number };

const WORKSPACE_ROLES: readonly Role[] = ['discovery', 'planner', 'criteria_author', 'implementer', 'reviewer', 'adversarial_tester', 'verifier', 'publisher', 'knowledge_curator'];
const COMMIT = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
const HEX64 = /^[0-9a-f]{64}$/;
const LOCK_WAIT_MS = 75_000;
export const MATERIALIZATION_PURPOSE = (workspaceId: string, generation: number): string => `workspace_materialization/${workspaceId}/g${String(generation)}`;
export const CANDIDATE_PURPOSE = (workspaceId: string): string => `workspace_candidate/${workspaceId}`;
const REPLACEABLE: readonly WorkspaceState[] = ['allocated', 'active', 'quiescing', 'checkpointed', 'retained'];
const RELEASABLE: readonly WorkspaceState[] = ['allocated', 'checkpointed', 'retained', 'releasing'];

// Version-8 UUID from SHA-256, so a retried candidate copy finds the same rows and directories.
export function deriveWorkspaceId(orgId: string, candidateId: string, repositoryId: string, role: string, stageRunId: string): string {
  const h = createHash('sha256').update(['factory-workspace/1', orgId, candidateId, repositoryId, role, stageRunId].join('\n')).digest();
  const b = Buffer.from(h.subarray(0, 16));
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x80;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const x = b.toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

const record = (r: WorkspaceRow): WorkspaceRecord => ({
  id: r.id, orgId: r.orgId, taskId: r.taskId, repositoryId: r.repositoryId, role: r.role as WorkspaceRecord['role'],
  ...(r.branch === null ? {} : { branch: r.branch }), baseCommit: r.baseCommit, ...(r.candidateCommit === null ? {} : { candidateCommit: r.candidateCommit }),
  state: r.state, generation: r.generation, ownerEpoch: r.ownerEpoch, stageRunId: r.stageRunLogicalId,
  setupProfileRef: r.setupProfileRef as ArtifactRef, ...(r.checkpointRef === null ? {} : { checkpointRef: r.checkpointRef as ArtifactRef }),
});

const looksLikeRef = (r: unknown): r is ArtifactRef => typeof r === 'object' && r !== null
  && typeof (r as ArtifactRef).artifactId === 'string' && HEX64.test((r as ArtifactRef).sha256) && typeof (r as ArtifactRef).mediaType === 'string'
  && typeof (r as ArtifactRef).schemaVersion === 'string' && Number.isSafeInteger((r as ArtifactRef).sizeBytes);

export function createWorkspaceManager(o: WorkspaceManagerOptions): WorkspaceManagerService {
  const { db, artifacts } = o;

  const isRunner = (ctx: AuthContext): boolean => ctx.actorKind === 'service' && ctx.actorId === o.runnerIdentity;
  async function requireRunner(ctx: AuthContext, action: string, resourceId: string): Promise<void> {
    if (isRunner(ctx)) return;
    // Denials are committed in their own transaction; the refused call's own transaction never ran.
    await db.withTenant({ orgId: ctx.orgId }, (tx) => recordWorkspaceAudit(tx, {
      orgId: ctx.orgId, actorId: ctx.actorId, action, resourceId, outcome: 'denied', correlationId: ctx.correlationId,
      requestDigest: createHash('sha256').update(canonicalJson({ action, resourceId })).digest('hex') }));
    throw new WorkspaceError('forbidden', `${action} is limited to the runner service identity`);
  }
  const checkEpoch = (row: WorkspaceRow, expected: number): void => {
    if (!Number.isSafeInteger(expected) || row.ownerEpoch !== expected) throw new WorkspaceError('stale_epoch', `workspace is at epoch ${String(row.ownerEpoch)}, not ${String(expected)}`, { current: row.ownerEpoch, expected });
  };
  async function lockOrThrow(tx: Tx, ctx: AuthContext, id: string, wait?: number): Promise<WorkspaceRow> {
    if (!isUuid(id)) throw new WorkspaceError('invalid_request', 'workspace id must be a UUID');
    let row: WorkspaceRow | undefined;
    try { row = await lockWorkspace(tx, ctx.orgId, id, 'update', wait); }
    catch (e) { if (isLockTimeout(e)) throw new WorkspaceError('publish_in_progress', 'could not get the workspace row lock in time (a publish or another transition holds it); retry'); throw e; }
    if (!row) throw new WorkspaceError('not_found', 'unknown workspace');
    checkTask(ctx, row.taskId);
    return row;
  }
  // A caller scoped to a task may touch only that task's workspaces; its scope is never rewritten.
  const checkTask = (ctx: AuthContext, taskId: string): void => {
    if (ctx.taskId !== undefined && ctx.taskId !== taskId) throw new WorkspaceError('forbidden', 'the caller is scoped to another task');
  };

  async function acceptedReceipt(tx: Tx, row: WorkspaceRow): Promise<{ sha256: string } | undefined> {
    return findLinkedArtifact(tx, row.orgId, row.taskId, MATERIALIZATION_PURPOSE(row.id, row.generation));
  }

  async function candidateLink(tx: Tx, row: WorkspaceRow): Promise<ArtifactRef | undefined> {
    const l = await findLinkedArtifact(tx, row.orgId, row.taskId, CANDIDATE_PURPOSE(row.id));
    return l ? { artifactId: l.artifactId, sha256: l.sha256, mediaType: l.mediaType, schemaVersion: l.schemaVersion, sizeBytes: l.sizeBytes } : undefined;
  }

  async function readCandidateSource(ctx: AuthContext, row: WorkspaceRow, manifestRef: ArtifactRef, withBytes: boolean): Promise<CandidateSource> {
    if (ctx.taskId === undefined) throw new WorkspaceError('forbidden', 'reading a candidate needs a task-scoped caller');
    const read = ctx; // the caller's own scope: a caller scoped to task A cannot read task B's manifest or bundle
    const manifest = JSON.parse((await artifacts.readVerified(read, manifestRef)).toString('utf8')) as CandidateManifest;
    const repo = manifest.repositories.find((r) => r.repositoryId === row.repositoryId && r.candidateCommit === row.candidateCommit);
    if (!repo || repo.candidateCommit !== row.candidateCommit) throw new WorkspaceError('binding_mismatch', 'the candidate manifest has no entry for this workspace');
    const bytes = withBytes ? await artifacts.readVerified(read, repo.sourceRef, 512 * 1024 * 1024) : undefined;
    return { bundle: repo.sourceRef, commit: repo.candidateCommit, expectedTreeDigest: repo.treeDigest, ...(bytes ? { bytes } : {}) };
  }

  async function requestInTx(tx: Tx, row: WorkspaceRow, source?: CandidateSource): Promise<MaterializationRequestResult> {
    if (row.state !== 'allocated') return { ok: false, code: 'not_materializable' };
    // Lost work is never papered over with a fresh clone.
    if (row.checkpointRef !== null) return { ok: false, code: 'restore_unavailable' };
    if (await acceptedReceipt(tx, row)) return { ok: false, code: 'not_materializable' };
    const target = { orgId: row.orgId, workspaceId: row.id, generation: row.generation };
    if (await candidateLink(tx, row)) {
      if (!source) throw new WorkspaceError('invalid_request', 'a candidate copy needs its resolved source');
      if (source.commit !== row.candidateCommit) throw new WorkspaceError('binding_mismatch', 'the resolved source is not the workspace\'s candidate commit');
      return { ok: true, request: { kind: 'bundle', target, bundle: source.bundle, commit: source.commit, expectedTreeDigest: source.expectedTreeDigest } };
    }
    const src = await resolveSource(tx, row.orgId, row.taskId, row.repositoryId);
    return { ok: true, request: { kind: 'remote', target, taskId: row.taskId, cloneUrl: src.cloneUrl, commit: row.baseCommit, ...(row.branch === null ? {} : { branch: row.branch }), subpath: src.subpath } };
  }

  async function acceptInTx(tx: Tx, row: WorkspaceRow, receipt: MaterializeReceipt, source?: CandidateSource): Promise<'accepted' | 'unchanged'> {
    if (!Number.isSafeInteger(receipt.generation) || !COMMIT.test(receipt.headCommit) || !HEX64.test(receipt.treeDigest) || typeof receipt.gitVersion !== 'string' || receipt.gitVersion === '') {
      throw new WorkspaceError('receipt_mismatch', 'malformed receipt');
    }
    if (receipt.generation !== row.generation) throw new WorkspaceError('receipt_mismatch', 'receipt is for another generation', { receipt: receipt.generation, current: row.generation });
    const body = Buffer.from(canonicalJson({
      schema: 'factory-workspace-materialization/1', orgId: row.orgId, workspaceId: row.id, generation: row.generation, ownerEpoch: row.ownerEpoch,
      headCommit: receipt.headCommit, treeDigest: receipt.treeDigest, gitVersion: receipt.gitVersion }), 'utf8');
    const digest = createHash('sha256').update(body).digest('hex');
    const existing = await acceptedReceipt(tx, row);
    if (existing) {
      if (existing.sha256 === digest) return 'unchanged';
      throw new WorkspaceError('conflict', 'a different receipt was already accepted for this generation');
    }
    if (row.state !== 'allocated') throw new WorkspaceError('invalid_state', `receipts are accepted only while allocated, not ${row.state}`);
    const isCandidate = (await candidateLink(tx, row)) !== undefined;
    const expectedCommit = isCandidate ? (row.candidateCommit ?? row.baseCommit) : row.baseCommit;
    if (isCandidate) {
      // The receipt must carry the digest the manifest recorded, compared under the row lock.
      if (!source) throw new WorkspaceError('invalid_request', 'accepting a candidate copy needs its resolved source');
      if (source.commit !== row.candidateCommit) throw new WorkspaceError('binding_mismatch', 'the resolved source is not the workspace\'s candidate commit');
      if (receipt.treeDigest !== source.expectedTreeDigest) throw new WorkspaceError('receipt_mismatch', 'the receipt\'s treeDigest is not the manifest\'s', { expected: source.expectedTreeDigest, got: receipt.treeDigest });
    }
    if (receipt.headCommit !== expectedCommit) throw new WorkspaceError('receipt_mismatch', 'receipt names a different commit from the request', { expected: expectedCommit, got: receipt.headCommit });
    const object = await artifacts.putControllerObject(row.orgId, body);
    await artifacts.registerControllerArtifact(tx, {
      orgId: row.orgId, taskId: row.taskId, producerId: o.runnerIdentity, object, mediaType: 'application/json', schemaVersion: '1.0',
      classification: 'ordinary', purpose: MATERIALIZATION_PURPOSE(row.id, row.generation) });
    return 'accepted';
  }

  async function resolveCandidateSource(ctx: AuthContext, id: string, withBytes: boolean): Promise<CandidateSource | undefined> {
    const found = await db.withTenant({ orgId: ctx.orgId }, async (tx) => {
      const row = await getWorkspace(tx, ctx.orgId, id);
      return row ? { row, link: await candidateLink(tx, row) } : undefined;
    });
    if (!found) throw new WorkspaceError('not_found', 'unknown workspace');
    checkTask(ctx, found.row.taskId);
    return found.link ? readCandidateSource(ctx, found.row, found.link, withBytes) : undefined;
  }

  async function probe(ctx: AuthContext, id: string): Promise<'ready' | 'not_materializable' | 'restore_unavailable'> {
    return db.withTenant({ orgId: ctx.orgId }, async (tx) => {
      const row = await getWorkspace(tx, ctx.orgId, id);
      if (!row) throw new WorkspaceError('not_found', 'unknown workspace');
      checkTask(ctx, row.taskId);
      if (row.state !== 'allocated') return 'not_materializable';
      if (row.checkpointRef !== null) return 'restore_unavailable';
      return (await acceptedReceipt(tx, row)) ? 'not_materializable' : 'ready';
    });
  }

  const service: WorkspaceManagerService = {
    async allocateOrAttach(ctx, id, spec) {
      await requireRunner(ctx, 'workspace.allocate', id);
      if (ctx.taskId === undefined) throw new WorkspaceError('forbidden', 'allocateOrAttach needs a task-scoped caller');
      if (!isUuid(id)) throw new WorkspaceError('invalid_request', 'workspace id must be a UUID');
      assertNoCallerSuppliedSource(spec);
      if (!COMMIT.test(spec.baseCommit)) throw new WorkspaceError('invalid_request', 'baseCommit must be a full Git object id');
      if (!HEX64.test(spec.specHash)) throw new WorkspaceError('invalid_request', 'specHash must be a SHA-256 digest');
      if (!WORKSPACE_ROLES.includes(spec.role)) throw new WorkspaceError('invalid_request', `unknown role ${spec.role}`);
      if (!looksLikeRef(spec.setupProfileRef)) throw new WorkspaceError('invalid_request', 'setupProfileRef must be an ArtifactRef');
      return db.withTenant({ orgId: ctx.orgId }, async (tx) => {
        const stage = await findStageRunByLogicalId(tx, ctx.orgId, spec.stageRunId);
        if (!stage) throw new WorkspaceError('not_found', 'unknown stage run');
        if (ctx.taskId !== stage.taskId) throw new WorkspaceError('forbidden', 'the stage run belongs to another task');
        if (spec.branch !== undefined) assertTaskBranch(stage.taskId, spec.branch);
        await resolveSource(tx, ctx.orgId, stage.taskId, spec.repositoryId); // the registry decides where the source is
        await insertWorkspace(tx, { orgId: ctx.orgId, id, taskId: stage.taskId, repositoryId: spec.repositoryId, stageRunId: stage.id, role: spec.role,
          ...(spec.branch === undefined ? {} : { branch: spec.branch }), baseCommit: spec.baseCommit, setupProfileRef: spec.setupProfileRef });
        const row = await lockOrThrow(tx, ctx, id);
        // SI-11: a workspace row stores no specHash, so conflict is equality of the stored columns.
        const differs = [
          row.taskId !== stage.taskId && 'taskId', row.repositoryId !== spec.repositoryId && 'repositoryId', row.stageRunId !== stage.id && 'stageRunId',
          row.role !== spec.role && 'role', (row.branch ?? undefined) !== spec.branch && 'branch', row.baseCommit !== spec.baseCommit && 'baseCommit',
          canonicalJson(row.setupProfileRef) !== canonicalJson(spec.setupProfileRef) && 'setupProfileRef',
        ].filter((x): x is string => x !== false);
        if (differs.length > 0) throw new WorkspaceError('conflict', `workspace ${id} exists with different ${differs.join(', ')}`, { fields: differs });
        return record(row);
      });
    },

    async materializationRequest(ctx, id, expectedEpoch) {
      await requireRunner(ctx, 'workspace.materialization_request', id);
      const row = await db.withTenant({ orgId: ctx.orgId }, (tx) => getWorkspace(tx, ctx.orgId, id));
      if (!row) throw new WorkspaceError('not_found', 'unknown workspace');
      checkTask(ctx, row.taskId);
      checkEpoch(row, expectedEpoch);
      const source = await resolveCandidateSource(ctx, id, false);
      return db.withTenant({ orgId: ctx.orgId }, async (tx) => {
        const fresh = await getWorkspace(tx, ctx.orgId, id);
        if (!fresh) throw new WorkspaceError('not_found', 'unknown workspace');
        checkEpoch(fresh, expectedEpoch);
        return requestInTx(tx, fresh, source);
      });
    },

    async acceptMaterialization(ctx, id, expectedEpoch, receipt) {
      await requireRunner(ctx, 'workspace.accept_materialization', id);
      const source = await resolveCandidateSource(ctx, id, false); // read before the lock; compared under it
      return db.withTenant({ orgId: ctx.orgId }, async (tx) => {
        const row = await lockOrThrow(tx, ctx, id);
        checkEpoch(row, expectedEpoch);
        await acceptInTx(tx, row, receipt, source);
        return record(row);
      });
    },

    async markWriterStarted(ctx, id, expectedEpoch, podUid) {
      await requireRunner(ctx, 'workspace.mark_writer_started', id);
      if (typeof podUid !== 'string' || podUid === '') throw new WorkspaceError('invalid_request', 'podUid is required');
      return db.withTenant({ orgId: ctx.orgId }, async (tx) => {
        const row = await lockOrThrow(tx, ctx, id);
        checkEpoch(row, expectedEpoch);
        if (row.state === 'active' && row.ownerPodUid === podUid) return record(row);
        if (row.state !== 'allocated') throw new WorkspaceError('invalid_state', `a writer can start only on an allocated workspace, not ${row.state}`);
        if (!(await acceptedReceipt(tx, row))) throw new WorkspaceError('invalid_state', 'no accepted materialization for the current generation');
        const next = await transitionWorkspace(tx, { orgId: row.orgId, id, expectedEpoch, from: ['allocated'], expectedGeneration: row.generation, patch: { state: 'active', ownerPodUid: podUid } });
        if (!next) throw new WorkspaceError('stale_epoch', 'workspace changed under the lock');
        return record(next);
      });
    },

    async replaceWriter(ctx, id, expectedEpoch) {
      await requireRunner(ctx, 'workspace.replace_writer', id);
      return db.withTenant({ orgId: ctx.orgId }, async (tx) => {
        const row = await lockOrThrow(tx, ctx, id, o.lockWaitMs ?? LOCK_WAIT_MS);
        checkEpoch(row, expectedEpoch);
        if (!REPLACEABLE.includes(row.state)) throw new WorkspaceError('invalid_state', `a writer cannot be replaced while ${row.state}`);
        // The fence commits whatever follows. g<n> is never read, renamed, reused or deleted here.
        const next = await transitionWorkspace(tx, { orgId: row.orgId, id, expectedEpoch, from: REPLACEABLE, expectedGeneration: row.generation,
          patch: { state: 'allocated', generation: row.generation + 1, ownerEpoch: row.ownerEpoch + 1, ownerPodUid: null } });
        if (!next) throw new WorkspaceError('stale_epoch', 'workspace changed under the lock');
        return { record: record(next), generation: next.generation, ownerEpoch: next.ownerEpoch, next: next.checkpointRef === null ? 'materialize' : 'restore_required' };
      });
    },

    async materializeCandidate(ctx, candidateRef, role, binding) {
      await requireRunner(ctx, 'workspace.materialize_candidate', candidateRef.artifactId);
      if (ctx.taskId === undefined) throw new WorkspaceError('forbidden', 'materializeCandidate needs a task-scoped caller');
      if (!binding) throw new WorkspaceError('verifier_binding_required', 'a candidate copy needs the verifier\'s stage run and setup profile');
      if ((role as string) !== 'reviewer' && (role as string) !== 'verifier') throw new WorkspaceError('invalid_request', 'role must be reviewer or verifier');
      if (!looksLikeRef(candidateRef) || !looksLikeRef(binding.setupProfileRef)) throw new WorkspaceError('invalid_request', 'candidateRef and setupProfileRef must be ArtifactRefs');
      const cand = await db.withTenant({ orgId: ctx.orgId }, (tx) => findCandidateByManifest(tx, ctx.orgId, candidateRef.artifactId));
      if (!cand || cand.manifestRef['sha256'] !== candidateRef.sha256) throw new WorkspaceError('not_found', 'unknown candidate');
      checkTask(ctx, cand.taskId); // the caller's own scope: task A cannot read task B's manifest or create rows for it
      const manifest = JSON.parse((await artifacts.readVerified(ctx, candidateRef)).toString('utf8')) as CandidateManifest;
      if (manifest.candidateId !== cand.id || manifest.taskId !== cand.taskId || !Array.isArray(manifest.repositories) || manifest.repositories.length === 0) {
        throw new WorkspaceError('binding_mismatch', 'the manifest does not match its candidate row');
      }
      return db.withTenant({ orgId: ctx.orgId }, async (tx) => {
        const stage = await findStageRunByLogicalId(tx, ctx.orgId, binding.stageRunId);
        if (!stage || stage.taskId !== manifest.taskId || stage.role !== role || stage.superseded || binding.stageRunId === manifest.createdByStageRunId) {
          throw new WorkspaceError('binding_mismatch', 'the stage run is not a current stage of this task in that role (and is not the author\'s)');
        }
        const out: WorkspaceRecord[] = [];
        for (const repo of manifest.repositories) {
          const id = deriveWorkspaceId(ctx.orgId, manifest.candidateId, repo.repositoryId, role, binding.stageRunId);
          await insertWorkspace(tx, { orgId: ctx.orgId, id, taskId: manifest.taskId, repositoryId: repo.repositoryId, stageRunId: stage.id, role,
            baseCommit: repo.baseCommit, candidateCommit: repo.candidateCommit, setupProfileRef: binding.setupProfileRef });
          const row = await lockOrThrow(tx, ctx, id);
          if (row.taskId !== manifest.taskId || row.repositoryId !== repo.repositoryId || row.stageRunId !== stage.id || row.role !== role || row.branch !== null
            || row.baseCommit !== repo.baseCommit || row.candidateCommit !== repo.candidateCommit || canonicalJson(row.setupProfileRef) !== canonicalJson(binding.setupProfileRef)) {
            throw new WorkspaceError('conflict', `candidate workspace ${id} exists with different fields`);
          }
          await linkWorkspaceCandidate(tx, { orgId: ctx.orgId, taskId: manifest.taskId, artifactId: candidateRef.artifactId, stageRunId: stage.id, candidateId: cand.id, purpose: CANDIDATE_PURPOSE(id) });
          out.push(record(row));
        }
        return out;
      });
    },

    async release(ctx, id, expectedEpoch) {
      await requireRunner(ctx, 'workspace.release', id);
      const claimed = await db.withTenant({ orgId: ctx.orgId }, async (tx) => {
        const row = await lockOrThrow(tx, ctx, id);
        if (row.state === 'released') return { done: true as const };
        checkEpoch(row, expectedEpoch);
        if (row.state === 'active' || row.state === 'quiescing') throw new WorkspaceError('writer_active', `workspace is ${row.state}; stop the writer first`);
        if (!RELEASABLE.includes(row.state)) throw new WorkspaceError('invalid_state', `a workspace in ${row.state} cannot be released`);
        // Spec 06:100: release only after an accepted checkpoint/output and a retention check. Until
        // W-020 builds checkpoints, a checkpointed or retained copy is released only when its
        // checkpoint_ref names a registered artifact that is still inside its retention window.
        if ((row.state === 'checkpointed' || row.state === 'retained') && (row.checkpointRef === null || !(await checkpointRetained(tx, row.orgId, row.checkpointRef)))) {
          throw new WorkspaceError('checkpoint_not_accepted', `a ${row.state} workspace is released only after its checkpoint is accepted and retained`);
        }
        if (row.state !== 'releasing') {
          const next = await transitionWorkspace(tx, { orgId: row.orgId, id, expectedEpoch, from: [row.state], expectedGeneration: row.generation, patch: { state: 'releasing' } });
          if (!next) throw new WorkspaceError('stale_epoch', 'workspace changed under the lock');
        }
        return { done: false as const, generation: row.generation };
      });
      if (claimed.done) return { state: 'released' };
      if (!o.materializer) return { state: 'releasing', needsOperator: true };
      const removed = await o.materializer.remove({ orgId: ctx.orgId, workspaceId: id, generation: claimed.generation });
      if (!removed.absent) return { state: 'releasing', needsOperator: true };
      return db.withTenant({ orgId: ctx.orgId }, async (tx): Promise<ReleaseOutcome> => {
        const row = await lockOrThrow(tx, ctx, id);
        if (row.state === 'released') return { state: 'released' };
        const next = await transitionWorkspace(tx, { orgId: row.orgId, id, expectedEpoch: row.ownerEpoch, from: ['releasing'], expectedGeneration: claimed.generation, patch: { state: 'released' } });
        return next ? { state: 'released' } : { state: 'releasing', needsOperator: true };
      });
    },

    checkpoint() { return Promise.reject(new WorkspaceError('not_supported', 'checkpoint arrives with W-020')); },
    restore() { return Promise.reject(new WorkspaceError('not_supported', 'restore arrives with W-020')); },
  };
  internals.set(service, { isRunner, probe, resolveCandidateSource, requestInTx, acceptInTx });
  return service;
}
