// Shared harness (not exported): a migrated database with two tenants, an artifact service on a temporary
// object store, a workspace manager, FakeKube, and runner instances that can be created several at a time
// (each with its own pool, as two controllers would have). No Git, no cluster, no Temporal.
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactService, FileObjectStore, type AuthContext } from '@factory/artifacts';
import type { ArtifactRef, StageInput } from '@factory/contracts';
import { Database, createMigratedDatabase, openBudgetAccount, provisionOrganization, reserveBudget, type AllocationRow, type MigratedDatabase, getAllocation, type WorkspaceRow, getWorkspace } from '@factory/database';
import { canonicalHash } from '@factory/domain';
import { Faults } from '@factory/test-support';
import { createWorkspaceManager, type GitMaterializer, type WorkspaceManagerService } from '@factory/workspace';
import { createPodVolumeMaterializer, createRunner, encodeReceiptMessage, tokenAudience, type KubeApi, type RunnerConfig, type RunnerService } from '../src/index.ts';
import type { RunnerDeps } from '../src/core.ts';
import { FakeKube, createTestConfig } from '../src/testing.ts';

export type ConfigOver = Partial<Omit<RunnerConfig, 'review'>> & { review?: Partial<RunnerConfig['review']> };
export const RUNNER_ID = 'runner:factory';
export const CALLER = 'service:worker';
export const hex = (c: string): string => c.repeat(64);
export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
export async function until(what: string, cond: () => Promise<boolean> | boolean, timeoutMs = 15_000): Promise<void> {
  const t0 = performance.now();
  while (!(await cond())) { if (performance.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`); await sleep(25); }
}
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export type Tenant = { orgId: string; principalId: string; applicationId: string; repositoryId: string; taskId: string; accountId: string };
export type Stage = { logicalId: string; nodeId: string; role: string; inputHash: string; binding: Record<string, unknown>; limits: Record<string, number> };
export type Instance = { runner: RunnerService; deps: RunnerDeps; kube: FakeKube; faults: Faults; db: Database; workspaces: WorkspaceManagerService; config: RunnerConfig };
// The same, against a real cluster (the k3s tier): the port is any KubeApi.
export type ClusterInstance = Omit<Instance, 'kube'> & { kube: KubeApi };

// The pod-mode `remove` lives in 17b; release in 17a's tests uses a stub that reports the volume absent.
export const absentMaterializer: GitMaterializer = {
  materialize: () => Promise.resolve({ ok: false, code: 'not_supported', message: 'pod mode materializes in the Job' }),
  remove: () => Promise.resolve({ absent: true }),
};

const ref = (n: string): ArtifactRef => ({ artifactId: randomUUID(), sha256: sha256(n), mediaType: 'application/json', schemaVersion: '1.0', sizeBytes: 2 });

export async function createEnv(prefix: string, opts: { config?: ConfigOver; cloneUrl?: string } = {}) {
  const m: MigratedDatabase = await createMigratedDatabase(prefix);
  const orgA = randomUUID();
  const orgB = randomUUID();
  await provisionOrganization(m.migratorUrl, { id: orgA, name: 'A' });
  await provisionOrganization(m.migratorUrl, { id: orgB, name: 'B' });
  const db = Database.connect(m.runtimeUrl, 40);
  const extraPools: Database[] = [];
  const base = mkdtempSync(join(tmpdir(), 'w017-'));
  const store = new FileObjectStore(join(base, 'store'));
  const artifacts = new ArtifactService({ db, store, signingKey: Buffer.alloc(32, 7), downloadOrigin: 'http://127.0.0.1:1' });
  const config = createTestConfig({ runnerIdentity: RUNNER_ID, controlPlaneIdentities: [CALLER], pools: { authoring: 500, verifier: 500 }, ...opts.config });
  let n = 0;

  async function seedTenant(orgId: string): Promise<Tenant> {
    const t: Tenant = { orgId, principalId: randomUUID(), applicationId: randomUUID(), repositoryId: randomUUID(), taskId: randomUUID(), accountId: '' };
    await db.withTenant({ orgId }, async (tx) => {
      await tx.query("INSERT INTO factory.principal (org_id, id, issuer, subject, display_name) VALUES ($1,$2,'https://issuer.test',$3,'User')", [orgId, t.principalId, `u-${t.principalId}`]);
      await tx.query("INSERT INTO factory.application (org_id, id, app_key, name, owner_ids, lifecycle, data_classification) VALUES ($1,$2,$3,'Orders','[]','production','internal')", [orgId, t.applicationId, `orders-${t.applicationId.slice(0, 8)}`]);
      await tx.query("INSERT INTO factory.repository (org_id, id, provider, installation_ref, external_id, clone_url, default_branch, policy_ref) VALUES ($1,$2,'local','inst',$3,$4,'main','{}')", [orgId, t.repositoryId, `repo-${t.repositoryId}`, opts.cloneUrl ?? 'https://git.example.test/org/repo.git']);
      await tx.query("INSERT INTO factory.application_repository (org_id, id, application_id, repository_id, subpath, purpose) VALUES ($1,$2,$3,$4,'','primary')", [orgId, randomUUID(), t.applicationId, t.repositoryId]);
      await tx.query("INSERT INTO factory.task (org_id, id, creator_id, primary_application_id, target_kind, target_context, work_type, change_class, delivery_scope, status) VALUES ($1,$2,$3,$4,'existing_application',$5,'feature','feature','pr','running')",
        [orgId, t.taskId, t.principalId, t.applicationId, JSON.stringify({ kind: 'existing_application', applicationId: t.applicationId })]);
      await tx.query("INSERT INTO factory.task_spec_version (org_id, id, task_id, version, spec, spec_hash, actor_id) VALUES ($1,$2,$3,1,'{}',$4,$5)", [orgId, randomUUID(), t.taskId, hex('a'), t.principalId]);
      await tx.query("INSERT INTO factory.execution_plan (org_id, id, task_id, version, spec_version, plan_ref, policy_ref, plan_hash, template_id, template_version, template_ref) VALUES ($1,$2,$3,1,1,'{}','{}',$4,'existing_feature','3.0.0','{}')", [orgId, randomUUID(), t.taskId, hex('b')]);
      t.accountId = await openBudgetAccount(tx, { orgId, taskId: t.taskId, limitMicroUsd: 1_000_000_000, deliveryScope: 'pr' });
    });
    return t;
  }
  const a = await seedTenant(orgA);
  const b = await seedTenant(orgB);

  const ctx = (t: Tenant, over: Partial<AuthContext> = {}): AuthContext => ({ orgId: t.orgId, actorId: CALLER, actorKind: 'service', taskId: t.taskId, grantIds: [], correlationId: randomUUID(), ...over });
  const runnerCtx = (t: Tenant): AuthContext => ({ orgId: t.orgId, actorId: RUNNER_ID, actorKind: 'service', taskId: t.taskId, grantIds: [], correlationId: randomUUID() });

  // A stage run with its budget reservation, as the worker leaves it before it asks the runner for anything.
  async function newStage(t: Tenant, role = 'implementer', over: { limits?: Record<string, number>; status?: string; reserve?: boolean } = {}): Promise<Stage> {
    n += 1;
    const nodeId = `node-${String(n)}`;
    const logicalId = `task-${t.taskId}/plan-1/${nodeId}/attempt-1`;
    const binding = { taskSpecVersion: 1, planVersion: 1, policyRef: ref('policy'), applicationSnapshotRef: ref('snapshot'), workflowTemplateRef: ref('template') };
    const inputHash = canonicalHash(binding);
    const limits = { wallSeconds: 2700, maxTurns: 40, maxToolCalls: 200, maxOutputBytes: 1_000_000, reservedMicroUsd: 0, ...over.limits };
    await db.withTenant({ orgId: t.orgId }, async (tx) => {
      await tx.query("INSERT INTO factory.stage_run (org_id, id, task_id, plan_version, node_id, semantic_attempt, logical_id, input_hash, input_ref, role, status, limits) VALUES ($1,$2,$3,1,$4,1,$5,$6,'{}',$7,$8,$9)",
        [t.orgId, randomUUID(), t.taskId, nodeId, logicalId, inputHash, role, over.status ?? 'running', JSON.stringify(limits)]);
      if (over.reserve !== false) await reserveBudget(tx, { orgId: t.orgId, accountId: t.accountId, operationKey: logicalId, amountMicroUsd: 1000 });
    });
    return { logicalId, nodeId, role, inputHash, binding, limits };
  }

  function input(t: Tenant, s: Stage, over: Partial<StageInput> = {}): StageInput {
    return { schemaVersion: '2.0', orgId: t.orgId, taskId: t.taskId, stageRunId: s.logicalId, nodeId: s.nodeId, semanticAttempt: 1, role: s.role as StageInput['role'],
      inputBinding: s.binding as StageInput['inputBinding'], inputHash: s.inputHash, contextRef: ref('context'), limits: s.limits as StageInput['limits'], capabilityGrants: [], sessionPolicy: 'fresh', ...over };
  }

  async function putArtifact(t: Tenant, body: Buffer, purpose: string): Promise<ArtifactRef> {
    const object = await artifacts.putControllerObject(t.orgId, body);
    return db.withTenant({ orgId: t.orgId }, (tx) => artifacts.registerControllerArtifact(tx, { orgId: t.orgId, taskId: t.taskId, producerId: 'test', object, mediaType: 'application/json', schemaVersion: '1.0', classification: 'ordinary', purpose }));
  }

  // A runner instance: its own pool and manager (as a second controller process would have), sharing one fake cluster by default.
  function newRunner(o: { kube?: FakeKube; faults?: Faults; ownPool?: boolean; config?: ConfigOver; nowMs?: () => number; pod?: { settle?: { timeoutMs: number; pollMs: number }; wait?: (ms: number) => Promise<void> } } = {}): Instance {
    return build({ ...o, kube: o.kube ?? new FakeKube() }) as Instance;
  }
  // The pod-mode runner against any cluster: PodVolumeMaterializer is the workspace manager's materializer.
  function newClusterRunner(o: { kube: KubeApi; ownPool?: boolean; config?: ConfigOver; faults?: Faults }): ClusterInstance {
    return build({ ...o, pod: {} });
  }
  function build(o: { kube: KubeApi; faults?: Faults; ownPool?: boolean; config?: ConfigOver; nowMs?: () => number; pod?: { settle?: { timeoutMs: number; pollMs: number }; wait?: (ms: number) => Promise<void> } }): ClusterInstance {
    const idb = o.ownPool ? Database.connect(m.runtimeUrl, 10) : db;
    if (o.ownPool) extraPools.push(idb);
    const kube = o.kube;
    const faults = o.faults ?? new Faults();
    const cfg = o.config ? createTestConfig({ runnerIdentity: RUNNER_ID, controlPlaneIdentities: [CALLER], pools: { authoring: 500, verifier: 500 }, ...opts.config, ...o.config }) : config;
    const workspaces = createWorkspaceManager({ db: idb, artifacts: new ArtifactService({ db: idb, store, signingKey: Buffer.alloc(32, 7), downloadOrigin: 'http://127.0.0.1:1' }), runnerIdentity: RUNNER_ID, materializer: o.pod ? createPodVolumeMaterializer({ kube, config: cfg, db: idb, ...o.pod }) : absentMaterializer });
    const deps: RunnerDeps = { db: idb, kube, workspaces, config: cfg, faults, artifacts, ...(o.nowMs ? { monotonicNowMs: o.nowMs } : {}) };
    return { runner: createRunner(deps), deps, kube, faults, db: idb, workspaces, config: cfg };
  }

  // A workspace row for a stage run (what W-023's Activity does through the facade before startOrAttach).
  async function newWorkspace(t: Tenant, s: Stage, inst: Pick<Instance, 'workspaces'>, o: { baseCommit?: string } = {}): Promise<string> {
    const id = randomUUID();
    const setup = await putArtifact(t, Buffer.from('{"schema":"factory-setup-profile/1","fixture":true}'), 'setup_profile');
    await inst.workspaces.allocateOrAttach(runnerCtx(t), id, { repositoryId: t.repositoryId, baseCommit: o.baseCommit ?? 'c'.repeat(40), branch: `factory/${t.taskId}/main`, role: s.role as 'implementer', stageRunId: s.logicalId, setupProfileRef: setup, specHash: hex('e') });
    return id;
  }

  // Sessions waiting on a lock right now (for forcing an interleaving without sleeping).
  const waiters = async (): Promise<number> => Number((await db.withoutTenant(async (tx) => (await tx.query<{ n: string }>('SELECT count(*) AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE NOT l.granted AND a.datname = current_database()')).rows))[0]?.n);
  const q = <T extends Record<string, unknown>>(t: Tenant, sql: string, params: unknown[] = []): Promise<T[]> => db.withTenant({ orgId: t.orgId }, async (tx) => (await tx.query<T>(sql, params)).rows);
  const allocations = (t: Tenant, s: Stage): Promise<AllocationRow[]> => db.withTenant({ orgId: t.orgId }, async (tx) => {
    const r = await tx.query<{ id: string }>('SELECT a.id FROM factory.execution_allocation a JOIN factory.stage_run s ON s.org_id=a.org_id AND s.id=a.stage_run_id WHERE s.logical_id = $1 ORDER BY a.generation', [s.logicalId]);
    const out: AllocationRow[] = [];
    for (const row of r.rows) { const x = await getAllocation(tx, t.orgId, row.id); if (x) out.push(x); }
    return out;
  });
  const allocation = async (t: Tenant, id: string): Promise<AllocationRow> => {
    const x = await db.withTenant({ orgId: t.orgId }, (tx) => getAllocation(tx, t.orgId, id));
    if (!x) throw new Error('no such allocation');
    return x;
  };
  const workspace = async (t: Tenant, id: string): Promise<WorkspaceRow> => {
    const x = await db.withTenant({ orgId: t.orgId }, (tx) => getWorkspace(tx, t.orgId, id));
    if (!x) throw new Error('no such workspace');
    return x;
  };
  // Moves time by backdating the row's timestamps, never by sleeping.
  const backdate = (t: Tenant, id: string, f: { leaseUntilSecondsAgo?: number; heartbeatSecondsAgo?: number; updatedSecondsAgo?: number }): Promise<unknown> => db.withTenant({ orgId: t.orgId }, async (tx) => {
    const sets: string[] = []; const p: unknown[] = [t.orgId, id];
    if (f.leaseUntilSecondsAgo !== undefined) { p.push(f.leaseUntilSecondsAgo); sets.push(`controller_lease_until = clock_timestamp() - make_interval(secs => $${String(p.length)}::double precision)`); }
    if (f.heartbeatSecondsAgo !== undefined) { p.push(f.heartbeatSecondsAgo); sets.push(`last_heartbeat_at = clock_timestamp() - make_interval(secs => $${String(p.length)}::double precision)`); }
    if (f.updatedSecondsAgo !== undefined) { p.push(f.updatedSecondsAgo); sets.push(`updated_at = clock_timestamp() - make_interval(secs => $${String(p.length)}::double precision)`); }
    return tx.query(`UPDATE factory.execution_allocation SET ${sets.join(', ')} WHERE org_id = $1 AND id = $2`, p);
  });
  const auditCount = async (t: Tenant, where: string, params: unknown[] = []): Promise<number> => Number((await q<{ n: string }>(t, `SELECT count(*) AS n FROM factory.audit_event WHERE ${where}`, params))[0]?.n);
  const tables = async (t: Tenant): Promise<string> => JSON.stringify(await Promise.all(['stage_run', 'execution_allocation', 'workspace', 'capacity_reservation'].map((x) => q(t, `SELECT * FROM factory.${x} ORDER BY id`))));

  // Drives a stage run to `running`: start, a pod that is up (with its receipt, for a workspace), a token minted for it, a granted permit.
  async function runningAllocation(t: Tenant, s: Stage, inst: Instance, o: { withWorkspace?: boolean } = {}): Promise<{ allocationId: string; podName: string; podUid: string; token: string; workspaceId: string | undefined; jobName: string }> {
    const workspaceId = o.withWorkspace ? await newWorkspace(t, s, inst) : undefined;
    await inst.runner.startOrAttach(ctx(t), input(t, s, workspaceId ? { workspaceId } : {}), hex('e'));
    const alloc = (await allocations(t, s)).at(-1);
    if (!alloc) throw new Error('no allocation');
    const pod = inst.kube.driver.podsOf(alloc.jobName)[0];
    if (!pod) throw new Error('no pod');
    if (workspaceId) inst.kube.driver.initFinished(pod.metadata.name, { exitCode: 0, message: receiptMessage(alloc.generation) });
    else inst.kube.driver.startPod(pod.metadata.name);
    const token = inst.kube.mintToken(pod, tokenAudience(t.orgId, alloc.id));
    const r = await inst.runner.acquireStartPermit({ token, orgId: t.orgId, allocationId: alloc.id, epoch: alloc.ownerEpoch });
    if (!r.granted) throw new Error(`permit refused: ${r.code} ${r.reason ?? ''}`);
    return { allocationId: alloc.id, podName: pod.metadata.name, podUid: pod.metadata.uid, token, workspaceId, jobName: alloc.jobName };
  }

  const receiptFor = (): { generation: number; headCommit: string; treeDigest: string; gitVersion: string } => ({ generation: 1, headCommit: 'c'.repeat(40), treeDigest: 'ab'.repeat(32), gitVersion: 'git version 2.50.1 (Apple Git-155)' });
  const receiptMessage = (generation = 1): string => encodeReceiptMessage({ ...receiptFor(), generation });

  return {
    m, db, a, b, config, artifacts, ctx, runnerCtx, newStage, input, putArtifact, newRunner, newClusterRunner, newWorkspace, q, allocations, allocation, workspace, backdate, auditCount, tables, receiptFor, receiptMessage, runningAllocation, waiters,
    async close(): Promise<void> {
      for (const x of extraPools) await x.close().catch(() => undefined); // a test may have closed it already ("controller A dies")
      await db.close();
      await m.drop();
      rmSync(base, { recursive: true, force: true });
    },
  };
}
export type Env = Awaited<ReturnType<typeof createEnv>>;
