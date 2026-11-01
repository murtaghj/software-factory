// Captures representative TaskWorkflow histories as replay fixtures (AC-09). Run deliberately when
// a new workflow build is accepted; never overwrite an existing fixture — fixtures from older
// builds must keep replaying against every later build.
// Usage: node apps/worker/scripts/capture-histories.ts [--suffix <build-label>]
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { historyToJSON } from '@temporalio/common/lib/proto-utils';
import type { WorkflowHandle } from '@temporalio/client';
import { canonicalHash } from '@factory/domain';
import { createWorkerHarness, investigationSpec } from '../test/harness.ts';

const outDir = join(import.meta.dirname, '..', 'test', 'histories');
const workflowsDir = join(import.meta.dirname, '..', 'src', 'workflows');
export function workflowCodeDigest(): string {
  const h = createHash('sha256');
  for (const f of readdirSync(workflowsDir).sort()) h.update(`${f}\0${readFileSync(join(workflowsDir, f), 'utf8')}\n`);
  return h.digest('hex');
}

const h = await createWorkerHarness('capture');
mkdirSync(outDir, { recursive: true });
const manifestPath = join(outDir, 'manifest.json');
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown> : {};
const build = workflowCodeDigest();
const until = async (fn: () => Promise<boolean>): Promise<void> => { for (let i = 0; i < 300; i += 1) { if (await fn()) return; await new Promise((r) => setTimeout(r, 50)); } throw new Error('timeout'); };

const suffixAt = process.argv.indexOf('--suffix');
const suffix = suffixAt >= 0 ? `-${process.argv[suffixAt + 1] ?? ''}` : '';

async function capture(baseName: string, description: string, run: (tq: string) => Promise<string>, behavior?: Parameters<typeof h.withWorker>[0]): Promise<void> {
  const name = `${baseName}${suffix}`;
  const file = join(outDir, `${name}.json`);
  if (existsSync(file)) { console.log(`keep existing ${name}`); return; }
  const runId = await h.withWorker(behavior, run);
  const workflowId = runId.split('|')[0] ?? '';
  const history = await h.env.client.workflow.getHandle(workflowId, runId.split('|')[1]).fetchHistory();
  writeFileSync(file, historyToJSON(history));
  manifest[name] = { description, workflowId, capturedWithWorkflowCodeDigest: build, events: history.events?.length ?? 0 };
  console.log(`captured ${name} (${String(history.events?.length ?? 0)} events)`);
}

const start = (tq: string, launch: object, id: string) => h.env.client.workflow.start('TaskWorkflow', { taskQueue: tq, workflowId: id, args: [launch] });

await capture('completed', 'Investigation plan run to success through fake stages', async (tq) => {
  const { launch } = await h.newTask();
  const handle = await start(tq, launch, launch.workflowId);
  await handle.result();
  return `${launch.workflowId}|${handle.firstExecutionRunId}`;
});

await capture('failed', 'Mandatory evidence_review stage reports a product failure', async (tq) => {
  const { launch } = await h.newTask();
  const handle = await start(tq, launch, launch.workflowId);
  await handle.result();
  return `${launch.workflowId}|${handle.firstExecutionRunId}`;
}, { outcome: (n) => (n === 'evidence_review' ? 'product_failure' : 'completed') });

await capture('active-mid-stage', 'Open history: the investigate stage is still executing', async (tq) => {
  const { launch } = await h.newTask();
  const handle = await start(tq, launch, launch.workflowId);
  await until(async () => (await handle.query<{ nodes: Record<string, { status: string }> }>('state')).nodes.investigate?.status === 'running');
  return `${launch.workflowId}|${handle.firstExecutionRunId}`;
}, { delayMs: (n) => (n === 'investigate' ? 3000 : 0) });

await capture('amended', 'amend_spec races an in-flight stage; plan 2 supersedes plan 1', async (tq) => {
  const { taskId, launch } = await h.newTask();
  const handle = await start(tq, launch, launch.workflowId);
  await until(async () => (await handle.query<{ nodes: Record<string, { status: string }> }>('state')).nodes.investigate?.status === 'running');
  const spec2 = { ...investigationSpec(h.applicationId), title: 'Amended' };
  await h.db.withTenant({ orgId: h.orgId }, (t) => t.query('INSERT INTO factory.task_spec_version (org_id, id, task_id, version, spec, spec_hash, actor_id) VALUES ($1,$2,$3,2,$4,$5,$6)', [h.orgId, randomUUID(), taskId, JSON.stringify(spec2), canonicalHash(spec2), h.principalId]));
  await handle.executeUpdate('applyCommand', { args: [{ workflowId: launch.workflowId, commandId: randomUUID(), kind: 'amend_spec', expectedRevision: 1, specVersion: 2 }] });
  await handle.result();
  return `${launch.workflowId}|${handle.firstExecutionRunId}`;
}, { delayMs: (n, _a, p) => (n === 'investigate' && p === 1 ? 800 : 0) });

await capture('continued-as-new', 'First run of a task that rolls over after two stages', async (tq) => {
  const { launch } = await h.newTask();
  const handle = await start(tq, { ...launch, continueAsNewAfterStages: 2 }, launch.workflowId);
  await h.env.client.workflow.getHandle(launch.workflowId).result();
  return `${launch.workflowId}|${handle.firstExecutionRunId}`;
});

// commands-v1 scenarios on the production template (investigation 0.2.0, mandatory plan review).
const reviewerId = randomUUID();
await h.db.withTenant({ orgId: h.orgId }, async (t) => {
  await t.query("INSERT INTO factory.principal (org_id, id, issuer, subject, display_name) VALUES ($1,$2,'https://issuer',$3,'Reviewer') ON CONFLICT DO NOTHING", [h.orgId, reviewerId, `reviewer-${reviewerId}`]);
  await t.query("INSERT INTO factory.membership (org_id, id, principal_id, role, application_scope) VALUES ($1,$2,$3,'reviewer','[\"*\"]')", [h.orgId, randomUUID(), reviewerId]);
});
type View = { status: string; controlRevision: number; nodes: Record<string, { status: string }> };
const approve = async (handle: WorkflowHandle, workflowId: string, taskId: string) => {
  await until(async () => (await handle.query<View>('state')).status === 'waiting_decision');
  const d = await h.db.withTenant({ orgId: h.orgId }, async (t) => (await t.query<{ id: string; subject_hash: string }>("SELECT id, subject_hash FROM factory.decision_request WHERE task_id = $1 AND state = 'pending'", [taskId])).rows[0]);
  const rev = (await handle.query<View>('state')).controlRevision;
  const commandId = randomUUID(); // as the API would, record the command row the decision references
  await h.db.withTenant({ orgId: h.orgId }, (t) => t.query("INSERT INTO factory.command (org_id, id, task_id, principal_id, expected_revision, kind, request_hash, payload, state) VALUES ($1,$2,$3,$4,$5,'respond_decision',$6,'{}','delivered')", [h.orgId, commandId, taskId, reviewerId, rev, 'a'.repeat(64)]));
  await handle.executeUpdate('applyCommand', { args: [{ workflowId, commandId, kind: 'respond_decision', expectedRevision: rev, decisionId: d?.id, subjectHash: d?.subject_hash, outcome: 'approve', reason: 'ok', reviewedSectionIds: ['intent_scope', 'current_state', 'design', 'interfaces_data', 'implementation', 'acceptance_tests', 'quality_security', 'delivery_recovery', 'operations', 'risks_decisions', 'definition_of_done', 'review_ownership'], deciderPrincipalId: reviewerId, channel: 'decision_response_endpoint' }] });
};
const withTemplate = async (behavior: Parameters<typeof h.withWorker>[0], fn: (tq: string) => Promise<string>) => h.withWorker(behavior, fn, { template: 'investigation-0.2.0.json' });
async function captureWith(baseName: string, description: string, behavior: Parameters<typeof h.withWorker>[0], run: (tq: string) => Promise<string>): Promise<void> {
  const name = `${baseName}${suffix}`;
  const file = join(outDir, `${name}.json`);
  if (existsSync(file)) { console.log(`keep existing ${name}`); return; }
  const ids = await withTemplate(behavior, run);
  const [workflowId, runId] = ids.split('|');
  const history = await h.env.client.workflow.getHandle(workflowId ?? '', runId).fetchHistory();
  writeFileSync(file, historyToJSON(history));
  manifest[name] = { description, workflowId, capturedWithWorkflowCodeDigest: build, events: history.events?.length ?? 0 };
  console.log(`captured ${name} (${String(history.events?.length ?? 0)} events)`);
}
// Command scenarios need the production template (plan review); captured for every build since commands-v1.
if (suffix === '-commands-v1' || suffix === '-outcome-v1') {
  await captureWith('plan-review-approved', 'Production template: plan review approved by an independent peer', undefined, async (tq) => {
    const { taskId, launch } = await h.newTask();
    const handle = await start(tq, launch, launch.workflowId);
    await approve(handle, launch.workflowId, taskId);
    await handle.result();
    return `${launch.workflowId}|${handle.firstExecutionRunId}`;
  });
  await captureWith('paused-resumed', 'Paused during a stage, then resumed', { delayMs: (n) => (n === 'investigate' ? 800 : 0) }, async (tq) => {
    const { taskId, launch } = await h.newTask();
    const handle = await start(tq, launch, launch.workflowId);
    await approve(handle, launch.workflowId, taskId);
    await until(async () => (await handle.query<View>('state')).nodes.investigate?.status === 'running');
    let rev = (await handle.query<View>('state')).controlRevision;
    await handle.executeUpdate('applyCommand', { args: [{ workflowId: launch.workflowId, commandId: randomUUID(), kind: 'pause', expectedRevision: rev }] });
    await until(async () => (await handle.query<View>('state')).status === 'paused');
    rev = (await handle.query<View>('state')).controlRevision;
    await handle.executeUpdate('applyCommand', { args: [{ workflowId: launch.workflowId, commandId: randomUUID(), kind: 'resume', expectedRevision: rev }] });
    await handle.result();
    return `${launch.workflowId}|${handle.firstExecutionRunId}`;
  });
  await captureWith('cancelled-in-flight', 'Cancelled while a stage was executing', { delayMs: (n) => (n === 'investigate' ? 3000 : 0) }, async (tq) => {
    const { taskId, launch } = await h.newTask();
    const handle = await start(tq, launch, launch.workflowId);
    await approve(handle, launch.workflowId, taskId);
    await until(async () => (await handle.query<View>('state')).nodes.investigate?.status === 'running');
    const rev = (await handle.query<View>('state')).controlRevision;
    await handle.executeUpdate('applyCommand', { args: [{ workflowId: launch.workflowId, commandId: randomUUID(), kind: 'cancel', expectedRevision: rev }] });
    await handle.result();
    return `${launch.workflowId}|${handle.firstExecutionRunId}`;
  });
}

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
await h.close();
