// Tiers 2 to 4 from the caller's own tasks (P-24): a review request about to expire, a task waiting
// for input, a task that stopped, a task that finished. "Yours" is creator or owner, the rule
// `/v2/me/work` already uses. Nothing else is ever listed: running, queued, paused, cancelled and
// waiting-on-someone-else tasks stay on boards and in "Your other work".
import type { QueueAdapter, QueueCandidate, QueuePriority } from '../types.ts';

type Row = { task_id: string; application_id: string; priority_class: QueuePriority; title: string | null; status: string; waiting_reason: string | null; updated_at: Date; decision_id: string | null; required_principal_id: string | null; decision_created_at: Date | null; expires_at: Date | null };
const FROM = `FROM factory.task t
  JOIN factory.task_spec_version s ON s.org_id = t.org_id AND s.task_id = t.id AND s.version = t.spec_version`;
const COLUMNS = `t.id AS task_id, t.primary_application_id AS application_id, t.priority_class, s.spec->>'title' AS title, t.status, t.waiting_reason, t.updated_at`;
const MINE = '(t.creator_id = $1 OR t.owner_principal_id = $1) AND t.primary_application_id = ANY($2::uuid[])';

export const tasksAdapter: QueueAdapter = {
  id: 'factory.tasks', kind: 'factory',
  async collect(ctx) {
    const me = ctx.principal.principalId;
    const apps = [...ctx.readableApplications.keys()];
    const cap = ctx.rules.perSourceCap;
    const limit = `LIMIT ${String(cap + 1)}`;
    const windowStart = new Date(ctx.now.getTime() - ctx.rules.windowDays * 24 * 60 * 60 * 1000);
    const soon = new Date(ctx.now.getTime() + ctx.rules.expiringWithinSeconds * 1000);
    // A request someone else must answer, running out. The task's own status is not tested: a paused
    // task's request keeps counting down.
    const expiring = await ctx.tx.query<Row>(`SELECT ${COLUMNS}, d.id AS decision_id, d.required_principal_id, d.created_at AS decision_created_at, d.expires_at
      ${FROM} JOIN factory.decision_request d ON d.org_id = t.org_id AND d.task_id = t.id
      WHERE ${MINE} AND d.state = 'pending' AND d.required_principal_id IS DISTINCT FROM $1 AND d.expires_at > $3::timestamptz AND d.expires_at <= $4::timestamptz
      ORDER BY CASE t.priority_class WHEN 'incident' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, d.expires_at, d.id ${limit}`, [me, apps, ctx.now, soon]);
    const waitingInput = await ctx.tx.query<Row>(`SELECT ${COLUMNS}, NULL::uuid AS decision_id, NULL::uuid AS required_principal_id, NULL::timestamptz AS decision_created_at, NULL::timestamptz AS expires_at
      ${FROM} WHERE ${MINE} AND t.status = 'waiting_input' ORDER BY CASE t.priority_class WHEN 'incident' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, t.updated_at, t.id ${limit}`, [me, apps]);
    // Stopped and finished are separate queries with their own caps, newest first, and acknowledged
    // items are left out here (same key format as the engine), so a pile of old finished tasks can
    // neither push a fresh failure out of the list nor leave the list empty after being marked as seen.
    const ended = (statuses: string, code: string) => ctx.tx.query<Row>(`SELECT ${COLUMNS}, NULL::uuid AS decision_id, NULL::uuid AS required_principal_id, NULL::timestamptz AS decision_created_at, NULL::timestamptz AS expires_at
      ${FROM} WHERE ${MINE} AND t.status IN (${statuses}) AND t.updated_at > $3::timestamptz
        AND NOT EXISTS (SELECT 1 FROM factory.queue_ack a WHERE a.principal_id = $1 AND a.item_key = 'task:' || t.id::text || ':${code}')
      ORDER BY CASE t.priority_class WHEN 'incident' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, t.updated_at DESC, t.id ${limit}`, [me, apps, windowStart]);
    const stopped = await ended("'failed','incomplete'", 'task_stopped');
    const finished = await ended("'succeeded'", 'task_finished');

    const base = (r: Row) => ({ priority: r.priority_class, since: r.updated_at.toISOString() });
    const items: QueueCandidate[] = [
      ...expiring.rows.slice(0, cap).flatMap((r): QueueCandidate[] => (r.decision_id && r.expires_at && r.decision_created_at ? [{
        need: 'running_out', dismissible: false, priority: r.priority_class, since: r.decision_created_at.toISOString(), expiresAt: r.expires_at.toISOString(),
        subject: { kind: 'decision', id: r.decision_id, title: r.title ?? '', taskId: r.task_id, applicationId: r.application_id },
        reason: { code: 'review_expiring', ...(r.required_principal_id ? { actorPrincipalId: r.required_principal_id } : {}) },
        action: { kind: 'open_task', taskId: r.task_id },
      }] : [])),
      ...waitingInput.rows.slice(0, cap).map((r): QueueCandidate => ({
        ...base(r), need: 'stopped', dismissible: false, subject: { kind: 'task', id: r.task_id, title: r.title ?? '', taskId: r.task_id, applicationId: r.application_id },
        reason: { code: 'task_needs_input' }, action: { kind: 'open_task', taskId: r.task_id },
      })),
      ...stopped.rows.slice(0, cap).map((r): QueueCandidate => ({
        ...base(r), need: 'stopped', dismissible: true, subject: { kind: 'task', id: r.task_id, title: r.title ?? '', taskId: r.task_id, applicationId: r.application_id },
        reason: { code: 'task_stopped', ...(r.waiting_reason ? { detailCode: r.waiting_reason } : {}) }, action: { kind: 'open_task', taskId: r.task_id },
      })),
      ...finished.rows.slice(0, cap).map((r): QueueCandidate => ({
        ...base(r), need: 'finished', dismissible: true, subject: { kind: 'task', id: r.task_id, title: r.title ?? '', taskId: r.task_id, applicationId: r.application_id },
        reason: { code: 'task_finished' }, action: { kind: 'open_task', taskId: r.task_id },
      })),
    ];
    return { items, truncated: [expiring, waitingInput, stopped, finished].some((q) => q.rows.length > cap) };
  },
};
