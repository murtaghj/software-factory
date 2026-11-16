// P-21 (docs/plan-additions.md): project boards and the cross-project "my work" view, full stack.
// Developers work on several projects at once; the view answers "what should I do next?" in a
// fixed order, and neither view can change a task.
import { randomUUID } from 'node:crypto';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { EXIT, run, type CliIo } from '@factory/cli';
import { FactoryClient, type Board, type MyWork } from '@factory/client';
import { createFactoryMcpServer } from '@factory/mcp';
import { createSystemHarness, type SystemHarness, type SystemUser } from '../src/index.ts';
import { command, createTask, investigation, pendingDecision, respond, waitStatus } from './support.ts';

describe('P-21 project boards and my work', () => {
  let h: SystemHarness;
  let dana: SystemUser; // works on both projects
  let riley: SystemUser; // reviewer on both, contributor on billing
  let outsider: SystemUser; // no role on billing
  const billing = randomUUID();
  beforeAll(async () => {
    h = await createSystemHarness('p21', { temporal: {} });
    await h.tx((t) => t.query("INSERT INTO factory.application (org_id, id, app_key, name, owner_ids, lifecycle) VALUES ($1,$2,'billing','Billing API','[]','production')", [h.orgId, billing]));
    dana = await h.user([{ role: 'contributor', scope: [h.applicationId, billing] }]);
    riley = await h.user([{ role: 'reviewer', scope: [h.applicationId, billing] }, { role: 'contributor', scope: [billing] }]);
    outsider = await h.user([{ role: 'viewer', scope: [h.applicationId] }]);
    await h.tx(async (t) => {
      await t.query("UPDATE factory.principal SET display_name = 'Dana' WHERE id = $1", [dana.principalId]);
      await t.query("UPDATE factory.principal SET display_name = 'Riley' WHERE id = $1", [riley.principalId]);
    });
  }, 300_000);
  afterAll(async () => { await h.close(); });
  const work = async (u: SystemUser) => (await h.call(u, 'GET', '/v2/me/work')).body as MyWork;
  const board = async (u: SystemUser, app: string) => (await h.call(u, 'GET', `/v2/applications/${app}/board`)).body as Board;
  const onBilling = (title: string) => ({ ...investigation(billing), title });
  const ids = (cards: Array<{ taskId: string }>) => cards.map((c) => c.taskId);

  let ordersDone: string; let ordersWaiting: string; let billingWaiting: string; let billingStopped: string; let rileysTask: string;

  it('a developer with nothing going on is told so', async () => {
    const w = await work(dana);
    expect(w).toMatchObject({ principalId: dana.principalId, needsYou: [], stopped: [], inProgress: [], waitingOnOthers: [], recentlyDone: [], truncated: false });
  });

  it('my work spans projects and is ordered by what to do first', async () => {
    // Dana: one finished and one waiting on Riley in Orders; in Billing, one waiting on Riley and
    // one that ran out of budget. Riley has a task of their own that waits on nobody... and Dana
    // is not a reviewer, so Riley's Billing task has no eligible peer and stops.
    ordersDone = await createTask(h, dana, { title: 'Orders: finished investigation' });
    await respond(h, riley, ordersDone, await pendingDecision(h, dana, ordersDone));
    await waitStatus(h, dana, ordersDone, ['succeeded']);
    ordersWaiting = await createTask(h, dana, { title: 'Orders: awaiting plan review' });
    billingWaiting = ((await h.call(dana, 'POST', '/v2/tasks', onBilling('Billing: awaiting plan review'), { 'idempotency-key': randomUUID() })).body as { taskId: string }).taskId;
    billingStopped = ((await h.call(dana, 'POST', '/v2/tasks', { ...onBilling('Billing: ran out of budget'), budget: { ...investigation(billing).budget, maxMicroUsd: 1_500_000 } }, { 'idempotency-key': randomUUID() })).body as { taskId: string }).taskId;
    await waitStatus(h, dana, ordersWaiting, ['waiting_decision']);
    await waitStatus(h, dana, billingWaiting, ['waiting_decision']);
    await waitStatus(h, dana, billingStopped, ['incomplete']);

    const w = await work(dana);
    expect(w.needsYou).toEqual([]);
    expect(ids(w.stopped)).toEqual([billingStopped]);
    expect(ids(w.waitingOnOthers).sort()).toEqual([ordersWaiting, billingWaiting].sort());
    expect(w.waitingOnOthers.every((c) => c.waitingOnPrincipalId === riley.principalId && c.decisionId !== undefined)).toBe(true);
    expect(ids(w.recentlyDone)).toEqual([ordersDone]);
    expect(w.applications).toEqual({ [h.applicationId]: 'Orders API', [billing]: 'Billing API' });
    expect(w.people[riley.principalId]).toBe('Riley');
  }, 120_000);

  it('the reviewer is told first about what others are blocked on, soonest expiry first, even with work of their own', async () => {
    rileysTask = ((await h.call(riley, 'POST', '/v2/tasks', onBilling('Billing: Riley\'s own task'), { 'idempotency-key': randomUUID() })).body as { taskId: string }).taskId;
    await waitStatus(h, riley, rileysTask, ['incomplete']); // nobody else can review Billing
    const w = await work(riley);
    expect(ids(w.needsYou).sort()).toEqual([ordersWaiting, billingWaiting].sort());
    const expiries = w.needsYou.map((c) => c.decisionExpiresAt ?? '');
    expect(expiries).toEqual([...expiries].sort()); // soonest expiry first
    expect(ids(w.stopped)).toEqual([rileysTask]);
    // Answering one moves it out of "needs you" for Riley and out of "waiting" for Dana.
    await respond(h, riley, ordersWaiting, await pendingDecision(h, dana, ordersWaiting));
    await waitStatus(h, dana, ordersWaiting, ['succeeded']);
    expect(ids((await work(riley)).needsYou)).toEqual([billingWaiting]);
    expect(ids((await work(dana)).waitingOnOthers)).toEqual([billingWaiting]);
  }, 120_000);

  it('a project board groups that project\'s tasks by state, shows who each waits on, and totals this month\'s spend', async () => {
    const b = await board(dana, billing);
    expect(b).toMatchObject({ applicationId: billing, name: 'Billing API', truncated: false });
    expect(ids(b.columns.waiting)).toEqual([billingWaiting]);
    expect(ids(b.columns.stopped).sort()).toEqual([billingStopped, rileysTask].sort());
    expect(b.columns.done).toEqual([]);
    expect(ids(b.needsPerson)).toEqual([billingWaiting]);
    expect(b.needsPerson[0]).toMatchObject({ waitingOnPrincipalId: riley.principalId, currentNodeId: 'plan_review', waitingReason: 'plan_review' });
    // Billing: waiting task ran scope + plan ($2); the budget-limited one ran scope ($1); Riley's
    // ran scope + plan ($2) before finding no reviewer.
    expect(b.spentThisMonthMicroUsd).toBe(5_000_000);
    const orders = await board(dana, h.applicationId);
    expect(ids(orders.columns.done).sort()).toEqual([ordersDone, ordersWaiting].sort());
    expect(Object.values(orders.columns).flat().some((c) => c.applicationId !== h.applicationId)).toBe(false);
  });

  it('boards respect project access, and are read-only', async () => {
    expect((await h.call(outsider, 'GET', `/v2/applications/${billing}/board`)).status).toBe(404);
    expect((await h.call(outsider, 'GET', `/v2/applications/${randomUUID()}/board`)).status).toBe(404);
    expect((await h.call(outsider, 'GET', `/v2/applications/${h.applicationId}/board`)).status).toBe(200);
    expect(await work(outsider)).toMatchObject({ needsYou: [], stopped: [], waitingOnOthers: [] }); // sees nothing that is not theirs
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect((await h.call(dana, method, `/v2/applications/${billing}/board`, { columns: {} })).status, method).toBe(404);
      expect((await h.call(dana, method, '/v2/me/work', {})).status, method).toBe(404);
    }
    // State changes only through commands: cancelling moves the card.
    await command(h, dana, billingWaiting, 'cancel');
    await waitStatus(h, dana, billingWaiting, ['cancelled']);
    const b = await board(dana, billing);
    expect(b.columns.waiting).toEqual([]);
    expect(b.needsPerson).toEqual([]);
    expect(ids(b.columns.stopped)).toContain(billingWaiting);
    expect(ids((await work(riley)).needsYou)).toEqual([]);
  });

  it('the same answer reaches the CLI and the developer\'s agent', async () => {
    const out: string[] = [];
    const io: CliIo = { client: new FactoryClient({ baseUrl: h.apiUrl, token: () => dana.token() }), out: (l) => { out.push(l); }, err: (l) => { out.push(`ERR ${l}`); }, isTTY: false, ask: () => Promise.resolve(''), readFile: () => Promise.reject(new Error('unused')), writeFile: () => Promise.reject(new Error('unused')), now: () => Date.now(), uuid: () => randomUUID(), sleep: () => Promise.resolve() };
    expect(await run(['work'], io)).toBe(EXIT.ok);
    // The ranked queue: her stopped task first, then what finished. Ranking is the server's; the CLI prints it in order.
    expect(out[0]).toMatch(/^Next: "Billing: ran out of budget" — Stopped — ran out of budget, /);
    expect(out.filter((l) => /^\d+\. /.test(l)).map((l) => l.replace(/ — .*/, ''))).toEqual(['1. [Stopped] Billing: ran out of budget [Billing API]', '2. [Finished] Orders: finished investigation [Orders API]', '3. [Finished] Orders: awaiting plan review [Orders API]']);
    expect(out.join('\n')).toContain(`factory status ${billingStopped}`);
    out.length = 0;
    expect(await run(['board', billing], io)).toBe(EXIT.ok);
    expect(out[0]).toBe('Billing API — spent this month $5.00');
    expect(out).toContain('Stopped (3)');

    const server = createFactoryMcpServer(new FactoryClient({ baseUrl: h.apiUrl, token: () => dana.token() }));
    const [a, c] = InMemoryTransport.createLinkedPair();
    const agent = new Client({ name: 'test-agent', version: '0.0.0' });
    await Promise.all([server.connect(a), agent.connect(c)]);
    const result = await agent.callTool({ name: 'factory_my_work', arguments: {} }) as { content: Array<{ text: string }> };
    const seen = JSON.parse(result.content[0]?.text ?? '{}') as { next: string; items: Array<{ subject: { taskId: string }; reasonText: string }> };
    expect(seen.items[0]?.subject.taskId).toBe(billingStopped);
    expect(seen.next).toMatch(/^Next: "Billing: ran out of budget" — /);
    await agent.close();

  });
});
