import { describe, expect, it } from 'vitest';
import { decodeRunnerResult } from '@factory/contracts';
import { MissingBindingField, currentPassing, effectiveAssurance, evaluateReviewPassed, evaluateScopeAccepted, gateInputHash, invalidatedBy, requiredGatesFor, unmetGates, type Binding, type GateEvaluationRecord } from '../src/index.ts';

const ref = (n: string) => ({ artifactId: `00000000-0000-4000-8000-${n.padStart(12, '0')}`, sha256: n.repeat(64).slice(0, 64), mediaType: 'application/json', schemaVersion: '2.0', sizeBytes: 1 });
const base: Binding = { taskSpecVersion: 1, planVersion: 1, policyRef: ref('1'), workflowTemplateRef: { id: 'existing_feature', version: '3.0.0', definitionRef: ref('2') } };
const verifyBinding = (candidate: string, recipe = '9'): Binding => ({ ...base, criteriaRef: ref('3'), candidateRef: ref(candidate), canonicalPackageRef: ref('4'), recipeRef: ref(recipe), environmentPlanRef: ref('5'), verificationReportRef: ref('6') });
const passed = (id: string, gateId: GateEvaluationRecord['gateId'], b: Binding): GateEvaluationRecord => ({ id, gateId, inputHash: gateInputHash(gateId, b), verdict: 'passed', reasonCodes: [] });

describe('AC-24 source binding changes', () => {
  it('a passing gate for candidate C cannot approve candidate C2', () => {
    const c = verifyBinding('a');
    const c2 = verifyBinding('b');
    const evals = [passed('e1', 'outcome_verified', c)];
    expect(currentPassing(evals, 'outcome_verified', c)?.id).toBe('e1');
    expect(currentPassing(evals, 'outcome_verified', c2)).toBeUndefined();
    expect(unmetGates(evals, ['outcome_verified'], c2)).toEqual(['outcome_verified']);
  });

  it('a candidate or required recipe change supersedes C\'s result; unrelated evidence is preserved', () => {
    const c = verifyBinding('a');
    const scopeBinding = { ...c, scopeEvidenceRef: ref('7') };
    const evals = [passed('verify-c', 'outcome_verified', c), passed('scope', 'scope_accepted', scopeBinding)];
    expect(invalidatedBy(evals, { ...scopeBinding, candidateRef: ref('b') }).map((e) => e.id)).toEqual(['verify-c']);
    expect(invalidatedBy(evals, { ...scopeBinding, recipeRef: ref('8') }).map((e) => e.id)).toEqual(['verify-c']);
    expect(invalidatedBy(evals, scopeBinding)).toEqual([]); // nothing material changed
    expect(invalidatedBy(evals, { ...scopeBinding, planVersion: 2 }).map((e) => e.id).sort()).toEqual(['scope', 'verify-c']);
    // once superseded, an evaluation never counts again, even for its own original binding
    const superseded = evals.map((e) => (e.id === 'verify-c' ? { ...e, supersededBy: 'marker' } : e));
    expect(currentPassing(superseded, 'outcome_verified', c)).toBeUndefined();
  });

  it('a binding missing a declared input is a contract bug, never a partial hash', () => {
    const incomplete = Object.fromEntries(Object.entries(verifyBinding('a')).filter(([k]) => k !== 'recipeRef'));
    expect(() => gateInputHash('outcome_verified', incomplete)).toThrow(MissingBindingField);
    expect(invalidatedBy([passed('v', 'outcome_verified', verifyBinding('a'))], incomplete).map((e) => e.id)).toEqual(['v']);
  });
});

describe('AC-33 risk escalation (gate set)', () => {
  it('any risk trigger forces enhanced, whatever was requested or how small the diff is', () => {
    expect(effectiveAssurance('fast', 'fast', [])).toBe('fast');
    expect(effectiveAssurance('fast', 'standard', [])).toBe('standard');
    expect(effectiveAssurance('fast', 'fast', ['auth_or_authorization'])).toBe('enhanced');
    expect(effectiveAssurance('standard', 'fast', ['public_api_change'])).toBe('enhanced');
    expect(effectiveAssurance('enhanced', 'fast', [])).toBe('enhanced'); // never lowered
  });

  it('enhanced adds the relevant independent gates to executable nodes and never removes declared ones', () => {
    const execute = { stageKind: 'execute', requiredGateIds: [] };
    const verify = { stageKind: 'verify', requiredGateIds: ['outcome_verified'] };
    expect(requiredGatesFor(execute, 'standard')).toEqual([]);
    expect(requiredGatesFor(execute, 'enhanced')).toEqual(['oracle_accepted', 'adversarial_passed']);
    expect(requiredGatesFor(verify, 'enhanced')).toEqual(['outcome_verified', 'oracle_accepted', 'adversarial_passed']);
    expect(requiredGatesFor(verify, 'fast')).toEqual(['outcome_verified']);
  });
});

describe('AC-44 stale production approval (gate binding)', () => {
  const release = (candidate: string, environment: string, policy: string, decision: string): Binding => ({ ...base, policyRef: ref(policy), candidateRef: ref(candidate), environment, releaseDecisionRef: ref(decision) });
  it('a release authorization applies only to the exact candidate, environment, policy and decision it evaluated', () => {
    const approved = release('a', 'production-eu', '1', 'd');
    const evals = [passed('rel', 'release_authorized', approved)];
    expect(currentPassing(evals, 'release_authorized', approved)?.id).toBe('rel');
    for (const changed of [release('b', 'production-eu', '1', 'd'), release('a', 'production-us', '1', 'd'), release('a', 'production-eu', '2', 'd'), release('a', 'production-eu', '1', 'e')]) {
      expect(currentPassing(evals, 'release_authorized', changed)).toBeUndefined();
      expect(invalidatedBy(evals, changed).map((e) => e.id)).toEqual(['rel']);
    }
  });
});

describe('AC-18 malformed agent output (gate half)', () => {
  it('malformed output yields no outcome and no gate evidence, so no gate can pass', () => {
    const decoded = decodeRunnerResult('{"status":"completed","verdict":"approve"}', { orgId: 'o', taskId: 't', stageRunId: 's', inputHash: 'h', allocationEpoch: 1 });
    expect(decoded.ok).toBe(false);
    expect(evaluateReviewPassed({ findings: 'none', reviewerProducerId: 'r' }).verdict).toBe('inconclusive');
    expect(evaluateScopeAccepted({ criteriaIds: ['c1'] }).verdict).toBe('inconclusive');
    const review = { ...base, candidateRef: ref('a'), reviewReportRef: ref('b') };
    expect(unmetGates([], ['review_passed'], review)).toEqual(['review_passed']);
  });

  it('review evidence must come from an independent reviewer with sufficient scope and no unresolved blockers', () => {
    expect(evaluateReviewPassed({ findings: [], reviewerProducerId: 'author', authorProducerIds: ['author'], scopeReviewed: true }).reasonCodes).toEqual(['reviewer_not_independent']);
    expect(evaluateReviewPassed({ findings: [{ severity: 'high' }], reviewerProducerId: 'r', authorProducerIds: ['a'], scopeReviewed: true }).verdict).toBe('failed');
    expect(evaluateReviewPassed({ findings: [{ severity: 'medium', violatesCriterion: true }], reviewerProducerId: 'r', authorProducerIds: ['a'], scopeReviewed: true }).verdict).toBe('failed');
    expect(evaluateReviewPassed({ findings: [{ severity: 'high', resolved: true }, { severity: 'low' }], reviewerProducerId: 'r', authorProducerIds: ['a'], scopeReviewed: true }).verdict).toBe('passed');
    expect(evaluateReviewPassed({ findings: [], reviewerProducerId: 'r', authorProducerIds: ['a'], scopeReviewed: false }).verdict).toBe('inconclusive');
  });
});
