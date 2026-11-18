// Projection of workflow state to the database. Every state change is projected with a monotonic
// projection sequence (AC-04).
import { persist } from './config.ts';
import type { ProjectExtra, RunContext } from './run-context.ts';
import type { Checkpoint } from './types.ts';

const projectOnce = async (ctx: RunContext, requested: Checkpoint['status'], eventType: string, extra: ProjectExtra): Promise<void> => {
  const { state, launch } = ctx;
  ctx.lastPosition = { currentNodeId: extra.currentNodeId ?? null, waitingReason: extra.waitingReason ?? null };
  // A pause applied while a stage was in flight wins over the stage's own "running" projection.
  const status = ctx.commandsV1 && state.status === 'paused' && (requested === 'running' || requested === 'waiting_decision') ? 'paused' : requested;
  state.status = status;
  ctx.control.projectedRevision = state.controlRevision;
  state.projectionSequence += 1;
  await persist.project({
    orgId: launch.orgId, taskId: launch.taskId, sequence: state.projectionSequence, eventType, correlationId: launch.operationId,
    state: { status, currentNodeId: extra.currentNodeId ?? null, waitingReason: extra.waitingReason ?? null, specVersion: state.specVersion, planVersion: state.plan.version, controlRevision: state.controlRevision, ...(status === 'succeeded' && state.outcomeRef ? { outcomeRef: state.outcomeRef } : {}) },
    refs: { planHash: state.plan.planHash, ...extra.refs },
  });
};

// Projections are strictly ordered. With resilience-v1 an Update handler may project while the
// main loop is projecting too, so they are queued: sequence numbers are assigned in queue order
// and each write completes before the next starts.
export const project = (ctx: RunContext, requested: Checkpoint['status'], eventType: string, extra: ProjectExtra = {}): Promise<void> => {
  if (!ctx.control.resilienceV1) return projectOnce(ctx, requested, eventType, extra);
  ctx.projectionQueue = ctx.projectionQueue.then(() => projectOnce(ctx, requested, eventType, extra));
  return ctx.projectionQueue;
};

// While parked (decision wait or pause), applied commands still change the control revision;
// project it so clients' If-Match stays current, and apply budget changes immediately.
export const revisionChanged = (ctx: RunContext): boolean => ctx.state.controlRevision !== ctx.control.projectedRevision;
