// Ordered, resumable task event stream (W-014, AC-52; chapter 03 "Event envelope and ordering").
// - The SSE `id` is the per-task event sequence. Last-Event-ID takes precedence over `after`.
// - A cursor older than the retained window gets 410 EventCursorExpired before the stream opens.
//   It carries snapshotUrl/resumeAfterSequence, so the client can refresh the snapshot and resume.
// - A keepalive comment goes every 15 s; buffers are bounded (pages of 100); authorization is
//   re-checked while the stream is open.
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { EventCursorExpired, TaskEvent } from '@factory/contracts';
import type { Database, Tx } from '@factory/database';
import type { Principal } from '../auth/rbac.ts';
import { problem, sendProblem } from '../http/problem.ts';

export type StreamOptions = { retentionMs: number; pollMs?: number; keepaliveMs?: number; reauthorizeMs?: number };
type EventRow = { id: string; org_id: string; task_id: string; sequence: string; event_type: string; occurred_at: Date; recorded_at: Date; source: string; correlation_id: string; payload_ref: TaskEvent['payloadRef']; schema_version: string };

export function toTaskEvent(r: EventRow): TaskEvent {
  return { eventId: r.id, orgId: r.org_id, taskId: r.task_id, sequence: Number(r.sequence), eventType: r.event_type, occurredAt: r.occurred_at.toISOString(), recordedAt: r.recorded_at.toISOString(), source: r.source, correlationId: r.correlation_id, payloadRef: r.payload_ref, schemaVersion: '2.0' };
}

export function parseCursor(req: FastifyRequest<{ Querystring: { after?: string } }>): number | undefined {
  const header = req.headers['last-event-id'];
  const raw = typeof header === 'string' && header.length > 0 ? header : req.query.after;
  if (raw === undefined) return 0;
  return /^\d{1,15}$/.test(raw) ? Number(raw) : undefined;
}

export async function streamTaskEvents(req: FastifyRequest<{ Params: { taskId: string }; Querystring: { after?: string } }>, reply: FastifyReply, deps: {
  db: Database; principal: Principal; canRead: () => Promise<boolean>; options: StreamOptions;
}): Promise<FastifyReply | undefined> {
  const { taskId } = req.params;
  const cursor = parseCursor(req);
  if (cursor === undefined) return sendProblem(reply, problem(400, 'invalid_cursor', 'Last-Event-ID / after must be a nonnegative integer', req.id));
  const tenant = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => deps.db.withTenant({ orgId: deps.principal.orgId, principalId: deps.principal.principalId }, fn);
  const window = await tenant(async (tx) => (await tx.query<{ floor: string | null; last: string }>(
    `SELECT (SELECT min(sequence) FROM factory.task_event WHERE task_id = $1 AND recorded_at >= now() - make_interval(secs => $2::bigint / 1000.0)) AS floor,
            (SELECT last_event_sequence FROM factory.task WHERE id = $1) AS last`, [taskId, deps.options.retentionMs])).rows[0] ?? { floor: null, last: '0' });
  const last = Number(window.last);
  const floor = window.floor === null ? last + 1 : Number(window.floor);
  if (cursor < floor - 1) {
    const snapshotUrl = `/v2/tasks/${taskId}`;
    const body: EventCursorExpired = { ...problem(410, 'event_cursor_expired', `events after ${String(cursor)} are no longer retained; refresh the snapshot and resume after its lastEventSequence`, req.id), status: 410, code: 'event_cursor_expired', snapshotUrl, resumeAfterSequence: last };
    return reply.code(410).header('content-type', 'application/problem+json').header('location', snapshotUrl).send(body);
  }
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-store', connection: 'keep-alive', 'x-accel-buffering': 'no', 'x-request-id': req.id });
  const conn = { closed: false };
  req.raw.on('close', () => { conn.closed = true; });
  let position = cursor;
  let lastWrite = Date.now();
  let lastAuth = Date.now();
  const poll = deps.options.pollMs ?? 250;
  const keepalive = deps.options.keepaliveMs ?? 15_000;
  const reauth = deps.options.reauthorizeMs ?? 15_000;
  try {
    while (!conn.closed) {
      const rows = await tenant(async (tx) => (await tx.query<EventRow>('SELECT id, org_id, task_id, sequence, event_type, occurred_at, recorded_at, source, correlation_id, payload_ref, schema_version FROM factory.task_event WHERE task_id = $1 AND sequence > $2 ORDER BY sequence LIMIT 100', [taskId, position])).rows);
      for (const row of rows) {
        const e = toTaskEvent(row);
        if (!res.write(`id: ${String(e.sequence)}\nevent: ${e.eventType}\ndata: ${JSON.stringify(e)}\n\n`)) await new Promise((r) => res.once('drain', r));
        position = e.sequence;
        lastWrite = Date.now();
      }
      if (rows.length === 100) continue;
      if (Date.now() - lastWrite >= keepalive) { res.write(': keepalive\n\n'); lastWrite = Date.now(); }
      if (Date.now() - lastAuth >= reauth) {
        lastAuth = Date.now();
        if (!(await deps.canRead())) { res.write('event: reauthenticate\ndata: {}\n\n'); break; }
      }
      await new Promise((r) => setTimeout(r, poll));
    }
  } finally {
    res.end();
  }
  return undefined;
}
