// A deliberately incompatible TaskWorkflow build: it resolves the plan before loading the task.
// Replaying histories recorded by the real build against it must fail (AC-09 negative control).
import { proxyActivities } from '@temporalio/workflow';
import type { LaunchPayload, TaskActivities } from '../../src/workflows/types.ts';

const acts = proxyActivities<TaskActivities>({ startToCloseTimeout: '30 seconds' });

export async function TaskWorkflow(launch: LaunchPayload): Promise<void> {
  await acts.resolvePlan({ orgId: launch.orgId, taskId: launch.taskId, specVersion: 1, planVersion: 1 });
  await acts.loadTask({ orgId: launch.orgId, taskId: launch.taskId });
}
