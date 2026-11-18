import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InjectedFault } from '@factory/test-support';
import { tokenAudience } from '../src/index.ts';
import { REVIEW_MEMORY_MS, terminateTx } from '../src/testing.ts';
import type { Database } from '@factory/database';
import { createEnv, hex, until, type Env, type Instance, type Stage } from './harness.ts';

let e: Env;
beforeAll(async () => { e = await createEnv('w017_permit'); });
afterAll(async () => { await e.close(); });

const start = (inst: Instance, s: Stage, workspaceId?: string) => inst.runner.startOrAttach(e.ctx(e.a), e.input(e.a, s, workspaceId ? { workspaceId } : {}), hex('e'));
const alloc = async (s: Stage) => (await e.allocations(e.a, s))[0] as NonNullable<Awaited<ReturnType<typeof e.allocations>>[number]>;
const req = (token: string, allocationId: string, epoch = 1, orgId = e.a.orgId) => ({ token, orgId, allocationId, epoch });
const denials = (allocationId: string) => e.q<{ code: string; action: string }>(e.a, "SELECT details_ref->>'code' AS code, action FROM factory.audit_event WHERE resource_id = $1 AND outcome = 'denied' ORDER BY created_at", [allocationId]);
// A started allocation with a workspace whose pod has finished its init step (or not).
async function started(inst: Instance, o: { receipt?: boolean; workspace?: boolean } = {}) {
  const s = await e.newStage(e.a);
  const ws = o.workspace === false ? undefined : await e.newWorkspace(e.a, s, inst);
  await start(inst, s, ws);
  const a = await alloc(s);
  const pod = inst.kube.driver.podsOf(a.jobName)[0] as NonNullable<ReturnType<typeof inst.kube.driver.podsOf>[number]>;
  if (o.receipt !== false) { if (ws) inst.kube.driver.initFinished(pod.metadata.name, { exitCode: 0, message: e.receiptMessage() }); else inst.kube.driver.startPod(pod.metadata.name); }
  return { s, ws, a, pod, token: inst.kube.mintToken(pod, tokenAudience(e.a.orgId, a.id)) };
}

describe('W-017 permits', () => {
  it('before the database: another audience, an expired or forged token, a review that is true with empty audiences, a wrong subject and an oversized token are each refused with no row written anywhere, and the counter moves', async () => {
    const inst = e.newRunner();
    const x = await started(inst);
    const other = await started(inst);
    const snapshot = async () => JSON.stringify([await e.tables(e.a), await e.tables(e.b), await e.auditCount(e.a, 'true'), await e.auditCount(e.b, 'true')]);
    const before = await snapshot();
    const aud = tokenAudience(e.a.orgId, x.a.id);
    // another audience: a token minted for the other allocation, presented for this one
    expect(await inst.runner.acquireStartPermit(req(other.token, x.a.id))).toMatchObject({ granted: false, code: 'unauthenticated', reason: 'local_audience_mismatch' });
    // expired, and forged (a payload edited after signing)
    expect(await inst.runner.acquireStartPermit(req(inst.kube.mintToken(x.pod, aud, { expiresInSeconds: -120 }), x.a.id))).toMatchObject({ reason: 'local_expired' });
    const [h, p, sig] = inst.kube.mintToken(x.pod, aud).split('.') as [string, string, string];
    const edited = Buffer.from(JSON.stringify({ ...(JSON.parse(Buffer.from(p, 'base64url').toString()) as object), sub: 'system:serviceaccount:kube-system:admin' })).toString('base64url');
    expect(await inst.runner.acquireStartPermit(req(`${h}.${edited}.${sig}`, x.a.id))).toMatchObject({ reason: 'local_bad_signature' });
    // empty audiences in a "true" review (the token itself is genuine, so the review is reached)
    inst.kube.reviewIgnoresAudiences = true;
    expect(await inst.runner.acquireStartPermit(req(x.token, x.a.id))).toMatchObject({ granted: false, code: 'unauthenticated', reason: 'audience_missing' });
    inst.kube.reviewIgnoresAudiences = false;
    // a wrong subject (another service account)
    expect(await inst.runner.acquireStartPermit(req(inst.kube.mintToken(x.pod, aud, { serviceAccount: 'someone-else' }), x.a.id))).toMatchObject({ reason: 'local_wrong_subject' });
    // oversized, unknown, empty tokens and bad ids or epochs
    expect(await inst.runner.acquireStartPermit(req('t'.repeat(8193), x.a.id))).toMatchObject({ granted: false, code: 'invalid_request' });
    expect(await inst.runner.acquireStartPermit(req('', x.a.id))).toMatchObject({ code: 'invalid_request' });
    expect(await inst.runner.acquireStartPermit(req('nonsense', x.a.id))).toMatchObject({ code: 'unauthenticated', reason: 'local_malformed_token' });
    expect(await inst.runner.acquireStartPermit({ ...req(x.token, x.a.id), epoch: 0 })).toMatchObject({ code: 'invalid_request' });
    expect(await inst.runner.acquireStartPermit({ ...req(x.token, 'not-a-uuid') })).toMatchObject({ code: 'invalid_request' });
    expect(await snapshot()).toBe(before); // nothing written, in either organization
    expect(inst.runner.permitRefusals()).toMatchObject({ local_audience_mismatch: 1, local_expired: 1, local_bad_signature: 1, audience_missing: 1, local_wrong_subject: 1, token_size: 2, local_malformed_token: 1 });
    // Control: the right token is granted and does write. (x.token itself failed the review above and is remembered as failed for 10 s.)
    expect(await inst.runner.acquireStartPermit(req(x.token, x.a.id))).toMatchObject({ code: 'unauthenticated', reason: 'recently_failed' });
    expect(await inst.runner.acquireStartPermit(req(inst.kube.mintToken(x.pod, aud), x.a.id))).toMatchObject({ granted: true });
    expect(await snapshot()).not.toBe(before);
  });

  it('a token that failed for one allocation is not refused for the allocation it is for (the memory is keyed by token and audience)', async () => {
    const inst = e.newRunner();
    const x = await started(inst);
    const y = await started(inst);
    expect(await inst.runner.acquireStartPermit(req(x.token, y.a.id))).toMatchObject({ code: 'unauthenticated', reason: 'local_audience_mismatch' });
    expect(await inst.runner.acquireStartPermit(req(x.token, y.a.id))).toMatchObject({ code: 'unauthenticated', reason: 'recently_failed' }); // the same pair is remembered
    expect(await inst.runner.acquireStartPermit(req(x.token, x.a.id))).toMatchObject({ granted: true }); // the other audience is not
  });

  it('a flood of unique junk tokens does not spend the review budget: a real renewal still goes through, and the cluster saw no review for the junk', async () => {
    const now = 0;
    const inst = e.newRunner({ nowMs: () => now, config: { review: { perSecond: 20, burst: 40 } } });
    const x = await started(inst);
    await inst.runner.acquireStartPermit(req(x.token, x.a.id));
    const reviews = () => inst.kube.calls.filter((c) => c.startsWith('reviewToken')).length;
    const before = reviews();
    const [h, p] = inst.kube.mintToken(x.pod, tokenAudience(e.a.orgId, x.a.id)).split('.') as [string, string, string];
    for (let i = 0; i < 2000; i += 1) {
      const junk = i % 2 === 0 ? `junk-${String(i)}-${randomUUID()}` : `${h}.${p}.${Buffer.from(randomUUID()).toString('base64url')}`; // random text; a real header and payload with a made-up signature
      expect(await inst.runner.acquireStartPermit(req(junk, x.a.id))).toMatchObject({ granted: false, code: 'unauthenticated' });
    }
    expect(reviews()).toBe(before); // not one of them reached the cluster
    expect(inst.runner.permitRefusals()['throttled'] ?? 0).toBe(0);
    expect(await inst.runner.renewPermit(req(inst.kube.mintToken(x.pod, tokenAudience(e.a.orgId, x.a.id)), x.a.id))).toMatchObject({ granted: true });
    expect(reviews()).toBe(before + 1);
    expect(inst.kube.jwksCalls).toBeLessThanOrEqual(2); // the signing keys are cached, and an unknown key id refetches at most once per 30 s
  });

  it('a per-source cap hook refuses before any budget is spent', async () => {
    const inst = e.newRunner();
    const x = await started(inst);
    inst.deps.admitSource = (src) => src !== 'noisy';
    expect(await inst.runner.acquireStartPermit({ ...req(x.token, x.a.id), source: 'noisy' })).toMatchObject({ code: 'throttled', reason: 'source_capped' });
    expect(inst.kube.calls.filter((c) => c.startsWith('reviewToken'))).toHaveLength(0);
    expect(await inst.runner.acquireStartPermit({ ...req(x.token, x.a.id), source: 'quiet' })).toMatchObject({ granted: true });
  });

  it('the 41st review in a burst is throttled with no review; a token that failed is not reviewed again within 10 s', async () => {
    let now = 0;
    const inst = e.newRunner({ nowMs: () => now, config: { review: { perSecond: 20, burst: 40 } } });
    const x = await started(inst);
    const y = await started(inst, { workspace: false });
    const aud = tokenAudience(e.a.orgId, x.a.id);
    // Tokens that verify locally but that the cluster refuses (their pod is gone): these are the ones that spend the budget.
    const stale = Array.from({ length: 41 }, () => inst.kube.mintToken(y.pod, aud));
    inst.kube.driver.removePod(y.pod.metadata.name);
    const reviews = () => inst.kube.calls.filter((c) => c.startsWith('reviewToken')).length;
    const results = [];
    for (const t of stale) results.push(await inst.runner.acquireStartPermit(req(t, x.a.id)));
    expect(results.slice(0, 40).every((r) => !r.granted && (r as { code: string }).code === 'unauthenticated')).toBe(true);
    expect(results[40]).toMatchObject({ granted: false, code: 'throttled', retryable: true });
    expect(reviews()).toBe(40); // the 41st was never reviewed
    now += 1000; // 20 tokens come back
    expect(await inst.runner.acquireStartPermit(req(stale[0] as string, x.a.id))).toMatchObject({ code: 'unauthenticated', reason: 'recently_failed' });
    expect(reviews()).toBe(40); // remembered by token and audience
    now += 10_000;
    expect(await inst.runner.acquireStartPermit(req(stale[0] as string, x.a.id))).toMatchObject({ code: 'unauthenticated', reason: 'not_authenticated' });
    expect(reviews()).toBe(41); // and reviewed again after 10 s
    // A success is never remembered or cached: the good token is reviewed every time.
    const before = reviews();
    const good = inst.kube.mintToken(x.pod, aud);
    expect(await inst.runner.acquireStartPermit(req(good, x.a.id))).toMatchObject({ granted: true });
    expect(await inst.runner.acquireStartPermit(req(good, x.a.id))).toMatchObject({ granted: true }); // a retry by the holder
    expect(reviews()).toBe(before + 2);
  });

  it('after a good review each failure is its own audited denial: another Job\'s pod, a pod being deleted, a stale epoch, an init step still running, a terminated allocation', async () => {
    const inst = e.newRunner();
    const x = await started(inst);
    const y = await started(inst);
    // a pod of another Job, with a token that names this allocation
    const foreignToken = inst.kube.mintToken(y.pod, tokenAudience(e.a.orgId, x.a.id));
    expect(await inst.runner.acquireStartPermit(req(foreignToken, x.a.id))).toMatchObject({ code: 'not_this_job' });
    // a pod with a deletion timestamp
    inst.kube.driver.pod(x.pod.metadata.name).metadata.deletionTimestamp = inst.kube.now();
    expect(await inst.runner.acquireStartPermit(req(x.token, x.a.id))).toMatchObject({ code: 'not_this_job' });
    delete inst.kube.driver.pod(x.pod.metadata.name).metadata.deletionTimestamp;
    // a stale epoch
    expect(await inst.runner.acquireStartPermit(req(x.token, x.a.id, 2))).toMatchObject({ code: 'stale_epoch' });
    // an init step still running
    const z = await started(inst, { receipt: false });
    expect(await inst.runner.acquireStartPermit(req(z.token, z.a.id))).toMatchObject({ code: 'not_ready', retryable: true });
    // a refusal as the init step's answer
    const w = await started(inst, { receipt: false });
    inst.kube.driver.initFinished(w.pod.metadata.name, { exitCode: 1 });
    expect(await inst.runner.acquireStartPermit(req(w.token, w.a.id))).toMatchObject({ code: 'no_receipt' });
    // a terminated allocation
    await e.db.withTenant({ orgId: e.a.orgId }, (tx) => tx.query("UPDATE factory.execution_allocation SET state = 'terminated', terminated_at = now() WHERE id = $1", [y.a.id]));
    expect(await inst.runner.acquireStartPermit(req(y.token, y.a.id))).toMatchObject({ code: 'not_startable' });
    expect((await denials(x.a.id)).map((d) => d.code)).toEqual(['not_this_job', 'not_this_job', 'stale_epoch']);
    expect((await denials(z.a.id)).map((d) => d.code)).toEqual(['not_ready']);
    expect((await denials(w.a.id)).map((d) => d.code)).toEqual(['no_receipt']);
    expect((await denials(y.a.id)).map((d) => d.code)).toEqual(['not_startable']);
    // Control: x's own pod, its own token, the right epoch, an accepted receipt.
    expect(await inst.runner.acquireStartPermit(req(x.token, x.a.id))).toMatchObject({ granted: true, leaseSeconds: 60, beatSeconds: 10 });
    expect(await e.workspace(e.a, x.ws as string)).toMatchObject({ state: 'active', ownerPodUid: x.pod.metadata.uid });
  });

  it('renewal: another pod\'s UID in the request body renews this pod only; a forged request with no valid token is refused', async () => {
    const inst = e.newRunner();
    const x = await started(inst);
    await inst.runner.acquireStartPermit(req(x.token, x.a.id));
    await e.backdate(e.a, x.a.id, { heartbeatSecondsAgo: 20 });
    const forged = { ...req(x.token, x.a.id), podUid: 'someone-elses-uid', podName: 'someone-else' };
    expect(await inst.runner.renewPermit(forged)).toMatchObject({ granted: true, podUid: x.pod.metadata.uid });
    expect((await e.allocation(e.a, x.a.id)).heartbeatAgeMs).toBeLessThan(5000);
    // the harness's request: the same body, no valid token
    expect(await inst.runner.renewPermit({ ...forged, token: 'forged' })).toMatchObject({ granted: false, code: 'unauthenticated' });
    // another pod's token for this allocation is not the writer
    const y = await started(inst, { workspace: false });
    const wrong = inst.kube.mintToken(y.pod, tokenAudience(e.a.orgId, x.a.id));
    expect(await inst.runner.renewPermit(req(wrong, x.a.id))).toMatchObject({ granted: false, code: 'not_this_job' });
  });

  it('renewal with a token the cluster still reviews as valid, for a pod that has been deleted, is refused; the same token worked before', async () => {
    const inst = e.newRunner();
    const x = await started(inst);
    await inst.runner.acquireStartPermit(req(x.token, x.a.id));
    expect(await inst.runner.renewPermit(req(x.token, x.a.id))).toMatchObject({ granted: true });
    inst.kube.driver.removePod(x.pod.metadata.name);
    expect((await inst.kube.reviewToken(x.token, [tokenAudience(e.a.orgId, x.a.id)])).authenticated).toBe(true); // the review still passes...
    expect(await inst.runner.renewPermit(req(x.token, x.a.id))).toMatchObject({ granted: false, code: 'not_this_job' }); // ...and the permit does not
    inst.kube.driver.advance(REVIEW_MEMORY_MS + 1);
    expect(await inst.runner.renewPermit(req(x.token, x.a.id))).toMatchObject({ granted: false, code: 'unauthenticated' });
  });

  it('renewal after the lease has expired, and after a cancel, is refused (stopping is how the supervisor learns of it)', async () => {
    const inst = e.newRunner();
    const x = await started(inst);
    await inst.runner.acquireStartPermit(req(x.token, x.a.id));
    await e.backdate(e.a, x.a.id, { leaseUntilSecondsAgo: 1 });
    expect(await inst.runner.renewPermit(req(x.token, x.a.id))).toMatchObject({ granted: false, code: 'not_renewable', reason: 'lease_expired' });
    const y = await started(inst);
    await inst.runner.acquireStartPermit(req(y.token, y.a.id));
    await e.db.withTenant({ orgId: e.a.orgId }, (tx) => tx.query("UPDATE factory.execution_allocation SET state = 'stopping' WHERE id = $1", [y.a.id])); // a cancel, with the pod still there
    expect(await inst.runner.renewPermit(req(y.token, y.a.id))).toMatchObject({ granted: false, code: 'not_renewable', reason: 'stopping' });
    const c = await started(inst);
    await inst.runner.acquireStartPermit(req(c.token, c.a.id));
    await inst.runner.cancel(e.ctx(e.a), c.s.logicalId, randomUUID(), 'stop'); // and with the pod gone as well
    expect(await inst.runner.renewPermit(req(c.token, c.a.id))).toMatchObject({ granted: false });
    // Control: a live lease renews.
    const z = await started(inst);
    await inst.runner.acquireStartPermit(req(z.token, z.a.id));
    expect(await inst.runner.renewPermit(req(z.token, z.a.id))).toMatchObject({ granted: true });
  });

  it('a crash at after_permit_claim is completed by the same pod\'s retry; another pod meanwhile is a duplicate_writer', async () => {
    const inst = e.newRunner();
    const x = await started(inst);
    inst.faults.throwAt('runner.after_permit_claim');
    await expect(inst.runner.acquireStartPermit(req(x.token, x.a.id))).rejects.toBeInstanceOf(InjectedFault);
    expect(await e.allocation(e.a, x.a.id)).toMatchObject({ state: 'starting', podUid: x.pod.metadata.uid });
    const dup = inst.kube.driver.addDuplicatePod(x.a.jobName);
    inst.kube.driver.initFinished(dup.metadata.name, { exitCode: 0, message: e.receiptMessage() });
    expect(await inst.runner.acquireStartPermit(req(inst.kube.mintToken(dup, tokenAudience(e.a.orgId, x.a.id)), x.a.id))).toMatchObject({ code: 'duplicate_writer' });
    expect(await inst.runner.acquireStartPermit(req(x.token, x.a.id))).toMatchObject({ granted: true });
  });

  it('crash and retry at after_writer_started: the workspace is active under a starting allocation, a pass leaves it, and the same pod\'s retry is granted; with another pod as owner the pass stops it', async () => {
    const inst = e.newRunner();
    const x = await started(inst);
    inst.faults.throwAt('runner.after_writer_started');
    await expect(inst.runner.acquireStartPermit(req(x.token, x.a.id))).rejects.toBeInstanceOf(InjectedFault);
    expect(await e.workspace(e.a, x.ws as string)).toMatchObject({ state: 'active' });
    expect((await e.allocation(e.a, x.a.id)).state).toBe('starting');
    await inst.runner.reconcileOne(e.a.orgId, x.a.id);
    expect((await e.allocation(e.a, x.a.id)).state).toBe('starting'); // the permit between its steps is accepted
    expect(await inst.runner.acquireStartPermit(req(x.token, x.a.id))).toMatchObject({ granted: true });
    // Control: the same state with another pod as the workspace's owner is not accepted.
    const y = await started(inst);
    inst.faults.throwAt('runner.after_writer_started');
    await expect(inst.runner.acquireStartPermit(req(y.token, y.a.id))).rejects.toBeInstanceOf(InjectedFault);
    await e.db.withTenant({ orgId: e.a.orgId }, (tx) => tx.query("UPDATE factory.workspace SET owner_pod_uid = 'another-pod' WHERE id = $1", [y.ws]));
    await inst.runner.reconcileOne(e.a.orgId, y.a.id);
    expect((await e.allocation(e.a, y.a.id)).state).not.toBe('starting');
  });

  it('a stop that lands before markWriterStarted: the allocation is terminated while the workspace is still allocated, then the writer lands; the permit settles the workspace (retained, never quiescing or active)', async () => {
    const inst = e.newRunner();
    const x = await started(inst);
    const hold = inst.faults.holdAt('runner.before_writer_started');
    const permit = inst.runner.acquireStartPermit(req(x.token, x.a.id));
    await hold.reached;
    expect((await e.allocation(e.a, x.a.id)).podUid).toBe(x.pod.metadata.uid);
    await inst.runner.cancel(e.ctx(e.a), x.s.logicalId, randomUUID(), 'stop');
    expect((await e.allocation(e.a, x.a.id)).state).toBe('terminated'); // proved while the workspace was still `allocated`
    expect((await e.workspace(e.a, x.ws as string)).state).toBe('allocated');
    hold.release();
    expect(await permit).toMatchObject({ granted: false, code: 'not_startable' });
    expect(await e.workspace(e.a, x.ws as string)).toMatchObject({ state: 'retained', ownerPodUid: x.pod.metadata.uid });
  });

  it('with the permit killed after markWriterStarted landed under a terminated allocation, the release facade settles the workspace before it delegates', async () => {
    const inst = e.newRunner();
    const x = await started(inst);
    const hold = inst.faults.holdAt('runner.before_writer_started', {});
    const permit = inst.runner.acquireStartPermit(req(x.token, x.a.id));
    await hold.reached;
    await inst.runner.cancel(e.ctx(e.a), x.s.logicalId, randomUUID(), 'stop');
    inst.faults.throwAt('runner.after_writer_started');
    hold.release();
    await expect(permit).rejects.toBeInstanceOf(InjectedFault); // the permit dies with the writer started
    expect(await e.workspace(e.a, x.ws as string)).toMatchObject({ state: 'active' }); // active under a terminated allocation
    await expect(inst.runner.releaseWorkspace(e.ctx(e.a), x.ws as string, 1)).rejects.toMatchObject({ code: 'checkpoint_not_accepted' }); // settled, then W-018's rule
    expect((await e.workspace(e.a, x.ws as string)).state).toBe('retained');
  });

  it('terminated is refused while the workspace is active or quiescing for this pod, and goes through once it is settled', async () => {
    const inst = e.newRunner();
    const x = await started(inst);
    expect(await inst.runner.acquireStartPermit(req(x.token, x.a.id))).toMatchObject({ granted: true });
    await e.db.withTenant({ orgId: e.a.orgId }, (tx) => tx.query("UPDATE factory.execution_allocation SET state = 'stopping' WHERE id = $1", [x.a.id]));
    const stopping = await e.allocation(e.a, x.a.id);
    expect(await terminateTx(inst.deps, stopping)).toBe('needs_settle'); // active
    expect((await e.allocation(e.a, x.a.id)).state).toBe('stopping');
    await inst.workspaces.markWriterQuiescing(e.runnerCtx(e.a), x.ws as string, 1, x.pod.metadata.uid);
    expect(await terminateTx(inst.deps, stopping)).toBe('needs_settle'); // quiescing
    await inst.workspaces.markWriterStopped(e.runnerCtx(e.a), x.ws as string, 1, x.pod.metadata.uid);
    expect(await terminateTx(inst.deps, stopping)).toBe('terminated'); // retained
    expect((await e.allocation(e.a, x.a.id)).state).toBe('terminated');
    await until('nothing left waiting', async () => (await e.waiters()) === 0);
  });

  it('a real interleaving: the writer lands right after the pass has looked at the workspace; terminated is refused, the pass settles it and tries again, and the workspace ends retained', async () => {
    const inst = e.newRunner();
    const x = await started(inst);
    const hold = inst.faults.holdAt('runner.before_writer_started'); // the permit has claimed pod_uid; markWriterStarted has not run
    const permit = inst.runner.acquireStartPermit(req(x.token, x.a.id));
    await hold.reached;
    // The runner's database, wrapped: on the stop pass's second look at the workspace (the one made for the proof) the
    // permit's markWriterStarted lands right after the row is read, so the pass holds an `allocated` row that is already stale.
    const real = inst.deps.db;
    let looks = 0; let landed = false;
    inst.deps.db = Object.create(real, { withTenant: { value: async (c: { orgId: string }, fn: never) => {
      const r = await real.withTenant<{ id?: string; state?: string } | undefined>(c, fn);
      if (!landed && r !== undefined && r.id === x.ws && r.state === 'allocated') {
        looks += 1;
        if (looks === 2) { landed = true; await inst.workspaces.markWriterStarted(e.runnerCtx(e.a), x.ws as string, 1, x.pod.metadata.uid); }
      }
      return r;
    } } }) as Database;
    await inst.runner.cancel(e.ctx(e.a), x.s.logicalId, randomUUID(), 'stop');
    inst.deps.db = real;
    expect(landed).toBe(true);
    // Before the permit is released: the allocation is terminated only because the workspace was settled first.
    expect((await e.allocation(e.a, x.a.id)).state).toBe('terminated');
    expect(await e.workspace(e.a, x.ws as string)).toMatchObject({ state: 'retained', ownerPodUid: x.pod.metadata.uid });
    hold.release();
    expect(await permit).toMatchObject({ granted: false, code: 'not_startable' });
    expect((await e.workspace(e.a, x.ws as string)).state).toBe('retained');
  });
});
