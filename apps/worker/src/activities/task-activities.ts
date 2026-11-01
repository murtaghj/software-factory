// TaskWorkflow Activities (W-011). Every Activity is idempotent on a stable key, so Temporal
// infrastructure retries never duplicate effects (INV-02): plans by (task, version), stage runs by
// logical ID, projections by sequence + hash.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ApplicationFailure } from '@temporalio/activity';
import { validateContract } from '@factory/contracts';
import { canonicalHash, canonicalJson } from '@factory/domain';
import { projectTransition, type Database, type Tx } from '@factory/database';
import type { ArtifactService } from '@factory/artifacts';
import type { ArtifactRefLike, FakeStageResult, PlanSnapshot, TaskActivities } from '../workflows/types.ts';

export const TEMPLATES_DIR = join(import.meta.dirname, '..', 'templates');
const TEMPLATE_BY_WORK_TYPE: Record<string, string> = { investigation: 'investigation-0.1.0.json' };
// M1 default policy (A-10). W-013 replaces this with the resolved PolicyProfile.
export const M1_POLICY = { id: 'm1-default-policy', revision: 1, defaultAssurance: 'standard' } as const;

export type FakeStageBehavior = {
  delayMs?: (nodeId: string, attempt: number, planVersion: number) => number;
  outcome?: (nodeId: string, attempt: number, planVersion: number) => FakeStageResult['status'];
};
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
      const nodes = template.nodes.map((n) => ({ id: n.id, stageKind: n.stageKind, role: n.role, dependsOn: n.dependsOn, requiredGateIds: n.requiredGateIds, timeoutClass: n.timeoutClass, mandatory: n.mandatory }));
      const body = { taskId, version: planVersion, specVersion, templateRef: { id: template.id, version: template.version, definitionRef }, policyRef, nodes };
      const plan: PlanSnapshot = { version: planVersion, specVersion, planHash: canonicalHash(body), policyRef, templateRef: body.templateRef, nodes };
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
      const output = await store(orgId, taskId, { schemaVersion: '2.0', kind: 'fake_stage_output', stageKind, nodeId, stageRunId: logicalId, inputHash, summary: `fake ${stageKind} output for ${nodeId}` }, 'stage_output');
      const result: FakeStageResult = { schemaVersion: '2.0', orgId, taskId, stageRunId: logicalId, inputHash, allocationEpoch: 1, status, outputRefs: [output], usage: [], producerId: 'fake-runner', completedAt: new Date().toISOString(), producerKind: 'runner' };
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
