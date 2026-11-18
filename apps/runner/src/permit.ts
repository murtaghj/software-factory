// Permits, runner side (section 5). The supervisor side, the 10 s heartbeat sender and the process stop are W-019.
//
// Identity is never what the pod says, on either call. Both take { token, orgId, allocationId, epoch } and
// both review the token every time; the pod UID is taken only from the review, because the harness can reach
// the same route and can learn its pod's UID. A good review does not show the pod still exists (the cluster
// keeps a successful review for several seconds after the pod is deleted, step 0), so both calls then read the pod.
//
// Refusals before a good review write nothing: an unauthenticated caller could otherwise make the runner
// write an audit row, in an organization of its choosing, per attempt. They are counted in process by reason.
import { claimWriterPod, getAllocation, getRunnerStageRunById, lockAllocation, recordRunnerAudit, renewAllocationLease, setLockWait, transitionAllocation, isLockTimeout, type AllocationRow } from '@factory/database';
import { canonicalJson } from '@factory/domain';
import { WorkspaceError } from '@factory/workspace';
import { activateCapacity } from './capacity-standin.ts';
import { supervisorSubject } from './config.ts';
import { UUID, faultsOf, readCancelRecord, runnerCtx, sha256, type RunnerDeps } from './core.ts';
import { KubeError, type KubePod } from './kube/api.ts';
import { tokenAudience } from './names.ts';
import { parseMaterializeStatus } from './pod/receipt.ts';
import { JwksCache, verifyTokenLocally } from './token.ts';
import { settleWorkspace } from './workspaces.ts';

export const MAX_TOKEN_BYTES = 8 * 1024;
const POD_NAME_CAP = 253;
const POD_UID_CAP = 128;

// `source` names where the request came from (W-019's listener fills it); `admitSource` in the deps may cap it per source.
export type PermitRequest = { token: string; orgId: string; allocationId: string; epoch: number; source?: string };
export type PermitGrant = { granted: true; allocationId: string; generation: number; epoch: number; podUid: string; leaseSeconds: number; beatSeconds: number };
export type PermitDenialCode =
  | 'invalid_request' | 'unauthenticated' | 'throttled' | 'review_unavailable'
  | 'not_this_job' | 'duplicate_writer' | 'no_receipt' | 'stale_epoch' | 'not_ready' | 'not_startable' | 'not_renewable';
export type PermitDenial = { granted: false; code: PermitDenialCode; retryable: boolean; reason?: string };
export type PermitResult = PermitGrant | PermitDenial;

const RETRYABLE: ReadonlySet<PermitDenialCode> = new Set(['throttled', 'review_unavailable', 'not_ready']);
const deny = (code: PermitDenialCode, reason?: string): PermitDenial => ({ granted: false, code, retryable: RETRYABLE.has(code), ...(reason === undefined ? {} : { reason }) });

type Reviewed = { podName: string; podUid: string; username: string };

export class PermitService {
  readonly #d: RunnerDeps;
  readonly #counts = new Map<string, number>();
  readonly #failed = new Map<string, number>(); // sha256(token | audience) -> expiry (monotonic ms)
  readonly #jwks: JwksCache;
  #bucket: number;
  #bucketAt: number;

  constructor(d: RunnerDeps) {
    this.#d = d;
    this.#bucket = d.config.review.burst;
    this.#bucketAt = this.#now();
    this.#jwks = new JwksCache(d.kube, () => this.#now());
  }
  #wall(): number { return (this.#d.wallClockSeconds ?? ((): number => Math.floor(new Date().getTime() / 1000)))(); }
  #now(): number { return (this.#d.monotonicNowMs ?? ((): number => performance.now()))(); }

  // Refusals before the database, by reason.
  counters(): Record<string, number> { return Object.fromEntries(this.#counts); }
  #count(reason: string): void { this.#counts.set(reason, (this.#counts.get(reason) ?? 0) + 1); }

  #take(): boolean {
    const { perSecond, burst } = this.#d.config.review;
    const now = this.#now();
    this.#bucket = Math.min(burst, this.#bucket + ((now - this.#bucketAt) / 1000) * perSecond);
    this.#bucketAt = now;
    if (this.#bucket < 1) return false;
    this.#bucket -= 1;
    return true;
  }

  async #review(req: PermitRequest): Promise<Reviewed | PermitDenial> {
    const bad = (r: string): PermitDenial => { this.#count(r); return deny('invalid_request', r); };
    if (typeof req.token !== 'string' || req.token === '' || Buffer.byteLength(req.token) > MAX_TOKEN_BYTES) return bad('token_size');
    if (typeof req.orgId !== 'string' || !UUID.test(req.orgId) || typeof req.allocationId !== 'string' || !UUID.test(req.allocationId)) return bad('ids');
    if (!Number.isSafeInteger(req.epoch) || req.epoch < 1) return bad('epoch');
    const audience = tokenAudience(req.orgId, req.allocationId);
    // Keyed by token and audience: a token that failed for one allocation is not refused for the one it is for.
    const digest = sha256(`${req.token}|${audience}`);
    const until = this.#failed.get(digest);
    const now = this.#now();
    if (until !== undefined && until > now) { this.#count('recently_failed'); return deny('unauthenticated', 'recently_failed'); }
    const refuse = (reason: string): PermitDenial => {
      this.#count(reason);
      if (this.#failed.size >= 4096) for (const [k, v] of this.#failed) if (v <= now) this.#failed.delete(k);
      if (this.#failed.size < 4096) this.#failed.set(digest, now + this.#d.config.review.failedTokenMemoryMs); // a success is never cached
      return deny('unauthenticated', reason);
    };
    if (this.#d.admitSource && !this.#d.admitSource(req.source)) { this.#count('source_capped'); return deny('throttled', 'source_capped'); }
    // The shared TokenReview budget is spent only on a token that already verifies locally, so one tenant's junk cannot starve everyone's renewals.
    let local;
    try { local = await verifyTokenLocally(req.token, { audience, subject: supervisorSubject(this.#d.config), namespace: this.#d.config.namespace, serviceAccount: this.#d.config.supervisorServiceAccount }, this.#jwks, this.#wall()); } catch (e) {
      if (e instanceof KubeError) { this.#count('review_unavailable'); return deny('review_unavailable'); }
      throw e;
    }
    // An unknown key id may be a rotation the cache has not seen yet: retryable, and never remembered as a failed token.
    if (!local.ok && local.reason === 'unknown_key') { this.#count('local_unknown_key'); return deny('review_unavailable', 'unknown_key'); }
    if (!local.ok) return refuse(`local_${local.reason}`);
    if (!this.#take()) { this.#count('throttled'); return deny('throttled'); }
    let r;
    try { r = await this.#d.kube.reviewToken(req.token, [audience]); } catch (e) {
      if (e instanceof KubeError) { this.#count('review_unavailable'); return deny('review_unavailable'); }
      throw e;
    }
    if (!r.authenticated) return refuse('not_authenticated');
    if (r.error !== undefined && r.error !== '') return refuse('review_error');
    // An authenticator that ignores audiences can answer true with none: the exact audience must be listed.
    if (!Array.isArray(r.audiences) || !r.audiences.includes(audience)) return refuse('audience_missing');
    const username = r.user?.username;
    if (username !== supervisorSubject(this.#d.config)) return refuse('wrong_subject');
    const name = r.user?.extra?.['authentication.kubernetes.io/pod-name']?.[0];
    const uid = r.user?.extra?.['authentication.kubernetes.io/pod-uid']?.[0];
    if (typeof name !== 'string' || name === '' || name.length > POD_NAME_CAP || typeof uid !== 'string' || uid === '' || uid.length > POD_UID_CAP) return refuse('no_pod_binding');
    if (name !== local.podName || uid !== local.podUid) return refuse('binding_mismatch'); // the review and the token must name the same pod
    return { podName: name, podUid: uid, username };
  }

  // After a good review, a denial is typed and audited.
  async #denied(req: PermitRequest, who: Reviewed, action: string, d: PermitDenial): Promise<PermitDenial> {
    await this.#d.db.withTenant({ orgId: req.orgId }, (tx) => recordRunnerAudit(tx, {
      orgId: req.orgId, actorId: who.username, action, resourceKind: 'execution_allocation', resourceId: req.allocationId, outcome: 'denied', correlationId: `${action}:${req.allocationId}`,
      requestDigest: sha256(canonicalJson({ action, code: d.code, pod: who.podUid })), details: { code: d.code, reason: d.reason ?? null, podUid: who.podUid, epoch: req.epoch } }));
    return d;
  }

  // The reviewed pod must still exist with the reviewed UID, no deletion timestamp, this allocation's label, and the allocation's Job as owner.
  async #pod(a: AllocationRow, who: Reviewed): Promise<KubePod | undefined> {
    let pod: KubePod;
    try { pod = await this.#d.kube.getPod(who.podName); } catch (e) { if (e instanceof KubeError && e.isNotFound) return undefined; throw e; }
    const label = `${this.#d.config.labelPrefix}allocation`;
    if (pod.metadata.uid !== who.podUid || pod.metadata.deletionTimestamp !== undefined || pod.metadata.labels[label] !== a.id) return undefined;
    if (a.jobUid === null || !(pod.metadata.ownerReferences ?? []).some((o) => o.kind === 'Job' && o.uid === a.jobUid && o.name === a.jobName)) return undefined;
    return pod;
  }

  async acquireStartPermit(req: PermitRequest): Promise<PermitResult> {
    const d = this.#d;
    const who = await this.#review(req);
    if ('granted' in who) return who;
    const action = 'runner.permit.acquire';
    const a = await d.db.withTenant({ orgId: req.orgId }, (tx) => getAllocation(tx, req.orgId, req.allocationId));
    if (!a) return this.#denied(req, who, action, deny('not_this_job', 'unknown_allocation'));
    if (a.ownerEpoch !== req.epoch) return this.#denied(req, who, action, deny('stale_epoch'));
    const pod = await this.#pod(a, who);
    if (!pod) return this.#denied(req, who, action, deny('not_this_job', 'pod'));
    if (a.state !== 'starting' && !(a.state === 'running' && a.podUid === who.podUid)) return this.#denied(req, who, action, deny('not_startable', a.state));
    const ctx = runnerCtx(d, a.orgId, a.taskId);
    if (a.workspaceId !== null) {
      // The pod must be a candidate: its own init step shows exit 0 and a receipt equal to the accepted one (accepted now, if this call is first to see it).
      const st = parseMaterializeStatus(pod);
      if (st.kind === 'not_finished') return this.#denied(req, who, action, deny('not_ready'));
      if (st.kind !== 'receipt') return this.#denied(req, who, action, deny('no_receipt', st.kind));
      try { await d.workspaces.acceptMaterialization(ctx, a.workspaceId, a.ownerEpoch, st.receipt); } catch (e) {
        if (e instanceof WorkspaceError && (e.code === 'receipt_mismatch' || e.code === 'conflict' || e.code === 'invalid_state')) return this.#denied(req, who, action, deny('no_receipt', e.code));
        if (e instanceof WorkspaceError && e.code === 'stale_epoch') return this.#denied(req, who, action, deny('stale_epoch'));
        throw e;
      }
    }
    // Locked, allocation row only: the only place a winner is chosen.
    const claim = await d.db.withTenant({ orgId: a.orgId }, async (tx) => {
      await setLockWait(tx, 5000);
      const locked = await lockAllocation(tx, a.orgId, a.id);
      if (!locked || locked.ownerEpoch !== req.epoch) return 'stale_epoch' as const;
      // A run that has a cancel record is never started, whatever state its row is in.
      if (await readCancelRecord(tx, d, a.orgId, a.stageRunLogicalId)) return 'not_startable' as const;
      if (locked.state !== 'starting' && !(locked.state === 'running' && locked.podUid === who.podUid)) return 'not_startable' as const;
      if (locked.podUid === null) return (await claimWriterPod(tx, { orgId: a.orgId, id: a.id, ownerEpoch: req.epoch, podUid: who.podUid })) ? 'claimed' as const : 'not_startable' as const;
      return locked.podUid === who.podUid ? 'claimed' as const : 'duplicate_writer' as const;
    }).catch((e: unknown) => { if (isLockTimeout(e)) return 'busy' as const; throw e; });
    if (claim === 'busy') return deny('not_ready', 'lock_wait');
    if (claim !== 'claimed') return this.#denied(req, who, action, deny(claim));
    await faultsOf(d).hit('runner.after_permit_claim');

    if (a.workspaceId !== null) {
      const fresh = await d.db.withTenant({ orgId: a.orgId }, (tx) => getAllocation(tx, a.orgId, a.id));
      if (!fresh || (fresh.state !== 'starting' && !(fresh.state === 'running' && fresh.podUid === who.podUid))) return this.#stoppedMeanwhile(req, who, action, a);
      await faultsOf(d).hit('runner.before_writer_started');
      try { await d.workspaces.markWriterStarted(ctx, a.workspaceId, a.ownerEpoch, who.podUid); } catch (e) {
        if (e instanceof WorkspaceError && e.code === 'stale_epoch') return this.#denied(req, who, action, deny('stale_epoch'));
        if (e instanceof WorkspaceError && (e.code === 'invalid_state' || e.code === 'conflict')) return this.#denied(req, who, action, deny('not_startable', e.code));
        throw e;
      }
      await faultsOf(d).hit('runner.after_writer_started');
    }
    await faultsOf(d).hit('runner.before_permit_commit');
    const done = await d.db.withTenant({ orgId: a.orgId }, async (tx) => {
      await setLockWait(tx, 5000);
      const locked = await lockAllocation(tx, a.orgId, a.id);
      if (locked?.state === 'running' && locked.podUid === who.podUid) return locked; // a retry by the pod that already holds the permit
      if (!locked || locked.state !== 'starting' || locked.podUid !== who.podUid) return undefined;
      if (await readCancelRecord(tx, d, a.orgId, a.stageRunLogicalId)) return undefined;
      const next = await transitionAllocation(tx, { orgId: a.orgId, id: a.id, ownerEpoch: a.ownerEpoch, from: ['starting'], to: 'running', heartbeat: true, leaseSeconds: d.config.leaseSeconds });
      if (!next) return undefined;
      const stage = await getRunnerStageRunById(tx, a.orgId, a.stageRunId);
      if (stage) await activateCapacity(tx, d.config, { orgId: a.orgId, stageRunId: a.stageRunId, role: stage.role, generation: a.generation });
      return next;
    }).catch((e: unknown) => { if (isLockTimeout(e)) return 'busy' as const; throw e; });
    if (done === 'busy') return deny('not_ready', 'lock_wait');
    if (!done) return this.#stoppedMeanwhile(req, who, action, a);
    return { granted: true, allocationId: a.id, generation: a.generation, epoch: a.ownerEpoch, podUid: who.podUid, leaseSeconds: d.config.leaseSeconds, beatSeconds: d.config.beatSeconds };
  }

  // The allocation was stopped between the steps: not_startable, and the workspace is settled (quiescing while a stop is
  // under way; retained once `terminated` has proved every pod gone), because this permit may have started its writer.
  async #stoppedMeanwhile(req: PermitRequest, who: Reviewed, action: string, a: AllocationRow): Promise<PermitDenial> {
    const now = await this.#d.db.withTenant({ orgId: a.orgId }, (tx) => getAllocation(tx, a.orgId, a.id));
    if (now) await settleWorkspace(this.#d, now, now.state === 'terminated' ? 'proof' : 'stopping');
    return this.#denied(req, who, action, deny('not_startable', now?.state ?? 'gone'));
  }

  async renewPermit(req: PermitRequest): Promise<PermitResult> {
    const d = this.#d;
    const who = await this.#review(req);
    if ('granted' in who) return who;
    const action = 'runner.permit.renew';
    const a = await d.db.withTenant({ orgId: req.orgId }, (tx) => getAllocation(tx, req.orgId, req.allocationId));
    if (!a) return this.#denied(req, who, action, deny('not_this_job', 'unknown_allocation'));
    if (a.ownerEpoch !== req.epoch) return this.#denied(req, who, action, deny('stale_epoch'));
    const pod = await this.#pod(a, who);
    if (!pod) return this.#denied(req, who, action, deny('not_this_job', 'pod'));
    // One UPDATE: epoch and writer pod equal, running or suspect, lease not passed on clock_timestamp().
    const row = await d.db.withTenant({ orgId: a.orgId }, (tx) => renewAllocationLease(tx, { orgId: a.orgId, id: a.id, ownerEpoch: req.epoch, podUid: who.podUid, leaseSeconds: d.config.leaseSeconds }));
    if (!row) {
      const now = await d.db.withTenant({ orgId: a.orgId }, (tx) => getAllocation(tx, a.orgId, a.id));
      const why = now === undefined ? 'gone' : now.podUid !== who.podUid ? 'not_the_writer' : now.state === 'running' || now.state === 'suspect' ? 'lease_expired' : now.state; // `stopping` is how a supervisor learns of a cancel
      return this.#denied(req, who, action, deny('not_renewable', why));
    }
    return { granted: true, allocationId: row.id, generation: row.generation, epoch: row.ownerEpoch, podUid: who.podUid, leaseSeconds: d.config.leaseSeconds, beatSeconds: d.config.beatSeconds };
  }
}
