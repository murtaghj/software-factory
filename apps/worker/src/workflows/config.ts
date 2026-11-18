// Shared workflow configuration: Activity proxies, patch markers and small pure helpers. Workflow
// sandbox code only (no Node APIs).
import { proxyActivities } from '@temporalio/workflow';
import type { NodeState, PlanSnapshot, TaskActivities } from './types.ts';

export const persist = proxyActivities<TaskActivities>({ startToCloseTimeout: '30 seconds', scheduleToCloseTimeout: '5 minutes', retry: { initialInterval: '1 second', backoffCoefficient: 2, maximumInterval: '30 seconds', maximumAttempts: 5 } });
export const resolve = proxyActivities<TaskActivities>({ startToCloseTimeout: '120 seconds', scheduleToCloseTimeout: '10 minutes', retry: { initialInterval: '1 second', backoffCoefficient: 2, maximumInterval: '30 seconds', maximumAttempts: 4 } });
export const execute = proxyActivities<TaskActivities>({ startToCloseTimeout: '50 minutes', heartbeatTimeout: '10 seconds', retry: { initialInterval: '1 second', backoffCoefficient: 2, maximumInterval: '30 seconds', maximumAttempts: 5 } });

// Workflow time. Inside the Temporal sandbox `Date.now()` is the deterministic task time recorded in
// history (constant within a workflow task and identical on replay), so this is the one sanctioned
// use of Date in workflow code; the lint rule bans it everywhere else.
// eslint-disable-next-line no-restricted-globals -- deterministic sandbox clock, see above
export const workflowNow = (): number => Date.now();
export const HISTORY_SOFT_LIMIT = 5000;
export const GATE_ENGINE_V1 = 'gate-engine-v1';
export const BUDGET_V1 = 'budget-v1';
export const COMMANDS_V1 = 'commands-v1';
export const OUTCOME_V1 = 'outcome-v1';
export const SETTLE_V1 = 'settle-v1';
export const RESILIENCE_V1 = 'resilience-v1';
export const AUTHORITY_V1 = 'authority-v1';
export const PAUSABLE: readonly string[] = ['queued', 'running', 'waiting_input', 'waiting_decision'];
export const CANCELLABLE: readonly string[] = ['accepted', 'queued', 'running', 'waiting_input', 'waiting_decision', 'paused'];

export const logicalStageId = (taskId: string, planVersion: number, nodeId: string, attempt: number): string => `task-${taskId}/plan-${String(planVersion)}/${nodeId}/attempt-${String(attempt)}`;

export function freshNodes(plan: PlanSnapshot): Record<string, NodeState> {
  return Object.fromEntries(plan.nodes.map((n) => [n.id, { status: 'pending', attempt: 1 } satisfies NodeState]));
}
