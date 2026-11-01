// Outcome bundle export (W-016, AC-54; chapter 12 "Audit interaction"). An operator exports one
// delivered task's outcome: the exact source, policy, criteria, plan, evidence, decisions, budget,
// events and provider handles that produced it. Every artifact in the bundle is read back through
// the ArtifactStore and digest-verified; the manifest's human authority is re-resolved against the
// immutable decision rows (INV-29) and its gate refs against the stored evaluations, so a stored
// view can never override trusted state. Any mismatch fails the export; nothing is skipped.
//
// The bundle envelope is not a spec contract (no outcome-bundle schema exists in rev 1.13); its
// members are contract documents. See docs/assumptions.md A-14.
import { validateContract, type ArtifactRef, type DecisionView, type GateEvaluation, type OutcomeManifest, type RunView } from '@factory/contracts';
import { AI_REVIEW_MARKER, canonicalJson, checkOutcomeProvenance, resolveAuthorities, type ContractCheck } from '@factory/domain';
import type { Database, Tx } from '@factory/database';
import type { ArtifactService, AuthContext } from '@factory/artifacts';
import { authorize, effectiveRoles, type Principal } from '../auth/rbac.ts';
import { ApiError } from './service.ts';
import { listRuns } from './views.ts';

export const OUTCOME_BUNDLE_SCHEMA = 'factory-outcome-bundle/1';
type Verified<T = unknown> = { ref: ArtifactRef; value: T };
export type OutcomeBundle = {
  schemaVersion: typeof OUTCOME_BUNDLE_SCHEMA;
  orgId: string; taskId: string; exportedAt: string; exportedBy: string;
  reviewMode: 'human' | 'ai_only'; reviewMarker?: typeof AI_REVIEW_MARKER;
  outcome: Verified<OutcomeManifest>;
  source: { currentSpecVersion: number; specVersions: Array<{ version: number; specHash: string; actorId: string; createdAt: string; spec: unknown }>; applicationSnapshot: Verified };
  plan: Verified & { version: number; planHash: string; specVersion: number };
  template: Verified; policy: Verified; criteria: Verified;
  stageRuns: Array<RunView & { input?: Verified; result?: Verified }>;
  gates: Array<Verified<GateEvaluation> & { evidence: Verified[] }>;
  humanDecisions: Array<Verified<DecisionView> & { decidedAt: string; commandId: string; reviewedSectionIds: unknown }>;
  // AI review decisions and voluntary human reviews are always listed separately, never mixed into
  // humanDecisions. This release supports human mode only, so both are empty.
  aiReviewDecisions: Verified[]; voluntaryHumanReviews: Verified[];
  delivered: Verified[];
  budget: { limitMicroUsd: number; reservedMicroUsd: number; chargedMicroUsd: number; ledger: Array<{ operationKey: string; kind: string; amountMicroUsd: number; recordedAt: string }> };
  events: Array<{ sequence: number; eventType: string; occurredAt: string; correlationId: string; payload: Verified }>;
  providerHandles: string[];
  verification: { digestVerifiedArtifacts: number; humanAuthorityResolved: number };
};

const contractCheck: ContractCheck = (contract, value) => validateContract(contract, value).ok;
const integrity = (detail: string): ApiError => new ApiError(409, 'outcome_bundle_integrity_failure', detail);
const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);
const MAX_RUNS = 10_000;

export class OutcomeBundleService {
  private readonly db: Database;
  private readonly artifacts: ArtifactService;
  constructor(o: { db: Database; artifacts: ArtifactService }) { this.db = o.db; this.artifacts = o.artifacts; }

  async export(p: Principal, taskId: string, requestId: string): Promise<OutcomeBundle> {
    const tenant = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => this.db.withTenant({ orgId: p.orgId, principalId: p.principalId }, fn);
    const task = await tenant(async (tx) => (await tx.query<{ id: string; primary_application_id: string; owner_ids: unknown; outcome_ref: ArtifactRef | null; status: string; spec_version: number; plan_version: number | null }>(
      'SELECT t.id, t.primary_application_id, a.owner_ids, t.outcome_ref, t.status, t.spec_version, t.plan_version FROM factory.task t JOIN factory.application a ON a.org_id = t.org_id AND a.id = t.primary_application_id WHERE t.id = $1', [taskId])).rows[0]);
    const owners = Array.isArray(task?.owner_ids) ? (task.owner_ids as unknown[]).filter((x): x is string => typeof x === 'string') : [];
    if (!task || effectiveRoles(p, { applicationId: task.primary_application_id, applicationOwnerIds: owners }).length === 0) throw new ApiError(404, 'not_found', 'unknown or inaccessible resource');
    if (!authorize(p, 'outcome.export', { applicationId: task.primary_application_id, applicationOwnerIds: owners }).allowed) throw new ApiError(403, 'outcome_export_not_authorized', 'exporting an outcome bundle requires the operator role on the application');
    if (!task.outcome_ref) throw new ApiError(409, 'outcome_not_recorded', `task is ${task.status} and has no recorded outcome`);

    const ctx: AuthContext = { orgId: p.orgId, actorId: p.principalId, principalId: p.principalId, actorKind: 'human', groups: p.groups, grantIds: p.grants.map((g) => g.membershipId), correlationId: requestId, taskId };
    let verifiedCount = 0;
    // Secrets and native session transcripts never leave through an export (chapter 12).
    const read = async <T = unknown>(ref: ArtifactRef | null | undefined, what: string): Promise<Verified<T>> => {
      if (!ref) throw integrity(`${what} is not recorded`);
      const cls = await tenant(async (tx) => (await tx.query<{ classification: string }>('SELECT classification FROM factory.artifact WHERE id = $1', [ref.artifactId])).rows[0]?.classification);
      if (cls === 'sensitive_session') throw integrity(`${what} is session state and cannot be exported`);
      let bytes: Buffer;
      try { bytes = await this.artifacts.readVerified(ctx, ref); } catch (e) { throw integrity(`${what} failed digest verification: ${e instanceof Error ? e.message : 'error'}`); }
      verifiedCount += 1;
      return { ref, value: JSON.parse(bytes.toString('utf8')) as T };
    };

    const outcome = await read<OutcomeManifest>(task.outcome_ref, 'outcome manifest');
    const m = outcome.value;
    if (!validateContract('OutcomeManifest', m).ok) throw integrity('outcome manifest is not a valid OutcomeManifest');
    if (m.taskId !== taskId) throw integrity('outcome manifest names another task');
    // INV-29: every human-authority ref resolves to an authenticated human decision; AI fields
    // require ai_only with the marker; ai_only itself is not enabled in this release.
    const io = {
      read: async (ref: ArtifactRef) => { try { return (await read(ref, 'decision record')).value; } catch { return undefined; } },
      decision: (id: string) => tenant(async (tx) => {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) return undefined;
        const r = (await tx.query<{ id: string; task_id: string; state: string; subject_hash: string; decider_id: string; actor_kind: string; created_at: Date }>(
          'SELECT r.id, r.task_id, r.state, r.subject_hash, d.decider_id, d.actor_kind, d.created_at FROM factory.decision_request r JOIN factory.decision d ON d.org_id = r.org_id AND d.request_id = r.id WHERE r.id = $1', [id])).rows[0];
        return r ? { requestId: r.id, taskId: r.task_id, deciderId: r.decider_id, actorKind: r.actor_kind, state: r.state, subjectHash: r.subject_hash, decidedAt: r.created_at.toISOString() } : undefined;
      }),
      isAi: (ref: ArtifactRef) => tenant(async (tx) => ((await tx.query("SELECT 1 FROM factory.ai_review_decision WHERE id::text = $1 OR decision_ref->>'artifactId' = $1 LIMIT 1", [ref.artifactId])).rowCount ?? 0) > 0),
    };
    const provenance = checkOutcomeProvenance(m, await resolveAuthorities(m, io), { aiOnlySupported: false, validate: contractCheck });
    if (!provenance.ok) throw new ApiError(409, 'outcome_provenance_invalid', `outcome provenance rejected: ${provenance.reason}${provenance.field ? ` (${provenance.field})` : ''}`);

    const facts = await tenant(async (tx) => {
      const plan = (await tx.query<{ version: number; spec_version: number; plan_hash: string; plan_ref: ArtifactRef; policy_ref: ArtifactRef }>('SELECT version, spec_version, plan_hash, plan_ref, policy_ref FROM factory.execution_plan WHERE task_id = $1 AND version = $2', [taskId, task.plan_version])).rows[0];
      const specs = (await tx.query<{ version: number; spec_hash: string; actor_id: string; created_at: Date; spec: unknown }>('SELECT version, spec_hash, actor_id, created_at, spec FROM factory.task_spec_version WHERE task_id = $1 ORDER BY version', [taskId])).rows;
      const runs = await listRuns(tx, taskId, { limit: MAX_RUNS });
      const inputs = (await tx.query<{ logical_id: string; input_ref: ArtifactRef }>('SELECT logical_id, input_ref FROM factory.stage_run WHERE task_id = $1', [taskId])).rows;
      const gates = (await tx.query<{ id: string; verdict: string; input_hash: string; superseded_by: string | null }>('SELECT id, verdict, input_hash, superseded_by FROM factory.gate_evaluation WHERE task_id = $1', [taskId])).rows;
      const decisions = (await tx.query<{ request_id: string; command_id: string; reviewed_section_ids: unknown; created_at: Date }>('SELECT d.request_id, d.command_id, d.reviewed_section_ids, d.created_at FROM factory.decision d JOIN factory.decision_request r ON r.org_id = d.org_id AND r.id = d.request_id WHERE r.task_id = $1', [taskId])).rows;
      const account = (await tx.query<{ id: string; limit_micro_usd: string; reserved_micro_usd: string; charged_micro_usd: string }>('SELECT id, limit_micro_usd, reserved_micro_usd, charged_micro_usd FROM factory.budget_account WHERE task_id = $1', [taskId])).rows[0];
      const ledger = account ? (await tx.query<{ operation_key: string; kind: string; amount_micro_usd: string; created_at: Date }>('SELECT operation_key, kind, amount_micro_usd, created_at FROM factory.budget_ledger WHERE account_id = $1 ORDER BY created_at, id', [account.id])).rows : [];
      const events = (await tx.query<{ sequence: string; event_type: string; occurred_at: Date; correlation_id: string; payload_ref: ArtifactRef }>('SELECT sequence, event_type, occurred_at, correlation_id, payload_ref FROM factory.task_event WHERE task_id = $1 ORDER BY sequence', [taskId])).rows;
      return { plan, specs, runs: runs.items, inputs, gates, decisions, account, ledger, events };
    });
    if (!facts.plan) throw integrity('the executed plan is not recorded');
    if (facts.runs.length >= MAX_RUNS) throw integrity('too many stage runs to export completely');

    const plan = await read<{ planHash: string; templateRef: { definitionRef: ArtifactRef }; policyRef: ArtifactRef; criteriaRef?: ArtifactRef; applicationSnapshotRef?: ArtifactRef }>(facts.plan.plan_ref, 'execution plan');
    if (plan.value.planHash !== facts.plan.plan_hash) throw integrity('stored plan hash does not match the plan artifact');
    if (!same(plan.value.policyRef, facts.plan.policy_ref)) throw integrity('stored policy snapshot does not match the plan artifact');
    const gates: OutcomeBundle['gates'] = [];
    for (const ref of m.gateEvaluationRefs) {
      const g = await read<GateEvaluation>(ref, 'gate evaluation');
      if (!validateContract('GateEvaluation', g.value).ok) throw integrity('gate evaluation record is not a valid GateEvaluation');
      const row = facts.gates.find((r) => r.id === g.value.id);
      // The exported record must be the stored evaluation, unchanged and not since superseded.
      if (!row || row.verdict !== g.value.verdict || row.input_hash !== g.value.inputHash || row.superseded_by !== null) throw integrity(`gate evaluation ${g.value.id} does not match the stored evaluation`);
      const evidence: Verified[] = [];
      for (const e of g.value.evidenceRefs) evidence.push(await read(e, `evidence for ${g.value.gateId}`));
      gates.push({ ...g, evidence });
    }
    const humanDecisions: OutcomeBundle['humanDecisions'] = [];
    for (const ref of m.decisionRefs) {
      const d = await read<DecisionView>(ref, 'human decision');
      const row = facts.decisions.find((r) => r.request_id === d.value.id);
      if (!row) throw integrity(`decision ${d.value.id} has no recorded human response`);
      humanDecisions.push({ ...d, decidedAt: row.created_at.toISOString(), commandId: row.command_id, reviewedSectionIds: row.reviewed_section_ids });
    }
    const stageRuns: OutcomeBundle['stageRuns'] = [];
    for (const run of facts.runs) {
      const inputRef = facts.inputs.find((i) => i.logical_id === run.id)?.input_ref;
      stageRuns.push({ ...run, ...(inputRef ? { input: await read(inputRef, `input of ${run.id}`) } : {}), ...(run.resultRef ? { result: await read(run.resultRef, `result of ${run.id}`) } : {}) });
    }
    const delivered: Verified[] = [];
    for (const ref of m.deliveredArtifactRefs) delivered.push(await read(ref, 'delivered artifact'));
    const events: OutcomeBundle['events'] = [];
    for (const e of facts.events) events.push({ sequence: Number(e.sequence), eventType: e.event_type, occurredAt: e.occurred_at.toISOString(), correlationId: e.correlation_id, payload: await read(e.payload_ref, `event ${e.sequence}`) });

    return {
      schemaVersion: OUTCOME_BUNDLE_SCHEMA, orgId: p.orgId, taskId, exportedAt: new Date().toISOString(), exportedBy: p.principalId,
      reviewMode: m.reviewMode ?? 'human', ...(m.reviewMode === 'ai_only' ? { reviewMarker: AI_REVIEW_MARKER } : {}),
      outcome,
      source: {
        currentSpecVersion: task.spec_version,
        specVersions: facts.specs.map((s) => ({ version: s.version, specHash: s.spec_hash, actorId: s.actor_id, createdAt: s.created_at.toISOString(), spec: s.spec })),
        applicationSnapshot: await read(plan.value.applicationSnapshotRef, 'application snapshot'),
      },
      plan: { ...plan, version: facts.plan.version, planHash: facts.plan.plan_hash, specVersion: facts.plan.spec_version },
      template: await read(plan.value.templateRef.definitionRef, 'workflow template'),
      policy: await read(plan.value.policyRef, 'policy snapshot'),
      criteria: await read(plan.value.criteriaRef, 'criteria'),
      stageRuns, gates, humanDecisions, aiReviewDecisions: [], voluntaryHumanReviews: [], delivered,
      budget: { limitMicroUsd: Number(facts.account?.limit_micro_usd ?? 0), reservedMicroUsd: Number(facts.account?.reserved_micro_usd ?? 0), chargedMicroUsd: Number(facts.account?.charged_micro_usd ?? 0),
        ledger: facts.ledger.map((l) => ({ operationKey: l.operation_key, kind: l.kind, amountMicroUsd: Number(l.amount_micro_usd), recordedAt: l.created_at.toISOString() })) },
      events, providerHandles: m.providerHandles,
      verification: { digestVerifiedArtifacts: verifiedCount, humanAuthorityResolved: provenance.humanRecords },
    };
  }
}
