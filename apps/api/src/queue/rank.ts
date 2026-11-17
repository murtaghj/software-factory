// Ranking for the "what needs you next" queue (P-24). Pure: no clock, no database. The server decides
// the order and clients render it as received, so no ranking rule lives in a client.
import { QUEUE_ACTION_KINDS, QUEUE_NEEDS, QUEUE_REASON_CODES, type QueueCandidate, type QueueItem, type QueueNeed, type QueuePriority, type QueueRules, type QueueTier } from './types.ts';

export const EXPIRING_WINDOW_MS = 24 * 60 * 60 * 1000;
export const ALLOWANCE_LOW_PERCENT = 10;
export const WINDOW_DAYS = 14;
export const PER_SOURCE_CAP = 100;
export const QUEUE_CAP = 100;
export const QUEUE_RULES: QueueRules = { tiers: QUEUE_NEEDS, expiringWithinSeconds: EXPIRING_WINDOW_MS / 1000, allowanceLowPercent: ALLOWANCE_LOW_PERCENT, windowDays: WINDOW_DAYS };

const PRIORITY_ORDER: Record<QueuePriority, number> = { incident: 0, normal: 1, background: 2 };
export const tierOf = (need: QueueNeed): QueueTier => (QUEUE_NEEDS.indexOf(need) + 1) as QueueTier;
export const keyOf = (c: Pick<QueueCandidate, 'subject' | 'reason'>): string => `${c.subject.kind}:${c.subject.id}:${c.reason.code}`;

// One candidate from one source, before it is trusted. `sourceOrder` is the source's registration index.
export type Ranked = { candidate: QueueCandidate; sourceId: string; sourceOrder: number };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// The shape the ack endpoint accepts; a shown item must have a key that matches it.
export const KEY_FORMAT = /^[a-z]+:[A-Za-z0-9._-]{1,100}:[a-z_]{1,60}$/;
export const BUDGET_SOURCE = 'factory.budget';

// Why a candidate is not acceptable, or undefined. An adapter's own SQL filter is the first
// authorization check; this is the second. Task and decision subjects must name a project the caller
// can read; an allowance subject comes only from the budget source.
export function validateCandidate(c: unknown, readable: ReadonlyMap<string, string>, sourceId: string): string | undefined {
  if (typeof c !== 'object' || c === null) return 'not an object';
  const x = c as Partial<QueueCandidate>;
  if (!x.need || !(QUEUE_NEEDS as readonly string[]).includes(x.need)) return 'unknown need';
  if (!x.reason || !(QUEUE_REASON_CODES as readonly string[]).includes(x.reason.code)) return 'unknown reason';
  if (!x.action || !(QUEUE_ACTION_KINDS as readonly string[]).includes(x.action.kind)) return 'unknown action';
  if (!x.subject || typeof x.subject.id !== 'string' || typeof x.subject.title !== 'string' || !['decision', 'task', 'allowance'].includes(x.subject.kind)) return 'bad subject';
  if (typeof x.since !== 'string' || Number.isNaN(Date.parse(x.since))) return 'bad since';
  if (x.expiresAt !== undefined && Number.isNaN(Date.parse(x.expiresAt))) return 'bad expiry';
  if (!x.priority || !Object.hasOwn(PRIORITY_ORDER, x.priority)) return 'bad priority';
  if (typeof x.dismissible !== 'boolean') return 'bad dismissible';
  if (x.need === 'blocked_on_you' && x.dismissible) return 'a blocking item cannot be dismissed';
  if (x.action.kind === 'answer_decision' && (typeof x.action.decisionId !== 'string' || !UUID.test(x.action.decisionId))) return 'bad decision id';
  if (!KEY_FORMAT.test(keyOf({ subject: x.subject, reason: x.reason }))) return 'key cannot be acknowledged';
  if (x.subject.kind === 'allowance') {
    if (sourceId !== BUDGET_SOURCE) return 'allowance subject from another source';
  } else if (x.subject.applicationId === undefined || !readable.has(x.subject.applicationId)) return 'application not readable';
  if (x.subject.taskId !== undefined && (typeof x.subject.taskId !== 'string' || !UUID.test(x.subject.taskId))) return 'bad task id';
  if (x.reason.actorPrincipalId !== undefined && (typeof x.reason.actorPrincipalId !== 'string' || !UUID.test(x.reason.actorPrincipalId))) return 'bad actor';
  if (x.action.kind === 'open_task' && x.subject.taskId !== undefined && x.action.taskId !== x.subject.taskId) return 'action and subject name different tasks';
  return undefined;
}

// Tier, then incident-first, then soonest deadline (items without one last), then longest waiting,
// then key, which makes the order total and repeatable.
export function compareItems(a: { tier: number; candidate: QueueCandidate; key: string }, b: { tier: number; candidate: QueueCandidate; key: string }): number {
  const ea = a.candidate.expiresAt === undefined ? Number.POSITIVE_INFINITY : Date.parse(a.candidate.expiresAt);
  const eb = b.candidate.expiresAt === undefined ? Number.POSITIVE_INFINITY : Date.parse(b.candidate.expiresAt);
  return a.tier - b.tier
    || PRIORITY_ORDER[a.candidate.priority] - PRIORITY_ORDER[b.candidate.priority]
    || (ea === eb ? 0 : ea < eb ? -1 : 1)
    || Date.parse(a.candidate.since) - Date.parse(b.candidate.since)
    || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

// Drops acknowledged dismissible items, dedupes by key (lowest tier wins, then the earlier source),
// sorts, cuts at `cap` and numbers from 1.
export function rankQueue(input: Ranked[], acked: ReadonlySet<string>, cap: number = QUEUE_CAP): { items: QueueItem[]; truncated: boolean } {
  const best = new Map<string, { r: Ranked; key: string; tier: QueueTier }>();
  for (const r of input) {
    const key = keyOf(r.candidate);
    if (r.candidate.dismissible && acked.has(key)) continue;
    const tier = tierOf(r.candidate.need);
    const have = best.get(key);
    if (!have || tier < have.tier || (tier === have.tier && r.sourceOrder < have.r.sourceOrder)) best.set(key, { r, key, tier });
  }
  const sorted = [...best.values()].map((b) => ({ tier: b.tier, candidate: b.r.candidate, key: b.key, sourceId: b.r.sourceId })).sort(compareItems);
  return { truncated: sorted.length > cap, items: sorted.slice(0, cap).map((s, i): QueueItem => ({ ...s.candidate, key: s.key, rank: i + 1, tier: s.tier, sourceId: s.sourceId })) };
}
