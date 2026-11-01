// Types shared by TaskWorkflow and its Activities. Pure declarations only (workflow sandbox safe).
export type ArtifactRefLike = { artifactId: string; sha256: string; mediaType: string; schemaVersion: string; sizeBytes: number };
export type TaskStatus = 'accepted' | 'queued' | 'running' | 'waiting_input' | 'waiting_decision' | 'paused' | 'cancelling' | 'succeeded' | 'incomplete' | 'failed' | 'cancelled';
export const TERMINAL: readonly TaskStatus[] = ['succeeded', 'incomplete', 'failed', 'cancelled'];

export type LaunchPayload = {
  workflowId: string; taskId: string; orgId: string; specVersion: number; specHash: string; operationId: string;
  // Bounded-history knob: Continue-As-New after this many completed stages in one run (in addition
  // to the SDK suggestion and the soft history limit). Used to exercise rollover deterministically.
  continueAsNewAfterStages?: number;
};

export type PlanNodeSnapshot = { id: string; stageKind: string; role: string; dependsOn: string[]; requiredGateIds: string[]; timeoutClass: string; mandatory: boolean };
export type PlanSnapshot = {
  version: number;
  specVersion: number;
  planHash: string;
  policyRef: ArtifactRefLike;
  templateRef: { id: string; version: string; definitionRef: ArtifactRefLike };
  nodes: PlanNodeSnapshot[];
  // Added with gate-engine-v1. Absent in plans resolved by earlier builds.
  criteriaRef?: ArtifactRefLike;
  // Pinned ApplicationSnapshot (added in W-014; absent in plans resolved by earlier builds).
  applicationSnapshotRef?: ArtifactRefLike;
  // Added with budget-v1: the accepted TaskSpec budget.
  budget?: { maxMicroUsd: number; maxActiveSeconds: number; maxCalendarSeconds: number; maxAuthoringInvocations: number; maxSemanticAttemptsPerNode: number; invocationMode: 'one' | 'bounded' };
};

export type BudgetAdmission = { admitted: boolean; reasons: string[]; chargedMicroUsd: number; reservedMicroUsd: number; limitMicroUsd: number };

export type GateResult = { gateId: string; verdict: 'passed' | 'failed' | 'inconclusive'; evaluationId: string; reasonCodes: string[] };

export type NodeState = { status: 'pending' | 'running' | 'passed' | 'failed'; attempt: number; stageRunId?: string; inputHash?: string; resultRef?: ArtifactRefLike; outputRefs?: ArtifactRefLike[] };

export type StageBinding = { orgId: string; taskId: string; stageRunId: string; inputHash: string; allocationEpoch: number };
export type FakeStageResult = {
  schemaVersion: '2.0'; orgId: string; taskId: string; stageRunId: string; inputHash: string; allocationEpoch: number;
  status: 'completed' | 'product_failure' | 'inconclusive' | 'needs_input' | 'infrastructure_error' | 'cancelled';
  outputRefs: ArtifactRefLike[]; usage: unknown[]; producerId: string; completedAt: string; producerKind: 'runner';
};

export type CommandPayload = { workflowId: string; commandId: string; kind: string; expectedRevision: number; reason?: string; specVersion?: number; [key: string]: unknown };
export type Receipt = { state: 'accepted' | 'applied' | 'rejected'; reason?: string; resultingRevision?: number };

export type Checkpoint = {
  launch: LaunchPayload;
  status: TaskStatus;
  controlRevision: number;
  specVersion: number;
  plan: PlanSnapshot;
  projectionSequence: number;
  nodes: Record<string, NodeState>;
  receipts: Record<string, Receipt>;
  pendingAmendSpecVersion?: number;
  supersededResults: number;
  authoringInvocations?: number;
  // Test knob for Continue-As-New coverage: roll over after this many completed stages in a run.
  rolloverAfterStages?: number;
};

export type WorkflowView = { status: TaskStatus; controlRevision: number; specVersion: number; planVersion: number; projectionSequence: number; nodes: Record<string, NodeState>; supersededResults: number; receiptCount: number };

export interface TaskActivities {
  loadTask(i: { orgId: string; taskId: string }): Promise<{ status: TaskStatus; specVersion: number; controlRevision: number; projectionSequence: number }>;
  resolvePlan(i: { orgId: string; taskId: string; specVersion: number; planVersion: number }): Promise<PlanSnapshot>;
  startStage(i: { orgId: string; taskId: string; planVersion: number; nodeId: string; attempt: number; role: string; logicalId: string; inputHash: string; binding: Record<string, unknown> }): Promise<{ stageRunId: string }>;
  executeFakeStage(i: { orgId: string; taskId: string; logicalId: string; nodeId: string; stageKind: string; attempt: number; inputHash: string; specVersion: number; planVersion: number }): Promise<FakeStageResult>;
  finishStage(i: { orgId: string; logicalId: string; status: 'passed' | 'failed' | 'inconclusive'; resultRef?: ArtifactRefLike; errorClass?: string }): Promise<void>;
  supersedeStages(i: { orgId: string; taskId: string; oldPlanVersion: number; newPlanVersion: number }): Promise<number>;
  evaluateGates(i: { orgId: string; taskId: string; nodeId: string; logicalId: string; stageKind: string; requiredGateIds: string[]; binding: Record<string, unknown>; outputRefs: ArtifactRefLike[]; dependencyRefs: ArtifactRefLike[] }): Promise<{ allPassed: boolean; results: GateResult[] }>;
  supersedeGates(i: { orgId: string; taskId: string; oldPlanVersion: number; newPlanVersion: number }): Promise<number>;
  openBudget(i: { orgId: string; taskId: string; limitMicroUsd: number }): Promise<{ accountId: string }>;
  reserveStageBudget(i: { orgId: string; taskId: string; operationKey: string; nodeId: string }): Promise<BudgetAdmission>;
  chargeStageBudget(i: { orgId: string; taskId: string; operationKey: string; nodeId: string }): Promise<BudgetAdmission>;
  project(i: { orgId: string; taskId: string; sequence: number; state: { status: TaskStatus; currentNodeId?: string | null; waitingReason?: string | null; specVersion: number; planVersion: number; controlRevision: number }; refs: Record<string, unknown>; eventType: string; correlationId: string }): Promise<{ outcome: 'applied' | 'duplicate' | 'stale' }>;
}
