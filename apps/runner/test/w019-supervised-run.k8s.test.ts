// W-019 on a real cluster (the k3s tier, 19b): the real controller, the listener on the host, the real images, under the local egress policy, with the gate `required`.
// The supervisor verifies the CA's digest, passes the gate, reads its own projected token, is granted, and beats; uid 10002 lists the checkout; the harness writes
// through its read-write mount; its exit stops the pod; the proof names the node and the claim; the volume survives. Run with `pnpm test:k8s` on AC power.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { quiescenceProof } from '@factory/workspace';
import { recordDeps, type PodListener } from '../src/testing.ts';
import { hex, until } from './harness.ts';
import { inNode, sleep } from './k8s/cluster.ts';
import { backingDir, claimOf, supervisedRig, type Supervised } from './k8s/supervised.ts';
import type { KubePod } from '../src/index.ts';

let x: Supervised;
let listener: PodListener | undefined;
const facts: string[] = [];
beforeAll(async () => { x = await supervisedRig('w019_k8s_run', { script: 'write-file' }); listener = x.listener; });
afterAll(async () => {
  try {
    await x.admin.clean('factory.local/org');
    let left: string[] = [];
    for (let i = 0; i < 240; i += 1) { left = await x.admin.leftovers(); if (left.length === 0) break; await sleep(500); }
    console.info(`k3s-record ${facts.join(' ')}`);
    expect(left).toEqual([]);
  } finally { await x.close(); }
});
const podsOfJob = async (jobName: string): Promise<KubePod[]> => (await x.admin.items(x.admin.ns('pods'))).filter((p) => (p as unknown as KubePod).metadata.ownerReferences?.some((o) => o.name === jobName)) as unknown as KubePod[];

describe('W-019 on k3s: a supervised run', () => {
  it('the supervisor passes the gate, is granted and beats; uid 10002 lists work/main; the levels on the node are 2750 10001:10001; the write-file harness writes through its mount; a hand-made second pod stays Pending; the harness exits and the pass stops the pod; the proof names the node and the claim; the PVC survives', async () => {
    expect(listener).toBeDefined();
    const s = await x.e.newStage(x.e.a);
    const ws = await x.e.newWorkspace(x.e.a, s, x.inst, { baseCommit: x.env.fixtureCommit });
    await x.inst.runner.startOrAttach(x.e.ctx(x.e.a), x.e.input(x.e.a, s, { workspaceId: ws }), hex('e'));
    const a = (await x.e.allocations(x.e.a, s))[0] as NonNullable<Awaited<ReturnType<typeof x.e.allocations>>[number]>;
    await until('the allocation is running', async () => { await x.inst.runner.reconcileOne(x.e.a.orgId, a.id, 5000); return (await x.e.allocation(x.e.a, a.id)).state === 'running'; }, 240_000);
    const pod = (await podsOfJob(a.jobName))[0] as KubePod;
    const log = await x.admin.logs(pod.metadata.name, 'supervisor');
    expect(log).toContain('"event":"gate"');
    expect(log).toMatch(/"event":"workspace_view_list","entries":[1-9]/); // uid 10002 listed work/main: the line is written AFTER a successful listing, with its entry count (an EACCES logs nothing)
    expect((await x.e.allocation(x.e.a, a.id)).heartbeatAgeMs).toBeLessThan(15_000); // a fresh heartbeat
    // the backing directory's levels, by stat in the node
    const dir = await backingDir(x, ws);
    const levels = ['factory', x.e.a.orgId, ws, 'g1', 'work'];
    let path = dir;
    const seen: string[] = [];
    for (const l of levels) { path = `${path}/${l}`; seen.push((await inNode('stat', '-c', '%a %u:%g', path)).trim()); }
    facts.push(`levels=${seen.join(',').replace(/ /g, '_')}`);
    expect(seen).toEqual(levels.map(() => '2750 10001:10001'));
    // the write-file harness wrote through its read-write mount
    await until('the file is on the volume', async () => inNode('test', '-f', `${path}/main/harness-was-here`).then(() => true, () => false), 60_000);
    // a hand-made second pod on the claim stays Pending (ReadWriteOncePod), now with the supervisor image
    const second = `second-${a.id.slice(0, 6)}`;
    await x.admin.ok('POST', x.admin.ns('pods'), { apiVersion: 'v1', kind: 'Pod', metadata: { name: second, labels: { 'factory-test': 'w019-run' } }, spec: {
      restartPolicy: 'Never', serviceAccountName: 'factory-allocation-supervisor', automountServiceAccountToken: false, securityContext: { runAsNonRoot: true, seccompProfile: { type: 'RuntimeDefault' } },
      containers: [{ name: 'c', image: 'factory-supervisor:local', securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] }, runAsUser: 10002 }, volumeMounts: [{ name: 'workspace', mountPath: '/workspace' }] }],
      volumes: [{ name: 'workspace', persistentVolumeClaim: { claimName: claimOf(x, ws) } }] } });
    await until('the second pod is unschedulable', async () => ((await x.admin.ok('GET', `${x.admin.ns('pods')}/${second}`)) as { status: { conditions?: Array<{ type: string; status: string }> } }).status.conditions?.some((c) => c.type === 'PodScheduled' && c.status === 'False') === true, 90_000);
    await x.admin.call('DELETE', `${x.admin.ns('pods')}/${second}`, { gracePeriodSeconds: 0 });
    // the harness exits; the pass stops the pod; the proof names the node and the claim
    await until('terminated', async () => { await x.inst.runner.reconcileOne(x.e.a.orgId, a.id, 5000); return (await x.e.allocation(x.e.a, a.id)).state === 'terminated'; }, 240_000);
    const proof = await quiescenceProof.readChecked(recordDeps(x.inst.deps), x.e.a.orgId, x.e.a.taskId, a.id);
    expect(proof.kind).toBe('present');
    const body = (proof.kind === 'present' ? proof.body : {}) as { writer?: { nodeName?: string }; detachment?: { claim?: { name: string } }; nodeCheck?: string };
    expect(body.writer?.nodeName).toBeTruthy();
    expect(body.detachment?.claim?.name).toBe(claimOf(x, ws));
    expect(['passed', 'not_needed']).toContain(body.nodeCheck); // the node check is on: `passed` when the pod object is gone and its node is still there, `not_needed` while it is listed
    expect(await x.admin.items(x.admin.ns('persistentvolumeclaims'), `factory.local/workspace=${ws}`)).toHaveLength(1); // the PVC survives
    expect((await x.e.workspace(x.e.a, ws)).state).toBe('retained');
  }, 600_000);
});
