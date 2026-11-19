// AC-15, the tree stop, at production timings (k3s only; the fake tier claims the protocol and not this). The `spawn-tree` harness starts a child in its group and a grandchild
// that called setsid and ignores TERM. A cancel: the hold, the supervisor acknowledges within one beat, the pod is deleted; EVERY process of the tree, the one that left the group
// included, is gone when the pod object is gone, by the runtime's own view. Times are recorded and asserted under 30 s and 20 s.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { quiescenceProof } from '@factory/workspace';
import { recordDeps } from '../src/testing.ts';
import { hex, until } from './harness.ts';
import { containerRunning, inNode, sleep } from './k8s/cluster.ts';
import { supervisedRig, type Supervised } from './k8s/supervised.ts';
import type { KubePod } from '../src/index.ts';

let x: Supervised;
const facts: string[] = [];
beforeAll(async () => { x = await supervisedRig('w019_k8s_tree', { script: 'spawn-tree' }); });
afterAll(async () => {
  try {
    await x.admin.clean('factory.local/org');
    let left: string[] = [];
    for (let i = 0; i < 240; i += 1) { left = await x.admin.leftovers(); if (left.length === 0) break; await sleep(500); }
    console.info(`k3s-record ${facts.join(' ')}`);
    expect(left).toEqual([]);
  } finally { await x.close(); }
});
// The marker processes, as the node sees them: the harness's own `node`, the child (sleep 31001) and the grandchild (sleep 31002).
const markers = async (): Promise<string> => (await inNode('sh', '-c', "ps -o args | grep -E 'sleep 3100[12]' | grep -v grep || true")).trim();

describe('AC-15 on k3s: the tree stop', () => {
  it('cancel: the supervisor acknowledges within one beat, every process of the tree is gone when the pod object is gone, and the stop ends terminated with the proof', async () => {
    const s = await x.e.newStage(x.e.a);
    const ws = await x.e.newWorkspace(x.e.a, s, x.inst, { baseCommit: x.env.fixtureCommit });
    await x.inst.runner.startOrAttach(x.e.ctx(x.e.a), x.e.input(x.e.a, s, { workspaceId: ws }), hex('e'));
    const a = (await x.e.allocations(x.e.a, s))[0] as NonNullable<Awaited<ReturnType<typeof x.e.allocations>>[number]>;
    await until('running', async () => { await x.inst.runner.reconcileOne(x.e.a.orgId, a.id, 5000); return (await x.e.allocation(x.e.a, a.id)).state === 'running'; }, 240_000);
    const pod = (await x.admin.items(x.admin.ns('pods'))).map((p) => p as unknown as KubePod).find((p) => p.metadata.ownerReferences?.some((o) => o.name === a.jobName)) as KubePod;
    // control: before the cancel all of them are alive
    await until('the tree started', async () => (await markers()).split('\n').filter(Boolean).length >= 2, 120_000);
    expect((await markers()).includes('sleep 31002')).toBe(true);
    expect(await containerRunning(pod.metadata.uid, 'harness')).toBe(true);

    const t0 = performance.now();
    await x.inst.runner.cancel(x.e.ctx(x.e.a), s.logicalId, randomUUID(), 'stop');
    await until('the supervisor acknowledged', async () => (await x.e.q(x.e.a, "SELECT count(*)::int AS n FROM factory.audit_event WHERE action = 'runner.stop_ack' AND resource_id = $1", [a.id]))[0]?.['n'] === 1, 30_000);
    const acked = (performance.now() - t0) / 1000;
    let deletedAt: number | undefined;
    await until('the pod object is gone', async () => {
      const p = (await x.admin.items(x.admin.ns('pods'))).find((q) => (q as unknown as KubePod).metadata.uid === pod.metadata.uid) as unknown as KubePod | undefined;
      if (p?.metadata.deletionTimestamp !== undefined) deletedAt ??= performance.now();
      return p === undefined;
    }, 90_000);
    const gone = performance.now();
    // every process of the tree, the setsid one included, is gone: by the runtime's view and by ps in the node
    expect(await containerRunning(pod.metadata.uid, 'harness')).not.toBe(true);
    expect(await markers()).toBe('');
    const cancelToDelete = ((deletedAt ?? gone) - t0) / 1000;
    const deleteToGone = (gone - (deletedAt ?? gone)) / 1000;
    facts.push(`ack_s=${acked.toFixed(1)}`, `cancel_to_delete_s=${cancelToDelete.toFixed(1)}`, `delete_to_gone_s=${deleteToGone.toFixed(1)}`);
    expect(acked).toBeLessThan(25); // within the hold (30 s at most; one beat in practice)
    expect(cancelToDelete).toBeLessThan(30);
    expect(deleteToGone).toBeLessThan(20);
    await until('terminated', async () => { await x.inst.runner.reconcileOne(x.e.a.orgId, a.id, 5000); return (await x.e.allocation(x.e.a, a.id)).state === 'terminated'; }, 120_000);
    expect((await quiescenceProof.readChecked(recordDeps(x.inst.deps), x.e.a.orgId, x.e.a.taskId, a.id)).kind).toBe('present');
    expect((await x.e.workspace(x.e.a, ws)).state).toBe('retained');
  }, 900_000);
});
