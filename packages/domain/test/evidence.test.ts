import { describe, expect, it } from 'vitest';
import { evaluateBugRedLockGreen, evaluateCriteriaEvidence, type ExecutionReport, type FailureSignature } from '../src/index.ts';

const signature: FailureSignature = { framework: 'fixture-test-runner', frameworkVersion: '1.0.0', scenarioIds: ['dup'], intendedAssertionMatchers: ['expected reservation count 1; observed 2'], minimumExecutedTests: 1, rejectedClasses: ['compile', 'setup', 'discovery', 'network', 'timeout'] };
const env = (sourceDigest: string, extra: Record<string, string> = {}) => ({ releaseId: sourceDigest, sourceDigest, equivalence: { pg: '18.6', seed: 's1', ...extra } });
const report = (over: Partial<ExecutionReport> = {}): ExecutionReport => ({
  framework: 'fixture-test-runner', frameworkVersion: '1.0.0', packageId: 'p@1', packageDigest: 'd'.repeat(64), environment: env('b'), discovered: 2, executed: 2,
  runs: [{ scenarioId: 'dup', criterionIds: ['BUG-1'], outcome: 'assertion_failed', message: 'expected reservation count 1; observed 2' }, { scenarioId: 'reg', criterionIds: ['REG-1'], outcome: 'passed' }],
  ...over,
});
const green = (over: Partial<ExecutionReport> = {}): ExecutionReport => report({ environment: env('c'), runs: [{ scenarioId: 'dup', criterionIds: ['BUG-1'], outcome: 'passed' }, { scenarioId: 'reg', criterionIds: ['REG-1'], outcome: 'passed' }], ...over });
const locked = 'd'.repeat(64);

describe('INV-05 bug red/lock/green predicate', () => {
  it('verifies only the complete combination', () => {
    expect(evaluateBugRedLockGreen({ signature, lockedPackageDigest: locked, baseline: report(), candidate: green() }).verdict).toBe('verified');
  });
  it.each([
    ['baseline passed (not reproduced)', report({ runs: [{ scenarioId: 'dup', criterionIds: [], outcome: 'passed' }] }), green(), 'invalid'],
    ['wrong assertion', report({ runs: [{ scenarioId: 'dup', criterionIds: [], outcome: 'assertion_failed', message: 'expected order status code 201; observed 500' }] }), green(), 'invalid'],
    ['baseline timeout', report({ runs: [{ scenarioId: 'dup', criterionIds: [], outcome: 'timeout' }] }), green(), 'inconclusive'],
    ['baseline unknown error', report({ runs: [{ scenarioId: 'dup', criterionIds: [], outcome: 'error', message: 'TypeError' }] }), green(), 'inconclusive'],
    ['profiled scenario missing from baseline', report({ runs: [] }), green(), 'invalid'],
    ['candidate regression fails', report(), green({ runs: [{ scenarioId: 'dup', criterionIds: [], outcome: 'passed' }, { scenarioId: 'reg', criterionIds: [], outcome: 'assertion_failed' }] }), 'invalid'],
    ['candidate skipped tests', report(), green({ executed: 1 }), 'inconclusive'],
    ['different package on candidate', report(), green({ packageDigest: 'e'.repeat(64) }), 'invalid'],
    ['different framework', report({ frameworkVersion: '2.0.0' }), green(), 'invalid'],
    ['environments not comparable', report(), green({ environment: env('c', { seed: 's2' }) }), 'invalid'],
    ['same source on both sides', report(), green({ environment: env('b') }), 'invalid'],
    ['below minimum executed', report({ executed: 0, discovered: 0 }), green(), 'inconclusive'],
  ] as const)('%s → %s', (_label, baseline, candidate, verdict) => {
    expect(evaluateBugRedLockGreen({ signature, lockedPackageDigest: locked, baseline, candidate }).verdict).toBe(verdict);
  });
});

describe('INV-06 criteria evidence predicate', () => {
  it('requires every criterion to be covered by passing executed scenarios', () => {
    expect(evaluateCriteriaEvidence(['REG-1'], green()).complete).toBe(true);
    expect(evaluateCriteriaEvidence(['REG-1', 'X'], green()).unmet).toEqual([{ criterionId: 'X', reason: 'no executed scenario covers this criterion' }]);
    expect(evaluateCriteriaEvidence(['BUG-1'], report()).complete).toBe(false);
    expect(evaluateCriteriaEvidence(['REG-1'], green({ executed: 1 })).complete).toBe(false);
  });
});
