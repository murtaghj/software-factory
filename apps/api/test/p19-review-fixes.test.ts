import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { appendTaskEvent } from '@factory/database';
import type { DecisionPage } from '@factory/contracts';
import { createApiHarness, type ApiHarness, type User } from './harness.ts';
import { taskRequest } from './task-fixtures.ts';
import { streamTaskEvents } from '../src/events/sse.ts';
import { CommandService, OidcVerifier, buildApi } from '../src/index.ts';

// P-19: dedicated tests for review fixes that had none. Each test fails when its fix is reverted.
describe('P-19 review fixes in the API', () => {
  let h: ApiHarness;
  let alice: User;
  beforeAll(async () => {
    h = await createApiHarness('p19');
    alice = await h.user(h.a, [{ role: 'contributor', scope: [h.a.applicationId] }]);
  });
  afterAll(async () => { await h.close(); });

  const authz = async (u: User) => ({ authorization: `Bearer ${await u.token()}` });
  const createTask = async (u: User, applicationId: string): Promise<string> => {
    const r = await h.app.inject({ method: 'POST', url: '/v2/tasks', headers: { ...(await authz(u)), 'content-type': 'application/json', 'idempotency-key': randomUUID() }, payload: taskRequest(applicationId) as unknown as Record<string, unknown> });
    return r.json<{ taskId: string }>().taskId;
  };

  // The event stream used to wait for 'drain' forever when a client disconnected with the socket
  // buffer full. The socket is simulated: write() reports a full buffer and never drains.
  it('the event stream ends when the client disconnects while the write buffer is full', async () => {
    const taskId = await createTask(alice, h.a.applicationId);
    const payloadRef = { artifactId: randomUUID(), sha256: 'a'.repeat(64), mediaType: 'application/json', schemaVersion: '2.0', sizeBytes: 1 };
    for (let i = 0; i < 3; i += 1) await h.tx(h.a, (t) => appendTaskEvent(t, { orgId: h.a.orgId, taskId, eventType: 'stage.progress', source: 'runner', payloadRef, correlationId: 'c', producerEventId: `p-${String(i)}` }));
    const rawRequest = new EventEmitter();
    const res = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false, writes: 0, ended: false });
    const raw = Object.assign(res, {
      writeHead: () => raw,
      write: () => { res.writes += 1; return false; }, // buffer full: the caller must wait for drain or close
      end: () => { res.ended = true; res.writableEnded = true; },
    });
    const req = { params: { taskId }, query: {}, headers: {}, id: 'p19-sse', raw: rawRequest } as unknown as FastifyRequest<{ Params: { taskId: string }; Querystring: { after?: string } }>;
    const reply = { hijack: () => { /* the stream owns the socket */ }, raw } as unknown as FastifyReply;
    const principal = { orgId: h.a.orgId, principalId: alice.principalId, issuer: h.a.issuer.issuer, subject: alice.subject, groups: [], grants: [] };
    const streaming = streamTaskEvents(req, reply, { db: h.db, principal, canRead: () => Promise.resolve(true), options: { retentionMs: 3_600_000, pollMs: 10 } });
    const start = Date.now();
    while (res.writes === 0 && Date.now() - start < 5000) await new Promise((r) => setTimeout(r, 10));
    expect(res.writes).toBe(1); // blocked on the first write, waiting for a drain that will never come
    res.destroyed = true; // the client goes away
    res.emit('close');
    rawRequest.emit('close');
    const outcome = await Promise.race([streaming.then(() => 'ended'), new Promise<string>((r) => { setTimeout(() => { r('hung'); }, 3000); })]);
    expect(outcome).toBe('ended');
    expect(res.ended).toBe(true);
    expect(res.writes).toBe(1);
  });

  // The cursor carries the creation time to the microsecond. Tasks created within one millisecond
  // share a millisecond-rounded time, so a cursor rounded to milliseconds skips or repeats them.
  it('task-list paging is exact for tasks created within the same millisecond', async () => {
    const lister = await h.user(h.a, [{ role: 'contributor', scope: [h.a.applicationId] }]);
    const ids: string[] = [];
    await h.tx(h.a, async (t) => {
      for (let i = 0; i < 7; i += 1) {
        const id = randomUUID();
        ids.push(id);
        // 2031-05-05T10:00:00.000100Z, .000200Z, ...: one millisecond, distinct microseconds.
        await t.query("INSERT INTO factory.task (org_id, id, creator_id, primary_application_id, target_kind, target_context, work_type, change_class, delivery_scope, status, created_at) VALUES ($1,$2,$3,$4,'existing_application',$5,'feature','feature','pr','running',$6::timestamptz)",
          [h.a.orgId, id, lister.principalId, h.a.applicationId, JSON.stringify({ kind: 'existing_application', applicationId: h.a.applicationId }), `2031-05-05T10:00:00.${String((i + 1) * 100).padStart(6, '0')}Z`]);
        await t.query("INSERT INTO factory.task_spec_version (org_id, id, task_id, version, spec, spec_hash, actor_id) VALUES ($1,$2,$3,1,$4,$5,$6)", [h.a.orgId, randomUUID(), id, JSON.stringify(taskRequest(h.a.applicationId)), 'a'.repeat(64), lister.principalId]);
      }
    });
    for (const limit of [1, 2, 3]) {
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await h.app.inject({ method: 'GET', url: `/v2/tasks?limit=${String(limit)}&creatorId=${lister.principalId}${cursor ? `&cursor=${cursor}` : ''}`, headers: await authz(lister) });
        expect(page.statusCode).toBe(200);
        const body = page.json<{ items: Array<{ id: string }>; nextCursor?: string }>();
        seen.push(...body.items.map((x) => x.id));
        cursor = body.nextCursor;
      } while (cursor);
      expect(seen, `limit ${String(limit)}`).toEqual([...ids].reverse()); // newest first, none skipped, none repeated
    }
  });

  // Decisions list newest first, and a caller who cannot read a task never has its decisions count
  // against the page: 205 newer decisions on a task the caller cannot read must not hide the
  // caller's own three.
  it('the decision listing is newest-first and applies authorization before the limit', async () => {
    const reader = await h.user(h.a, [{ role: 'viewer', scope: [h.a.applicationId] }]);
    const other = await h.user(h.a, [{ role: 'contributor', scope: [h.a.otherApplicationId] }]);
    const readableTask = await createTask(alice, h.a.applicationId);
    const hiddenTask = await createTask(other, h.a.otherApplicationId);
    const readable = [randomUUID(), randomUUID(), randomUUID()];
    await h.tx(h.a, async (t) => {
      for (const [i, id] of readable.entries()) {
        await t.query("INSERT INTO factory.decision_request (org_id, id, task_id, action, subject_hash, subject_ref, policy_ref, evidence_refs, eligible_roles, required_principal_id, state, expires_at, reason, created_at) VALUES ($1,$2,$3,'approve_plan',$4,'{}','{}','[]','[\"reviewer\"]',$5,'pending',now() + interval '1 day','readable',$6::timestamptz)",
          [h.a.orgId, id, readableTask, String(i).padStart(64, 'b'), alice.principalId, `2031-01-01T00:0${String(i + 1)}:00Z`]);
      }
      await t.query("INSERT INTO factory.decision_request (org_id, id, task_id, action, subject_hash, subject_ref, policy_ref, evidence_refs, eligible_roles, state, expires_at, reason, created_at) SELECT $1, gen_random_uuid(), $2, 'reconcile_pr_head', lpad(n::text, 64, 'c'), '{}', '{}', '[]', '[\"reviewer\"]', 'pending', now() + interval '1 day', 'hidden', '2032-01-01T00:00:00Z'::timestamptz + n * interval '1 second' FROM generate_series(1, 205) AS n",
        [h.a.orgId, hiddenTask]);
    });
    const verifier = new OidcVerifier([{ issuer: h.a.issuer.issuer, audience: 'software-factory-api', jwksUrl: h.a.issuer.jwksUrl, orgId: h.a.orgId }]);
    const api = buildApi({ db: h.db, verifier, artifacts: h.artifacts, tasks: h.tasks, commands: new CommandService({ db: h.db, artifacts: h.artifacts }), dashboardOrigin: 'http://localhost:4173' });
    try {
      const res = await api.inject({ method: 'GET', url: '/v2/decisions', headers: await authz(reader) });
      expect(res.statusCode).toBe(200);
      const page = res.json<DecisionPage>();
      expect(page.items.map((d) => d.id)).toEqual([...readable].reverse());
      expect(page.items.every((d) => d.taskId === readableTask)).toBe(true);
    } finally {
      await api.close();
    }
  });
});
