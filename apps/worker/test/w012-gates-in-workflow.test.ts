import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { canonicalHash, gateInputHash } from '@factory/domain';
import type { Tx } from '@factory/database';
import type { WorkflowView } from '../src/index.ts';
import { createWorkerHarness, investigationSpec, type WorkerHarness } from './harness.ts';

describe('W-012 gate engine in TaskWorkflow', () => {
  let h: WorkerHarness;
  beforeAll(async () => { h = await createWorkerHarness('w012'); }, 300_000);
  afterAll(async () => { await h.close(); });
  const tx = <T>(fn: (t: Tx) => Promise<T>) => h.db.withTenant({ orgId: h.orgId }, fn);
  const start = (tq: string, launch: object, id: string) => h.env.client.workflow.start('TaskWorkflow', { taskQueue: tq, workflowId: id, args: [launch] });
  const gates = (taskId: string) => tx(async (t) => (await t.query<{ id: string; gate_id: string; verdict: string; input_hash: string; input_binding: Record<string, unknown>; reason_codes: string[]; superseded_by: string | null }>('SELECT id, gate_id, verdict, input_hash, input_binding, reason_codes, superseded_by FROM factory.gate_evaluation WHERE task_id = $1 ORDER BY created_at', [taskId])).rows);

  it('every required gate is evaluated once against its exact declared binding and recorded immutably', async () => {
    const { taskId, launch } = await h.newTask();
    const view = await h.withWorker<WorkflowView>(undefined, async (tq) => (await start(tq, launch, launch.workflowId)).result() as Promise<WorkflowView>);
    expect(view.status).toBe('succeeded');
    const rows = await gates(taskId);
    expect(rows.map((r) => [r.gate_id, r.verdict])).toEqual([['scope_accepted', 'passed'], ['review_passed', 'passed'], ['outcome_recorded', 'passed']]);
    for (const r of rows) {
      const projection = Object.fromEntries(Object.entries(r.input_binding).filter(([k]) => k !== 'stageRunId'));
      expect(r.input_hash).toBe(gateInputHash(r.gate_id as 'scope_accepted', projection));
    }
    await expect(tx((t) => t.query("UPDATE factory.gate_evaluation SET verdict = 'failed' WHERE task_id = $1", [taskId]))).rejects.toMatchObject({ code: '42501' });
  });

  it('a blocking review finding fails review_passed; the node does not pass and nothing downstream runs', async () => {
    const { taskId, launch } = await h.newTask();
    const view = await h.withWorker<WorkflowView>({ evidence: (node, d) => (node === 'evidence_review' ? { ...d, findings: [{ severity: 'high', blocking: true }] } : d) }, async (tq) => (await start(tq, launch, launch.workflowId)).result() as Promise<WorkflowView>);
    expect(view.status).toBe('failed');
    expect(view.nodes.evidence_review?.status).toBe('failed');
    expect(view.nodes.deliver?.status).toBe('pending');
    expect((await gates(taskId)).find((g) => g.gate_id === 'review_passed')).toMatchObject({ verdict: 'failed', reason_codes: ['unresolved_blocking_findings'] });
  });

  it('a reviewer that is the author fails independence, even with no findings and a self-description claiming otherwise', async () => {
    const { taskId, launch } = await h.newTask();
    // The review stage really ran as the author's producer; its output still claims independence.
    const view = await h.withWorker<WorkflowView>({ producerId: (node) => (node === 'evidence_review' ? 'fake-runner' : node === 'investigate' ? 'fake-runner' : 'fake-other') }, async (tq) => (await start(tq, launch, launch.workflowId)).result() as Promise<WorkflowView>);
    expect((await gates(taskId)).find((g) => g.gate_id === 'review_passed')).toMatchObject({ verdict: 'failed', reason_codes: ['reviewer_not_independent'] });
    expect(view.status).toBe('failed');
    expect(view.nodes.deliver?.status).toBe('pending');
  });

  it('the reviewer cannot make itself independent or dependent by describing itself: only recorded producers count', async () => {
    const { taskId, launch } = await h.newTask();
    const view = await h.withWorker<WorkflowView>({ evidence: (node, d) => (node === 'evidence_review' ? { ...d, reviewerProducerId: 'fake-runner' } : d) }, async (tq) => (await start(tq, launch, launch.workflowId)).result() as Promise<WorkflowView>);
    expect((await gates(taskId)).find((g) => g.gate_id === 'review_passed')).toMatchObject({ verdict: 'passed' });
    expect(view.status).toBe('succeeded');
  });

  it('scope_accepted maps the pinned criteria, not the discovery stage\'s own list', async () => {
    const { taskId, launch } = await h.newTask();
    // Discovery reports only a criterion it invented, and "maps" exactly that one.
    const view = await h.withWorker<WorkflowView>({ evidence: (node, d) => (node === 'scope' ? { ...d, criteriaIds: ['C9'], mappedCriteriaIds: ['C9'] } : d) }, async (tq) => (await start(tq, launch, launch.workflowId)).result() as Promise<WorkflowView>);
    expect(view.status).toBe('failed');
    expect((await gates(taskId)).map((g) => [g.gate_id, g.verdict, g.reason_codes])).toEqual([['scope_accepted', 'failed', ['criteria_unmapped']]]);
  });

  it('a blocking context gap fails scope_accepted at the first node', async () => {
    const { taskId, launch } = await h.newTask();
    const view = await h.withWorker<WorkflowView>({ evidence: (node, d) => (node === 'scope' ? { ...d, blockingGaps: ['no telemetry for the incident window'] } : d) }, async (tq) => (await start(tq, launch, launch.workflowId)).result() as Promise<WorkflowView>);
    expect(view.status).toBe('failed');
    expect((await gates(taskId)).map((g) => [g.gate_id, g.verdict, g.reason_codes])).toEqual([['scope_accepted', 'failed', ['blocking_context_gap']]]);
  });

  it('a plan revision supersedes the old plan\'s gate evaluations; the new plan earns its own', async () => {
    const { taskId, launch } = await h.newTask();
    const view = await h.withWorker<WorkflowView>({ delayMs: (n, _a, p) => (n === 'investigate' && p === 1 ? 1200 : 0) }, async (tq) => {
      const handle = await start(tq, launch, launch.workflowId);
      for (let i = 0; i < 300 && (await handle.query<WorkflowView>('state')).nodes.investigate?.status !== 'running'; i += 1) await new Promise((r) => setTimeout(r, 25));
      const spec2 = { ...investigationSpec(h.applicationId), acceptanceCriteria: ['A revised, narrower question.'] };
      await tx((t) => t.query('INSERT INTO factory.task_spec_version (org_id, id, task_id, version, spec, spec_hash, actor_id) VALUES ($1,$2,$3,2,$4,$5,$6)', [h.orgId, randomUUID(), taskId, JSON.stringify(spec2), canonicalHash(spec2), h.principalId]));
      await handle.executeUpdate('applyCommand', { args: [{ workflowId: launch.workflowId, commandId: randomUUID(), kind: 'amend_spec', expectedRevision: 1, specVersion: 2 }] });
      return handle.result() as Promise<WorkflowView>;
    });
    expect(view).toMatchObject({ status: 'succeeded', planVersion: 2 });
    const rows = await gates(taskId);
    const plan1Scope = rows.find((r) => r.gate_id === 'scope_accepted' && r.input_binding.planVersion === 1);
    expect(plan1Scope?.verdict).toBe('passed');
    expect(plan1Scope?.superseded_by).toBeTruthy();
    expect(rows.find((r) => r.id === plan1Scope?.superseded_by)).toMatchObject({ verdict: 'superseded', reason_codes: ['plan_revised'] });
    const plan2 = rows.filter((r) => r.input_binding.planVersion === 2);
    expect(plan2.map((r) => [r.gate_id, r.verdict, r.superseded_by])).toEqual([['scope_accepted', 'passed', null], ['review_passed', 'passed', null], ['outcome_recorded', 'passed', null]]);
    expect(plan2.find((r) => r.gate_id === 'scope_accepted')?.input_hash).not.toBe(plan1Scope?.input_hash);
  });
});
