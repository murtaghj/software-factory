import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { validateContract } from '@factory/contracts';
import { createApiHarness, type ApiHarness, type User } from './harness.ts';
import { taskRequest } from './task-fixtures.ts';

describe('task intake idempotency', () => {
  let h: ApiHarness;
  let alice: User;
  beforeAll(async () => {
    h = await createApiHarness('ac010203');
    alice = await h.user(h.a, [{ role: 'contributor', scope: [h.a.applicationId] }]);
  });
  afterAll(async () => { await h.close(); });

  const post = async (key: string | undefined, body: unknown, app = h.app) => app.inject({ method: 'POST', url: '/v2/tasks', headers: { authorization: `Bearer ${await alice.token()}`, 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) }, payload: body as Record<string, unknown> });
  const counts = () => h.tx(h.a, async (t) => {
    const n = async (sql: string) => Number((await t.query<{ n: string }>(sql)).rows[0]?.n);
    return { tasks: await n('SELECT count(*) AS n FROM factory.task'), outbox: await n("SELECT count(*) AS n FROM factory.outbox WHERE kind = 'task.launch'"), records: await n('SELECT count(*) AS n FROM factory.idempotency_record'), specs: await n('SELECT count(*) AS n FROM factory.task_spec_version'), events: await n('SELECT count(*) AS n FROM factory.task_event') };
  });

  describe('AC-01 duplicate task submission', () => {
    it('a retry after a lost response returns the same task identity and creates nothing new', async () => {
      const before = await counts();
      const first = await post('key-retry', taskRequest(h.a.applicationId));
      expect(first.statusCode).toBe(202);
      expect(validateContract('TaskAccepted', first.json()).ok).toBe(true);
      const retry = await post('key-retry', taskRequest(h.a.applicationId));
      expect(retry.statusCode).toBe(202);
      expect(retry.json()).toEqual(first.json());
      expect(await counts()).toEqual({ tasks: before.tasks + 1, outbox: before.outbox + 1, records: before.records + 1, specs: before.specs + 1, events: before.events + 1 });
    });

    it('racing duplicates with the same key and body yield one task and one launch, and every caller gets its identity', async () => {
      const before = await counts();
      const body = taskRequest(h.a.applicationId, { title: 'Racing duplicate' });
      const responses = await Promise.all(Array.from({ length: 12 }, () => post('key-race', body)));
      expect(responses.map((r) => r.statusCode)).toEqual(Array(12).fill(202));
      const ids = new Set(responses.map((r) => r.json<{ taskId: string }>().taskId));
      expect(ids.size).toBe(1);
      const after = await counts();
      expect(after.tasks - before.tasks).toBe(1);
      expect(after.outbox - before.outbox).toBe(1);
      const [taskId] = [...ids];
      const launches = await h.tx(h.a, (t) => t.query<{ payload: { workflowId: string } }>("SELECT payload FROM factory.outbox WHERE kind = 'task.launch' AND aggregate_id = $1", [taskId]));
      expect(launches.rows.map((r) => r.payload.workflowId)).toEqual([`factory/${h.a.orgId}/${String(taskId)}`]);
    });

    it('the key is scoped to the principal: another principal using the same key creates its own task', async () => {
      const bob = await h.user(h.a, [{ role: 'contributor', scope: [h.a.applicationId] }]);
      const a1 = await post('shared-key', taskRequest(h.a.applicationId));
      const b1 = await h.app.inject({ method: 'POST', url: '/v2/tasks', headers: { authorization: `Bearer ${await bob.token()}`, 'content-type': 'application/json', 'idempotency-key': 'shared-key' }, payload: taskRequest(h.a.applicationId) as unknown as Record<string, unknown> });
      expect(b1.statusCode).toBe(202);
      expect(b1.json<{ taskId: string }>().taskId).not.toBe(a1.json<{ taskId: string }>().taskId);
    });
  });

  describe('AC-02 conflicting idempotency payload', () => {
    it('reusing a key with a changed body returns 409 and causes no second side effect', async () => {
      const first = await post('key-conflict', taskRequest(h.a.applicationId));
      expect(first.statusCode).toBe(202);
      const before = await counts();
      const changed = await post('key-conflict', taskRequest(h.a.applicationId, { title: 'Something else entirely' }));
      expect(changed.statusCode).toBe(409);
      expect(changed.json()).toMatchObject({ code: 'idempotency_conflict', retryable: false });
      expect(await counts()).toEqual(before);
      const again = await post('key-conflict', taskRequest(h.a.applicationId));
      expect(again.json()).toEqual(first.json()); // the original remains retrievable
    });

    it('racing different bodies under one key: exactly one wins, the rest get 409', async () => {
      const before = await counts();
      const responses = await Promise.all(Array.from({ length: 8 }, (_, i) => post('key-race-conflict', taskRequest(h.a.applicationId, { title: `variant ${String(i)}` }))));
      const statuses = responses.map((r) => r.statusCode).sort();
      expect(statuses).toEqual([202, 409, 409, 409, 409, 409, 409, 409]);
      const after = await counts();
      expect(after.tasks - before.tasks).toBe(1);
      expect(after.outbox - before.outbox).toBe(1);
    });

    it('semantically identical bodies with different key order are the same request', async () => {
      const body = taskRequest(h.a.applicationId, { title: 'Key order' });
      const reordered = Object.fromEntries(Object.entries(body).reverse());
      const first = await post('key-order', body);
      const second = await post('key-order', reordered);
      expect(second.statusCode).toBe(202);
      expect(second.json()).toEqual(first.json());
    });
  });

  describe('AC-03 launch crash recovery (intake half: task and launch outbox commit together)', () => {
    it('a crash between the task insert and the outbox leaves nothing behind; the retry creates exactly one task with its launch', async () => {
      const crashing = await h.appWith({ hooks: { beforeOutbox: () => Promise.reject(new Error('process killed')) } });
      const before = await counts();
      const crashed = await post('key-crash', taskRequest(h.a.applicationId, { title: 'Crash during intake' }), crashing);
      expect(crashed.statusCode).toBe(500);
      expect(await counts()).toEqual(before); // no task, no spec, no event, no outbox, no idempotency record
      const retry = await post('key-crash', taskRequest(h.a.applicationId, { title: 'Crash during intake' }));
      expect(retry.statusCode).toBe(202);
      const taskId = retry.json<{ taskId: string }>().taskId;
      const after = await counts();
      expect(after.tasks - before.tasks).toBe(1);
      const outbox = await h.tx(h.a, (t) => t.query<{ state: string; dedupe_key: string; payload: { workflowId: string; specVersion: number } }>('SELECT state, dedupe_key, payload FROM factory.outbox WHERE aggregate_id = $1', [taskId]));
      expect(outbox.rows).toEqual([{ state: 'pending', dedupe_key: `launch:${taskId}`, payload: expect.objectContaining({ workflowId: `factory/${h.a.orgId}/${taskId}`, specVersion: 1 }) as unknown }]);
    });
  });
});
