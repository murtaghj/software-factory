// Outcome provenance and the outcome_recorded evaluator (W-016; chapter 05 "ReviewMode", INV-16,
// INV-29). Pure rules: callers supply a resolver that maps an ArtifactRef to the record it names
// (from the ArtifactStore and control-plane rows at runtime; from a fixture bundle in contract tests).
// Contract validation is injected too, so this module stays free of the validator at runtime (it is
// reachable from workflow code through the package index).
import type { OutcomeManifest } from '@factory/contracts';
import type { GateDecision } from './gates.ts';

export const AI_REVIEW_MARKER = 'AI-reviewed — no human review';
// Fields whose refs carry human authority: each MUST resolve to an authenticated human record.
export const HUMAN_AUTHORITY_FIELDS = ['decisionRefs', 'voluntaryHumanReviewRefs', 'unreproducedDecisionRef'] as const;
// Fields that only an ai_only outcome may carry. Presence alone (even an empty list) counts.
export const AI_OUTCOME_FIELDS = ['reviewModeDecisionRef', 'reviewMarker', 'reviewSubjectRef', 'aiReviewApprovalSetRefs'] as const;

export type RefLike = { artifactId: string; sha256: string; mediaType: string; schemaVersion: string; sizeBytes: number };
// What a ref resolves to. 'ai' means the ref names an AI review decision or approval set;
// 'mismatch' means the artifact is known but the ref's digest/size/media fields differ; 'unknown'
// means it names nothing the resolver can authenticate.
export type ResolvedAuthority = { kind: 'human'; record: Record<string, unknown>; decidedAt?: string } | { kind: 'ai' } | { kind: 'mismatch' } | { kind: 'unknown' };
export type ContractCheck = (contract: 'DecisionView' | 'DecisionResponse' | 'PlanApprovalSet' | 'IntentApprovalSet' | 'OutcomeManifest', value: unknown) => boolean;
export type ProvenanceVerdict = { ok: true; humanRecords: number } | { ok: false; reason: string; field?: string };

const isRef = (v: unknown): v is RefLike => typeof v === 'object' && v !== null && typeof (v as RefLike).artifactId === 'string' && typeof (v as RefLike).sha256 === 'string';
const refsOf = (v: unknown): unknown[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

// A human record is a DecisionView or DecisionResponse that validates, says actorKind human and
// approves, or a Plan/IntentApprovalSet whose own decisionRefs resolve the same way. A rejected or
// pending decision cannot be cited as authority for an outcome.
type Walk = { resolve: (ref: RefLike) => ResolvedAuthority; validate: ContractCheck; taskId: unknown; completedAt: number; count: number };
function authority(ref: unknown, w: Walk, active: ReadonlySet<string>): string | undefined {
  if (!isRef(ref)) return 'malformed_human_reference';
  if (active.has(ref.artifactId)) return 'cyclic_human_reference';
  const r = w.resolve(ref);
  if (r.kind === 'ai') return 'ai_decision_presented_as_human';
  if (r.kind === 'mismatch') return 'human_reference_mismatch';
  if (r.kind === 'unknown') return 'unknown_human_reference';
  const rec = r.record;
  if (rec.decisionKind === 'ai_review') return 'ai_decision_presented_as_human';
  if (rec.actorKind !== 'human') return 'non_human_approval_record';
  if (typeof rec.taskId === 'string' && rec.taskId !== w.taskId) return 'human_record_for_another_task';
  if (r.decidedAt !== undefined && !(Date.parse(r.decidedAt) <= w.completedAt)) return 'outcome_predates_authority';
  if (Array.isArray(rec.decisionRefs)) {
    const kind = 'confirmationSubjectRef' in rec ? 'IntentApprovalSet' : 'PlanApprovalSet';
    if (!w.validate(kind, rec)) return 'invalid_human_record';
    if (rec.decisionRefs.length === 0) return 'empty_human_approval_set';
    const inner = new Set([...active, ref.artifactId]);
    for (const nested of rec.decisionRefs) { const bad = authority(nested, w, inner); if (bad) return bad; }
  } else if ('outcome' in rec) {
    if (!w.validate('DecisionResponse', rec)) return 'invalid_human_record';
    if (rec.outcome !== 'approve') return 'human_decision_does_not_approve';
  } else {
    if (!w.validate('DecisionView', rec)) return 'invalid_human_record';
    if (rec.state !== 'approved') return 'human_decision_does_not_approve';
  }
  w.count += 1;
  return undefined;
}

// INV-29 for one OutcomeManifest. Human positions resolve before mode checks, so an AI ref hidden
// in a human field is named as such in either mode. AI fields require ai_only and the marker, even
// when the mode was omitted (chapter 05). A manifest with neither AI fields nor a mode is a legacy
// human output (positive-output-legacy). ai_only is refused unless the caller supports it: the AI
// panel predicates (W-141–W-143) are not part of this release.
export function checkOutcomeProvenance(manifest: Record<string, unknown>, resolve: (ref: RefLike) => ResolvedAuthority, opts: { aiOnlySupported: boolean; validate: ContractCheck }): ProvenanceVerdict {
  const w: Walk = { resolve, validate: opts.validate, taskId: manifest.taskId, completedAt: typeof manifest.completedAt === 'string' ? Date.parse(manifest.completedAt) : Number.NaN, count: 0 };
  for (const field of HUMAN_AUTHORITY_FIELDS) {
    for (const ref of refsOf(manifest[field])) {
      const bad = authority(ref, w, new Set());
      if (bad) return { ok: false, reason: bad, field };
    }
  }
  const aiField = AI_OUTCOME_FIELDS.find((f) => f in manifest);
  const mode = manifest.reviewMode;
  if (mode === undefined && aiField !== undefined) return { ok: false, reason: 'ai_fields_without_review_mode', field: aiField };
  if (mode !== undefined && mode !== 'human' && mode !== 'ai_only') return { ok: false, reason: 'unknown_review_mode' };
  if (mode === 'human' && aiField !== undefined) return { ok: false, reason: 'ai_fields_require_ai_only', field: aiField };
  if (mode === 'ai_only') {
    if (manifest.reviewMarker !== AI_REVIEW_MARKER) return { ok: false, reason: 'missing_review_marker', field: 'reviewMarker' };
    if (!opts.aiOnlySupported) return { ok: false, reason: 'ai_only_not_supported' };
  }
  return { ok: true, humanRecords: w.count };
}

export type OutcomeFacts = {
  manifest: unknown;
  taskId: string;
  deliveryScope: string;
  // Delivered refs whose bytes were read back and digest-verified from the ArtifactStore.
  verifiedDeliveredRefs: number;
  provenance: ProvenanceVerdict;
  // Every temporary resource has a known owner and expiry, or cleanup is complete.
  cleanupKnown: boolean;
  validate: ContractCheck;
};

// outcome_recorded: the requested artifact/report and its provenance exist, and resource owner/expiry
// or cleanup is known (chapter 05 gate table). Evaluated on the real manifest, never on a claim.
export function evaluateOutcomeRecorded(f: OutcomeFacts): GateDecision {
  if (!f.validate('OutcomeManifest', f.manifest)) return { verdict: 'failed', reasonCodes: ['outcome_manifest_invalid'] };
  const m = f.manifest as OutcomeManifest;
  if (m.taskId !== f.taskId) return { verdict: 'failed', reasonCodes: ['outcome_manifest_wrong_task'] };
  if (m.deliveryScope !== f.deliveryScope) return { verdict: 'failed', reasonCodes: ['outcome_delivery_scope_mismatch'] };
  if (m.deliveredArtifactRefs.length === 0) return { verdict: 'failed', reasonCodes: ['no_delivered_artifact'] };
  if (f.verifiedDeliveredRefs !== m.deliveredArtifactRefs.length) return { verdict: 'failed', reasonCodes: ['delivered_artifact_unverified'] };
  if (m.gateEvaluationRefs.length === 0) return { verdict: 'failed', reasonCodes: ['no_gate_provenance'] };
  if (!f.provenance.ok) return { verdict: 'failed', reasonCodes: [`provenance_${f.provenance.reason}`] };
  if (!f.cleanupKnown) return { verdict: 'failed', reasonCodes: ['cleanup_owner_or_expiry_unknown'] };
  return { verdict: 'passed', reasonCodes: ['outcome_recorded'] };
}

// Runtime resolution of the human-authority refs in a manifest. I/O is injected: `read` returns the
// digest-verified record (undefined when the bytes cannot be verified), `decision` returns the
// control-plane row for a decision request, `isAi` says whether a ref names an AI review record.
// A record resolves as human only when it agrees with the immutable decision row in every field
// that carries authority; anything else is unknown, never promoted.
export type HumanDecisionFact = { requestId: string; taskId: string; deciderId: string; actorKind: string; state: string; subjectHash: string; decidedAt: string };
export type AuthorityIo = { read: (ref: RefLike) => Promise<unknown>; decision: (requestId: string) => Promise<HumanDecisionFact | undefined>; isAi: (ref: RefLike) => Promise<boolean> };
const refKey = (r: RefLike): string => [r.artifactId, r.sha256, r.mediaType, r.schemaVersion, String(r.sizeBytes)].join('|');

export async function resolveAuthorities(manifest: Record<string, unknown>, io: AuthorityIo): Promise<(ref: RefLike) => ResolvedAuthority> {
  const resolved = new Map<string, ResolvedAuthority>();
  for (const field of HUMAN_AUTHORITY_FIELDS) {
    for (const ref of refsOf(manifest[field])) {
      if (!isRef(ref) || resolved.has(refKey(ref))) continue;
      if (await io.isAi(ref)) { resolved.set(refKey(ref), { kind: 'ai' }); continue; }
      const record = await io.read(ref);
      if (typeof record !== 'object' || record === null) { resolved.set(refKey(ref), { kind: 'unknown' }); continue; }
      const r = record as Record<string, unknown>;
      const fact = typeof r.id === 'string' ? await io.decision(r.id) : undefined;
      const agrees = fact !== undefined && fact.actorKind === 'human' && fact.deciderId === r.deciderId && fact.state === r.state && fact.subjectHash === r.subjectHash && fact.taskId === r.taskId;
      resolved.set(refKey(ref), agrees ? { kind: 'human', record: r, decidedAt: fact.decidedAt } : { kind: 'unknown' });
    }
  }
  return (ref) => resolved.get(refKey(ref)) ?? { kind: 'unknown' };
}
