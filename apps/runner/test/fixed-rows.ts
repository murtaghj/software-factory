// Fixed rows for the committed manifest documents: the builders are pure functions of these and the config.
import type { AllocationRow, RunnerStageRun, WorkspaceRow } from '@factory/database';
import { createTestConfig } from '../src/testing.ts';

export const ORG = '00000000-0000-4000-8000-000000000001';
export const TASK = '00000000-0000-4000-8000-000000000002';
export const WS = '00000000-0000-4000-8000-000000000003';
export const LOGICAL = `task-${TASK}/plan-1/implement/attempt-1`;
export const config = createTestConfig({ runnerIdentity: 'runner:factory', controlPlaneIdentities: ['service:worker'] });

export const allocation: AllocationRow = {
  orgId: ORG, id: '6d6363a2-a415-8491-9af4-367374fd9aac', stageRunId: '00000000-0000-4000-8000-000000000005', stageRunLogicalId: LOGICAL, taskId: TASK, workspaceId: WS,
  generation: 1, ownerEpoch: 1, specHash: 'e'.repeat(64), jobName: 'factory-pivtiima6zxpahjnxf4d-g1', jobUid: null, podUid: null, namespace: 'factory-exec-local',
  supervisorIdentity: 'system:serviceaccount:factory-exec-local:factory-allocation-supervisor', state: 'desired',
  leaseExpired: false, leaseRemainingMs: 600_000, heartbeatAgeMs: null, sinceUpdateMs: 0, terminated: false, heartbeatBeforeUpdateMs: null,
};
export const stage: RunnerStageRun = {
  orgId: ORG, id: allocation.stageRunId, taskId: TASK, logicalId: LOGICAL, nodeId: 'implement', semanticAttempt: 1, role: 'implementer', status: 'running', inputHash: 'c'.repeat(64),
  limits: { wallSeconds: 2700, maxTurns: 40, maxToolCalls: 200, maxOutputBytes: 1_000_000, reservedMicroUsd: 0 }, resultRef: null, superseded: false, taskStatus: 'running',
};
export const workspace: WorkspaceRow = {
  orgId: ORG, id: WS, taskId: TASK, repositoryId: '00000000-0000-4000-8000-000000000006', stageRunId: stage.id, stageRunLogicalId: LOGICAL, role: 'implementer', branch: `factory/${TASK}/main`,
  baseCommit: 'c'.repeat(40), candidateCommit: null, state: 'allocated', generation: 1, ownerEpoch: 1, ownerPodUid: null, setupProfileRef: {}, checkpointRef: null,
};
export const request = { kind: 'remote' as const, target: { orgId: ORG, workspaceId: WS, generation: 1 }, taskId: TASK, cloneUrl: 'https://git.example.test/org/repo.git', commit: 'c'.repeat(40), branch: `factory/${TASK}/main`, subpath: '' };
