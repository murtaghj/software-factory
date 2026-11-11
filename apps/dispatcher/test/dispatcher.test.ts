import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { Database, createMigratedDatabase, provisionOrganization, type MigratedDatabase } from '@factory/database';
import { ClientGateway, Dispatcher, type TemporalGateway } from '../src/index.ts';

const TASK_QUEUE = 'factory-tasks-test';

describe('W-010 outbox dispatcher', () => {
  let env: TestWorkflowEnvironment;
  let worker: Worker;
  let running: Promise<void>;
  let m: MigratedDatabase;
  let db: Database;
  let gateway: ClientGateway;
  const orgId = randomUUID();
  const principalId = randomUUID();
  const appId = randomUUID();

  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createLocal();
    const namespace = env.namespace ?? 'default';
    worker = await Worker.create({ connection: env.nativeConnection, namespace, taskQueue: TASK_QUEUE, workflowsPath: new URL('./fixture-workflows.ts', import.meta.url).pathname });
    running = worker.run();
    gateway = new ClientGateway(env.connection, namespace);
    m = await createMigratedDatabase('w010');
    await provisionOrganization(m.migratorUrl, { id: orgId, name: 'Org' });
    db = Database.connect(m.runtimeUrl);
    await db.withTenant({ orgId }, async (tx) => {
      await tx.query("INSERT INTO factory.principal (org_id, id, issuer, subject, display_name) VALUES ($1,$2,'https://i','s','u')", [orgId, principalId]);
      await tx.query("INSERT INTO factory.application (org_id, id, app_key, name, owner_ids, lifecycle) VALUES ($1,$2,'orders','Orders','[]','production')", [orgId, appId]);
    });
  }, 300_000);
  afterAll(async () => { worker.shutdown(); await running; await db.close(); await m.drop(); await env.teardown(); });

  async function newTask(): Promise<{ taskId: string; workflowId: string }> {
    const taskId = randomUUID();
    const workflowId = `factory/${orgId}/${taskId}`;
    await db.withTenant({ orgId }, async (tx) => {
      await tx.query("INSERT INTO factory.task (org_id, id, creator_id, primary_application_id, target_kind, target_context, work_type, change_class, delivery_scope, status) VALUES ($1,$2,$3,$4,'existing_application',$5,'feature','feature','pr','accepted')",
        [orgId, taskId, principalId, appId, JSON.stringify({ kind: 'existing_application', applicationId: appId })]);
      await tx.query("INSERT INTO factory.outbox (org_id, id, kind, aggregate_id, dedupe_key, payload, state) VALUES ($1,$2,'task.launch',$3,$4,$5,'pending')",
        [orgId, randomUUID(), taskId, `launch:${taskId}`, JSON.stringify({ workflowId, taskId, orgId, specVersion: 1 })]);
    });
    return { taskId, workflowId };
  }

  const outbox = (taskId: string) => db.withTenant({ orgId }, async (tx) => (await tx.query<{ state: string; attempts: number; lease_owner: string | null; last_error: string | null; available_at: Date }>('SELECT state, attempts, lease_owner, last_error, available_at FROM factory.outbox WHERE aggregate_id = $1', [taskId])).rows);
  const binding = (taskId: string) => db.withTenant({ orgId }, async (tx) => (await tx.query<{ workflow_id: string; current_run_id: string; last_observed_state: string }>('SELECT workflow_id, current_run_id, last_observed_state FROM factory.workflow_binding WHERE task_id = $1', [taskId])).rows);
  const runs = async (workflowId: string): Promise<string[]> => {
    const ids: string[] = [];
    for await (const w of env.client.workflow.list({ query: `WorkflowId = '${workflowId}'` })) ids.push(w.runId);
    return ids;
  };
  const dispatcher = (o: Partial<ConstructorParameters<typeof Dispatcher>[0]> = {}) => new Dispatcher({ db, temporal: gateway, taskQueue: TASK_QUEUE, ...o });

  describe('AC-03 launch crash recovery', () => {
    it('a dispatcher that dies after the Temporal start but before marking dispatch is recovered: the restart attaches to the same Workflow ID and clears the outbox', async () => {
      const { taskId, workflowId } = await newTask();
      const doomed = dispatcher({ owner: 'dispatcher-a', leaseMs: 10_000 });
      const [claimed] = (await doomed.claim(orgId)).filter((r) => r.aggregate_id === taskId);
      expect(claimed).toBeDefined();
      const { runId } = await gateway.start({ workflowId, taskQueue: TASK_QUEUE, args: [claimed?.payload] }); // the start A made before dying
      expect((await outbox(taskId))[0]).toMatchObject({ state: 'leased', lease_owner: 'dispatcher-a' });
      // The restarted dispatcher waits out the dead one's lease, then reconciles instead of starting again.
      expect((await dispatcher({ owner: 'dispatcher-b' }).runOnce()).filter((o) => o.outboxId === claimed?.id)).toEqual([]); // lease still held
      const restarted = dispatcher({ owner: 'dispatcher-b', clockOffsetMs: () => 11_000 });
      const outcomes = (await restarted.runOnce()).filter((o) => o.outboxId === claimed?.id);
      expect(outcomes.map((o) => o.result)).toEqual(['delivered']);
      expect(await binding(taskId)).toEqual([{ workflow_id: workflowId, current_run_id: runId, last_observed_state: 'attached:RUNNING' }]);
      expect((await outbox(taskId))[0]).toMatchObject({ state: 'delivered', lease_owner: null });
      expect(await runs(workflowId)).toEqual([runId]); // exactly one task workflow
      // If the dead dispatcher resumes, it no longer holds the lease and cannot overwrite the result.
      expect((await doomed.dispatch(claimed as never)).result).toBe('lease_lost');
      expect(await runs(workflowId)).toEqual([runId]);
    });

    it('a start whose reply is lost is reconciled by the same dispatcher without a second start', async () => {
      const { taskId, workflowId } = await newTask();
      const lossy: TemporalGateway = {
        start: async (req) => { await gateway.start(req); throw Object.assign(new Error('deadline exceeded awaiting reply'), { code: 4 }); },
        describe: (id) => gateway.describe(id),
        update: (id, u, a) => gateway.update(id, u, a),
      };
      const outcomes = (await dispatcher({ temporal: lossy }).runOnce()).filter((o) => o.kind === 'task.launch');
      expect(outcomes.some((o) => o.result === 'delivered')).toBe(true);
      const [b] = await binding(taskId);
      expect(b?.workflow_id).toBe(workflowId);
      expect(await runs(workflowId)).toEqual([b?.current_run_id]);
    });

    it('a start that failed before the workflow existed is retried with backoff and then delivered once', async () => {
      const { taskId, workflowId } = await newTask();
      const failing: TemporalGateway = { start: () => Promise.reject(Object.assign(new Error('connection refused'), { code: 14 })), describe: (id) => gateway.describe(id), update: (id, u, a) => gateway.update(id, u, a) };
      expect((await dispatcher({ temporal: failing }).runOnce()).find((o) => o.kind === 'task.launch')?.result).toBe('retry');
      const [row] = await outbox(taskId);
      expect(row).toMatchObject({ state: 'pending', attempts: 1 });
      expect(row?.last_error).toContain('connection refused');
      expect((await dispatcher().runOnce()).filter((o) => o.kind === 'task.launch')).toEqual([]); // backoff not elapsed
      expect((await dispatcher({ clockOffsetMs: () => 2000 }).runOnce()).find((o) => o.kind === 'task.launch')?.result).toBe('delivered');
      expect(await runs(workflowId)).toHaveLength(1);
    });

    it('two dispatchers racing over the same outbox start each task workflow once', async () => {
      const tasks = await Promise.all([newTask(), newTask(), newTask()]);
      const [x, y] = await Promise.all([dispatcher().runOnce(), dispatcher().runOnce()]);
      const delivered = [...x, ...y].filter((o) => o.result === 'delivered').length;
      expect(delivered).toBe(3);
      for (const t of tasks) {
        expect((await outbox(t.taskId))[0]?.state).toBe('delivered');
        expect(await runs(t.workflowId)).toHaveLength(1);
      }
    });
  });

  describe('retry classification', () => {
    it('a permanent start failure goes to dead_letter instead of retrying forever', async () => {
      const { taskId } = await newTask();
      const invalid: TemporalGateway = { start: () => Promise.reject(Object.assign(new Error('invalid argument'), { code: 3 })), describe: (id) => gateway.describe(id), update: (id, u, a) => gateway.update(id, u, a) };
      expect((await dispatcher({ temporal: invalid }).runOnce()).find((o) => o.kind === 'task.launch')?.result).toBe('dead_letter');
      expect((await outbox(taskId))[0]?.state).toBe('dead_letter');
    });

    it('a launch row that does not name the stable task workflow ID is refused', async () => {
      const taskId = randomUUID();
      await db.withTenant({ orgId }, async (tx) => {
        await tx.query("INSERT INTO factory.task (org_id, id, creator_id, primary_application_id, target_kind, target_context, work_type, change_class, delivery_scope, status) VALUES ($1,$2,$3,$4,'existing_application',$5,'feature','feature','pr','accepted')", [orgId, taskId, principalId, appId, JSON.stringify({ kind: 'existing_application', applicationId: appId })]);
        await tx.query("INSERT INTO factory.outbox (org_id, id, kind, aggregate_id, dedupe_key, payload, state) VALUES ($1,$2,'task.launch',$3,$4,$5,'pending')", [orgId, randomUUID(), taskId, `launch:${taskId}`, JSON.stringify({ workflowId: 'some-other-id' })]);
      });
      expect((await dispatcher().runOnce()).find((o) => o.kind === 'task.launch')?.result).toBe('dead_letter');
      expect(await runs('some-other-id')).toEqual([]);
    });
  });

  describe('command delivery (AC-07/AC-08 dispatcher half)', () => {
    async function command(taskId: string, workflowId: string, kind: string, rollover = false): Promise<string> {
      const commandId = randomUUID();
      await db.withTenant({ orgId }, async (tx) => {
        await tx.query("INSERT INTO factory.command (org_id, id, task_id, principal_id, expected_revision, kind, request_hash, payload, state) VALUES ($1,$2,$3,$4,1,$5,$6,'{}','queued')", [orgId, commandId, taskId, principalId, kind, 'a'.repeat(64)]);
        await tx.query("INSERT INTO factory.outbox (org_id, id, kind, aggregate_id, dedupe_key, payload, state) VALUES ($1,$2,'task.command',$3,$4,$5,'pending')", [orgId, randomUUID(), taskId, `command:${commandId}`, JSON.stringify({ workflowId, commandId, kind, rollover })]);
      });
      return commandId;
    }
    const commandRow = (id: string) => db.withTenant({ orgId }, async (tx) => (await tx.query<{ state: string; rejection_reason: string | null }>('SELECT state, rejection_reason FROM factory.command WHERE id = $1', [id])).rows[0]);
    const effects = (workflowId: string) => env.client.workflow.getHandle(workflowId).query<number>('effects');

    it('a lost Update reply leaves the command delivered (never rejected) and re-invoking the same command ID applies it once', async () => {
      const { workflowId } = await newTask();
      await dispatcher().runOnce();
      const commandId = await command(workflowId.split('/')[2] ?? '', workflowId, 'pause');
      const lossy: TemporalGateway = { start: (r) => gateway.start(r), describe: (id) => gateway.describe(id), update: async (id, u, a) => { await gateway.update(id, u, a); throw Object.assign(new Error('update timed out'), { code: 4 }); } };
      expect((await dispatcher({ temporal: lossy }).runOnce()).find((o) => o.kind === 'task.command')?.result).toBe('retry');
      expect(await commandRow(commandId)).toEqual({ state: 'delivered', rejection_reason: null });
      expect((await dispatcher({ clockOffsetMs: () => 2000 }).runOnce()).find((o) => o.kind === 'task.command')?.result).toBe('delivered');
      expect(await commandRow(commandId)).toEqual({ state: 'applied', rejection_reason: null });
      expect(await effects(workflowId)).toBe(1);
    });

    it('redelivery after Continue-As-New is answered by the carried receipt, not applied again', async () => {
      const { workflowId } = await newTask();
      await dispatcher().runOnce();
      const taskId = workflowId.split('/')[2] ?? '';
      const first = await command(taskId, workflowId, 'amend_spec', true); // the workflow rolls over after applying it
      await dispatcher().runOnce();
      expect((await commandRow(first))?.state).toBe('applied');
      await new Promise((r) => setTimeout(r, 300));
      const desc = await gateway.describe(workflowId);
      expect((await runs(workflowId)).length).toBe(2); // a new run after Continue-As-New
      // Deliver the same command ID again into the new run (e.g. an at-least-once redelivery).
      await db.withTenant({ orgId }, (tx) => tx.query("INSERT INTO factory.outbox (org_id, id, kind, aggregate_id, dedupe_key, payload, state) VALUES ($1,$2,'task.command',$3,$4,$5,'pending')",
        [orgId, randomUUID(), taskId, `command:${first}:redelivery`, JSON.stringify({ workflowId, commandId: first, kind: 'amend_spec' })]));
      await dispatcher().runOnce();
      expect(await effects(workflowId)).toBe(1);
      expect((await gateway.describe(workflowId))?.runId).toBe(desc?.runId);
    });

    it('a command for a closed task workflow is rejected without blocking delivery of others', async () => {
      const { workflowId } = await newTask();
      await dispatcher().runOnce();
      await env.client.workflow.getHandle(workflowId).signal('finish');
      await env.client.workflow.getHandle(workflowId).result();
      const late = await command(workflowId.split('/')[2] ?? '', workflowId, 'pause');
      await dispatcher().runOnce();
      expect(await commandRow(late)).toEqual({ state: 'rejected', rejection_reason: 'task workflow is completed' });
    });

    it('a command that may have applied before its reply was lost is not relabelled rejected when the workflow has since closed', async () => {
      const { workflowId } = await newTask();
      await dispatcher().runOnce();
      const commandId = await command(workflowId.split('/')[2] ?? '', workflowId, 'pause');
      const lossy: TemporalGateway = { start: (r) => gateway.start(r), describe: (id) => gateway.describe(id), update: async (id, u, a) => { await gateway.update(id, u, a); throw Object.assign(new Error('update timed out'), { code: 4 }); } };
      await dispatcher({ temporal: lossy }).runOnce();
      expect((await commandRow(commandId))?.state).toBe('delivered');
      expect(await effects(workflowId)).toBe(1); // it did apply
      await env.client.workflow.getHandle(workflowId).signal('finish');
      await env.client.workflow.getHandle(workflowId).result();
      expect((await dispatcher({ clockOffsetMs: () => 2000 }).runOnce()).find((o) => o.kind === 'task.command')?.result).toBe('delivered');
      expect(await commandRow(commandId)).toEqual({ state: 'delivered', rejection_reason: 'outcome unknown: task workflow is completed and the delivery reply was lost' });
    });

    it('a workflow rejection is recorded with its reason', async () => {
      const { workflowId } = await newTask();
      await dispatcher().runOnce();
      const commandId = await command(workflowId.split('/')[2] ?? '', workflowId, 'reject_me');
      await dispatcher().runOnce();
      expect(await commandRow(commandId)).toEqual({ state: 'rejected', rejection_reason: 'stale subject' });
    });
  });
});
