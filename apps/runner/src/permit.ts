// Permits, runner side (section 5, and W-019's guard). The supervisor side, the 10 s heartbeat sender and the process stop are the supervisor's (19b).
//
// Identity is never what the pod says, on either call. Both take { token, orgId, allocationId, epoch } and
// both review the token every time; the pod UID is taken only from the review, because the harness can reach
// the same route and can learn its pod's UID. A good review does not show the pod still exists (the cluster
// keeps a successful review for several seconds after the pod is deleted, step 0), so both calls then read the pod.
// All of that is `authorizePodCall` (pod-guard.ts).
//
// Every route that grants carries the lease clause in its own locked statement (rule 4): the first commit checks the start deadline, and
// every other grant, whatever branch it comes from, is the renewal statement. No branch returns a grant it did not just write.
//
// Refusals before a good review write nothing: an unauthenticated caller could otherwise make the runner
// write an audit row, in an organization of its choosing, per attempt. They are counted in process by reason.
import { claimWriterPod, getAllocation, getRunnerStageRunById, getWorkspace, lockAllocation, renewAllocationLease, setLockWait, transitionAllocation, isLockTimeout, type AllocationRow } from '@factory/database';
import type { HarnessState, PermitDenialCode } from '@factory/runner-protocol';
import { WorkspaceError } from '@factory/workspace';
import { activateCapacity } from './capacity-standin.ts';
import { faultsOf, readCancelRecord, runnerCtx, type RunnerDeps } from './core.ts';
import { KubeError, type KubePod } from './kube/api.ts';
import { NEED_ACQUIRE, NEED_RENEW, PodGuard, deny, harnessOf, type PermitDenial, type PodRequest, type Reviewed } from './pod-guard.ts';
import { parseMaterializeStatus } from './pod/receipt.ts';
import { writeWriterStart } from './records.ts';
import { settleWorkspace } from './workspaces.ts';

export { MAX_TOKEN_BYTES } from './pod-guard.ts';
export type { PermitDenialCode, PermitDenial };
// `source` names where the request came from (the listener fills it); `admitSource` in the deps charges it. `report` is the supervisor's start report, stored as reported.
export type PermitRequest = PodRequest & { report?: string };
export type PermitGrant = { granted: true; allocationId: string; generation: number; epoch: number; podUid: string; leaseSeconds: number; beatSeconds: number; harness?: HarnessState };
export type PermitResult = PermitGrant | PermitDenial;
const REPORT_CAP = 1024;

export class PermitService {
  readonly #d: RunnerDeps;
  readonly guard: PodGuard;

  constructor(d: RunnerDeps) { this.#d = d; this.guard = new PodGuard(d); }

  // Refusals before the database, by reason.
  counters(): Record<string, number> { return this.guard.counters(); }

  #grant(a: AllocationRow, podUid: string, pod: KubePod): PermitGrant {
    const d = this.#d;
    return { granted: true, allocationId: a.id, generation: a.generation, epoch: a.ownerEpoch, podUid, leaseSeconds: d.config.leaseSeconds, beatSeconds: d.config.beatSeconds, harness: harnessOf(pod) };
  }

  // Why the renewal statement did not write, in this order: the row is gone; another pod is the writer; the state is not running or suspect (`stopping`
  // is how a supervisor learns of a stop, whatever the workspace says); the workspace is not at this epoch; otherwise the lease has passed.
  async #notRenewed(req: PermitRequest, who: Reviewed, action: string, code: 'not_renewable' | 'not_startable'): Promise<PermitDenial> {
    const d = this.#d;
    const now = await d.db.withTenant({ orgId: req.orgId }, (tx) => getAllocation(tx, req.orgId, req.allocationId));
    if (!now) return this.guard.denied(req, who, action, deny(code, 'gone'));
    if (now.podUid !== who.podUid) return this.guard.denied(req, who, action, deny(code, 'not_the_writer'));
    if (now.state !== 'running' && now.state !== 'suspect') return this.guard.denied(req, who, action, deny(code, now.state));
    if (now.workspaceId !== null && await this.#workspaceMoved(now, who)) return this.guard.denied(req, who, action, deny('stale_epoch', 'workspace'));
    return this.guard.denied(req, who, action, deny(code, 'lease_expired'));
  }
  async #workspaceMoved(a: AllocationRow, who: Reviewed): Promise<boolean> {
    const ws = await this.#d.db.withTenant({ orgId: a.orgId }, (tx) => getWorkspace(tx, a.orgId, a.workspaceId as string));
    return !ws || ws.ownerEpoch !== a.ownerEpoch || ws.ownerPodUid !== who.podUid || ws.state !== 'active';
  }

  // The renewal statement: one UPDATE, epoch and writer pod equal, running or suspect, lease unexpired on clock_timestamp(), workspace at this
  // epoch and owned by this pod; the lease is refreshed in the same statement.
  async #renewal(a: AllocationRow, who: Reviewed): Promise<AllocationRow | undefined> {
    const d = this.#d;
    return d.db.withTenant({ orgId: a.orgId }, (tx) => renewAllocationLease(tx, { orgId: a.orgId, id: a.id, ownerEpoch: a.ownerEpoch, podUid: who.podUid, leaseSeconds: d.config.leaseSeconds }));
  }

  async acquireStartPermit(req: PermitRequest): Promise<PermitResult> {
    const d = this.#d;
    const action = 'runner.permit.acquire';
    const g = await this.guard.authorizePodCall(req, NEED_ACQUIRE, action);
    if ('granted' in g) return g;
    const { who, a, pod } = g;
    // Wherever acquire finds the row already running for this pod, the grant is the renewal statement's.
    if (a.state !== 'starting') {
      const row = await this.#renewal(a, who);
      return row ? this.#grant(row, who.podUid, pod) : this.#notRenewed(req, who, action, 'not_startable');
    }
    const ctx = runnerCtx(d, a.orgId, a.taskId);
    // The node the writer runs on is read after the review and the pod read, so a caller who is not authenticated never costs a Kubernetes call.
    let node: { name: string | null; uid: string | null } = { name: pod.spec.nodeName ?? null, uid: null };
    if (d.config.nodeCheck === 'required') {
      if (pod.spec.nodeName === undefined) return this.#deniedNotReady(req, who, action, 'node_unscheduled');
      try { const n = await d.kube.getNode(pod.spec.nodeName); node = { name: n.name, uid: n.uid }; } catch (e) {
        if (e instanceof KubeError) return this.#deniedNotReady(req, who, action, 'node_unreadable');
        throw e;
      }
    }
    if (a.workspaceId !== null) {
      // The pod must be a candidate: its own init step shows exit 0 and a receipt equal to the accepted one (accepted now, if this call is first to see it).
      const st = parseMaterializeStatus(pod);
      if (st.kind === 'not_finished') return this.guard.denied(req, who, action, deny('not_ready'));
      if (st.kind !== 'receipt') return this.guard.denied(req, who, action, deny('no_receipt', st.kind));
      try { await d.workspaces.acceptMaterialization(ctx, a.workspaceId, a.ownerEpoch, st.receipt); } catch (e) {
        if (e instanceof WorkspaceError && (e.code === 'receipt_mismatch' || e.code === 'conflict' || e.code === 'invalid_state')) return this.guard.denied(req, who, action, deny('no_receipt', e.code));
        if (e instanceof WorkspaceError && e.code === 'stale_epoch') return this.guard.denied(req, who, action, deny('stale_epoch'));
        throw e;
      }
    }
    // Locked, allocation row only: the only place a winner is chosen. A start deadline that has passed is a refusal here, before any writer starts.
    const claim = await d.db.withTenant({ orgId: a.orgId }, async (tx) => {
      await setLockWait(tx, 5000);
      const locked = await lockAllocation(tx, a.orgId, a.id);
      if (!locked || locked.ownerEpoch !== req.epoch) return 'stale_epoch' as const;
      // A run that has a cancel record is never started, whatever state its row is in.
      if (await readCancelRecord(tx, d, a.orgId, a.stageRunLogicalId)) return 'not_startable' as const;
      if (locked.state === 'running' && locked.podUid === who.podUid) return 'already_running' as const; // a concurrent call of this pod committed first
      if (locked.state !== 'starting') return 'not_startable' as const;
      if (locked.leaseExpired) return 'start_deadline' as const;
      if (locked.podUid === null) return (await claimWriterPod(tx, { orgId: a.orgId, id: a.id, ownerEpoch: req.epoch, podUid: who.podUid })) ? 'claimed' as const : 'not_startable' as const;
      return locked.podUid === who.podUid ? 'claimed' as const : 'duplicate_writer' as const;
    }).catch((e: unknown) => { if (isLockTimeout(e)) return 'busy' as const; throw e; });
    if (claim === 'busy') return deny('not_ready', 'lock_wait');
    if (claim === 'already_running') { const row = await this.#renewal(a, who); return row ? this.#grant(row, who.podUid, pod) : this.#notRenewed(req, who, action, 'not_startable'); }
    if (claim === 'start_deadline') return this.guard.denied(req, who, action, deny('not_startable', 'start_deadline'));
    if (claim !== 'claimed') return this.guard.denied(req, who, action, deny(claim));
    await faultsOf(d).hit('runner.after_permit_claim');

    if (a.workspaceId !== null) {
      const fresh = await d.db.withTenant({ orgId: a.orgId }, (tx) => getAllocation(tx, a.orgId, a.id));
      if (!fresh || (fresh.state !== 'starting' && !(fresh.state === 'running' && fresh.podUid === who.podUid))) return this.#stoppedMeanwhile(req, who, action, a);
      await faultsOf(d).hit('runner.before_writer_started');
      try { await d.workspaces.markWriterStarted(ctx, a.workspaceId, a.ownerEpoch, who.podUid); } catch (e) {
        if (e instanceof WorkspaceError && e.code === 'stale_epoch') return this.guard.denied(req, who, action, deny('stale_epoch'));
        if (e instanceof WorkspaceError && (e.code === 'invalid_state' || e.code === 'conflict')) return this.guard.denied(req, who, action, deny('not_startable', e.code));
        throw e;
      }
      await faultsOf(d).hit('runner.after_writer_started');
    }
    await faultsOf(d).hit('runner.before_permit_commit');
    await faultsOf(d).hit('runner.before_permit_last_tx');
    const report = req.report === undefined ? null : req.report.slice(0, REPORT_CAP);
    const done = await d.db.withTenant({ orgId: a.orgId }, async (tx) => {
      await setLockWait(tx, 5000);
      const locked = await lockAllocation(tx, a.orgId, a.id);
      // A retry by the pod that already holds the permit: not the old row, the renewal statement (lease unexpired, refreshed), so no branch returns a grant it did not just write.
      if (locked?.state === 'running' && locked.podUid === who.podUid) return (await renewAllocationLease(tx, { orgId: a.orgId, id: a.id, ownerEpoch: a.ownerEpoch, podUid: who.podUid, leaseSeconds: d.config.leaseSeconds })) ?? 'lease_gone' as const;
      if (!locked || locked.state !== 'starting' || locked.podUid !== who.podUid) return undefined;
      if (await readCancelRecord(tx, d, a.orgId, a.stageRunLogicalId)) return undefined;
      // `starting -> running` only while the start deadline has not passed, judged in this statement.
      const next = await transitionAllocation(tx, { orgId: a.orgId, id: a.id, ownerEpoch: a.ownerEpoch, from: ['starting'], to: 'running', heartbeat: true, leaseSeconds: d.config.leaseSeconds, leaseUnexpired: true });
      if (!next) return undefined;
      const stage = await getRunnerStageRunById(tx, a.orgId, a.stageRunId);
      if (stage) await activateCapacity(tx, d.config, { orgId: a.orgId, stageRunId: a.stageRunId, role: stage.role, generation: a.generation });
      await writeWriterStart(tx, d, a.orgId, a.id, { podName: who.podName, podUid: who.podUid, nodeName: node.name, nodeUid: node.uid, report, reported: true });
      return next;
    }).catch((e: unknown) => { if (isLockTimeout(e)) return 'busy' as const; throw e; });
    if (done === 'busy') return deny('not_ready', 'lock_wait');
    if (done === 'lease_gone') return this.#notRenewed(req, who, action, 'not_startable');
    if (!done) return this.#stoppedMeanwhile(req, who, action, a);
    return this.#grant(done, who.podUid, pod);
  }

  async #deniedNotReady(req: PermitRequest, who: Reviewed, action: string, reason: string): Promise<PermitDenial> {
    return this.guard.denied(req, who, action, deny('not_ready', reason));
  }

  // The allocation was stopped between the steps: not_startable, and the workspace is settled (quiescing while a stop is
  // under way; retained once `terminated` has proved every pod gone), because this permit may have started its writer.
  async #stoppedMeanwhile(req: PermitRequest, who: Reviewed, action: string, a: AllocationRow): Promise<PermitDenial> {
    const now = await this.#d.db.withTenant({ orgId: a.orgId }, (tx) => getAllocation(tx, a.orgId, a.id));
    if (now) await settleWorkspace(this.#d, now, now.state === 'terminated' ? 'proof' : 'stopping');
    return this.guard.denied(req, who, action, deny('not_startable', now?.state === 'starting' ? (now.leaseExpired ? 'start_deadline' : 'starting') : (now?.state ?? 'gone')));
  }

  async renewPermit(req: PermitRequest): Promise<PermitResult> {
    const action = 'runner.permit.renew';
    const g = await this.guard.authorizePodCall(req, NEED_RENEW, action);
    if ('granted' in g) return g;
    // One UPDATE: epoch and writer pod equal, running or suspect, lease not passed on clock_timestamp(), and the workspace still this pod's at this epoch.
    const row = await this.#renewal(g.a, g.who);
    return row ? this.#grant(row, g.who.podUid, g.pod) : this.#notRenewed(req, g.who, action, 'not_renewable');
  }
}
