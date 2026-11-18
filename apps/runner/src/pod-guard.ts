// The pod call guard (W-019, rule 4). One function, `authorizePodCall`, is the only way a pod-facing route reaches a row. In order: the
// review (local verification, the per-pod bucket, the shared budget, the TokenReview); the allocation by id; `owner_epoch` equal to the
// request's; the pod read (same UID, no deletion timestamp, our label, owned by `job_uid`); `pod_uid` equal to the reviewed UID, unless the
// route may claim; the state; the workspace clause of the route. The lease clause is in the locked statement of the route that grants or
// changes state, never here: nothing the supervisor remembers, and nothing this function read earlier, is authority.
import { getAllocation, getWorkspace, recordRunnerAudit, type AllocationRow, type AllocationState, type WorkspaceRow } from '@factory/database';
import { canonicalJson } from '@factory/domain';
import type { HarnessState, PermitDenialCode } from '@factory/runner-protocol';
import { reviewRateForWriters, supervisorSubject } from './config.ts';
import { UUID, sha256, type RunnerDeps } from './core.ts';
import { KubeError, type KubePod } from './kube/api.ts';
import { BucketTable, FailureMemory, TokenBucket } from './listener/buckets.ts';
import { tokenAudience } from './names.ts';
import { JwksCache, verifyTokenLocally } from './token.ts';

export const MAX_TOKEN_BYTES = 8 * 1024;
const POD_NAME_CAP = 253;
const POD_UID_CAP = 128;

export type PodRequest = { token: string; orgId: string; allocationId: string; epoch: number; source?: string };
export type { PermitDenialCode };
export type PermitDenial = { granted: false; code: PermitDenialCode; retryable: boolean; reason?: string };
export type Reviewed = { podName: string; podUid: string; username: string };

const RETRYABLE: ReadonlySet<PermitDenialCode> = new Set(['throttled', 'review_unavailable', 'not_ready']);
export const deny = (code: PermitDenialCode, reason?: string): PermitDenial => ({ granted: false, code, retryable: RETRYABLE.has(code), ...(reason === undefined ? {} : { reason }) });

// What a route needs of the row. `states` are the states the route works in; a row in another state is denied with `stateDenial`.
// `claimable` (acquire only) lets a pod that is not yet the writer through; every other route needs `pod_uid` equal to the reviewed pod.
export type Need = {
  route: 'acquire' | 'renew' | 'stop-ack';
  states: readonly AllocationState[];
  stateDenial: 'not_startable' | 'not_renewable';
  claimable: boolean;
  workspace: 'before_start' | 'writer_active' | 'writer_stopping';
};
export const NEED_ACQUIRE: Need = { route: 'acquire', states: ['starting', 'running', 'suspect'], stateDenial: 'not_startable', claimable: true, workspace: 'before_start' };
export const NEED_RENEW: Need = { route: 'renew', states: ['running', 'suspect'], stateDenial: 'not_renewable', claimable: false, workspace: 'writer_active' };
export const NEED_STOP_ACK: Need = { route: 'stop-ack', states: ['stopping'], stateDenial: 'not_renewable', claimable: false, workspace: 'writer_stopping' };

export type Authorized = { who: Reviewed; a: AllocationRow; pod: KubePod; ws: WorkspaceRow | undefined };

// The harness container as the cluster reports it in the pod this call already read.
export function harnessOf(pod: KubePod): HarnessState {
  const s = (pod.status.containerStatuses ?? []).find((c) => c.name === 'harness');
  if (!s) return { state: 'unknown' };
  if (s.state.terminated) return { state: 'terminated', exitCode: s.state.terminated.exitCode };
  if (s.state.running) return { state: 'running' };
  if (s.state.waiting) return { state: 'waiting' };
  return { state: 'unknown' };
}

export class PodGuard {
  readonly #d: RunnerDeps;
  readonly #counts = new Map<string, number>();
  readonly #failed = new FailureMemory(4096);
  readonly #podBuckets: BucketTable;
  readonly #auditBuckets: BucketTable;
  readonly #jwks: JwksCache;
  #bucket: TokenBucket;
  #rate: { perSecond: number; burst: number };

  constructor(d: RunnerDeps) {
    this.#d = d;
    const { burst, intervalMs } = d.config.podRate;
    this.#podBuckets = new BucketTable(4096, 1000 / intervalMs, burst);
    this.#auditBuckets = new BucketTable(4096, d.config.refusalAudit.perSecond, d.config.refusalAudit.burst);
    this.#rate = { perSecond: d.config.review.perSecond, burst: d.config.review.burst };
    this.#bucket = new TokenBucket(this.#rate.perSecond, this.#rate.burst, this.#now());
    this.#jwks = new JwksCache(d.kube, () => this.#now());
  }
  #wall(): number { return (this.#d.wallClockSeconds ?? ((): number => Math.floor(new Date().getTime() / 1000)))(); }
  #now(): number { return (this.#d.monotonicNowMs ?? ((): number => performance.now()))(); }
  counters(): Record<string, number> { return Object.fromEntries(this.#counts); }
  count(reason: string): void { this.#counts.set(reason, (this.#counts.get(reason) ?? 0) + 1); }
  reviewRate(): { perSecond: number; burst: number } { return { ...this.#rate }; }

  // Each pass hands over the writers it saw across all organizations; the budget is resized from them (W-019, "The listener").
  setLiveWriters(n: number): void {
    const r = reviewRateForWriters(this.#d.config, n);
    if (r.ceilingBound) {
      this.count('review_ceiling_bound');
      (this.#d.onWarning ?? ((m: string): void => { console.warn(m); }))(`[runner] the review budget is bound by its ceiling of ${String(this.#d.config.review.ceilingPerSecond)} a second with ${String(n)} live writers`);
    }
    this.#rate = { perSecond: r.perSecond, burst: r.burst };
    this.#bucket.resize(r.perSecond, r.burst, this.#now()); // the tokens the budget has left are carried over, not refilled
  }

  // The source charge: every request whose token did not verify locally is charged to its source (listener, step 3).
  #charged(req: PodRequest, d: PermitDenial): PermitDenial {
    if (this.#d.config.test?.chargeBeforeVerification !== true && this.#d.admitSource && !this.#d.admitSource(req.source)) { this.count('source_capped'); return deny('throttled', 'source_capped'); }
    return d;
  }

  // Steps 4 to 6 of the listener's admission order. Returns the reviewed pod, or the denial. Nothing is written for a refusal here.
  async review(req: PodRequest): Promise<Reviewed | PermitDenial> {
    const sw = this.#d.config.test;
    if (sw?.chargeBeforeVerification === true && this.#d.admitSource && !this.#d.admitSource(req.source)) { this.count('source_capped'); return deny('throttled', 'source_capped'); } // the old order, as a control
    const bad = (r: string): PermitDenial => { this.count(r); return this.#charged(req, deny('invalid_request', r)); };
    if (typeof req.token !== 'string' || req.token === '' || Buffer.byteLength(req.token) > MAX_TOKEN_BYTES) return bad('token_size');
    if (typeof req.orgId !== 'string' || !UUID.test(req.orgId) || typeof req.allocationId !== 'string' || !UUID.test(req.allocationId)) return bad('ids');
    if (!Number.isSafeInteger(req.epoch) || req.epoch < 1) return bad('epoch');
    const audience = tokenAudience(req.orgId, req.allocationId);
    // Keyed by token and audience: a token that failed for one allocation is not refused for the one it is for.
    const digest = sha256(`${req.token}|${audience}`);
    const now = this.#now();
    if (this.#failed.remembered(digest, now)) { this.count('recently_failed'); return this.#charged(req, deny('unauthenticated', 'recently_failed')); }
    const refuse = (reason: string, charged: boolean): PermitDenial => {
      this.count(reason);
      this.#failed.remember(digest, now + this.#d.config.review.failedTokenMemoryMs); // a success is never cached
      return charged ? this.#charged(req, deny('unauthenticated', reason)) : deny('unauthenticated', reason);
    };
    let local;
    try { local = await verifyTokenLocally(req.token, { audience, subject: supervisorSubject(this.#d.config), namespace: this.#d.config.namespace, serviceAccount: this.#d.config.supervisorServiceAccount }, this.#jwks, this.#wall()); } catch (e) {
      if (e instanceof KubeError) { this.count('review_unavailable'); return this.#charged(req, deny('review_unavailable')); } // no usable key set: not a verified token, so charged like an unknown key id
      throw e;
    }
    // An unknown key id may be a rotation the cache has not seen yet: retryable, charged to the source, and never remembered as a failed token.
    if (!local.ok && local.reason === 'unknown_key') { this.count('local_unknown_key'); return this.#charged(req, deny('review_unavailable', 'unknown_key')); }
    if (!local.ok) return refuse(`local_${local.reason}`, true);
    // The token verifies: from here the source is never charged or refused. The pod's own bucket stops one valid token from spending everyone's review budget.
    if (sw?.noPodBucket !== true && !this.#podBuckets.take(local.podUid, now)) { this.count('pod_throttled'); return deny('throttled', 'pod_rate'); }
    if (!this.#bucket.take(this.#now())) { this.count('throttled'); return deny('throttled'); }
    let r;
    try { r = await this.#d.kube.reviewToken(req.token, [audience]); } catch (e) {
      if (e instanceof KubeError) { this.count('review_unavailable'); return deny('review_unavailable'); }
      throw e;
    }
    if (!r.authenticated) return refuse('not_authenticated', false);
    if (r.error !== undefined && r.error !== '') return refuse('review_error', false);
    // An authenticator that ignores audiences can answer true with none: the exact audience must be listed.
    if (!Array.isArray(r.audiences) || !r.audiences.includes(audience)) return refuse('audience_missing', false);
    const username = r.user?.username;
    if (username !== supervisorSubject(this.#d.config)) return refuse('wrong_subject', false);
    const name = r.user?.extra?.['authentication.kubernetes.io/pod-name']?.[0];
    const uid = r.user?.extra?.['authentication.kubernetes.io/pod-uid']?.[0];
    if (typeof name !== 'string' || name === '' || name.length > POD_NAME_CAP || typeof uid !== 'string' || uid === '' || uid.length > POD_UID_CAP) return refuse('no_pod_binding', false);
    if (name !== local.podName || uid !== local.podUid) return refuse('binding_mismatch', false); // the review and the token must name the same pod
    return { podName: name, podUid: uid, username };
  }

  // After a good review a denial is typed and audited, through a bucket keyed by the REVIEWED POD UID (not the username: every supervisor has the same one).
  async denied(req: PodRequest, who: Reviewed, action: string, d: PermitDenial): Promise<PermitDenial> {
    if (!this.#auditBuckets.take(who.podUid, this.#now())) { this.count('denial_audit_capped'); return d; }
    await this.#d.db.withTenant({ orgId: req.orgId }, (tx) => recordRunnerAudit(tx, {
      orgId: req.orgId, actorId: who.username, action, resourceKind: 'execution_allocation', resourceId: req.allocationId, outcome: 'denied', correlationId: `${action}:${req.allocationId}`,
      requestDigest: sha256(canonicalJson({ action, code: d.code, pod: who.podUid })), details: { code: d.code, reason: d.reason ?? null, podUid: who.podUid, epoch: req.epoch } }));
    return d;
  }

  // The reviewed pod must still exist with the reviewed UID, no deletion timestamp, this allocation's label, and the allocation's Job as owner.
  async pod(a: AllocationRow, who: Reviewed): Promise<KubePod | undefined> {
    let pod: KubePod;
    try { pod = await this.#d.kube.getPod(who.podName); } catch (e) { if (e instanceof KubeError && e.isNotFound) return undefined; throw e; }
    const label = `${this.#d.config.labelPrefix}allocation`;
    if (pod.metadata.uid !== who.podUid || pod.metadata.deletionTimestamp !== undefined || pod.metadata.labels[label] !== a.id) return undefined;
    if (a.jobUid === null || !(pod.metadata.ownerReferences ?? []).some((o) => o.kind === 'Job' && o.uid === a.jobUid && o.name === a.jobName)) return undefined;
    return pod;
  }

  async authorizePodCall(req: PodRequest, need: Need, action: string): Promise<Authorized | PermitDenial> {
    const d = this.#d;
    const who = await this.review(req);
    if ('granted' in who) return who;
    const a = await d.db.withTenant({ orgId: req.orgId }, (tx) => getAllocation(tx, req.orgId, req.allocationId));
    if (!a) return this.denied(req, who, action, deny('not_this_job', 'unknown_allocation'));
    if (a.ownerEpoch !== req.epoch) return this.denied(req, who, action, deny('stale_epoch'));
    const pod = await this.pod(a, who);
    if (!pod) return this.denied(req, who, action, deny('not_this_job', 'pod'));
    if (!need.claimable) {
      // Another pod's allocation: only the writer is answered with anything about its state. (A row that is not yet claimed has no writer.)
      if (a.podUid !== who.podUid) return this.denied(req, who, action, deny(need.stateDenial, a.podUid === null ? a.state : 'not_the_writer'));
    } else if (a.podUid !== null && a.podUid !== who.podUid && a.state !== 'starting') {
      // Another pod holds the claim. While its writer lives (running, suspect) this pod is a duplicate writer (exit 65), however the race was
      // timed against the winner's commit; once the allocation is stopping or terminal it is merely not startable (exit 66).
      if (a.state === 'running' || a.state === 'suspect') return this.denied(req, who, action, deny('duplicate_writer', a.state));
      return this.denied(req, who, action, deny('not_startable', a.state));
    }
    if (!need.states.includes(a.state)) return this.denied(req, who, action, deny(need.stateDenial, a.state)); // `stopping` is how a supervisor learns of a stop
    // The workspace clause of the route.
    let ws: WorkspaceRow | undefined;
    if (a.workspaceId !== null) {
      ws = await d.db.withTenant({ orgId: a.orgId }, (tx) => getWorkspace(tx, a.orgId, a.workspaceId as string));
      if (!ws || ws.ownerEpoch !== a.ownerEpoch) return this.denied(req, who, action, deny('stale_epoch', 'workspace'));
      const mine = ws.ownerPodUid === who.podUid;
      const ok = need.workspace === 'before_start' ? (a.state === 'starting' ? (ws.state === 'allocated' || (ws.state === 'active' && mine)) : (ws.state === 'active' && mine))
        : need.workspace === 'writer_active' ? (ws.state === 'active' && mine)
          : (mine && (ws.state === 'active' || ws.state === 'quiescing'));
      // A duplicate that arrives after the winner's `markWriterStarted` finds the workspace active and owned by another pod: that is still a duplicate writer (exit 65), not a pod that is merely not startable.
      if (!ok && need.route === 'acquire' && ws.state === 'active' && !mine) return this.denied(req, who, action, deny('duplicate_writer', 'workspace_active'));
      if (!ok) return this.denied(req, who, action, deny(need.route === 'renew' || need.route === 'stop-ack' ? 'stale_epoch' : 'not_startable', `workspace_${ws.state}`));
    }
    return { who, a, pod, ws };
  }
}
