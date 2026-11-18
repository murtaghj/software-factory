// Waiting states: parked on a pause, and plan_peer_review (commands-v1), a controller stage that
// opens one bound decision request for an independent required peer and waits durably (no runner)
// until it is answered, superseded, cancelled or expires. Only an approval of the exact subject
// passes plan_peer_approved.
import { condition, sleep } from '@temporalio/workflow';
import { canonicalHash } from '@factory/domain';
import { persist } from './config.ts';
import { project, revisionChanged } from './projection.ts';
import type { RunContext } from './run-context.ts';
import type { Checkpoint, NodeState, PendingDecision } from './types.ts';

// Handlers mutate state between awaits; read it through functions so control flow never relies
// on a stale narrowed value.
export const cancelRequested = (ctx: RunContext): boolean => ctx.state.cancelRequested === true;
export const isPaused = (ctx: RunContext): boolean => ctx.state.status === 'paused';
const decisionOf = (ctx: RunContext): PendingDecision | undefined => ctx.state.decision;
const deadlinePassed = (d: { passed: boolean }): boolean => d.passed;

export const catchUpWhileWaiting = async (ctx: RunContext, status: Checkpoint['status'], extra: { currentNodeId?: string | null; waitingReason?: string | null } = {}): Promise<void> => {
  const { state, launch } = ctx;
  if (state.pendingBudgetMicroUsd !== undefined) {
    const limit = state.pendingBudgetMicroUsd;
    delete state.pendingBudgetMicroUsd;
    await persist.adjustBudget({ orgId: launch.orgId, taskId: launch.taskId, limitMicroUsd: limit });
    await project(ctx, status, 'budget.changed', { ...extra, refs: { limitMicroUsd: limit } });
  } else {
    await project(ctx, status, 'task.revised', extra);
  }
};

export const finishCancelled = async (ctx: RunContext): Promise<void> => {
  const { state, launch } = ctx;
  await project(ctx, 'cancelling', 'task.cancelling');
  await persist.supersedeDecisions({ orgId: launch.orgId, taskId: launch.taskId, reason: 'task_cancelled' });
  await project(ctx, 'cancelled', 'task.completed', { refs: { outcome: 'cancelled', completedNodeIds: state.plan.nodes.filter((n) => state.nodes[n.id]?.status === 'passed').map((n) => n.id) } });
};

export const runPlanReview = async (ctx: RunContext, nodeId: string, logicalId: string, ns: NodeState): Promise<'continue' | 'stop'> => {
  const { state, launch, settleV1 } = ctx;
  const planNode = state.plan.nodes.find((n) => n.id === nodeId);
  const packetRef = planNode ? state.nodes[planNode.dependsOn[0] ?? '']?.resultRef : undefined;
  const binding = { taskSpecVersion: state.specVersion, planVersion: state.plan.version, planHash: state.plan.planHash, policyRef: state.plan.policyRef, workflowTemplateRef: state.plan.templateRef, nodeId, semanticAttempt: ns.attempt, ...(state.plan.applicationSnapshotRef ? { applicationSnapshotRef: state.plan.applicationSnapshotRef } : {}) };
  const inputHash = canonicalHash(binding);
  const { stageRunId } = await persist.startStage({ orgId: launch.orgId, taskId: launch.taskId, planVersion: state.plan.version, nodeId, attempt: ns.attempt, role: 'reviewer', logicalId, inputHash, binding });
  if (!packetRef) {
    await persist.finishStage({ orgId: launch.orgId, logicalId, status: 'failed', errorClass: 'no_plan_packet' });
    await project(ctx, 'incomplete', 'task.completed', { currentNodeId: nodeId, refs: { outcome: 'plan_review_unavailable', reason: 'no_plan_packet' } });
    return 'stop';
  }
  const req = await persist.requestPlanReview({ orgId: launch.orgId, taskId: launch.taskId, planVersion: state.plan.version, nodeId, logicalId, packetRef, policyRef: state.plan.policyRef });
  if (!req.ok) {
    await persist.finishStage({ orgId: launch.orgId, logicalId, status: 'failed', errorClass: req.reason });
    await project(ctx, 'incomplete', 'task.completed', { currentNodeId: nodeId, waitingReason: req.reason, refs: { outcome: 'plan_review_unavailable', reason: req.reason } });
    return 'stop';
  }
  state.decision = req.decision;
  state.nodes[nodeId] = { ...ns, status: 'running', stageRunId, inputHash };
  await project(ctx, 'waiting_decision', 'decision.requested', { currentNodeId: nodeId, waitingReason: 'plan_review', refs: { decisionId: req.decision.requestId, subjectHash: req.decision.subjectHash } });
  const decided = (): boolean => state.decision?.state !== 'pending' || cancelRequested(ctx) || state.pendingAmendSpecVersion !== undefined;
  // One durable deadline for the request; pausing does not stop calendar time.
  const deadline = { passed: false };
  void sleep(req.decision.ttlMs).then(() => { deadline.passed = true; });
  for (;;) {
    await condition(() => decided() || deadlinePassed(deadline) || isPaused(ctx) || revisionChanged(ctx));
    if (decided() || deadlinePassed(deadline)) break;
    if (!isPaused(ctx)) { await catchUpWhileWaiting(ctx, 'waiting_decision', { currentNodeId: nodeId, waitingReason: 'plan_review' }); continue; }
    await project(ctx, 'paused', 'task.paused', { currentNodeId: nodeId, waitingReason: 'plan_review' });
    for (;;) {
      await condition(() => !isPaused(ctx) || decided() || deadlinePassed(deadline) || revisionChanged(ctx));
      if (!isPaused(ctx) || decided() || deadlinePassed(deadline)) break;
      await catchUpWhileWaiting(ctx, 'paused', { currentNodeId: nodeId, waitingReason: 'plan_review' });
    }
    if (decided() || deadlinePassed(deadline)) break;
    await project(ctx, 'waiting_decision', 'task.resumed', { currentNodeId: nodeId, waitingReason: 'plan_review' });
  }
  if (cancelRequested(ctx) || state.pendingAmendSpecVersion !== undefined) {
    if (settleV1) await persist.finishStage({ orgId: launch.orgId, logicalId, status: 'inconclusive', errorClass: cancelRequested(ctx) ? 'cancelled' : 'superseded_binding' });
    return 'continue';
  }
  const current = decisionOf(ctx);
  const d: PendingDecision = !current || current.state === 'pending' ? { ...req.decision, state: 'expired' } : current;
  state.decision = d;
  const gate = await persist.settleDecision({ orgId: launch.orgId, taskId: launch.taskId, decision: d, binding });
  if (d.state === 'approve' && gate.gate === 'passed') {
    await persist.finishStage({ orgId: launch.orgId, logicalId, status: 'passed' });
    state.nodes[nodeId] = { ...ns, status: 'passed', stageRunId, inputHash };
    await project(ctx, 'running', 'decision.resolved', { currentNodeId: nodeId, refs: { decisionId: d.requestId, outcome: d.state, gate: gate.gate } });
    return 'continue';
  }
  await persist.finishStage({ orgId: launch.orgId, logicalId, status: 'failed', errorClass: d.state === 'expired' ? 'decision_expired' : `decision_${d.state}` });
  state.nodes[nodeId] = { ...ns, status: 'failed', stageRunId, inputHash };
  // Rejection or expiry has no permitted alternative in this plan: incomplete, never success.
  await project(ctx, 'incomplete', 'task.completed', { currentNodeId: nodeId, waitingReason: d.state === 'expired' ? 'decision_expired' : 'plan_rejected', refs: { outcome: d.state === 'approve' ? 'decider_authority_revoked' : `plan_${d.state}`, decisionId: d.requestId, gateReasons: gate.reasonCodes } });
  return 'stop';
};
