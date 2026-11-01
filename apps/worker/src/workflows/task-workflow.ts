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
import { allHandlersFinished, condition, continueAsNew, defineQuery, defineUpdate, patched, proxyActivities, setHandler, workflowInfo } from '@temporalio/workflow';
import { canonicalHash } from '@factory/domain';
import { AUTHORING_STAGE_KINDS, checkCeilings } from '@factory/policy';
import { TERMINAL, type Checkpoint, type CommandPayload, type LaunchPayload, type NodeState, type PlanSnapshot, type Receipt, type TaskActivities, type WorkflowView } from './types.ts';

export const applyCommand = defineUpdate<Receipt, [CommandPayload]>('applyCommand');
export const stateQuery = defineQuery<WorkflowView>('state');

const persist = proxyActivities<TaskActivities>({ startToCloseTimeout: '30 seconds', scheduleToCloseTimeout: '5 minutes', retry: { initialInterval: '1 second', backoffCoefficient: 2, maximumInterval: '30 seconds', maximumAttempts: 5 } });
const resolve = proxyActivities<TaskActivities>({ startToCloseTimeout: '120 seconds', scheduleToCloseTimeout: '10 minutes', retry: { initialInterval: '1 second', backoffCoefficient: 2, maximumInterval: '30 seconds', maximumAttempts: 4 } });
const execute = proxyActivities<TaskActivities>({ startToCloseTimeout: '50 minutes', retry: { initialInterval: '1 second', backoffCoefficient: 2, maximumInterval: '30 seconds', maximumAttempts: 5 } });

const HISTORY_SOFT_LIMIT = 5000;
export const GATE_ENGINE_V1 = 'gate-engine-v1';
export const BUDGET_V1 = 'budget-v1';

export const logicalStageId = (taskId: string, planVersion: number, nodeId: string, attempt: number): string => `task-${taskId}/plan-${String(planVersion)}/${nodeId}/attempt-${String(attempt)}`;

function freshNodes(plan: PlanSnapshot): Record<string, NodeState> {
  return Object.fromEntries(plan.nodes.map((n) => [n.id, { status: 'pending', attempt: 1 } satisfies NodeState]));
}

export async function TaskWorkflow(launch: LaunchPayload, checkpoint?: Checkpoint): Promise<WorkflowView> {
  // Handlers are registered before the first await, so a command or query that arrives while the
  // task is still being loaded is held until initialization instead of being refused.
  let initialized: Checkpoint | undefined = checkpoint;
  let stagesThisRun = 0;
  const viewOf = (st: Checkpoint): WorkflowView => ({ status: st.status, controlRevision: st.controlRevision, specVersion: st.specVersion, planVersion: st.plan.version, projectionSequence: st.projectionSequence, nodes: st.nodes, supersededResults: st.supersededResults, receiptCount: Object.keys(st.receipts).length });
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

  const project = async (status: Checkpoint['status'], eventType: string, extra: { currentNodeId?: string | null; waitingReason?: string | null; refs?: Record<string, unknown> } = {}): Promise<void> => {
    state.status = status;
    state.projectionSequence += 1;
    await persist.project({
      orgId: launch.orgId, taskId: launch.taskId, sequence: state.projectionSequence, eventType, correlationId: launch.operationId,
      state: { status, currentNodeId: extra.currentNodeId ?? null, waitingReason: extra.waitingReason ?? null, specVersion: state.specVersion, planVersion: state.plan.version, controlRevision: state.controlRevision },
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

  while (!TERMINAL.includes(state.status)) {
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
    const dependencies = node.dependsOn.map((d) => ({ nodeId: d, resultRef: state.nodes[d]?.resultRef ?? null }));
    const binding = { taskSpecVersion: state.specVersion, planVersion, planHash: state.plan.planHash, policyRef: state.plan.policyRef, workflowTemplateRef: state.plan.templateRef, nodeId: node.id, semanticAttempt: ns.attempt, dependencies, ...(state.plan.applicationSnapshotRef ? { applicationSnapshotRef: state.plan.applicationSnapshotRef } : {}) };
    const inputHash = canonicalHash(binding);
    const { stageRunId } = await persist.startStage({ orgId: launch.orgId, taskId: launch.taskId, planVersion, nodeId: node.id, attempt: ns.attempt, role: node.role, logicalId, inputHash, binding });
    state.nodes[node.id] = { ...ns, status: 'running', stageRunId, inputHash };
    await project('running', 'stage.started', { currentNodeId: node.id, refs: { stageRunId: logicalId } });

    const result = await execute.executeFakeStage({ orgId: launch.orgId, taskId: launch.taskId, logicalId, nodeId: node.id, stageKind: node.stageKind, attempt: ns.attempt, inputHash, specVersion: state.specVersion, planVersion });
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
