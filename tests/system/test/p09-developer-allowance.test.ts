// P-09 (docs/plan-additions.md): a developer's monthly allowance, full stack. The creator pays:
// tasks draw on their creator's allowance as stages run. When it is used up, running work ends
// incomplete with the reason, new submissions get 429, and nothing is recorded as success.
import { randomUUID } from 'node:crypto';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { EXIT, run, type CliIo } from '@factory/cli';
import { FactoryClient } from '@factory/client';
import { createSystemHarness, type SystemHarness, type SystemUser } from '../src/index.ts';
import { createTask, investigation, pendingDecision, respond, waitStatus } from './support.ts';

describe('P-09 developer allowance (full stack)', () => {
  let h: SystemHarness;
  let developer: SystemUser;
  let colleague: SystemUser;
  let reviewer: SystemUser;
  let admin: SystemUser;
  beforeAll(async () => {
    h = await createSystemHarness('p09sys', { temporal: {} });
    developer = await h.user([{ role: 'contributor', scope: [h.applicationId] }]);
    colleague = await h.user([{ role: 'contributor', scope: [h.applicationId] }]);
    reviewer = await h.user([{ role: 'reviewer', scope: [h.applicationId] }]);
    admin = await h.user([{ role: 'organization_admin', scope: ['*'] }]);
  }, 300_000);
  afterAll(async () => { await h.close(); });
  const setLimit = (by: SystemUser, who: SystemUser, usd: number) => h.call(by, 'POST', `/v2/principals/${who.principalId}/allowance`, { monthlyLimitMicroUsd: usd * 1_000_000 }, { 'idempotency-key': randomUUID() });
  const mine = async (user: SystemUser) => (await h.call(user, 'GET', '/v2/me/allowance')).body as { enrolled: boolean; limitMicroUsd?: number; chargedMicroUsd?: number; reservedMicroUsd?: number; remainingMicroUsd?: number };
  const factory = async (user: SystemUser, argv: string[]): Promise<{ code: number; out: string[]; err: string[] }> => {
    const s = { code: -1, out: [] as string[], err: [] as string[] };
    const io: CliIo = { client: new FactoryClient({ baseUrl: h.apiUrl, token: () => user.token() }), out: (l) => { s.out.push(l); }, err: (l) => { s.err.push(l); }, isTTY: false, ask: () => Promise.resolve(''), readFile: () => Promise.reject(new Error('unused')), writeFile: () => Promise.reject(new Error('unused')), now: () => Date.now(), uuid: () => randomUUID(), sleep: () => Promise.resolve() };
    s.code = await run(argv, io);
    return s;
  };

  it('only an organization admin sets an allowance; a developer reads only their own', async () => {
    expect(await mine(developer)).toEqual({ principalId: developer.principalId, enrolled: false });
    expect(await setLimit(developer, developer, 1000)).toMatchObject({ status: 403, body: { code: 'allowance_not_authorized' } });
    expect(await setLimit(reviewer, developer, 1000)).toMatchObject({ status: 403 });
    expect(await setLimit(admin, developer, -1)).toMatchObject({ status: 422, body: { code: 'invalid_allowance' } });
    expect((await h.call(admin, 'POST', `/v2/principals/${randomUUID()}/allowance`, { monthlyLimitMicroUsd: 1 })).status).toBe(404);
    expect(await setLimit(admin, developer, 2)).toMatchObject({ status: 200, body: { enrolled: true, limitMicroUsd: 2_000_000, remainingMicroUsd: 2_000_000 } });
    expect((await h.call(colleague, 'GET', `/v2/principals/${developer.principalId}/allowance`)).status).toBe(404);
    expect((await h.call(admin, 'GET', `/v2/principals/${developer.principalId}/allowance`)).body).toMatchObject({ enrolled: true, limitMicroUsd: 2_000_000 });
    const audit = await h.tx(async (t) => (await t.query<{ actor_id: string }>("SELECT actor_id FROM factory.audit_event WHERE action = 'allowance.set' AND resource_id = $1", [developer.principalId])).rows);
    expect(audit.map((a) => a.actor_id)).toEqual([admin.principalId]);
  });

  it('when the allowance runs out mid-task the task ends incomplete with the reason, and new submissions are refused with 429', async () => {
    // $2 allowance; each fake runner stage costs $1. Scope and plan fit; the next reservation does not.
    const taskId = await createTask(h, developer);
    const done = await waitStatus(h, developer, taskId, ['incomplete', 'succeeded', 'failed', 'waiting_decision']);
    expect(done).toMatchObject({ status: 'incomplete', waitingReason: 'budget_exhausted' });
    const last = await h.tx(async (t) => (await t.query<{ payload_ref: { artifactId: string } }>("SELECT payload_ref FROM factory.task_event WHERE task_id = $1 AND event_type = 'task.completed'", [taskId])).rows[0]);
    expect(last).toBeDefined();
    const account = await h.tx(async (t) => (await t.query<{ limit_micro_usd: string; charged_micro_usd: string }>('SELECT limit_micro_usd, charged_micro_usd FROM factory.budget_account WHERE task_id = $1', [taskId])).rows[0]);
    expect(account).toEqual({ limit_micro_usd: '25000000', charged_micro_usd: '2000000' }); // the task's own budget was not the limit
    expect(await mine(developer)).toMatchObject({ chargedMicroUsd: 2_000_000, reservedMicroUsd: 0, remainingMicroUsd: 0 });

    const refused = await h.call(developer, 'POST', '/v2/tasks', investigation(h.applicationId), { 'idempotency-key': randomUUID() });
    expect(refused).toMatchObject({ status: 429, body: { code: 'allowance_exhausted', retryable: true } });
    expect((await factory(developer, ['budget'])).out[0]).toMatch(/^\$0\.00 left of \$2\.00 until \d{4}-\d{2}-01$/);
  }, 120_000);

  it('a colleague is unaffected, and raising the limit lets the developer work again', async () => {
    const theirs = await createTask(h, colleague);
    await respond(h, reviewer, theirs, await pendingDecision(h, colleague, theirs));
    expect((await waitStatus(h, colleague, theirs, ['succeeded', 'incomplete', 'failed'])).status).toBe('succeeded');
    expect(await mine(colleague)).toMatchObject({ enrolled: false });

    // Raised through the CLI by the admin: usage is kept, the remainder grows.
    expect((await factory(developer, ['budget', 'set', developer.principalId, '--limit-usd', '30'])).err[0]).toMatch(/^factory: allowance_not_authorized/);
    const raised = await factory(admin, ['budget', 'set', developer.principalId, '--limit-usd', '30']);
    expect(raised.code).toBe(EXIT.ok);
    expect(raised.out[1]).toMatch(/^\$28\.00 left of \$30\.00/);
    const taskId = await createTask(h, developer);
    await respond(h, reviewer, taskId, await pendingDecision(h, developer, taskId));
    expect((await waitStatus(h, developer, taskId, ['succeeded', 'incomplete', 'failed'])).status).toBe('succeeded');
    // Four runner stages at $1 on top of the earlier $2; nothing left reserved.
    expect(await mine(developer)).toMatchObject({ limitMicroUsd: 30_000_000, chargedMicroUsd: 6_000_000, reservedMicroUsd: 0, remainingMicroUsd: 24_000_000 });
    expect((await factory(admin, ['budget', 'set', developer.principalId, '--limit-usd', 'lots'])).code).toBe(EXIT.usage);
  }, 120_000);
});
