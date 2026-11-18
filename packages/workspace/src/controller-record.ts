// Controller artifacts that other packages cite by `ArtifactRef` and that must be retained (W-019): the quiescence proof
// and the quarantine record. They share three functions and one rule, so they share this file:
//   prepare   outside any transaction: the runner identity is required, the body is validated and put, a handle is minted;
//   register  on the CALLER's transaction (the caller holds the allocation's row lock): links the stored object once;
//   read      counts only links produced by the runner identity. `artifact_link` has no unique key, so "one per allocation" is the
//             row lock and nothing else: a second link means the lock was bypassed, and that is a hard error.
// No object-store call is ever made inside a transaction: `prepare` puts, `register` only links, `read` only reads rows.
import { randomUUID } from 'node:crypto';
import type { ArtifactService, AuthContext } from '@factory/artifacts';
import type { ArtifactRef } from '@factory/contracts';
import { listLinksByPurpose, recordRunnerAudit, type Database, type Tx } from '@factory/database';
import { canonicalJson } from '@factory/domain';
import { createHash } from 'node:crypto';
import { WorkspaceError } from './errors.ts';

export const MAX_RECORD_BYTES = 64 * 1024;
export type RecordDeps = { db: Database; artifacts: ArtifactService; runnerIdentity: string };
export type RecordKindSpec = { name: 'quiescence_proof' | 'quarantine_record'; schema: string; classification: 'ordinary' | 'restricted' };
export type RecordInput = { orgId: string; taskId: string; allocationId: string; body: Record<string, unknown> };

// A handle only `prepare` can mint: it is in this set or it is not a handle, whatever shape an object has.
const minted = new WeakSet<object>();
export type RecordHandle = Readonly<{ kind: RecordKindSpec['name']; orgId: string; taskId: string; allocationId: string; object: { storageKey: string; sha256: string; sizeBytes: number } }>;
export type Registered = { kind: 'registered'; ref: ArtifactRef } | { kind: 'exists'; ref: ArtifactRef };
export type ReadResult = { kind: 'absent' } | { kind: 'present'; ref: ArtifactRef };

const purposeOf = (k: RecordKindSpec, allocationId: string): string => `${k.name}/${allocationId}`;
const refOf = (l: { artifactId: string; sha256: string; mediaType: string; schemaVersion: string; sizeBytes: number }): ArtifactRef =>
  ({ artifactId: l.artifactId, sha256: l.sha256, mediaType: l.mediaType, schemaVersion: l.schemaVersion, sizeBytes: l.sizeBytes });

export function recordKind(spec: RecordKindSpec) {
  const purpose = (allocationId: string): string => purposeOf(spec, allocationId);

  async function prepare(deps: RecordDeps, actorId: string, input: RecordInput): Promise<RecordHandle> {
    if (actorId !== deps.runnerIdentity) {
      // Audited here, in its own transaction, so that a rollback of the caller's later transaction cannot erase the refusal.
      try {
        await deps.db.withTenant({ orgId: input.orgId }, (tx) => recordRunnerAudit(tx, {
          orgId: input.orgId, id: randomUUID(), actorId, action: `workspace.${spec.name}.prepare`, resourceKind: 'execution_allocation', resourceId: input.allocationId, outcome: 'denied',
          correlationId: `${spec.name}:${input.allocationId}`, requestDigest: createHash('sha256').update(`${spec.name}|${actorId}`).digest('hex'), details: { reason: 'not_the_runner_identity' } }));
      } catch { /* an organization that does not exist cannot hold the row; the refusal stands */ }
      throw new WorkspaceError('forbidden', `${spec.name} is accepted only from the runner identity`);
    }
    const b = input.body;
    if (b['schema'] !== spec.schema || b['allocationId'] !== input.allocationId || b['organizationId'] !== input.orgId) throw new WorkspaceError('invalid_request', `${spec.name}: the body must carry its schema and name the organization and the allocation`);
    const bytes = Buffer.from(canonicalJson(b), 'utf8');
    if (bytes.length > MAX_RECORD_BYTES) throw new WorkspaceError('invalid_request', `${spec.name} is larger than ${String(MAX_RECORD_BYTES)} bytes`);
    const object = await deps.artifacts.putControllerObject(input.orgId, bytes);
    const h: RecordHandle = Object.freeze({ kind: spec.name, orgId: input.orgId, taskId: input.taskId, allocationId: input.allocationId, object });
    minted.add(h);
    return h;
  }

  async function read(tx: Tx, deps: Pick<RecordDeps, 'runnerIdentity'>, orgId: string, allocationId: string): Promise<ReadResult> {
    const mine = await listLinksByPurpose(tx, orgId, purpose(allocationId), deps.runnerIdentity);
    if (mine.length === 0) return { kind: 'absent' };
    if (mine.length > 1) throw new WorkspaceError('conflict', `${spec.name} has ${String(mine.length)} links for one allocation: the allocation's row lock was bypassed`);
    return { kind: 'present', ref: refOf(mine[0] as NonNullable<(typeof mine)[0]>) };
  }

  async function register(tx: Tx, deps: RecordDeps, handle: RecordHandle): Promise<Registered> {
    if (!minted.has(handle) || handle.kind !== spec.name) throw new WorkspaceError('invalid_request', `${spec.name}: not a handle that prepare minted`);
    const existing = await read(tx, deps, handle.orgId, handle.allocationId);
    if (existing.kind === 'present') return { kind: 'exists', ref: existing.ref };
    const ref = await deps.artifacts.registerControllerArtifact(tx, {
      orgId: handle.orgId, taskId: handle.taskId, producerId: deps.runnerIdentity, object: handle.object, mediaType: 'application/json', schemaVersion: '1.0',
      classification: spec.classification, purpose: purpose(handle.allocationId) });
    return { kind: 'registered', ref };
  }

  // The body of the stored record, read OUTSIDE any transaction and checked: the link must be the runner's and the body must name the
  // allocation asked for. A link whose body names another allocation is not this allocation's record.
  async function readChecked(deps: RecordDeps, orgId: string, taskId: string, allocationId: string): Promise<(ReadResult & { kind: 'present'; body: Record<string, unknown> }) | { kind: 'absent' }> {
    const r = await deps.db.withTenant({ orgId }, (tx) => read(tx, deps, orgId, allocationId));
    if (r.kind === 'absent') return r;
    const ctx: AuthContext = { orgId, actorId: deps.runnerIdentity, actorKind: 'service', taskId, grantIds: [], correlationId: randomUUID() };
    const body = JSON.parse((await deps.artifacts.readVerified(ctx, r.ref, MAX_RECORD_BYTES)).toString('utf8')) as Record<string, unknown>;
    if (body['allocationId'] !== allocationId || body['organizationId'] !== orgId || body['schema'] !== spec.schema) return { kind: 'absent' };
    return { ...r, body };
  }
  return { spec, purpose, prepare, register, read, readChecked };
}
