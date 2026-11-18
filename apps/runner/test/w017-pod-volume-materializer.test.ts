// PodVolumeMaterializer.remove, rule by rule, against FakeKube with a stubbed lookup (no database): each refusal has its accepted twin.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { KubeError, labelKeys, pvcName, PodVolumeMaterializer, type KubeApi, type KubePod, type KubePvc, type PvcManifest } from '../src/index.ts';
import { FakeKube } from '../src/testing.ts';
import { config } from './fixed-rows.ts';

const k = labelKeys(config.labelPrefix);
const ORG = randomUUID(); const WS = randomUUID(); const TASK = randomUUID();
const target = (generation = 1): { orgId: string; workspaceId: string; generation: number } => ({ orgId: ORG, workspaceId: WS, generation });
const claim = (generation: number, over: { labels?: Record<string, string>; name?: string } = {}): PvcManifest => ({
  apiVersion: 'v1', kind: 'PersistentVolumeClaim',
  metadata: { name: over.name ?? pvcName(ORG, WS, generation), namespace: 'factory-exec-local', annotations: {}, labels: over.labels ?? { [k.org]: ORG, [k.task]: TASK, [k.workspace]: WS, [k.generation]: String(generation) } },
  spec: { accessModes: ['ReadWriteOncePod'], storageClassName: 'local-path', resources: { requests: { storage: '2Gi' } } },
});
const mk = (o: { live?: boolean; kube?: KubeApi; settle?: { timeoutMs: number; pollMs: number }; wait?: (ms: number) => Promise<void>; liveCalls?: string[] } = {}): { kube: FakeKube; m: PodVolumeMaterializer } => {
  const kube = new FakeKube();
  const m = new PodVolumeMaterializer({ kube: o.kube ?? kube, config, lookup: (org, ws) => { o.liveCalls?.push(`${org}/${ws}`); return Promise.resolve({ taskId: TASK, live: o.live === true }); },
    settle: o.settle ?? { timeoutMs: 50, pollMs: 10 }, wait: o.wait ?? (() => Promise.resolve()) });
  return { kube, m };
};
// A pod that uses a claim, with no workspace label (a hand-made pod, or a Job's pod of another kind).
const holder = (kube: FakeKube, claimName: string, labels: Record<string, string> = {}): KubePod => {
  const pod: KubePod = { metadata: { name: `holder-${randomUUID().slice(0, 6)}`, namespace: kube.namespace, uid: randomUUID(), labels, annotations: {} },
    spec: { restartPolicy: 'Never', terminationGracePeriodSeconds: 15, serviceAccountName: 'x', automountServiceAccountToken: false, shareProcessNamespace: false, securityContext: {}, containers: [{ name: 'c', image: 'x' }], volumes: [{ name: 'w', persistentVolumeClaim: { claimName } }] },
    status: { phase: 'Running', containerStatuses: [{ name: 'c', state: { running: {} } }] } };
  kube.pods.set(pod.metadata.name, pod);
  kube.scheduled.add(pod.metadata.uid);
  return pod;
};

describe('W-017 PodVolumeMaterializer.remove', () => {
  it('1. a workspace with a live allocation answers absent:false and touches nothing (N5); control: with none, the claim goes', async () => {
    const calls: string[] = [];
    const { kube, m } = mk({ live: true, liveCalls: calls });
    await kube.createPvc(claim(1));
    const w0 = kube.writes.length;
    expect(await m.remove(target())).toMatchObject({ absent: false, error: expect.stringContaining('live allocation') as unknown });
    expect(calls).toEqual([`${ORG}/${WS}`]);
    expect(kube.writes.length).toBe(w0);
    expect(kube.pvcs.size).toBe(1);
    const twin = mk({ live: false });
    await twin.kube.createPvc(claim(1));
    expect(await twin.m.remove(target())).toEqual({ absent: true });
    expect(twin.kube.pvcs.size).toBe(0);
  });

  it('2. a pod with the workspace and generation labels, in any phase, answers absent:false; another generation\'s pod does not block this one', async () => {
    const { kube, m } = mk();
    await kube.createPvc(claim(1));
    const pod = holder(kube, 'unrelated', { [k.org]: ORG, [k.workspace]: WS, [k.generation]: '1' });
    pod.status.phase = 'Succeeded';
    expect(await m.remove(target())).toMatchObject({ absent: false, error: expect.stringContaining('pod') as unknown });
    expect(kube.pvcs.size).toBe(1);
    kube.pods.delete(pod.metadata.name);
    const other = holder(kube, 'unrelated', { [k.org]: ORG, [k.workspace]: WS, [k.generation]: '2' }); // control: generation 2's pod is not generation 1's
    expect(other.metadata.labels[k.generation]).toBe('2');
    expect(await m.remove(target())).toEqual({ absent: true });
  });

  it('3. a claim whose ownership labels are not ours is never deleted; a precondition that fails (409) leaves it alone; the labels are compared exactly', async () => {
    for (const labels of [
      { [k.org]: randomUUID(), [k.task]: TASK, [k.workspace]: WS, [k.generation]: '1' },
      { [k.org]: ORG, [k.task]: TASK, [k.workspace]: randomUUID(), [k.generation]: '1' },
      { [k.org]: ORG, [k.task]: TASK, [k.workspace]: WS, [k.generation]: '2' },
      { [k.task]: TASK, [k.workspace]: WS, [k.generation]: '1' },
      { [k.org]: ORG, [k.task]: randomUUID(), [k.workspace]: WS, [k.generation]: '1' }, // another task's label: the same predicate the attach uses
      { [k.org]: ORG, [k.workspace]: WS, [k.generation]: '1' },
    ]) {
      const { kube, m } = mk();
      await kube.createPvc(claim(1, { labels }));
      expect(await m.remove(target())).toMatchObject({ absent: false });
      expect(kube.writes.filter((w) => w.startsWith('deletePvc'))).toEqual([]);
      expect(kube.pvcs.size).toBe(1);
    }
    // 409 Conflict: the object under the name changed between the read and the delete.
    const { kube, m } = mk();
    await kube.createPvc(claim(1));
    kube.failNext('deletePvc', new KubeError(409, 'Conflict', 'Precondition failed'));
    expect(await m.remove(target())).toMatchObject({ absent: false, error: expect.stringContaining('left alone') as unknown });
    expect(kube.pvcs.size).toBe(1);
    expect(await m.remove(target())).toEqual({ absent: true }); // control: the next call, no fault, deletes it
  });

  it('3b. a claim a hand-made pod still uses stays, terminating: absent:false while it does; absent:true once the pod is gone (the poll, with a gate and no sleeping)', async () => {
    let polls = 0;
    let freed = false;
    const kubeRef: { kube?: FakeKube } = {};
    const { kube, m } = mk({ settle: { timeoutMs: 1000, pollMs: 10 }, wait: () => {
      polls += 1;
      if (polls === 3) { freed = true; const h = [...(kubeRef.kube?.pods.values() ?? [])][0]; if (h) kubeRef.kube?.driver.removePod(h.metadata.name); }
      return Promise.resolve();
    } });
    kubeRef.kube = kube;
    await kube.createPvc(claim(1));
    holder(kube, pvcName(ORG, WS, 1));
    expect(await m.remove(target())).toEqual({ absent: true });
    expect(freed).toBe(true);
    expect(polls).toBe(3); // it read until 404, no longer
    // Control: nobody frees it, and the settle deadline answers absent:false with the claim still there, terminating.
    const stuck = mk({ settle: { timeoutMs: 50, pollMs: 10 } });
    await stuck.kube.createPvc(claim(1));
    holder(stuck.kube, pvcName(ORG, WS, 1));
    expect(await stuck.m.remove(target())).toMatchObject({ absent: false, error: expect.stringContaining('terminating') as unknown });
    expect(stuck.kube.pvcs.get(pvcName(ORG, WS, 1))?.metadata.deletionTimestamp).toBeDefined();
  });

  it('3c. a new claim that appears under the name while the old one is going is not "gone"', async () => {
    const { kube, m } = mk({ settle: { timeoutMs: 100, pollMs: 10 } });
    const first = await kube.createPvc(claim(1));
    holder(kube, pvcName(ORG, WS, 1));
    const original = kube.getPvc.bind(kube);
    let n = 0;
    kube.getPvc = async (name: string): Promise<KubePvc> => { n += 1; const r = await original(name); return n > 2 ? { ...r, metadata: { ...r.metadata, uid: randomUUID() } } : r; };
    expect(first.metadata.uid).toBeDefined();
    expect(await m.remove(target())).toMatchObject({ absent: false, error: expect.stringContaining('now sits') as unknown });
  });

  it('4. any claim left with the workspace\'s label, of any generation, answers absent:false and is not deleted; another workspace\'s claim does not count', async () => {
    const { kube, m } = mk();
    await kube.createPvc(claim(1));
    await kube.createPvc(claim(2));
    const stranger = randomUUID();
    await kube.createPvc(claim(1, { name: pvcName(ORG, stranger, 1), labels: { [k.org]: ORG, [k.task]: TASK, [k.workspace]: stranger, [k.generation]: '1' } }));
    const r = await m.remove(target(1));
    expect(r).toMatchObject({ absent: false, error: expect.stringContaining(pvcName(ORG, WS, 2)) as unknown });
    expect(kube.pvcs.has(pvcName(ORG, WS, 2))).toBe(true);   // never deleted: only the target generation's own claim is
    expect(kube.pvcs.has(pvcName(ORG, stranger, 1))).toBe(true);
    expect(kube.pvcs.has(pvcName(ORG, WS, 1))).toBe(false);
    expect(await m.remove(target(2))).toEqual({ absent: true }); // control: with generation 1's gone, deleting generation 2's leaves only the stranger's
    expect(kube.pvcs.size).toBe(1);
  });

  it('every failure is an absent:false, never a throw and never "absent"; truncated lists and invalid targets included', async () => {
    const { kube, m } = mk();
    await kube.createPvc(claim(1));
    kube.failNext('listPods', new KubeError(0, 'Timeout', 'no answer'));
    expect(await m.remove(target())).toMatchObject({ absent: false });
    kube.failNext('getPvc', new KubeError(500, 'InternalError', 'boom'));
    expect(await m.remove(target())).toMatchObject({ absent: false });
    kube.failNext('deletePvc', new KubeError(0, 'Timeout', 'unknown outcome'));
    expect(await m.remove(target())).toMatchObject({ absent: false });
    kube.failNext('listPvcs', new KubeError(0, 'Timeout', 'no answer')); // the delete went through; the final list failed
    expect(await m.remove(target())).toMatchObject({ absent: false });
    for (const bad of [{ orgId: 'x', workspaceId: WS, generation: 1 }, { orgId: ORG, workspaceId: 'x', generation: 1 }, { orgId: ORG, workspaceId: WS, generation: 0 }, { orgId: ORG, workspaceId: WS, generation: 1.5 }]) {
      expect(await m.remove(bad)).toMatchObject({ absent: false, error: 'invalid target' });
    }
    expect(await m.remove(target())).toEqual({ absent: true }); // control: all the faults spent, the claim is gone
    // A list that stopped at its cap is not "none left".
    const real = new FakeKube();
    const capped = new Proxy(real, { get: (t, p) => {
      if (p === 'listPvcs') return async (selector: string): Promise<{ items: KubePvc[]; truncated: boolean }> => ({ ...(await t.listPvcs(selector)), truncated: true });
      const v: unknown = Reflect.get(t, p);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    } }) as KubeApi;
    const c = mk({ kube: capped });
    await real.createPvc(claim(1));
    expect(await c.m.remove(target())).toMatchObject({ absent: false, error: expect.stringContaining('cap') as unknown });
  });
});
