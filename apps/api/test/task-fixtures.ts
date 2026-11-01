import type { TaskRequest } from '@factory/contracts';

export function taskRequest(applicationId: string, over: Partial<TaskRequest> = {}): TaskRequest {
  return {
    schemaVersion: '2.0',
    title: 'Add order cancellation',
    intent: 'Customers can cancel unfulfilled orders with an audit trail.',
    applicationIds: [applicationId],
    workType: 'feature',
    acceptanceCriteria: ['Authorized customer can cancel an unfulfilled order.', 'Repeated cancellation is idempotent.'],
    assurance: 'standard',
    deliveryScope: 'pr',
    budget: { maxMicroUsd: 25_000_000, maxActiveSeconds: 14_400, maxCalendarSeconds: 604_800, maxAuthoringInvocations: 8, maxSemanticAttemptsPerNode: 3, maxDesignReturns: 2, invocationMode: 'bounded' },
    targetContext: { kind: 'existing_application', applicationId },
    ...over,
  };
}
