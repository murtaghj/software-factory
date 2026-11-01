// Workflow transition projection (chapter 02 "Ownership and consistency"; AC-04).
//
// projectTransition locks the task row and hashes (sequence, state, refs) canonically:
//   - a higher sequence applies the transition and stores projection_sequence and projection_hash
//     together, with a task event allocated from last_event_sequence in the same transaction;
//   - an equal sequence is an idempotent replay only when the hash matches; otherwise it is an
//     integrity incident;
//   - a lower sequence is rejected as stale and changes nothing.
import { randomUUID } from 'node:crypto';
import { canonicalHash } from '@factory/domain';
import type { Tx } from './db.ts';

export type ProjectedState = {
  status: 'accepted' | 'queued' | 'running' | 'waiting_input' | 'waiting_decision' | 'paused' | 'cancelling' | 'succeeded' | 'incomplete' | 'failed' | 'cancelled';
  currentNodeId?: string | null;
  waitingReason?: string | null;
  specVersion?: number;
  planVersion?: number;
  controlRevision?: number;
  outcomeRef?: unknown;
};
export type ProjectionRefs = Record<string, unknown>;
export type ProjectionResult =
  | { outcome: 'applied'; sequence: number; eventSequence: number }
  | { outcome: 'duplicate'; sequence: number }
  | { outcome: 'stale'; storedSequence: number };

export class ProjectionIntegrityIncident extends Error {
  readonly taskId: string;
  readonly sequence: number;
  constructor(taskId: string, sequence: number) {
    super(`projection ${String(sequence)} for task ${taskId} conflicts with the stored transition`);
    this.name = 'ProjectionIntegrityIncident';
    this.taskId = taskId;
    this.sequence = sequence;
  }
}

export function projectionHash(sequence: number, state: ProjectedState, refs: ProjectionRefs): string {
  return canonicalHash({ sequence, state, refs });
}

export async function projectTransition(tx: Tx, input: { orgId: string; taskId: string; sequence: number; state: ProjectedState; refs: ProjectionRefs; eventType: string; payloadRef: unknown; correlationId: string; producerEventId: string }): Promise<ProjectionResult> {
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) throw new Error('projection sequence must be a positive integer');
  const hash = projectionHash(input.sequence, input.state, input.refs);
  const locked = await tx.query<{ projection_sequence: string; projection_hash: string | null; last_event_sequence: string }>(
    'SELECT projection_sequence, projection_hash, last_event_sequence FROM factory.task WHERE id = $1 FOR UPDATE', [input.taskId]);
  const row = locked.rows[0];
  if (!row) throw new Error(`task ${input.taskId} not found`);
  const stored = Number(row.projection_sequence);
  if (input.sequence < stored) return { outcome: 'stale', storedSequence: stored };
  if (input.sequence === stored) {
    if (row.projection_hash === hash) return { outcome: 'duplicate', sequence: stored };
    throw new ProjectionIntegrityIncident(input.taskId, input.sequence);
  }
  const eventSequence = Number(row.last_event_sequence) + 1;
  const s = input.state;
  await tx.query(`UPDATE factory.task SET status = $2, projection_sequence = $3, projection_hash = $4, projected_at = now(), last_event_sequence = $5,
      current_node_id = $6, waiting_reason = $7, spec_version = COALESCE($8, spec_version), plan_version = COALESCE($9, plan_version),
      control_revision = COALESCE($10, control_revision), outcome_ref = COALESCE($11, outcome_ref), updated_at = now()
    WHERE id = $1`,
    [input.taskId, s.status, input.sequence, hash, eventSequence, s.currentNodeId ?? null, s.waitingReason ?? null, s.specVersion ?? null, s.planVersion ?? null, s.controlRevision ?? null, s.outcomeRef === undefined ? null : JSON.stringify(s.outcomeRef)]);
  await tx.query(`INSERT INTO factory.task_event (org_id, id, task_id, sequence, producer_event_id, event_type, occurred_at, source, schema_version, correlation_id, payload_ref)
    VALUES ($1,$2,$3,$4,$5,$6,now(),'workflow','2.0',$7,$8)`,
    [input.orgId, randomUUID(), input.taskId, eventSequence, input.producerEventId, input.eventType, input.correlationId, JSON.stringify(input.payloadRef)]);
  return { outcome: 'applied', sequence: input.sequence, eventSequence };
}

// Runner/stage progress events advance only the event counter, never the projection sequence.
export async function appendTaskEvent(tx: Tx, input: { orgId: string; taskId: string; eventType: string; source: string; payloadRef: unknown; correlationId: string; producerEventId: string }): Promise<{ eventSequence: number; duplicate: boolean }> {
  const existing = await tx.query<{ sequence: string }>('SELECT sequence FROM factory.task_event WHERE producer_event_id = $1', [input.producerEventId]);
  if (existing.rows[0]) return { eventSequence: Number(existing.rows[0].sequence), duplicate: true };
  const locked = await tx.query<{ last_event_sequence: string }>('SELECT last_event_sequence FROM factory.task WHERE id = $1 FOR UPDATE', [input.taskId]);
  const row = locked.rows[0];
  if (!row) throw new Error(`task ${input.taskId} not found`);
  const eventSequence = Number(row.last_event_sequence) + 1;
  await tx.query('UPDATE factory.task SET last_event_sequence = $2, updated_at = now() WHERE id = $1', [input.taskId, eventSequence]);
  await tx.query(`INSERT INTO factory.task_event (org_id, id, task_id, sequence, producer_event_id, event_type, occurred_at, source, schema_version, correlation_id, payload_ref)
    VALUES ($1,$2,$3,$4,$5,$6,now(),$7,'2.0',$8,$9)`,
    [input.orgId, randomUUID(), input.taskId, eventSequence, input.producerEventId, input.eventType, input.source, input.correlationId, JSON.stringify(input.payloadRef)]);
  return { eventSequence, duplicate: false };
}
