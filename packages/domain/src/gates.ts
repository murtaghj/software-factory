// Gate engine (W-012; chapter 05 "Gate definitions", chapter 04 "Backward transitions and
// invalidation", INV-04). Pure and deterministic.
//
// A gate applies only to the exact versioned input set it evaluated. Each gate declares the binding
// fields it depends on; its input hash is the canonical hash of exactly that projection. A missing
// declared field is a contract bug and throws rather than hashing an incomplete binding.
import { canonicalHash } from './canonical.ts';

export type GateId =
  | 'scope_accepted' | 'plan_accepted' | 'oracle_accepted' | 'baseline_valid' | 'canonical_package_locked' | 'outcome_verified' | 'review_passed'
  | 'adversarial_passed' | 'integration_passed' | 'release_authorized' | 'deployed_verified' | 'outcome_recorded' | 'architecture_accepted'
  | 'bootstrap_ready' | 'foundation_verified' | 'application_registered' | 'vertical_slice_verified' | 'parent_outcome_verified' | 'intent_aligned'
  | 'plan_peer_approved' | 'delivery_complete';

export type Binding = Record<string, unknown>;
const BASE = ['taskSpecVersion', 'planVersion', 'policyRef', 'workflowTemplateRef'] as const;

// Declared input projection per gate. Fields are the InputBinding names (contracts domain 2.0)
// plus the gate-specific subjects (candidateRef, recipeRef, environment, decisionRef ...).
export const GATE_INPUTS: Record<GateId, readonly string[]> = {
  scope_accepted: [...BASE, 'criteriaRef', 'scopeEvidenceRef'],
  plan_accepted: [...BASE, 'criteriaRef', 'reviewPacketRef', 'planApprovalSetRef'],
  plan_peer_approved: [...BASE, 'reviewPacketRef', 'planApprovalSetRef'],
  oracle_accepted: [...BASE, 'criteriaRef', 'canonicalPackageRef', 'oracleDecisionRef'],
  baseline_valid: [...BASE, 'canonicalPackageRef', 'baselineRef', 'environmentPlanRef'],
  canonical_package_locked: [...BASE, 'canonicalPackageRef'],
  outcome_verified: [...BASE, 'criteriaRef', 'candidateRef', 'canonicalPackageRef', 'recipeRef', 'environmentPlanRef', 'verificationReportRef'],
  review_passed: [...BASE, 'candidateRef', 'reviewReportRef'],
  adversarial_passed: [...BASE, 'candidateRef', 'adversarialReportRef'],
  integration_passed: [...BASE, 'candidateRef', 'integrationReportRef'],
  release_authorized: [...BASE, 'candidateRef', 'environment', 'releaseDecisionRef'],
  deployed_verified: [...BASE, 'candidateRef', 'environment', 'deploymentEvidenceRef'],
  outcome_recorded: [...BASE, 'outcomeManifestRef'],
  architecture_accepted: [...BASE, 'architectureRef', 'planApprovalSetRef'],
  bootstrap_ready: [...BASE, 'bootstrapPlanRef', 'bootstrapReceiptRef'],
  foundation_verified: [...BASE, 'foundationRef', 'verificationReportRef'],
  application_registered: [...BASE, 'definitionRef'],
  vertical_slice_verified: [...BASE, 'candidateRef', 'verificationReportRef'],
  parent_outcome_verified: [...BASE, 'candidateRef', 'verificationReportRef'],
  intent_aligned: [...BASE, 'intentBriefRef', 'intentDecisionRef'],
  delivery_complete: [...BASE, 'deliveryEvidenceRef'],
};

export class MissingBindingField extends Error {
  readonly gateId: GateId;
  readonly field: string;
  constructor(gateId: GateId, field: string) {
    super(`gate ${gateId} binding is missing declared input ${field}`);
    this.name = 'MissingBindingField';
    this.gateId = gateId;
    this.field = field;
  }
}

export function gateBinding(gateId: GateId, binding: Binding): Binding {
  const out: Binding = {};
  for (const field of GATE_INPUTS[gateId]) {
    if (binding[field] === undefined) throw new MissingBindingField(gateId, field);
    out[field] = binding[field];
  }
  return out;
}

export const gateInputHash = (gateId: GateId, binding: Binding): string => canonicalHash({ gateId, inputs: gateBinding(gateId, binding) });

export type Verdict = 'passed' | 'failed' | 'inconclusive';
export type GateEvaluationRecord = { id: string; gateId: GateId; inputHash: string; verdict: Verdict | 'superseded'; supersededBy?: string | null; reasonCodes: string[] };

// A gate is satisfied for a binding only by a non-superseded passing evaluation of exactly that
// binding. Older, superseded, failed or inconclusive evaluations never count.
export function currentPassing(evaluations: readonly GateEvaluationRecord[], gateId: GateId, binding: Binding): GateEvaluationRecord | undefined {
  const hash = gateInputHash(gateId, binding);
  return evaluations.find((e) => e.gateId === gateId && e.inputHash === hash && e.verdict === 'passed' && !e.supersededBy);
}

export function unmetGates(evaluations: readonly GateEvaluationRecord[], required: readonly GateId[], binding: Binding): GateId[] {
  return required.filter((g) => !currentPassing(evaluations, g, binding));
}

// Evaluations that no longer apply to the new binding (any declared input changed) and are not yet
// superseded. Unaffected evaluations (identical declared inputs) are preserved.
export function invalidatedBy(evaluations: readonly GateEvaluationRecord[], next: Binding): GateEvaluationRecord[] {
  return evaluations.filter((e) => {
    if (e.supersededBy || e.verdict === 'superseded') return false;
    try {
      return gateInputHash(e.gateId, next) !== e.inputHash;
    } catch (err) {
      if (err instanceof MissingBindingField) return true; // the input it relied on no longer exists
      throw err;
    }
  });
}

// --- Evaluators for the gates the M1 slice exercises. Evidence is parsed, finalized artifact
// content supplied by the trusted evaluator Activity; nothing here reads an author's claim.

export type Finding = { severity: 'critical' | 'high' | 'medium' | 'low'; blocking?: boolean; resolved?: boolean; violatesCriterion?: boolean };
export type GateDecision = { verdict: Verdict; reasonCodes: string[] };

export function evaluateScopeAccepted(e: { criteriaIds?: unknown; mappedCriteriaIds?: unknown; blockingGaps?: unknown }): GateDecision {
  if (!Array.isArray(e.criteriaIds) || !Array.isArray(e.mappedCriteriaIds) || !Array.isArray(e.blockingGaps)) return { verdict: 'inconclusive', reasonCodes: ['scope_evidence_malformed'] };
  const unmapped = (e.criteriaIds as unknown[]).filter((c) => !(e.mappedCriteriaIds as unknown[]).includes(c));
  if ((e.criteriaIds as unknown[]).length === 0) return { verdict: 'failed', reasonCodes: ['no_criteria'] };
  if (unmapped.length > 0) return { verdict: 'failed', reasonCodes: ['criteria_unmapped'] };
  if ((e.blockingGaps as unknown[]).length > 0) return { verdict: 'failed', reasonCodes: ['blocking_context_gap'] };
  return { verdict: 'passed', reasonCodes: ['criteria_mapped', 'no_blocking_gaps'] };
}

// review_passed: no unresolved blocking findings on the current artifact, from a reviewer that is
// independent of the author (chapter 05: critical/high block; medium blocks when it violates a
// criterion; low is informational).
export function evaluateReviewPassed(e: { findings?: unknown; reviewerProducerId?: unknown; authorProducerIds?: unknown; scopeReviewed?: unknown }): GateDecision {
  if (!Array.isArray(e.findings) || typeof e.reviewerProducerId !== 'string' || !Array.isArray(e.authorProducerIds) || e.scopeReviewed !== true) return { verdict: 'inconclusive', reasonCodes: ['review_evidence_malformed_or_scope_insufficient'] };
  if ((e.authorProducerIds as unknown[]).includes(e.reviewerProducerId)) return { verdict: 'failed', reasonCodes: ['reviewer_not_independent'] };
  const blocking = (e.findings as Finding[]).filter((f) => !f.resolved && (f.severity === 'critical' || f.severity === 'high' || f.blocking === true || (f.severity === 'medium' && f.violatesCriterion === true)));
  return blocking.length > 0 ? { verdict: 'failed', reasonCodes: ['unresolved_blocking_findings'] } : { verdict: 'passed', reasonCodes: ['no_blocking_findings'] };
}

// outcome_recorded is evaluated from the real OutcomeManifest: see outcome.ts.

// --- Gate-set resolution with risk escalation (chapter 05 "Assurance" and "Proportional
// scrutiny"). The effective tier is the maximum of requested, application minimum and discovered
// risk; any risk trigger forces enhanced. Escalation only adds gates; it never removes one.
export type Assurance = 'fast' | 'standard' | 'enhanced';
export type RiskTrigger = 'public_api_change' | 'auth_or_authorization' | 'payment' | 'data_sensitivity' | 'persistent_data_migration' | 'several_services' | 'unknown_blast_radius' | 'critical_application' | 'privileged_infrastructure' | 'performance_risk';
const RANK: Record<Assurance, number> = { fast: 0, standard: 1, enhanced: 2 };

// Triggers are policy-profile names (e.g. RiskTrigger values or the profile's own vocabulary).
export function effectiveAssurance(requested: Assurance, applicationMinimum: Assurance, triggers: readonly string[]): Assurance {
  const floor = triggers.length > 0 ? 'enhanced' : 'fast';
  return ([requested, applicationMinimum, floor] as Assurance[]).reduce((a, b) => (RANK[b] > RANK[a] ? b : a));
}

const ENHANCED_GATES: Partial<Record<string, GateId[]>> = {
  // Executable outcomes under enhanced scrutiny add independent oracle and adversarial evidence.
  execute: ['oracle_accepted', 'adversarial_passed'],
  verify: ['oracle_accepted', 'adversarial_passed'],
  review: ['adversarial_passed'],
};

export function requiredGatesFor(node: { stageKind: string; requiredGateIds: readonly string[] }, assurance: Assurance): GateId[] {
  const base = node.requiredGateIds as GateId[];
  const extra = assurance === 'enhanced' ? (ENHANCED_GATES[node.stageKind] ?? []) : [];
  return [...new Set([...base, ...extra])];
}
