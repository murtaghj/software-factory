// Worker assembly: registers TaskWorkflow and its Activities on one task queue.
import { Worker, bundleWorkflowCode, type NativeConnection, type WorkflowBundleWithSourceMap } from '@temporalio/worker';
import { createTaskActivities, type ActivityDeps } from './activities/task-activities.ts';

export const WORKFLOWS_PATH = new URL('./workflows/index.ts', import.meta.url).pathname;

export function bundleWorkflows(): Promise<WorkflowBundleWithSourceMap> {
  return bundleWorkflowCode({ workflowsPath: WORKFLOWS_PATH });
}

export async function createWorker(o: { connection: NativeConnection; namespace: string; taskQueue: string; workflowBundle?: WorkflowBundleWithSourceMap } & ActivityDeps): Promise<Worker> {
  return Worker.create({
    connection: o.connection, namespace: o.namespace, taskQueue: o.taskQueue, activities: createTaskActivities(o),
    ...(o.workflowBundle ? { workflowBundle: o.workflowBundle } : { workflowsPath: WORKFLOWS_PATH }),
  });
}
