// The durable quiescence proof (`factory-quiescence-proof/1`): the runner's statement that nothing of an allocation was running when it was
// read, stored as a controller artifact (rule 6: once an allocation has one it can only become `terminated`).
import { recordKind } from './controller-record.ts';

export const QUIESCENCE_PROOF_SCHEMA = 'factory-quiescence-proof/1';
export const quiescenceProof = recordKind({ name: 'quiescence_proof', schema: QUIESCENCE_PROOF_SCHEMA, classification: 'ordinary' });

export type ProofContainer = { name: string; kind: 'init' | 'app'; state: 'waiting' | 'running' | 'terminated' | 'unknown'; exitCode?: number };
export type ProofPod = { podUid: string; phase: string; containers: ProofContainer[] };
export type QuiescenceProofBody = {
  schema: typeof QUIESCENCE_PROOF_SCHEMA;
  organizationId: string; taskId: string; allocationId: string; stageRunId: string; generation: number; epoch: number; workspaceId: string | null;
  job: { name: string; uid: string | null; absent: true };
  writer: { podUid: string; podName: string | null; nodeName: string | null; nodeUid: string | null } | null;
  pods: ProofPod[];                   // the writer's pod first, then others, at most 100; `podCount` and `observationDigest` cover them all
  podCount: number; observationDigest: string;
  // `finished`: the writer's pod is still listed and every container of it is finished. `gone`: the object is absent (the kubelet removed
  // it). `none`: no pod ever held the writer claim.
  writerPod: 'finished' | 'gone' | 'none';
  nodeCheck: 'passed' | 'not_needed' | 'off';
  detachment: { method: 'no_consumer_pod'; claim: { name: string; uid: string } } | { method: 'no_claim' };
  storage: 'pod_scoped_local';
  observedAt: string; // the Postgres clock, read in the unlocked phase, before the put
};
