// P-24 (docs/plan-additions.md): the ranked "what needs you next" queue, full stack. Two projects and
// five people. The server decides what is listed and in what order; the dashboard, CLI and agent tool
// show the same order; "Mark as seen" is the person's own act and never reaches an agent.
import { randomUUID } from 'node:crypto';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { DecisionView } from '@factory/contracts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { EXIT, run, type CliIo } from '@factory/cli';
import { FactoryClient, parseQueue, queueHeadline, type Board, type Queue, type QueueItem } from '@factory/client';
import { createFactoryMcpServer } from '@factory/mcp';
import { createSystemHarness, type SystemHarness, type SystemUser } from '../src/index.ts';
import { command, commandState, createTask, investigation, pendingDecision, respond, waitStatus } from './support.ts';

describe('P-24 what needs you next', () => {
  let h: SystemHarness;
  let dana: SystemUser; // contributor on both projects
  let riley: SystemUser; // reviewer on both, contributor on Billing
  let sam: SystemUser; // contributor on Billing
  let admin: SystemUser;
  let outsider: SystemUser; // viewer on Orders only
  const billing = randomUUID();
  let skew = 0; // the queue's clock runs ahead of the real one by this many ms
  beforeAll(async () => {
    h = await createSystemHarness('p24', { temporal: {}, queue: { now: () => new Date(Date.now() + skew) } });
    await h.tx((t) => t.query("INSERT INTO factory.application (org_id, id, app_key, name, owner_ids, lifecycle) VALUES ($1,$2,'billing','Billing API','[]','production')", [h.orgId, billing]));
    dana = await h.user([{ role: 'contributor', scope: [h.applicationId, billing] }], 'Dana');
    riley = await h.user([{ role: 'reviewer', scope: [h.applicationId, billing] }, { role: 'contributor', scope: [billing] }], 'Riley');
    sam = await h.user([{ role: 'contributor', scope: [billing] }], 'Sam');
    admin = await h.user([{ role: 'organization_admin', scope: ['*'] }], 'Admin');
    outsider = await h.user([{ role: 'viewer', scope: [h.applicationId] }], 'Outsider');
  }, 300_000);
  afterAll(async () => { await h.close(); });

  const queue = async (u: SystemUser): Promise<Queue> => parseQueue((await h.call(u, 'GET', '/v2/me/queue')).body);
  const keys = (q: Queue) => q.items.map((i) => i.key);
  const itemFor = (q: Queue, taskId: string, code?: string): QueueItem | undefined => q.items.find((i) => (i.subject.taskId === taskId || i.subject.id === taskId) && (code === undefined || i.reason.code === code));
  const onBilling = (title: string, over: Record<string, unknown> = {}) => ({ ...investigation(billing), title, ...over });
  const submit = async (u: SystemUser, body: unknown): Promise<string> => ((await h.call(u, 'POST', '/v2/tasks', body, { 'idempotency-key': randomUUID() })).body as { taskId: string }).taskId;
  const ack = (u: SystemUser, key: unknown) => h.call(u, 'POST', '/v2/me/queue/acks', { key });
  const setLimit = (micro: number, who: SystemUser) => h.call(admin, 'POST', `/v2/principals/${who.principalId}/allowance`, { monthlyLimitMicroUsd: micro }, { 'idempotency-key': randomUUID() });

  let ordersTask: string; let billingTask: string; let ordersDecision: DecisionView; let billingDecision: DecisionView;
  let stoppedTask: string; let rileysTask: string;

  it('a person with nothing going on gets an empty list and three healthy sources', async () => {
    const q = await queue(dana);
    expect(q).toMatchObject({ schema: 'factory-queue/1', principalId: dana.principalId, items: [], degraded: false, truncated: false });
    expect(q.sources.map((s) => [s.id, s.status])).toEqual([['factory.decisions', 'ok'], ['factory.tasks', 'ok'], ['factory.budget', 'ok']]);
    expect(queueHeadline(q, Date.now())).toBe('Nothing needs you.');
  });

  it('tier 1: the reviewer is told first about what others are blocked on, soonest expiry first', async () => {
    ordersTask = await createTask(h, dana, { title: 'Orders: awaiting plan review' });
    billingTask = await submit(dana, onBilling('Billing: awaiting plan review'));
    ordersDecision = await pendingDecision(h, dana, ordersTask);
    billingDecision = await pendingDecision(h, dana, billingTask);
    await waitStatus(h, dana, billingTask, ['waiting_decision']);
    const q = await queue(riley);
    expect(q.items).toHaveLength(2);
    for (const i of q.items) expect(i).toMatchObject({ tier: 1, need: 'blocked_on_you', dismissible: false, sourceId: 'factory.decisions', reason: { code: 'answer_needed', actorPrincipalId: dana.principalId }, action: { kind: 'answer_decision' } });
    expect(q.items.map((i) => i.rank)).toEqual([1, 2]);
    const expiries = q.items.map((i) => i.expiresAt ?? '');
    expect(expiries).toEqual([...expiries].sort());
    expect(new Set(q.items.map((i) => i.action.kind === 'answer_decision' ? i.action.decisionId : ''))).toEqual(new Set([ordersDecision.id, billingDecision.id]));
    expect(q.applications).toEqual({ [h.applicationId]: 'Orders API', [billing]: 'Billing API' });
    expect(q.people[dana.principalId]).toBe('Dana');
  }, 120_000);

  it('exclusion: tasks that are merely waiting, paused or cancelled are not listed, though "my work" still has them', async () => {
    expect(keys(await queue(dana))).toEqual([]); // 72 hours left: nothing of Dana's is about to run out
    const work = (await h.call(dana, 'GET', '/v2/me/work')).body as { waitingOnOthers: Array<{ taskId: string }> };
    expect(work.waitingOnOthers.map((c) => c.taskId).sort()).toEqual([ordersTask, billingTask].sort());
    const toPause = await createTask(h, dana, { title: 'Orders: to be paused' });
    const toCancel = await createTask(h, dana, { title: 'Orders: to be cancelled' });
    await waitStatus(h, dana, toPause, ['waiting_decision']);
    await waitStatus(h, dana, toCancel, ['waiting_decision']);
    expect((await commandState(h, dana, (await command(h, dana, toPause, 'pause')).commandId)).state).toBe('applied');
    expect((await commandState(h, dana, (await command(h, dana, toCancel, 'cancel')).commandId)).state).toBe('applied');
    await waitStatus(h, dana, toCancel, ['cancelled']);
    expect(keys(await queue(dana))).toEqual([]);
    expect((await queue(riley)).items.filter((i) => i.subject.taskId === toCancel)).toEqual([]); // a cancelled task no longer waits on anyone
    expect((await command(h, dana, toPause, 'cancel')).status).toBe(202);
    await waitStatus(h, dana, toPause, ['cancelled']);
    expect(keys(await queue(riley))).toHaveLength(2);
  }, 120_000);

  it('tier 2 (time): the author is told when a review request is about to expire; the reviewer stays in tier 1', async () => {
    const first = Math.min(Date.parse(ordersDecision.expiresAt), Date.parse(billingDecision.expiresAt));
    skew = first - 4 * 3600_000 - Date.now();
    try {
      const mine = await queue(dana);
      expect(mine.items.map((i) => [i.reason.code, i.tier, i.reason.actorPrincipalId])).toEqual([['review_expiring', 2, riley.principalId], ['review_expiring', 2, riley.principalId]]);
      expect(mine.items[0]).toMatchObject({ need: 'running_out', dismissible: false, action: { kind: 'open_task' }, subject: { kind: 'decision' } });
      expect(new Set(mine.items.map((i) => i.subject.taskId))).toEqual(new Set([ordersTask, billingTask]));
      expect(mine.people[riley.principalId]).toBe('Riley');
      expect((await queue(riley)).items.map((i) => i.tier)).toEqual([1, 1]);
    } finally { skew = 0; }
    expect(keys(await queue(dana))).toEqual([]);
  });

  it('tier 3: a task that stopped says why, and sorts after everything blocking the reviewer', async () => {
    stoppedTask = await submit(dana, onBilling('Billing: ran out of budget', { budget: { ...investigation(billing).budget, maxMicroUsd: 1_500_000 } }));
    rileysTask = await submit(riley, onBilling('Billing: Riley\'s own task'));
    await waitStatus(h, dana, stoppedTask, ['incomplete']);
    await waitStatus(h, riley, rileysTask, ['incomplete']); // nobody else can review Billing
    const mine = itemFor(await queue(dana), stoppedTask);
    expect(mine).toMatchObject({ tier: 3, need: 'stopped', dismissible: true, reason: { code: 'task_stopped', detailCode: 'budget_exhausted' }, subject: { kind: 'task', id: stoppedTask } });
    const theirs = await queue(riley);
    expect(theirs.items.map((i) => [i.rank, i.tier, i.reason.code])).toEqual([[1, 1, 'answer_needed'], [2, 1, 'answer_needed'], [3, 3, 'task_stopped']]);
    expect(theirs.items[2]).toMatchObject({ subject: { id: rileysTask }, reason: { detailCode: 'no_eligible_independent_reviewer' } });
  }, 120_000);

  it('tier 4: a finished task is for the author to look at, and leaves the reviewer\'s list once answered', async () => {
    expect((await respond(h, riley, ordersTask, ordersDecision)).status).toBe(202);
    await waitStatus(h, dana, ordersTask, ['succeeded']);
    const mine = itemFor(await queue(dana), ordersTask);
    expect(mine).toMatchObject({ tier: 4, need: 'finished', dismissible: true, reason: { code: 'task_finished' } });
    expect(itemFor(await queue(riley), ordersTask)).toBeUndefined();
  }, 120_000);

  it('the full order for the author with a request about to expire: tier 2, then 3, then 4', async () => {
    skew = Date.parse(billingDecision.expiresAt) - 4 * 3600_000 - 60_000 - Date.now(); // a minute over four hours, so "in 4 hours" holds while the test runs
    try {
      const q = await queue(dana);
      expect(q.items.map((i) => [i.rank, i.tier, i.reason.code])).toEqual([[1, 2, 'review_expiring'], [2, 3, 'task_stopped'], [3, 4, 'task_finished']]);
      expect(queueHeadline(q, Date.now() + skew)).toBe('Next: "Billing: awaiting plan review" — Riley has not answered your review request. 4 hours left, and the task stops if it expires.');
    } finally { skew = 0; }
  });

  it('tier 2 (money): a nearly used allowance is listed, "Mark as seen" removes it, and "used up" comes back under its own key', async () => {
    expect((await setLimit(100_000_000, sam)).status).toBe(200);
    const task = await submit(sam, onBilling('Billing: Sam\'s task'));
    await waitStatus(h, sam, task, ['waiting_decision']);
    const mine = async () => (await h.call(sam, 'GET', '/v2/me/allowance')).body as { chargedMicroUsd: number; reservedMicroUsd: number };
    const used = (await mine()).chargedMicroUsd + (await mine()).reservedMicroUsd;
    expect(used).toBeGreaterThan(0);
    expect((await setLimit(Math.ceil(used / 0.95), sam)).status).toBe(200);
    const low = (await queue(sam)).items.find((i) => i.reason.code === 'allowance_low');
    expect(low).toMatchObject({ tier: 2, need: 'running_out', dismissible: true, action: { kind: 'open_budget' }, subject: { kind: 'allowance' }, reason: { limitMicroUsd: Math.ceil(used / 0.95) } });
    expect(low?.key).toMatch(/^allowance:\d{4}-\d{2}-01\.l\d+:allowance_low$/);
    expect((await ack(sam, low?.key)).status).toBe(204);
    expect((await queue(sam)).items).toEqual([]);
    expect((await setLimit(used, sam)).status).toBe(200);
    const out = (await queue(sam)).items;
    expect(out.map((i) => [i.reason.code, i.reason.remainingMicroUsd])).toEqual([['allowance_used_up', 0]]);
    expect(out[0]?.key).toMatch(/:allowance_used_up$/);
  }, 120_000);

  it('Mark as seen: idempotent, personal, never for what still blocks, and it changes no task', async () => {
    const finished = itemFor(await queue(dana), ordersTask)?.key ?? '';
    expect(finished).toBe(`task:${ordersTask}:task_finished`);
    expect((await ack(riley, finished)).status).toBe(404); // someone else's key
    expect((await ack(dana, finished)).status).toBe(204);
    expect(keys(await queue(dana))).not.toContain(finished);
    expect((await ack(dana, finished)).status).toBe(204); // again
    const board = (await h.call(dana, 'GET', `/v2/applications/${h.applicationId}/board`)).body as Board;
    expect(board.columns.done.map((c) => c.taskId)).toContain(ordersTask); // still done on its board
    const blocking = (await queue(riley)).items[0];
    expect(blocking?.tier).toBe(1);
    expect(await ack(riley, blocking?.key)).toMatchObject({ status: 409, body: { code: 'not_dismissible' } });
    expect(await ack(dana, 'nonsense')).toMatchObject({ status: 422, body: { code: 'invalid_key' } });
    expect(await ack(dana, undefined)).toMatchObject({ status: 422 });
    expect(await ack(dana, `task:${randomUUID()}:task_finished`)).toMatchObject({ status: 404 });
  });

  it('authorization: someone with no access to Billing sees nothing of it', async () => {
    const q = await queue(outsider);
    expect(q.items).toEqual([]);
    expect(JSON.stringify(q)).not.toMatch(/Billing|billing/);
    expect(Object.keys(q.people)).toEqual([outsider.principalId]);
  });

  it('the CLI and the developer\'s agent show the same order as the API, and only a person can mark something as seen', async () => {
    const api = await queue(riley);
    expect(api.items.length).toBeGreaterThanOrEqual(3);
    const run1 = async (user: SystemUser, argv: string[], isTTY = false, answer = '') => {
      const s = { code: -1, out: [] as string[], err: [] as string[] };
      const io: CliIo = { client: new FactoryClient({ baseUrl: h.apiUrl, token: () => user.token() }), out: (l) => { s.out.push(l); }, err: (l) => { s.err.push(l); }, isTTY, ask: (q) => { s.out.push(`ASK ${q}`); return Promise.resolve(answer); }, readFile: () => Promise.reject(new Error('unused')), writeFile: () => Promise.reject(new Error('unused')), now: () => Date.now(), uuid: () => randomUUID(), sleep: () => Promise.resolve() };
      s.code = await run(argv, io);
      return s;
    };
    const cli = await run1(riley, ['work']);
    expect(cli.code).toBe(EXIT.ok);
    expect(cli.out[0]).toMatch(/^Next: /);
    const lines = cli.out.filter((l) => /^\d+\. /.test(l));
    expect(lines.map((l) => /^(\d+)\. /.exec(l)?.[1])).toEqual(api.items.map((i) => String(i.rank)));
    const cmd = (i: QueueItem) => i.action.kind === 'answer_decision' ? `factory show ${i.action.decisionId}` : i.action.kind === 'open_task' ? `factory status ${i.action.taskId}` : 'factory budget';
    expect(lines.map((l) => l.split('  ->  ')[1])).toEqual(api.items.map(cmd));
    expect(cli.out.at(-1)).toMatch(/^Within a group: incidents first/);
    expect(JSON.parse((await run1(riley, ['work', '--json'])).out.join('\n'))).toMatchObject({ schema: 'factory-queue/1', items: api.items.map((i) => ({ key: i.key })) });
    expect((await run1(dana, ['work', '--all'])).out.join('\n')).toContain('Waiting on others (1)'); // Dana's Billing task still waits on Riley

    const server = createFactoryMcpServer(new FactoryClient({ baseUrl: h.apiUrl, token: () => riley.token() }));
    const [a, c] = InMemoryTransport.createLinkedPair();
    const agent = new Client({ name: 'test-agent', version: '0.0.0' });
    await Promise.all([server.connect(a), agent.connect(c)]);
    const result = await agent.callTool({ name: 'factory_my_work', arguments: {} }) as { content: Array<{ text: string }> };
    const seen = JSON.parse(result.content[0]?.text ?? '{}') as { next: string; items: Array<{ key: string; reasonText: string; answerAt?: string }>; degraded: boolean };
    expect(seen.items.map((i) => i.key)).toEqual(keys(api));
    expect(seen.next).toMatch(/^Next: /);
    expect(seen.items[0]?.answerAt).toContain('/v2/decisions/');
    expect((await agent.listTools()).tools.map((t) => t.name).filter((n) => /seen|ack|dismiss/.test(n))).toEqual([]);
    await agent.close();

    // An agent's shell has no terminal: it cannot clear what needs the person.
    const stopped = api.items.find((i) => i.dismissible)?.key ?? '';
    const refused = await run1(riley, ['work', 'seen', stopped]);
    expect(refused.code).toBe(EXIT.usage);
    expect(refused.err.join(' ')).toContain('interactive terminal');
    expect(keys(await queue(riley))).toContain(stopped);
    // A pseudo-terminal alone is not enough: the person sees the item and types "seen".
    const unconfirmed = await run1(riley, ['work', 'seen', stopped], true, 'yes');
    expect(unconfirmed.code).toBe(EXIT.refused);
    expect(unconfirmed.out.join('\n')).toContain('Billing: Riley\'s own task');
    expect(unconfirmed.err.join(' ')).toContain('not confirmed');
    expect(keys(await queue(riley))).toContain(stopped);
    const unknown = await run1(riley, ['work', 'seen', `task:${randomUUID()}:task_stopped`], true, 'seen');
    expect(unknown.code).toBe(EXIT.refused);
    const blocking = await run1(riley, ['work', 'seen', api.items[0]?.key ?? ''], true, 'seen');
    expect(blocking.code).toBe(EXIT.refused);
    const person = await run1(riley, ['work', 'seen', stopped], true, 'seen');
    expect(person).toMatchObject({ code: EXIT.ok });
    expect(person.out.at(-1)).toBe('Marked as seen.');
    expect(keys(await queue(riley))).not.toContain(stopped);
    expect((await run1(riley, ['work', 'seen'], true)).code).toBe(EXIT.usage);
  }, 120_000);

  it('the queue cannot be changed by PUT, PATCH or DELETE, and has no other routes', async () => {
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      expect((await h.call(dana, method, '/v2/me/queue', {})).status, method).toBe(404);
      expect((await h.call(dana, method, '/v2/me/queue/acks', {})).status, method).toBe(404);
    }
    expect((await h.call(dana, 'GET', '/v2/me/queue/acks')).status).toBe(404);
    expect((await h.call(dana, 'POST', '/v2/me/queue', {})).status).toBe(404);
  });
});
