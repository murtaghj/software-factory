// TaskWorkflow Activities (W-011). Every Activity is idempotent on a stable key, so Temporal
// infrastructure retries never duplicate effects (INV-02): plans by (task, version), stage runs by
// logical ID, projections by sequence + hash.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ApplicationFailure, CancelledFailure, Context } from '@temporalio/activity';
import { validateContract } from '@factory/contracts';
import { canonicalHash, canonicalJson, checkOutcomeProvenance, evaluateOutcomeRecorded, evaluateReviewPassed, evaluateScopeAccepted, gateBinding, gateEvaluationView, gateInputHash, resolveAuthorities, type AuthorityIo, type ContractCheck, type GateDecision, type GateId, type GateRow } from '@factory/domain';
import { budgetUsage, chargeBudget, currentAllowance, openBudgetAccount, projectTransition, reserveBudget, type Database, type Tx } from '@factory/database';
import type { ArtifactService } from '@factory/artifacts';
import type { ArtifactRefLike, FakeStageResult, GateResult, PlanSnapshot, TaskActivities } from '../workflows/types.ts';

export const TEMPLATES_DIR = join(import.meta.dirname, '..', 'templates');
// Pinned template per work type. investigation 0.2.0 carries the mandatory plan + plan_review
// (peer sign-off) nodes; the 0.1.0 skeleton (no human gate) is only selectable through an explicit
// templateOverrides entry, which the scheduler-mechanics tests use.
const TEMPLATE_BY_WORK_TYPE: Record<string, string> = { investigation: 'investigation-0.2.0.json' };
export const PLAN_SECTIONS = ['intent_scope', 'current_state', 'design', 'interfaces_data', 'implementation', 'acceptance_tests', 'quality_security', 'delivery_recovery', 'operations', 'risks_decisions', 'definition_of_done', 'review_ownership'] as const;
export const DEFAULT_DECISION_TTL_MS = 72 * 60 * 60 * 1000;
// M1 default policy (A-10). W-013 replaces this with the resolved PolicyProfile.
export const M1_POLICY = { id: 'm1-default-policy', revision: 1, defaultAssurance: 'standard' } as const;

export type FakeStageBehavior = {
  delayMs?: (nodeId: string, attempt: number, planVersion: number) => number;
  outcome?: (nodeId: string, attempt: number, planVersion: number) => FakeStageResult['status'];
  // Overrides the structured evidence the fake stage emits (e.g. a blocking review finding).
  evidence?: (nodeId: string, defaults: Record<string, unknown>) => Record<string, unknown>;
  // Estimated and actual model cost of a fake stage, in micro-USD (default 1 USD each).
  estimateMicroUsd?: (nodeId: string) => number;
  actualMicroUsd?: (nodeId: string) => number;
  // Makes the fake runner fail outright (as a crashed pod would), instead of returning a result.
  crash?: (nodeId: string, attempt: number) => boolean;
  // Overrides the producer identity the fake runner reports (e.g. a reviewer that is the author).
  producerId?: (nodeId: string) => string;
};

const EVALUATOR_ID = 'gate-evaluator:m1';
const REVIEWER_PRODUCER = 'fake-reviewer';
const AUTHOR_PRODUCER = 'fake-runner';
export type ActivityDeps = { db: Database; artifacts: ArtifactService; fakeStage?: FakeStageBehavior; templateOverrides?: Record<string, string>; decisionTtlMs?: number };

const CONTROLLER = 'control-plane:worker';
const contractCheck: ContractCheck = (contract, value) => validateContract(contract, value).ok;

export function createTaskActivities(deps: ActivityDeps): TaskActivities {
  const tenant = <T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> => deps.db.withTenant({ orgId }, fn);
  const store = async (orgId: string, taskId: string, doc: unknown, purpose: string, tx?: Tx): Promise<ArtifactRefLike> => {
    const object = await deps.artifacts.putControllerObject(orgId, Buffer.from(canonicalJson(doc)));
    const register = (t: Tx) => deps.artifacts.registerControllerArtifact(t, { orgId, taskId, producerId: CONTROLLER, object, mediaType: 'application/json', schemaVersion: '2.0', classification: 'ordinary', purpose });
    return tx ? register(tx) : tenant(orgId, register);
  };
  const readJson = async <T>(orgId: string, taskId: string, ref: ArtifactRefLike): Promise<T> =>
    JSON.parse((await deps.artifacts.readVerified({ orgId, actorId: CONTROLLER, actorKind: 'service', taskId, grantIds: [], correlationId: taskId }, ref)).toString('utf8')) as T;

  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  // Human-authority resolution against the ArtifactStore (digest-verified bytes) and the immutable
  // decision rows (INV-29). Shared by manifest construction and the outcome_recorded evaluator.
  const authorityIo = (orgId: string, taskId: string): AuthorityIo => ({
    read: async (ref) => { try { return await readJson<unknown>(orgId, taskId, ref); } catch { return undefined; } },
    decision: (requestId) => UUID.test(requestId) ? tenant(orgId, async (tx) => {
      const r = await tx.query<{ id: string; task_id: string; state: string; subject_hash: string; decider_id: string; actor_kind: string; created_at: Date }>(
        'SELECT r.id, r.task_id, r.state, r.subject_hash, d.decider_id, d.actor_kind, d.created_at FROM factory.decision_request r JOIN factory.decision d ON d.org_id = r.org_id AND d.request_id = r.id WHERE r.id = $1', [requestId]);
      const row = r.rows[0];
      return row ? { requestId: row.id, taskId: row.task_id, deciderId: row.decider_id, actorKind: row.actor_kind, state: row.state, subjectHash: row.subject_hash, decidedAt: row.created_at.toISOString() } : undefined;
    }) : Promise.resolve(undefined),
    isAi: (ref) => tenant(orgId, async (tx) => ((await tx.query("SELECT 1 FROM factory.ai_review_decision WHERE id::text = $1 OR decision_ref->>'artifactId' = $1 LIMIT 1", [ref.artifactId])).rowCount ?? 0) > 0),
  });
  const verifies = async (orgId: string, taskId: string, ref: ArtifactRefLike): Promise<boolean> => {
    try { await deps.artifacts.readVerified({ orgId, actorId: CONTROLLER, actorKind: 'service', taskId, grantIds: [], correlationId: taskId }, ref); return true; } catch { return false; }
  };
  // outcome_recorded on the real manifest: schema, task, scope, delivered bytes, human provenance
  // and cleanup are all re-established from trusted state, not read from the manifest's claims.
  const outcomeDecision = async (orgId: string, taskId: string, manifestRef: ArtifactRefLike): Promise<GateDecision> => {
    let manifest: Record<string, unknown>;
    try { manifest = await readJson<Record<string, unknown>>(orgId, taskId, manifestRef); } catch { return { verdict: 'failed', reasonCodes: ['outcome_manifest_unreadable'] }; }
    const task = await tenant(orgId, (tx) => tx.query<{ delivery_scope: string; cleanup_state: string; allocations: string }>(
      'SELECT t.delivery_scope, t.cleanup_state, (SELECT count(*) FROM factory.execution_allocation a JOIN factory.stage_run s ON s.org_id = a.org_id AND s.id = a.stage_run_id WHERE s.task_id = t.id) AS allocations FROM factory.task t WHERE t.id = $1', [taskId]));
    const t = task.rows[0];
    if (!t) return { verdict: 'failed', reasonCodes: ['task_not_found'] };
    const delivered = Array.isArray(manifest.deliveredArtifactRefs) ? (manifest.deliveredArtifactRefs as ArtifactRefLike[]) : [];
    let verifiedDeliveredRefs = 0;
    for (const ref of delivered) if (await verifies(orgId, taskId, ref)) verifiedDeliveredRefs += 1;
    const provenance = checkOutcomeProvenance(manifest, await resolveAuthorities(manifest, authorityIo(orgId, taskId)), { aiOnlySupported: false, validate: contractCheck });
    return evaluateOutcomeRecorded({ manifest, taskId, deliveryScope: t.delivery_scope, verifiedDeliveredRefs, provenance, cleanupKnown: t.cleanup_state === 'complete' && Number(t.allocations) === 0, validate: contractCheck });
  };

  return {
    async loadTask({ orgId, taskId }) {
      const r = await tenant(orgId, (tx) => tx.query<{ status: PlanSnapshot['nodes'][number]['role']; spec_version: number; control_revision: string; projection_sequence: string }>('SELECT status, spec_version, control_revision, projection_sequence FROM factory.task WHERE id = $1', [taskId]));
      const row = r.rows[0];
      if (!row) throw ApplicationFailure.nonRetryable(`task ${taskId} not found`, 'task_not_found');
      return { status: row.status as never, specVersion: row.spec_version, controlRevision: Number(row.control_revision), projectionSequence: Number(row.projection_sequence) };
    },

    async resolvePlan({ orgId, taskId, specVersion, planVersion }) {
      const existing = await tenant(orgId, (tx) => tx.query<{ plan_ref: ArtifactRefLike }>('SELECT plan_ref FROM factory.execution_plan WHERE task_id = $1 AND version = $2', [taskId, planVersion]));
      if (existing.rows[0]) return readJson<PlanSnapshot>(orgId, taskId, existing.rows[0].plan_ref);
      const spec = await tenant(orgId, (tx) => tx.query<{ spec: { workType: string } }>('SELECT spec FROM factory.task_spec_version WHERE task_id = $1 AND version = $2', [taskId, specVersion]));
      const workType = spec.rows[0]?.spec.workType;
      if (!workType) throw ApplicationFailure.nonRetryable(`task spec ${String(specVersion)} not found`, 'spec_not_found');
      const file = deps.templateOverrides?.[workType] ?? TEMPLATE_BY_WORK_TYPE[workType];
      if (!file) throw ApplicationFailure.nonRetryable(`no compatible pinned template for ${workType}`, 'no_compatible_template');
      const template = JSON.parse(readFileSync(join(TEMPLATES_DIR, file), 'utf8')) as { id: string; version: string; nodes: PlanSnapshot['nodes'] };
      const valid = validateContract('WorkflowTemplateDefinition', template);
      if (!valid.ok) throw ApplicationFailure.nonRetryable(`template ${file} is invalid`, 'invalid_template');
      const definitionRef = await store(orgId, taskId, template, 'workflow_template');
      const policyRef = await store(orgId, taskId, M1_POLICY, 'policy_snapshot');
      const criteria = ((spec.rows[0]?.spec as { acceptanceCriteria?: string[] }).acceptanceCriteria ?? []).map((text, i) => ({ id: `C${String(i + 1)}`, text }));
      // The pinned ApplicationSnapshot: the accepted target context. No registry import exists yet
      // (W-037), so it carries no definition refs (A-10).
      const snapshot = { schemaVersion: '2.0', snapshotId: randomUUID(), targetContext: (spec.rows[0]?.spec as { targetContext?: unknown }).targetContext, applicationDefinitionRefs: [], applicationDraftRefs: [], createdAt: new Date().toISOString() };
      if (!validateContract('ApplicationSnapshot', snapshot).ok) throw ApplicationFailure.nonRetryable('cannot build a valid ApplicationSnapshot', 'invalid_snapshot');
      const applicationSnapshotRef = await store(orgId, taskId, snapshot, 'application_snapshot');
      const criteriaRef = await store(orgId, taskId, { schemaVersion: '2.0', specVersion, criteria }, 'criteria');
      const nodes = template.nodes.map((n) => ({ id: n.id, stageKind: n.stageKind, role: n.role, dependsOn: n.dependsOn, requiredGateIds: n.requiredGateIds, timeoutClass: n.timeoutClass, mandatory: n.mandatory }));
      const body = { taskId, version: planVersion, specVersion, templateRef: { id: template.id, version: template.version, definitionRef }, policyRef, nodes };
      const b = (spec.rows[0]?.spec as { budget?: PlanSnapshot['budget'] }).budget;
      const budget = b ? { maxMicroUsd: b.maxMicroUsd, maxActiveSeconds: b.maxActiveSeconds, maxCalendarSeconds: b.maxCalendarSeconds, maxAuthoringInvocations: b.maxAuthoringInvocations, maxSemanticAttemptsPerNode: b.maxSemanticAttemptsPerNode, invocationMode: b.invocationMode } : undefined;
      const plan: PlanSnapshot = { version: planVersion, specVersion, planHash: canonicalHash({ ...body, criteriaRef, budget, applicationSnapshotRef }), policyRef, templateRef: body.templateRef, nodes, criteriaRef, applicationSnapshotRef, ...(budget ? { budget } : {}) };
      const planRef = await store(orgId, taskId, plan, 'execution_plan');
      await tenant(orgId, (tx) => tx.query(`INSERT INTO factory.execution_plan (org_id, id, task_id, version, spec_version, plan_ref, policy_ref, plan_hash, template_id, template_version, template_ref)
        VALUES ($1, $11, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (org_id, task_id, version) DO NOTHING`,
        [orgId, taskId, planVersion, specVersion, JSON.stringify(planRef), JSON.stringify(policyRef), plan.planHash, template.id, template.version, JSON.stringify(plan.templateRef), randomUUID()]));
      const stored = await tenant(orgId, (tx) => tx.query<{ plan_ref: ArtifactRefLike }>('SELECT plan_ref FROM factory.execution_plan WHERE task_id = $1 AND version = $2', [taskId, planVersion]));
      const ref = stored.rows[0]?.plan_ref;
      if (!ref) throw new Error('execution plan not persisted');
      return readJson<PlanSnapshot>(orgId, taskId, ref); // a concurrent attempt's plan wins; never two plans per version
    },

    async startStage({ orgId, taskId, planVersion, nodeId, attempt, role, logicalId, inputHash, binding }) {
      const inputRef = await store(orgId, taskId, { logicalId, inputHash, binding }, 'stage_input');
      return tenant(orgId, async (tx) => {
        await tx.query(`INSERT INTO factory.stage_run (org_id, id, task_id, plan_version, node_id, semantic_attempt, logical_id, input_hash, input_ref, role, status, limits, started_at)
          VALUES ($1, $11, $2, $3, $4, $5, $6, $7, $8, $9, 'running', $10, now()) ON CONFLICT (org_id, logical_id) DO NOTHING`,
          [orgId, taskId, planVersion, nodeId, attempt, logicalId, inputHash, JSON.stringify(inputRef), role, JSON.stringify({ wallSeconds: 2700, maxTurns: 40, maxToolCalls: 200, maxOutputBytes: 1_000_000, reservedMicroUsd: 0 }), randomUUID()]);
        const r = await tx.query<{ id: string; input_hash: string }>('SELECT id, input_hash FROM factory.stage_run WHERE logical_id = $1', [logicalId]);
        const row = r.rows[0];
        if (!row) throw new Error('stage run not persisted');
        if (row.input_hash !== inputHash) throw ApplicationFailure.nonRetryable(`stage ${logicalId} exists with a different input binding`, 'binding_conflict');
        return { stageRunId: row.id };
      });
    },

    // The M1 fake runner: deterministic output, no harness. It still produces real finalized
    // artifacts and a schema-valid StageResult bound to the issued stage.
    async executeFakeStage({ orgId, taskId, logicalId, nodeId, stageKind, attempt, inputHash, planVersion }) {
      const delay = deps.fakeStage?.delayMs?.(nodeId, attempt, planVersion) ?? 0;
      if (delay > 0) {
        // Heartbeat while working so cancellation reaches the stage promptly.
        const ctx = Context.current();
        const until = Date.now() + delay;
        while (Date.now() < until) {
          ctx.heartbeat();
          await Promise.race([new Promise((r) => setTimeout(r, 50)), ctx.cancelled.catch(() => undefined)]);
          if (ctx.cancellationSignal.aborted) throw new CancelledFailure('stage cancelled');
        }
      }
      if (deps.fakeStage?.crash?.(nodeId, attempt)) throw ApplicationFailure.nonRetryable('fake runner crashed', 'runner_crashed');
      const status = deps.fakeStage?.outcome?.(nodeId, attempt, planVersion) ?? 'completed';
      const criteria = await tenant(orgId, (tx) => tx.query<{ spec: { acceptanceCriteria?: string[] } }>('SELECT s.spec FROM factory.task_spec_version s JOIN factory.execution_plan p ON p.org_id = s.org_id AND p.task_id = s.task_id AND p.spec_version = s.version WHERE p.task_id = $1 AND p.version = $2', [taskId, planVersion]));
      const criteriaIds = (criteria.rows[0]?.spec.acceptanceCriteria ?? []).map((_t, i) => `C${String(i + 1)}`);
      const defaults: Record<string, Record<string, unknown>> = {
        discover: { criteriaIds, mappedCriteriaIds: criteriaIds, blockingGaps: [] },
        review: { findings: [], reviewerProducerId: REVIEWER_PRODUCER, authorProducerIds: [AUTHOR_PRODUCER], scopeReviewed: true },
        plan: { sections: PLAN_SECTIONS.map((id) => ({ id, applicable: true, summary: `fake ${id} section` })), criteriaIds },
      };
      const evidence = deps.fakeStage?.evidence?.(nodeId, defaults[stageKind] ?? {}) ?? defaults[stageKind] ?? {};
      const output = await store(orgId, taskId, { schemaVersion: '2.0', kind: 'fake_stage_output', stageKind, nodeId, stageRunId: logicalId, inputHash, summary: `fake ${stageKind} output for ${nodeId}`, ...evidence }, 'stage_output');
      const result: FakeStageResult = { schemaVersion: '2.0', orgId, taskId, stageRunId: logicalId, inputHash, allocationEpoch: 1, status, outputRefs: [output], usage: [], producerId: deps.fakeStage?.producerId?.(nodeId) ?? (stageKind === 'review' ? REVIEWER_PRODUCER : AUTHOR_PRODUCER), completedAt: new Date().toISOString(), producerKind: 'runner' };
      const valid = validateContract('StageResult', result);
      if (!valid.ok) throw ApplicationFailure.nonRetryable('fake runner produced an invalid StageResult', 'invalid_result');
      return result;
    },

    async finishStage({ orgId, logicalId, status, resultRef, errorClass }) {
      await tenant(orgId, async (tx) => {
        const r = await tx.query<{ status: string }>('SELECT status FROM factory.stage_run WHERE logical_id = $1 FOR UPDATE', [logicalId]);
        const current = r.rows[0]?.status;
        if (current === undefined) throw ApplicationFailure.nonRetryable(`stage ${logicalId} not found`, 'stage_not_found');
        if (current === status) return; // idempotent retry
        await tx.query('UPDATE factory.stage_run SET status = $2, result_ref = $3, error_class = $4, completed_at = now(), updated_at = now() WHERE logical_id = $1',
          [logicalId, status, resultRef === undefined ? null : JSON.stringify(resultRef), errorClass ?? null]);
      });
    },

    async supersedeStages({ orgId, taskId, oldPlanVersion, newPlanVersion }) {
      return tenant(orgId, async (tx) => (await tx.query('UPDATE factory.stage_run SET superseded_at = now(), superseded_by_plan_version = $3, updated_at = now() WHERE task_id = $1 AND plan_version = $2 AND superseded_at IS NULL', [taskId, oldPlanVersion, newPlanVersion])).rowCount ?? 0);
    },

    // Trusted gate evaluation: reads finalized evidence, applies the pure evaluator and records an
    // immutable gate_evaluation bound to the gate's declared input projection (INV-04). A gate with
    // no qualified evaluator in this release is inconclusive, never passed.
    async evaluateGates({ orgId, taskId, logicalId, requiredGateIds, binding, outputRefs, dependencyRefs, producers }) {
      const results: GateResult[] = [];
      const primary = outputRefs[0];
      for (const gateId of requiredGateIds as GateId[]) {
        const evidenceField: Partial<Record<GateId, { field: string; extra?: Record<string, unknown> }>> = {
          scope_accepted: { field: 'scopeEvidenceRef' },
          review_passed: { field: 'reviewReportRef', extra: { candidateRef: dependencyRefs[0] } },
          outcome_recorded: { field: 'outcomeManifestRef' },
        };
        const spec = evidenceField[gateId];
        let decision: GateDecision;
        let full: Record<string, unknown> = binding;
        if (!spec || !primary) {
          decision = { verdict: 'inconclusive', reasonCodes: [primary ? 'no_qualified_evaluator' : 'no_evidence'] };
        } else {
          full = { ...binding, [spec.field]: primary, ...spec.extra };
          if (gateId === 'outcome_recorded') {
            decision = await outcomeDecision(orgId, taskId, primary);
          } else {
            const doc = await readJson<Record<string, unknown>>(orgId, taskId, primary);
            if (gateId === 'scope_accepted') {
              // The criteria to map are the pinned ones, not the discovery stage's own list.
              const pinned = binding.criteriaRef ? (await readJson<{ criteria: Array<{ id: string }> }>(orgId, taskId, binding.criteriaRef as ArtifactRefLike)).criteria.map((c) => c.id) : doc.criteriaIds;
              decision = evaluateScopeAccepted({ ...doc, criteriaIds: pinned });
            } else {
              // Independence comes from the producers recorded for the stage runs, not from the
              // reviewer's description of itself.
              decision = evaluateReviewPassed(producers ? { ...doc, reviewerProducerId: producers.reviewerProducerId, authorProducerIds: producers.authorProducerIds } : doc);
            }
          }
        }
        let inputHash: string;
        let projection: Record<string, unknown>;
        try {
          inputHash = gateInputHash(gateId, full);
          projection = gateBinding(gateId, full);
        } catch {
          inputHash = canonicalHash({ gateId, incomplete: full });
          projection = full;
          decision = { verdict: 'inconclusive', reasonCodes: ['incomplete_binding'] };
        }
        const evaluationId = await tenant(orgId, async (tx) => {
          await tx.query('SELECT 1 FROM factory.task WHERE id = $1 FOR UPDATE', [taskId]); // serialize per task
          const prior = await tx.query<{ id: string; verdict: string; reason_codes: string[] }>('SELECT id, verdict, reason_codes FROM factory.gate_evaluation WHERE task_id = $1 AND gate_id = $2 AND input_hash = $3 AND superseded_by IS NULL AND verdict <> $4', [taskId, gateId, inputHash, 'superseded']);
          const existing = prior.rows[0];
          if (existing) { decision = { verdict: existing.verdict as GateDecision['verdict'], reasonCodes: existing.reason_codes }; return existing.id; }
          const id = randomUUID();
          await tx.query(`INSERT INTO factory.gate_evaluation (org_id, id, task_id, gate_id, input_hash, input_binding, verdict, evidence_refs, evaluator_id, policy_ref, reason_codes, resolved_mode)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'automated')`,
            [orgId, id, taskId, gateId, inputHash, JSON.stringify({ ...projection, ...(binding.applicationSnapshotRef ? { applicationSnapshotRef: binding.applicationSnapshotRef } : {}), stageRunId: logicalId }), decision.verdict, JSON.stringify(primary ? [primary] : []), EVALUATOR_ID, JSON.stringify(binding.policyRef ?? null), JSON.stringify(decision.reasonCodes)]);
          return id;
        });
        results.push({ gateId, verdict: decision.verdict, evaluationId, reasonCodes: decision.reasonCodes });
      }
      return { allPassed: results.every((r) => r.verdict === 'passed'), results };
    },

    // A plan revision invalidates every evaluation bound to the old plan. The old rows stay
    // immutable; an appended 'superseded' marker records why and old rows point to it.
    async supersedeGates({ orgId, taskId, oldPlanVersion, newPlanVersion }) {
      return tenant(orgId, async (tx) => {
        const rows = await tx.query<{ id: string; gate_id: string; policy_ref: unknown }>("SELECT id, gate_id, policy_ref FROM factory.gate_evaluation WHERE task_id = $1 AND superseded_by IS NULL AND verdict <> 'superseded' AND (input_binding->>'planVersion')::int = $2", [taskId, oldPlanVersion]);
        for (const r of rows.rows) {
          const marker = randomUUID();
          await tx.query(`INSERT INTO factory.gate_evaluation (org_id, id, task_id, gate_id, input_hash, input_binding, verdict, evidence_refs, evaluator_id, policy_ref, reason_codes)
            VALUES ($1,$2,$3,$4,$5,$6,'superseded','[]','gate-engine:invalidation',$7,$8)`,
            [orgId, marker, taskId, r.gate_id, canonicalHash({ supersedes: r.id, newPlanVersion }), JSON.stringify({ supersedes: r.id, newPlanVersion }), JSON.stringify(r.policy_ref), JSON.stringify(['plan_revised'])]);
          await tx.query('UPDATE factory.gate_evaluation SET superseded_by = $2, updated_at = now() WHERE id = $1', [r.id, marker]);
        }
        return rows.rowCount ?? 0;
      });
    },

    async openBudget({ orgId, taskId, limitMicroUsd }) {
      return tenant(orgId, async (tx) => {
        const scope = await tx.query<{ delivery_scope: string; creator_id: string }>('SELECT delivery_scope, creator_id FROM factory.task WHERE id = $1', [taskId]);
        const task = scope.rows[0];
        // The creator pays: the task draws on the creator's allowance for the period it starts in.
        const personal = task ? await currentAllowance(tx, { orgId, principalId: task.creator_id }) : undefined;
        return { accountId: await openBudgetAccount(tx, { orgId, taskId, limitMicroUsd, deliveryScope: task?.delivery_scope ?? 'report', ...(personal ? { allowanceId: personal.allowanceId } : {}) }) };
      });
    },

    async reserveStageBudget({ orgId, taskId, operationKey, nodeId }) {
      return tenant(orgId, async (tx) => {
        const account = await tx.query<{ id: string }>('SELECT id FROM factory.budget_account WHERE task_id = $1', [taskId]);
        const accountId = account.rows[0]?.id;
        if (!accountId) return { admitted: false, reasons: ['no budget account'], chargedMicroUsd: 0, reservedMicroUsd: 0, limitMicroUsd: 0 };
        const r = await reserveBudget(tx, { orgId, accountId, operationKey, amountMicroUsd: deps.fakeStage?.estimateMicroUsd?.(nodeId) ?? 1_000_000 });
        const own = r.chain.at(-1);
        return { admitted: r.admitted, reasons: r.admitted ? [] : [`${r.reason} on account ${r.blockingAccountId}`], chargedMicroUsd: own?.chargedMicroUsd ?? 0, reservedMicroUsd: own?.reservedMicroUsd ?? 0, limitMicroUsd: own?.limitMicroUsd ?? 0 };
      });
    },

    async chargeStageBudget({ orgId, taskId, operationKey, nodeId, actualMicroUsd }) {
      return tenant(orgId, async (tx) => {
        const account = await tx.query<{ id: string }>('SELECT id FROM factory.budget_account WHERE task_id = $1', [taskId]);
        const accountId = account.rows[0]?.id;
        if (!accountId) return { admitted: false, reasons: ['no budget account'], chargedMicroUsd: 0, reservedMicroUsd: 0, limitMicroUsd: 0 };
        await chargeBudget(tx, { orgId, accountId, operationKey, actualMicroUsd: actualMicroUsd ?? deps.fakeStage?.actualMicroUsd?.(nodeId) ?? deps.fakeStage?.estimateMicroUsd?.(nodeId) ?? 1_000_000 });
        const u = await budgetUsage(tx, accountId);
        return { admitted: true, reasons: [], chargedMicroUsd: u?.chargedMicroUsd ?? 0, reservedMicroUsd: u?.reservedMicroUsd ?? 0, limitMicroUsd: u?.limitMicroUsd ?? 0 };
      });
    },

    // amend_spec: the new TaskSpec version is created only when the workflow applies the command.
    async materializeSpec({ orgId, taskId, specRef, version, actorCommandId }) {
      let doc: unknown;
      try { doc = await readJson<unknown>(orgId, taskId, specRef); } catch (e) { return { ok: false, reason: `spec artifact unreadable: ${e instanceof Error ? e.message : 'error'}` }; }
      const valid = validateContract('TaskRequest', doc);
      if (!valid.ok) return { ok: false, reason: 'amended spec is not a valid TaskRequest' };
      return tenant(orgId, async (tx) => {
        const task = await tx.query<{ delivery_scope: string; primary_application_id: string; creator_id: string }>('SELECT delivery_scope, primary_application_id, creator_id FROM factory.task WHERE id = $1', [taskId]);
        const t = task.rows[0];
        if (!t) return { ok: false as const, reason: 'task not found' };
        if ((t.delivery_scope === 'design') !== (valid.value.deliveryScope === 'design')) return { ok: false as const, reason: 'design_scope_change_requires_new_task' };
        if (valid.value.targetContext.applicationId !== t.primary_application_id) return { ok: false as const, reason: 'primary target cannot change; create a linked task' };
        const current = await tx.query<{ spec: { deliveryScope?: string; priorityClass?: string; budget?: unknown } }>('SELECT s.spec FROM factory.task_spec_version s JOIN factory.task t ON t.org_id = s.org_id AND t.id = s.task_id AND t.spec_version = s.version WHERE t.id = $1', [taskId]);
        const was = current.rows[0]?.spec;
        if (!was) return { ok: false as const, reason: 'current spec not found' };
        if (valid.value.deliveryScope !== was.deliveryScope || (valid.value.priorityClass ?? 'normal') !== (was.priorityClass ?? 'normal') || canonicalHash(valid.value.budget) !== canonicalHash(was.budget ?? null)) return { ok: false as const, reason: 'amendment changes scope, priority or budget' };
        const cmd = await tx.query<{ principal_id: string }>("SELECT principal_id FROM factory.command WHERE id = $1 AND task_id = $2 AND kind = 'amend_spec'", [actorCommandId, taskId]);
        const actor = cmd.rows[0]?.principal_id;
        if (!actor) return { ok: false as const, reason: 'amending command not found' };
        await tx.query('INSERT INTO factory.task_spec_version (org_id, id, task_id, version, spec, spec_hash, actor_id) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (org_id, task_id, version) DO NOTHING',
          [orgId, randomUUID(), taskId, version, JSON.stringify(valid.value), canonicalHash(valid.value), actor]);
        return { ok: true as const, version };
      });
    },

    // change_budget: a decrease never erases actual charges.
    async adjustBudget({ orgId, taskId, limitMicroUsd }) {
      return tenant(orgId, async (tx) => {
        const r = await tx.query<{ charged_micro_usd: string; reserved_micro_usd: string; limit_micro_usd: string }>(
          'UPDATE factory.budget_account SET limit_micro_usd = GREATEST($2::bigint, charged_micro_usd), revision = revision + 1, updated_at = now() WHERE task_id = $1 RETURNING charged_micro_usd, reserved_micro_usd, limit_micro_usd', [taskId, limitMicroUsd]);
        const row = r.rows[0];
        return { admitted: row !== undefined, reasons: row ? [] : ['no budget account'], chargedMicroUsd: Number(row?.charged_micro_usd ?? 0), reservedMicroUsd: Number(row?.reserved_micro_usd ?? 0), limitMicroUsd: Number(row?.limit_micro_usd ?? 0) };
      });
    },

    // Opens the bound approve_plan request for one independent required peer: an active reviewer on
    // the application who is neither the task's creator nor its owner.
    async requestPlanReview({ orgId, taskId, planVersion, nodeId, packetRef, policyRef }) {
      return tenant(orgId, async (tx) => {
        const task = await tx.query<{ creator_id: string; owner_principal_id: string; primary_application_id: string }>('SELECT creator_id, owner_principal_id, primary_application_id FROM factory.task WHERE id = $1', [taskId]);
        const t = task.rows[0];
        if (!t) return { ok: false as const, reason: 'task_not_found' };
        const authors = [...new Set([t.creator_id, t.owner_principal_id])];
        const reviewers = await tx.query<{ principal_id: string }>(`SELECT DISTINCT m.principal_id FROM factory.membership m JOIN factory.principal p ON p.org_id = m.org_id AND p.id = m.principal_id
          WHERE m.role = 'reviewer' AND m.revoked_at IS NULL AND p.disabled_at IS NULL AND (m.application_scope ? $1 OR m.application_scope ? '*') AND NOT (m.principal_id = ANY($2::uuid[])) ORDER BY m.principal_id`, [t.primary_application_id, authors]);
        const required = reviewers.rows[0]?.principal_id;
        if (!required) return { ok: false as const, reason: 'no_eligible_independent_reviewer' };
        const ttlMs = deps.decisionTtlMs ?? DEFAULT_DECISION_TTL_MS;
        const sectionIds = [...PLAN_SECTIONS];
        const subjectHash = canonicalHash({ action: 'approve_plan', taskId, planVersion, nodeId, packetRef, policyRef, requiredPrincipalId: required, sectionIds });
        await tx.query(`INSERT INTO factory.decision_request (org_id, id, task_id, action, subject_hash, subject_ref, policy_ref, evidence_refs, eligible_roles, required_principal_id, state, expires_at, reason)
          VALUES ($1,$2,$3,'approve_plan',$4,$5,$6,$7,'["reviewer"]',$8,'pending',now() + make_interval(secs => $9::bigint / 1000.0),$10)
          ON CONFLICT (org_id, task_id, subject_hash, required_principal_id) WHERE action = 'approve_plan' DO NOTHING`,
          [orgId, randomUUID(), taskId, subjectHash, JSON.stringify(packetRef), JSON.stringify(policyRef), JSON.stringify([packetRef]), required, ttlMs, 'Approve the exact engineering plan packet before implementation']);
        const r = await tx.query<{ id: string }>("SELECT id FROM factory.decision_request WHERE task_id = $1 AND subject_hash = $2 AND required_principal_id = $3 AND action = 'approve_plan'", [taskId, subjectHash, required]);
        const id = r.rows[0]?.id;
        if (!id) throw new Error('decision request not persisted');
        return { ok: true as const, decision: { nodeId, requestId: id, subjectHash, requiredPrincipalId: required, sectionIds, authorPrincipalIds: authors, ttlMs, state: 'pending' as const } };
      });
    },

    // Records the immutable human decision (or the expiry/supersession) and evaluates
    // plan_peer_approved, re-checking the decider's authority at application time.
    async settleDecision({ orgId, taskId, decision, binding }) {
      return tenant(orgId, async (tx) => {
        const reasons: string[] = [];
        if (decision.state === 'approve' || decision.state === 'reject' || decision.state === 'request_changes') {
          const decider = decision.deciderPrincipalId ?? '';
          // The durable timer can fire late (worker down); the stored expiry still binds.
          const live = await tx.query<{ expired: boolean }>('SELECT expires_at <= now() AS expired FROM factory.decision_request WHERE id = $1', [decision.requestId]);
          if (live.rows[0]?.expired !== false) reasons.push('decision_expired');
          const authority = await tx.query<{ id: string }>(`SELECT m.id FROM factory.membership m JOIN factory.principal p ON p.org_id = m.org_id AND p.id = m.principal_id JOIN factory.task t ON t.id = $2
            WHERE m.principal_id = $1 AND m.role = 'reviewer' AND m.revoked_at IS NULL AND p.disabled_at IS NULL AND (m.application_scope ? t.primary_application_id::text OR m.application_scope ? '*')`, [decider, taskId]);
          const membership = authority.rows[0]?.id;
          if (!membership) reasons.push('decider_authority_revoked');
          await tx.query(`INSERT INTO factory.decision (org_id, id, request_id, decider_id, subject_hash, command_id, reviewed_section_ids, outcome, reason, authority_ref)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (org_id, request_id) DO NOTHING`,
            [orgId, randomUUID(), decision.requestId, decider, decision.subjectHash, decision.commandId ?? randomUUID(), JSON.stringify(decision.reviewedSectionIds ?? []), decision.state, decision.reason ?? decision.state, JSON.stringify({ role: 'reviewer', membershipId: membership ?? null, revalidatedAtApply: true })]);
          const stateName = decision.state === 'approve' ? 'approved' : decision.state === 'reject' ? 'rejected' : 'changes_requested';
          await tx.query("UPDATE factory.decision_request SET state = $2, updated_at = now() WHERE id = $1 AND state = 'pending'", [decision.requestId, stateName]);
        } else {
          await tx.query("UPDATE factory.decision_request SET state = $2, updated_at = now() WHERE id = $1 AND state = 'pending'", [decision.requestId, decision.state]);
          reasons.push(decision.state === 'expired' ? 'decision_expired' : 'decision_superseded');
        }
        if (decision.state !== 'approve') reasons.push(`outcome_${decision.state}`);
        const passed = reasons.length === 0;
        const request = await tx.query<{ subject_ref: ArtifactRefLike; policy_ref: unknown }>('SELECT subject_ref, policy_ref FROM factory.decision_request WHERE id = $1', [decision.requestId]);
        const approvals = await store(orgId, taskId, { schemaVersion: '2.0', requestId: decision.requestId, subjectHash: decision.subjectHash, decisions: [{ decider: decision.deciderPrincipalId ?? null, outcome: decision.state, reviewedSectionIds: decision.reviewedSectionIds ?? [] }] }, 'plan_approval_set', tx);
        const full = { ...binding, reviewPacketRef: request.rows[0]?.subject_ref, planApprovalSetRef: approvals };
        const inputs = { ...gateBinding('plan_peer_approved', full), ...(binding.applicationSnapshotRef ? { applicationSnapshotRef: binding.applicationSnapshotRef } : {}), subjectHash: decision.subjectHash };
        await tx.query(`INSERT INTO factory.gate_evaluation (org_id, id, task_id, gate_id, input_hash, input_binding, verdict, evidence_refs, evaluator_id, policy_ref, reason_codes, resolved_mode)
          VALUES ($1,$2,$3,'plan_peer_approved',$4,$5,$6,$7,$8,$9,$10,'human')`,
          [orgId, randomUUID(), taskId, gateInputHash('plan_peer_approved', full), JSON.stringify(inputs), passed ? 'passed' : 'failed', JSON.stringify([approvals]), EVALUATOR_ID, JSON.stringify(request.rows[0]?.policy_ref ?? null), JSON.stringify(passed ? ['exact_subject_peer_approval'] : reasons)]);
        return { gate: passed ? 'passed' as const : 'failed' as const, reasonCodes: passed ? ['exact_subject_peer_approval'] : reasons };
      });
    },

    async supersedeDecisions({ orgId, taskId }) {
      return tenant(orgId, async (tx) => (await tx.query("UPDATE factory.decision_request SET state = 'superseded', updated_at = now() WHERE task_id = $1 AND state = 'pending'", [taskId])).rowCount ?? 0);
    },

    // deliver (outcome-v1): a trusted controller stage. Authorization and evidence are re-verified
    // immediately before the side effect (chapter 01): every gate required upstream must have a
    // current passing evaluation on this plan, and review_passed must name this exact candidate and
    // review. The delivered report is a finalized artifact; nothing is published elsewhere.
    async deliverReport({ orgId, taskId, planVersion, candidateRef, reviewRef, requiredGateIds }) {
      const rows = await tenant(orgId, (tx) => tx.query<{ gate_id: string; verdict: string; input_binding: Record<string, unknown>; evidence_refs: ArtifactRefLike[] }>(
        "SELECT gate_id, verdict, input_binding, evidence_refs FROM factory.gate_evaluation WHERE task_id = $1 AND superseded_by IS NULL AND verdict <> 'superseded' AND (input_binding->>'planVersion')::int = $2", [taskId, planVersion]));
      for (const gateId of requiredGateIds) {
        if (!rows.rows.some((g) => g.gate_id === gateId && g.verdict === 'passed')) return { ok: false as const, reason: `gate_not_current:${gateId}` };
      }
      const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);
      const review = rows.rows.find((g) => g.gate_id === 'review_passed' && g.verdict === 'passed' && same(g.input_binding.candidateRef, candidateRef) && g.evidence_refs.some((r) => same(r, reviewRef)));
      if (!review) return { ok: false as const, reason: 'review_not_bound_to_candidate' };
      let candidate: Record<string, unknown>;
      let reviewDoc: Record<string, unknown>;
      try {
        candidate = await readJson<Record<string, unknown>>(orgId, taskId, candidateRef);
        reviewDoc = await readJson<Record<string, unknown>>(orgId, taskId, reviewRef);
      } catch { return { ok: false as const, reason: 'delivery_evidence_unverifiable' }; }
      const spec = await tenant(orgId, (tx) => tx.query<{ spec: { title?: string; acceptanceCriteria?: string[] }; spec_version: number }>(
        'SELECT s.spec, p.spec_version FROM factory.execution_plan p JOIN factory.task_spec_version s ON s.org_id = p.org_id AND s.task_id = p.task_id AND s.version = p.spec_version WHERE p.task_id = $1 AND p.version = $2', [taskId, planVersion]));
      const row = spec.rows[0];
      if (!row) return { ok: false as const, reason: 'plan_not_found' };
      const report = {
        schemaVersion: '2.0', kind: 'investigation_report', taskId, specVersion: row.spec_version, planVersion, title: row.spec.title ?? '',
        criteria: (row.spec.acceptanceCriteria ?? []).map((text, i) => ({ id: `C${String(i + 1)}`, text })),
        summary: candidate.summary ?? null, reviewedCandidateRef: candidateRef, reviewRef, reviewFindings: Array.isArray(reviewDoc.findings) ? reviewDoc.findings : [],
        limitations: ['Produced by the M1 deterministic fake runner: the findings are synthetic and no system was inspected.'],
      };
      return { ok: true as const, ref: await store(orgId, taskId, report, 'delivered_report') };
    },

    // close (outcome-v1): builds the OutcomeManifest from control-plane facts only. Gate evaluations
    // and human decisions are exported as immutable artifacts so the manifest's refs are
    // digest-checkable. Fails closed on anything this release cannot account for: AI review mode,
    // allocated execution resources (unknown cleanup) or a provenance violation.
    async recordOutcome({ orgId, taskId, planVersion, deliveredRefs, providerHandles }) {
      const facts = await tenant(orgId, async (tx) => {
        const task = await tx.query<{ delivery_scope: string; primary_application_id: string }>('SELECT delivery_scope, primary_application_id FROM factory.task WHERE id = $1', [taskId]);
        const t = task.rows[0];
        if (!t) return undefined;
        const aiMode = await tx.query('SELECT 1 FROM factory.review_mode_decision WHERE application_id = $1 LIMIT 1', [t.primary_application_id]);
        const allocations = await tx.query<{ n: string }>('SELECT count(*) AS n FROM factory.execution_allocation a JOIN factory.stage_run s ON s.org_id = a.org_id AND s.id = a.stage_run_id WHERE s.task_id = $1', [taskId]);
        const gates = await tx.query<GateRow>(`SELECT id, task_id, gate_id, input_hash, input_binding, verdict, evidence_refs, evaluator_id, reason_codes, created_at, superseded_by, resolved_mode
          FROM factory.gate_evaluation WHERE task_id = $1 AND superseded_by IS NULL AND verdict <> 'superseded' AND (input_binding->>'planVersion')::int = $2 ORDER BY created_at, id`, [taskId, planVersion]);
        // Only human approvals that a current passing gate is bound to are cited as authority.
        const subjects = gates.rows.filter((g) => g.verdict === 'passed' && typeof g.input_binding.subjectHash === 'string').map((g) => g.input_binding.subjectHash as string);
        const decisions = await tx.query<{ id: string; task_id: string; action: string; subject_hash: string; subject_ref: ArtifactRefLike; policy_ref: ArtifactRefLike; evidence_refs: ArtifactRefLike[]; eligible_roles: string[]; state: string; reason: string; expires_at: Date; required_principal_id: string | null; decider_id: string }>(
          `SELECT r.id, r.task_id, r.action, r.subject_hash, r.subject_ref, r.policy_ref, r.evidence_refs, r.eligible_roles, r.state, r.reason, r.expires_at, r.required_principal_id, d.decider_id
           FROM factory.decision_request r JOIN factory.decision d ON d.org_id = r.org_id AND d.request_id = r.id
           WHERE r.task_id = $1 AND r.state = 'approved' AND d.actor_kind = 'human' AND r.subject_hash = ANY($2::text[]) ORDER BY d.created_at, r.id`, [taskId, subjects]);
        const ledger = await tx.query<{ operation_key: string; amount_micro_usd: string; created_at: Date }>(
          "SELECT l.operation_key, l.amount_micro_usd, l.created_at FROM factory.budget_ledger l JOIN factory.budget_account a ON a.org_id = l.org_id AND a.id = l.account_id WHERE a.task_id = $1 AND l.kind = 'observed_usage' ORDER BY l.created_at, l.id", [taskId]);
        return { t, aiMode: (aiMode.rowCount ?? 0) > 0, allocations: Number(allocations.rows[0]?.n ?? 0), gates: gates.rows, decisions: decisions.rows, ledger: ledger.rows };
      });
      if (!facts) return { ok: false as const, reason: 'task_not_found' };
      if (facts.aiMode) return { ok: false as const, reason: 'ai_only_not_supported' };
      if (facts.allocations > 0) return { ok: false as const, reason: 'cleanup_obligations_unresolved' };
      if (deliveredRefs.length === 0) return { ok: false as const, reason: 'no_delivered_artifact' };
      const gateEvaluationRefs: ArtifactRefLike[] = [];
      for (const row of facts.gates) {
        const view = gateEvaluationView(row);
        if (!view || !validateContract('GateEvaluation', view).ok) return { ok: false as const, reason: `gate_without_contract_view:${row.gate_id}` };
        gateEvaluationRefs.push(await store(orgId, taskId, view, 'gate_evaluation_record'));
      }
      // Every passing human-mode gate must be backed by a cited human decision on its subject.
      for (const g of facts.gates.filter((x) => x.verdict === 'passed' && x.resolved_mode === 'human')) {
        if (!facts.decisions.some((d) => d.subject_hash === g.input_binding.subjectHash)) return { ok: false as const, reason: `human_gate_without_decision:${g.gate_id}` };
      }
      const decisionRefs: ArtifactRefLike[] = [];
      for (const r of facts.decisions) {
        const view = { id: r.id, taskId: r.task_id, action: r.action, subjectHash: r.subject_hash, subjectRef: r.subject_ref, policyRef: r.policy_ref, evidenceRefs: r.evidence_refs, eligibleRoles: r.eligible_roles, state: r.state, reason: r.reason, expiresAt: r.expires_at.toISOString(),
          ...(r.required_principal_id ? { requiredPrincipalId: r.required_principal_id } : {}), deciderId: r.decider_id, actorKind: 'human' };
        if (!validateContract('DecisionView', view).ok) return { ok: false as const, reason: 'decision_without_contract_view' };
        decisionRefs.push(await store(orgId, taskId, view, 'human_decision_record'));
      }
      const usage = facts.ledger.map((l) => ({ provider: 'm1-fake-runner', modelProfile: 'fake-deterministic', quality: 'estimated', costMicroUsd: Number(l.amount_micro_usd), source: `budget_ledger:${l.operation_key}`, observedAt: l.created_at.toISOString() }));
      const manifest = {
        schemaVersion: '2.0', taskId, status: 'succeeded', deliveryScope: facts.t.delivery_scope, outcomeKind: 'delivered', deliveredArtifactRefs: deliveredRefs,
        providerHandles: [...providerHandles, ...deliveredRefs.map((r) => `artifact-store:${r.artifactId}`)], gateEvaluationRefs, decisionRefs, usage,
        limitations: ['M1 fake vertical slice: stage outputs come from the deterministic fake runner; no harness, model, repository or environment was used.', 'Usage costs are configured fake-runner values recorded in the budget ledger, not provider-reported usage.'],
        knowledgeProposalIds: [], cleanupObligationRefs: [], completedAt: new Date().toISOString(), reviewMode: 'human',
      };
      if (!validateContract('OutcomeManifest', manifest).ok) return { ok: false as const, reason: 'outcome_manifest_invalid' };
      const provenance = checkOutcomeProvenance(manifest, await resolveAuthorities(manifest, authorityIo(orgId, taskId)), { aiOnlySupported: false, validate: contractCheck });
      if (!provenance.ok) return { ok: false as const, reason: `provenance_${provenance.reason}` };
      // No execution resources were allocated, so nothing remains to clean up.
      await tenant(orgId, (tx) => tx.query("UPDATE factory.task SET cleanup_state = 'complete', updated_at = now() WHERE id = $1 AND cleanup_state <> 'complete'", [taskId]));
      return { ok: true as const, ref: await store(orgId, taskId, manifest, 'outcome_manifest') };
    },

    async project({ orgId, taskId, sequence, state, refs, eventType, correlationId }) {
      const object = await deps.artifacts.putControllerObject(orgId, Buffer.from(canonicalJson({ schemaVersion: '2.0', eventType, sequence, state, refs })));
      const r = await tenant(orgId, async (tx) => {
        const payloadRef = await deps.artifacts.registerControllerArtifact(tx, { orgId, taskId, producerId: CONTROLLER, object, mediaType: 'application/json', schemaVersion: '2.0', classification: 'ordinary', purpose: 'task_event_payload' });
        return projectTransition(tx, { orgId, taskId, sequence, state, refs, eventType, payloadRef, correlationId, producerEventId: `workflow:${taskId}:projection:${String(sequence)}` });
      });
      return { outcome: r.outcome };
    },
  };
}
