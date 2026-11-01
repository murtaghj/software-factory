// Trusted artifact service implementing the chapter 02 artifact storage protocol (W-007):
//   1. reserve: authorize the producer and bind the upload to org, scope, authority, media type,
//      schema version, classification and size; labels are derived, never caller-supplied.
//   2. upload: a capability that can write only that upload's temporary key, within its byte limit.
//   3. finalize: stream the temporary object, verify length, SHA-256 and content against the
//      reservation, and reject any producer/scope/authority mismatch.
//   4. promote to the immutable org/{orgId}/sha256/{digest} key (conditional create; an existing
//      object is re-verified).
//   5. register metadata in one transaction and return the ArtifactRef. Only a registered row can
//      satisfy a gate; an object without one is an orphan.
//   6. sweep expired uploads and unreferenced objects.
import { createHash, randomUUID } from 'node:crypto';
import type { ArtifactAccess, ArtifactRef, ArtifactView } from '@factory/contracts';
import type { Database, Tx } from '@factory/database';
import { CapabilitySigner, type DownloadCapability } from './capability.ts';
import { ArtifactError } from './errors.ts';
import { ObjectNotFound, ObjectTooLarge, type ObjectStore } from './object-store.ts';

export type AuthContext = { orgId: string; actorId: string; actorKind: 'human' | 'service'; taskId?: string; principalId?: string; groups?: string[]; grantIds: string[]; correlationId: string };
export type Classification = 'ordinary' | 'restricted' | 'sensitive_session';
export type Owner = { kind: 'application_draft'; applicationId: string } | { kind: 'organization_controller'; controllerKind: 'emergency_stop' | 'policy_release' };

// Verifies current owner-scope authority from authenticated context and pinned policy. The default
// grants nothing: owner scopes stay closed until an authority resolver is configured (W-008).
export interface OwnerAuthority {
  verify(ctx: AuthContext, owner: Owner, tx: Tx): Promise<{ authorityRef: Record<string, unknown> } | undefined>;
}
export const DENY_ALL_OWNERS: OwnerAuthority = { verify: () => Promise.resolve(undefined) };

// Decides whether a caller may read an artifact through one of its caller-visible links.
export interface ReadAuthority {
  canRead(ctx: AuthContext, artifact: { links: Array<{ taskId: string }>; classification: Classification }, tx: Tx): Promise<boolean>;
}
// Default: a caller bound to a task may read artifacts linked to that task; nothing else.
export const TASK_BOUND_READS: ReadAuthority = {
  canRead: (ctx, artifact) => Promise.resolve(ctx.taskId !== undefined && artifact.links.some((l) => l.taskId === ctx.taskId)),
};

export type ArtifactServiceOptions = {
  db: Database;
  store: ObjectStore;
  signingKey: Buffer;
  downloadOrigin: string;
  now?: () => number;
  reservationTtlMs?: number;
  accessTtlMs?: number;
  retentionMs?: number;
  maxUploadBytes?: number;
  ownerAuthority?: OwnerAuthority;
  readAuthority?: ReadAuthority;
  // The separate retention job connection (factory_retention_login). Sweeps refuse to run without it.
  retention?: Database;
  // Fault injection for recovery tests: called after the object is promoted, before registration.
  hooks?: { afterPromote?: (finalKey: string) => Promise<void> };
};

const ACTIVE_STAGE = ['pending', 'ready', 'running', 'evaluating'];
const PREVIEWABLE = new Set(['text/plain', 'application/json', 'image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const DIGEST = /^[0-9a-f]{64}$/;
const LOGICAL_STAGE = /^task-[0-9a-f-]{36}\/plan-[1-9][0-9]*\/[A-Za-z0-9][A-Za-z0-9_.-]*\/attempt-[1-9][0-9]*$/;

type UploadRow = {
  id: string; producer_id: string; temporary_key: string; max_bytes: string; reservation_scope: 'task_stage' | 'application_draft' | 'organization_controller';
  task_id: string | null; stage_run_id: string | null; application_id: string | null; controller_kind: string | null; media_type: string; schema_version: string;
  data_classification: string | null; classification: Classification; state: string; expires_at: Date; artifact_id: string | null; embargo_group_id: string | null;
};
type ArtifactRow = { id: string; sha256: string; media_type: string; schema_version: string; size_bytes: string; storage_key: string; producer_id: string; classification: Classification; data_classification: string | null; created_at: Date; retention_until: Date };

export const finalKeyFor = (orgId: string, digest: string): string => `org/${orgId}/sha256/${digest}`;

export class ArtifactService {
  private readonly signer: CapabilitySigner;
  private readonly now: () => number;
  private readonly o: ArtifactServiceOptions;
  constructor(o: ArtifactServiceOptions) {
    this.o = o;
    this.signer = new CapabilitySigner(o.signingKey);
    this.now = o.now ?? Date.now;
  }

  private tenant<T>(ctx: AuthContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.o.db.withTenant({ orgId: ctx.orgId, ...(ctx.principalId ? { principalId: ctx.principalId } : {}) }, fn);
  }

  // A denial is recorded in its own committed transaction: the operation's transaction rolls back
  // when it throws, and the audit trail must still show the refused attempt.
  private async auditDenied(ctx: AuthContext, action: string, resourceId: string, details: Record<string, unknown>): Promise<void> {
    await this.tenant(ctx, (tx) => this.audit(tx, ctx, action, resourceId, 'denied', details));
  }

  private async audit(tx: Tx, ctx: AuthContext, action: string, resourceId: string, outcome: 'allowed' | 'denied', details: Record<string, unknown>): Promise<void> {
    const digest = createHash('sha256').update(JSON.stringify(details)).digest('hex');
    await tx.query('INSERT INTO factory.audit_event (org_id, id, actor_id, action, resource_kind, resource_id, outcome, correlation_id, request_digest) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [ctx.orgId, randomUUID(), ctx.actorId, action, 'artifact', resourceId, outcome, ctx.correlationId, digest]);
  }

  private validateReservation(input: { mediaType: string; schemaVersion: string; maxBytes: number; classification: Classification }): void {
    const cap = this.o.maxUploadBytes ?? 256 * 1024 * 1024;
    if (!/^[a-z]+\/[a-z0-9.+-]+$/i.test(input.mediaType)) throw new ArtifactError('invalid_request', 'invalid media type');
    if (!/^\d+\.\d+$/.test(input.schemaVersion)) throw new ArtifactError('invalid_request', 'invalid schema version');
    if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1 || input.maxBytes > cap) throw new ArtifactError('invalid_request', `maxBytes must be 1..${String(cap)}`);
    if (!['ordinary', 'restricted', 'sensitive_session'].includes(input.classification)) throw new ArtifactError('invalid_request', 'invalid classification');
  }

  private capability(orgId: string, uploadId: string, temporaryKey: string, maxBytes: number, expiresAt: number): string {
    return this.signer.sign({ kind: 'upload', orgId, uploadId, temporaryKey, maxBytes, expiresAt });
  }

  // Stage producers: exact task/stage binding, resolved through the logical stage ID.
  async reserve(ctx: AuthContext, input: { taskId: string; stageRunId: string; mediaType: string; schemaVersion: string; maxBytes: number; classification: Classification }): Promise<{ uploadId: string; uploadCapability: string; expiresAt: string }> {
    this.validateReservation(input);
    if (!LOGICAL_STAGE.test(input.stageRunId)) throw new ArtifactError('invalid_request', 'stageRunId must be a logical stage identity');
    if (ctx.actorKind !== 'service' || ctx.taskId !== input.taskId) {
      await this.auditDenied(ctx, 'artifact.reserve', input.taskId, { reason: 'producer not bound to task', input });
      throw new ArtifactError('forbidden', 'producer is not bound to this task');
    }
    return this.tenant(ctx, async (tx) => {
      const stage = await tx.query<{ id: string; status: string; task_id: string; embargo_group_id: string | null; data_classification: string | null }>(
        `SELECT s.id, s.status, s.task_id, t.embargo_group_id, a.data_classification
         FROM factory.stage_run s JOIN factory.task t ON t.org_id = s.org_id AND t.id = s.task_id
         JOIN factory.application a ON a.org_id = t.org_id AND a.id = t.primary_application_id
         WHERE s.logical_id = $1`, [input.stageRunId]);
      const row = stage.rows[0];
      if (!row || row.task_id !== input.taskId || !ACTIVE_STAGE.includes(row.status)) {
        await this.auditDenied(ctx, 'artifact.reserve', input.taskId, { reason: 'stage not active for task', input });
        throw new ArtifactError('forbidden', 'stage is not an active stage of this task');
      }
      const uploadId = randomUUID();
      const expiresAt = this.now() + (this.o.reservationTtlMs ?? 60 * 60 * 1000);
      const temporaryKey = `tmp/${ctx.orgId}/${uploadId}`;
      const authorityRef = { kind: 'task_stage_binding', taskId: input.taskId, stageRunId: input.stageRunId, actorId: ctx.actorId, grantIds: ctx.grantIds };
      await tx.query(`INSERT INTO factory.artifact_upload (org_id, id, producer_id, temporary_key, max_bytes, reservation_scope, task_id, stage_run_id, authority_ref, media_type, schema_version, data_classification, classification, state, expires_at, embargo_group_id)
        VALUES ($1,$2,$3,$4,$5,'task_stage',$6,$7,$8,$9,$10,$11,$12,'reserved',$13,$14)`,
        [ctx.orgId, uploadId, ctx.actorId, temporaryKey, input.maxBytes, input.taskId, row.id, JSON.stringify(authorityRef), input.mediaType, input.schemaVersion, row.data_classification, input.classification, new Date(expiresAt), row.embargo_group_id]);
      await this.audit(tx, ctx, 'artifact.reserve', uploadId, 'allowed', { scope: 'task_stage', input });
      return { uploadId, uploadCapability: this.capability(ctx.orgId, uploadId, temporaryKey, input.maxBytes, expiresAt), expiresAt: new Date(expiresAt).toISOString() };
    });
  }

  // Trusted registry/operator controllers only. Stage workloads can never use owner scopes.
  async reserveOwned(ctx: AuthContext, input: { owner: Owner; mediaType: string; schemaVersion: string; maxBytes: number; classification: Classification }): Promise<{ uploadId: string; uploadCapability: string; expiresAt: string }> {
    this.validateReservation(input);
    return this.tenant(ctx, async (tx) => {
      const authority = ctx.taskId === undefined ? await (this.o.ownerAuthority ?? DENY_ALL_OWNERS).verify(ctx, input.owner, tx) : undefined;
      if (!authority) {
        await this.auditDenied(ctx, 'artifact.reserve_owned', input.owner.kind, { owner: input.owner });
        throw new ArtifactError('forbidden', 'no current owner authority for this scope');
      }
      const uploadId = randomUUID();
      const expiresAt = this.now() + (this.o.reservationTtlMs ?? 60 * 60 * 1000);
      const temporaryKey = `tmp/${ctx.orgId}/${uploadId}`;
      const draft = input.owner.kind === 'application_draft' ? input.owner.applicationId : null;
      const controller = input.owner.kind === 'organization_controller' ? input.owner.controllerKind : null;
      const dataClassification = draft ? (await tx.query<{ data_classification: string | null }>('SELECT data_classification FROM factory.application WHERE id = $1', [draft])).rows[0]?.data_classification ?? null : null;
      await tx.query(`INSERT INTO factory.artifact_upload (org_id, id, producer_id, temporary_key, max_bytes, reservation_scope, application_id, controller_kind, authority_ref, media_type, schema_version, data_classification, classification, state, expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'reserved',$14)`,
        [ctx.orgId, uploadId, ctx.actorId, temporaryKey, input.maxBytes, input.owner.kind, draft, controller, JSON.stringify(authority.authorityRef), input.mediaType, input.schemaVersion, dataClassification, input.classification, new Date(expiresAt)]);
      await this.audit(tx, ctx, 'artifact.reserve_owned', uploadId, 'allowed', { owner: input.owner });
      return { uploadId, uploadCapability: this.capability(ctx.orgId, uploadId, temporaryKey, input.maxBytes, expiresAt), expiresAt: new Date(expiresAt).toISOString() };
    });
  }

  // The upload capability writes only its own temporary key, within its byte limit.
  async upload(capability: string, body: AsyncIterable<Uint8Array> | Uint8Array): Promise<{ bytes: number }> {
    const cap = this.signer.verify(capability, 'upload', this.now());
    if (!cap) throw new ArtifactError('forbidden', 'invalid or expired upload capability');
    const ok = await this.o.db.withTenant({ orgId: cap.orgId }, async (tx) => {
      const r = await tx.query("UPDATE factory.artifact_upload SET state = 'uploading', updated_at = now() WHERE id = $1 AND state IN ('reserved','uploading') AND expires_at > $2 AND temporary_key = $3", [cap.uploadId, new Date(this.now()), cap.temporaryKey]);
      return r.rowCount === 1;
    });
    if (!ok) throw new ArtifactError('state_conflict', 'upload is not open');
    try {
      return await this.o.store.putTemp(cap.temporaryKey, body, cap.maxBytes);
    } catch (e) {
      if (e instanceof ObjectTooLarge) throw new ArtifactError('too_large', e.message);
      throw e;
    }
  }

  private async loadUpload(tx: Tx, uploadId: string): Promise<UploadRow> {
    const r = await tx.query<UploadRow>('SELECT * FROM factory.artifact_upload WHERE id = $1 FOR UPDATE', [uploadId]);
    const row = r.rows[0];
    if (!row) throw new ArtifactError('not_found', 'unknown upload');
    return row;
  }

  private async verifyContent(key: string, row: UploadRow, expectedDigest: string, expectedBytes: number): Promise<void> {
    const hash = createHash('sha256');
    const chunks: Buffer[] = [];
    let bytes = 0;
    const max = Number(row.max_bytes);
    const keepForInspection = /json$/.test(row.media_type);
    try {
      for await (const chunk of this.o.store.read(key)) {
        bytes += chunk.length;
        if (bytes > max) throw new ArtifactError('too_large', 'object exceeds the reserved size');
        hash.update(chunk);
        if (keepForInspection) chunks.push(chunk);
      }
    } catch (e) {
      if (e instanceof ObjectNotFound) throw new ArtifactError('state_conflict', 'no uploaded object to finalize');
      throw e;
    }
    if (bytes !== expectedBytes) throw new ArtifactError('size_mismatch', `uploaded ${String(bytes)} bytes, expected ${String(expectedBytes)}`);
    if (hash.digest('hex') !== expectedDigest) throw new ArtifactError('digest_mismatch', 'uploaded content does not match the expected SHA-256');
    if (keepForInspection) {
      let doc: unknown;
      try { doc = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ArtifactError('content_mismatch', `content is not ${row.media_type}`); }
      const declared: unknown = typeof doc === 'object' && doc !== null && 'schemaVersion' in doc ? doc.schemaVersion : undefined;
      if (declared !== undefined && declared !== row.schema_version) throw new ArtifactError('content_mismatch', `content declares schema ${JSON.stringify(declared)}, reservation is ${row.schema_version}`);
    }
  }

  async finalize(ctx: AuthContext, input: { uploadId: string; expectedDigest: string; expectedBytes: number; producerId: string }): Promise<ArtifactRef> {
    if (!DIGEST.test(input.expectedDigest) || !Number.isSafeInteger(input.expectedBytes) || input.expectedBytes < 0) throw new ArtifactError('invalid_request', 'invalid digest or size');
    // Phase 1: authorize against the reservation and mark it verifying.
    const row = await this.tenant(ctx, async (tx) => {
      const u = await this.loadUpload(tx, input.uploadId);
      const deny = async (reason: string, code: 'forbidden' | 'expired' | 'state_conflict' = 'forbidden'): Promise<never> => {
        await this.auditDenied(ctx, 'artifact.finalize', input.uploadId, { reason });
        throw new ArtifactError(code, reason);
      };
      if (u.producer_id !== ctx.actorId || input.producerId !== ctx.actorId) await deny('authenticated producer differs from the reservation');
      if (!(u.expires_at.getTime() > this.now())) await deny('reservation expired', 'expired');
      if (u.state !== 'uploading') await deny(`upload is ${u.state}`, 'state_conflict');
      if (u.reservation_scope === 'task_stage') {
        if (ctx.taskId !== u.task_id) await deny('caller is not bound to the reserved task');
        const s = await tx.query<{ status: string }>('SELECT status FROM factory.stage_run WHERE id = $1', [u.stage_run_id]);
        if (!ACTIVE_STAGE.includes(s.rows[0]?.status ?? '')) await deny('reserved stage is no longer active');
      } else {
        const owner: Owner = u.reservation_scope === 'application_draft' ? { kind: 'application_draft', applicationId: u.application_id ?? '' } : { kind: 'organization_controller', controllerKind: (u.controller_kind ?? '') as 'emergency_stop' };
        if (ctx.taskId !== undefined || !(await (this.o.ownerAuthority ?? DENY_ALL_OWNERS).verify(ctx, owner, tx))) await deny('owner authority is no longer current');
      }
      await tx.query("UPDATE factory.artifact_upload SET state = 'verifying', updated_at = now() WHERE id = $1", [u.id]);
      return u;
    });
    // Phase 2: verify bytes outside the transaction; a failure leaves the upload failed.
    try {
      await this.verifyContent(row.temporary_key, row, input.expectedDigest, input.expectedBytes);
    } catch (e) {
      await this.tenant(ctx, async (tx) => {
        await tx.query("UPDATE factory.artifact_upload SET state = 'failed', updated_at = now() WHERE id = $1", [row.id]);
        await this.audit(tx, ctx, 'artifact.finalize', row.id, 'denied', { reason: e instanceof Error ? e.message : String(e) });
      });
      await this.o.store.delete(row.temporary_key);
      throw e;
    }
    // Phase 3: promote to the immutable key; an existing object must hold the same bytes.
    const finalKey = finalKeyFor(ctx.orgId, input.expectedDigest);
    if ((await this.o.store.promote(row.temporary_key, finalKey)) === 'exists') {
      const h = createHash('sha256');
      for await (const chunk of this.o.store.read(finalKey)) h.update(chunk);
      if (h.digest('hex') !== input.expectedDigest) throw new ArtifactError('integrity_incident', `immutable object ${finalKey} does not match its digest`);
    }
    await this.o.hooks?.afterPromote?.(finalKey);
    // Phase 4: register. Until this commits, the object is an unreferenced orphan.
    return this.tenant(ctx, async (tx) => {
      const retention = new Date(this.now() + (this.o.retentionMs ?? 365 * 24 * 60 * 60 * 1000));
      const inserted = await tx.query<{ id: string }>(`INSERT INTO factory.artifact (org_id, id, sha256, media_type, schema_version, size_bytes, storage_key, producer_id, classification, data_classification, finalized_at, retention_until, embargo_group_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),$11,$12) ON CONFLICT (org_id, sha256, media_type, schema_version, classification, data_classification, embargo_group_id) DO NOTHING RETURNING id`,
        [ctx.orgId, randomUUID(), input.expectedDigest, row.media_type, row.schema_version, input.expectedBytes, finalKey, ctx.actorId, row.classification, row.data_classification, retention, row.embargo_group_id]);
      let artifactId = inserted.rows[0]?.id;
      if (!artifactId) {
        // Reuse the verified registration with identical metadata; retention may extend, never shorten.
        const existing = await tx.query<{ id: string }>(`UPDATE factory.artifact SET retention_until = GREATEST(retention_until, $7), updated_at = now()
          WHERE sha256 = $1 AND media_type = $2 AND schema_version = $3 AND classification = $4 AND data_classification IS NOT DISTINCT FROM $5 AND embargo_group_id IS NOT DISTINCT FROM $6 RETURNING id`,
          [input.expectedDigest, row.media_type, row.schema_version, row.classification, row.data_classification, row.embargo_group_id, retention]);
        artifactId = existing.rows[0]?.id;
        if (!artifactId) throw new ArtifactError('state_conflict', 'matching artifact registration is not visible');
      }
      const updated = await tx.query("UPDATE factory.artifact_upload SET state = 'finalized', artifact_id = $2, updated_at = now() WHERE id = $1 AND state = 'verifying'", [row.id, artifactId]);
      if (updated.rowCount !== 1) throw new ArtifactError('state_conflict', 'upload changed during finalization');
      if (row.reservation_scope === 'task_stage' && row.task_id) {
        await tx.query("INSERT INTO factory.artifact_link (org_id, id, artifact_id, task_id, stage_run_id, purpose, retain_until) VALUES ($1,$2,$3,$4,$5,'stage_output',$6)",
          [ctx.orgId, randomUUID(), artifactId, row.task_id, row.stage_run_id, retention]);
      }
      await this.audit(tx, ctx, 'artifact.finalize', artifactId, 'allowed', { uploadId: row.id, sha256: input.expectedDigest });
      return { artifactId, sha256: input.expectedDigest, mediaType: row.media_type, schemaVersion: row.schema_version, sizeBytes: input.expectedBytes };
    });
  }

  private async visibleArtifact(tx: Tx, ctx: AuthContext, artifactId: string): Promise<{ row: ArtifactRow; links: Array<{ taskId: string; stageRunId: string | null; candidateId: string | null; purpose: string; retainUntil: Date }> }> {
    const r = await tx.query<ArtifactRow>('SELECT id, sha256, media_type, schema_version, size_bytes, storage_key, producer_id, classification, data_classification, created_at, retention_until FROM factory.artifact WHERE id = $1', [artifactId]);
    const row = r.rows[0];
    const links = row ? (await tx.query<{ task_id: string; logical_id: string | null; candidate_id: string | null; purpose: string; retain_until: Date }>(
      'SELECT l.task_id, s.logical_id, l.candidate_id, l.purpose, l.retain_until FROM factory.artifact_link l LEFT JOIN factory.stage_run s ON s.org_id = l.org_id AND s.id = l.stage_run_id WHERE l.artifact_id = $1 ORDER BY l.created_at, l.id', [artifactId])).rows
      .map((l) => ({ taskId: l.task_id, stageRunId: l.logical_id, candidateId: l.candidate_id, purpose: l.purpose, retainUntil: l.retain_until })) : [];
    if (!row || !(await (this.o.readAuthority ?? TASK_BOUND_READS).canRead(ctx, { links, classification: row.classification }, tx))) {
      await this.auditDenied(ctx, 'artifact.read', artifactId, { reason: 'unknown or inaccessible artifact' });
      throw new ArtifactError('not_found', 'unknown or inaccessible artifact'); // knowing an ID confers no access (INV-14)
    }
    return { row, links };
  }

  // The only read path a gate may use: the registration must exist, match the ref exactly, and the
  // stored bytes must hash to the registered digest. A missing object is artifact_unavailable.
  async readVerified(ctx: AuthContext, ref: ArtifactRef, maxBytes = 16 * 1024 * 1024): Promise<Buffer> {
    const row = await this.tenant(ctx, async (tx) => (await this.visibleArtifact(tx, ctx, ref.artifactId)).row);
    if (row.sha256 !== ref.sha256 || row.media_type !== ref.mediaType || row.schema_version !== ref.schemaVersion || Number(row.size_bytes) !== ref.sizeBytes) {
      throw new ArtifactError('ref_mismatch', 'artifact reference does not match the registered metadata');
    }
    if (ref.sizeBytes > maxBytes) throw new ArtifactError('too_large', 'artifact exceeds the read limit');
    const hash = createHash('sha256');
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of this.o.store.read(row.storage_key)) { hash.update(chunk); chunks.push(chunk); }
    } catch (e) {
      if (e instanceof ObjectNotFound) throw new ArtifactError('artifact_unavailable', 'registered object is missing');
      throw e;
    }
    const body = Buffer.concat(chunks);
    if (body.length !== ref.sizeBytes || hash.digest('hex') !== ref.sha256) throw new ArtifactError('integrity_incident', 'stored bytes do not match the registered digest');
    return body;
  }

  async view(ctx: AuthContext, artifactId: string): Promise<ArtifactView> {
    return this.tenant(ctx, async (tx) => {
      const { row, links } = await this.visibleArtifact(tx, ctx, artifactId);
      return {
        ref: { artifactId: row.id, sha256: row.sha256, mediaType: row.media_type, schemaVersion: row.schema_version, sizeBytes: Number(row.size_bytes) },
        classification: row.classification, producerId: row.producer_id, mediaType: row.media_type, sizeBytes: Number(row.size_bytes),
        createdAt: row.created_at.toISOString(), retentionUntil: row.retention_until.toISOString(),
        links: links.map((l) => ({ taskId: l.taskId, purpose: l.purpose, retainUntil: l.retainUntil.toISOString(), ...(l.stageRunId ? { stageRunId: l.stageRunId } : {}), ...(l.candidateId ? { candidateId: l.candidateId } : {}) })),
        ...(row.data_classification ? { dataClassification: row.data_classification } : {}),
      };
    });
  }

  // Short-lived download capability on the isolated download origin; audited (chapter 03).
  async access(ctx: AuthContext, artifactId: string, purpose: string): Promise<ArtifactAccess> {
    if (purpose.trim().length === 0) throw new ArtifactError('invalid_request', 'purpose is required');
    return this.tenant(ctx, async (tx) => {
      const { row } = await this.visibleArtifact(tx, ctx, artifactId);
      const disposition = PREVIEWABLE.has(row.media_type) ? 'isolated_preview' : 'attachment';
      const expiresAt = this.now() + (this.o.accessTtlMs ?? 5 * 60 * 1000);
      const token = this.signer.sign({ kind: 'download', orgId: ctx.orgId, artifactId: row.id, storageKey: row.storage_key, sha256: row.sha256, sizeBytes: Number(row.size_bytes), mediaType: row.media_type, disposition, expiresAt });
      await this.audit(tx, ctx, 'artifact.access', row.id, 'allowed', { purpose, disposition });
      return { url: `${this.o.downloadOrigin}/d/${token}`, expiresAt: new Date(expiresAt).toISOString(), sha256: row.sha256, contentDisposition: disposition };
    });
  }

  verifyDownload(token: string): DownloadCapability | undefined {
    return this.signer.verify(token, 'download', this.now());
  }

  // Maintenance runs only as the retention job role (BYPASSRLS, sweep columns only), so embargoed
  // rows are never mistaken for absent ones. Without that connection the sweep fails closed.
  private retentionTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const retention = this.o.retention;
    if (!retention) throw new ArtifactError('forbidden', 'sweeps require the retention job role');
    return retention.withoutTenant(async (tx) => {
      await tx.query('SET LOCAL ROLE factory_retention');
      return fn(tx);
    });
  }

  // Expire unfinished uploads whose reservation lapsed and delete their temporary objects.
  async sweepExpiredUploads(): Promise<number> {
    const rows = await this.retentionTx(async (tx) => (await tx.query<{ org_id: string; id: string; temporary_key: string }>(
      "UPDATE factory.artifact_upload SET state = 'expired', updated_at = now() WHERE state IN ('reserved','uploading','verifying') AND expires_at <= $1 RETURNING org_id, id, temporary_key", [new Date(this.now())])).rows);
    for (const r of rows) await this.o.store.delete(r.temporary_key);
    if (rows.length > 0) {
      await this.retentionTx(async (tx) => {
        for (const r of rows) {
          await tx.query("INSERT INTO factory.audit_event (org_id, id, actor_id, action, resource_kind, resource_id, outcome, correlation_id, request_digest) VALUES ($1,$2,'retention-job','artifact.upload_expired','artifact_upload',$3,'allowed','sweep',$4)",
            [r.org_id, randomUUID(), r.id, createHash('sha256').update(r.temporary_key).digest('hex')]);
        }
      });
    }
    return rows.length;
  }

  // Delete immutable objects that no registration (in any security group) references, after a
  // grace window, rechecking reachability immediately before each deletion.
  async sweepOrphanObjects(graceMs: number): Promise<string[]> {
    const orgs = await this.retentionTx(async (tx) => (await tx.query<{ id: string }>('SELECT id FROM factory.organization ORDER BY id')).rows.map((r) => r.id));
    const deleted: string[] = [];
    for (const orgId of orgs) {
      const candidates = (await this.o.store.list(`org/${orgId}/sha256/`)).filter((o) => o.modifiedAt.getTime() <= this.now() - graceMs);
      for (const object of candidates) {
        const referenced = await this.retentionTx(async (tx) => (await tx.query('SELECT 1 FROM factory.artifact WHERE org_id = $1 AND storage_key = $2 LIMIT 1', [orgId, object.key])).rowCount === 1);
        if (referenced) continue;
        await this.o.store.delete(object.key);
        await this.retentionTx((tx) => tx.query("INSERT INTO factory.audit_event (org_id, id, actor_id, action, resource_kind, resource_id, outcome, correlation_id, request_digest) VALUES ($1,$2,'retention-job','artifact.orphan_swept','object',$3,'allowed','sweep',$4)",
          [orgId, randomUUID(), object.key, createHash('sha256').update(object.key).digest('hex')]));
        deleted.push(object.key);
      }
    }
    return deleted;
  }
}
