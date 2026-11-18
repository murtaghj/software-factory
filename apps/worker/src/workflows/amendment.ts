// amend_spec supersedes the current plan. A stage result that arrives for the old binding is kept
// as history only and cannot advance the new plan (AC-07, INV-04).
import { patched } from '@temporalio/workflow';
import { GATE_ENGINE_V1, freshNodes, persist, resolve } from './config.ts';
import { project } from './projection.ts';
import type { RunContext } from './run-context.ts';

export const applyPendingAmendment = async (ctx: RunContext): Promise<void> => {
  const { state, launch, commandsV1 } = ctx;
  const next = state.pendingAmendSpecVersion;
  if (next === undefined) return;
  if (commandsV1 && state.pendingAmendSpecRef) {
    const specRef = state.pendingAmendSpecRef;
    // The amending command is recorded when it is applied; later commands cannot take its place.
    const made = await persist.materializeSpec({ orgId: launch.orgId, taskId: launch.taskId, specRef, version: next, actorCommandId: state.pendingAmendCommandId ?? Object.keys(state.receipts).at(-1) ?? '' });
    delete state.pendingAmendSpecRef;
    delete state.pendingAmendCommandId;
    if (!made.ok) {
      delete state.pendingAmendSpecVersion;
      await project(ctx, state.status, 'plan.amendment_rejected', { refs: { reason: made.reason } });
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
  await project(ctx, 'running', 'plan.resolved', { refs: { supersededPlanVersion: oldPlan } });
};
