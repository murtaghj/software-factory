// Factory MCP server (plan-additions P-01). It lets a developer's own agent (Claude Code, an IDE)
// work with the factory through the existing API: submit a task, follow it, read its evidence,
// see what is waiting on the developer, and pause, resume or cancel.
//
// What it deliberately cannot do:
// - Answer a human decision. Plan approvals and other decisions are human authority (INV-21,
//   INV-29: an AI approval never counts as a human approval). The inbox tool shows what is waiting
//   and where to answer it; there is no tool that responds, and none must be added.
// - Change scope, budget or ownership (amend_spec, change_budget, reassign). Those stay with a
//   person in the dashboard or CLI.
// It holds no authority of its own: every call carries the developer's token and the API decides.
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { validateContract } from '@factory/contracts';
import type { ApiResult, FactoryClient } from './client.ts';

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
const UUID = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'must be a UUID');
export const AGENT_COMMANDS = ['pause', 'resume', 'cancel'] as const;
export const TOOL_NAMES = ['factory_submit_task', 'factory_get_task', 'factory_list_tasks', 'factory_task_evidence', 'factory_inbox', 'factory_command', 'factory_command_status'] as const;

const ok = (value: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
const fail = (code: string, detail: string, extra: Record<string, unknown> = {}): ToolResult => ({ isError: true, content: [{ type: 'text', text: JSON.stringify({ error: code, detail, ...extra }, null, 2) }] });
// API problems are passed through as they are (problem+json code and detail), never reworded into
// success and never retried here.
function unwrap(r: ApiResult, expected: number[]): { value: unknown } | { error: ToolResult } {
  if (expected.includes(r.status)) return { value: r.body };
  const p = (typeof r.body === 'object' && r.body !== null ? r.body : {}) as { code?: unknown; detail?: unknown; fieldErrors?: unknown };
  return { error: fail(typeof p.code === 'string' ? p.code : `http_${String(r.status)}`, typeof p.detail === 'string' ? p.detail : 'the factory API refused the request', { status: r.status, ...(p.fieldErrors === undefined ? {} : { fieldErrors: p.fieldErrors }) }) };
}

export function createFactoryMcpServer(client: FactoryClient, options: { dashboardUrl?: string } = {}): McpServer {
  const server = new McpServer({ name: 'software-factory', version: '0.1.0' }, {
    instructions: 'Tools for the software factory. You act as the signed-in developer. You can submit and follow tasks and read their evidence. You cannot approve plans or answer decisions: those need the human; show them the inbox item instead.',
  });

  server.registerTool('factory_submit_task', {
    description: 'Submit a new task to the factory. `request` must be a complete TaskRequest (schemaVersion "2.0", title, intent, applicationIds, workType, acceptanceCriteria, assurance, deliveryScope, budget, targetContext). Returns the accepted task ID. Pass the same idempotencyKey when retrying the same submission.',
    inputSchema: { request: z.record(z.string(), z.unknown()), idempotencyKey: z.string().min(8).max(200).optional() },
  }, async ({ request, idempotencyKey }) => {
    const valid = validateContract('TaskRequest', request);
    if (!valid.ok) return fail('invalid_task_request', 'request does not match TaskRequest', { fieldErrors: valid.errors.slice(0, 10).map((e) => `${e.path || '/'} ${e.message}`) });
    const r = unwrap(await client.post('/v2/tasks', request, idempotencyKey ?? randomUUID()), [200, 202]);
    return 'error' in r ? r.error : ok(r.value);
  });

  server.registerTool('factory_get_task', {
    description: 'Get one task: status, current stage, what it is waiting for, revision and outcome reference.',
    inputSchema: { taskId: UUID },
  }, async ({ taskId }) => {
    const r = unwrap(await client.get(`/v2/tasks/${taskId}`), [200]);
    return 'error' in r ? r.error : ok(r.value);
  });

  server.registerTool('factory_list_tasks', {
    description: 'List tasks the developer can see, newest first. Optional filters: status, applicationId.',
    inputSchema: { status: z.string().max(40).optional(), applicationId: UUID.optional(), limit: z.number().int().min(1).max(100).optional() },
  }, async ({ status, applicationId, limit }) => {
    const q = new URLSearchParams();
    if (status) q.set('status', status);
    if (applicationId) q.set('applicationId', applicationId);
    q.set('limit', String(limit ?? 20));
    const r = unwrap(await client.get(`/v2/tasks?${q.toString()}`), [200]);
    return 'error' in r ? r.error : ok(r.value);
  });

  server.registerTool('factory_task_evidence', {
    description: 'Read the evidence behind a task: its stage runs and the gate evaluations (verdict, reasons, evidence references) on the current plan.',
    inputSchema: { taskId: UUID },
  }, async ({ taskId }) => {
    const runs = unwrap(await client.get(`/v2/tasks/${taskId}/runs`), [200]);
    if ('error' in runs) return runs.error;
    const gates = unwrap(await client.get(`/v2/tasks/${taskId}/gates`), [200]);
    if ('error' in gates) return gates.error;
    return ok({ runs: (runs.value as { items: unknown[] }).items, gates: (gates.value as { items: unknown[] }).items });
  });

  server.registerTool('factory_inbox', {
    description: 'List the decisions waiting on the signed-in developer (for example plan approvals). Read-only: decisions are answered by the human, not by an agent. Each item says where to answer it.',
    inputSchema: {},
  }, async () => {
    const r = unwrap(await client.get('/v2/decisions?state=pending&assignedTo=me'), [200]);
    if ('error' in r) return r.error;
    const items = (r.value as { items: Array<{ id: string; taskId: string }> }).items;
    return ok({
      note: 'These need a human answer. An agent must not answer them.',
      items: items.map((d) => ({ ...d, answerAt: options.dashboardUrl ? `${options.dashboardUrl.replace(/\/+$/, '')}/decisions/${d.id}` : `POST /v2/decisions/${d.id}/responses (by the human)` })),
    });
  });

  server.registerTool('factory_command', {
    description: 'Pause, resume or cancel a task the developer controls. Returns a receipt; use factory_command_status to see whether it was applied. Scope, budget and ownership changes are not available to agents.',
    inputSchema: { taskId: UUID, kind: z.enum(AGENT_COMMANDS), reason: z.string().min(1).max(500), commandId: UUID.optional() },
  }, async ({ taskId, kind, reason, commandId }) => {
    const task = unwrap(await client.get(`/v2/tasks/${taskId}`), [200]);
    if ('error' in task) return task.error;
    const revision = (task.value as { revision: number }).revision;
    const r = unwrap(await client.post(`/v2/tasks/${taskId}/commands`, { commandId: commandId ?? randomUUID(), expectedRevision: revision, kind, reason }, randomUUID(), { 'if-match': String(revision) }), [202]);
    return 'error' in r ? r.error : ok(r.value);
  });

  server.registerTool('factory_command_status', {
    description: 'Get the receipt of a command: queued, delivered, applied or rejected, with the reason.',
    inputSchema: { commandId: UUID },
  }, async ({ commandId }) => {
    const r = unwrap(await client.get(`/v2/commands/${commandId}`), [200]);
    return 'error' in r ? r.error : ok(r.value);
  });

  return server;
}
