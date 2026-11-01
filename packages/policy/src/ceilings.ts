// Budget ceilings and explicit incomplete outcomes (INV-11; chapter 05 "Limits and stopping").
// Exhausting any ceiling stops new work and yields an explicit incomplete outcome with the unmet
// reason; it never becomes success.
export type TaskBudget = { maxMicroUsd: number; maxActiveSeconds: number; maxCalendarSeconds: number; maxAuthoringInvocations: number; maxSemanticAttemptsPerNode: number; invocationMode: 'one' | 'bounded' };
export type TaskUsage = { chargedMicroUsd: number; reservedMicroUsd: number; activeSeconds: number; calendarSeconds: number; authoringInvocations: number; maxSemanticAttemptsUsed: number };
export type CeilingCheck = { admit: true } | { admit: false; outcome: 'incomplete'; reasons: string[] };

export function checkCeilings(budget: TaskBudget, usage: TaskUsage, next: { authoring: boolean; estimateMicroUsd: number; semanticAttempt: number }): CeilingCheck {
  const reasons: string[] = [];
  const invocationCap = budget.invocationMode === 'one' ? 1 : budget.maxAuthoringInvocations;
  if (next.authoring && usage.authoringInvocations + 1 > invocationCap) reasons.push(`authoring invocation limit ${String(invocationCap)} reached`);
  if (next.semanticAttempt > budget.maxSemanticAttemptsPerNode) reasons.push(`semantic attempt limit ${String(budget.maxSemanticAttemptsPerNode)} reached`);
  if (usage.chargedMicroUsd + usage.reservedMicroUsd + next.estimateMicroUsd > budget.maxMicroUsd) reasons.push('money allowance would be exceeded');
  if (usage.activeSeconds >= budget.maxActiveSeconds) reasons.push('active execution time exhausted');
  if (usage.calendarSeconds >= budget.maxCalendarSeconds) reasons.push('calendar lifetime exhausted');
  return reasons.length === 0 ? { admit: true } : { admit: false, outcome: 'incomplete', reasons };
}

export const AUTHORING_STAGE_KINDS: ReadonlySet<string> = new Set(['execute', 'investigate', 'plan', 'criteria', 'author_regression', 'adversarial']);
