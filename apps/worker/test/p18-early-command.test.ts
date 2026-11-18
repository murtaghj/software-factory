import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { WithStartWorkflowOperation } from '@temporalio/client';
import { createWorkerHarness, type WorkerHarness } from './harness.ts';

// P-18: a command that reaches the workflow in the same workflow task as its start, while the task
// is still being loaded, is re-checked like any other (authority-v1 is read before the first await).
describe('P-18 a command that arrives while the task loads is re-checked', () => {
  let h: WorkerHarness;
  beforeAll(async () => { h = await createWorkerHarness('p18early'); }, 300_000);
  afterAll(async () => { await h.close(); });

  it('a pause from a principal who was disabled before it was applied is refused, even when it arrives with the start', async () => {
    const { taskId, launch } = await h.newTask();
    const disabled = randomUUID();
    const commandId = randomUUID();
    await h.db.withTenant({ orgId: h.orgId }, async (t) => {
      await t.query("INSERT INTO factory.principal (org_id, id, issuer, subject, display_name, disabled_at) VALUES ($1,$2,'https://issuer',$3,'Gone', now())", [h.orgId, disabled, `gone-${disabled}`]);
      await t.query("INSERT INTO factory.command (org_id, id, task_id, principal_id, expected_revision, kind, request_hash, payload, state) VALUES ($1,$2,$3,$4,1,'pause',$5,'{}','delivered')", [h.orgId, commandId, taskId, disabled, 'a'.repeat(64)]);
    });
    const receipt = await h.withWorker(undefined, async (tq) => {
      const op = new WithStartWorkflowOperation('TaskWorkflow', { workflowId: launch.workflowId, taskQueue: tq, args: [launch], workflowIdConflictPolicy: 'FAIL' });
      const r = await h.env.client.workflow.executeUpdateWithStart('applyCommand', { args: [{ workflowId: launch.workflowId, commandId, kind: 'pause', expectedRevision: 1 }], startWorkflowOperation: op });
      await (await op.workflowHandle()).result();
      return r;
    });
    expect(receipt).toEqual({ state: 'rejected', reason: 'authority_revoked' });
  });
});
