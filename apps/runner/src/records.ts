// The audit-event records of W-019 (section 6, "Records"): the writer start, the stop acknowledgement, the cancel stop and the urgent stop.
// Each follows D18 exactly: a deterministic id, pinned `action`, `resource_kind` and `outcome`, `ON CONFLICT DO NOTHING`, then read back;
// a row at that id with other fields is a hard error. They are read by primary key on every pass, so they are audit rows, not artifacts.
import { getAuditEventWithDetails, recordRunnerAudit, type Tx } from '@factory/database';
import { canonicalJson } from '@factory/domain';
import { sha256, type RunnerDeps } from './core.ts';
import { RunnerError } from './errors.ts';
import { cancelStopId, stopAckId, urgentStopId, writerStartId } from './names.ts';

type Spec = { action: string; resourceKind: 'execution_allocation' | 'stage_run' };
export const WRITER_START: Spec = { action: 'runner.writer_start', resourceKind: 'execution_allocation' };
export const STOP_ACK: Spec = { action: 'runner.stop_ack', resourceKind: 'execution_allocation' };
export const CANCEL_STOP: Spec = { action: 'runner.cancel_stop', resourceKind: 'execution_allocation' };
export const URGENT_STOP: Spec = { action: 'runner.urgent_stop', resourceKind: 'stage_run' };

async function write(tx: Tx, d: RunnerDeps, spec: Spec, o: { orgId: string; id: string; resourceId: string; correlation: string; details?: Record<string, unknown> }): Promise<boolean> {
  const wrote = await recordRunnerAudit(tx, { orgId: o.orgId, id: o.id, actorId: d.config.runnerIdentity, action: spec.action, resourceKind: spec.resourceKind, resourceId: o.resourceId, outcome: 'accepted',
    correlationId: o.correlation, requestDigest: sha256(canonicalJson({ action: spec.action, resourceId: o.resourceId })), ...(o.details === undefined ? {} : { details: o.details }) });
  const row = await read(tx, spec, o.orgId, o.id, o.resourceId);
  if (!row) throw new RunnerError('record_conflict', `${spec.action}: the record could not be read back`);
  return wrote;
}
// A primary-key read. The actor is not compared (a rename of the runner identity must not turn old records into hard conflicts).
async function read(tx: Tx, spec: Spec, orgId: string, id: string, resourceId: string): Promise<{ details: Record<string, unknown> | null } | undefined> {
  const row = await getAuditEventWithDetails(tx, orgId, id);
  if (!row) return undefined;
  if (row.action !== spec.action || row.resourceKind !== spec.resourceKind || row.resourceId !== resourceId || row.outcome !== 'accepted') throw new RunnerError('record_conflict', `a foreign row sits at the id of a ${spec.action} record`);
  return { details: row.details };
}

export type WriterStartDetails = { podName: string; podUid: string; nodeName: string | null; nodeUid: string | null; report: string | null; reported: true };
export const writeWriterStart = (tx: Tx, d: RunnerDeps, orgId: string, allocationId: string, details: WriterStartDetails): Promise<boolean> =>
  write(tx, d, WRITER_START, { orgId, id: writerStartId(orgId, allocationId), resourceId: allocationId, correlation: `writer-start:${allocationId}`, details });
export const readWriterStart = (tx: Tx, orgId: string, allocationId: string): Promise<{ details: Record<string, unknown> | null } | undefined> =>
  read(tx, WRITER_START, orgId, writerStartId(orgId, allocationId), allocationId);

export const writeStopAck = (tx: Tx, d: RunnerDeps, orgId: string, allocationId: string): Promise<boolean> =>
  write(tx, d, STOP_ACK, { orgId, id: stopAckId(orgId, allocationId), resourceId: allocationId, correlation: `stop-ack:${allocationId}` });
export const hasStopAck = async (tx: Tx, orgId: string, allocationId: string): Promise<boolean> => (await read(tx, STOP_ACK, orgId, stopAckId(orgId, allocationId), allocationId)) !== undefined;

// Written by `cancel`, in the transaction where IT makes the allocation's transition to `stopping`, and only then.
export const writeCancelStop = (tx: Tx, d: RunnerDeps, orgId: string, allocationId: string): Promise<boolean> =>
  write(tx, d, CANCEL_STOP, { orgId, id: cancelStopId(orgId, allocationId), resourceId: allocationId, correlation: `cancel-stop:${allocationId}` });
export const hasCancelStop = async (tx: Tx, orgId: string, allocationId: string): Promise<boolean> => (await read(tx, CANCEL_STOP, orgId, cancelStopId(orgId, allocationId), allocationId)) !== undefined;

// Written by `cancel` with `urgent`, under the stage run's lock.
export const writeUrgentStop = (tx: Tx, d: RunnerDeps, orgId: string, logicalId: string): Promise<boolean> =>
  write(tx, d, URGENT_STOP, { orgId, id: urgentStopId(orgId, logicalId), resourceId: logicalId, correlation: `urgent-stop:${logicalId}` });
export const hasUrgentStop = async (tx: Tx, orgId: string, logicalId: string): Promise<boolean> => (await read(tx, URGENT_STOP, orgId, urgentStopId(orgId, logicalId), logicalId)) !== undefined;
