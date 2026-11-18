// The durable proof (W-019): stored before `terminated`, a one-way door, and three conditions beyond W-017's: the writer's node, an unlabelled pod on the claim, and the list's cap.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InjectedFault } from '@factory/test-support';
import { listLinksByPurpose } from '@factory/database';
import { quiescenceProof, volumeDisposition } from '@factory/workspace';
import { KubeError } from '../src/index.ts';
import { pvcName } from '../src/names.ts';
import { recordDeps, settleWorkspace, terminateTx } from '../src/testing.ts';
import { createEnv, type Env, type Instance, type Stage } from './harness.ts';
import { foreignPod } from './pods.ts';

let e: Env;
beforeAll(async () => { e = await createEnv('w019_proof', { config: { podRate: { burst: 1000, intervalMs: 1 } } }); });
afterAll(async () => { await e.close(); });

const cancel = (inst: Instance, s: Stage) => inst.runner.cancel(e.ctx(e.a), s.logicalId, randomUUID(), 'stop');
const links = (id: string) => e.db.withTenant({ orgId: e.a.orgId }, (tx) => listLinksByPurpose(tx, e.a.orgId, `quiescence_proof/${id}`));
const body = async (inst: Instance, id: string) => {
  const r = await quiescenceProof.readChecked(recordDeps(inst.deps), e.a.orgId, e.a.taskId, id);
  if (r.kind !== 'present') throw new Error('no proof');
  return r.body as Record<string, unknown> & { nodeCheck: string; writerPod: string; detachment: { method: string }; pods: Array<{ containers: unknown[] }>; observedAt: string };
};
async function run(inst: Instance, o: { workspace?: boolean } = {}) {
  const s = await e.newStage(e.a);
  const x = await e.runningAllocation(e.a, s, inst, { withWorkspace: o.workspace ?? true });
  return { s, x };
}
const state = async (id: string) => (await e.allocation(e.a, id)).state;
const pass = (inst: Instance, id: string) => inst.runner.reconcileOne(e.a.orgId, id).catch((err: unknown) => err);

describe('W-019 the quiescence proof', () => {
  it('after a cancel: one artifact with the pinned purpose and schema, the allocation terminated, the workspace retained; the observation time is earlier than the link', async () => {
    const inst = e.newRunner();
    const { s, x } = await run(inst);
    await cancel(inst, s);
    expect(await state(x.allocationId)).toBe('terminated');
    expect((await e.workspace(e.a, x.workspaceId as string)).state).toBe('retained');
    const l = await links(x.allocationId);
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ mediaType: 'application/json', producerId: 'runner:factory', classification: 'ordinary' });
    const b = await body(inst, x.allocationId);
    expect(b['schema']).toBe('factory-quiescence-proof/1');
    expect(b.detachment.method).toBe('no_consumer_pod');
    const linkAt = (await e.q<{ t: string }>(e.a, "SELECT to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS t FROM factory.artifact_link WHERE purpose = $1", [`quiescence_proof/${x.allocationId}`]))[0]?.t as string;
    expect(Date.parse(b.observedAt)).toBeLessThanOrEqual(Date.parse(linkAt));
  });

  it('order: A dies after the put, and again after the registration; B ends terminated using the link, and exactly one link exists; terminateTx and settle refuse without it', async () => {
    const inst = e.newRunner();
    const first = await run(inst);
    inst.faults.throwAt('runner.after_proof_put');
    await expect(cancel(inst, first.s)).resolves.toBeDefined(); // the cancel's own pass failure is reported, not thrown
    expect(await state(first.x.allocationId)).toBe('stopping');
    expect(await links(first.x.allocationId)).toHaveLength(0);
    const second = await run(inst);
    inst.faults.throwAt('runner.after_proof_registered');
    await cancel(inst, second.s);
    expect(await state(second.x.allocationId)).toBe('stopping');
    expect(await links(second.x.allocationId)).toHaveLength(1); // the proof was stored, `terminated` was not written
    // B, whichever it is, goes straight to settle and terminate with the stored link
    const b = e.newRunner({ kube: inst.kube, ownPool: true });
    await b.runner.reconcileOne(e.a.orgId, second.x.allocationId);
    expect(await state(second.x.allocationId)).toBe('terminated');
    expect(await links(second.x.allocationId)).toHaveLength(1);
    await b.runner.reconcileOne(e.a.orgId, first.x.allocationId);
    expect(await state(first.x.allocationId)).toBe('terminated');
    expect(await links(first.x.allocationId)).toHaveLength(1);
    // without the link: needs_proof, and the workspace is not marked stopped
    const third = await run(inst);
    await e.db.withTenant({ orgId: e.a.orgId }, (tx) => tx.query("UPDATE factory.execution_allocation SET state = 'stopping' WHERE id = $1", [third.x.allocationId]));
    const row = await e.allocation(e.a, third.x.allocationId);
    await settleWorkspace(inst.deps, row, 'proof');
    expect((await e.workspace(e.a, third.x.workspaceId as string)).state).toBe('quiescing'); // quiescing yes, stopped no
    expect(await terminateTx(inst.deps, row)).toBe('needs_settle');
    await inst.workspaces.markWriterStopped(e.runnerCtx(e.a), third.x.workspaceId as string, 1, third.x.podUid); // the manager alone would let it through
    expect(await terminateTx(inst.deps, row)).toBe('needs_proof');
    await e.storeProof(inst, e.a, row); // control
    expect(await terminateTx(inst.deps, row)).toBe('terminated');
  });

  it('one-way door: proof stored, then a foreign labelled pod appears; the allocation still terminates. Control: the same pod before the proof keeps it open and it is quarantined at the deadline', async () => {
    const inst = e.newRunner();
    const a = await run(inst);
    inst.faults.throwAt('runner.after_proof_registered');
    await cancel(inst, a.s);
    foreignPod(inst.kube, a.x.allocationId, { name: `late-${a.x.allocationId.slice(0, 6)}` });
    await pass(inst, a.x.allocationId);
    expect(await state(a.x.allocationId)).toBe('terminated');
    // control
    const b = await run(inst);
    foreignPod(inst.kube, b.x.allocationId, { name: `early-${b.x.allocationId.slice(0, 6)}`, owner: { kind: 'Job', name: 'not-ours', uid: 'u-x' } });
    await cancel(inst, b.s);
    expect(await state(b.x.allocationId)).toBe('stopping');
    await e.backdate(e.a, b.x.allocationId, { leaseUntilSecondsAgo: 1 });
    await pass(inst, b.x.allocationId);
    expect(await state(b.x.allocationId)).toBe('quarantined');
  });

  it('node: loseNode while the writer ran is not proved (writer_node_missing), then quarantined; control: the same stop with the node present is proved', async () => {
    const inst = e.newRunner({ config: { nodeCheck: 'required' } });
    const lost = await run(inst);
    inst.kube.driver.loseNode('fake-node-1');
    await cancel(inst, lost.s);
    expect(await state(lost.x.allocationId)).toBe('stopping');
    expect(await links(lost.x.allocationId)).toHaveLength(0);
    await e.backdate(e.a, lost.x.allocationId, { leaseUntilSecondsAgo: 1 });
    await pass(inst, lost.x.allocationId);
    expect(await state(lost.x.allocationId)).toBe('quarantined');
    expect(await e.q(e.a, "SELECT details_ref->>'reason' AS r FROM factory.audit_event WHERE resource_id = $1 AND action = 'runner.allocation_quarantined'", [lost.x.allocationId])).toEqual([{ r: 'no_proof_of_quiescence:writer_node_missing' }]);
    const ok = e.newRunner({ config: { nodeCheck: 'required' } });
    const fine = await run(ok);
    await cancel(ok, fine.s);
    expect(await state(fine.x.allocationId)).toBe('terminated');
    expect((await body(ok, fine.x.allocationId)).nodeCheck).toBe('passed');
  });

  it('no start record: a cancel between the writer claim and the last commit is proved with the node check not_needed, though the node is gone', async () => {
    const inst = e.newRunner({ config: { nodeCheck: 'required' } });
    const s = await e.newStage(e.a);
    await inst.runner.startOrAttach(e.ctx(e.a), e.input(e.a, s), 'e'.repeat(64));
    const a = (await e.allocations(e.a, s))[0] as NonNullable<Awaited<ReturnType<typeof e.allocations>>[number]>;
    const pod = inst.kube.driver.podsOf(a.jobName)[0] as NonNullable<ReturnType<typeof inst.kube.driver.podsOf>[number]>;
    inst.kube.driver.startPod(pod.metadata.name);
    const hold = inst.faults.holdAt('runner.before_permit_commit');
    const permit = inst.runner.acquireStartPermit({ token: inst.kube.mintToken(pod, `factory-allocation:${e.a.orgId}:${a.id}`), orgId: e.a.orgId, allocationId: a.id, epoch: 1 });
    await hold.reached;
    inst.kube.driver.loseNode('fake-node-1');
    await cancel(inst, s);
    hold.release();
    expect(await permit).toMatchObject({ granted: false, code: 'not_startable' });
    expect(await state(a.id)).toBe('terminated');
    expect((await body(inst, a.id)).nodeCheck).toBe('not_needed');
  });

  it('claim: an unlabelled, unfinished pod naming the claim keeps the proof open; control: the same pod naming another claim does not; a capped namespace list is not proved', async () => {
    const inst = e.newRunner();
    const unlabelled = (name: string, claim: string, phase: 'Running' | 'Succeeded' = 'Running') => {
      const p = foreignPod(inst.kube, 'x', { name, phase });
      p.metadata.labels = {};
      p.spec.volumes = [{ name: 'workspace', persistentVolumeClaim: { claimName: claim } }];
      return p;
    };
    const a = await run(inst);
    const claim = pvcName(e.a.orgId, a.x.workspaceId as string, 1);
    const intruder = unlabelled(`intruder-${a.x.allocationId.slice(0, 6)}`, claim);
    await cancel(inst, a.s);
    expect(await state(a.x.allocationId)).toBe('stopping');
    intruder.status.phase = 'Succeeded';
    await pass(inst, a.x.allocationId);
    expect(await state(a.x.allocationId)).toBe('terminated');
    const b = await run(inst);
    unlabelled(`bystander-${b.x.allocationId.slice(0, 6)}`, 'some-other-claim');
    await cancel(inst, b.s);
    expect(await state(b.x.allocationId)).toBe('terminated');
    // the cap: the namespace list is paged at 500
    const c = await run(inst, { workspace: false });
    for (let i = 0; i < 501; i += 1) unlabelled(`filler-${c.x.allocationId.slice(0, 6)}-${String(i)}`, 'elsewhere', 'Succeeded');
    const d = await run(inst);
    await cancel(inst, d.s);
    expect(await state(d.x.allocationId)).toBe('stopping'); // the list is at its cap: not proved
  });

  it('a pod that finished on its own is recorded finished with exit codes, a deleted one gone; no message text is in the body', async () => {
    const inst = e.newRunner();
    const a = await run(inst, { workspace: false });
    const pod = inst.kube.driver.pod(a.x.podName);
    inst.kube.driver.containerExited(pod.metadata.uid, 'app', 'harness', { exitCode: 0, message: 'SECRET HARNESS TEXT' });
    inst.kube.driver.containerExited(pod.metadata.uid, 'app', 'supervisor', { exitCode: 143, message: 'SECRET SUPERVISOR TEXT' });
    inst.kube.delayDeletes = true; // the kubelet has not reaped it: the finished pod is still listed when the proof is read
    await pass(inst, a.x.allocationId);
    inst.kube.delayDeletes = false;
    await pass(inst, a.x.allocationId);
    expect(await state(a.x.allocationId)).toBe('terminated');
    const fin = await body(inst, a.x.allocationId);
    expect(fin.writerPod).toBe('finished');
    expect(JSON.stringify(fin)).not.toContain('SECRET');
    expect(JSON.stringify(fin.pods)).toContain('"exitCode":143');
    const g = await run(inst, { workspace: false });
    await cancel(inst, g.s);
    expect((await body(inst, g.x.allocationId)).writerPod).toBe('gone');
  });

  it('store down: a proved stop stays stopping past the stop deadline, is never quarantined or terminated, and keeps its capacity row; when the store returns the next pass terminates it', async () => {
    const inst = e.newRunner();
    const a = await run(inst);
    const real = e.artifacts.putControllerObject.bind(e.artifacts);
    e.artifacts.putControllerObject = () => Promise.reject(new InjectedFault('store down'));
    try {
      await cancel(inst, a.s);
      await e.backdate(e.a, a.x.allocationId, { leaseUntilSecondsAgo: 1 });
      expect(await pass(inst, a.x.allocationId)).toBeInstanceOf(InjectedFault);
      expect(await state(a.x.allocationId)).toBe('stopping');
      expect(await e.q(e.a, "SELECT count(*)::int AS n FROM factory.capacity_reservation WHERE state <> 'released' AND stage_run_id = (SELECT stage_run_id FROM factory.execution_allocation WHERE id = $1)", [a.x.allocationId])).toEqual([{ n: 1 }]);
    } finally { e.artifacts.putControllerObject = real; }
    await pass(inst, a.x.allocationId);
    expect(await state(a.x.allocationId)).toBe('terminated');
  });
});

describe('W-019 pods as the API returns them', () => {
  it('a pod in the namespace that mounts nothing has no `volumes` key: the proof still reads the namespace and the allocation still terminates (the old code threw in every stopping pass)', async () => {
    const inst = e.newRunner();
    const bare = foreignPod(inst.kube, 'x', { name: 'debug-probe', phase: 'Running' });
    bare.metadata.labels = {};
    expect('volumes' in bare.spec).toBe(false); // the fake can make one: this is what the API sends
    // and so does a Job whose template mounts nothing: the fake's Job controller omits an empty list too
    const a = await run(inst);
    expect(inst.kube.driver.pod(a.x.podName).spec.volumes).toBeDefined(); // control: a pod with volumes keeps them
    await cancel(inst, a.s);
    expect(await pass(inst, a.x.allocationId)).toBeUndefined(); // no TypeError out of the pass
    expect(await state(a.x.allocationId)).toBe('terminated'); // the unfinished volumeless pod does not name the claim
    bare.status.phase = 'Succeeded';
  });
});

describe('W-019 the proof when the cluster or the body misbehaves', () => {
  it('a body that would exceed 64 KiB shrinks to fit instead of throwing in every pass; the count and the digest still cover every pod', async () => {
    const inst = e.newRunner();
    const a = await run(inst, { workspace: false });
    for (let i = 0; i < 101; i += 1) {
      const p = foreignPod(inst.kube, a.x.allocationId, { name: `fat-${a.x.allocationId.slice(0, 6)}-${String(i)}`, phase: 'Succeeded' });
      const names = Array.from({ length: 64 }, (_, k) => `container-with-a-long-name-${String(k).padStart(3, '0')}`);
      p.spec.containers = names.map((name) => ({ name, image: 'x' }));
      p.status.containerStatuses = names.map((name) => ({ name, state: { terminated: { exitCode: 0 } } }));
    }
    await cancel(inst, a.s);
    expect(await pass(inst, a.x.allocationId)).toBeUndefined();
    expect(await state(a.x.allocationId)).toBe('terminated');
    const b = await body(inst, a.x.allocationId);
    expect(b['podCount']).toBe(101);
    expect(b.pods.length).toBeLessThan(101);
    expect(JSON.stringify(b).length).toBeLessThan(64 * 1024);
    expect(b['observationDigest']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('an unreadable node is retried, not quarantined: a transient API error at the stop deadline still proves one pass later; only past the grace is the stop quarantined; a 404 is quarantined at once', async () => {
    const inst = e.newRunner({ config: { nodeCheck: 'required', nodeReadGraceSeconds: 60 } });
    const transient = await run(inst);
    inst.kube.failNext('getNode', new KubeError(500, 'InternalError', 'etcd is slow'), 2);
    await cancel(inst, transient.s); // the cancel's own pass reads the node: unreadable, so not proved yet
    expect(await state(transient.x.allocationId)).toBe('stopping');
    await e.backdate(e.a, transient.x.allocationId, { leaseUntilSecondsAgo: 1 }); // the stop deadline has passed
    await pass(inst, transient.x.allocationId); // unreadable again, 1 s past the deadline: inside the grace
    expect(await state(transient.x.allocationId)).toBe('stopping');
    await pass(inst, transient.x.allocationId); // the node answers now
    expect(await state(transient.x.allocationId)).toBe('terminated');
    expect((await body(inst, transient.x.allocationId)).nodeCheck).toBe('passed');
    // past the grace
    const inst2 = e.newRunner({ config: { nodeCheck: 'required', nodeReadGraceSeconds: 60 } });
    const stuck = await run(inst2);
    inst2.kube.failNext('getNode', new KubeError(500, 'InternalError', 'down'), 99);
    await cancel(inst2, stuck.s);
    await e.backdate(e.a, stuck.x.allocationId, { leaseUntilSecondsAgo: 120 });
    await pass(inst2, stuck.x.allocationId);
    expect(await state(stuck.x.allocationId)).toBe('quarantined');
    expect(await e.q(e.a, "SELECT details_ref->>'reason' AS r FROM factory.audit_event WHERE resource_id = $1 AND action = 'runner.allocation_quarantined'", [stuck.x.allocationId])).toEqual([{ r: 'no_proof_of_quiescence:writer_node_unreadable' }]);
    // a 404 is a gone node, at once (control: the earlier test of this file)
    const inst3 = e.newRunner({ config: { nodeCheck: 'required' } });
    const gone = await run(inst3);
    inst3.kube.driver.loseNode('fake-node-1');
    await cancel(inst3, gone.s);
    await e.backdate(e.a, gone.x.allocationId, { leaseUntilSecondsAgo: 1 });
    await pass(inst3, gone.x.allocationId);
    expect(await state(gone.x.allocationId)).toBe('quarantined');
  });

  it('a start record written with the node check off is recorded `off` by a later proof under `required`, and the disposition does not call it quiescent; control: a start record with a node is `passed`', async () => {
    const off = e.newRunner(); // nodeCheck off: the start record has no node UID
    const a = await run(off);
    const strict = e.newRunner({ kube: off.kube, ownPool: true, config: { nodeCheck: 'required' } });
    await cancel(strict, a.s);
    expect(await state(a.x.allocationId)).toBe('terminated');
    const proofBody = await body(strict, a.x.allocationId);
    expect(proofBody.nodeCheck).toBe('off');
    expect(volumeDisposition({ state: 'terminated', proof: proofBody, quarantineRecord: false, storage: 'pod_scoped_local' }).answer).toBe('unknown');
    const on = e.newRunner({ config: { nodeCheck: 'required' } });
    const b = await run(on);
    await cancel(on, b.s);
    const passed = await body(on, b.x.allocationId);
    expect(passed.nodeCheck).toBe('passed');
    expect(volumeDisposition({ state: 'terminated', proof: passed, quarantineRecord: false, storage: 'pod_scoped_local' }).answer).toBe('quiescent');
  });
});
