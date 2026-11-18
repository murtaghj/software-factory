// The quarantine record (`factory-quarantine-record/1`): written in the transaction that moves an allocation to `quarantined`, as restricted
// evidence (`06-runner-workspaces.md:104`), with the obligation an operator must settle (D25).
import { recordKind } from './controller-record.ts';
import type { ProofPod } from './quiescence-proof.ts';

export const QUARANTINE_RECORD_SCHEMA = 'factory-quarantine-record/1';
export const quarantineRecord = recordKind({ name: 'quarantine_record', schema: QUARANTINE_RECORD_SCHEMA, classification: 'restricted' });

export type QuarantineRecordBody = {
  schema: typeof QUARANTINE_RECORD_SCHEMA;
  organizationId: string; taskId: string; allocationId: string; stageRunId: string; generation: number; epoch: number; workspaceId: string | null;
  source: 'desired' | 'starting' | 'stopping';
  reason: string;                       // a code, never container text
  notProvedBecause: string | null;      // the quiescence reason when the source is `stopping`
  lastObservation: ProofPod[];          // the proof's shape; no container message or reason text; shrinks to fit the cap, `podCount` says how many there were
  podCount?: number;
  claim: { name: string; uid: string | null } | null;
  writer: { podUid: string } | null;
  recordedAt: string; preserveUntil: string; escalateAfter: string;
  obligation: { kind: 'quarantined_allocation'; owner: string; needsOperator: true };
};
