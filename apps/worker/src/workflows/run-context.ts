// Per-run state shared by the TaskWorkflow modules. It lives in workflow memory only; durable state
// is the Checkpoint (carried across Continue-As-New) and Activity results.
import type { CancellationScope } from '@temporalio/workflow';
import type { Checkpoint, LaunchPayload } from './types.ts';

// Flags and handles that command handlers need before the task has been loaded.
export type RunControl = {
  inflight?: CancellationScope;
  projectedRevision: number;
  // resilience-v1: a command applied while a stage is in flight projects its revision at once, and a
  // stage whose activity fails outright is recorded and its reservation settled.
  resilienceV1: boolean;
  // authority-v1: pause, resume, cancel and amend_spec re-check the issuing principal's authority when applied.
  authorityV1: boolean;
  // authority-v1: resolves when the command decided before the next one has been decided.
  commandChain: Promise<void>;
  projectInFlight?: () => Promise<void>;
};

export type ProjectExtra = { currentNodeId?: string | null; waitingReason?: string | null; refs?: Record<string, unknown> };

export type RunContext = {
  launch: LaunchPayload;
  state: Checkpoint;
  control: RunControl;
  commandsV1: boolean;
  settleV1: boolean;
  budgeted: boolean;
  lastPosition: { currentNodeId?: string | null; waitingReason?: string | null };
  projectionQueue: Promise<void>;
};
