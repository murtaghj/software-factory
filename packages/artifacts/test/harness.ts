// Shared harness: a migrated database with one tenant, a running stage, an artifact service on a
// temporary object store and its isolated download origin.
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database, createMigratedDatabase, provisionOrganization, type MigratedDatabase } from '@factory/database';
import { ArtifactService, FileObjectStore, startDownloadOrigin, type AuthContext, type ArtifactServiceOptions, type DownloadOrigin } from '../src/index.ts';

export const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const hex = (c: string): string => c.repeat(64);

export type Tenant = { orgId: string; principalId: string; applicationId: string; taskId: string; stageRunId: string; logicalStageId: string };

export async function seedTenant(db: Database, orgId: string): Promise<Tenant> {
  const t = { orgId, principalId: randomUUID(), applicationId: randomUUID(), taskId: randomUUID(), stageRunId: randomUUID(), logicalStageId: '' };
  t.logicalStageId = `task-${t.taskId}/plan-1/implement/attempt-1`;
  await db.withTenant({ orgId }, async (tx) => {
    await tx.query("INSERT INTO factory.principal (org_id, id, issuer, subject, display_name) VALUES ($1,$2,'https://issuer.test',$3,'User')", [orgId, t.principalId, `u-${t.principalId}`]);
    await tx.query("INSERT INTO factory.application (org_id, id, app_key, name, owner_ids, lifecycle, data_classification) VALUES ($1,$2,$3,'Orders','[]','production','internal')", [orgId, t.applicationId, `orders-${t.applicationId.slice(0, 8)}`]);
    await tx.query("INSERT INTO factory.task (org_id, id, creator_id, primary_application_id, target_kind, target_context, work_type, change_class, delivery_scope, status) VALUES ($1,$2,$3,$4,'existing_application',$5,'feature','feature','pr','running')",
      [orgId, t.taskId, t.principalId, t.applicationId, JSON.stringify({ kind: 'existing_application', applicationId: t.applicationId })]);
    await tx.query("INSERT INTO factory.task_spec_version (org_id, id, task_id, version, spec, spec_hash, actor_id) VALUES ($1,$2,$3,1,'{}',$4,$5)", [orgId, randomUUID(), t.taskId, hex('a'), t.principalId]);
    await tx.query("INSERT INTO factory.execution_plan (org_id, id, task_id, version, spec_version, plan_ref, policy_ref, plan_hash, template_id, template_version, template_ref) VALUES ($1,$2,$3,1,1,'{}','{}',$4,'existing_feature','3.0.0','{}')", [orgId, randomUUID(), t.taskId, hex('b')]);
    await tx.query("INSERT INTO factory.stage_run (org_id, id, task_id, plan_version, node_id, semantic_attempt, logical_id, input_hash, input_ref, role, status, limits) VALUES ($1,$2,$3,1,'implement',1,$4,$5,'{}','implementer','running','{}')",
      [orgId, t.stageRunId, t.taskId, t.logicalStageId, hex('c')]);
  });
  return t;
}

export async function addStage(db: Database, t: Tenant, nodeId: string): Promise<Tenant> {
  const stageRunId = randomUUID();
  const logicalStageId = `task-${t.taskId}/plan-1/${nodeId}/attempt-1`;
  await db.withTenant({ orgId: t.orgId }, (tx) => tx.query("INSERT INTO factory.stage_run (org_id, id, task_id, plan_version, node_id, semantic_attempt, logical_id, input_hash, input_ref, role, status, limits) VALUES ($1,$2,$3,1,$4,1,$5,$6,'{}','implementer','running','{}')",
    [t.orgId, stageRunId, t.taskId, nodeId, logicalStageId, hex('d')]));
  return { ...t, stageRunId, logicalStageId };
}

export type Harness = {
  m: MigratedDatabase; db: Database; retention: Database; store: FileObjectStore; service: ArtifactService; origin: DownloadOrigin; storeRoot: string;
  a: Tenant; b: Tenant; clock: { now: number }; producer: (t: Tenant) => AuthContext; human: (t: Tenant, taskId?: string) => AuthContext;
  make: (overrides?: Partial<ArtifactServiceOptions>) => ArtifactService; close: () => Promise<void>;
};

export async function createHarness(prefix: string): Promise<Harness> {
  const m = await createMigratedDatabase(prefix);
  const orgA = randomUUID();
  const orgB = randomUUID();
  await provisionOrganization(m.migratorUrl, { id: orgA, name: 'A' });
  await provisionOrganization(m.migratorUrl, { id: orgB, name: 'B' });
  const db = Database.connect(m.runtimeUrl);
  const retention = Database.connect(m.retentionUrl);
  const a = await seedTenant(db, orgA);
  const b = await seedTenant(db, orgB);
  const storeRoot = mkdtempSync(join(tmpdir(), 'artifacts-'));
  const store = new FileObjectStore(storeRoot);
  const clock = { now: Date.now() };
  const signingKey = randomBytes(32);
  const holder: { service?: ArtifactService } = {};
  const origin = await startDownloadOrigin(store, (token) => holder.service?.verifyDownload(token));
  const make = (overrides: Partial<ArtifactServiceOptions> = {}) => new ArtifactService({ db, store, signingKey, downloadOrigin: origin.url, now: () => clock.now, retention, ...overrides });
  const service = make();
  holder.service = service;
  return {
    m, db, retention, store, service, origin, storeRoot, a, b, clock, make,
    producer: (t) => ({ orgId: t.orgId, actorId: `runner:${t.taskId}`, actorKind: 'service', taskId: t.taskId, grantIds: [], correlationId: randomUUID() }),
    human: (t, taskId) => ({ orgId: t.orgId, actorId: t.principalId, principalId: t.principalId, actorKind: 'human', grantIds: [], correlationId: randomUUID(), ...(taskId ? { taskId } : {}) }),
    close: async () => { await origin.close(); await db.close(); await retention.close(); await m.drop(); rmSync(storeRoot, { recursive: true, force: true }); },
  };
}

export async function produce(h: Harness, service: ArtifactService, t: Tenant, body: Buffer, mediaType = 'application/json', schemaVersion = '2.0') {
  const ctx = h.producer(t);
  const r = await service.reserve(ctx, { taskId: t.taskId, stageRunId: t.logicalStageId, mediaType, schemaVersion, maxBytes: 1_000_000, classification: 'ordinary' });
  await service.upload(r.uploadCapability, body);
  return { ctx, reservation: r, finalize: () => service.finalize(ctx, { uploadId: r.uploadId, expectedDigest: sha256(body), expectedBytes: body.length, producerId: ctx.actorId }) };
}
