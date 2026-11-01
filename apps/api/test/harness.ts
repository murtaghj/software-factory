// W-008/W-009 API harness: a migrated database, two organizations each with its own trusted local
// OIDC issuer, real principals/memberships, an artifact service and the Fastify app.
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database, createMigratedDatabase, provisionOrganization, type MigratedDatabase, type Tx } from '@factory/database';
import { ArtifactService, FileObjectStore, startDownloadOrigin, type DownloadOrigin } from '@factory/artifacts';
import { startTestIssuer, type TestIssuer } from '@factory/test-support';
import { OidcVerifier, RBAC_ARTIFACT_READS, buildApi } from '../src/index.ts';
import type { FastifyInstance } from 'fastify';

export const AUDIENCE = 'software-factory-api';
export const DASHBOARD_ORIGIN = 'http://localhost:4173';
export const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

export type Org = { orgId: string; issuer: TestIssuer; applicationId: string; otherApplicationId: string };
export type User = { principalId: string; subject: string; token: () => Promise<string> };

export type ApiHarness = {
  m: MigratedDatabase; db: Database; app: FastifyInstance; artifacts: ArtifactService; origin: DownloadOrigin; a: Org; b: Org;
  user: (org: Org, roles: Array<{ role: string; scope: string[] }>, opts?: { groups?: string[] }) => Promise<User>;
  task: (org: Org, creator: User, applicationId?: string) => Promise<{ taskId: string; logicalStageId: string; stageRunId: string; allocationId: string; workspaceId: string; repositoryId: string }>;
  artifactFor: (org: Org, task: { taskId: string; logicalStageId: string }, body: Buffer, mediaType?: string, classification?: 'ordinary' | 'restricted' | 'sensitive_session') => Promise<string>;
  tx: <T>(org: Org, fn: (tx: Tx) => Promise<T>) => Promise<T>;
  close: () => Promise<void>;
};

export async function createApiHarness(prefix: string): Promise<ApiHarness> {
  const m = await createMigratedDatabase(prefix);
  const mkOrg = async (name: string): Promise<Org> => {
    const orgId = randomUUID();
    await provisionOrganization(m.migratorUrl, { id: orgId, name });
    return { orgId, issuer: await startTestIssuer(name), applicationId: randomUUID(), otherApplicationId: randomUUID() };
  };
  const a = await mkOrg('org-a');
  const b = await mkOrg('org-b');
  const db = Database.connect(m.runtimeUrl);
  const retention = Database.connect(m.retentionUrl);
  for (const org of [a, b]) {
    await db.withTenant({ orgId: org.orgId }, async (tx) => {
      for (const [id, key] of [[org.applicationId, 'orders'], [org.otherApplicationId, 'billing']] as const) {
        await tx.query("INSERT INTO factory.application (org_id, id, app_key, name, owner_ids, lifecycle) VALUES ($1,$2,$3,$3,$4,'production')", [org.orgId, id, key, JSON.stringify(key === 'orders' ? ['team:commerce'] : [])]);
      }
    });
  }
  const storeRoot = mkdtempSync(join(tmpdir(), 'api-artifacts-'));
  const store = new FileObjectStore(storeRoot);
  const holder: { s?: ArtifactService } = {};
  const origin = await startDownloadOrigin(store, (t) => holder.s?.verifyDownload(t));
  const artifacts = new ArtifactService({ db, store, signingKey: randomBytes(32), downloadOrigin: origin.url, retention, readAuthority: RBAC_ARTIFACT_READS });
  holder.s = artifacts;
  const verifier = new OidcVerifier([a, b].map((o) => ({ issuer: o.issuer.issuer, audience: AUDIENCE, jwksUrl: o.issuer.jwksUrl, orgId: o.orgId })));
  const app = buildApi({ db, verifier, artifacts, dashboardOrigin: DASHBOARD_ORIGIN });
  await app.ready();
  const tx = <T>(org: Org, fn: (tx: Tx) => Promise<T>) => db.withTenant({ orgId: org.orgId }, fn);
  return {
    m, db, app, artifacts, origin, a, b, tx,
    user: async (org, roles, opts = {}) => {
      const principalId = randomUUID();
      const subject = `sub-${principalId}`;
      await tx(org, async (t) => {
        await t.query("INSERT INTO factory.principal (org_id, id, issuer, subject, display_name) VALUES ($1,$2,$3,$4,'User')", [org.orgId, principalId, org.issuer.issuer, subject]);
        for (const r of roles) await t.query('INSERT INTO factory.membership (org_id, id, principal_id, role, application_scope) VALUES ($1,$2,$3,$4,$5)', [org.orgId, randomUUID(), principalId, r.role, JSON.stringify(r.scope)]);
      });
      return { principalId, subject, token: () => org.issuer.mint({ sub: subject, aud: AUDIENCE, ...(opts.groups ? { groups: opts.groups } : {}) }) };
    },
    task: async (org, creator, applicationId = org.applicationId) => {
      const ids = { taskId: randomUUID(), stageRunId: randomUUID(), allocationId: randomUUID(), workspaceId: randomUUID(), repositoryId: randomUUID(), logicalStageId: '' };
      ids.logicalStageId = `task-${ids.taskId}/plan-1/implement/attempt-1`;
      await tx(org, async (t) => {
        await t.query("INSERT INTO factory.task (org_id, id, creator_id, primary_application_id, target_kind, target_context, work_type, change_class, delivery_scope, status) VALUES ($1,$2,$3,$4,'existing_application',$5,'feature','feature','pr','running')",
          [org.orgId, ids.taskId, creator.principalId, applicationId, JSON.stringify({ kind: 'existing_application', applicationId })]);
        await t.query("INSERT INTO factory.task_spec_version (org_id, id, task_id, version, spec, spec_hash, actor_id) VALUES ($1,$2,$3,1,'{}',$4,$5)", [org.orgId, randomUUID(), ids.taskId, 'a'.repeat(64), creator.principalId]);
        await t.query("INSERT INTO factory.execution_plan (org_id, id, task_id, version, spec_version, plan_ref, policy_ref, plan_hash, template_id, template_version, template_ref) VALUES ($1,$2,$3,1,1,'{}','{}',$4,'existing_feature','3.0.0','{}')", [org.orgId, randomUUID(), ids.taskId, 'b'.repeat(64)]);
        await t.query("INSERT INTO factory.stage_run (org_id, id, task_id, plan_version, node_id, semantic_attempt, logical_id, input_hash, input_ref, role, status, limits) VALUES ($1,$2,$3,1,'implement',1,$4,$5,'{}','implementer','running','{}')", [org.orgId, ids.stageRunId, ids.taskId, ids.logicalStageId, 'c'.repeat(64)]);
        await t.query("INSERT INTO factory.repository (org_id, id, provider, installation_ref, external_id, clone_url, default_branch, policy_ref) VALUES ($1,$2,'github','inst',$3,'https://git.test/r','main','{}')", [org.orgId, ids.repositoryId, `ext-${ids.repositoryId}`]);
        await t.query("INSERT INTO factory.workspace (org_id, id, task_id, repository_id, stage_run_id, role, base_commit, state, generation, owner_epoch, setup_profile_ref) VALUES ($1,$2,$3,$4,$5,'implementer',$6,'active',1,1,'{}')", [org.orgId, ids.workspaceId, ids.taskId, ids.repositoryId, ids.stageRunId, 'a'.repeat(40)]);
        await t.query("INSERT INTO factory.execution_allocation (org_id, id, stage_run_id, workspace_id, generation, owner_epoch, spec_hash, job_name, namespace, supervisor_identity, state) VALUES ($1,$2,$3,$4,1,1,$5,$6,'exec','sup','running')", [org.orgId, ids.allocationId, ids.stageRunId, ids.workspaceId, 'd'.repeat(64), `job-${ids.allocationId}`]);
      });
      return ids;
    },
    artifactFor: async (org, task, body, mediaType = 'text/plain', classification = 'ordinary') => {
      const ctx = { orgId: org.orgId, actorId: `runner:${task.taskId}`, actorKind: 'service' as const, taskId: task.taskId, grantIds: [], correlationId: randomUUID() };
      const r = await artifacts.reserve(ctx, { taskId: task.taskId, stageRunId: task.logicalStageId, mediaType, schemaVersion: '1.0', maxBytes: 100_000, classification });
      await artifacts.upload(r.uploadCapability, body);
      return (await artifacts.finalize(ctx, { uploadId: r.uploadId, expectedDigest: sha256(body), expectedBytes: body.length, producerId: ctx.actorId })).artifactId;
    },
    close: async () => { await app.close(); await origin.close(); await a.issuer.close(); await b.issuer.close(); await db.close(); await retention.close(); await m.drop(); rmSync(storeRoot, { recursive: true, force: true }); },
  };
}
