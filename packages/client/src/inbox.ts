// Decision inbox (plan-additions P-02): only what is waiting on the signed-in person. The list
// comes from the API's own filter (`assignedTo=me`), so the server decides whose inbox it is. A
// response is built here for a human to send; the workflow still re-checks subject, revision,
// decider and reviewed scope when it applies it.
import { label } from './wording.ts';
import { validateContract, type DecisionResponse, type DecisionView, type PlanSectionId } from '@factory/contracts';

export const PLAN_SECTION_IDS: readonly PlanSectionId[] = ['intent_scope', 'current_state', 'design', 'interfaces_data', 'implementation', 'acceptance_tests', 'quality_security', 'delivery_recovery', 'operations', 'risks_decisions', 'definition_of_done', 'review_ownership'];
export const INBOX_PATH = '/v2/decisions?state=pending&assignedTo=me';
export const EXPIRES_SOON_MS = 24 * 60 * 60 * 1000;

const ACTION_LABELS: Partial<Record<DecisionView['action'], string>> = { approve_plan: 'Approve plan', confirm_intent: 'Confirm intent', approve_rule_exception: 'Approve rule exception' };
export type InboxItem = {
  id: string; taskId: string; action: DecisionView['action']; label: string; reason: string; subjectHash: string;
  expiresAt: string; expiresInSeconds: number; urgency: 'expired' | 'soon' | 'normal';
  // Sections a reviewer must have read before approving; empty for decisions without a packet.
  sectionsToReview: readonly PlanSectionId[];
};
export type InboxModel = { items: InboxItem[]; summary: string };

export function inboxModel(decisions: DecisionView[], nowMs: number): InboxModel {
  const items = decisions.filter((d) => d.state === 'pending').map((d): InboxItem => {
    const left = Date.parse(d.expiresAt) - nowMs;
    return {
      id: d.id, taskId: d.taskId, action: d.action, label: ACTION_LABELS[d.action] ?? d.action.replace(/_/g, ' '), reason: d.reason, subjectHash: d.subjectHash, expiresAt: d.expiresAt,
      expiresInSeconds: Math.floor(left / 1000), urgency: left <= 0 ? 'expired' : left <= EXPIRES_SOON_MS ? 'soon' : 'normal',
      sectionsToReview: d.action === 'approve_plan' ? PLAN_SECTION_IDS : [],
    };
  }).sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt) || a.id.localeCompare(b.id)); // soonest to expire first
  const soon = items.filter((i) => i.urgency === 'soon').length;
  const summary = items.length === 0 ? 'Nothing is waiting on you.' : `${String(items.length)} waiting on you${soon > 0 ? `, ${String(soon)} expiring within a day` : ''}.`;
  return { items, summary };
}

export type ResponseInput = { outcome: DecisionResponse['outcome']; reason: string; reviewedSectionIds: PlanSectionId[]; commandId: string; expectedRevision: number };
export type BuiltResponse = { ok: true; body: DecisionResponse } | { ok: false; problems: string[] };

// Builds the response a person is about to send. It refuses, before any request is made, what the
// workflow would refuse anyway: an expired item, an approval that has not covered every section,
// or an empty reason. It never fills in sections on the reviewer's behalf.
export function buildDecisionResponse(item: InboxItem, input: ResponseInput): BuiltResponse {
  const problems: string[] = [];
  if (item.urgency === 'expired') problems.push('This request has expired and can no longer be answered.');
  if (input.reason.trim().length === 0) problems.push('A reason is required.');
  const missing = item.sectionsToReview.filter((s) => !input.reviewedSectionIds.includes(s));
  if (input.outcome === 'approve' && missing.length > 0) problems.push(`Approval needs every section reviewed; missing: ${missing.map((m) => label(m)).join(', ')}.`);
  if (problems.length > 0) return { ok: false, problems };
  const body = { commandId: input.commandId, expectedRevision: input.expectedRevision, subjectHash: item.subjectHash, outcome: input.outcome, reason: input.reason.trim(), reviewedSectionIds: item.sectionsToReview.filter((s) => input.reviewedSectionIds.includes(s)), actorKind: 'human' as const };
  const valid = validateContract('DecisionResponse', body);
  return valid.ok ? { ok: true, body: valid.value } : { ok: false, problems: valid.errors.slice(0, 5).map((e) => `${e.path || '/'} ${e.message}`) };
}

// Fetches the caller's inbox. `request` performs an authenticated GET and returns the parsed body.
export async function fetchInbox(request: (path: string) => Promise<{ status: number; body: unknown }>, nowMs: number): Promise<InboxModel> {
  const r = await request(INBOX_PATH);
  if (r.status !== 200) throw new Error(`inbox request failed with status ${String(r.status)}`);
  const items = (r.body as { items?: unknown }).items;
  if (!Array.isArray(items)) throw new Error('inbox response has no items');
  const decisions: DecisionView[] = [];
  for (const d of items) {
    const v = validateContract('DecisionView', d);
    if (!v.ok) throw new Error('inbox response contains an invalid DecisionView');
    decisions.push(v.value);
  }
  return inboxModel(decisions, nowMs);
}
