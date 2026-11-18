import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { WorkflowUpdateStage } from '@temporalio/client';
import pg from 'pg';
import { createWorkerHarness, type WorkerHarness } from './harness.ts';

type View = { status: string; controlRevision: number };

// P-18: commands are decided one at a time in arrival order, and a check that cannot be made is a
// recorded refusal, not an approval and not a failed Update.
describe('P-18 command ordering and an unavailable authority check', () => {
  let h: WorkerHarness;
  beforeAll(async () => {
    h = await createWorkerHarness('p18order');
    // The task's own principal controls its task, as it does through the API.
    await h.db.withTenant({ orgId: h.orgId }, (t) => t.query("INSERT INTO factory.membership (org_id, id, principal_id, role, application_scope) VALUES ($1,$2,$3,'contributor','[\"*\"]')", [h.orgId, randomUUID(), h.principalId]));
  }, 300_000);
  afterAll(async () => { await h.close(); });

  const record = (taskId: string, commandId: string, kind: string, payload = '{}') => h.db.withTenant({ orgId: h.orgId }, (t) => t.query("INSERT INTO factory.command (org_id, id, task_id, principal_id, expected_revision, kind, request_hash, payload, state) VALUES ($1,$2,$3,$4,1,$5,$6,$7::jsonb,'delivered')", [h.orgId, commandId, taskId, h.principalId, kind, 'a'.repeat(64), payload]));
  const slowStage = { delayMs: (n: string) => (n === 'investigate' ? 30_000 : 0) };
  const running = async (handle: { query: <T>(q: string) => Promise<T> }) => { for (let i = 0; i < 300; i += 1) { if ((await handle.query<View>('state')).status === 'running') return; await new Promise((r) => setTimeout(r, 50)); } throw new Error('not running'); };

  it('a later command that needs no check cannot overtake an earlier one whose check is slow', async () => {
    const { taskId, launch } = await h.newTask();
    const cancelId = randomUUID();
    const amendId = randomUUID();
    await record(taskId, cancelId, 'cancel');
    const admin = new pg.Client({ connectionString: h.m.adminUrl });
    await admin.connect();
    try {
      const results = await h.withWorker(slowStage, async (tq) => {
        const handle = await h.env.client.workflow.start('TaskWorkflow', { taskQueue: tq, workflowId: launch.workflowId, args: [launch] });
        await running(handle);
        // The cancel's check reads memberships; hold them locked so that it cannot finish.
        await admin.query('BEGIN');
        await admin.query('LOCK TABLE factory.membership IN ACCESS EXCLUSIVE MODE');
        const cancel = await handle.startUpdate('applyCommand', { args: [{ workflowId: launch.workflowId, commandId: cancelId, kind: 'cancel', expectedRevision: 1 }], waitForStage: WorkflowUpdateStage.ACCEPTED });
        // The later command is the pre-commands-v1 amend_spec form, which is never re-checked, so it could be decided at once.
        const amend = await handle.startUpdate('applyCommand', { args: [{ workflowId: launch.workflowId, commandId: amendId, kind: 'amend_spec', expectedRevision: 1, specVersion: 2 }], waitForStage: WorkflowUpdateStage.ACCEPTED });
        await new Promise((r) => setTimeout(r, 500));
        await admin.query('COMMIT');
        return { cancel: await cancel.result() as { state: string }, amend: await amend.result() as { state: string; reason?: string } };
      });
      expect(results.cancel).toMatchObject({ state: 'applied' });
      expect(results.amend).toMatchObject({ state: 'rejected' });
      expect(results.amend.reason).toMatch(/^stale_revision/);
    } finally {
      await admin.query('ROLLBACK').catch(() => undefined);
      await admin.end();
    }
  });

  it('a check that fails on every attempt rejects the command as authority_check_unavailable and the task goes on', async () => {
    const { taskId, launch } = await h.newTask();
    const commandId = randomUUID();
    // A budget change whose recorded payload is JSON null makes the check Activity throw on every attempt.
    await record(taskId, commandId, 'change_budget', 'null');
    const receipt = await h.withWorker(slowStage, async (tq) => {
      const handle = await h.env.client.workflow.start('TaskWorkflow', { taskQueue: tq, workflowId: launch.workflowId, args: [launch] });
      await running(handle);
      const r = await handle.executeUpdate('applyCommand', { args: [{ workflowId: launch.workflowId, commandId, kind: 'change_budget', expectedRevision: 1, budgetMicroUsd: 1_000_000 }] });
      expect((await handle.query<View>('state')).status).toBe('running'); // the task was not harmed
      await handle.executeUpdate('applyCommand', { args: [{ workflowId: launch.workflowId, commandId: randomUUID(), kind: 'cancel', expectedRevision: 1 }] }).catch(() => undefined);
      return r;
    });
    expect(receipt).toEqual({ state: 'rejected', reason: 'authority_check_unavailable' });
  }, 120_000);
});
