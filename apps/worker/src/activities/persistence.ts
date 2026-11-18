// Persistence Activities: task load, stage runs, stage supersession and the projection write. Stage
// runs are keyed by logical ID, projections by sequence and hash (INV-02).
import { randomUUID } from 'node:crypto';
import { ApplicationFailure } from '@temporalio/activity';
import { canonicalJson } from '@factory/domain';
import { projectTransition } from '@factory/database';
import type { PlanSnapshot, TaskActivities } from '../workflows/types.ts';
import { CONTROLLER, type ActivityKit } from './shared.ts';

type Persistence = Pick<TaskActivities, 'loadTask' | 'startStage' | 'finishStage' | 'supersedeStages' | 'project'>;

export function persistenceActivities({ deps, tenant, store }: ActivityKit): Persistence {
  return {
    async loadTask({ orgId, taskId }) {
      const r = await tenant(orgId, (tx) => tx.query<{ status: PlanSnapshot['nodes'][number]['role']; spec_version: number; control_revision: string; projection_sequence: string }>('SELECT status, spec_version, control_revision, projection_sequence FROM factory.task WHERE id = $1', [taskId]));
      const row = r.rows[0];
      if (!row) throw ApplicationFailure.nonRetryable(`task ${taskId} not found`, 'task_not_found');
      return { status: row.status as never, specVersion: row.spec_version, controlRevision: Number(row.control_revision), projectionSequence: Number(row.projection_sequence) };
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
