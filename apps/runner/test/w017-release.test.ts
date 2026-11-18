// The release path (17b): cancel, wait for terminated, then release through the facade; PodVolumeMaterializer.remove deletes the
// PVC of the generation that holds the work, by its UID, and no row is released while a PVC with its label exists (D15).
import { randomUUID } from 'node:crypto';
import { transitionWorkspace } from '@factory/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pvcName } from '../src/index.ts';
import { createEnv, hex, type Env, type Instance, type Stage } from './harness.ts';
import { foreignPod } from './pods.ts';

let e: Env;
beforeAll(async () => { e = await createEnv('w017_release'); });
afterAll(async () => { await e.close(); });

// The pod-mode runner: the workspace manager's materializer is PodVolumeMaterializer, and nothing waits on a timer.
const podRunner = (): Instance & { pvcDeletes: Array<[string, string]> } => {
  const inst = e.newRunner({ pod: { settle: { timeoutMs: 100, pollMs: 10 }, wait: () => Promise.resolve() } });
  const pvcDeletes: Array<[string, string]> = [];
  const original = inst.kube.deletePvc.bind(inst.kube);
  inst.kube.deletePvc = (name, uid) => { pvcDeletes.push([name, uid]); return original(name, uid); };
  return Object.assign(inst, { pvcDeletes });
};
const start = (inst: Instance, s: Stage, workspaceId: string) => inst.runner.startOrAttach(e.ctx(e.a), e.input(e.a, s, { workspaceId }), hex('e'));
const cancel = (inst: Instance, s: Stage) => inst.runner.cancel(e.ctx(e.a), s.logicalId, randomUUID(), 'release test');
const release = (inst: Instance, ws: string, epoch = 1) => inst.runner.releaseWorkspace(e.ctx(e.a), ws, epoch);
const labelled = (inst: Instance, ws: string): string[] => [...inst.kube.pvcs.values()].filter((p) => p.metadata.labels['factory.local/workspace'] === ws).map((p) => p.metadata.name).sort();
const checkpoint = async (ws: string, epoch: number): Promise<void> => {
  const ref = await e.putArtifact(e.a, Buffer.from(`{"checkpoint":"${randomUUID()}"}`), 'checkpoint');
  await e.db.withTenant({ orgId: e.a.orgId }, (tx) => transitionWorkspace(tx, { orgId: e.a.orgId, id: ws, expectedEpoch: epoch, from: ['retained'], patch: { checkpointRef: ref } }));
};
const terminate = async (inst: Instance, id: string): Promise<void> => {
  await inst.runner.reconcileOne(e.a.orgId, id, 5000);
  const a = await e.allocation(e.a, id);
  if (a.state !== 'terminated') throw new Error(`expected terminated, got ${a.state}`);
};

describe('W-017 release through the facade', () => {
  it('(a) a writer on generation 1 is cancelled: quiescing refuses release; retained without a checkpoint is refused and the PVC stays; with the checkpoint seeded the PVC of generation 1 is deleted by its UID', async () => {
    const inst = podRunner();
    const s = await e.newStage(e.a);
    const run = await e.runningAllocation(e.a, s, inst, { withWorkspace: true });
    const ws = run.workspaceId as string;
    const pvc = inst.kube.pvcs.get(pvcName(e.a.orgId, ws, 1));
    expect(pvc).toBeDefined();
    inst.kube.delayDeletes = true; // the pod stays visible, Terminating, until the kubelet reaps it
    await cancel(inst, s);
    expect((await e.workspace(e.a, ws)).state).toBe('quiescing');
    await expect(release(inst, ws)).rejects.toMatchObject({ code: 'allocation_live', retryable: true }); // the facade, while the allocation is live
    await expect(inst.workspaces.release(e.runnerCtx(e.a), ws, 1)).rejects.toMatchObject({ code: 'writer_active' }); // W-018's own refusal
    expect(labelled(inst, ws)).toHaveLength(1);
    inst.kube.driver.finishDeletes();
    await terminate(inst, run.allocationId);
    expect((await e.workspace(e.a, ws)).state).toBe('retained');
    await expect(release(inst, ws)).rejects.toMatchObject({ code: 'checkpoint_not_accepted' });
    expect(labelled(inst, ws)).toHaveLength(1); // the work survives
    expect(inst.pvcDeletes).toHaveLength(0);
    await checkpoint(ws, 1);
    expect(await release(inst, ws)).toEqual({ state: 'released' });
    expect(inst.pvcDeletes).toEqual([[pvcName(e.a.orgId, ws, 1), pvc?.metadata.uid]]); // by its UID
    expect(labelled(inst, ws)).toEqual([]);
    expect((await e.workspace(e.a, ws)).state).toBe('released');
    expect(await release(inst, ws)).toEqual({ state: 'released' }); // a repeat is a no-op
  });

  it('(b) generation 1 is lost and replaced; generation 2\'s writer is cancelled and released: the first PVC deleted is generation 2\'s, the row stays releasing with needsOperator while generation 1\'s exists, and becomes released once it is removed', async () => {
    const inst = podRunner();
    const s = await e.newStage(e.a);
    const g1 = await e.runningAllocation(e.a, s, inst, { withWorkspace: true });
    const ws = g1.workspaceId as string;
    inst.kube.driver.losePod(g1.podName); // generation 1 is lost
    await terminate(inst, g1.allocationId);
    expect(await start(inst, s, ws)).toMatchObject({ generation: 2, epoch: 2 }); // replaced: a new PVC
    const g2 = (await e.allocations(e.a, s))[1] as NonNullable<Awaited<ReturnType<typeof e.allocations>>[number]>;
    const pod = inst.kube.driver.podsOf(g2.jobName)[0] as NonNullable<ReturnType<typeof inst.kube.driver.podsOf>[number]>;
    inst.kube.driver.initFinished(pod.metadata.name, { exitCode: 0, message: e.receiptMessage(2) });
    const granted = await inst.runner.acquireStartPermit({ token: inst.kube.mintToken(pod, `factory-allocation:${e.a.orgId}:${g2.id}`), orgId: e.a.orgId, allocationId: g2.id, epoch: 2 });
    expect(granted).toMatchObject({ granted: true });
    const two = [...labelled(inst, ws)];
    expect(two).toEqual([pvcName(e.a.orgId, ws, 1), pvcName(e.a.orgId, ws, 2)].sort());
    await cancel(inst, s);
    await terminate(inst, g2.id);
    expect((await e.workspace(e.a, ws)).state).toBe('retained');
    await checkpoint(ws, 2);
    const uid2 = inst.kube.pvcs.get(pvcName(e.a.orgId, ws, 2))?.metadata.uid;
    expect(await release(inst, ws, 2)).toEqual({ state: 'releasing', needsOperator: true });
    expect(inst.pvcDeletes[0]).toEqual([pvcName(e.a.orgId, ws, 2), uid2]); // the first one deleted is the one with the work
    expect(labelled(inst, ws)).toEqual([pvcName(e.a.orgId, ws, 1)]);
    expect(await release(inst, ws, 2)).toEqual({ state: 'releasing', needsOperator: true }); // still: no row is released while a PVC with its label exists
    expect((await e.workspace(e.a, ws)).state).toBe('releasing');
    // An operator (W-024 later) removes the older generation's claim; the retry then reaches released with none left.
    const old = inst.kube.pvcs.get(pvcName(e.a.orgId, ws, 1));
    await inst.kube.deletePvc(pvcName(e.a.orgId, ws, 1), old?.metadata.uid as string);
    expect(await release(inst, ws, 2)).toEqual({ state: 'released' });
    expect(labelled(inst, ws)).toEqual([]);
  });

  it('(c) no proof: the allocation is quarantined, the workspace stays quiescing, release is refused, and both objects are untouched', async () => {
    const inst = podRunner();
    const s = await e.newStage(e.a);
    const run = await e.runningAllocation(e.a, s, inst, { withWorkspace: true });
    const ws = run.workspaceId as string;
    inst.kube.driver.losePod(run.podName);
    foreignPod(inst.kube, run.allocationId, { name: 'imposter-release', owner: { kind: 'Job', name: 'someone-elses', uid: 'u-other' } }); // keeps the proof open
    await inst.runner.reconcileOne(e.a.orgId, run.allocationId, 5000);
    await e.backdate(e.a, run.allocationId, { leaseUntilSecondsAgo: 1 });
    await inst.runner.reconcileOne(e.a.orgId, run.allocationId, 5000);
    expect((await e.allocation(e.a, run.allocationId)).state).toBe('quarantined');
    expect((await e.workspace(e.a, ws)).state).toBe('quiescing');
    const before = { kube: inst.kube.snapshot(), ws: await e.workspace(e.a, ws) };
    await expect(release(inst, ws)).rejects.toMatchObject({ code: 'allocation_quarantined', retryable: true });
    await expect(inst.workspaces.release(e.runnerCtx(e.a), ws, 1)).rejects.toMatchObject({ code: 'writer_active' }); // W-018 refuses it too
    expect(inst.kube.snapshot()).toBe(before.kube); // the PVC and the foreign pod are untouched
    expect(await e.workspace(e.a, ws)).toEqual(before.ws);
    expect(inst.pvcDeletes).toHaveLength(0);
  });

  it('(c2) quarantined before any permit: the workspace is still allocated, but release is refused and its PVC is untouched; control: a terminated allocation releases', async () => {
    const inst = podRunner();
    const s = await e.newStage(e.a);
    const ws = await e.newWorkspace(e.a, s, inst);
    await start(inst, s, ws);
    const a = (await e.allocations(e.a, s))[0] as NonNullable<Awaited<ReturnType<typeof e.allocations>>[number]>;
    foreignPod(inst.kube, a.id, { name: 'imposter-c2', owner: { kind: 'Job', name: 'someone-elses', uid: 'u-other' } }); // keeps the proof open
    await cancel(inst, s);
    await e.backdate(e.a, a.id, { leaseUntilSecondsAgo: 1 });
    await inst.runner.reconcileOne(e.a.orgId, a.id, 5000);
    expect((await e.allocation(e.a, a.id)).state).toBe('quarantined');
    expect((await e.workspace(e.a, ws)).state).toBe('allocated'); // no writer ever started
    const before = inst.kube.snapshot();
    await expect(release(inst, ws)).rejects.toMatchObject({ code: 'allocation_quarantined' });
    expect(inst.kube.snapshot()).toBe(before);
    expect(inst.pvcDeletes).toHaveLength(0);
    expect((await e.workspace(e.a, ws)).state).toBe('allocated');
  });

  it('(d) cancelled before any permit: the workspace is still allocated and release deletes generation 1\'s PVC', async () => {
    const inst = podRunner();
    const s = await e.newStage(e.a);
    const ws = await e.newWorkspace(e.a, s, inst);
    await start(inst, s, ws);
    const a = (await e.allocations(e.a, s))[0] as NonNullable<Awaited<ReturnType<typeof e.allocations>>[number]>;
    expect(labelled(inst, ws)).toEqual([pvcName(e.a.orgId, ws, 1)]);
    await expect(release(inst, ws)).rejects.toMatchObject({ code: 'allocation_live' }); // control: while the allocation lives, the facade refuses
    expect(labelled(inst, ws)).toHaveLength(1);
    await cancel(inst, s);
    await terminate(inst, a.id);
    expect((await e.workspace(e.a, ws)).state).toBe('allocated'); // no writer ever started
    expect(await release(inst, ws)).toEqual({ state: 'released' });
    expect(labelled(inst, ws)).toEqual([]);
    expect(inst.pvcDeletes).toHaveLength(1);
  });

  it('(e) a release that races a start: the facade answers allocation_live; W-018\'s release called directly moves the row to releasing and remove answers absent:false; the allocation stops, and only then does a retry reach released with no PVC left', async () => {
    const inst = podRunner();
    const s = await e.newStage(e.a);
    const ws = await e.newWorkspace(e.a, s, inst);
    await start(inst, s, ws);
    const a = (await e.allocations(e.a, s))[0] as NonNullable<Awaited<ReturnType<typeof e.allocations>>[number]>;
    await expect(release(inst, ws)).rejects.toMatchObject({ code: 'allocation_live', retryable: true });
    expect((await e.workspace(e.a, ws)).state).toBe('allocated'); // the facade changed nothing
    // The race: W-018's release is called directly while the allocation is live.
    expect(await inst.workspaces.release(e.runnerCtx(e.a), ws, 1)).toEqual({ state: 'releasing', needsOperator: true });
    expect(inst.pvcDeletes).toHaveLength(0); // remove answered absent:false before it deleted anything
    expect(labelled(inst, ws)).toHaveLength(1);
    // The allocation can only stop now: the workspace is no longer allocated.
    await inst.runner.reconcileOne(e.a.orgId, a.id, 5000);
    expect((await e.allocation(e.a, a.id)).state).toBe('terminated');
    expect(await release(inst, ws)).toEqual({ state: 'released' });
    expect(labelled(inst, ws)).toEqual([]);
    expect(inst.pvcDeletes).toHaveLength(1);
    // A new allocation of a released workspace is refused (control that the row is closed).
    const s2 = await e.newStage(e.a);
    await expect(start(inst, s2, ws)).rejects.toBeDefined();
  });

  it('the release facade is task-scoped and limited to the configured callers, and refuses an unknown workspace', async () => {
    const inst = podRunner();
    const s = await e.newStage(e.a);
    const ws = await e.newWorkspace(e.a, s, inst);
    await expect(inst.runner.releaseWorkspace(e.ctx(e.a, { actorId: 'service:stranger' }), ws, 1)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(inst.runner.releaseWorkspace(e.ctx(e.a, { taskId: randomUUID() }), ws, 1)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(release(inst, randomUUID())).rejects.toMatchObject({ code: 'not_found' });
    expect(await release(inst, ws)).toEqual({ state: 'released' }); // control: the right caller and scope, no allocation, nothing to remove
  });
});
