// Worker test harness: Temporal SDK local test server, a migrated database with one tenant, the
// artifact service and helpers to create investigation tasks and run TaskWorkflow against them.
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import type { Worker, WorkflowBundleWithSourceMap } from '@temporalio/worker';
import { Database, createMigratedDatabase, provisionOrganization, type MigratedDatabase } from '@factory/database';
import { ArtifactService, FileObjectStore } from '@factory/artifacts';
import { canonicalHash } from '@factory/domain';
import { bundleWorkflows, createWorker, type FakeStageBehavior, type LaunchPayload } from '../src/index.ts';

export type WorkerHarness = {
  env: TestWorkflowEnvironment; m: MigratedDatabase; db: Database; artifacts: ArtifactService; orgId: string; principalId: string; applicationId: string; bundle: WorkflowBundleWithSourceMap;
  newTask: () => Promise<{ taskId: string; launch: LaunchPayload }>;
  withWorker: <T>(behavior: FakeStageBehavior | undefined, fn: (taskQueue: string) => Promise<T>) => Promise<T>;
  close: () => Promise<void>;
};

export const investigationSpec = (applicationId: string, title = 'Why do orders fail intermittently?') => ({
  schemaVersion: '2.0', title, intent: 'Explain intermittent order failures with evidence.', applicationIds: [applicationId], workType: 'investigation',
  acceptanceCriteria: ['The report distinguishes observations, inference and open questions.'], assurance: 'standard', deliveryScope: 'report',
  budget: { maxMicroUsd: 5_000_000, maxActiveSeconds: 3600, maxCalendarSeconds: 86_400, maxAuthoringInvocations: 4, maxSemanticAttemptsPerNode: 3, maxDesignReturns: 2, invocationMode: 'bounded' },
  targetContext: { kind: 'existing_application', applicationId }, priorityClass: 'normal',
});

export async function createWorkerHarness(prefix: string): Promise<WorkerHarness> {
  const env = await TestWorkflowEnvironment.createLocal();
  const m = await createMigratedDatabase(prefix);
  const orgId = randomUUID();
  const principalId = randomUUID();
  const applicationId = randomUUID();
  await provisionOrganization(m.migratorUrl, { id: orgId, name: 'Org' });
  const db = Database.connect(m.runtimeUrl, 20);
  const retention = Database.connect(m.retentionUrl);
  await db.withTenant({ orgId }, async (tx) => {
    await tx.query("INSERT INTO factory.principal (org_id, id, issuer, subject, display_name) VALUES ($1,$2,'https://issuer','sub','User')", [orgId, principalId]);
    await tx.query("INSERT INTO factory.application (org_id, id, app_key, name, owner_ids, lifecycle) VALUES ($1,$2,'orders','Orders','[]','production')", [orgId, applicationId]);
  });
  const storeRoot = mkdtempSync(join(tmpdir(), 'worker-artifacts-'));
  const artifacts = new ArtifactService({ db, store: new FileObjectStore(storeRoot), signingKey: randomBytes(32), downloadOrigin: 'http://127.0.0.1:1', retention });
  const bundle = await bundleWorkflows();
  const namespace = env.namespace ?? 'default';
  return {
    env, m, db, artifacts, orgId, principalId, applicationId, bundle,
    newTask: async () => {
      const taskId = randomUUID();
      const spec = investigationSpec(applicationId);
      await db.withTenant({ orgId }, async (tx) => {
        await tx.query("INSERT INTO factory.task (org_id, id, creator_id, primary_application_id, target_kind, target_context, work_type, change_class, delivery_scope, status, projected_at, last_event_sequence) VALUES ($1,$2,$3,$4,'existing_application',$5,'investigation','investigation','report','accepted',now(),0)",
          [orgId, taskId, principalId, applicationId, JSON.stringify(spec.targetContext)]);
        await tx.query('INSERT INTO factory.task_spec_version (org_id, id, task_id, version, spec, spec_hash, actor_id) VALUES ($1,$2,$3,1,$4,$5,$6)', [orgId, randomUUID(), taskId, JSON.stringify(spec), canonicalHash(spec), principalId]);
      });
      return { taskId, launch: { workflowId: `factory/${orgId}/${taskId}`, taskId, orgId, specVersion: 1, specHash: canonicalHash(spec), operationId: randomUUID() } };
    },
    withWorker: async (behavior, fn) => {
      const taskQueue = `tq-${randomUUID()}`;
      const worker: Worker = await createWorker({ connection: env.nativeConnection, namespace, taskQueue, workflowBundle: bundle, db, artifacts, ...(behavior ? { fakeStage: behavior } : {}) });
      return worker.runUntil(fn(taskQueue));
    },
    close: async () => { await db.close(); await retention.close(); await m.drop(); await env.teardown(); rmSync(storeRoot, { recursive: true, force: true }); },
  };
}
