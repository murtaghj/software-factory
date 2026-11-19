// AC-12, the quarantine half: a lease expires while the old process still runs. The old writer's pod-facing calls are refused and it stops itself; without a proof the generation is
// quarantined on record and the replacement is isolated; no volume is reused. The server half and the supervisor half are asserted apart.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { pvcName } from '@factory/runner';
import { rig, snapshotTree, until, type Rig } from './kit.ts';

let r: Rig | undefined;
afterEach(async () => { await r?.close(); r = undefined; });
const FAST = { leaseSeconds: 4, suspectSeconds: 2 }; // a 3 s fence, so that the resumed supervisor's local fence time has passed by the time the test looks
let pausedAt = 0;
const state = async (x: Rig, id: string) => (await x.e.allocation(x.e.a, id)).state;

async function writer(o: { held: boolean }) {
  r = await rig('w019_ac12', { config: FAST, ...(o.held ? {} : { graceMs: 400 }) });
  const run = await r.startRun();
  const pod = r.podsOf(run.jobName)[0] as NonNullable<ReturnType<Rig['podsOf']>[number]>;
  await until('the writer runs and its harness started', async () => (await state(r as Rig, run.allocationId)) === 'running' && r?.events(pod.metadata.name, 'launcher').some((x) => x['event'] === 'started') === true, 40_000);
  return { x: r, run, pod };
}
const stale = async (x: Rig, run: { allocationId: string }, pod: { metadata: { uid: string } }, held: boolean) => {
  x.kube.driver.pause(pod.metadata.uid, 'supervisor'); // a supervisor that stops answering: STOP, not a kill
  pausedAt = performance.now();
  await x.e.backdate(x.e.a, run.allocationId, { leaseUntilSecondsAgo: 1 });
  x.kube.delayDeletes = held; // the node does not hear of the delete yet: the pod is Terminating and its process is still alive
  await x.inst.runner.reconcileOne(x.e.a.orgId, run.allocationId);
  expect(await state(x, run.allocationId)).toBe('stopping');
};

describe('AC-12 a stale live writer', () => {
  it('the pass stops it, the delete is held (the process is alive), the stop deadline passes: quarantined with the record and the workspace quiescing, the claim untouched; a replacement gets generation 2, epoch 2, a new claim, a new directory and a new supervisor; the old one is refused (server half) and stops itself (supervisor half)', async () => {
    const { x, run, pod } = await writer({ held: true });
    const claim1 = pvcName(x.e.a.orgId, run.ws, 1);
    const claim1Uid = x.kube.pvcs.get(claim1)?.metadata.uid;
    const oldToken = readFileSync(x.kubelet.tokenFile(pod.metadata.uid) as string, 'utf8');
    await stale(x, run, pod, true);
    expect(x.kubelet.processOf(pod.metadata.uid, 'supervisor')?.alive()).toBe(true); // shown alive
    expect(x.kube.pods.has(pod.metadata.name)).toBe(true);
    await x.e.backdate(x.e.a, run.allocationId, { leaseUntilSecondsAgo: 1 }); // the stop deadline
    await x.inst.runner.reconcileOne(x.e.a.orgId, run.allocationId);
    expect(await state(x, run.allocationId)).toBe('quarantined');
    expect(await x.e.q(x.e.a, 'SELECT count(*)::int AS n FROM factory.artifact_link WHERE purpose = $1', [`quarantine_record/${run.allocationId}`])).toEqual([{ n: 1 }]);
    expect((await x.e.workspace(x.e.a, run.ws)).state).toBe('quiescing');
    expect(x.kube.pvcs.get(claim1)?.metadata.uid).toBe(claim1Uid); // the claim is untouched
    // the replacement: a new generation, a new claim, a new supervisor
    const callsBefore = x.kube.writes.length;
    await x.inst.runner.startOrAttach(x.e.ctx(x.e.a), x.e.input(x.e.a, run.s, { workspaceId: run.ws }), 'e'.repeat(64));
    const gen2 = (await x.e.allocations(x.e.a, run.s)).at(-1) as NonNullable<Awaited<ReturnType<typeof x.e.allocations>>[number]>;
    expect([gen2.generation, gen2.ownerEpoch]).toEqual([2, 2]);
    await until('generation 2 is running', async () => (await state(x, gen2.id)) === 'running', 40_000);
    const pod2 = x.podsOf(gen2.jobName)[0] as NonNullable<ReturnType<Rig['podsOf']>[number]>;
    expect(x.kube.pvcs.has(pvcName(x.e.a.orgId, run.ws, 2))).toBe(true);
    expect(x.claimDir(run.ws, 2)).not.toBe(x.claimDir(run.ws, 1)); // a new directory
    expect(JSON.stringify([...x.kube.jobs.values()])).not.toContain(claim1); // no manifest names generation 1's claim
    expect(x.kube.writes.slice(callsBefore).filter((w) => w.includes(claim1))).toEqual([]);
    const treeBefore = snapshotTree(x.claimDir(run.ws, 2));
    // ---- the server half: the test itself calls the renewal route with the old pod's token and epoch
    const rowBefore = await x.e.allocation(x.e.a, run.allocationId);
    const deniedBefore = await x.e.auditCount(x.e.a, "action = 'runner.permit.renew' AND outcome = 'denied' AND resource_id = $1", [run.allocationId]);
    const answer = await x.inst.runner.renewPermit({ token: oldToken, orgId: x.e.a.orgId, allocationId: run.allocationId, epoch: 1 });
    // With the delete held the old pod has a deletion timestamp, so the guard refuses at the POD READ (before the state or the epoch is looked at). That is what this tier shows;
    // the state and epoch refusals are 19a's pod-guard tests, and the publisher is W-018's own tests.
    expect(answer).toMatchObject({ granted: false, code: 'not_this_job', reason: 'pod' });
    const rowAfter = await x.e.allocation(x.e.a, run.allocationId);
    expect([rowAfter.state, rowAfter.leaseRemainingMs === null, rowAfter.heartbeatAgeMs !== null && rowAfter.heartbeatAgeMs >= (rowBefore.heartbeatAgeMs ?? 0)]).toEqual(['quarantined', rowBefore.leaseRemainingMs === null, true]); // no lease moved, no heartbeat
    expect(await x.e.auditCount(x.e.a, "action = 'runner.permit.renew' AND outcome = 'denied' AND resource_id = $1", [run.allocationId])).toBe(deniedBefore + 1); // only the denial's audit row
    // W-018's fence: a call at epoch 1 is stale_epoch
    await expect(x.inst.workspaces.markWriterStopped(x.e.runnerCtx(x.e.a), run.ws, 1, pod.metadata.uid)).rejects.toMatchObject({ code: 'stale_epoch' });
    // ---- the supervisor half: resumed after its local fence time, it exits 70 and makes no further call
    const mark = x.calls.length;
    // Its local fence time (3 s after its last grant was sent) must have passed: the only real wait of this file.
    await new Promise((res) => setTimeout(res, Math.max(0, 4000 - (performance.now() - pausedAt))));
    x.kube.driver.resume(pod.metadata.uid, 'supervisor');
    const proc = x.kubelet.procs.find((q) => q.podUid === pod.metadata.uid && q.container === 'supervisor');
    await until('the old supervisor fenced itself and exited', () => proc?.done === true, 20_000);
    expect(proc?.child.exitCode).toBe(70);
    // The call that was in flight when it was stopped may have been answered in the meantime; after the resume it made no call at all.
    const podTokens = new Set([oldToken, readFileSync(x.kubelet.tokenFile(pod.metadata.uid) as string, 'utf8')]); // every token that pod holds, not only the first
    expect(x.calls.slice(mark).filter((c) => podTokens.has(c.token))).toEqual([]); // the listener saw nothing from that pod after the resume
    expect(x.events(pod.metadata.name, 'supervisor').find((e) => e['event'] === 'fenced')).toBeDefined();
    await until('its launcher was told to stop', () => x.events(pod.metadata.name, 'launcher').some((e) => e['event'] === 'stopping'), 15_000);
    expect(snapshotTree(x.claimDir(run.ws, 2))).toBe(treeBefore); // generation 2's tree is unchanged throughout
    expect(x.kube.pods.get(pod2.metadata.name)).toBeDefined(); // and the replacement still runs
  }, 150_000);

  it('control: the same sequence with the delete not held ends terminated with a proof and no quarantine record, and no manifest names generation 1\'s claim', async () => {
    const { x, run, pod } = await writer({ held: false });
    await stale(x, run, pod, false);
    await until('terminated', async () => { await x.inst.runner.reconcileOne(x.e.a.orgId, run.allocationId); return (await state(x, run.allocationId)) === 'terminated'; }, 30_000);
    expect(await x.e.q(x.e.a, 'SELECT count(*)::int AS n FROM factory.artifact_link WHERE purpose = $1', [`quiescence_proof/${run.allocationId}`])).toEqual([{ n: 1 }]);
    expect(await x.e.q(x.e.a, 'SELECT count(*)::int AS n FROM factory.artifact_link WHERE purpose = $1', [`quarantine_record/${run.allocationId}`])).toEqual([{ n: 0 }]);
    expect((await x.e.workspace(x.e.a, run.ws)).state).toBe('retained');
  }, 120_000);
});
