// Task, stage and gate view models with honest projection staleness (W-014; chapter 12 "State
// presentation": task detail stays readable from its last projection while indicating staleness).
import type { GateEvaluation, RunView, TaskView } from '@factory/contracts';
import type { Connection } from './store.ts';
import { relativeTime } from './format.ts';

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
  // A task that is waiting on a person or paused is not expected to change; only a lost connection
  // makes its state doubtful.
  const quiet = task.status === 'waiting_decision' || task.status === 'waiting_input' || task.status === 'paused';
  const stale = !terminal && (disconnected || (!quiet && ageMs > STALE_AFTER_MS));
  const updated = `last updated ${relativeTime(task.projectedAt, nowMs)}`;
  const message = connection === 'refreshing' ? `Refreshing — ${updated}`
    : disconnected ? `Disconnected — showing the last known state, ${updated}`
    : stale ? `No update since ${relativeTime(task.projectedAt, nowMs)} — this may be out of date`
    : `Live — ${updated}`;
  return {
    title: task.spec.title,
    status: { value: task.status, label: task.status.replace('_', ' '), tone: TONES[task.status] },
    ...(task.currentNodeId ? { currentNode: task.currentNodeId } : {}),
    stages: runs.map((r) => ({ nodeId: r.nodeId, attempt: r.semanticAttempt, planVersion: r.planVersion, status: r.status, superseded: r.supersededAt !== undefined, logicalId: r.id })),
    gates: gates.map((g) => ({ gateId: g.gateId, verdict: g.verdict, current: g.supersededBy === undefined && g.verdict !== 'superseded', reasonCodes: g.reasonCodes })),
    freshness: { projectedAt: task.projectedAt, ageSeconds: Math.round(ageMs / 1000), stale, connection, message },
  };
}

// The plan as a pipeline: every stage of the current plan with what has happened to it so far.
export type PlanNode = { id: string; stageKind: string; role: string; dependsOn: string[]; mandatory: boolean };
export type PipelineStep = { id: string; state: 'done' | 'current' | 'failed' | 'pending'; attempts: number };
export function pipelineOf(nodes: PlanNode[], runs: RunView[], planVersion: number, currentNodeId: string | undefined, terminal: boolean): PipelineStep[] {
  return nodes.map((n) => {
    const mine = runs.filter((r) => r.nodeId === n.id && r.planVersion === planVersion && r.supersededAt === undefined);
    const last = mine.at(-1);
    let state: PipelineStep['state'] = 'pending';
    if (last?.status === 'passed') state = 'done';
    else if (last && last.status === 'running' && !terminal) state = 'current';
    else if (last) state = 'failed'; // failed, inconclusive, or left running when the task ended
    else if (n.id === currentNodeId && !terminal) state = 'current';
    return { id: n.id, state, attempts: mine.length };
  });
}
