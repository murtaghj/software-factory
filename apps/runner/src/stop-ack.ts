// The stop acknowledgement (W-019, SI-29): the supervisor learns of a stop from its next renewal (`not_renewable`, `stopping`) and sends this once.
// It grants nothing and changes no state (`06:112`: cancellation "permits only scoped checkpoint/cleanup recording"), so its locked statement has no
// lease clause. It is reachable only while the pod is not Terminating: the pod read refuses it after the delete has begun.
import { faultsOf, type RunnerDeps } from './core.ts';
import { NEED_STOP_ACK, type PermitDenial, type PodGuard, type PodRequest } from './pod-guard.ts';
import { writeStopAck } from './records.ts';

export type StopAckResult = { acknowledged: true; repeat: boolean } | PermitDenial;

export async function stopAck(d: RunnerDeps, guard: PodGuard, req: PodRequest): Promise<StopAckResult> {
  const g = await guard.authorizePodCall(req, NEED_STOP_ACK, 'runner.permit.stop_ack');
  if ('granted' in g) return g;
  const wrote = await d.db.withTenant({ orgId: g.a.orgId }, (tx) => writeStopAck(tx, d, g.a.orgId, g.a.id));
  return { acknowledged: true, repeat: !wrote };
}
// The pass a stop-ack sets off runs AFTER the response is written; its fault point is here so a test can hold it.
export const afterStopAck = (d: RunnerDeps): Promise<void> => faultsOf(d).hit('runner.after_stop_ack');
