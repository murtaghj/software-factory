// Fixes from the 17a adversarial review: stale judgements, the fake kubelet's removal rule, the bind and sweep rules,
// the real pass deadline, the pod-template comparison on attach, and the image and service-link rules.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getRunnerStageRunById } from '@factory/database';
import { cancelRecordId, createConfig, KubeError, quantityValue, renderJob, renderPvc, templateDifferences, tokenAudience, type JobManifest } from '../src/index.ts';
import { allocation, config as fixedConfig, request as fixedRequest, stage as fixedStage, workspace as fixedWorkspace } from './fixed-rows.ts';
import { FakeKubelet, createTestConfig, move, passOnce, STUB_PROGRAMS } from '../src/testing.ts';
import { createEnv, hex, sleep, until, type Env, type Instance, type Stage } from './harness.ts';

let e: Env;
const kubelets: FakeKubelet[] = [];
beforeAll(async () => { e = await createEnv('w017_fixes'); });
afterEach(async () => { for (const k of kubelets.splice(0)) await k.close(); });
afterAll(async () => { await e.close(); });

const start = (inst: Instance, s: Stage, workspaceId?: string) => inst.runner.startOrAttach(e.ctx(e.a), e.input(e.a, s, workspaceId ? { workspaceId } : {}), hex('e'));
const alloc = async (s: Stage, n = 0) => (await e.allocations(e.a, s))[n] as NonNullable<Awaited<ReturnType<typeof e.allocations>>[number]>;
const setState = (id: string, state: string, jobUid?: string) => e.db.withTenant({ orgId: e.a.orgId }, (tx) => tx.query('UPDATE factory.execution_allocation SET state = $2, job_uid = COALESCE($3, job_uid) WHERE id = $1', [id, state, jobUid ?? null]));

describe('review fixes', () => {
  it('a pass whose row was read before a permit claimed the writer pod does not stop the good start (re-read, and a stale move is refused)', async () => {
    const inst = e.newRunner();
    const s = await e.newStage(e.a);
    const ws = await e.newWorkspace(e.a, s, inst);
    await start(inst, s, ws);
    const a = await alloc(s);
    const pod = inst.kube.driver.podsOf(a.jobName)[0] as NonNullable<ReturnType<typeof inst.kube.driver.podsOf>[number]>;
    inst.kube.driver.initFinished(pod.metadata.name, { exitCode: 0, message: e.receiptMessage() });
    // Hold the pass between its Job read and its workspace read.
    const real = inst.kube.getJob.bind(inst.kube);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let reached!: () => void;
    const hit = new Promise<void>((r) => { reached = r; });
    let armed = true;
    inst.kube.getJob = async (n: string) => { const r = await real(n); if (armed) { armed = false; reached(); await gate; } return r; };
    const pass = inst.runner.reconcileOne(e.a.orgId, a.id, 5000);
    await hit;
    const granted = await inst.runner.acquireStartPermit({ token: inst.kube.mintToken(pod, tokenAudience(e.a.orgId, a.id)), orgId: e.a.orgId, allocationId: a.id, epoch: 1 });
    expect(granted.granted).toBe(true);
    expect(await e.workspace(e.a, ws)).toMatchObject({ state: 'active', ownerPodUid: pod.metadata.uid });
    release();
    await pass;
    expect(await e.allocation(e.a, a.id)).toMatchObject({ state: 'running', podUid: pod.metadata.uid }); // not stopping
    // And at the row: a move judged on a stale claim (podUid null) is refused while the row is `starting` with a claim.
    const s2 = await e.newStage(e.a);
    await start(inst, s2);
    const b = await alloc(s2);
    await e.db.withTenant({ orgId: e.a.orgId }, (tx) => tx.query("UPDATE factory.execution_allocation SET pod_uid = 'p-1' WHERE id = $1", [b.id]));
    expect(b.state).toBe('starting');
    expect(await move(inst.deps, b, 'stopping')).toBeUndefined();
    expect((await e.allocation(e.a, b.id)).state).toBe('starting');
    expect(await move(inst.deps, await e.allocation(e.a, b.id), 'stopping')).toBeDefined(); // control: judged on the current claim it moves
  });

  it('the re-read alone: a pass whose row went stale answers "someone else moved it" (progress) without trying to move anything, whatever move would have done', async () => {
    const inst = e.newRunner();
    const s = await e.newStage(e.a);
    const ws = await e.newWorkspace(e.a, s, inst);
    await start(inst, s, ws);
    const a = await alloc(s);
    const pod = inst.kube.driver.podsOf(a.jobName)[0] as NonNullable<ReturnType<typeof inst.kube.driver.podsOf>[number]>;
    inst.kube.driver.initFinished(pod.metadata.name, { exitCode: 0, message: e.receiptMessage() });
    const real = inst.kube.getJob.bind(inst.kube);
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    let reached!: () => void; const hit = new Promise<void>((r) => { reached = r; });
    let armed = true;
    inst.kube.getJob = async (n: string) => { const r = await real(n); if (armed) { armed = false; reached(); await gate; } return r; };
    const pass = passOnce(inst.deps, e.a.orgId, a.id); // read the row as `starting` with no writer claim
    await hit;
    expect((await inst.runner.acquireStartPermit({ token: inst.kube.mintToken(pod, tokenAudience(e.a.orgId, a.id)), orgId: e.a.orgId, allocationId: a.id, epoch: 1 })).granted).toBe(true);
    release();
    // With the re-read the pass finds the row no longer `starting` and reports progress. Without it, the workspace judgement
    // would have stopped on the stale claim, and move's own compare would have refused it: the pass would answer false.
    expect(await pass).toBe(true);
    expect((await e.allocation(e.a, a.id)).state).toBe('running');
  });

  it('the cancel check at the permit\'s final commit refuses a run with a cancel record even when the stop was never written (control: without the record it is granted)', async () => {
    const inst = e.newRunner();
    const run = await e.newStage(e.a);
    await start(inst, run);
    const a = await alloc(run);
    const pod = inst.kube.driver.podsOf(a.jobName)[0] as NonNullable<ReturnType<typeof inst.kube.driver.podsOf>[number]>;
    inst.kube.driver.startPod(pod.metadata.name);
    const hold = inst.faults.holdAt('runner.before_permit_commit');
    const permit = inst.runner.acquireStartPermit({ token: inst.kube.mintToken(pod, tokenAudience(e.a.orgId, a.id)), orgId: e.a.orgId, allocationId: a.id, epoch: 1 });
    await hold.reached; // the claim has committed; the final commit has not
    await e.q(e.a, "INSERT INTO factory.audit_event (org_id, id, actor_id, action, resource_kind, resource_id, outcome, correlation_id, request_digest) VALUES ($1,$2,'runner:factory','runner.cancel','stage_run',$3,'accepted','c',$4)", [e.a.orgId, cancelRecordId(e.a.orgId, run.logicalId), run.logicalId, hex('a')]);
    hold.release();
    expect(await permit).toMatchObject({ granted: false, code: 'not_startable' });
    expect((await e.allocation(e.a, a.id)).state).toBe('starting');
    // Control: the same sequence with no record is granted.
    const run2 = await e.newStage(e.a);
    await start(inst, run2);
    const b = await alloc(run2);
    const pod2 = inst.kube.driver.podsOf(b.jobName)[0] as NonNullable<ReturnType<typeof inst.kube.driver.podsOf>[number]>;
    inst.kube.driver.startPod(pod2.metadata.name);
    const hold2 = inst.faults.holdAt('runner.before_permit_commit');
    const permit2 = inst.runner.acquireStartPermit({ token: inst.kube.mintToken(pod2, tokenAudience(e.a.orgId, b.id)), orgId: e.a.orgId, allocationId: b.id, epoch: 1 });
    await hold2.reached;
    hold2.release();
    expect(await permit2).toMatchObject({ granted: true });
  });

  it('an error after a commit that nobody listens for is logged as a warning, never dropped', async () => {
    const inst = e.newRunner();
    const s = await e.newStage(e.a);
    inst.faults.throwAt('runner.after_allocate_commit');
    const warned: unknown[][] = [];
    const real = console.warn;
    console.warn = (...a: unknown[]): void => { warned.push(a); };
    try { await start(inst, s); } finally { console.warn = real; }
    expect(warned).toHaveLength(1);
    expect(String(warned[0]?.[0])).toContain('after a commit');
  });

  it('the fake kubelet never drops a pod while its processes live: a delete while the containers still read waiting keeps the pod until the processes are gone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'w017-gate-'));
    const installed = join(dir, 'installed');
    const gate = join(dir, 'gate');
    try {
      const inst = e.newRunner({ config: { images: { supervisor: 'factory-stub:local', harness: 'factory-stub-gated:local', materializer: 'factory-materializer:local' } } });
      const kubelet = new FakeKubelet(inst.kube, { graceMs: 1500 });
      kubelets.push(kubelet);
      // Ignores TERM, says so by writing a file, and reports ready only when a second file appears: no sleep decides anything.
      kubelet.register('factory-stub-gated:local', () => ({ command: process.execPath, waitForReady: true, env: { INSTALLED: installed, GATE: gate },
        args: ['-e', "const fs=require('fs');process.on('SIGTERM',()=>{});fs.writeFileSync(process.env.INSTALLED,'1');setInterval(()=>{if(fs.existsSync(process.env.GATE))process.stderr.write('R')},10)"] }));
      expect(STUB_PROGRAMS['factory-stub:local']).toBeDefined();
      const s = await e.newStage(e.a);
      await start(inst, s);
      const a = await alloc(s);
      await until('the gated process has installed its handler', () => existsSync(installed));
      const pod = inst.kube.driver.podsOf(a.jobName)[0] as NonNullable<ReturnType<typeof inst.kube.driver.podsOf>[number]>;
      expect(pod.status.containerStatuses?.every((c) => c.state.waiting !== undefined)).toBe(true); // the window: a live process, every container reads waiting
      expect(kubelet.processOf(pod.metadata.uid, 'harness')?.alive()).toBe(true);
      await inst.kube.deletePod(pod.metadata.name, pod.metadata.uid);
      expect(inst.kube.pods.has(pod.metadata.name)).toBe(true); // a process is alive: the pod stays, Terminating
      expect(inst.kube.pods.get(pod.metadata.name)?.metadata.deletionTimestamp).toBeDefined();
      expect(kubelet.processOf(pod.metadata.uid, 'harness')?.alive()).toBe(true); // TERM is ignored: only KILL ends it
      await until('the pod to go', () => !inst.kube.pods.has(pod.metadata.name), 10_000);
      expect(kubelet.processOf(pod.metadata.uid, 'harness')?.alive()).toBe(false); // and it goes only when they have
      expect(kubelet.processOf(pod.metadata.uid, 'supervisor')?.alive()).toBe(false);
      writeFileSync(gate, '1'); // control: the gate was never needed for the pod to go
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('the bind path deletes the Job it holds only for another UID or a stopping or finished row; a finalizing row that records our UID keeps it', async () => {
    for (const [state, sameUid, deleted] of [['finalizing', true, false], ['starting', true, false], ['completed', true, false], ['stopping', true, true], ['terminated', true, true], ['finalizing', false, true]] as const) {
      const a = e.newRunner({ ownPool: true });
      const s = await e.newStage(e.a);
      const hold = a.faults.holdAt('runner.after_job_create');
      const pending = start(a, s);
      await hold.reached;
      const row = await alloc(s);
      const held = [...a.kube.jobs.values()][0] as NonNullable<ReturnType<typeof a.kube.jobs.get>>;
      await setState(row.id, state, sameUid ? held.metadata.uid : 'some-other-uid');
      hold.release();
      await pending;
      expect(a.kube.jobs.has(held.metadata.name), `${state} / ${sameUid ? 'our UID' : 'another UID'}`).toBe(!deleted);
    }
  });

  it('the sweep covers every state but desired when the Job\'s UID is not the recorded one, and leaves the recorded Job alone', async () => {
    const inst = e.newRunner();
    for (const state of ['running', 'suspect', 'finalizing', 'completed'] as const) {
      const s = await e.newStage(e.a);
      await start(inst, s);
      const a = await alloc(s);
      await setState(a.id, state);
      expect(await inst.runner.sweepJobs()).toBe(0); // the recorded Job is the allocation's own
      expect(inst.kube.jobs.has(a.jobName)).toBe(true);
      const stage = await e.db.withTenant({ orgId: e.a.orgId }, (tx) => getRunnerStageRunById(tx, e.a.orgId, a.stageRunId));
      const late = renderJob({ allocation: a, stage: stage as never, workspace: undefined, request: undefined, config: inst.config });
      inst.kube.jobs.delete(a.jobName);
      await inst.kube.createJob(late); // a late create under the same name: another UID
      expect(await inst.runner.sweepJobs(), state).toBe(1);
      expect(inst.kube.jobs.has(a.jobName), state).toBe(false);
    }
  });

  it('reconcileOne\'s budget is a deadline the list calls see: a list that outlives it fails instead of paging on', async () => {
    const inst = e.newRunner();
    const s = await e.newStage(e.a);
    await start(inst, s);
    const a = await alloc(s);
    const seen: Array<AbortSignal | undefined> = [];
    const real = inst.kube.listPods.bind(inst.kube);
    inst.kube.listPods = async (sel, opts) => { seen.push(opts?.signal); await sleep(120); return real(sel, opts); };
    const t0 = performance.now();
    await expect(inst.runner.reconcileOne(e.a.orgId, a.id, 60)).rejects.toMatchObject({ status: 0, reason: 'Timeout' });
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(seen[0]).toBeDefined();
    expect(seen[0]?.aborted).toBe(true);
    // Control: with room the same pass completes.
    inst.kube.listPods = real;
    await expect(inst.runner.reconcileOne(e.a.orgId, a.id, 5000)).resolves.toBeUndefined();
    expect(KubeError).toBeDefined();
  });

  describe('attach compares the whole live Job spec, exactly, with the API server\'s known defaults applied', () => {
    type Rec = Record<string, unknown>;
    // What a real API server stores for our manifest: defaults filled in, generated keys added, quantities written another way.
    const withServerDefaults = (m: JobManifest): JobManifest => {
      const j = structuredClone(m) as unknown as { metadata: Rec; spec: Rec & { template: { metadata: { labels: Rec }; spec: Rec & { containers: Rec[]; initContainers?: Rec[]; volumes: Rec[] } } } };
      Object.assign(j.spec, { parallelism: 1, completions: 1, completionMode: 'NonIndexed', suspend: false, manualSelector: false, podReplacementPolicy: 'TerminatingOrFailed', selector: { matchLabels: { 'batch.kubernetes.io/controller-uid': 'uid-1' } } });
      Object.assign(j.spec.template.metadata.labels, { 'controller-uid': 'uid-1', 'job-name': 'j', 'batch.kubernetes.io/controller-uid': 'uid-1', 'batch.kubernetes.io/job-name': 'j' });
      const ps = j.spec.template.spec;
      Object.assign(ps, { dnsPolicy: 'ClusterFirst', schedulerName: 'default-scheduler', serviceAccount: ps['serviceAccountName'] });
      const q: Record<string, string> = { '100m': '0.1', '1': '1000m', '128Mi': '131072Ki', '512Mi': '536870912', '64Mi': '65536Ki', '1Gi': '1024Mi' };
      for (const c of [...(ps.initContainers ?? []), ...ps.containers]) {
        Object.assign(c, { imagePullPolicy: 'IfNotPresent', terminationMessagePath: '/dev/termination-log' });
        for (const part of Object.values(c['resources'] as Record<string, Record<string, string>>)) for (const k of Object.keys(part)) part[k] = q[part[k] as string] ?? part[k] as string;
      }
      for (const v of ps.volumes) if (v['projected']) Object.assign(v['projected'] as Rec, { defaultMode: 420 });
      return j as unknown as JobManifest;
    };
    const containers = (j: JobManifest): Rec[] => j.spec.template.spec.containers;
    const spec = (j: JobManifest): Rec => j.spec;
    const pod = (j: JobManifest): Rec => j.spec.template.spec;
    const tampers: Array<[string, (j: JobManifest) => void]> = [
      ['another service account', (j) => { j.spec.template.spec.serviceAccountName = 'cluster-admin-sa'; }],
      ['a privileged container', (j) => { (containers(j)[0]?.['securityContext'] as Rec)['privileged'] = true; }],
      ['a host path volume', (j) => { (j.spec.template.spec.volumes ?? []).push({ name: 'host', hostPath: { path: '/' } } as never); }],
      ['host networking', (j) => { pod(j)['hostNetwork'] = true; }],
      ['a manual selector (the server writes false; k3s 1.36.6, measured)', (j) => { spec(j)['manualSelector'] = true; }],
      ['another image', (j) => { (containers(j)[1] as Rec)['image'] = 'evil:latest'; }],
      ['a command', (j) => { (containers(j)[0] as Rec)['command'] = ['/bin/sh', '-c', 'exfiltrate']; }],
      ['a lifecycle hook', (j) => { (containers(j)[1] as Rec)['lifecycle'] = { postStart: { exec: { command: ['/bin/sh'] } } }; }],
      ['an exec probe', (j) => { (containers(j)[1] as Rec)['livenessProbe'] = { exec: { command: ['/bin/sh'] }, periodSeconds: 1 }; }],
      ['envFrom', (j) => { (containers(j)[0] as Rec)['envFrom'] = [{ secretRef: { name: 'everything' } }]; }],
      ['a host port', (j) => { (containers(j)[1] as Rec)['ports'] = [{ containerPort: 80, hostPort: 8080 }]; }],
      ['a working directory', (j) => { (containers(j)[0] as Rec)['workingDir'] = '/'; }],
      ['stdin and tty', (j) => { Object.assign(containers(j)[0] as Rec, { stdin: true, tty: true }); }],
      ['another termination message path', (j) => { (containers(j)[0] as Rec)['terminationMessagePath'] = '/workspace/forged'; }],
      ['a dnsConfig', (j) => { pod(j)['dnsConfig'] = { nameservers: ['10.0.0.1'] }; }],
      ['hostAliases', (j) => { pod(j)['hostAliases'] = [{ ip: '10.0.0.1', hostnames: ['metadata.internal'] }]; }],
      ['another dnsPolicy', (j) => { pod(j)['dnsPolicy'] = 'Default'; }],
      ['tolerations', (j) => { pod(j)['tolerations'] = [{ operator: 'Exists' }]; }],
      ['a nodeSelector', (j) => { pod(j)['nodeSelector'] = { 'kubernetes.io/hostname': 'control-plane' }; }],
      ['an affinity', (j) => { pod(j)['affinity'] = { nodeAffinity: {} }; }],
      ['a runtimeClassName', (j) => { pod(j)['runtimeClassName'] = 'unsandboxed'; }],
      ['a priorityClassName', (j) => { pod(j)['priorityClassName'] = 'system-node-critical'; }],
      ['imagePullSecrets', (j) => { pod(j)['imagePullSecrets'] = [{ name: 'registry' }]; }],
      ['resourceClaims', (j) => { pod(j)['resourceClaims'] = [{ name: 'gpu' }]; }],
      ['a larger resource limit', (j) => { ((containers(j)[1] as Rec)['resources'] as { limits: Rec }).limits['memory'] = '64Gi'; }],
      ['parallelism', (j) => { spec(j)['parallelism'] = 2; }],
      ['completions', (j) => { spec(j)['completions'] = 5; }],
      ['suspend', (j) => { spec(j)['suspend'] = true; }],
      ['a podFailurePolicy', (j) => { spec(j)['podFailurePolicy'] = { rules: [] }; }],
      ['managedBy', (j) => { spec(j)['managedBy'] = 'example.com/other-controller'; }],
      ['a manual selector', (j) => { Object.assign(spec(j), { manualSelector: true, selector: { matchLabels: { app: 'anything' } } }); }],
      ['a label on the pod template', (j) => { j.spec.template.metadata.labels['app'] = 'evil'; }],
      ['an annotation on the pod template', (j) => { j.spec.template.metadata.annotations['sidecar.example/inject'] = 'true'; }],
      ['another deadline', (j) => { j.spec.activeDeadlineSeconds = 1_000_000; }],
    ];
    const setup = async (inst: Instance) => {
      const s = await e.newStage(e.a);
      inst.faults.throwAt('runner.after_allocate_commit');
      await start(inst, s);
      const a = await alloc(s);
      expect(a.state).toBe('desired');
      const stage = await e.db.withTenant({ orgId: e.a.orgId }, (tx) => getRunnerStageRunById(tx, e.a.orgId, a.stageRunId));
      return { a, manifest: renderJob({ allocation: a, stage: stage as never, workspace: undefined, request: undefined, config: inst.config }) };
    };
    for (const [name, tamper] of tampers) {
      for (const defaults of [false, true]) {
        it(`an existing Job with our annotations and ${name}${defaults ? ' (as the server stores it, defaults applied)' : ''} is quarantined, and nothing attaches`, async () => {
          const inst = e.newRunner();
          const { a, manifest } = await setup(inst);
          const m = defaults ? withServerDefaults(manifest) : manifest;
          tamper(m);
          await inst.kube.createJob(m);
          await inst.runner.reconcileOne(e.a.orgId, a.id);
          expect(await e.allocation(e.a, a.id)).toMatchObject({ state: 'quarantined', jobUid: null });
        });
      }
    }
    it('an init container that restarts (a sidecar) on the materialize step is quarantined (a workspace allocation)', async () => {
      const inst = e.newRunner();
      const s = await e.newStage(e.a);
      const ws = await e.newWorkspace(e.a, s, inst);
      inst.faults.throwAt('runner.after_allocate_commit');
      await start(inst, s, ws);
      const a = await alloc(s);
      const req = await inst.workspaces.materializationRequest(e.runnerCtx(e.a), ws, 1);
      if (!req.ok) throw new Error('no request');
      const stage = await e.db.withTenant({ orgId: e.a.orgId }, (tx) => getRunnerStageRunById(tx, e.a.orgId, a.stageRunId));
      const input = { allocation: a, stage: stage as never, workspace: await e.workspace(e.a, ws), request: req.request, config: inst.config };
      const good = withServerDefaults(renderJob(input));
      const bad = withServerDefaults(renderJob(input));
      ((bad.spec.template.spec.initContainers as unknown as Rec[])[0] as Rec)['restartPolicy'] = 'Always';
      // Control first: the honest Job with the server's defaults applied (init container and claim included) attaches.
      await inst.kube.createPvc(renderPvc(input));
      await inst.kube.createJob(good);
      await inst.runner.reconcileOne(e.a.orgId, a.id);
      expect((await e.allocation(e.a, a.id)).state).toBe('starting');
      const s2 = await e.newStage(e.a);
      const ws2 = await e.newWorkspace(e.a, s2, inst);
      inst.faults.throwAt('runner.after_allocate_commit');
      await start(inst, s2, ws2);
      const a2 = await alloc(s2);
      const req2 = await inst.workspaces.materializationRequest(e.runnerCtx(e.a), ws2, 1);
      if (!req2.ok) throw new Error('no request');
      const stage2 = await e.db.withTenant({ orgId: e.a.orgId }, (tx) => getRunnerStageRunById(tx, e.a.orgId, a2.stageRunId));
      const input2 = { allocation: a2, stage: stage2 as never, workspace: await e.workspace(e.a, ws2), request: req2.request, config: inst.config };
      const evil = withServerDefaults(renderJob(input2));
      ((evil.spec.template.spec.initContainers as unknown as Rec[])[0] as Rec)['restartPolicy'] = 'Always';
      await inst.kube.createPvc(renderPvc(input2));
      await inst.kube.createJob(evil);
      await inst.runner.reconcileOne(e.a.orgId, a2.id);
      expect((await e.allocation(e.a, a2.id)).state).toBe('quarantined');
      expect(bad).toBeDefined();
    });
    it('control: an existing Job with exactly the rendered template attaches, and so does the same Job as the server stores it (defaults, generated keys, other spellings of the same quantities)', async () => {
      for (const defaults of [false, true]) {
        const inst = e.newRunner();
        const { a, manifest } = await setup(inst);
        await inst.kube.createJob(defaults ? withServerDefaults(manifest) : manifest);
        await inst.runner.reconcileOne(e.a.orgId, a.id);
        expect((await e.allocation(e.a, a.id)).state, defaults ? 'with defaults' : 'exact').toBe('starting');
      }
    });
    it('quantities are compared as numbers (0.5 is 500m, 1Gi is 1024Mi) and templateDifferences names what differs', () => {
      expect(quantityValue('0.5')).toBe(quantityValue('500m'));
      expect(quantityValue('1Gi')).toBe(quantityValue('1024Mi'));
      expect(quantityValue('512Mi')).toBe(536_870_912);
      expect(quantityValue('1')).not.toBe(quantityValue('1m'));
      expect(quantityValue('lots')).toBeUndefined();
      const m = renderJob({ allocation, stage: fixedStage, workspace: fixedWorkspace, request: fixedRequest, config: fixedConfig });
      expect(templateDifferences(withServerDefaults(m), m)).toEqual([]);
      const t = withServerDefaults(m);
      (containers(t)[0] as Rec)['command'] = ['x'];
      expect(templateDifferences(t, m)).toEqual(['spec.template.spec.containers[0].command']);
    });
  });

  it('the Job disables service links; production configuration needs pinned images and bound identities and cannot be given a test switch', () => {
    const digest = `registry.example/factory-supervisor@sha256:${'c'.repeat(64)}`;
    const base = { runnerIdentity: 'r', controlPlaneIdentities: ['c'], identityOrgs: { c: randomUUID() } };
    const pinned = { supervisor: digest, harness: digest, materializer: digest };
    expect(() => createConfig(base)).toThrow(/pinned by an @sha256 digest/);
    expect(() => createConfig({ ...base, images: { ...pinned, materializer: 'registry.example/m:latest' } })).toThrow(/image materializer/);
    expect(() => createConfig({ ...base, images: pinned })).not.toThrow();
    expect(() => createConfig({ runnerIdentity: 'r', controlPlaneIdentities: ['c'], images: pinned })).toThrow(/bound to an organization/); // an identity with no organization
    expect(() => createConfig({ ...base, images: pinned, allowUnpinnedImages: true } as never)).toThrow(/test switches are not accepted/);
    expect(() => createTestConfig({ runnerIdentity: 'r', controlPlaneIdentities: ['c'] })).not.toThrow(); // the test factory: unpinned, unbound
    expect(renderJob({ allocation, stage: fixedStage, workspace: fixedWorkspace, request: fixedRequest, config: fixedConfig }).spec.template.spec.enableServiceLinks).toBe(false);
  });

  it('production code never loads @factory/test-support (the fault hook lives in the runner), and the test configuration is reachable only from the test entry', async () => {
    const files: string[] = [];
    const walk = (d: string): void => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.ts')) files.push(p); } };
    walk(join(import.meta.dirname, '..', 'src'));
    expect(files.length).toBeGreaterThan(10);
    expect(files.filter((f) => readFileSync(f, 'utf8').includes('@factory/test-support'))).toEqual([]);
    // The test switch for the configuration is reachable only from the test entry: nothing else in src names it, and the index does not export it.
    const users = files.filter((f) => /\b(createTestConfig|buildConfig)\b/.test(readFileSync(f, 'utf8'))).map((f) => f.slice(f.indexOf('/src/') + 5)).sort();
    expect(users).toEqual(['config.ts', 'testing.ts']);
    expect(Object.keys(await import('../src/index.ts'))).not.toContain('buildConfig');
    expect(Object.keys(await import('../src/index.ts'))).not.toContain('createTestConfig');
    expect(randomUUID()).toBeDefined();
  });
});
