// TaskWorkflow (W-011): deterministic coordination of one task (INV-01). All I/O happens in
// Activities; this file uses only workflow-safe APIs and pure @factory/domain functions.
//
// - Loads the accepted task and its pinned plan through Activities, then schedules the plan DAG.
// - Every state change is projected with a monotonic projection sequence (AC-04).
// - applyCommand is a serialized Update. Receipts keyed by commandId are carried across
//   Continue-As-New, so a redelivered command is answered, not re-applied (AC-08). A command whose
//   expectedRevision is not the current control revision is rejected with a reason (AC-07).
// - amend_spec supersedes the current plan. A stage result that arrives for the old binding is kept
//   as history only and cannot advance the new plan (AC-07, INV-04).
import { CancellationScope, allHandlersFinished, condition, continueAsNew, defineQuery, defineUpdate, isCancellation, patched, proxyActivities, setHandler, sleep, workflowInfo } from '@temporalio/workflow';
import { canonicalHash } from '@factory/domain';
import { AUTHORING_STAGE_KINDS, checkCeilings } from '@factory/policy';
import { TERMINAL, type Checkpoint, type CommandPayload, type ControllerOutput, type LaunchPayload, type NodeState, type PendingDecision, type PlanSnapshot, type Receipt, type TaskActivities, type WorkflowView } from './types.ts';

export const applyCommand = defineUpdate<Receipt, [CommandPayload]>('applyCommand');
export const stateQuery = defineQuery<WorkflowView>('state');

const persist = proxyActivities<TaskActivities>({ startToCloseTimeout: '30 seconds', scheduleToCloseTimeout: '5 minutes', retry: { initialInterval: '1 second', backoffCoefficient: 2, maximumInterval: '30 seconds', maximumAttempts: 5 } });
const resolve = proxyActivities<TaskActivities>({ startToCloseTimeout: '120 seconds', scheduleToCloseTimeout: '10 minutes', retry: { initialInterval: '1 second', backoffCoefficient: 2, maximumInterval: '30 seconds', maximumAttempts: 4 } });
const execute = proxyActivities<TaskActivities>({ startToCloseTimeout: '50 minutes', heartbeatTimeout: '10 seconds', retry: { initialInterval: '1 second', backoffCoefficient: 2, maximumInterval: '30 seconds', maximumAttempts: 5 } });

const HISTORY_SOFT_LIMIT = 5000;
export const GATE_ENGINE_V1 = 'gate-engine-v1';
export const BUDGET_V1 = 'budget-v1';
export const COMMANDS_V1 = 'commands-v1';
export const OUTCOME_V1 = 'outcome-v1';
const PAUSABLE: readonly string[] = ['queued', 'running', 'waiting_input', 'waiting_decision'];
const CANCELLABLE: readonly string[] = ['accepted', 'queued', 'running', 'waiting_input', 'waiting_decision', 'paused'];

export const logicalStageId = (taskId: string, planVersion: number, nodeId: string, attempt: number): string => `task-${taskId}/plan-${String(planVersion)}/${nodeId}/attempt-${String(attempt)}`;

function freshNodes(plan: PlanSnapshot): Record<string, NodeState> {
  return Object.fromEntries(plan.nodes.map((n) => [n.id, { status: 'pending', attempt: 1 } satisfies NodeState]));
}

export async function TaskWorkflow(launch: LaunchPayload, checkpoint?: Checkpoint): Promise<WorkflowView> {
  // Handlers are registered before the first await, so a command or query that arrives while the
  // task is still being loaded is held until initialization instead of being refused.
  let initialized: Checkpoint | undefined = checkpoint;
  let stagesThisRun = 0;
  const commandsV1 = patched(COMMANDS_V1);
  let inflight: CancellationScope | undefined;
  let projectedRevision = -1;
  const viewOf = (st: Checkpoint): WorkflowView => ({ status: st.status, controlRevision: st.controlRevision, specVersion: st.specVersion, planVersion: st.plan.version, projectionSequence: st.projectionSequence, nodes: st.nodes, supersededResults: st.supersededResults, receiptCount: Object.keys(st.receipts).length });
  // A human decision applies only to the exact pending request and subject, from the required
  // peer, with full reviewed scope, through the response endpoint (AC-07, AC-44, INV-21).
  const applyDecisionResponse = (st: Checkpoint, cmd: CommandPayload): Receipt => {
    const d = st.decision;
    if (!d || d.requestId !== cmd.decisionId) return { state: 'rejected', reason: 'unknown_or_closed_decision' };
    if (d.state === 'expired') return { state: 'rejected', reason: 'decision_expired' };
    if (d.state === 'superseded') return { state: 'rejected', reason: 'stale_subject: the decision was superseded' };
    if (d.state !== 'pending') return { state: 'rejected', reason: 'decision_already_resolved' };
    if (cmd.channel !== 'decision_response_endpoint') return { state: 'rejected', reason: 'decision_requires_response_endpoint' };
    if (cmd.subjectHash !== d.subjectHash) return { state: 'rejected', reason: 'stale_subject: response names a different subject' };
    if (cmd.deciderPrincipalId === undefined || cmd.deciderPrincipalId !== d.requiredPrincipalId) return { state: 'rejected', reason: 'not_the_required_peer' };
    if (d.authorPrincipalIds.includes(cmd.deciderPrincipalId)) return { state: 'rejected', reason: 'author_cannot_approve' };
    if (cmd.outcome !== 'approve' && cmd.outcome !== 'reject' && cmd.outcome !== 'request_changes') return { state: 'rejected', reason: 'invalid_outcome' };
    const reviewed = cmd.reviewedSectionIds ?? [];
    if (cmd.outcome === 'approve' && !d.sectionIds.every((sid) => reviewed.includes(sid))) return { state: 'rejected', reason: 'reviewed_scope_incomplete' };
    st.controlRevision += 1;
    st.decision = { ...d, state: cmd.outcome, commandId: cmd.commandId, deciderPrincipalId: cmd.deciderPrincipalId, reviewedSectionIds: reviewed, reason: typeof cmd.reason === 'string' ? cmd.reason : cmd.outcome };
    return { state: 'applied', resultingRevision: st.controlRevision };
  };

  setHandler(stateQuery, () => (initialized ? viewOf(initialized) : { status: 'accepted', controlRevision: 0, specVersion: launch.specVersion, planVersion: 0, projectionSequence: 0, nodes: {}, supersededResults: 0, receiptCount: 0 }));
  setHandler(applyCommand, async (cmd: CommandPayload): Promise<Receipt> => {
    await condition(() => initialized !== undefined);
    const st = initialized;
    if (!st) return { state: 'rejected', reason: 'task not initialized' };
    const prior = st.receipts[cmd.commandId];
    if (prior) return prior; // durable receipt lookup: a redelivered command is never applied twice
    let receipt: Receipt;
    if (TERMINAL.includes(st.status)) {
      receipt = { state: 'rejected', reason: `task is ${st.status}` };
    } else if (cmd.expectedRevision !== st.controlRevision) {
      receipt = { state: 'rejected', reason: `stale_revision: expected ${String(cmd.expectedRevision)}, current ${String(st.controlRevision)}` };
    } else if (commandsV1 && cmd.kind === 'cancel') {
      // A repeat in cancelling is an idempotent no-op; terminal states were rejected above.
      if (st.cancelRequested === true || st.status === 'cancelling') receipt = { state: 'applied', reason: 'already cancelling', resultingRevision: st.controlRevision };
      else if (!CANCELLABLE.includes(st.status)) receipt = { state: 'rejected', reason: `cannot cancel while ${st.status}` };
      else { st.controlRevision += 1; st.cancelRequested = true; inflight?.cancel(); receipt = { state: 'applied', resultingRevision: st.controlRevision }; }
    } else if (commandsV1 && cmd.kind === 'pause') {
      if (st.cancelRequested === true || st.status === 'cancelling') receipt = { state: 'applied', reason: 'already cancelling', resultingRevision: st.controlRevision };
      else if (!PAUSABLE.includes(st.status)) receipt = { state: 'rejected', reason: `cannot pause while ${st.status}` };
      else { st.controlRevision += 1; st.pausedFrom = st.status; st.status = 'paused'; receipt = { state: 'applied', resultingRevision: st.controlRevision }; }
    } else if (commandsV1 && cmd.kind === 'resume') {
      if (st.status !== 'paused') receipt = { state: 'rejected', reason: `cannot resume while ${st.status}` };
      else { st.controlRevision += 1; st.status = st.pausedFrom ?? 'running'; delete st.pausedFrom; receipt = { state: 'applied', resultingRevision: st.controlRevision }; }
    } else if (commandsV1 && cmd.kind === 'change_budget' && typeof cmd.budgetMicroUsd === 'number' && Number.isSafeInteger(cmd.budgetMicroUsd) && cmd.budgetMicroUsd >= 0) {
      st.controlRevision += 1; st.pendingBudgetMicroUsd = cmd.budgetMicroUsd; receipt = { state: 'applied', resultingRevision: st.controlRevision };
    } else if (commandsV1 && cmd.kind === 'amend_spec' && cmd.specRef !== undefined && st.pendingAmendSpecVersion === undefined && st.pendingAmendSpecRef === undefined) {
      st.controlRevision += 1; st.pendingAmendSpecRef = cmd.specRef; st.pendingAmendSpecVersion = st.specVersion + 1;
      receipt = { state: 'applied', resultingRevision: st.controlRevision };
    } else if (commandsV1 && cmd.kind === 'respond_decision') {
      receipt = applyDecisionResponse(st, cmd);
    } else if (cmd.kind === 'amend_spec' && typeof cmd.specVersion === 'number' && cmd.specVersion === st.specVersion + 1 && st.pendingAmendSpecVersion === undefined) {
      st.controlRevision += 1;
      st.pendingAmendSpecVersion = cmd.specVersion;
      receipt = { state: 'applied', resultingRevision: st.controlRevision };
    } else if (cmd.kind === 'amend_spec') {
      receipt = { state: 'rejected', reason: 'amend_spec requires the next spec version and no pending amendment' };
    } else {
      receipt = { state: 'rejected', reason: `unsupported_command: ${cmd.kind}` };
    }
    st.receipts[cmd.commandId] = receipt;
    return receipt;
  }, { validator: (cmd: CommandPayload) => { if (typeof cmd.commandId !== 'string' || typeof cmd.kind !== 'string' || typeof cmd.expectedRevision !== 'number') throw new Error('malformed command'); } });

  if (!initialized) {
    const task = await resolve.loadTask({ orgId: launch.orgId, taskId: launch.taskId });
    const plan = await resolve.resolvePlan({ orgId: launch.orgId, taskId: launch.taskId, specVersion: task.specVersion, planVersion: 1 });
    initialized = { launch, status: task.status, controlRevision: task.controlRevision, specVersion: task.specVersion, plan, projectionSequence: task.projectionSequence, nodes: freshNodes(plan), receipts: {}, supersededResults: 0, ...(launch.continueAsNewAfterStages === undefined ? {} : { rolloverAfterStages: launch.continueAsNewAfterStages }) };
  }
  const state: Checkpoint = initialized;
  const view = (): WorkflowView => viewOf(state);
  // budget-v1: open the task's account before any stage; later builds reserve before each stage.
  const budgeted = patched(BUDGET_V1) && state.plan.budget !== undefined;
  if (budgeted && !checkpoint && state.plan.budget) await persist.openBudget({ orgId: launch.orgId, taskId: launch.taskId, limitMicroUsd: state.plan.budget.maxMicroUsd });

  const project = async (requested: Checkpoint['status'], eventType: string, extra: { currentNodeId?: string | null; waitingReason?: string | null; refs?: Record<string, unknown> } = {}): Promise<void> => {
    // A pause applied while a stage was in flight wins over the stage's own "running" projection.
    const status = commandsV1 && state.status === 'paused' && (requested === 'running' || requested === 'waiting_decision') ? 'paused' : requested;
    state.status = status;
    projectedRevision = state.controlRevision;
    state.projectionSequence += 1;
    await persist.project({
      orgId: launch.orgId, taskId: launch.taskId, sequence: state.projectionSequence, eventType, correlationId: launch.operationId,
      state: { status, currentNodeId: extra.currentNodeId ?? null, waitingReason: extra.waitingReason ?? null, specVersion: state.specVersion, planVersion: state.plan.version, controlRevision: state.controlRevision, ...(status === 'succeeded' && state.outcomeRef ? { outcomeRef: state.outcomeRef } : {}) },
      refs: { planHash: state.plan.planHash, ...extra.refs },
    });
  };

  if (!checkpoint) {
    await project('queued', 'plan.resolved', { refs: { templateId: state.plan.templateRef.id, templateVersion: state.plan.templateRef.version } });
    await project('running', 'task.running');
  }

  const applyPendingAmendment = async (): Promise<void> => {
    const next = state.pendingAmendSpecVersion;
    if (next === undefined) return;
    if (commandsV1 && state.pendingAmendSpecRef) {
      const specRef = state.pendingAmendSpecRef;
      const made = await persist.materializeSpec({ orgId: launch.orgId, taskId: launch.taskId, specRef, version: next, actorCommandId: Object.keys(state.receipts).at(-1) ?? '' });
      delete state.pendingAmendSpecRef;
      if (!made.ok) {
        delete state.pendingAmendSpecVersion;
        await project(state.status, 'plan.amendment_rejected', { refs: { reason: made.reason } });
        return;
      }
    }
    if (commandsV1) {
      await persist.supersedeDecisions({ orgId: launch.orgId, taskId: launch.taskId, reason: 'plan_revised' });
      if (state.decision?.state === 'pending') state.decision = { ...state.decision, state: 'superseded' };
    }
    const oldPlan = state.plan.version;
    const plan = await resolve.resolvePlan({ orgId: launch.orgId, taskId: launch.taskId, specVersion: next, planVersion: oldPlan + 1 });
    await persist.supersedeStages({ orgId: launch.orgId, taskId: launch.taskId, oldPlanVersion: oldPlan, newPlanVersion: plan.version });
    if (patched(GATE_ENGINE_V1)) await persist.supersedeGates({ orgId: launch.orgId, taskId: launch.taskId, oldPlanVersion: oldPlan, newPlanVersion: plan.version });
    state.specVersion = next;
    state.plan = plan;
    state.nodes = freshNodes(plan); // dependent evidence of the old plan is invalidated (INV-04)
    delete state.pendingAmendSpecVersion;
    await project('running', 'plan.resolved', { refs: { supersededPlanVersion: oldPlan } });
  };

  let pausedProjected = false;
  const cancelRequested = (): boolean => state.cancelRequested === true;
  // Handlers mutate state between awaits; read it through functions so control flow never relies
  // on a stale narrowed value.
  const isPaused = (): boolean => state.status === 'paused';
  const decisionOf = (): PendingDecision | undefined => state.decision;
  const deadlinePassed = (d: { passed: boolean }): boolean => d.passed;
  // While parked (decision wait or pause), applied commands still change the control revision;
  // project it so clients' If-Match stays current, and apply budget changes immediately.
  const revisionChanged = (): boolean => state.controlRevision !== projectedRevision;
  const catchUpWhileWaiting = async (status: Checkpoint['status'], extra: { currentNodeId?: string | null; waitingReason?: string | null } = {}): Promise<void> => {
    if (state.pendingBudgetMicroUsd !== undefined) {
      const limit = state.pendingBudgetMicroUsd;
      delete state.pendingBudgetMicroUsd;
      await persist.adjustBudget({ orgId: launch.orgId, taskId: launch.taskId, limitMicroUsd: limit });
      await project(status, 'budget.changed', { ...extra, refs: { limitMicroUsd: limit } });
    } else {
      await project(status, 'task.revised', extra);
    }
  };
  const finishCancelled = async (): Promise<void> => {
    await project('cancelling', 'task.cancelling');
    await persist.supersedeDecisions({ orgId: launch.orgId, taskId: launch.taskId, reason: 'task_cancelled' });
    await project('cancelled', 'task.completed', { refs: { outcome: 'cancelled', completedNodeIds: state.plan.nodes.filter((n) => state.nodes[n.id]?.status === 'passed').map((n) => n.id) } });
  };

  // plan_peer_review (commands-v1): a controller stage that opens one bound decision request for an
  // independent required peer and waits durably (no runner) until it is answered, superseded,
  // cancelled or expires. Only an approval of the exact subject passes plan_peer_approved.
  const runPlanReview = async (nodeId: string, logicalId: string, ns: NodeState): Promise<'continue' | 'stop'> => {
    const planNode = state.plan.nodes.find((n) => n.id === nodeId);
    const packetRef = planNode ? state.nodes[planNode.dependsOn[0] ?? '']?.resultRef : undefined;
    const binding = { taskSpecVersion: state.specVersion, planVersion: state.plan.version, planHash: state.plan.planHash, policyRef: state.plan.policyRef, workflowTemplateRef: state.plan.templateRef, nodeId, semanticAttempt: ns.attempt, ...(state.plan.applicationSnapshotRef ? { applicationSnapshotRef: state.plan.applicationSnapshotRef } : {}) };
    const inputHash = canonicalHash(binding);
    const { stageRunId } = await persist.startStage({ orgId: launch.orgId, taskId: launch.taskId, planVersion: state.plan.version, nodeId, attempt: ns.attempt, role: 'reviewer', logicalId, inputHash, binding });
    if (!packetRef) {
      await persist.finishStage({ orgId: launch.orgId, logicalId, status: 'failed', errorClass: 'no_plan_packet' });
      await project('incomplete', 'task.completed', { currentNodeId: nodeId, refs: { outcome: 'plan_review_unavailable', reason: 'no_plan_packet' } });
      return 'stop';
    }
    const req = await persist.requestPlanReview({ orgId: launch.orgId, taskId: launch.taskId, planVersion: state.plan.version, nodeId, logicalId, packetRef, policyRef: state.plan.policyRef });
    if (!req.ok) {
      await persist.finishStage({ orgId: launch.orgId, logicalId, status: 'failed', errorClass: req.reason });
      await project('incomplete', 'task.completed', { currentNodeId: nodeId, waitingReason: req.reason, refs: { outcome: 'plan_review_unavailable', reason: req.reason } });
      return 'stop';
    }
    state.decision = req.decision;
    state.nodes[nodeId] = { ...ns, status: 'running', stageRunId, inputHash };
    await project('waiting_decision', 'decision.requested', { currentNodeId: nodeId, waitingReason: 'plan_review', refs: { decisionId: req.decision.requestId, subjectHash: req.decision.subjectHash } });
    const decided = (): boolean => state.decision?.state !== 'pending' || cancelRequested() || state.pendingAmendSpecVersion !== undefined;
    // One durable deadline for the request; pausing does not stop calendar time.
    const deadline = { passed: false };
    void sleep(req.decision.ttlMs).then(() => { deadline.passed = true; });
    for (;;) {
      await condition(() => decided() || deadlinePassed(deadline) || isPaused() || revisionChanged());
      if (decided() || deadlinePassed(deadline)) break;
      if (!isPaused()) { await catchUpWhileWaiting('waiting_decision', { currentNodeId: nodeId, waitingReason: 'plan_review' }); continue; }
      await project('paused', 'task.paused', { currentNodeId: nodeId, waitingReason: 'plan_review' });
      for (;;) {
        await condition(() => !isPaused() || decided() || deadlinePassed(deadline) || revisionChanged());
        if (!isPaused() || decided() || deadlinePassed(deadline)) break;
        await catchUpWhileWaiting('paused', { currentNodeId: nodeId, waitingReason: 'plan_review' });
      }
      if (decided() || deadlinePassed(deadline)) break;
      await project('waiting_decision', 'task.resumed', { currentNodeId: nodeId, waitingReason: 'plan_review' });
    }
    if (cancelRequested() || state.pendingAmendSpecVersion !== undefined) return 'continue';
    const current = decisionOf();
    const d: PendingDecision = !current || current.state === 'pending' ? { ...req.decision, state: 'expired' } : current;
    state.decision = d;
    const gate = await persist.settleDecision({ orgId: launch.orgId, taskId: launch.taskId, decision: d, binding });
    if (d.state === 'approve' && gate.gate === 'passed') {
      await persist.finishStage({ orgId: launch.orgId, logicalId, status: 'passed' });
      state.nodes[nodeId] = { ...ns, status: 'passed', stageRunId, inputHash };
      await project('running', 'decision.resolved', { currentNodeId: nodeId, refs: { decisionId: d.requestId, outcome: d.state, gate: gate.gate } });
      return 'continue';
    }
    await persist.finishStage({ orgId: launch.orgId, logicalId, status: 'failed', errorClass: d.state === 'expired' ? 'decision_expired' : `decision_${d.state}` });
    state.nodes[nodeId] = { ...ns, status: 'failed', stageRunId, inputHash };
    // Rejection or expiry has no permitted alternative in this plan: incomplete, never success.
    await project('incomplete', 'task.completed', { currentNodeId: nodeId, waitingReason: d.state === 'expired' ? 'decision_expired' : 'plan_rejected', refs: { outcome: d.state === 'approve' ? 'decider_authority_revoked' : `plan_${d.state}`, decisionId: d.requestId, gateReasons: gate.reasonCodes } });
    return 'stop';
  };

  // deliver and close (outcome-v1) are trusted controller stages: no runner is involved, so no
  // runner result is accepted for them. Delivery re-verifies every upstream gate on the current plan
  // and the review binding before recording the report; close builds the OutcomeManifest from
  // control-plane facts and outcome_recorded is evaluated on that manifest.
  const ancestorsOf = (nodeId: string): string[] => {
    const seen = new Set<string>();
    const walk = (id: string): void => { for (const d of state.plan.nodes.find((n) => n.id === id)?.dependsOn ?? []) if (!seen.has(d)) { seen.add(d); walk(d); } };
    walk(nodeId);
    return [...seen];
  };
  const runControllerStage = async (node: PlanSnapshot['nodes'][number], logicalId: string, ns: NodeState): Promise<void> => {
    const planVersion = state.plan.version;
    const dependencies = node.dependsOn.map((d) => ({ nodeId: d, resultRef: state.nodes[d]?.resultRef ?? null }));
    const binding = { taskSpecVersion: state.specVersion, planVersion, planHash: state.plan.planHash, policyRef: state.plan.policyRef, workflowTemplateRef: state.plan.templateRef, nodeId: node.id, semanticAttempt: ns.attempt, dependencies, ...(state.plan.applicationSnapshotRef ? { applicationSnapshotRef: state.plan.applicationSnapshotRef } : {}) };
    const inputHash = canonicalHash(binding);
    const { stageRunId } = await persist.startStage({ orgId: launch.orgId, taskId: launch.taskId, planVersion, nodeId: node.id, attempt: ns.attempt, role: node.role, logicalId, inputHash, binding });
    state.nodes[node.id] = { ...ns, status: 'running', stageRunId, inputHash };
    await project('running', 'stage.started', { currentNodeId: node.id, refs: { stageRunId: logicalId } });
    let out: ControllerOutput;
    if (node.stageKind === 'deliver') {
      const reviewNodeId = node.dependsOn[0] ?? '';
      const reviewRef = state.nodes[reviewNodeId]?.resultRef;
      const candidateRef = state.nodes[state.plan.nodes.find((n) => n.id === reviewNodeId)?.dependsOn[0] ?? '']?.resultRef;
      const requiredGateIds = [...new Set(ancestorsOf(node.id).flatMap((id) => state.plan.nodes.find((n) => n.id === id)?.requiredGateIds ?? []))];
      out = reviewRef && candidateRef ? await persist.deliverReport({ orgId: launch.orgId, taskId: launch.taskId, logicalId, planVersion, candidateRef, reviewRef, requiredGateIds }) : { ok: false, reason: 'no_reviewed_candidate' };
    } else {
      const deliveredRefs = ancestorsOf(node.id).flatMap((id) => (state.plan.nodes.find((n) => n.id === id)?.stageKind === 'deliver' ? (state.nodes[id]?.outputRefs ?? []) : []));
      const info = workflowInfo();
      const providerHandles = [`temporal:workflow:${info.workflowId}`, `temporal:run:${info.firstExecutionRunId}`, ...(info.runId === info.firstExecutionRunId ? [] : [`temporal:run:${info.runId}`]), `dispatcher:operation:${launch.operationId}`,
        ...state.plan.nodes.flatMap((n) => (state.nodes[n.id]?.status === 'passed' && n.stageKind !== 'deliver' && n.stageKind !== 'plan_peer_review' ? [`fake-runner:${logicalStageId(launch.taskId, planVersion, n.id, state.nodes[n.id]?.attempt ?? 1)}`] : []))];
      out = await persist.recordOutcome({ orgId: launch.orgId, taskId: launch.taskId, logicalId, planVersion, deliveredRefs, providerHandles });
    }
    if (budgeted) await persist.chargeStageBudget({ orgId: launch.orgId, taskId: launch.taskId, operationKey: logicalId, nodeId: node.id, actualMicroUsd: 0 }); // controller work has no model cost
    const stillCurrent = state.plan.version === planVersion && state.pendingAmendSpecVersion === undefined;
    if (!out.ok || !stillCurrent) {
      await persist.finishStage({ orgId: launch.orgId, logicalId, status: out.ok ? 'inconclusive' : 'failed', errorClass: out.ok ? 'superseded_binding' : out.reason });
      if (stillCurrent) state.nodes[node.id] = { ...ns, status: 'failed', stageRunId, inputHash };
      await project('running', 'stage.completed', { currentNodeId: node.id, refs: { stageRunId: logicalId, outcome: out.ok ? 'superseded' : 'failed', ...(out.ok ? {} : { reason: out.reason }) } });
      return;
    }
    if (node.requiredGateIds.length > 0) {
      const gates = await persist.evaluateGates({ orgId: launch.orgId, taskId: launch.taskId, nodeId: node.id, logicalId, stageKind: node.stageKind, requiredGateIds: node.requiredGateIds, binding: { ...binding, ...(state.plan.criteriaRef ? { criteriaRef: state.plan.criteriaRef } : {}) }, outputRefs: [out.ref], dependencyRefs: dependencies.flatMap((d) => (d.resultRef ? [d.resultRef] : [])) });
      await project('running', 'gate.evaluated', { currentNodeId: node.id, refs: { stageRunId: logicalId, gates: gates.results.map((g) => ({ gateId: g.gateId, verdict: g.verdict, evaluationId: g.evaluationId })) } });
      if (!gates.allPassed) {
        await persist.finishStage({ orgId: launch.orgId, logicalId, status: 'failed', errorClass: 'gate_failed' });
        state.nodes[node.id] = { ...ns, status: 'failed', stageRunId, inputHash };
        return;
      }
    }
    await persist.finishStage({ orgId: launch.orgId, logicalId, status: 'passed', resultRef: out.ref });
    state.nodes[node.id] = { ...ns, status: 'passed', stageRunId, inputHash, outputRefs: [out.ref], resultRef: out.ref };
    if (node.stageKind === 'learn_close') state.outcomeRef = out.ref;
    await project('running', 'stage.completed', { currentNodeId: node.id, refs: { stageRunId: logicalId, outcome: 'passed', ...(node.stageKind === 'learn_close' ? { outcomeManifestRef: out.ref } : {}) } });
  };

  while (!TERMINAL.includes(state.status)) {
    if (commandsV1) {
      if (cancelRequested()) { await finishCancelled(); break; }
      if (state.pendingBudgetMicroUsd !== undefined) {
        const limit = state.pendingBudgetMicroUsd;
        delete state.pendingBudgetMicroUsd;
        await persist.adjustBudget({ orgId: launch.orgId, taskId: launch.taskId, limitMicroUsd: limit });
        await project(state.status, 'budget.changed', { refs: { limitMicroUsd: limit } });
      }
      if (state.status === 'paused') {
        if (!pausedProjected) { pausedProjected = true; await project('paused', 'task.paused'); }
        await condition(() => state.status !== 'paused' || cancelRequested() || revisionChanged());
        if (cancelRequested()) continue;
        if (isPaused()) { await catchUpWhileWaiting('paused'); continue; }
        pausedProjected = false;
        await project(state.status, 'task.resumed');
        continue;
      }
    }
    await applyPendingAmendment();
    const info = workflowInfo();
    if (info.continueAsNewSuggested || info.historyLength > HISTORY_SOFT_LIMIT || (state.rolloverAfterStages !== undefined && stagesThisRun >= state.rolloverAfterStages)) {
      await condition(allHandlersFinished); // safe boundary: no stage in flight, no running handler
      await continueAsNew<typeof TaskWorkflow>(launch, state);
    }
    const node = state.plan.nodes.find((n) => state.nodes[n.id]?.status === 'pending' && n.dependsOn.every((d) => state.nodes[d]?.status === 'passed'));
    if (!node) {
      const mandatoryPassed = state.plan.nodes.filter((n) => n.mandatory).every((n) => state.nodes[n.id]?.status === 'passed');
      await project(mandatoryPassed ? 'succeeded' : 'failed', 'task.completed', { refs: { outcome: mandatoryPassed ? 'all_mandatory_nodes_passed' : 'unrunnable_plan' } });
      break;
    }
    const ns = state.nodes[node.id] ?? { status: 'pending', attempt: 1 };
    const planVersion = state.plan.version;
    const logicalId = logicalStageId(launch.taskId, planVersion, node.id, ns.attempt);
    if (budgeted && state.plan.budget) {
      // Ceilings and reservation precede the stage; exhaustion is an explicit incomplete outcome (INV-11).
      const authoring = AUTHORING_STAGE_KINDS.has(node.stageKind);
      const ceiling = checkCeilings(state.plan.budget, { chargedMicroUsd: 0, reservedMicroUsd: 0, activeSeconds: 0, calendarSeconds: 0, authoringInvocations: state.authoringInvocations ?? 0, maxSemanticAttemptsUsed: 0 }, { authoring, estimateMicroUsd: 0, semanticAttempt: ns.attempt });
      const admission = ceiling.admit ? await persist.reserveStageBudget({ orgId: launch.orgId, taskId: launch.taskId, operationKey: logicalId, nodeId: node.id }) : undefined;
      if (!ceiling.admit || !admission?.admitted) {
        const reasons = ceiling.admit ? (admission?.reasons ?? ['budget reservation failed']) : ceiling.reasons;
        await project('incomplete', 'task.completed', { currentNodeId: node.id, waitingReason: 'budget_exhausted', refs: { outcome: 'budget_exhausted', reasons, unmetNodeIds: state.plan.nodes.filter((n) => state.nodes[n.id]?.status !== 'passed').map((n) => n.id) } });
        break;
      }
      if (authoring) state.authoringInvocations = (state.authoringInvocations ?? 0) + 1;
    }
    if (commandsV1 && node.stageKind === 'plan_peer_review') {
      const outcome = await runPlanReview(node.id, logicalId, ns);
      // outcome-v1: the review is controller work; settle its reservation at zero actual cost.
      if (budgeted && patched(OUTCOME_V1)) await persist.chargeStageBudget({ orgId: launch.orgId, taskId: launch.taskId, operationKey: logicalId, nodeId: node.id, actualMicroUsd: 0 });
      if (outcome === 'stop') break;
      continue;
    }
    if (commandsV1 && (node.stageKind === 'deliver' || node.stageKind === 'learn_close') && patched(OUTCOME_V1)) {
      await runControllerStage(node, logicalId, ns);
      continue;
    }
    const dependencies = node.dependsOn.map((d) => ({ nodeId: d, resultRef: state.nodes[d]?.resultRef ?? null }));
    const binding = { taskSpecVersion: state.specVersion, planVersion, planHash: state.plan.planHash, policyRef: state.plan.policyRef, workflowTemplateRef: state.plan.templateRef, nodeId: node.id, semanticAttempt: ns.attempt, dependencies, ...(state.plan.applicationSnapshotRef ? { applicationSnapshotRef: state.plan.applicationSnapshotRef } : {}) };
    const inputHash = canonicalHash(binding);
    const { stageRunId } = await persist.startStage({ orgId: launch.orgId, taskId: launch.taskId, planVersion, nodeId: node.id, attempt: ns.attempt, role: node.role, logicalId, inputHash, binding });
    state.nodes[node.id] = { ...ns, status: 'running', stageRunId, inputHash };
    await project('running', 'stage.started', { currentNodeId: node.id, refs: { stageRunId: logicalId } });

    const stageInput = { orgId: launch.orgId, taskId: launch.taskId, logicalId, nodeId: node.id, stageKind: node.stageKind, attempt: ns.attempt, inputHash, specVersion: state.specVersion, planVersion };
    let result: Awaited<ReturnType<TaskActivities['executeFakeStage']>>;
    if (commandsV1) {
      // Cancellation stops the in-flight stage; its partial result is recorded as cancelled (INV-15).
      const scope = new CancellationScope();
      inflight = scope;
      try {
        result = await scope.run(() => execute.executeFakeStage(stageInput));
      } catch (e) {
        if (!isCancellation(e)) throw e;
        inflight = undefined;
        await CancellationScope.nonCancellable(() => persist.finishStage({ orgId: launch.orgId, logicalId, status: 'inconclusive', errorClass: 'cancelled' }));
        state.nodes[node.id] = { ...ns, status: 'failed', stageRunId, inputHash };
        continue;
      }
      inflight = undefined;
    } else {
      result = await execute.executeFakeStage(stageInput);
    }
    stagesThisRun += 1;
    if (budgeted) await persist.chargeStageBudget({ orgId: launch.orgId, taskId: launch.taskId, operationKey: logicalId, nodeId: node.id }); // actual usage, recorded truthfully
    // Validate provenance and binding against the stage as it was issued, and against the *current*
    // plan. A result for a superseded binding is history only.
    const producerKind: string = result.producerKind; // arrives over the wire: check it, do not trust the type
    const issuedFor = result.orgId === launch.orgId && result.taskId === launch.taskId && result.stageRunId === logicalId && result.inputHash === inputHash && producerKind === 'runner';
    const current = state.plan.version === planVersion && state.pendingAmendSpecVersion === undefined;
    if (!issuedFor || !current) {
      await persist.finishStage({ orgId: launch.orgId, logicalId, status: 'inconclusive', errorClass: issuedFor ? 'superseded_binding' : 'binding_mismatch' });
      state.supersededResults += 1;
      if (current) state.nodes[node.id] = { status: 'pending', attempt: ns.attempt + 1 };
      continue;
    }
    // gate-engine-v1: a completed node passes only when every required gate has a current passing
    // evaluation for this exact binding. Histories from earlier builds keep their original path.
    if (result.status === 'completed' && node.requiredGateIds.length > 0 && patched(GATE_ENGINE_V1)) {
      const gates = await persist.evaluateGates({ orgId: launch.orgId, taskId: launch.taskId, nodeId: node.id, logicalId, stageKind: node.stageKind, requiredGateIds: node.requiredGateIds, binding: { ...binding, ...(state.plan.criteriaRef ? { criteriaRef: state.plan.criteriaRef } : {}) }, outputRefs: result.outputRefs, dependencyRefs: dependencies.flatMap((d) => (d.resultRef ? [d.resultRef] : [])) });
      if (!gates.allPassed) {
        await persist.finishStage({ orgId: launch.orgId, logicalId, status: 'failed', errorClass: 'gate_failed' });
        state.nodes[node.id] = { ...ns, status: 'failed', stageRunId, inputHash };
        await project('running', 'gate.evaluated', { currentNodeId: node.id, refs: { stageRunId: logicalId, gates: gates.results.map((g) => ({ gateId: g.gateId, verdict: g.verdict, evaluationId: g.evaluationId })) } });
        continue;
      }
      await project('running', 'gate.evaluated', { currentNodeId: node.id, refs: { stageRunId: logicalId, gates: gates.results.map((g) => ({ gateId: g.gateId, verdict: g.verdict, evaluationId: g.evaluationId })) } });
    }
    if (result.status === 'completed') {
      const resultRef = result.outputRefs[0];
      await persist.finishStage({ orgId: launch.orgId, logicalId, status: 'passed', ...(resultRef ? { resultRef } : {}) });
      state.nodes[node.id] = { ...ns, status: 'passed', stageRunId, inputHash, outputRefs: result.outputRefs, ...(resultRef ? { resultRef } : {}) };
      await project('running', 'stage.completed', { currentNodeId: node.id, refs: { stageRunId: logicalId, outcome: 'passed' } });
    } else {
      await persist.finishStage({ orgId: launch.orgId, logicalId, status: result.status === 'product_failure' ? 'failed' : 'inconclusive', errorClass: result.status });
      state.nodes[node.id] = { ...ns, status: 'failed', stageRunId, inputHash };
      await project('running', 'stage.completed', { currentNodeId: node.id, refs: { stageRunId: logicalId, outcome: result.status } });
    }
  }
  await condition(allHandlersFinished);
  return view();
}
