// Shared helpers for full-stack system tests.
import { randomUUID } from 'node:crypto';
import type { DecisionView, TaskView } from '@factory/contracts';
import type { SystemHarness, SystemUser } from '../src/index.ts';

export const investigation = (applicationId: string, over: Record<string, unknown> = {}) => ({
  schemaVersion: '2.0', title: 'Why do some orders fail after a retry?', intent: 'Explain intermittent order failures with evidence and limitations.', applicationIds: [applicationId], workType: 'investigation',
  acceptanceCriteria: ['The report distinguishes observations, inference and open questions.', 'Competing explanations are compared with evidence.'], assurance: 'standard', deliveryScope: 'report',
  budget: { maxMicroUsd: 25_000_000, maxActiveSeconds: 3600, maxCalendarSeconds: 86_400, maxAuthoringInvocations: 4, maxSemanticAttemptsPerNode: 3, maxDesignReturns: 2, invocationMode: 'bounded' },
  targetContext: { kind: 'existing_application', applicationId }, ...over,
});

export async function pump<T>(h: SystemHarness, probe: () => Promise<T | undefined>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    await h.temporal?.dispatch();
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error('condition not reached in time');
    await new Promise((r) => setTimeout(r, 50));
  }
}

export async function createTask(h: SystemHarness, user: SystemUser, over: Record<string, unknown> = {}): Promise<string> {
  const r = await h.call(user, 'POST', '/v2/tasks', investigation(h.applicationId, over), { 'idempotency-key': randomUUID() });
  if (r.status !== 202) throw new Error(`task creation failed: ${JSON.stringify(r.body)}`);
  return (r.body as { taskId: string }).taskId;
}

export const getTask = async (h: SystemHarness, user: SystemUser, taskId: string): Promise<TaskView> => (await h.call(user, 'GET', `/v2/tasks/${taskId}`)).body as TaskView;

export async function waitStatus(h: SystemHarness, user: SystemUser, taskId: string, statuses: string[]): Promise<TaskView> {
  return pump(h, async () => { const t = await getTask(h, user, taskId); return statuses.includes(t.status) ? t : undefined; });
}

export async function pendingDecision(h: SystemHarness, user: SystemUser, taskId: string, notId?: string): Promise<DecisionView> {
  return pump(h, async () => {
    const page = (await h.call(user, 'GET', `/v2/decisions?taskId=${taskId}&state=pending`)).body as { items: DecisionView[] };
    return page.items.find((d) => d.id !== notId);
  });
}

export const ALL_SECTIONS = ['intent_scope', 'current_state', 'design', 'interfaces_data', 'implementation', 'acceptance_tests', 'quality_security', 'delivery_recovery', 'operations', 'risks_decisions', 'definition_of_done', 'review_ownership'];

export async function respond(h: SystemHarness, user: SystemUser, taskId: string, d: DecisionView, over: Record<string, unknown> = {}): Promise<{ status: number; body: unknown }> {
  const t = await getTask(h, user, taskId);
  return h.call(user, 'POST', `/v2/decisions/${d.id}/responses`, { commandId: randomUUID(), expectedRevision: t.revision, subjectHash: d.subjectHash, outcome: 'approve', reason: 'Plan reviewed in full.', reviewedSectionIds: ALL_SECTIONS, ...over }, { 'idempotency-key': randomUUID() });
}

export async function command(h: SystemHarness, user: SystemUser, taskId: string, kind: string, extra: Record<string, unknown> = {}): Promise<{ status: number; body: unknown; commandId: string }> {
  const t = await getTask(h, user, taskId);
  const commandId = randomUUID();
  const r = await h.call(user, 'POST', `/v2/tasks/${taskId}/commands`, { commandId, expectedRevision: t.revision, kind, reason: `test ${kind}`, ...extra }, { 'idempotency-key': randomUUID(), 'if-match': String(t.revision) });
  return { ...r, commandId };
}

export async function commandState(h: SystemHarness, user: SystemUser, commandId: string): Promise<{ state: string; reason?: string }> {
  return pump(h, async () => { const r = (await h.call(user, 'GET', `/v2/commands/${commandId}`)).body as { state: string; reason?: string }; return ['applied', 'rejected'].includes(r.state) ? r : undefined; });
}
