// TaskWorkflow (W-011): deterministic coordination of one task (INV-01). All I/O happens in
// Activities; this file uses only workflow-safe APIs and pure @factory/domain functions.
//
// - Loads the accepted task and its pinned plan through Activities, then schedules the plan DAG.
// - Every state change is projected with a monotonic projection sequence (AC-04).
// - applyCommand is a serialized Update (commands.ts); amend_spec supersedes the plan
//   (amendment.ts); waiting and plan review are in decision-wait.ts; stages run in
//   stage-execution.ts; projection is in projection.ts.
//
// This file keeps the main loop only. The order of Activity calls, patched() markers and timers is
// replay-critical: change it only behind a new patched() marker.
import { allHandlersFinished, condition, continueAsNew, patched, workflowInfo } from '@temporalio/workflow';
import { applyPendingAmendment } from './amendment.ts';
import { applyCommand, registerHandlers, stateQuery, viewOf } from './commands.ts';
import { AUTHORITY_V1, BUDGET_V1, COMMANDS_V1, HISTORY_SOFT_LIMIT, OUTCOME_V1, RESILIENCE_V1, SETTLE_V1, freshNodes, logicalStageId, persist, resolve, workflowNow } from './config.ts';
import { cancelRequested, catchUpWhileWaiting, finishCancelled, isPaused, runPlanReview } from './decision-wait.ts';
import { project, revisionChanged } from './projection.ts';
import type { RunContext, RunControl } from './run-context.ts';
import { admitStageBudget, runControllerStage, runRunnerStage } from './stage-execution.ts';
import { TERMINAL, type Checkpoint, type LaunchPayload, type WorkflowView } from './types.ts';

export { applyCommand, stateQuery, logicalStageId };

export async function TaskWorkflow(launch: LaunchPayload, checkpoint?: Checkpoint): Promise<WorkflowView> {
  // Handlers are registered before the first await, so a command or query that arrives while the
  // task is still being loaded is held until initialization instead of being refused.
  let initialized: Checkpoint | undefined = checkpoint;
  let stagesThisRun = 0;
  const commandsV1 = patched(COMMANDS_V1);
  // Read before the first await: a command that arrives while the task loads is rechecked too.
  const control: RunControl = { projectedRevision: -1, resilienceV1: false, authorityV1: patched(AUTHORITY_V1), commandChain: Promise.resolve() };
  registerHandlers(launch, commandsV1, control, () => initialized);

  if (!initialized) {
    const task = await resolve.loadTask({ orgId: launch.orgId, taskId: launch.taskId });
    const plan = await resolve.resolvePlan({ orgId: launch.orgId, taskId: launch.taskId, specVersion: task.specVersion, planVersion: 1 });
    initialized = { launch, status: task.status, controlRevision: task.controlRevision, specVersion: task.specVersion, plan, projectionSequence: task.projectionSequence, nodes: freshNodes(plan), receipts: {}, supersededResults: 0, ...(launch.continueAsNewAfterStages === undefined ? {} : { rolloverAfterStages: launch.continueAsNewAfterStages }) };
  }
  const state: Checkpoint = initialized;
  // budget-v1: open the task's account before any stage; later builds reserve before each stage.
  const budgeted = patched(BUDGET_V1) && state.plan.budget !== undefined;
  if (budgeted && !checkpoint && state.plan.budget) await persist.openBudget({ orgId: launch.orgId, taskId: launch.taskId, limitMicroUsd: state.plan.budget.maxMicroUsd });
  // settle-v1: meter calendar and active time for the ceilings, settle the reservation of a
  // cancelled stage, and close a plan-review stage run that a cancel or amendment interrupted.
  const settleV1 = patched(SETTLE_V1);
  if (settleV1 && state.startedAtMs === undefined) state.startedAtMs = workflowNow();
  control.resilienceV1 = patched(RESILIENCE_V1);

  const ctx: RunContext = { launch, state, control, commandsV1, settleV1, budgeted, lastPosition: {}, projectionQueue: Promise.resolve() };
  control.projectInFlight = () => project(ctx, state.status, 'task.revised', ctx.lastPosition);

  if (!checkpoint) {
    await project(ctx, 'queued', 'plan.resolved', { refs: { templateId: state.plan.templateRef.id, templateVersion: state.plan.templateRef.version } });
    await project(ctx, 'running', 'task.running');
  }

  let pausedProjected = false;
  while (!TERMINAL.includes(state.status)) {
    if (commandsV1) {
      if (cancelRequested(ctx)) { await finishCancelled(ctx); break; }
      if (state.pendingBudgetMicroUsd !== undefined) {
        const limit = state.pendingBudgetMicroUsd;
        delete state.pendingBudgetMicroUsd;
        await persist.adjustBudget({ orgId: launch.orgId, taskId: launch.taskId, limitMicroUsd: limit });
        await project(ctx, state.status, 'budget.changed', { refs: { limitMicroUsd: limit } });
      }
      if (state.status === 'paused') {
        if (!pausedProjected) { pausedProjected = true; await project(ctx, 'paused', 'task.paused'); }
        await condition(() => state.status !== 'paused' || cancelRequested(ctx) || revisionChanged(ctx));
        if (cancelRequested(ctx)) continue;
        if (isPaused(ctx)) { await catchUpWhileWaiting(ctx, 'paused'); continue; }
        pausedProjected = false;
        await project(ctx, state.status, 'task.resumed');
        continue;
      }
    }
    await applyPendingAmendment(ctx);
    const info = workflowInfo();
    if (info.continueAsNewSuggested || info.historyLength > HISTORY_SOFT_LIMIT || (state.rolloverAfterStages !== undefined && stagesThisRun >= state.rolloverAfterStages)) {
      await condition(allHandlersFinished); // safe boundary: no stage in flight, no running handler
      await continueAsNew<typeof TaskWorkflow>(launch, state);
    }
    const node = state.plan.nodes.find((n) => state.nodes[n.id]?.status === 'pending' && n.dependsOn.every((d) => state.nodes[d]?.status === 'passed'));
    if (!node) {
      const mandatoryPassed = state.plan.nodes.filter((n) => n.mandatory).every((n) => state.nodes[n.id]?.status === 'passed');
      await project(ctx, mandatoryPassed ? 'succeeded' : 'failed', 'task.completed', { refs: { outcome: mandatoryPassed ? 'all_mandatory_nodes_passed' : 'unrunnable_plan' } });
      break;
    }
    const ns = state.nodes[node.id] ?? { status: 'pending', attempt: 1 };
    const logicalId = logicalStageId(launch.taskId, state.plan.version, node.id, ns.attempt);
    if (!(await admitStageBudget(ctx, node, logicalId, ns))) break;
    if (commandsV1 && node.stageKind === 'plan_peer_review') {
      const outcome = await runPlanReview(ctx, node.id, logicalId, ns);
      // outcome-v1: the review is controller work; settle its reservation at zero actual cost.
      if (budgeted && patched(OUTCOME_V1)) await persist.chargeStageBudget({ orgId: launch.orgId, taskId: launch.taskId, operationKey: logicalId, nodeId: node.id, actualMicroUsd: 0 });
      if (outcome === 'stop') break;
      continue;
    }
    if (commandsV1 && (node.stageKind === 'deliver' || node.stageKind === 'learn_close') && patched(OUTCOME_V1)) {
      await runControllerStage(ctx, node, logicalId, ns);
      continue;
    }
    if (await runRunnerStage(ctx, node, logicalId, ns)) stagesThisRun += 1;
  }
  await condition(allHandlersFinished);
  return viewOf(state);
}
