// Stage execution: budget admission, trusted controller stages (deliver, close) and runner stages.
import { CancellationScope, isCancellation, patched, workflowInfo } from '@temporalio/workflow';
import { canonicalHash } from '@factory/domain';
import { AUTHORING_STAGE_KINDS, checkCeilings } from '@factory/policy';
import { GATE_ENGINE_V1, execute, logicalStageId, persist, workflowNow } from './config.ts';
import { project } from './projection.ts';
import type { RunContext } from './run-context.ts';
import type { ControllerOutput, NodeState, PlanSnapshot, TaskActivities } from './types.ts';

type PlanNode = PlanSnapshot['nodes'][number];

// Ceilings and reservation precede the stage; exhaustion is an explicit incomplete outcome (INV-11).
// Returns false when the task ended because the budget is exhausted.
export const admitStageBudget = async (ctx: RunContext, node: PlanNode, logicalId: string, ns: NodeState): Promise<boolean> => {
  const { state, launch, settleV1, budgeted } = ctx;
  if (!(budgeted && state.plan.budget)) return true;
  const authoring = AUTHORING_STAGE_KINDS.has(node.stageKind);
  // Money is enforced by the database reservation below (it sees every account on the chain); the
  // workflow enforces invocation, attempt and (settle-v1) time ceilings.
  const activeSeconds = settleV1 ? (state.activeMs ?? 0) / 1000 : 0;
  const calendarSeconds = settleV1 ? (workflowNow() - (state.startedAtMs ?? workflowNow())) / 1000 : 0;
  const ceiling = checkCeilings(state.plan.budget, { chargedMicroUsd: 0, reservedMicroUsd: 0, activeSeconds, calendarSeconds, authoringInvocations: state.authoringInvocations ?? 0, maxSemanticAttemptsUsed: 0 }, { authoring, estimateMicroUsd: 0, semanticAttempt: ns.attempt });
  const admission = ceiling.admit ? await persist.reserveStageBudget({ orgId: launch.orgId, taskId: launch.taskId, operationKey: logicalId, nodeId: node.id }) : undefined;
  if (!ceiling.admit || !admission?.admitted) {
    const reasons = ceiling.admit ? (admission?.reasons ?? ['budget reservation failed']) : ceiling.reasons;
    await project(ctx, 'incomplete', 'task.completed', { currentNodeId: node.id, waitingReason: 'budget_exhausted', refs: { outcome: 'budget_exhausted', reasons, unmetNodeIds: state.plan.nodes.filter((n) => state.nodes[n.id]?.status !== 'passed').map((n) => n.id) } });
    return false;
  }
  if (authoring) state.authoringInvocations = (state.authoringInvocations ?? 0) + 1;
  return true;
};

// deliver and close (outcome-v1) are trusted controller stages: no runner is involved, so no
// runner result is accepted for them. Delivery re-verifies every upstream gate on the current plan
// and the review binding before recording the report; close builds the OutcomeManifest from
// control-plane facts and outcome_recorded is evaluated on that manifest.
const ancestorsOf = (ctx: RunContext, nodeId: string): string[] => {
  const seen = new Set<string>();
  const walk = (id: string): void => { for (const d of ctx.state.plan.nodes.find((n) => n.id === id)?.dependsOn ?? []) if (!seen.has(d)) { seen.add(d); walk(d); } };
  walk(nodeId);
  return [...seen];
};

export const runControllerStage = async (ctx: RunContext, node: PlanNode, logicalId: string, ns: NodeState): Promise<void> => {
  const { state, launch, budgeted } = ctx;
  const planVersion = state.plan.version;
  const dependencies = node.dependsOn.map((d) => ({ nodeId: d, resultRef: state.nodes[d]?.resultRef ?? null }));
  const binding = { taskSpecVersion: state.specVersion, planVersion, planHash: state.plan.planHash, policyRef: state.plan.policyRef, workflowTemplateRef: state.plan.templateRef, nodeId: node.id, semanticAttempt: ns.attempt, dependencies, ...(state.plan.applicationSnapshotRef ? { applicationSnapshotRef: state.plan.applicationSnapshotRef } : {}) };
  const inputHash = canonicalHash(binding);
  const { stageRunId } = await persist.startStage({ orgId: launch.orgId, taskId: launch.taskId, planVersion, nodeId: node.id, attempt: ns.attempt, role: node.role, logicalId, inputHash, binding });
  state.nodes[node.id] = { ...ns, status: 'running', stageRunId, inputHash };
  await project(ctx, 'running', 'stage.started', { currentNodeId: node.id, refs: { stageRunId: logicalId } });
  let out: ControllerOutput;
  if (node.stageKind === 'deliver') {
    const reviewNodeId = node.dependsOn[0] ?? '';
    const reviewRef = state.nodes[reviewNodeId]?.resultRef;
    const candidateRef = state.nodes[state.plan.nodes.find((n) => n.id === reviewNodeId)?.dependsOn[0] ?? '']?.resultRef;
    const requiredGateIds = [...new Set(ancestorsOf(ctx, node.id).flatMap((id) => state.plan.nodes.find((n) => n.id === id)?.requiredGateIds ?? []))];
    out = reviewRef && candidateRef ? await persist.deliverReport({ orgId: launch.orgId, taskId: launch.taskId, logicalId, planVersion, candidateRef, reviewRef, requiredGateIds }) : { ok: false, reason: 'no_reviewed_candidate' };
  } else {
    const deliveredRefs = ancestorsOf(ctx, node.id).flatMap((id) => (state.plan.nodes.find((n) => n.id === id)?.stageKind === 'deliver' ? (state.nodes[id]?.outputRefs ?? []) : []));
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
    await project(ctx, 'running', 'stage.completed', { currentNodeId: node.id, refs: { stageRunId: logicalId, outcome: out.ok ? 'superseded' : 'failed', ...(out.ok ? {} : { reason: out.reason }) } });
    return;
  }
  if (node.requiredGateIds.length > 0) {
    const gates = await persist.evaluateGates({ orgId: launch.orgId, taskId: launch.taskId, nodeId: node.id, logicalId, stageKind: node.stageKind, requiredGateIds: node.requiredGateIds, binding: { ...binding, ...(state.plan.criteriaRef ? { criteriaRef: state.plan.criteriaRef } : {}) }, outputRefs: [out.ref], dependencyRefs: dependencies.flatMap((d) => (d.resultRef ? [d.resultRef] : [])) });
    await project(ctx, 'running', 'gate.evaluated', { currentNodeId: node.id, refs: { stageRunId: logicalId, gates: gates.results.map((g) => ({ gateId: g.gateId, verdict: g.verdict, evaluationId: g.evaluationId })) } });
    if (!gates.allPassed) {
      await persist.finishStage({ orgId: launch.orgId, logicalId, status: 'failed', errorClass: 'gate_failed' });
      state.nodes[node.id] = { ...ns, status: 'failed', stageRunId, inputHash };
      return;
    }
  }
  await persist.finishStage({ orgId: launch.orgId, logicalId, status: 'passed', resultRef: out.ref });
  state.nodes[node.id] = { ...ns, status: 'passed', stageRunId, inputHash, outputRefs: [out.ref], resultRef: out.ref };
  if (node.stageKind === 'learn_close') state.outcomeRef = out.ref;
  await project(ctx, 'running', 'stage.completed', { currentNodeId: node.id, refs: { stageRunId: logicalId, outcome: 'passed', ...(node.stageKind === 'learn_close' ? { outcomeManifestRef: out.ref } : {}) } });
};

// A stage run by a runner Activity. Resolves to true when the runner returned a result (the stage
// counts toward the Continue-As-New rollover), false when it was cancelled or failed outright.
export const runRunnerStage = async (ctx: RunContext, node: PlanNode, logicalId: string, ns: NodeState): Promise<boolean> => {
  const { state, launch, budgeted, commandsV1, settleV1, control } = ctx;
  const planVersion = state.plan.version;
  const dependencies = node.dependsOn.map((d) => ({ nodeId: d, resultRef: state.nodes[d]?.resultRef ?? null }));
  const binding = { taskSpecVersion: state.specVersion, planVersion, planHash: state.plan.planHash, policyRef: state.plan.policyRef, workflowTemplateRef: state.plan.templateRef, nodeId: node.id, semanticAttempt: ns.attempt, dependencies, ...(state.plan.applicationSnapshotRef ? { applicationSnapshotRef: state.plan.applicationSnapshotRef } : {}) };
  const inputHash = canonicalHash(binding);
  const { stageRunId } = await persist.startStage({ orgId: launch.orgId, taskId: launch.taskId, planVersion, nodeId: node.id, attempt: ns.attempt, role: node.role, logicalId, inputHash, binding });
  state.nodes[node.id] = { ...ns, status: 'running', stageRunId, inputHash };
  await project(ctx, 'running', 'stage.started', { currentNodeId: node.id, refs: { stageRunId: logicalId } });

  const stageInput = { orgId: launch.orgId, taskId: launch.taskId, logicalId, nodeId: node.id, stageKind: node.stageKind, attempt: ns.attempt, inputHash, specVersion: state.specVersion, planVersion };
  let result: Awaited<ReturnType<TaskActivities['executeFakeStage']>>;
  if (commandsV1) {
    // Cancellation stops the in-flight stage; its partial result is recorded as cancelled (INV-15).
    const scope = new CancellationScope();
    control.inflight = scope;
    const began = workflowNow();
    try {
      result = await scope.run(() => execute.executeFakeStage(stageInput));
    } catch (e) {
      if (!isCancellation(e)) {
        if (!control.resilienceV1) throw e;
        // The runner activity failed outright (retries exhausted or non-retryable). Nothing it
        // produced is evidence: record the stage, settle its reservation and let the plan end.
        delete control.inflight;
        state.activeMs = (state.activeMs ?? 0) + (workflowNow() - began);
        await persist.finishStage({ orgId: launch.orgId, logicalId, status: 'inconclusive', errorClass: 'infrastructure_error' });
        if (budgeted) await persist.chargeStageBudget({ orgId: launch.orgId, taskId: launch.taskId, operationKey: logicalId, nodeId: node.id });
        state.nodes[node.id] = { ...ns, status: 'failed', stageRunId, inputHash };
        await project(ctx, 'running', 'stage.completed', { currentNodeId: node.id, refs: { stageRunId: logicalId, outcome: 'infrastructure_error' } });
        return false;
      }
      delete control.inflight;
      if (settleV1) state.activeMs = (state.activeMs ?? 0) + (workflowNow() - began);
      await CancellationScope.nonCancellable(() => persist.finishStage({ orgId: launch.orgId, logicalId, status: 'inconclusive', errorClass: 'cancelled' }));
      // The stage ran until cancelled: record its spend and release the reservation.
      if (settleV1 && budgeted) await CancellationScope.nonCancellable(() => persist.chargeStageBudget({ orgId: launch.orgId, taskId: launch.taskId, operationKey: logicalId, nodeId: node.id }));
      state.nodes[node.id] = { ...ns, status: 'failed', stageRunId, inputHash };
      return false;
    }
    delete control.inflight;
    if (settleV1) state.activeMs = (state.activeMs ?? 0) + (workflowNow() - began);
  } else {
    result = await execute.executeFakeStage(stageInput);
  }
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
    return true;
  }
  // gate-engine-v1: a completed node passes only when every required gate has a current passing
  // evaluation for this exact binding. Histories from earlier builds keep their original path.
  if (result.status === 'completed' && node.requiredGateIds.length > 0 && patched(GATE_ENGINE_V1)) {
    const authorProducerIds = node.dependsOn.flatMap((d) => { const p = state.nodes[d]?.producerId; return p === undefined ? [] : [p]; });
    const producers = authorProducerIds.length === node.dependsOn.length ? { reviewerProducerId: result.producerId, authorProducerIds } : undefined;
    const gates = await persist.evaluateGates({ orgId: launch.orgId, taskId: launch.taskId, nodeId: node.id, logicalId, stageKind: node.stageKind, requiredGateIds: node.requiredGateIds, binding: { ...binding, ...(state.plan.criteriaRef ? { criteriaRef: state.plan.criteriaRef } : {}) }, outputRefs: result.outputRefs, dependencyRefs: dependencies.flatMap((d) => (d.resultRef ? [d.resultRef] : [])), ...(producers ? { producers } : {}) });
    if (!gates.allPassed) {
      await persist.finishStage({ orgId: launch.orgId, logicalId, status: 'failed', errorClass: 'gate_failed' });
      state.nodes[node.id] = { ...ns, status: 'failed', stageRunId, inputHash };
      await project(ctx, 'running', 'gate.evaluated', { currentNodeId: node.id, refs: { stageRunId: logicalId, gates: gates.results.map((g) => ({ gateId: g.gateId, verdict: g.verdict, evaluationId: g.evaluationId })) } });
      return true;
    }
    await project(ctx, 'running', 'gate.evaluated', { currentNodeId: node.id, refs: { stageRunId: logicalId, gates: gates.results.map((g) => ({ gateId: g.gateId, verdict: g.verdict, evaluationId: g.evaluationId })) } });
  }
  if (result.status === 'completed') {
    const resultRef = result.outputRefs[0];
    await persist.finishStage({ orgId: launch.orgId, logicalId, status: 'passed', ...(resultRef ? { resultRef } : {}) });
    state.nodes[node.id] = { ...ns, status: 'passed', stageRunId, inputHash, outputRefs: result.outputRefs, producerId: result.producerId, ...(resultRef ? { resultRef } : {}) };
    await project(ctx, 'running', 'stage.completed', { currentNodeId: node.id, refs: { stageRunId: logicalId, outcome: 'passed' } });
  } else {
    await persist.finishStage({ orgId: launch.orgId, logicalId, status: result.status === 'product_failure' ? 'failed' : 'inconclusive', errorClass: result.status });
    state.nodes[node.id] = { ...ns, status: 'failed', stageRunId, inputHash };
    await project(ctx, 'running', 'stage.completed', { currentNodeId: node.id, refs: { stageRunId: logicalId, outcome: result.status } });
  }
  return true;
};
