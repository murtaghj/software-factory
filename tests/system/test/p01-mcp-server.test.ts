// P-01 (docs/plan-additions.md): the factory MCP server. A real MCP client is connected to the
// server over an in-memory transport; the server calls the real API with the developer's token.
// The tests prove the agent can do the developer's routine work, that the API's rules still decide
// everything, and that no tool lets an agent give a human approval (INV-29).
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { FactoryClient, TOOL_NAMES, createFactoryMcpServer } from '@factory/mcp';
import { createSystemHarness, type SystemHarness, type SystemUser } from '../src/index.ts';
import { investigation, pendingDecision, respond, waitStatus, pump } from './support.ts';

type Result = { isError?: boolean; content: Array<{ type: string; text: string }> };

describe('P-01 factory MCP server', () => {
  let h: SystemHarness;
  let developer: SystemUser;
  let reviewer: SystemUser;
  let viewer: SystemUser;
  const clients: Client[] = [];
  const connect = async (user: SystemUser): Promise<Client> => {
    const server = createFactoryMcpServer(new FactoryClient({ baseUrl: h.apiUrl, token: () => user.token() }), { dashboardUrl: 'https://factory.example/' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-agent', version: '0.0.0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    clients.push(client);
    return client;
  };
  const call = async (c: Client, name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; value: Record<string, unknown> }> => {
    const r = await c.callTool({ name, arguments: args }) as Result;
    const text = r.content[0]?.text ?? '';
    let value: Record<string, unknown>;
    try { value = JSON.parse(text) as Record<string, unknown>; } catch { value = { raw: text }; }
    return { isError: r.isError === true, value };
  };
  beforeAll(async () => {
    h = await createSystemHarness('p01', { temporal: { fakeStage: { delayMs: (n) => (n === 'investigate' ? 1500 : 0) } } });
    developer = await h.user([{ role: 'contributor', scope: [h.applicationId] }]);
    reviewer = await h.user([{ role: 'reviewer', scope: [h.applicationId] }]);
    viewer = await h.user([{ role: 'viewer', scope: [h.applicationId] }]);
  }, 300_000);
  afterAll(async () => { for (const c of clients) await c.close(); await h.close(); });

  it('offers exactly the agent tools: nothing that answers a decision or changes scope, budget or ownership', async () => {
    const agent = await connect(developer);
    const names = (await agent.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([...TOOL_NAMES].sort());
    expect(names.filter((n) => /respond|approve|decision_response|amend|budget|reassign/.test(n))).toEqual([]);
    const command = (await agent.listTools()).tools.find((t) => t.name === 'factory_command');
    expect((command?.inputSchema.properties as { kind: { enum: string[] } }).kind.enum).toEqual(['pause', 'resume', 'cancel']);
  });

  it('a developer\'s agent submits a task, follows it and reads its evidence; the human approval happens outside the agent', async () => {
    const agent = await connect(developer);
    const submitted = await call(agent, 'factory_submit_task', { request: investigation(h.applicationId), idempotencyKey: 'agent-submit-0001' });
    expect(submitted.isError).toBe(false);
    const taskId = submitted.value.taskId as string;
    // Retrying the same submission with the same key is the same task, not a second one.
    expect((await call(agent, 'factory_submit_task', { request: investigation(h.applicationId), idempotencyKey: 'agent-submit-0001' })).value.taskId).toBe(taskId);
    const decision = await pendingDecision(h, developer, taskId);

    // The reviewer's agent sees the decision in the reviewer's inbox, with where a human answers it.
    const reviewerAgent = await connect(reviewer);
    const inbox = await call(reviewerAgent, 'factory_inbox');
    expect(inbox.isError).toBe(false);
    expect(inbox.value.note).toMatch(/human/);
    expect(inbox.value.items).toEqual([expect.objectContaining({ id: decision.id, taskId, action: 'approve_plan', state: 'pending', answerAt: `https://factory.example/decisions/${decision.id}` })]);
    // It is not in the developer's own inbox: they are the author, not the assigned peer.
    expect((await call(agent, 'factory_inbox')).value.items).toEqual([]);

    expect((await respond(h, reviewer, taskId, decision)).status).toBe(202); // the human reviewer, through the API
    await waitStatus(h, developer, taskId, ['succeeded']);
    expect((await call(agent, 'factory_get_task', { taskId })).value).toMatchObject({ id: taskId, status: 'succeeded' });
    const listed = await call(agent, 'factory_list_tasks', { status: 'succeeded' });
    expect((listed.value.items as Array<{ id: string }>).map((t) => t.id)).toContain(taskId);
    const evidence = await call(agent, 'factory_task_evidence', { taskId });
    expect((evidence.value.runs as Array<{ nodeId: string; status: string }>).map((r) => [r.nodeId, r.status])).toContainEqual(['deliver', 'passed']);
    expect((evidence.value.gates as Array<{ gateId: string; verdict: string }>).map((g) => [g.gateId, g.verdict]).sort()).toEqual([['outcome_recorded', 'passed'], ['plan_peer_approved', 'passed'], ['review_passed', 'passed'], ['scope_accepted', 'passed']]);
    expect((await call(reviewerAgent, 'factory_inbox')).value.items).toEqual([]); // answered: gone from the inbox
  }, 120_000);

  it('the agent can pause, resume and cancel the developer\'s task, and sees the receipts', async () => {
    const agent = await connect(developer);
    const taskId = (await call(agent, 'factory_submit_task', { request: investigation(h.applicationId) })).value.taskId as string;
    await respond(h, reviewer, taskId, await pendingDecision(h, developer, taskId));
    await pump(h, async () => ((await call(agent, 'factory_get_task', { taskId })).value.currentNodeId === 'investigate' ? true : undefined));
    const applied = async (kind: string) => {
      const receipt = await call(agent, 'factory_command', { taskId, kind, reason: `agent ${kind}` });
      expect(receipt.isError, JSON.stringify(receipt.value)).toBe(false);
      return pump(h, async () => { const s = (await call(agent, 'factory_command_status', { commandId: receipt.value.commandId })).value; return s.state === 'applied' || s.state === 'rejected' ? s : undefined; });
    };
    expect(await applied('pause')).toMatchObject({ state: 'applied' });
    expect((await waitStatus(h, developer, taskId, ['paused'])).status).toBe('paused');
    expect(await applied('resume')).toMatchObject({ state: 'applied' });
    expect(await applied('cancel')).toMatchObject({ state: 'applied' });
    expect((await waitStatus(h, developer, taskId, ['cancelled'])).status).toBe('cancelled');
    // A closed task: the API's refusal reaches the agent as an error with the API's own code.
    const late = await call(agent, 'factory_command', { taskId, kind: 'pause', reason: 'too late' });
    expect(late).toMatchObject({ isError: true, value: { error: 'task_terminal', status: 409 } });
  }, 120_000);

  it('the API still decides: a viewer\'s agent cannot submit or control, and other kinds of command are not expressible', async () => {
    const viewerAgent = await connect(viewer);
    expect(await call(viewerAgent, 'factory_submit_task', { request: investigation(h.applicationId) })).toMatchObject({ isError: true, value: { error: 'application_not_authorized', status: 403 } });
    const agent = await connect(developer);
    const taskId = (await call(agent, 'factory_submit_task', { request: investigation(h.applicationId) })).value.taskId as string;
    await pendingDecision(h, developer, taskId);
    expect(await call(viewerAgent, 'factory_command', { taskId, kind: 'cancel', reason: 'not mine' })).toMatchObject({ isError: true, value: { error: 'not_task_controller', status: 403 } });
    // The tool schema refuses anything but pause/resume/cancel before the API is reached.
    for (const kind of ['amend_spec', 'change_budget', 'respond_decision']) {
      const r = await viewerAgent.callTool({ name: 'factory_command', arguments: { taskId, kind, reason: 'x' } }).then((x) => x as Result, (e: unknown) => ({ isError: true, content: [{ type: 'text', text: String(e) }] }));
      expect(r.isError, kind).toBe(true);
    }
    // An invalid request is refused locally with field errors, and a task in another organization
    // is indistinguishable from one that does not exist.
    expect(await call(agent, 'factory_submit_task', { request: { title: 'not a task request' } })).toMatchObject({ isError: true, value: { error: 'invalid_task_request' } });
    expect(await call(agent, 'factory_get_task', { taskId: '00000000-0000-4000-8000-000000000001' })).toMatchObject({ isError: true, value: { error: 'not_found', status: 404 } });
    expect((await call(agent, 'factory_command', { taskId, kind: 'cancel', reason: 'cleanup' })).isError).toBe(false);
    await waitStatus(h, developer, taskId, ['cancelled']);
  }, 120_000);

  it('the inbox filter is the caller\'s own: assignedTo accepts only "me"', async () => {
    expect((await h.call(reviewer, 'GET', '/v2/decisions?assignedTo=someone-else')).status).toBe(422);
    const mine = (await h.call(reviewer, 'GET', '/v2/decisions?assignedTo=me')).body as { items: Array<{ requiredPrincipalId: string }> };
    expect(mine.items.length).toBeGreaterThan(0);
    expect(mine.items.every((d) => d.requiredPrincipalId === reviewer.principalId)).toBe(true);
    expect(((await h.call(developer, 'GET', '/v2/decisions?assignedTo=me')).body as { items: unknown[] }).items).toEqual([]);
  });
});
