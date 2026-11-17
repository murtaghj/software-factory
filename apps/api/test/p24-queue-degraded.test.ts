// P-24 (docs/plan-additions.md): the queue keeps answering when a source fails. Each source runs in
// its own SAVEPOINT, a slow source times out, a source cannot smuggle in an item for a project the
// caller cannot read, organizations stay apart, and no error text reaches the caller.
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createApiHarness, AUDIENCE, DASHBOARD_ORIGIN, type ApiHarness, type Org, type User } from './harness.ts';
import { OidcVerifier, QueueService, buildApi, factoryAdapters, type Queue, type QueueAdapter, type QueueCandidate } from '../src/index.ts';

describe('P-24 queue sources fail one at a time', () => {
  let h: ApiHarness;
  let alice: User; // reviewer on Orders; a decision on bob's task waits on her
  let bob: User;
  let carol: User; // second organization
  let decisionId: string;
  const logged: Array<{ sourceId: string; requestId?: string }> = [];
  const throws: QueueAdapter = { id: 'test.throws', kind: 'factory', collect: () => Promise.reject(new Error('secret table detail')) };
  const badSql: QueueAdapter = { id: 'test.sql', kind: 'factory', collect: async (ctx) => { await ctx.tx.query('SELECT 1/0'); return { items: [], truncated: false }; } };
  const slow: QueueAdapter = { id: 'test.slow', kind: 'factory', collect: async (ctx) => { await ctx.tx.query('SELECT pg_sleep(5)'); return { items: [], truncated: false }; } };
  const leak = (applicationId: string): QueueAdapter => ({ id: 'test.leak', kind: 'factory', collect: () => Promise.resolve({ truncated: false, items: [{
    need: 'finished', dismissible: true, priority: 'normal', since: '2026-11-01T00:00:00Z', subject: { kind: 'task', id: 'x', title: 'Secret', applicationId },
    reason: { code: 'task_finished' }, action: { kind: 'open_task', taskId: 'x' },
  } satisfies QueueCandidate] }) });

  beforeAll(async () => {
    h = await createApiHarness('p24deg');
    alice = await h.user(h.a, [{ role: 'reviewer', scope: [h.a.applicationId] }]);
    bob = await h.user(h.a, [{ role: 'contributor', scope: [h.a.applicationId] }]);
    carol = await h.user(h.b, [{ role: 'reviewer', scope: [h.b.applicationId] }]);
    decisionId = await decisionFor(h.a, bob, alice, h.a.applicationId);
    await decisionFor(h.b, carol, carol, h.b.applicationId);
  }, 120_000);
  afterAll(async () => { await h.close(); });

  async function decisionFor(org: Org, creator: User, reviewer: User, applicationId: string): Promise<string> {
    const { taskId } = await h.task(org, creator, applicationId);
    const id = randomUUID();
    await h.tx(org, (t) => t.query(`INSERT INTO factory.decision_request (org_id, id, task_id, action, subject_hash, subject_ref, policy_ref, evidence_refs, eligible_roles, required_principal_id, state, expires_at, reason)
      VALUES ($1,$2,$3,'approve_plan',$4,'{}','{}','[]','["reviewer"]',$5,'pending',now() + interval '1 day','Approve the plan')`, [org.orgId, id, taskId, 'c'.repeat(64), reviewer.principalId]));
    return id;
  }
  const verifier = () => new OidcVerifier([h.a, h.b].map((o) => ({ issuer: o.issuer.issuer, audience: AUDIENCE, jwksUrl: o.issuer.jwksUrl, orgId: o.orgId })));
  async function queueFor(user: User, adapters: QueueAdapter[], adapterTimeoutMs = 2000): Promise<{ status: number; text: string; queue: Queue }> {
    const app = buildApi({ db: h.db, verifier: verifier(), artifacts: h.artifacts, tasks: h.tasks, queue: new QueueService({ db: h.db, adapters, adapterTimeoutMs, log: (e) => { logged.push({ sourceId: e.sourceId, ...(e.requestId ? { requestId: e.requestId } : {}) }); } }), dashboardOrigin: DASHBOARD_ORIGIN });
    try {
      const res = await app.inject({ method: 'GET', url: '/v2/me/queue', headers: { authorization: `Bearer ${await user.token()}` } });
      return { status: res.statusCode, text: res.body, queue: res.json<Queue>() };
    } finally { await app.close(); }
  }
  async function ackFor(user: User, adapters: QueueAdapter[], key: string): Promise<{ status: number; text: string }> {
    const app = buildApi({ db: h.db, verifier: verifier(), artifacts: h.artifacts, tasks: h.tasks, queue: new QueueService({ db: h.db, adapters, log: () => undefined }), dashboardOrigin: DASHBOARD_ORIGIN });
    try {
      const res = await app.inject({ method: 'POST', url: '/v2/me/queue/acks', headers: { authorization: `Bearer ${await user.token()}` }, payload: { key } });
      return { status: res.statusCode, text: res.body };
    } finally { await app.close(); }
  }
  const status = (q: Queue, id: string) => q.sources.find((s) => s.id === id);

  it('a source that throws is reported as failed and the others still answer', async () => {
    logged.length = 0;
    const r = await queueFor(alice, [throws, ...factoryAdapters()]);
    expect(r.status).toBe(200);
    expect(r.queue.items.map((i) => i.key)).toEqual([`decision:${decisionId}:answer_needed`]);
    expect(status(r.queue, 'test.throws')).toMatchObject({ status: 'degraded', problem: 'failed' });
    expect(status(r.queue, 'factory.decisions')).toMatchObject({ status: 'ok', items: 1 });
    expect(r.queue.degraded).toBe(true);
    expect(logged).toEqual([{ sourceId: 'test.throws', requestId: expect.any(String) as string }]); // logged with the request ID
  });

  it('a failed SQL statement does not poison the transaction: later sources still run (the savepoint)', async () => {
    const r = await queueFor(alice, [badSql, ...factoryAdapters()]);
    expect(status(r.queue, 'test.sql')).toMatchObject({ status: 'degraded', problem: 'failed' });
    expect(r.queue.items).toHaveLength(1);
    expect(r.queue.sources.filter((s) => s.status === 'ok').map((s) => s.id)).toEqual(['factory.decisions', 'factory.tasks', 'factory.budget']);
  });

  it('a source that takes too long times out and the others stay intact', async () => {
    // The timeout applies to every source, so it must leave the real ones room under a loaded suite.
    const r = await queueFor(alice, [slow, ...factoryAdapters()], 1500);
    expect(status(r.queue, 'test.slow')).toMatchObject({ status: 'degraded', problem: 'timed_out' });
    expect(r.queue.items).toHaveLength(1);
  });

  it('an item for a project the caller cannot read is dropped and the source flagged', async () => {
    const r = await queueFor(alice, [leak(h.a.otherApplicationId), ...factoryAdapters()]);
    expect(status(r.queue, 'test.leak')).toMatchObject({ status: 'degraded', problem: 'invalid_items', items: 0 });
    expect(r.text).not.toContain('Secret');
    expect(r.queue.items).toHaveLength(1);
  });

  it('with every source broken the answer is still 200, empty, and says it could not check', async () => {
    const r = await queueFor(alice, [throws, badSql, slow], 200);
    expect(r.status).toBe(200);
    expect(r.queue).toMatchObject({ items: [], degraded: true });
    expect(r.queue.sources.map((s) => s.status)).toEqual(['degraded', 'degraded', 'degraded']);
  });

  it('another organization sees none of this one\'s items, and the reverse', async () => {
    const theirs = await queueFor(carol, factoryAdapters());
    expect(theirs.queue.items).toHaveLength(1);
    expect(theirs.queue.items.map((i) => i.key)).not.toContain(`decision:${decisionId}:answer_needed`);
    expect(theirs.queue.degraded).toBe(false);
    // Bob created the task but is not asked: his only item is the request about to expire on his own task.
    expect((await queueFor(bob, factoryAdapters())).queue.items.map((i) => i.reason.code)).toEqual(['review_expiring']);
  });

  it('no error text or SQL reaches the response', async () => {
    const r = await queueFor(alice, [throws, badSql, ...factoryAdapters()]);
    for (const word of ['secret', 'division', 'SELECT', '1/0', 'pg_']) expect(r.text.toLowerCase()).not.toContain(word.toLowerCase());
  });

  it('the endpoint answers 503 when no queue is configured and 401 without sign-in', async () => {
    const app = buildApi({ db: h.db, verifier: verifier(), artifacts: h.artifacts, tasks: h.tasks, dashboardOrigin: DASHBOARD_ORIGIN });
    try {
      const auth = { authorization: `Bearer ${await alice.token()}` };
      expect((await app.inject({ method: 'GET', url: '/v2/me/queue', headers: auth })).statusCode).toBe(503); // no queue configured
      expect((await app.inject({ method: 'GET', url: '/v2/me/queue' })).statusCode).toBe(401);
    } finally { await app.close(); }
  });

  it('an adapter that rejects with something that is not an Error leaves that source failed and the answer 200', async () => {
    for (const reason of [undefined, null, 'just a string', 42]) {
      const odd: QueueAdapter = { id: 'test.odd', kind: 'factory', // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the point of the test: adapters may reject with anything
        collect: () => Promise.reject(reason) };
      const r = await queueFor(alice, [odd, ...factoryAdapters()]);
      expect(r.status, String(reason)).toBe(200);
      expect(status(r.queue, 'test.odd')).toMatchObject({ status: 'degraded', problem: 'failed' });
      expect(r.queue.items).toHaveLength(1);
    }
  });

  it('a source that never answers is timed out by the clock, not only by the database, and its late queries are refused', async () => {
    let late: string | undefined;
    const hung: QueueAdapter = { id: 'test.hung', kind: 'factory', collect: async (ctx) => {
      await new Promise((resolve) => setTimeout(resolve, 400)); // far past the 200 ms limit
      try { await ctx.tx.query('SELECT 1'); late = 'ran'; } catch (e) { late = e instanceof Error ? e.message : 'refused'; }
      return { items: [], truncated: false };
    } };
    const r = await queueFor(alice, [hung, ...factoryAdapters()], 200);
    expect(r.status).toBe(200);
    expect(status(r.queue, 'test.hung')).toMatchObject({ status: 'degraded', problem: 'timed_out' });
    expect(r.queue.items).toHaveLength(1); // later sources were not disturbed
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(late).toBe('this source has finished');
    const never: QueueAdapter = { id: 'test.never', kind: 'factory', collect: () => new Promise(() => undefined) };
    expect(status((await queueFor(alice, [never, ...factoryAdapters()], 200)).queue, 'test.never')).toMatchObject({ problem: 'timed_out' });
  });

  it('an adapter that returns something that is not a result is reported invalid and the answer stays 200', async () => {
    for (const value of [undefined, null, 'text', { items: 'no', truncated: false }, { items: [] }]) {
      const bad: QueueAdapter = { id: 'test.bad', kind: 'factory', collect: () => Promise.resolve(value as never) };
      const r = await queueFor(alice, [bad, ...factoryAdapters()]);
      expect(r.status, JSON.stringify(value)).toBe(200);
      expect(status(r.queue, 'test.bad')).toMatchObject({ status: 'degraded', problem: 'invalid_items', items: 0 });
      expect(r.queue.items).toHaveLength(1);
    }
  });

  it('a late query from an abandoned adapter is refused whether it uses a promise, a callback or is never awaited', async () => {
    const outcome: { callback?: string; callbackReturn?: unknown } = {};
    const abandoned: QueueAdapter = { id: 'test.abandoned', kind: 'factory', collect: async (ctx) => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      void (ctx.tx.query as (sql: string) => Promise<unknown>)('SELECT 1'); // never awaited: must not become an unhandled rejection
      outcome.callbackReturn = (ctx.tx.query as unknown as (sql: string, cb: (e: Error | null) => void) => unknown)('SELECT 1', (e) => { outcome.callback = e?.message ?? 'ran'; });
      return { items: [], truncated: false };
    } };
    const r = await queueFor(alice, [abandoned, ...factoryAdapters()], 200);
    expect(status(r.queue, 'test.abandoned')).toMatchObject({ problem: 'timed_out' });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(outcome).toEqual({ callback: 'this source has finished', callbackReturn: undefined });
  });

  it('the ack endpoint says 503, not 404, while a source could not be read (the item may be hidden)', async () => {
    const missing = `task:${randomUUID()}:task_finished`;
    expect((await ackFor(alice, factoryAdapters(), missing)).status).toBe(404);
    expect((await ackFor(alice, [throws, ...factoryAdapters()], missing)).status).toBe(503);
  });

  it('when the acknowledgement lookup fails the list is degraded even though every source answered', async () => {
    const dismissible: QueueAdapter = { id: 'test.dismissible', kind: 'factory', collect: () => Promise.resolve({ truncated: false, items: [{
      need: 'finished', dismissible: true, priority: 'normal', since: '2026-11-01T00:00:00Z', subject: { kind: 'task', id: 'x', title: 'Done', taskId: '3f2c1b9e-8d4a-4f6e-9a1b-2c3d4e5f6a7b', applicationId: h.a.applicationId },
      reason: { code: 'task_finished' }, action: { kind: 'open_task', taskId: '3f2c1b9e-8d4a-4f6e-9a1b-2c3d4e5f6a7b' },
    } satisfies QueueCandidate] }) };
    const migrator = new pg.Client({ connectionString: h.m.migratorUrl });
    await migrator.connect();
    await migrator.query('SET ROLE factory_migrator');
    await migrator.query('ALTER TABLE factory.queue_ack RENAME TO queue_ack_away');
    try {
      const r = await queueFor(alice, [dismissible]);
      expect(r.status).toBe(200);
      expect(r.queue.sources.map((s) => s.status)).toEqual(['ok']);
      expect(r.queue.degraded).toBe(true);
      expect(r.queue.items).toHaveLength(1); // still shown, with the warning
    } finally {
      await migrator.query('ALTER TABLE factory.queue_ack_away RENAME TO queue_ack');
      await migrator.end();
    }
  });
});
