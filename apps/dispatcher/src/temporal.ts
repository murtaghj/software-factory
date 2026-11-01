// The dispatcher's view of Temporal: start a task workflow, describe it, and deliver an Update.
// TemporalGateway is a thin adapter over the real client; tests wrap it to inject faults around
// real calls (e.g. "the start succeeded but the reply was lost").
import { Client, WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError, WorkflowUpdateFailedError, type Connection } from '@temporalio/client';

export const TASK_WORKFLOW_TYPE = 'TaskWorkflow';
export const APPLY_COMMAND_UPDATE = 'applyCommand';

export type StartRequest = { workflowId: string; taskQueue: string; args: unknown[] };
export type WorkflowDescription = { workflowId: string; runId: string; status: string };
export type UpdateResult = { state: 'accepted' | 'applied' | 'rejected'; reason?: string; resultingRevision?: number };

export interface TemporalGateway {
  start(req: StartRequest): Promise<{ runId: string }>;
  describe(workflowId: string): Promise<WorkflowDescription | undefined>;
  update(workflowId: string, updateId: string, args: [unknown]): Promise<UpdateResult>;
}

export class AlreadyStarted extends Error {
  constructor(workflowId: string) { super(`workflow ${workflowId} already started`); this.name = 'AlreadyStarted'; }
}
export class UpdateRejected extends Error {
  constructor(message: string) { super(message); this.name = 'UpdateRejected'; }
}

export class ClientGateway implements TemporalGateway {
  private readonly client: Client;
  constructor(connection: Connection, namespace: string) {
    this.client = new Client({ connection, namespace });
  }

  async start(req: StartRequest): Promise<{ runId: string }> {
    try {
      const handle = await this.client.workflow.start(TASK_WORKFLOW_TYPE, {
        workflowId: req.workflowId,
        taskQueue: req.taskQueue,
        args: req.args,
        // One task workflow per task, ever: never start a second execution under the same ID.
        workflowIdConflictPolicy: 'FAIL',
        workflowIdReusePolicy: 'REJECT_DUPLICATE',
        // Workflow-level retries are disabled for TaskWorkflow (chapter 04).
        retry: { maximumAttempts: 1 },
      });
      return { runId: handle.firstExecutionRunId };
    } catch (e) {
      if (e instanceof WorkflowExecutionAlreadyStartedError) throw new AlreadyStarted(req.workflowId);
      throw e;
    }
  }

  async describe(workflowId: string): Promise<WorkflowDescription | undefined> {
    try {
      const d = await this.client.workflow.getHandle(workflowId).describe();
      return { workflowId, runId: d.runId, status: d.status.name };
    } catch (e) {
      if (e instanceof WorkflowNotFoundError) return undefined;
      throw e;
    }
  }

  async update(workflowId: string, updateId: string, args: [unknown]): Promise<UpdateResult> {
    try {
      return await this.client.workflow.getHandle(workflowId).executeUpdate<UpdateResult, [unknown]>(APPLY_COMMAND_UPDATE, { args, updateId });
    } catch (e) {
      if (e instanceof WorkflowUpdateFailedError) throw new UpdateRejected(e.cause?.message ?? e.message);
      throw e;
    }
  }
}
