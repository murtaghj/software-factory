// P-24 review fixes (docs/plan-additions.md): caps cannot hide a fresh failure, a "seen" allowance
// notice returns when the limit is raised and used up again, a GET never writes, and incidents
// survive a source cap.
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApiHarness, AUDIENCE, DASHBOARD_ORIGIN, type ApiHarness, type Org, type User } from './harness.ts';
import { OidcVerifier, QueueService, buildApi, factoryAdapters, type Queue } from '../src/index.ts';

describe('P-24 review fixes', () => {
  let h: ApiHarness;
  beforeAll(async () => { h = await createApiHarness('p24rev'); }, 120_000);
  afterAll(async () => { await h.close(); });

  const verifier = () => new OidcVerifier([h.a, h.b].map((o) => ({ issuer: o.issuer.issuer, audience: AUDIENCE, jwksUrl: o.issuer.jwksUrl, orgId: o.orgId })));
  async function call(user: User, o: { method?: 'GET' | 'POST'; url?: string; payload?: object; cap?: number; now?: Date } = {}): Promise<{ status: number; queue: Queue }> {
    const queue = new QueueService({ db: h.db, adapters: factoryAdapters(), log: () => undefined, ...(o.cap ? { perSourceCap: o.cap } : {}), ...(o.now ? { now: () => o.now as Date } : {}) });
    const app = buildApi({ db: h.db, verifier: verifier(), artifacts: h.artifacts, tasks: h.tasks, queue, dashboardOrigin: DASHBOARD_ORIGIN });
    try {
      const res = await app.inject({ method: o.method ?? 'GET', url: o.url ?? '/v2/me/queue', headers: { authorization: `Bearer ${await user.token()}` }, ...(o.payload ? { payload: o.payload } : {}) });
      return { status: res.statusCode, queue: (res.body ? JSON.parse(res.body) : {}) as Queue };
    } finally { await app.close(); }
  }
  const ack = (user: User, key: string) => call(user, { method: 'POST', url: '/v2/me/queue/acks', payload: { key } });
  const taskIn = async (org: Org, user: User, status: string, updated: string): Promise<string> => {
    const { taskId } = await h.task(org, user);
    await h.tx(org, (t) => t.query(`UPDATE factory.task SET status = $2, updated_at = ${updated} WHERE id = $1`, [taskId, status]));
    return taskId;
  };

  it('a fresh failure is not pushed out by 100 old successes, and acknowledging them does not empty the list', async () => {
    const dana = await h.user(h.a, [{ role: 'contributor', scope: [h.a.applicationId] }]);
    const old: string[] = [];
    for (let i = 0; i < 101; i += 1) old.push(await taskIn(h.a, dana, 'succeeded', `now() - interval '10 days' + interval '${String(i)} seconds'`));
    const failed = await taskIn(h.a, dana, 'failed', "now() - interval '1 hour'");
    const q = (await call(dana)).queue;
    expect(q.items[0]).toMatchObject({ tier: 3, key: `task:${failed}:task_stopped` });
    expect(q.truncated).toBe(true); // 101 finished tasks exceed the cap of 100
    expect(q.items.filter((i) => i.tier === 4)).toHaveLength(99); // 100 in the queue cap, minus the failure
    // Mark every visible finished item as seen, round after round: the oldest one (never shown) comes into view, the failure stays.
    for (let round = 0; round < 3; round += 1) {
      const shown = (await call(dana)).queue;
      for (const i of shown.items.filter((x) => x.dismissible && x.tier === 4)) expect((await ack(dana, i.key)).status).toBe(204);
    }
    const after = (await call(dana)).queue;
    expect(after.items.map((i) => i.key)).toEqual([`task:${failed}:task_stopped`]);
    expect(after.truncated).toBe(false);
    expect(old).toHaveLength(101);
  }, 300_000);

  it('each cap keeps the newest stopped task, and finished tasks have their own cap', async () => {
    const eve = await h.user(h.a, [{ role: 'contributor', scope: [h.a.applicationId] }]);
    const a = await taskIn(h.a, eve, 'incomplete', "now() - interval '3 days'");
    const b = await taskIn(h.a, eve, 'incomplete', "now() - interval '1 day'");
    for (let i = 0; i < 3; i += 1) await taskIn(h.a, eve, 'succeeded', "now() - interval '2 days'");
    const q = (await call(eve, { cap: 2 })).queue;
    expect(q.items.filter((i) => i.tier === 3).map((i) => i.subject.id)).toEqual([a, b]); // shown longest-waiting first
    expect(q.items.filter((i) => i.tier === 4)).toHaveLength(2);
    const one = (await call(eve, { cap: 1 })).queue; // a cap of one keeps the newest, not the oldest
    expect(one.items.filter((i) => i.tier === 3).map((i) => i.subject.id)).toEqual([b]);
    expect(q.truncated).toBe(true);
  });

  it('incident-priority items survive a source cap', async () => {
    const fay = await h.user(h.a, [{ role: 'contributor', scope: [h.a.applicationId] }]);
    const quiet = await taskIn(h.a, fay, 'failed', "now() - interval '1 hour'");
    const quiet2 = await taskIn(h.a, fay, 'failed', "now() - interval '2 hours'");
    const incident = await taskIn(h.a, fay, 'failed', "now() - interval '9 days'");
    await h.tx(h.a, (t) => t.query("UPDATE factory.task SET priority_class = 'incident' WHERE id = $1", [incident]));
    const q = (await call(fay, { cap: 2 })).queue;
    expect(q.items.map((i) => i.subject.id)).toContain(incident);
    expect(q.items[0]?.subject.id).toBe(incident);
    expect([quiet, quiet2]).toHaveLength(2);
  });

  it('a "seen" allowance notice comes back when the limit is raised and used up again; a GET never writes', async () => {
    const gil = await h.user(h.a, [{ role: 'contributor', scope: [h.a.applicationId] }]);
    const admin = await h.user(h.a, [{ role: 'organization_admin', scope: ['*'] }]);
    const setRow = (limit: number, charged: number) => h.tx(h.a, async (t) => {
      await t.query(`INSERT INTO factory.principal_allowance (org_id, id, principal_id, period_start, period_end, limit_micro_usd, charged_micro_usd, set_by_principal_id)
        VALUES ($1,$2,$3, date_trunc('month', now() AT TIME ZONE 'UTC')::date, (date_trunc('month', now() AT TIME ZONE 'UTC') + interval '1 month')::date, $4, $5, $6)
        ON CONFLICT (org_id, principal_id, period_start) DO UPDATE SET limit_micro_usd = EXCLUDED.limit_micro_usd, charged_micro_usd = EXCLUDED.charged_micro_usd`, [h.a.orgId, randomUUID(), gil.principalId, limit, charged, admin.principalId]);
    });
    await setRow(100, 100);
    const first = (await call(gil)).queue.items[0];
    expect(first).toMatchObject({ reason: { code: 'allowance_used_up' }, dismissible: true });
    expect((await ack(gil, first?.key ?? '')).status).toBe(204);
    expect((await call(gil)).queue.items).toEqual([]); // marked as seen
    await setRow(200, 100); // raised: plenty left
    expect((await call(gil)).queue.items).toEqual([]);
    await setRow(200, 200); // used up again, under a new limit
    const again = (await call(gil)).queue.items[0];
    expect(again).toMatchObject({ reason: { code: 'allowance_used_up', limitMicroUsd: 200 } });
    expect(again?.key).not.toBe(first?.key);

    // A new month is shown as what opening it would create, without opening it.
    const rows = () => h.tx(h.a, async (t) => Number((await t.query<{ n: string }>('SELECT count(*) AS n FROM factory.principal_allowance WHERE principal_id = $1', [gil.principalId])).rows[0]?.n));
    expect(await rows()).toBe(1);
    const nextYear = new Date(Date.now() + 400 * 24 * 3600_000);
    const future = (await call(gil, { now: nextYear })).queue.items;
    expect(future).toEqual([]); // the carried-over limit with no usage: plenty left
    expect(await rows()).toBe(1); // the GET wrote nothing
    expect((await call(gil, { now: nextYear })).queue.degraded).toBe(false);
  });
});
