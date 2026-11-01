// TaskWorkflow Activities (W-011). Every Activity is idempotent on a stable key, so Temporal
// infrastructure retries never duplicate effects (INV-02): plans by (task, version), stage runs by
// logical ID, projections by sequence + hash.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ApplicationFailure } from '@temporalio/activity';
import { validateContract } from '@factory/contracts';
import { canonicalHash, canonicalJson, evaluateOutcomeRecorded, evaluateReviewPassed, evaluateScopeAccepted, gateBinding, gateInputHash, type GateDecision, type GateId } from '@factory/domain';
import { budgetUsage, chargeBudget, openBudgetAccount, projectTransition, reserveBudget, type Database, type Tx } from '@factory/database';
import type { ArtifactService } from '@factory/artifacts';
import type { ArtifactRefLike, FakeStageResult, GateResult, PlanSnapshot, TaskActivities } from '../workflows/types.ts';

export const TEMPLATES_DIR = join(import.meta.dirname, '..', 'templates');
const TEMPLATE_BY_WORK_TYPE: Record<string, string> = { investigation: 'investigation-0.1.0.json' };
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
};

const EVALUATOR_ID = 'gate-evaluator:m1';
const REVIEWER_PRODUCER = 'fake-reviewer';
const AUTHOR_PRODUCER = 'fake-runner';
export type ActivityDeps = { db: Database; artifacts: ArtifactService; fakeStage?: FakeStageBehavior };

const CONTROLLER = 'control-plane:worker';

export function createTaskActivities(deps: ActivityDeps): TaskActivities {
  const tenant = <T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> => deps.db.withTenant({ orgId }, fn);
  const store = async (orgId: string, taskId: string, doc: unknown, purpose: string, tx?: Tx): Promise<ArtifactRefLike> => {
    const object = await deps.artifacts.putControllerObject(orgId, Buffer.from(canonicalJson(doc)));
    const register = (t: Tx) => deps.artifacts.registerControllerArtifact(t, { orgId, taskId, producerId: CONTROLLER, object, mediaType: 'application/json', schemaVersion: '2.0', classification: 'ordinary', purpose });
    return tx ? register(tx) : tenant(orgId, register);
  };
  const readJson = async <T>(orgId: string, taskId: string, ref: ArtifactRefLike): Promise<T> =>
    JSON.parse((await deps.artifacts.readVerified({ orgId, actorId: CONTROLLER, actorKind: 'service', taskId, grantIds: [], correlationId: taskId }, ref)).toString('utf8')) as T;

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
      const file = TEMPLATE_BY_WORK_TYPE[workType];
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
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      const status = deps.fakeStage?.outcome?.(nodeId, attempt, planVersion) ?? 'completed';
      const criteria = await tenant(orgId, (tx) => tx.query<{ spec: { acceptanceCriteria?: string[] } }>('SELECT s.spec FROM factory.task_spec_version s JOIN factory.execution_plan p ON p.org_id = s.org_id AND p.task_id = s.task_id AND p.spec_version = s.version WHERE p.task_id = $1 AND p.version = $2', [taskId, planVersion]));
      const criteriaIds = (criteria.rows[0]?.spec.acceptanceCriteria ?? []).map((_t, i) => `C${String(i + 1)}`);
      const defaults: Record<string, Record<string, unknown>> = {
        discover: { criteriaIds, mappedCriteriaIds: criteriaIds, blockingGaps: [] },
        review: { findings: [], reviewerProducerId: REVIEWER_PRODUCER, authorProducerIds: [AUTHOR_PRODUCER], scopeReviewed: true },
        learn_close: { outcomeManifestPresent: true, cleanupKnown: true },
      };
      const evidence = deps.fakeStage?.evidence?.(nodeId, defaults[stageKind] ?? {}) ?? defaults[stageKind] ?? {};
      const output = await store(orgId, taskId, { schemaVersion: '2.0', kind: 'fake_stage_output', stageKind, nodeId, stageRunId: logicalId, inputHash, summary: `fake ${stageKind} output for ${nodeId}`, ...evidence }, 'stage_output');
      const result: FakeStageResult = { schemaVersion: '2.0', orgId, taskId, stageRunId: logicalId, inputHash, allocationEpoch: 1, status, outputRefs: [output], usage: [], producerId: stageKind === 'review' ? REVIEWER_PRODUCER : AUTHOR_PRODUCER, completedAt: new Date().toISOString(), producerKind: 'runner' };
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
    async evaluateGates({ orgId, taskId, logicalId, requiredGateIds, binding, outputRefs, dependencyRefs }) {
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
          const doc = await readJson<Record<string, unknown>>(orgId, taskId, primary);
          decision = gateId === 'scope_accepted' ? evaluateScopeAccepted(doc) : gateId === 'review_passed' ? evaluateReviewPassed(doc) : evaluateOutcomeRecorded(doc);
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
            [orgId, id, taskId, gateId, inputHash, JSON.stringify({ ...projection, stageRunId: logicalId }), decision.verdict, JSON.stringify(primary ? [primary] : []), EVALUATOR_ID, JSON.stringify(binding.policyRef ?? null), JSON.stringify(decision.reasonCodes)]);
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
        const scope = await tx.query<{ delivery_scope: string }>('SELECT delivery_scope FROM factory.task WHERE id = $1', [taskId]);
        return { accountId: await openBudgetAccount(tx, { orgId, taskId, limitMicroUsd, deliveryScope: scope.rows[0]?.delivery_scope ?? 'report' }) };
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

    async chargeStageBudget({ orgId, taskId, operationKey, nodeId }) {
      return tenant(orgId, async (tx) => {
        const account = await tx.query<{ id: string }>('SELECT id FROM factory.budget_account WHERE task_id = $1', [taskId]);
        const accountId = account.rows[0]?.id;
        if (!accountId) return { admitted: false, reasons: ['no budget account'], chargedMicroUsd: 0, reservedMicroUsd: 0, limitMicroUsd: 0 };
        await chargeBudget(tx, { orgId, accountId, operationKey, actualMicroUsd: deps.fakeStage?.actualMicroUsd?.(nodeId) ?? deps.fakeStage?.estimateMicroUsd?.(nodeId) ?? 1_000_000 });
        const u = await budgetUsage(tx, accountId);
        return { admitted: true, reasons: [], chargedMicroUsd: u?.chargedMicroUsd ?? 0, reservedMicroUsd: u?.reservedMicroUsd ?? 0, limitMicroUsd: u?.limitMicroUsd ?? 0 };
      });
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
