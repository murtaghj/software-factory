import { describe, expect, it } from 'vitest';
import { checkCeilings, type TaskBudget, type TaskUsage } from '../src/index.ts';

const budget: TaskBudget = { maxMicroUsd: 10, maxActiveSeconds: 100, maxCalendarSeconds: 1000, maxAuthoringInvocations: 3, maxSemanticAttemptsPerNode: 2, invocationMode: 'bounded' };
const used: TaskUsage = { chargedMicroUsd: 0, reservedMicroUsd: 0, activeSeconds: 0, calendarSeconds: 0, authoringInvocations: 0, maxSemanticAttemptsUsed: 0 };

describe('INV-11 ceilings give explicit incomplete outcomes', () => {
  it('invocation mode one admits exactly one authoring invocation', () => {
    expect(checkCeilings({ ...budget, invocationMode: 'one' }, used, { authoring: true, estimateMicroUsd: 1, semanticAttempt: 1 })).toEqual({ admit: true });
    expect(checkCeilings({ ...budget, invocationMode: 'one' }, { ...used, authoringInvocations: 1 }, { authoring: true, estimateMicroUsd: 1, semanticAttempt: 1 })).toEqual({ admit: false, outcome: 'incomplete', reasons: ['authoring invocation limit 1 reached'] });
    expect(checkCeilings({ ...budget, invocationMode: 'one' }, { ...used, authoringInvocations: 1 }, { authoring: false, estimateMicroUsd: 1, semanticAttempt: 1 })).toEqual({ admit: true });
  });
  it.each([
    ['semantic attempts', used, { semanticAttempt: 3 }, 'semantic attempt limit 2 reached'],
    ['money', { ...used, chargedMicroUsd: 8 }, { estimateMicroUsd: 3 }, 'money allowance would be exceeded'],
    ['active time', { ...used, activeSeconds: 100 }, {}, 'active execution time exhausted'],
    ['calendar', { ...used, calendarSeconds: 1000 }, {}, 'calendar lifetime exhausted'],
    ['bounded invocations', { ...used, authoringInvocations: 3 }, { authoring: true }, 'authoring invocation limit 3 reached'],
  ] as const)('exhausted %s → incomplete', (_l, usage, next, reason) => {
    const r = checkCeilings(budget, usage, { authoring: false, estimateMicroUsd: 0, semanticAttempt: 1, ...next });
    expect(r).toEqual({ admit: false, outcome: 'incomplete', reasons: [reason] });
  });
});
