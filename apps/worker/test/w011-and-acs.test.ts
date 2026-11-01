import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { canonicalHash } from '@factory/domain';
import { ProjectionIntegrityIncident, appendTaskEvent, projectTransition } from '@factory/database';
import type { WorkflowView } from '../src/index.ts';
import type { Tx } from '@factory/database';
import { createWorkerHarness, investigationSpec, type WorkerHarness } from './harness.ts';

const until = async (fn: () => Promise<boolean>, ms = 15_000): Promise<void> => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error('condition not met in time');
};

describe('W-011 Temporal task skeleton', () => {
  let h: WorkerHarness;
  beforeAll(async () => { h = await createWorkerHarness('w011'); }, 300_000);
  afterAll(async () => { await h.close(); });

  const tx = <T>(fn: (t: Tx) => Promise<T>) => h.db.withTenant({ orgId: h.orgId }, fn);
  const start = (taskQueue: string, launch: object, workflowId: string) => h.env.client.workflow.start('TaskWorkflow', { taskQueue, workflowId, args: [launch] });

  it('runs the pinned plan through fake stages to success, projecting every transition in order', async () => {
    const { taskId, launch } = await h.newTask();
    const view = await h.withWorker<WorkflowView>(undefined, async (tq) => (await start(tq, launch, launch.workflowId)).result() as Promise<WorkflowView>);
    expect(view.status).toBe('succeeded');
    const task = await tx(async (t) => (await t.query<{ status: string; projection_sequence: string; last_event_sequence: string; plan_version: number }>('SELECT status, projection_sequence, last_event_sequence, plan_version FROM factory.task WHERE id = $1', [taskId])).rows[0]);
    // queued, running, 5 x (stage.started, stage.completed), task.completed
    expect(task).toEqual({ status: 'succeeded', projection_sequence: '13', last_event_sequence: '13', plan_version: 1 });
    const events = await tx(async (t) => (await t.query<{ sequence: string; event_type: string }>('SELECT sequence, event_type FROM factory.task_event WHERE task_id = $1 ORDER BY sequence', [taskId])).rows);
    expect(events.map((e) => Number(e.sequence))).toEqual(Array.from({ length: 13 }, (_, i) => i + 1));
    expect(events[0]?.event_type).toBe('plan.resolved');
    expect(events.at(-1)?.event_type).toBe('task.completed');
    const stages = await tx(async (t) => (await t.query<{ logical_id: string; status: string; input_ref: unknown; result_ref: unknown }>('SELECT logical_id, status, input_ref, result_ref FROM factory.stage_run WHERE task_id = $1 ORDER BY created_at', [taskId])).rows);
    expect(stages.map((s) => [s.logical_id.split('/').slice(2).join('/'), s.status])).toEqual([['scope/attempt-1', 'passed'], ['investigate/attempt-1', 'passed'], ['evidence_review/attempt-1', 'passed'], ['deliver/attempt-1', 'passed'], ['close/attempt-1', 'passed']]);
    expect(stages.every((s) => s.input_ref !== null && s.result_ref !== null)).toBe(true);
    const plan = await tx(async (t) => (await t.query<{ template_id: string; template_version: string }>('SELECT template_id, template_version FROM factory.execution_plan WHERE task_id = $1', [taskId])).rows);
    expect(plan).toEqual([{ template_id: 'investigation', template_version: '0.1.0' }]);
  });

  it('a product failure in a mandatory stage ends the task failed, not succeeded', async () => {
    const { launch } = await h.newTask();
    const view = await h.withWorker<WorkflowView>({ outcome: (node) => (node === 'evidence_review' ? 'product_failure' : 'completed') }, async (tq) => (await start(tq, launch, launch.workflowId)).result() as Promise<WorkflowView>);
    expect(view.status).toBe('failed');
    expect(view.nodes.evidence_review?.status).toBe('failed');
    expect(view.nodes.deliver?.status).toBe('pending');
  });

  describe('AC-04 projection ordering', () => {
    it('with sequence 12 stored, sequence 11 cannot overwrite state and a conflicting duplicate 12 is rejected', async () => {
      const { taskId } = await h.newTask();
      const payloadRef = { artifactId: randomUUID(), sha256: 'a'.repeat(64), mediaType: 'application/json', schemaVersion: '2.0', sizeBytes: 1 };
      const project = (sequence: number, status: 'running' | 'queued' | 'paused', node: string) => tx((t) => projectTransition(t, { orgId: h.orgId, taskId, sequence, state: { status, currentNodeId: node }, refs: { node }, eventType: 'test', payloadRef, correlationId: 'c', producerEventId: `p-${taskId}-${String(sequence)}-${randomUUID()}` }));
      for (let s = 1; s <= 12; s += 1) expect((await project(s, 'running', `n${String(s)}`)).outcome).toBe('applied');
      const read = () => tx(async (t) => (await t.query<{ projection_sequence: string; status: string; current_node_id: string; projection_hash: string }>('SELECT projection_sequence, status, current_node_id, projection_hash FROM factory.task WHERE id = $1', [taskId])).rows[0]);
      const at12 = await read();
      expect(await project(11, 'queued', 'n11')).toEqual({ outcome: 'stale', storedSequence: 12 });
      expect(await read()).toEqual(at12);
      expect(await project(12, 'running', 'n12')).toEqual({ outcome: 'duplicate', sequence: 12 }); // same content: idempotent
      await expect(project(12, 'paused', 'n12')).rejects.toBeInstanceOf(ProjectionIntegrityIncident); // conflicting duplicate
      expect(await read()).toEqual(at12);
      expect(at12?.projection_hash).toBe(canonicalHash({ sequence: 12, state: { status: 'running', currentNodeId: 'n12' }, refs: { node: 'n12' } }));
      expect((await project(13, 'paused', 'n13')).outcome).toBe('applied');
    });

    it('runner progress events advance the event counter but never the projection sequence; producer event IDs deduplicate', async () => {
      const { taskId } = await h.newTask();
      const payloadRef = { artifactId: randomUUID(), sha256: 'b'.repeat(64), mediaType: 'application/json', schemaVersion: '2.0', sizeBytes: 1 };
      await tx((t) => projectTransition(t, { orgId: h.orgId, taskId, sequence: 1, state: { status: 'queued' }, refs: {}, eventType: 'plan.resolved', payloadRef, correlationId: 'c', producerEventId: `p1-${taskId}` }));
      const first = await tx((t) => appendTaskEvent(t, { orgId: h.orgId, taskId, eventType: 'stage.progress', source: 'runner', payloadRef, correlationId: 'c', producerEventId: `progress-${taskId}` }));
      const again = await tx((t) => appendTaskEvent(t, { orgId: h.orgId, taskId, eventType: 'stage.progress', source: 'runner', payloadRef, correlationId: 'c', producerEventId: `progress-${taskId}` }));
      expect(first).toEqual({ eventSequence: 2, duplicate: false });
      expect(again).toEqual({ eventSequence: 2, duplicate: true });
      const row = await tx(async (t) => (await t.query<{ projection_sequence: string; last_event_sequence: string }>('SELECT projection_sequence, last_event_sequence FROM factory.task WHERE id = $1', [taskId])).rows[0]);
      expect(row).toEqual({ projection_sequence: '1', last_event_sequence: '2' });
    });
  });

  describe('AC-07 workflow command race', () => {
    it('a new spec revision racing with an in-flight result: only the current binding advances; the stale command is rejected with a reason', async () => {
      const { taskId, launch } = await h.newTask();
      const slow = { delayMs: (node: string, _a: number, plan: number) => (node === 'investigate' && plan === 1 ? 1500 : 0) };
      const view = await h.withWorker<WorkflowView>(slow, async (tq) => {
        const handle = await start(tq, launch, launch.workflowId);
        await until(async () => (await handle.query<WorkflowView>('state')).nodes.investigate?.status === 'running');
        const spec2 = { ...investigationSpec(h.applicationId), title: 'Revised question: which upstream input is invalid?' };
        await tx((t) => t.query('INSERT INTO factory.task_spec_version (org_id, id, task_id, version, spec, spec_hash, actor_id) VALUES ($1,$2,$3,2,$4,$5,$6)', [h.orgId, randomUUID(), taskId, JSON.stringify(spec2), canonicalHash(spec2), h.principalId]));
        const [amend, stale] = await Promise.all([
          handle.executeUpdate('applyCommand', { args: [{ workflowId: launch.workflowId, commandId: randomUUID(), kind: 'amend_spec', expectedRevision: 1, specVersion: 2 }] }),
          (async () => { await new Promise((r) => setTimeout(r, 50)); return handle.executeUpdate('applyCommand', { args: [{ workflowId: launch.workflowId, commandId: randomUUID(), kind: 'amend_spec', expectedRevision: 1, specVersion: 2 }] }); })(),
        ]);
        expect(amend).toEqual({ state: 'applied', resultingRevision: 2 });
        expect(stale).toEqual({ state: 'rejected', reason: 'stale_revision: expected 1, current 2' });
        return handle.result() as Promise<WorkflowView>;
      });
      expect(view).toMatchObject({ status: 'succeeded', planVersion: 2, specVersion: 2, controlRevision: 2 });
      expect(view.supersededResults).toBe(1);
      const stages = await tx(async (t) => (await t.query<{ logical_id: string; status: string; error_class: string | null; superseded_by_plan_version: number | null }>('SELECT logical_id, status, error_class, superseded_by_plan_version FROM factory.stage_run WHERE task_id = $1 ORDER BY created_at', [taskId])).rows);
      const plan1 = stages.filter((s) => s.logical_id.includes('/plan-1/'));
      const plan2 = stages.filter((s) => s.logical_id.includes('/plan-2/'));
      expect(plan1.map((s) => [s.logical_id.split('/')[2], s.status, s.superseded_by_plan_version])).toEqual([['scope', 'passed', 2], ['investigate', 'inconclusive', 2]]);
      expect(plan1.find((s) => s.logical_id.includes('investigate'))?.error_class).toBe('superseded_binding');
      expect(plan2.map((s) => [s.logical_id.split('/')[2], s.status])).toEqual([['scope', 'passed'], ['investigate', 'passed'], ['evidence_review', 'passed'], ['deliver', 'passed'], ['close', 'passed']]);
    });

    it('unsupported, malformed or post-terminal commands are refused, never silently applied', async () => {
      const { launch } = await h.newTask();
      await h.withWorker({ delayMs: (n) => (n === 'scope' ? 800 : 0) }, async (tq) => {
        const handle = await start(tq, launch, launch.workflowId);
        expect(await handle.executeUpdate('applyCommand', { args: [{ workflowId: launch.workflowId, commandId: randomUUID(), kind: 'force_success', expectedRevision: 1 }] })).toEqual({ state: 'rejected', reason: 'unsupported_command: force_success' });
        await expect(handle.executeUpdate('applyCommand', { args: [{ workflowId: launch.workflowId, kind: 'amend_spec' }] })).rejects.toThrow();
        await handle.result();
        await expect(handle.executeUpdate('applyCommand', { args: [{ workflowId: launch.workflowId, commandId: randomUUID(), kind: 'amend_spec', expectedRevision: 1, specVersion: 2 }] })).rejects.toThrow();
      });
    });
  });

  describe('AC-08 Continue-As-New dedupe', () => {
    it('a command applied before rollover and redelivered into the new run is not applied again; state and cursors stay correct', async () => {
      const { taskId, launch } = await h.newTask();
      const view = await h.withWorker<WorkflowView>({ delayMs: (n, _a, plan) => (n === 'investigate' && plan === 1 ? 600 : 0) }, async (tq) => {
        const handle = await start(tq, { ...launch, continueAsNewAfterStages: 2 }, launch.workflowId);
        await until(async () => (await handle.query<WorkflowView>('state')).nodes.investigate?.status === 'running');
        const spec2 = { ...investigationSpec(h.applicationId), title: 'Amended before rollover' };
        await tx((t) => t.query('INSERT INTO factory.task_spec_version (org_id, id, task_id, version, spec, spec_hash, actor_id) VALUES ($1,$2,$3,2,$4,$5,$6)', [h.orgId, randomUUID(), taskId, JSON.stringify(spec2), canonicalHash(spec2), h.principalId]));
        const command = { workflowId: launch.workflowId, commandId: randomUUID(), kind: 'amend_spec', expectedRevision: 1, specVersion: 2 };
        expect(await handle.executeUpdate('applyCommand', { args: [command] })).toEqual({ state: 'applied', resultingRevision: 2 });
        // Wait for at least one rollover, then redeliver the same command ID to the latest run.
        await until(async () => { const ids: string[] = []; for await (const w of h.env.client.workflow.list({ query: `WorkflowId = '${launch.workflowId}'` })) ids.push(w.runId); return ids.length >= 2; });
        const latest = h.env.client.workflow.getHandle(launch.workflowId);
        expect(await latest.executeUpdate('applyCommand', { args: [command] })).toEqual({ state: 'applied', resultingRevision: 2 });
        const mid = await latest.query<WorkflowView>('state');
        expect(mid.controlRevision).toBe(2); // not incremented a second time
        expect(mid.receiptCount).toBe(1);
        return latest.result() as Promise<WorkflowView>;
      });
      expect(view).toMatchObject({ status: 'succeeded', controlRevision: 2, specVersion: 2, planVersion: 2, receiptCount: 1 });
      const runs: string[] = [];
      for await (const w of h.env.client.workflow.list({ query: `WorkflowId = '${launch.workflowId}'` })) runs.push(w.runId);
      expect(runs.length).toBeGreaterThanOrEqual(2);
      const task = await tx(async (t) => (await t.query<{ projection_sequence: string; last_event_sequence: string; status: string }>('SELECT projection_sequence, last_event_sequence, status FROM factory.task WHERE id = $1', [taskId])).rows[0]);
      expect(task?.status).toBe('succeeded');
      expect(task?.projection_sequence).toBe(task?.last_event_sequence); // one gap-free cursor across all runs
      const seqs = await tx(async (t) => (await t.query<{ sequence: string }>('SELECT sequence FROM factory.task_event WHERE task_id = $1 ORDER BY sequence', [taskId])).rows.map((r) => Number(r.sequence)));
      expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));
    });
  });
});
