// AC-54 / INV-29 contract tests for outcome provenance and the outcome_recorded evaluator. The
// ai-review OutcomeManifest fixtures are run through checkOutcomeProvenance with a resolver built
// from each fixture's own bundle: refs listed under bundle.decisions / approvalSetRef are AI
// records, refs under bundle.humanArtifacts are human records (exact ref match), anything else is
// unknown. Each negative must be rejected for its stated reason; each positive must pass every
// human-provenance check (ai_only positives then stop only at ai_only_not_supported).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateContract } from '@factory/contracts';
import { AI_REVIEW_MARKER, checkOutcomeProvenance, evaluateOutcomeRecorded, resolveAuthorities, type ContractCheck, type HumanDecisionFact, type RefLike, type ResolvedAuthority } from '../src/index.ts';

const dir = join(import.meta.dirname, '..', '..', '..', 'docs', 'spec', 'examples', 'ai-review');
type Fixture = { kind: string; value: Record<string, unknown>; bundle?: Bundle; error?: string };
type Entry = { ref: RefLike; value: Record<string, unknown> };
type Bundle = { decisions?: Entry[]; priorDecisions?: Entry[]; approvalSetRef?: RefLike; humanArtifacts?: Entry[]; reviewBundles?: Bundle[] };
const load = (f: string): Fixture => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Fixture;
const validate: ContractCheck = (contract, value) => validateContract(contract, value).ok;
const sameRef = (a: RefLike, b: RefLike) => a.artifactId === b.artifactId && a.sha256 === b.sha256 && a.mediaType === b.mediaType && a.schemaVersion === b.schemaVersion && a.sizeBytes === b.sizeBytes;

function fixtureResolver(bundle: Bundle | undefined): (ref: RefLike) => ResolvedAuthority {
  const bundles = bundle ? [bundle, ...(bundle.reviewBundles ?? [])] : [];
  const ai = new Set<string>();
  const human: Entry[] = [];
  for (const b of bundles) {
    for (const e of [...(b.decisions ?? []), ...(b.priorDecisions ?? [])]) { ai.add(e.ref.artifactId); if (typeof e.value.id === 'string') ai.add(e.value.id); }
    if (b.approvalSetRef) ai.add(b.approvalSetRef.artifactId);
    human.push(...(b.humanArtifacts ?? []));
  }
  return (ref) => {
    if (ai.has(ref.artifactId)) return { kind: 'ai' };
    const h = human.find((e) => e.ref.artifactId === ref.artifactId);
    if (!h) return { kind: 'unknown' };
    return sameRef(h.ref, ref) ? { kind: 'human', record: h.value } : { kind: 'mismatch' };
  };
}

// Reference-predicate error text (tools/review_mode_validation.py) → this module's reason codes.
const REFERENCE_ERRORS: Record<string, string[]> = {
  'AI decision presented as human approval': ['ai_decision_presented_as_human'],
  'unknown or cyclic human approval reference': ['unknown_human_reference', 'cyclic_human_reference'],
  'human artifact ref mismatch': ['human_reference_mismatch'],
};
const NEGATIVES: Record<string, string[]> = {
  'negative-outcomemanifest-ai_only-ai-in-decisionRefs.json': ['ai_decision_presented_as_human'],
  'negative-outcomemanifest-ai_only-ai-in-voluntaryHumanReviewRefs.json': ['ai_decision_presented_as_human'],
  'negative-outcomemanifest-human-ai-in-decisionRefs.json': ['ai_decision_presented_as_human'],
  'negative-outcomemanifest-human-ai-in-voluntaryHumanReviewRefs.json': ['ai_decision_presented_as_human'],
  'negative-outcomemanifest-legacy-ai-in-decisionRefs.json': ['ai_decision_presented_as_human'],
  'negative-outcomemanifest-legacy-ai-in-voluntaryHumanReviewRefs.json': ['ai_decision_presented_as_human'],
  'negative-outcomemanifest-unknown-human-ref.json': ['unknown_human_reference'],
  'negative-output-cyclic-human-ref.json': ['cyclic_human_reference'],
  'negative-output-mismatched-human-ref.json': ['human_reference_mismatch'],
  'negative-output-nested-ai-human-ref.json': ['ai_decision_presented_as_human'],
  'negative-outcomemanifest-ai-fields-human-mode.json': ['ai_fields_require_ai_only'],
  'negative-outcomemanifest-without-reviewMarker.json': ['missing_review_marker'],
  'negative-outcomemanifest-without-reviewMode-reviewMarker.json': ['ai_fields_without_review_mode'],
};

describe('AC-54 end-to-end audit: outcome provenance (INV-29) on the ai-review fixtures', () => {
  for (const [file, reasons] of Object.entries(NEGATIVES)) {
    it(`rejects ${file}`, () => {
      const f = load(file);
      expect(f.kind).toBe('OutcomeManifest');
      if (f.error) expect(REFERENCE_ERRORS[f.error]).toEqual(expect.arrayContaining(reasons)); // our reason is the reference predicate's
      const v = checkOutcomeProvenance(f.value, fixtureResolver(f.bundle), { aiOnlySupported: false, validate });
      expect(v.ok).toBe(false);
      expect(reasons).toContain(v.ok ? '' : v.reason);
    });
  }

  it('accepts the human-mode positive and resolves its voluntary human review', () => {
    const f = load('positive-output-human.json');
    expect(checkOutcomeProvenance(f.value, fixtureResolver(f.bundle), { aiOnlySupported: false, validate })).toEqual({ ok: true, humanRecords: 1 });
  });

  it('accepts a legacy output with neither AI fields nor a mode, but not once an AI field appears', () => {
    const f = load('positive-output-legacy.json');
    expect(f.value.reviewMode).toBeUndefined();
    expect(checkOutcomeProvenance(f.value, fixtureResolver(f.bundle), { aiOnlySupported: false, validate }).ok).toBe(true);
    const withAi = { ...f.value, aiReviewApprovalSetRefs: [] };
    expect(checkOutcomeProvenance(withAi, fixtureResolver(f.bundle), { aiOnlySupported: false, validate })).toMatchObject({ ok: false, reason: 'ai_fields_without_review_mode' });
  });

  it('ai_only positives pass every human-provenance check, including nested approval sets, and are then refused as unsupported', () => {
    for (const file of ['positive-output-voluntary-human.json', 'positive-output-nested-human.json']) {
      const f = load(file);
      expect(f.value.reviewMarker).toBe(AI_REVIEW_MARKER);
      expect(checkOutcomeProvenance(f.value, fixtureResolver(f.bundle), { aiOnlySupported: false, validate })).toEqual({ ok: false, reason: 'ai_only_not_supported' });
    }
    // The nested positive resolves two human records: the approval set and the decision inside it.
    const nested = load('positive-output-nested-human.json');
    expect(checkOutcomeProvenance(nested.value, fixtureResolver(nested.bundle), { aiOnlySupported: true, validate })).toEqual({ ok: true, humanRecords: 2 });
  });

  it('a human record that does not approve, or belongs to another task, is not authority', () => {
    const f = load('positive-output-human.json');
    const entry = f.bundle?.humanArtifacts?.[0];
    if (!entry) throw new Error('fixture has no human artifact');
    const rejected = { ...f.bundle, humanArtifacts: [{ ...entry, value: { ...entry.value, state: 'rejected' } }] };
    expect(checkOutcomeProvenance(f.value, fixtureResolver(rejected), { aiOnlySupported: false, validate })).toMatchObject({ ok: false, reason: 'human_decision_does_not_approve' });
    const elsewhere = { ...f.bundle, humanArtifacts: [{ ...entry, value: { ...entry.value, taskId: '00000000-0000-4000-8000-00000000ffff' } }] };
    expect(checkOutcomeProvenance(f.value, fixtureResolver(elsewhere), { aiOnlySupported: false, validate })).toMatchObject({ ok: false, reason: 'human_record_for_another_task' });
    const nonHuman = { ...f.bundle, humanArtifacts: [{ ...entry, value: { ...entry.value, actorKind: 'service' } }] };
    expect(checkOutcomeProvenance(f.value, fixtureResolver(nonHuman), { aiOnlySupported: false, validate })).toMatchObject({ ok: false, reason: 'non_human_approval_record' });
  });
});

describe('AC-54 runtime resolution of human authority', () => {
  const f = load('positive-output-human.json');
  const entry = f.bundle?.humanArtifacts?.[0];
  if (!entry) throw new Error('fixture has no human artifact');
  const fact: HumanDecisionFact = { requestId: String(entry.value.id), taskId: String(entry.value.taskId), deciderId: String(entry.value.deciderId), actorKind: 'human', state: 'approved', subjectHash: String(entry.value.subjectHash), decidedAt: '2026-10-29T12:00:00Z' };
  const io = (over: { fact?: HumanDecisionFact | undefined; record?: unknown; ai?: boolean } = {}) => ({
    read: () => Promise.resolve('record' in over ? over.record : entry.value),
    decision: () => Promise.resolve('fact' in over ? over.fact : fact),
    isAi: () => Promise.resolve(over.ai ?? false),
  });
  const run = async (o: Parameters<typeof io>[0], manifest: Record<string, unknown> = f.value) => checkOutcomeProvenance(manifest, await resolveAuthorities(manifest, io(o)), { aiOnlySupported: false, validate });

  it('resolves a record only when it agrees with the immutable decision row', async () => {
    expect(await run({})).toEqual({ ok: true, humanRecords: 1 });
    expect(await run({ fact: undefined })).toMatchObject({ ok: false, reason: 'unknown_human_reference' });
    expect(await run({ fact: { ...fact, deciderId: '00000000-0000-4000-8000-0000000000aa' } })).toMatchObject({ ok: false, reason: 'unknown_human_reference' });
    expect(await run({ fact: { ...fact, state: 'rejected' } })).toMatchObject({ ok: false, reason: 'unknown_human_reference' });
    expect(await run({ record: undefined })).toMatchObject({ ok: false, reason: 'unknown_human_reference' }); // bytes failed digest verification
    expect(await run({ ai: true })).toMatchObject({ ok: false, reason: 'ai_decision_presented_as_human' });
  });

  it('an outcome completed before its authority was given is rejected', async () => {
    expect(await run({ fact: { ...fact, decidedAt: '2026-10-29T12:30:00Z' } })).toMatchObject({ ok: false, reason: 'outcome_predates_authority' });
  });
});

describe('AC-54 outcome_recorded is evaluated on the real manifest', () => {
  const ref = (n: string): RefLike => ({ artifactId: `00000000-0000-4000-8000-${n.padStart(12, '0')}`, sha256: n.repeat(64).slice(0, 64), mediaType: 'application/json', schemaVersion: '2.0', sizeBytes: 10 });
  const taskId = '00000000-0000-4000-8000-000000000002';
  const manifest = { schemaVersion: '2.0', taskId, status: 'succeeded', deliveryScope: 'report', outcomeKind: 'delivered', deliveredArtifactRefs: [ref('a')], providerHandles: ['temporal:workflow:x'], gateEvaluationRefs: [ref('b')], decisionRefs: [], usage: [], limitations: [], knowledgeProposalIds: [], cleanupObligationRefs: [], completedAt: '2026-10-29T12:00:00Z', reviewMode: 'human' };
  const facts = { manifest, taskId, deliveryScope: 'report', verifiedDeliveredRefs: 1, provenance: { ok: true as const, humanRecords: 0 }, cleanupKnown: true, validate };

  it('passes only when every fact holds', () => {
    expect(validateContract('OutcomeManifest', manifest).ok).toBe(true);
    expect(evaluateOutcomeRecorded(facts)).toEqual({ verdict: 'passed', reasonCodes: ['outcome_recorded'] });
  });

  it.each([
    ['a claim instead of a manifest', { manifest: { outcomeManifestPresent: true, cleanupKnown: true } }, 'outcome_manifest_invalid'],
    ['a manifest for another task', { manifest: { ...manifest, taskId: '00000000-0000-4000-8000-000000000003' } }, 'outcome_manifest_wrong_task'],
    ['a different delivery scope', { deliveryScope: 'pr' }, 'outcome_delivery_scope_mismatch'],
    ['nothing delivered', { manifest: { ...manifest, deliveredArtifactRefs: [] } }, 'no_delivered_artifact'],
    ['delivered bytes that did not verify', { verifiedDeliveredRefs: 0 }, 'delivered_artifact_unverified'],
    ['no gate provenance', { manifest: { ...manifest, gateEvaluationRefs: [] } }, 'no_gate_provenance'],
    ['a provenance violation', { provenance: { ok: false as const, reason: 'ai_decision_presented_as_human' } }, 'provenance_ai_decision_presented_as_human'],
    ['unknown cleanup', { cleanupKnown: false }, 'cleanup_owner_or_expiry_unknown'],
  ])('fails for %s', (_name, over, reason) => {
    expect(evaluateOutcomeRecorded({ ...facts, ...over })).toEqual({ verdict: 'failed', reasonCodes: [reason] });
  });
});
