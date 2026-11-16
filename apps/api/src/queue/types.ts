// The ranked "what needs you next" queue (plan-additions P-24; A-21). API-local, mirrored by hand in
// packages/client/src/queue.ts like MyWork (A-18): the generated contracts follow the read-only spec.
import type { Tx } from '@factory/database';
import type { Principal } from '../auth/rbac.ts';

export const QUEUE_SCHEMA = 'factory-queue/1';
// Position in this array + 1 is the tier. This is the fixed ranking.
export const QUEUE_NEEDS = ['blocked_on_you', 'running_out', 'stopped', 'finished'] as const;
export type QueueNeed = (typeof QUEUE_NEEDS)[number];
export type QueueTier = 1 | 2 | 3 | 4;
export const QUEUE_REASON_CODES = ['answer_needed', 'review_expiring', 'allowance_low', 'allowance_used_up', 'task_needs_input', 'task_stopped', 'task_finished'] as const;
export type QueueReasonCode = (typeof QUEUE_REASON_CODES)[number];
export const QUEUE_ACTION_KINDS = ['answer_decision', 'open_task', 'open_budget'] as const;
export type QueueSubject = { kind: 'decision' | 'task' | 'allowance'; id: string; title: string; taskId?: string; applicationId?: string };
export type QueueReason = {
  code: QueueReasonCode;
  actorPrincipalId?: string; // who is blocked on you, or who has not answered
  detailCode?: string; // decision action, or task.waiting_reason
  remainingMicroUsd?: number; limitMicroUsd?: number;
};
// Exactly one per item.
export type QueueAction = { kind: 'answer_decision'; decisionId: string } | { kind: 'open_task'; taskId: string } | { kind: 'open_budget' };
export type QueuePriority = 'incident' | 'normal' | 'background';

// What an adapter returns.
export type QueueCandidate = {
  need: QueueNeed; subject: QueueSubject; reason: QueueReason; action: QueueAction;
  dismissible: boolean;
  priority: QueuePriority; // task.priority_class; 'normal' when there is no task
  since: string; // ISO: when this started needing you
  expiresAt?: string; // ISO: hard deadline, if any
};
// What the API returns. The engine adds these four; an adapter cannot set them.
export type QueueItem = QueueCandidate & { key: string; rank: number; tier: QueueTier; sourceId: string };

export type QueueSourceStatus = { id: string; kind: 'factory' | 'external'; status: 'ok' | 'degraded'; problem?: 'failed' | 'timed_out' | 'invalid_items' | 'stale'; items: number; truncated: boolean };
export type QueueRules = { tiers: readonly QueueNeed[]; expiringWithinSeconds: number; allowanceLowPercent: number; windowDays: number };
export type Queue = {
  schema: typeof QUEUE_SCHEMA; principalId: string; generatedAt: string;
  items: QueueItem[]; // already ranked; rank is 1..n
  sources: QueueSourceStatus[]; degraded: boolean; // degraded = any source not ok
  truncated: boolean; rules: QueueRules; // rules are sent so every client can show them
  applications: Record<string, string>; people: Record<string, string>;
};

export type QueueContext = {
  principal: Principal; // orgId, principalId, groups, grants
  tx: Tx; // already inside withTenant({ orgId, principalId }): RLS and embargo policies apply
  now: Date; // one instant for the whole request
  readableApplications: ReadonlyMap<string, string>; // id -> name; applications where authorize(p, 'task.read') allows
  rules: QueueRules & { perSourceCap: number };
};
export type QueueAdapter = {
  id: string; kind: 'factory' | 'external';
  collect(ctx: QueueContext): Promise<{ items: QueueCandidate[]; truncated: boolean }>;
};
