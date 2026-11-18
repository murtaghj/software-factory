// W-017 on a real cluster (the k3s tier, 17b): the real controller, the real pod executor in the test image (A-31: the
// fixture repository over file://), the real Job controller, scheduler, kubelet, storage class and token issuer, with the
// runner acting only through its own Role. The stubs stand in for the supervisor and the harness (A-27).
// Run with `pnpm test:k8s`; a missing cluster fails the run.
import { randomUUID } from 'node:crypto';
import { transitionWorkspace } from '@factory/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { jobName, parseMaterializeStatus, startRunnerProcess, tokenAudience, type KubePod } from '../src/index.ts';
import { createEnv, hex, until, type ClusterInstance, type Env, type Stage } from './harness.ts';
import { AdminClient, inNode, loadK3sEnv, runnerKube, sleep } from './k8s/cluster.ts';

const env = loadK3sEnv();
const admin = new AdminClient(env);
const TEST_LABEL = 'factory-test=w017-run';
let e: Env;
let a: ClusterInstance;   // two runner instances, each with its own pool: two controllers
let b: ClusterInstance;
let e2: Env;           // a second tenant database whose repository is the fixture that stalls (stall.git)
let c: ClusterInstance;
const facts: string[] = [];
const record = (k: string, v: string): void => { facts.push(`${k}=${v}`); };

beforeAll(async () => {
  e = await createEnv('w017_k8s', { cloneUrl: 'file:///fixture/repo.git',
    config: { namespace: env.namespace, images: { supervisor: 'factory-stub:local', harness: 'factory-stub:local', materializer: 'factory-materializer-test:local' } } });
  a = e.newClusterRunner({ kube: runnerKube(env), ownPool: true });
  b = e.newClusterRunner({ kube: runnerKube(env), ownPool: true });
  e2 = await createEnv('w017_k8s_stall', { cloneUrl: 'file:///fixture/stall.git', config: { namespace: env.namespace, images: { supervisor: 'factory-stub:local', harness: 'factory-stub:local', materializer: 'factory-materializer-test:local' } } });
  c = e2.newClusterRunner({ kube: runnerKube(env), ownPool: true });
});
afterAll(async () => {
  try {
    await admin.clean('factory.local/org');
    await admin.clean(TEST_LABEL);
    let left: string[] = [];
    for (let i = 0; i < 240; i += 1) { left = await admin.leftovers(); if (left.length === 0) break; await sleep(500); }
    console.info(`k3s-record ${facts.join(' ')}`);
    expect(left).toEqual([]); // nothing is left behind in the namespace
  } finally { await e2.close(); await e.close(); }
});

const start = (inst: ClusterInstance, s: Stage, workspaceId: string) => inst.runner.startOrAttach(e.ctx(e.a), e.input(e.a, s, { workspaceId }), hex('e'));
const podsOfJob = async (jobName: string): Promise<KubePod[]> => (await admin.items(admin.ns('pods'))).filter((p) => (p as unknown as KubePod).metadata.ownerReferences?.some((o) => o.name === jobName)) as unknown as KubePod[];

describe('W-017 on k3s: one run, two controllers', () => {
  let s: Stage; let wsId: string; let allocId: string; let jobName: string; let epoch: number; let pod: KubePod; let dir: string;

  it('controller A dies right after creating the Job: the row is still desired, and B attaches the live Job (the whole Job spec is compared with the re-rendered one) and binds it', async () => {
    s = await e.newStage(e.a);
    wsId = await e.newWorkspace(e.a, s, a, { baseCommit: env.fixtureCommit });
    a.faults.throwAt('runner.after_job_create', { times: 1, error: new Error('controller A dies') });
    await start(a, s, wsId); // the pass fails after the post-commit step; the call still answers with the handle
    const rows = await e.allocations(e.a, s);
    expect(rows).toHaveLength(1);
    ({ id: allocId, jobName, ownerEpoch: epoch } = rows[0] as NonNullable<(typeof rows)[number]>);
    expect(await e.allocation(e.a, allocId)).toMatchObject({ state: 'desired', jobUid: null }); // A left the row as it was
    const live = await admin.items(admin.jobs(), `factory.local/allocation=${allocId}`);
    expect(live).toHaveLength(1);
    expect(await admin.items(admin.ns('persistentvolumeclaims'), `factory.local/workspace=${wsId}`)).toHaveLength(1);
    // B: AlreadyExists for the claim and the Job, each validated; the Job's whole spec equals the re-rendered one after the server's defaults.
    await b.runner.reconcileOne(e.a.orgId, allocId); // a second start would only return the handle: the loop's pass is what attaches
    expect(await e.allocation(e.a, allocId)).toMatchObject({ state: 'starting', jobUid: (live[0] as { metadata: { uid: string } }).metadata.uid }); // never quarantined
    expect(await admin.items(admin.jobs(), `factory.local/allocation=${allocId}`)).toHaveLength(1);
    expect(await admin.items(admin.ns('persistentvolumeclaims'), `factory.local/workspace=${wsId}`)).toHaveLength(1);
    expect(await e.auditCount(e.a, "action = 'runner.allocation_quarantined'")).toBe(0);
  });

  it('the init container clones the fixture and its receipt is accepted; the pod then runs', async () => {
    await until('the pod runs', async () => { await a.runner.reconcileOne(e.a.orgId, allocId, 5000); const p = (await podsOfJob(jobName))[0]; return p?.status.phase === 'Running'; }, 120_000);
    pod = (await podsOfJob(jobName))[0] as KubePod;
    const st = parseMaterializeStatus(pod);
    expect(st).toMatchObject({ kind: 'receipt', receipt: { generation: 1, headCommit: env.fixtureCommit } });
    expect(st.kind === 'receipt' ? st.receipt.gitVersion : '').toMatch(/^git version 2\.(4[89]|[5-9]\d)\./); // Git 2.48 or later in the image (to-confirm 3)
    // The init step's message is the whole of its status: the app containers' statuses are never read.
    expect(pod.status.initContainerStatuses?.[0]?.name).toBe('materialize');
    record('git', st.kind === 'receipt' ? st.receipt.gitVersion.replace(/ /g, '_') : '');
  });

  it('the mount point, the 0700 subdirectory and the volume on the node (to-confirm 1 and 4: the owner and mode, and that local-path removes it)', async () => {
    const claim = (await admin.items(admin.ns('persistentvolumeclaims'), `factory.local/workspace=${wsId}`))[0] as { metadata: { name: string }; spec: { volumeName: string } };
    dir = `/var/lib/rancher/k3s/storage/${claim.spec.volumeName}_${env.namespace}_${claim.metadata.name}`;
    record('mountpoint', (await inNode('stat', '-c', '%u:%g_%a', dir)).trim());
    record('factory_dir', (await inNode('stat', '-c', '%u:%g_%a', `${dir}/factory`)).trim());
    expect((await inNode('stat', '-c', '%a', `${dir}/factory`)).trim().slice(-3)).toBe('700'); // fsGroup adds the setgid bit to a directory made under the mount point
    expect((await inNode('stat', '-c', '%u', `${dir}/factory`)).trim()).toBe('10001');
    expect((await inNode('test', '-d', `${dir}/factory/${e.a.orgId}/${wsId}/g1/work/main`).then(() => 'dir', () => 'missing'))).toBe('dir'); // the checkout is on the volume
  });

  it('a hand-made second pod on the PVC stays Pending (ReadWriteOncePod); a token for it is refused, a token read from the allocation pod\'s own projected volume is granted', async () => {
    const claim = (await admin.items(admin.ns('persistentvolumeclaims'), `factory.local/workspace=${wsId}`))[0] as { metadata: { name: string } };
    const second = `second-${randomUUID().slice(0, 6)}`;
    await admin.ok('POST', admin.ns('pods'), { apiVersion: 'v1', kind: 'Pod', metadata: { name: second, labels: { 'factory-test': 'w017-run' } }, spec: {
      restartPolicy: 'Never', serviceAccountName: 'factory-allocation-supervisor', automountServiceAccountToken: false, securityContext: { runAsNonRoot: true, seccompProfile: { type: 'RuntimeDefault' } },
      containers: [{ name: 'c', image: 'factory-stub:local', securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] }, runAsUser: 10001 }, volumeMounts: [{ name: 'workspace', mountPath: '/workspace' }] }],
      volumes: [{ name: 'workspace', persistentVolumeClaim: { claimName: claim.metadata.name } }] } });
    // The scheduler records why it cannot place the pod; that condition is the gate (no sleeping).
    await until('the second pod is unschedulable', async () => {
      const p = (await admin.ok('GET', `${admin.ns('pods')}/${second}`)) as { status: { phase: string; conditions?: Array<{ type: string; status: string; message?: string }> } };
      const c = p.status.conditions?.find((x) => x.type === 'PodScheduled');
      if (c?.status === 'False') record('second_pod', (c.message ?? '').replace(/\s+/g, '_').slice(0, 120));
      return c?.status === 'False';
    }, 60_000);
    expect((await admin.ok('GET', `${admin.ns('pods')}/${second}`) as { status: { phase: string } }).status.phase).toBe('Pending');
    expect(pod.status.phase).toBe('Running'); // control: the first pod is the one that holds the claim

    const aud = tokenAudience(e.a.orgId, allocId);
    const foreign = await admin.mintToken(second, aud);
    const refused = await a.runner.acquireStartPermit({ token: foreign, orgId: e.a.orgId, allocationId: allocId, epoch });
    expect(refused).toMatchObject({ granted: false, code: 'not_this_job' });
    expect((await e.allocation(e.a, allocId)).podUid).toBeNull(); // the refusal wrote no claim
    // A token read from the projected volume of the real allocation pod (the kubelet's own mechanism, first reviewed here).
    const projected = (await inNode('kubectl', '-n', env.namespace, 'exec', pod.metadata.name, '-c', 'supervisor', '--', 'cat', '/var/run/factory-identity/token')).trim();
    const granted = await b.runner.acquireStartPermit({ token: projected, orgId: e.a.orgId, allocationId: allocId, epoch });
    expect(granted).toMatchObject({ granted: true });
    expect(await e.allocation(e.a, allocId)).toMatchObject({ state: 'running', podUid: pod.metadata.uid });
    expect(await e.workspace(e.a, wsId)).toMatchObject({ state: 'active', ownerPodUid: pod.metadata.uid });
    // Renewal with the same token by the other controller; the foreign pod's token still gets nothing.
    expect(await a.runner.renewPermit({ token: projected, orgId: e.a.orgId, allocationId: allocId, epoch })).toMatchObject({ granted: true });
    expect(await a.runner.renewPermit({ token: foreign, orgId: e.a.orgId, allocationId: allocId, epoch })).toMatchObject({ granted: false });
    await admin.call('DELETE', `${admin.ns('pods')}/${second}`, { gracePeriodSeconds: 0 });
  });

  it('cancel ends the pod inside the grace period; the workspace is retained and the PVC survives', async () => {
    const t0 = performance.now();
    expect(await a.runner.cancel(e.ctx(e.a), s.logicalId, randomUUID(), 'k3s run')).toMatchObject({ state: 'reconciling' });
    await until('terminated', async () => { await b.runner.reconcileOne(e.a.orgId, allocId, 5000); return (await e.allocation(e.a, allocId)).state === 'terminated'; }, 90_000);
    const seconds = (performance.now() - t0) / 1000;
    record('cancel_to_terminated_s', seconds.toFixed(1));
    expect(seconds).toBeLessThan(15 + 20); // the grace period plus the reconcile and request overhead
    // The proof reads pod status: a pod that finished (or is gone) with no running container. The garbage collector then removes the object.
    expect((await podsOfJob(jobName)).every((p) => p.status.phase !== 'Running')).toBe(true);
    await until('the pod object is collected', async () => (await podsOfJob(jobName)).length === 0, 60_000);
    expect(await admin.items(admin.jobs(), `factory.local/allocation=${allocId}`)).toHaveLength(0);
    expect(await e.workspace(e.a, wsId)).toMatchObject({ state: 'retained' });
    expect(await admin.items(admin.ns('persistentvolumeclaims'), `factory.local/workspace=${wsId}`)).toHaveLength(1); // the work survives
    expect((await a.runner.getRun(e.ctx(e.a), s.logicalId)).state).toBe('cancelled');
  });

  it('release is refused without an accepted checkpoint and the PVC stays; with one seeded it deletes that generation\'s PVC, none with the workspace\'s label is left, and the backing directory is gone', async () => {
    await expect(a.runner.releaseWorkspace(e.ctx(e.a), wsId, 1)).rejects.toMatchObject({ code: 'checkpoint_not_accepted' });
    expect(await e.workspace(e.a, wsId)).toMatchObject({ state: 'retained' });
    expect(await admin.items(admin.ns('persistentvolumeclaims'), `factory.local/workspace=${wsId}`)).toHaveLength(1);
    expect(await inNode('test', '-d', dir).then(() => true, () => false)).toBe(true); // control: the directory exists before the delete
    const ref = await e.putArtifact(e.a, Buffer.from('{"checkpoint":"seeded"}'), 'checkpoint');
    await e.db.withTenant({ orgId: e.a.orgId }, (tx) => transitionWorkspace(tx, { orgId: e.a.orgId, id: wsId, expectedEpoch: 1, from: ['retained'], patch: { checkpointRef: ref } }));
    expect(await a.runner.releaseWorkspace(e.ctx(e.a), wsId, 1)).toEqual({ state: 'released' });
    expect(await admin.items(admin.ns('persistentvolumeclaims'), `factory.local/workspace=${wsId}`)).toHaveLength(0);
    expect(await e.workspace(e.a, wsId)).toMatchObject({ state: 'released' });
    // The storage class reclaims the bytes with a helper pod, a moment after the claim is gone.
    const t0 = performance.now();
    await until('the backing directory is removed', async () => !(await inNode('test', '-d', dir).then(() => true, () => false)), 90_000);
    record('reclaim_s', ((performance.now() - t0) / 1000).toFixed(1));
  });
});

describe('W-017 on k3s: concurrent starts', () => {
  it('twelve concurrent startOrAttach calls over two controllers give one allocation, one Job and one PVC and twelve equal handles', async () => {
    const s2 = await e.newStage(e.a);
    const ws2 = await e.newWorkspace(e.a, s2, a, { baseCommit: env.fixtureCommit });
    const handles = await Promise.all(Array.from({ length: 12 }, (_v, i) => start(i % 2 === 0 ? a : b, s2, ws2)));
    expect(new Set(handles.map((h) => JSON.stringify(h))).size).toBe(1);
    const rows = await e.allocations(e.a, s2);
    expect(rows).toHaveLength(1);
    const id = (rows[0] as NonNullable<(typeof rows)[number]>).id;
    expect(await admin.items(admin.jobs(), `factory.local/allocation=${id}`)).toHaveLength(1);
    expect(await admin.items(admin.ns('persistentvolumeclaims'), `factory.local/workspace=${ws2}`)).toHaveLength(1);
    expect(['accepted', 'running']).toContain(handles[0]?.state);
    expect((await e.allocation(e.a, id)).state).not.toBe('quarantined');
    await a.runner.cancel(e.ctx(e.a), s2.logicalId, randomUUID(), 'done');
  });
});

describe('W-017 on k3s: a Job under our name that is not ours', () => {
  it('AlreadyExists with foreign annotations quarantines the allocation, nothing attaches, and the foreign Job is untouched (AC-11, the Job-level half)', async () => {
    const s3 = await e.newStage(e.a);
    const ws3 = await e.newWorkspace(e.a, s3, a, { baseCommit: env.fixtureCommit });
    const name = jobName(e.a.orgId, s3.logicalId, 1);
    // A suspended Job that someone else made under the name this run's Job will get: no pod is ever started for it.
    const foreign = await admin.ok('POST', admin.jobs(), { apiVersion: 'batch/v1', kind: 'Job', metadata: { name, labels: { 'factory-test': 'w017-run' }, annotations: { 'factory.local/allocation': randomUUID() } }, spec: { suspend: true, backoffLimit: 0, template: { spec: {
      restartPolicy: 'Never', serviceAccountName: 'factory-allocation-supervisor', automountServiceAccountToken: false, securityContext: { runAsNonRoot: true, seccompProfile: { type: 'RuntimeDefault' } },
      containers: [{ name: 'c', image: 'factory-stub:local', securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] }, runAsUser: 10001 } }] } } } }) as { metadata: { uid: string } };
    await start(a, s3, ws3);
    const row = (await e.allocations(e.a, s3))[0] as NonNullable<Awaited<ReturnType<typeof e.allocations>>[number]>;
    expect(await e.allocation(e.a, row.id)).toMatchObject({ state: 'quarantined', jobUid: null }); // nothing attached
    expect((await admin.ok('GET', `${admin.jobs()}/${name}`) as { metadata: { uid: string } }).metadata.uid).toBe(foreign.metadata.uid); // the foreign Job was neither replaced nor deleted
    expect(await e.auditCount(e.a, "action = 'runner.allocation_quarantined' AND resource_id = $1", [row.id])).toBe(1);
  });
});

describe('W-017 on k3s: the process start and a stopped clone', () => {
  it('the runner process start reads the storage class under the runner\'s own token; a class outside the Role is forbidden (control)', async () => {
    const kube = runnerKube(env);
    const p = await startRunnerProcess({ config: e.config, kube, db: e.db, artifacts: e.artifacts });
    await p.stop();
    await expect(kube.assertStorageClass('some-other-class')).rejects.toMatchObject({ status: 403 });
    await expect(kube.assertStorageClass('local-path')).resolves.toBeUndefined();
  });

  it('a pod told to stop in the middle of a clone exits well inside its grace period: tini is PID 1 and reaps what Git left behind', async () => {
    const s4 = await e2.newStage(e2.a);
    const ws4 = await e2.newWorkspace(e2.a, s4, c, { baseCommit: env.fixtureCommit });
    await c.runner.startOrAttach(e2.ctx(e2.a), e2.input(e2.a, s4, { workspaceId: ws4 }), hex('e'));
    const row = (await e2.allocations(e2.a, s4))[0] as NonNullable<Awaited<ReturnType<typeof e2.allocations>>[number]>;
    // The gate: the stalled clone has written its marker in the init container (no sleeping).
    await until('the clone is held open', async () => {
      const p = (await podsOfJob(row.jobName))[0];
      if (!p) return false;
      return inNode('kubectl', '-n', env.namespace, 'exec', p.metadata.name, '-c', 'materialize', '--', 'test', '-e', '/tmp/stalled').then(() => true, () => false);
    }, 120_000);
    const pod4 = (await podsOfJob(row.jobName))[0] as KubePod;
    expect(pod4.status.initContainerStatuses?.[0]?.state.running).toBeDefined(); // control: the init step is still running
    expect(await inNode('kubectl', '-n', env.namespace, 'exec', pod4.metadata.name, '-c', 'materialize', '--', 'cat', '/proc/1/comm')).toContain('tini');
    const t0 = performance.now();
    await c.runner.cancel(e2.ctx(e2.a), s4.logicalId, randomUUID(), 'mid-clone');
    await until('the pod is gone', async () => (await podsOfJob(row.jobName)).length === 0, 60_000);
    const seconds = (performance.now() - t0) / 1000;
    record('stalled_clone_cancel_to_pod_gone_s', seconds.toFixed(1));
    expect(seconds).toBeLessThan(8); // the grace period is 15 s; an init process that does not reap would spend 10 s of it in the wait for the group
  });
});

