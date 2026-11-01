import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { Tx } from '@factory/database';
import type { WorkflowView } from '../src/index.ts';
import { createWorkerHarness, type WorkerHarness } from './harness.ts';

describe('AC-34 budget concurrency (workflow half: unmet work never becomes success)', () => {
  let h: WorkerHarness;
  beforeAll(async () => { h = await createWorkerHarness('w013'); }, 300_000);
  afterAll(async () => { await h.close(); });
  const tx = <T>(fn: (t: Tx) => Promise<T>) => h.db.withTenant({ orgId: h.orgId }, fn);
  const start = (tq: string, launch: object, id: string) => h.env.client.workflow.start('TaskWorkflow', { taskQueue: tq, workflowId: id, args: [launch] });

  it('when the allowance runs out before the plan finishes, the task ends incomplete with the reason and unmet nodes', async () => {
    const { taskId, launch } = await h.newTask({ maxMicroUsd: 2_500_000 });
    const view = await h.withWorker<WorkflowView>(undefined, async (tq) => (await start(tq, launch, launch.workflowId)).result() as Promise<WorkflowView>);
    expect(view.status).toBe('incomplete');
    expect(Object.values(view.nodes).filter((n) => n.status === 'passed')).toHaveLength(2);
    const task = await tx(async (t) => (await t.query<{ status: string; waiting_reason: string }>('SELECT status, waiting_reason FROM factory.task WHERE id = $1', [taskId])).rows[0]);
    expect(task).toEqual({ status: 'incomplete', waiting_reason: 'budget_exhausted' });
    const account = await tx(async (t) => (await t.query<{ charged_micro_usd: string; reserved_micro_usd: string; limit_micro_usd: string }>('SELECT charged_micro_usd, reserved_micro_usd, limit_micro_usd FROM factory.budget_account WHERE task_id = $1', [taskId])).rows[0]);
    expect(account).toEqual({ charged_micro_usd: '2000000', reserved_micro_usd: '0', limit_micro_usd: '2500000' });
  });

  it('an overrun reported by a stage stops the next admission, still incomplete rather than success', async () => {
    const { taskId, launch } = await h.newTask();
    const view = await h.withWorker<WorkflowView>({ actualMicroUsd: (n) => (n === 'scope' ? 30_000_000 : 1_000_000) }, async (tq) => (await start(tq, launch, launch.workflowId)).result() as Promise<WorkflowView>);
    expect(view.status).toBe('incomplete');
    expect(view.nodes.scope?.status).toBe('passed');
    expect(view.nodes.investigate?.status).toBe('pending');
    const charged = await tx(async (t) => (await t.query<{ charged_micro_usd: string }>('SELECT charged_micro_usd FROM factory.budget_account WHERE task_id = $1', [taskId])).rows[0]?.charged_micro_usd);
    expect(charged).toBe('30000000');
  });

  it('invocation mode one admits the plan\'s single authoring stage and independent checks still run', async () => {
    const { launch } = await h.newTask({ invocationMode: 'one' });
    const view = await h.withWorker<WorkflowView>(undefined, async (tq) => (await start(tq, launch, launch.workflowId)).result() as Promise<WorkflowView>);
    expect(view.status).toBe('succeeded'); // the investigation plan has exactly one authoring stage
    expect(view.nodes.investigate?.status).toBe('passed');
    expect(view.nodes.evidence_review?.status).toBe('passed'); // independent review is not an authoring invocation
  });
});
