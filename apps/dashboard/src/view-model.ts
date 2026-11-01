// Task, stage and gate view models with honest projection staleness (W-014; chapter 12 "State
// presentation": task detail stays readable from its last projection while indicating staleness).
import type { GateEvaluation, RunView, TaskView } from '@factory/contracts';
import type { Connection } from './store.ts';

const TERMINAL = new Set(['succeeded', 'incomplete', 'failed', 'cancelled']);
export const STALE_AFTER_MS = 60_000;

export type StatusTone = 'neutral' | 'active' | 'waiting' | 'success' | 'warning' | 'danger';
const TONES: Record<TaskView['status'], StatusTone> = { accepted: 'neutral', queued: 'neutral', running: 'active', waiting_input: 'waiting', waiting_decision: 'waiting', paused: 'waiting', cancelling: 'warning', succeeded: 'success', incomplete: 'warning', failed: 'danger', cancelled: 'neutral' };

export type TaskModel = {
  title: string;
  status: { value: TaskView['status']; label: string; tone: StatusTone };
  currentNode?: string;
  stages: Array<{ nodeId: string; attempt: number; planVersion: number; status: string; superseded: boolean; logicalId: string }>;
  gates: Array<{ gateId: string; verdict: GateEvaluation['verdict']; current: boolean; reasonCodes: string[] }>;
  freshness: { projectedAt: string; ageSeconds: number; stale: boolean; connection: Connection; message: string };
};

export function taskModel(task: TaskView, runs: RunView[], gates: GateEvaluation[], connection: Connection, nowMs: number): TaskModel {
  const ageMs = Math.max(0, nowMs - Date.parse(task.projectedAt));
  const terminal = TERMINAL.has(task.status);
  const disconnected = connection === 'disconnected' || connection === 'connecting';
  const stale = !terminal && (disconnected || ageMs > STALE_AFTER_MS);
  const asOf = `as of ${task.projectedAt}`;
  const message = connection === 'refreshing' ? `Refreshing from the latest snapshot; showing state ${asOf}`
    : disconnected ? `Disconnected — showing the last known state ${asOf}`
    : stale ? `No update for ${String(Math.round(ageMs / 1000))} s — state ${asOf} may be out of date`
    : `Live — state ${asOf}`;
  return {
    title: task.spec.title,
    status: { value: task.status, label: task.status.replace('_', ' '), tone: TONES[task.status] },
    ...(task.currentNodeId ? { currentNode: task.currentNodeId } : {}),
    stages: runs.map((r) => ({ nodeId: r.nodeId, attempt: r.semanticAttempt, planVersion: r.planVersion, status: r.status, superseded: r.supersededAt !== undefined, logicalId: r.id })),
    gates: gates.map((g) => ({ gateId: g.gateId, verdict: g.verdict, current: g.supersededBy === undefined && g.verdict !== 'superseded', reasonCodes: g.reasonCodes })),
    freshness: { projectedAt: task.projectedAt, ageSeconds: Math.round(ageMs / 1000), stale, connection, message },
  };
}
