// System-test harness: the real components wired together over real infrastructure.
//   PostgreSQL 18 (migrated, role split) · artifact service + isolated download origin
//   · OIDC test issuer · Fastify API listening on a port · optionally the Temporal SDK local
//   test server with the TaskWorkflow worker and the outbox dispatcher.
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
type FastifyInstance = ReturnType<typeof buildApi>;
import { Database, createMigratedDatabase, provisionOrganization, type MigratedDatabase, type Tx } from '@factory/database';
import { ArtifactService, FileObjectStore, startDownloadOrigin, type DownloadOrigin } from '@factory/artifacts';
import { startTestIssuer, type TestIssuer, retryStart } from '@factory/test-support';
import { AllowanceService, BoardService, CommandService, OidcVerifier, OutcomeBundleService, RBAC_ARTIFACT_READS, TaskService, buildApi } from '@factory/api';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import type { Worker } from '@temporalio/worker';
import { bundleWorkflows, createWorker, type FakeStageBehavior } from '@factory/worker';
import { ClientGateway, Dispatcher, type TemporalGateway } from '@factory/dispatcher';
import type { StreamOptions } from '@factory/api';

export const AUDIENCE = 'software-factory-api';

export type SystemUser = { principalId: string; subject: string; token: () => Promise<string> };
export type SystemHarness = {
  m: MigratedDatabase; db: Database; retention: Database; artifacts: ArtifactService; tasks: TaskService; issuer: TestIssuer; orgId: string; applicationId: string;
  api: FastifyInstance; apiUrl: string; origin: DownloadOrigin; storeRoot: string;
  user: (roles: Array<{ role: string; scope: string[] }>) => Promise<SystemUser>;
  temporal?: { env: TestWorkflowEnvironment; taskQueue: string; dispatch: (gateway?: TemporalGateway) => Promise<number>; gateway: ClientGateway };
  call: (user: SystemUser, method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: unknown }>;
  tx: <T>(fn: (t: Tx) => Promise<T>) => Promise<T>;
  close: () => Promise<void>;
};

export type SystemOptions = { events?: StreamOptions; temporal?: { fakeStage?: FakeStageBehavior; decisionTtlMs?: number } };

export async function createSystemHarness(prefix: string, options: SystemOptions = {}): Promise<SystemHarness> {
  const m = await createMigratedDatabase(prefix);
  const orgId = randomUUID();
  const applicationId = randomUUID();
  await provisionOrganization(m.migratorUrl, { id: orgId, name: 'Factory Org' });
  const db = Database.connect(m.runtimeUrl, 20);
  const retention = Database.connect(m.retentionUrl);
  await db.withTenant({ orgId }, (tx) => tx.query("INSERT INTO factory.application (org_id, id, app_key, name, owner_ids, lifecycle) VALUES ($1,$2,'orders','Orders API','[\"team:commerce\"]','production')", [orgId, applicationId]));
  const storeRoot = mkdtempSync(join(tmpdir(), 'system-artifacts-'));
  const store = new FileObjectStore(storeRoot);
  const holder: { s?: ArtifactService } = {};
  const origin = await startDownloadOrigin(store, (t) => holder.s?.verifyDownload(t));
  const artifacts = new ArtifactService({ db, store, signingKey: randomBytes(32), downloadOrigin: origin.url, retention, readAuthority: RBAC_ARTIFACT_READS });
  holder.s = artifacts;
  const issuer = await startTestIssuer('system');
  const tasks = new TaskService({ db, artifacts });
  const commands = new CommandService({ db, artifacts });
  const api = buildApi({ db, verifier: new OidcVerifier([{ issuer: issuer.issuer, audience: AUDIENCE, jwksUrl: issuer.jwksUrl, orgId }]), artifacts, tasks, commands, outcomes: new OutcomeBundleService({ db, artifacts }), allowances: new AllowanceService({ db }), boards: new BoardService({ db }), dashboardOrigin: 'http://localhost:4173', ...(options.events ? { events: options.events } : {}) });
  const apiUrl = await api.listen({ port: 0, host: '127.0.0.1' });
  const tx = <T>(fn: (t: Tx) => Promise<T>) => db.withTenant({ orgId }, fn);
  let temporal: SystemHarness['temporal'];
  let worker: Worker | undefined;
  let workerRun: Promise<void> | undefined;
  let env: TestWorkflowEnvironment | undefined;
  if (options.temporal) {
    env = await retryStart(() => TestWorkflowEnvironment.createLocal());
    const namespace = env.namespace ?? 'default';
    const taskQueue = `factory-tasks-${randomUUID()}`;
    worker = await createWorker({ connection: env.nativeConnection, namespace, taskQueue, workflowBundle: await bundleWorkflows(), db, artifacts, ...(options.temporal.fakeStage ? { fakeStage: options.temporal.fakeStage } : {}), ...(options.temporal.decisionTtlMs === undefined ? {} : { decisionTtlMs: options.temporal.decisionTtlMs }) });
    workerRun = worker.run();
    const gateway = new ClientGateway(env.connection, namespace);
    temporal = { env, taskQueue, gateway, dispatch: async (g) => (await new Dispatcher({ db, temporal: g ?? gateway, taskQueue }).runOnce()).length };
  }
  const call = async (user: SystemUser, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${apiUrl}${path}`, { method, headers: { authorization: `Bearer ${await user.token()}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await res.text();
    return { status: res.status, body: text.length > 0 ? JSON.parse(text) as unknown : undefined };
  };
  return {
    m, db, retention, artifacts, tasks, issuer, orgId, applicationId, api, apiUrl, origin, storeRoot, tx, call, ...(temporal ? { temporal } : {}),
    user: async (roles) => {
      const principalId = randomUUID();
      const subject = `sub-${principalId}`;
      await tx(async (t) => {
        await t.query("INSERT INTO factory.principal (org_id, id, issuer, subject, display_name) VALUES ($1,$2,$3,$4,'User')", [orgId, principalId, issuer.issuer, subject]);
        for (const r of roles) await t.query('INSERT INTO factory.membership (org_id, id, principal_id, role, application_scope) VALUES ($1,$2,$3,$4,$5)', [orgId, randomUUID(), principalId, r.role, JSON.stringify(r.scope)]);
      });
      return { principalId, subject, token: () => issuer.mint({ sub: subject, aud: AUDIENCE }) };
    },
    close: async () => { if (worker) { worker.shutdown(); await workerRun; } if (env) await env.teardown(); await api.close(); await origin.close(); await issuer.close(); await db.close(); await retention.close(); await m.drop(); rmSync(storeRoot, { recursive: true, force: true }); },
  };
}
