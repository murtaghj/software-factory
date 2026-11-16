// Tier 1: decisions waiting on the caller (P-24). Every pending, unexpired request that names the
// caller as the required principal, on any task in a project they can read.
import type { QueueAdapter, QueueCandidate, QueuePriority } from '../types.ts';

type Row = { id: string; action: string; created_at: Date; expires_at: Date; task_id: string; application_id: string; owner_principal_id: string; priority_class: QueuePriority; title: string | null };

export const decisionsAdapter: QueueAdapter = {
  id: 'factory.decisions', kind: 'factory',
  async collect(ctx) {
    const me = ctx.principal.principalId;
    const r = await ctx.tx.query<Row>(`SELECT d.id, d.action, d.created_at, d.expires_at, t.id AS task_id, t.primary_application_id AS application_id, t.owner_principal_id, t.priority_class, s.spec->>'title' AS title
      FROM factory.decision_request d
      JOIN factory.task t ON t.org_id = d.org_id AND t.id = d.task_id
      JOIN factory.task_spec_version s ON s.org_id = t.org_id AND s.task_id = t.id AND s.version = t.spec_version
      WHERE d.state = 'pending' AND d.required_principal_id = $1 AND d.expires_at > $2::timestamptz AND t.primary_application_id = ANY($3::uuid[])
      ORDER BY CASE t.priority_class WHEN 'incident' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, d.expires_at, d.id LIMIT ${String(ctx.rules.perSourceCap + 1)}`, [me, ctx.now, [...ctx.readableApplications.keys()]]);
    const items = r.rows.slice(0, ctx.rules.perSourceCap).map((d): QueueCandidate => ({
      need: 'blocked_on_you', dismissible: false, priority: d.priority_class, since: d.created_at.toISOString(), expiresAt: d.expires_at.toISOString(),
      subject: { kind: 'decision', id: d.id, title: d.title ?? '', taskId: d.task_id, applicationId: d.application_id },
      reason: { code: 'answer_needed', detailCode: d.action, ...(d.owner_principal_id === me ? {} : { actorPrincipalId: d.owner_principal_id }) },
      action: { kind: 'answer_decision', decisionId: d.id },
    }));
    return { items, truncated: r.rows.length > ctx.rules.perSourceCap };
  },
};
