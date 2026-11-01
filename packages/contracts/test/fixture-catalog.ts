// Exhaustive classification of every JSON fixture in docs/spec/examples (W-003).
//
// - schema-positive: must validate against its contract definition.
// - schema-negative: must be rejected by the contract schema with an error matching the reason the
//   specification states for it (the fixture's own `expect` field, or the table below when the
//   fixture states its reason only through its name).
// - semantic: the reason is a service predicate beyond JSON Schema, owned by a package outside this
//   run (ai_only review mode W-141–W-143, design delivery W-144) or by a later M1 package. Its wire
//   parts must still validate, which proves schema validation alone cannot reject it.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { isDomainDefinition } from '../src/validate.ts';
import type { DomainDefinitionName } from '../src/generated/domain.ts';

export const examplesDir = join(import.meta.dirname, '..', '..', '..', 'docs', 'spec', 'examples');

export type ExpectedError = { path: string; keyword: string; missingProperty?: string };
export type WirePart = { label: string; definition: DomainDefinitionName; value: unknown };
export type Classified =
  | { file: string; kind: 'schema-positive'; parts: WirePart[] }
  | { file: string; kind: 'schema-negative'; part: WirePart; expected: ExpectedError; statedReason: string }
  | { file: string; kind: 'semantic'; polarity: 'positive' | 'negative'; owner: string; statedReason: string; parts: WirePart[] }
  | { file: string; kind: 'external'; owner: string; reason: string };

// Top-level raw fixtures and the contract each one is an example of.
export const RAW_POSITIVES: Record<string, DomainDefinitionName> = {
  'ai-review/ai-review-decision.json': 'AIReviewDecision',
  'ai-review/ai-review-subject.json': 'AIReviewSubject',
  'ai-review/application-review-policy.json': 'ApplicationReviewPolicy',
  'ai-review/audit-selection.json': 'ReviewAuditSelection',
  'ai-review/draft-preview-pr.json': 'PullRequest',
  'ai-review/gate-mode-rule.json': 'GateModeRule',
  'ai-review/merged-dev-pr.json': 'PullRequest',
  'ai-review/outcome-manifest.json': 'OutcomeManifest',
  'ai-review/review-mode-decision.json': 'ReviewModeDecision',
  'ai-review/reviewer-qualification.json': 'ReviewerQualification',
  'application-draft.json': 'ApplicationDraftRequest',
  'application-health-sample.json': 'ApplicationHealthSample',
  'application-snapshot.json': 'ApplicationSnapshot',
  'application.json': 'ApplicationDefinition',
  'autonomy-policy-decision.json': 'AutonomyPolicyDecision',
  'bootstrap-plan.json': 'BootstrapPlan',
  'bootstrap-receipt.json': 'BootstrapReceipt',
  'branch-preview-plan.json': 'EnvironmentPlan',
  'bug-task.json': 'TaskRequest',
  'compiled-role.json': 'CompiledRole',
  'deployment-status.json': 'DeploymentStatus',
  'design/application-with-design-location.json': 'ApplicationDefinition',
  'design/build-task.json': 'TaskRequest',
  'design/design-task.json': 'TaskRequest',
  'design/embargoed-build-task.json': 'TaskRequest',
  'design/embargoed-design-task.json': 'TaskRequest',
  'design/greenfield-design-task.json': 'TaskRequest',
  'design/policy-design.json': 'PolicyProfile',
  'design/refactor-design-task.json': 'TaskRequest',
  'design/security-flagged-design-task.json': 'TaskRequest',
  'draft-preview-pr.json': 'PullRequest',
  'environment-plan.json': 'EnvironmentPlan',
  'factory-evidence-query-v1.2.json': 'GetEvidenceToolInputV12',
  'factory-open-hypothesis.json': 'OpenHypothesisToolInput',
  'factory-submit-result-v1.2.json': 'SubmitResultToolInputV12',
  'failure-signature-profile.json': 'FailureSignatureProfile',
  'feature-task.json': 'TaskRequest',
  'gate-evaluation.json': 'GateEvaluation',
  'greenfield-monorepo-task.json': 'TaskRequest',
  'greenfield-root-adoption-task.json': 'TaskRequest',
  'greenfield-task.json': 'TaskRequest',
  'harness-run-result.json': 'HarnessRunResult',
  'implementation-task.json': 'ImplementationTask',
  'intent-answer.json': 'IntentAnswerRequest',
  'intent-brief.json': 'IntentBrief',
  'intent-confirmation.json': 'IntentConfirmationSubject',
  'intent-interview.json': 'IntentInterviewView',
  'interface.json': 'InterfaceDefinition',
  'outcome-already_compliant.json': 'OutcomeManifest',
  'outcome-not_applicable.json': 'OutcomeManifest',
  'plan-review-assignment.json': 'PlanReviewAssignment',
  'plan-review-packet.json': 'PlanReviewPacket',
  'plan-review-subject.json': 'PlanReviewSubject',
  'policy.json': 'PolicyProfile',
  'pr-review-already_compliant.json': 'PRReviewState',
  'pr-review-not_applicable.json': 'PRReviewState',
  'pr-review-preview-only.json': 'PRReviewState',
  'pr-review-state.json': 'PRReviewState',
  'queued-environment.json': 'EnvironmentView',
  'queued-environments.json': 'EnvironmentPage',
  'recipe-already_compliant.json': 'RecipeOutcomeRecord',
  'recipe-not_applicable.json': 'RecipeOutcomeRecord',
  'resolved-rules.json': 'ResolvedRules',
  'reuse-justification.json': 'ReuseJustification',
  'review-followthrough-task.json': 'TaskRequest',
  'role-delivery-attestation.json': 'RoleDeliveryAttestation',
  'role-package.json': 'RolePackage',
  'rule-definition.json': 'RuleDefinition',
  'rule-exception-grant.json': 'RuleExceptionGrant',
  'rule-exception.json': 'RuleException',
  'skill-admission.json': 'SkillAdmission',
  'stage-result.json': 'StageResult',
  'standards-bundle.json': 'StandardsBundle',
};

// Retained factory-tool fixtures: validated with the frozen reader of their negotiated tool set
// (chapter 02: retained 1.0.0/1.1.0 readers preserve historical string stage IDs).
export const RETAINED_TOOL_FIXTURES: Record<string, Array<{ toolSet: '1.0.0' | '1.1.0'; tool: 'submit_result' | 'verify'; field: 'input' | 'output' }>> = {
  'factory-submit-receipt.json': [{ toolSet: '1.0.0', tool: 'submit_result', field: 'output' }, { toolSet: '1.1.0', tool: 'submit_result', field: 'output' }],
  'factory-submit-result.json': [{ toolSet: '1.0.0', tool: 'submit_result', field: 'input' }],
  'factory-submit-result-v1.1.json': [{ toolSet: '1.1.0', tool: 'submit_result', field: 'input' }],
  'factory-verify-feedback.json': [{ toolSet: '1.0.0', tool: 'verify', field: 'output' }],
  'factory-verify-feedback-v1.1.json': [{ toolSet: '1.1.0', tool: 'verify', field: 'output' }],
};

// Negatives whose stated reason is only their name; the expected schema error is derived from it.
export const NAMED_SCHEMA_NEGATIVES: Record<string, ExpectedError & { statedReason: string }> = {
  'ai-review/negative-outcomemanifest-ai-fields-human-mode.json': { path: '/reviewMode', keyword: 'const', statedReason: 'AI review fields require reviewMode ai_only' },
  'ai-review/negative-outcomemanifest-without-reviewMarker.json': { path: '', keyword: 'required', missingProperty: 'reviewMarker', statedReason: 'ai_only outcome without review marker' },
  'ai-review/negative-outcomemanifest-without-reviewMode-reviewMarker.json': { path: '', keyword: 'required', missingProperty: 'reviewMode', statedReason: 'AI fields without reviewMode' },
  'ai-review/negative-pullrequest-ai-fields-human-mode.json': { path: '/reviewMode', keyword: 'const', statedReason: 'AI review fields require reviewMode ai_only' },
  'ai-review/negative-pullrequest-without-reviewMarker.json': { path: '', keyword: 'required', missingProperty: 'reviewMarker', statedReason: 'ai_only PR without review marker' },
  'ai-review/negative-pullrequest-without-reviewMode-reviewMarker.json': { path: '', keyword: 'required', missingProperty: 'reviewMode', statedReason: 'AI fields without reviewMode' },
  'ai-review/negative-pre-repository-fabricated-id.json': { path: '', keyword: 'not', statedReason: 'pre_repository decision cannot carry a fabricated repository identity' },
  'ai-review/negative-pre-repository-without-policy.json': { path: '', keyword: 'required', statedReason: 'pre_repository decision requires its bootstrap policy' },
  // Raw panel case: its embedded ReviewModeDecision lacks the required application-owner approval.
  'ai-review/invalid-missing-owner.json': { path: '/ownerApprovals', keyword: 'contains', statedReason: 'ai_only establishment requires the application owner approval' },
};

const AI_REVIEW_OWNER = 'W-141–W-143 (ai_only review mode; out of scope for M1)';
const DESIGN_OWNER = 'W-144 (design-only delivery; out of scope for M1)';

// Parses a stated reason in the specification validator's format, e.g. "$.workType enum",
// "$ missing reviewMode", "$.target oneOf expected one matching branch", "$.approvals contains count".
export function parseStatedReason(reason: string): ExpectedError | undefined {
  const m = /^\$((?:\.[A-Za-z0-9_]+|\[\d+\])*) (.+)$/.exec(reason);
  if (!m) return undefined;
  const path = (m[1] ?? '').replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean).map((s) => `/${s}`).join('');
  const rest = (m[2] ?? '').split(' ');
  if (rest[0] === 'missing' && rest[1]) return { path, keyword: 'required', missingProperty: rest[1] };
  return rest[0] ? { path, keyword: rest[0] } : undefined;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.json') ? [p] : [];
  });
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function allFixtureFiles(): string[] {
  return walk(examplesDir).map((p) => relative(examplesDir, p).split(sep).join('/')).sort();
}

export function readFixture(file: string): unknown {
  return JSON.parse(readFileSync(join(examplesDir, file), 'utf8'));
}

function designParts(kind: string, value: Record<string, unknown>): WirePart[] {
  const parts: WirePart[] = [];
  const add = (label: string, definition: DomainDefinitionName, v: unknown): void => { if (v !== undefined) parts.push({ label, definition, value: v }); };
  if (kind === 'template') add('template', 'WorkflowTemplateDefinition', value);
  if (kind === 'delivery' || kind === 'outcome') add('record', 'DesignDeliveryRecord', value.record);
  if (kind === 'outcome') add('outcome', 'OutcomeManifest', value.outcome);
  if (kind === 'binding') { add('delivery', 'DesignDeliveryRecord', value.delivery); add('buildTask', 'TaskRequest', value.buildTask); add('binding', 'DesignBuildBinding', value.binding); }
  return parts;
}

export function classify(file: string): Classified {
  const doc = readFixture(file);
  const name = file.split('/').pop() ?? file;
  const negative = /^(negative|invalid)-/.test(name);
  const folder = file.startsWith('design/') ? 'design' : file.startsWith('ai-review/') ? 'ai-review' : 'core';
  const owner = folder === 'design' ? DESIGN_OWNER : AI_REVIEW_OWNER;
  if (file === 'kubernetes-job.json') return { file, kind: 'external', owner: 'W-017 (Kubernetes Job protocol; M2)', reason: 'Kubernetes batch/v1 Job manifest, not a factory domain contract' };
  if (file in RAW_POSITIVES) {
    const definition = RAW_POSITIVES[file];
    if (!definition) throw new Error(file);
    return { file, kind: 'schema-positive', parts: [{ label: 'document', definition, value: doc }] };
  }
  if (file in RETAINED_TOOL_FIXTURES) return { file, kind: 'schema-positive', parts: [] };
  if (/^(design\/)?templates\//.test(file)) return { file, kind: 'schema-positive', parts: [{ label: 'template', definition: 'WorkflowTemplateDefinition', value: doc }] };
  if (!isRecord(doc)) throw new Error(`Unclassified fixture ${file}`);
  const kind = typeof doc.kind === 'string' ? doc.kind : undefined;
  const statedRaw = doc.expect ?? doc.error ?? doc.expected;
  const statedReason = typeof statedRaw === 'string' ? statedRaw : '';
  if (kind !== undefined && doc.value !== undefined) {
    const value = doc.value;
    const parts: WirePart[] = kind && isDomainDefinition(kind) ? [{ label: 'value', definition: kind, value }] : isRecord(value) && kind ? designParts(kind, value) : [];
    if (negative) {
      const named = NAMED_SCHEMA_NEGATIVES[file];
      const parsed = folder === 'design' ? parseStatedReason(statedReason) : undefined;
      const expected = named ?? parsed;
      if (expected) {
        const target = kind === 'outcome' ? parts.find((p) => p.label === 'outcome') : kind === 'delivery' ? parts.find((p) => p.label === 'record') : parts[0];
        if (!target) throw new Error(`No wire part for schema negative ${file}`);
        return { file, kind: 'schema-negative', part: target, expected, statedReason: named?.statedReason ?? statedReason };
      }
      return { file, kind: 'semantic', polarity: 'negative', owner, statedReason, parts };
    }
    return { file, kind: 'semantic', polarity: 'positive', owner, statedReason: statedReason || 'accept', parts };
  }
  // Raw predicate cases (ai-review panel bundles, design delivery/binding wrappers, review evidence).
  if (folder === 'design') {
    const parts: WirePart[] = [];
    if (isRecord(doc.record)) parts.push({ label: 'record', definition: 'DesignDeliveryRecord', value: doc.record });
    if (isRecord(doc.binding)) parts.push({ label: 'binding', definition: 'DesignBuildBinding', value: doc.binding });
    if (isRecord(doc.buildTask)) parts.push({ label: 'buildTask', definition: 'TaskRequest', value: doc.buildTask });
    if (isRecord(doc.delivery)) parts.push({ label: 'delivery', definition: 'DesignDeliveryRecord', value: doc.delivery });
    return { file, kind: 'semantic', polarity: negative ? 'negative' : 'positive', owner, statedReason: negative ? name : 'accept', parts };
  }
  if (folder === 'ai-review') {
    const parts: WirePart[] = isRecord(doc.decision) ? [{ label: 'decision', definition: 'ReviewModeDecision', value: doc.decision }] : [];
    const named = NAMED_SCHEMA_NEGATIVES[file];
    const decisionPart = parts[0];
    if (named && decisionPart) return { file, kind: 'schema-negative', part: decisionPart, expected: named, statedReason: named.statedReason };
    return { file, kind: 'semantic', polarity: negative ? 'negative' : 'positive', owner, statedReason: negative ? name.replace(/\.json$/, '') : 'accept', parts };
  }
  throw new Error(`Unclassified fixture ${file}`);
}
