// The ranked "what needs you next" queue (plan-additions P-24): client-side shapes mirrored by hand
// from the API (`apps/api/src/queue/types.ts`, like MyWork; A-21) and the words for them. The server
// ranks; this file never sorts, filters or decides. Every switch falls back to words for a code it
// does not know, so a later source's new codes still render.
import { label, relativeTime, timeLeft, usd } from './wording.ts';
import type { StageDescriptor, Station } from './work.ts';

export const QUEUE_PATH = '/v2/me/queue';
export const QUEUE_ACK_PATH = '/v2/me/queue/acks';
export const QUEUE_SCHEMA = 'factory-queue/1';
export type QueueNeed = 'blocked_on_you' | 'running_out' | 'stopped' | 'finished';
export type QueueReasonCode = 'answer_needed' | 'review_expiring' | 'allowance_low' | 'allowance_used_up' | 'task_needs_input' | 'task_stopped' | 'task_finished';
export type QueueSubject = { kind: 'decision' | 'task' | 'allowance'; id: string; title: string; taskId?: string; applicationId?: string };
export type QueueReason = { code: QueueReasonCode; actorPrincipalId?: string; detailCode?: string; remainingMicroUsd?: number; limitMicroUsd?: number };
export type QueueAction = { kind: 'answer_decision'; decisionId: string } | { kind: 'open_task'; taskId: string } | { kind: 'open_budget' };
export type QueueItem = {
  key: string; rank: number; tier: 1 | 2 | 3 | 4; sourceId: string; need: QueueNeed; subject: QueueSubject; reason: QueueReason; action: QueueAction;
  dismissible: boolean; priority: 'incident' | 'normal' | 'background'; since: string; expiresAt?: string; stage?: StageDescriptor;
};
export type QueueSourceStatus = { id: string; kind: 'factory' | 'external'; status: 'ok' | 'degraded'; problem?: 'failed' | 'timed_out' | 'invalid_items' | 'stale'; items: number; truncated: boolean };
export type QueueRules = { tiers: readonly QueueNeed[]; expiringWithinSeconds: number; allowanceLowPercent: number; windowDays: number };
export type Queue = {
  schema: typeof QUEUE_SCHEMA; principalId: string; generatedAt: string; items: QueueItem[]; sources: QueueSourceStatus[]; degraded: boolean; truncated: boolean;
  rules: QueueRules; stations: Station[]; applications: Record<string, string>; people: Record<string, string>;
};

// Refuses a body that is not this version of the queue, so a drifted server is noticed, not guessed at.
export function parseQueue(body: unknown): Queue {
  const q = body as Partial<Queue> | null;
  if (typeof q !== 'object' || q === null || q.schema !== QUEUE_SCHEMA || !Array.isArray(q.items) || !Array.isArray(q.sources)) throw new Error('the queue response is not in a format this client understands');
  return { ...q, stations: q.stations ?? [] } as Queue; // an older server sends no stations
}

const NEED_LABELS: Record<string, string> = { blocked_on_you: 'Blocked on you', running_out: 'About to run out', stopped: 'Stopped', finished: 'Finished' };
const RULE_LINES: Record<string, string> = {
  blocked_on_you: 'Someone is blocked on you', running_out: 'Something of yours is about to run out',
  stopped: 'Something of yours stopped and needs a decision', finished: 'Something of yours finished and needs a look',
};
const SOURCE_LABELS: Record<string, string> = { 'factory.decisions': 'Reviews and approvals', 'factory.tasks': 'Your tasks', 'factory.budget': 'Budget' };
export const needLabel = (need: string): string => NEED_LABELS[need] ?? label(need);
export const sourceLabel = (id: string): string => SOURCE_LABELS[id] ?? label(id);

const nameOf = (queue: Pick<Queue, 'people'>, id: string | undefined): string => (id === undefined ? undefined : queue.people[id]) ?? 'Someone';

// The short reason, for a table cell, and when it applies (so a view can keep the exact time in
// <time> markup). "expires" is a deadline ("2 days left"); "since" is when it started ("3 hours ago").
export function reasonOf(item: QueueItem, queue: Pick<Queue, 'people'>): { lead: string; when?: { kind: 'expires' | 'since'; iso: string } } {
  const r = item.reason;
  const expires = item.expiresAt === undefined ? {} : { when: { kind: 'expires' as const, iso: item.expiresAt } };
  switch (r.code) {
    case 'answer_needed': return { lead: r.actorPrincipalId ? `${nameOf(queue, r.actorPrincipalId)} is blocked on you` : 'Your task is waiting for your answer', ...expires };
    case 'review_expiring': return { lead: `${nameOf(queue, r.actorPrincipalId)} has not answered your review request`, ...expires };
    case 'allowance_low': return { lead: `${usd(r.remainingMicroUsd)} left of ${usd(r.limitMicroUsd)}` };
    case 'allowance_used_up': return { lead: 'Your allowance for this month is used up' };
    case 'task_needs_input': return { lead: 'Your task is waiting for input from you' };
    case 'task_stopped': return { lead: r.detailCode ? label(r.detailCode) : 'It stopped before finishing', when: { kind: 'since', iso: item.since } };
    case 'task_finished': return { lead: 'Take a look at the result', when: { kind: 'since', iso: item.since } };
    default: return { lead: label(String(r.code)) };
  }
}
// The same reason as plain sentences, for text clients (CLI, agents): "Stopped in Orders API 3 hours
// ago. The review request expired."
export function reasonText(item: QueueItem, queue: Pick<Queue, 'people'> & Partial<Pick<Queue, 'applications'>>, nowMs: number): string {
  const r = item.reason;
  const { lead } = reasonOf(item, queue);
  const left = item.expiresAt === undefined ? '' : timeLeft(item.expiresAt, nowMs);
  const where = item.subject.applicationId ? queue.applications?.[item.subject.applicationId] : undefined;
  const ago = relativeTime(item.since, nowMs);
  const started = (verb: string): string => [verb, where ? `in ${where}` : '', ago].filter((x) => x !== '').join(' ');
  switch (r.code) {
    case 'answer_needed': return left ? `${lead}. ${left}.` : `${lead}.`;
    case 'review_expiring': return left ? `${lead}. ${left}, and the task stops if it expires.` : `${lead}. The task stops if it expires.`;
    case 'allowance_low': return `You have ${usd(r.remainingMicroUsd)} left of your ${usd(r.limitMicroUsd)} allowance this month.`;
    case 'allowance_used_up': return `${lead}. New tasks are refused until it is raised.`;
    case 'task_stopped': return r.detailCode ? `${started('Stopped')}. ${lead}.` : `${started('Stopped')}.`;
    case 'task_finished': return `${started('Finished')}. ${lead}.`;
    default: return `${lead}.`;
  }
}
export function actionOf(item: QueueItem): { label: string } {
  switch (item.action.kind) {
    case 'answer_decision': return { label: 'Review now' };
    case 'open_budget': return { label: 'Open budget' };
    case 'open_task': return { label: item.reason.code === 'task_stopped' ? 'See why it stopped' : item.reason.code === 'task_finished' ? 'See the result' : 'Open task' };
    default: return { label: 'Open' };
  }
}
export const DISMISS_LABEL = 'Mark as seen';

// Set when a source could not be read. Never say "Nothing needs you" over a list that may be missing items.
export function degradedNote(queue: Queue): string | undefined {
  if (!queue.degraded) return undefined;
  const names = queue.sources.filter((s) => s.status !== 'ok').map((s) => sourceLabel(s.id));
  return `Could not check: ${names.length > 0 ? names.join(', ') : 'part of your list'}. This list may be incomplete.`;
}
export const TRUNCATED_NOTE = 'More needs you than can be shown; the least urgent are not listed.';
export const TRUNCATED_EMPTY_NOTE = 'Some items could not be shown here, so this list may be incomplete.';
// Why the list may be missing items, if it may: a source that could not be read, or a cap that cut it.
export function incompleteNote(queue: Queue): string | undefined {
  return degradedNote(queue) ?? (queue.truncated ? (queue.items.length > 0 ? TRUNCATED_NOTE : TRUNCATED_EMPTY_NOTE) : undefined);
}
export function queueHeadline(queue: Queue, nowMs: number): string {
  const first = queue.items[0];
  if (first) return `Next: "${first.subject.title}" — ${reasonText(first, queue, nowMs)}`;
  return incompleteNote(queue) ?? 'Nothing needs you.';
}
export const ORDER_RULE = 'Within a group: incidents first, then the soonest deadline, then the longest waiting. Work that is running or waiting on someone else is not listed.';
export function rulesText(queue: Pick<Queue, 'rules'>): string[] {
  return [...queue.rules.tiers.map((t) => RULE_LINES[t] ?? label(t)), ORDER_RULE];
}
