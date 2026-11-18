// The conformance suite (section 2, "Conformance list"): one function that registers the assertions against a
// KubeApi and a small driver (raw requests, waits and a process check that the port does not offer). The fake
// tier calls it from kube-conformance.fake.test.ts; the k3s tier (17b) calls it from kube-conformance.k8s.test.ts.
// Fake-only faults (a duplicate pod, a lost node) are not in it and are never reported as cluster evidence.
import { describe, expect, it } from 'vitest';
import type { KubeError} from '../../src/index.ts';
import { evaluateQuiescence, type ContainerSpec, type JobManifest, type KubeApi, type KubePod, type PvcManifest } from '../../src/index.ts';

export type ConformanceDriver = {
  images: { exitOnTerm: string; ignoreTerm: string; message: string; stderrFail: string; exitZero: string };
  graceMs: number;                                   // how long a pod with a TERM-ignoring container lives after a delete
  rawDeleteJob(name: string): Promise<void>;         // a Job delete with no propagation policy
  forceDeletePod(name: string): Promise<void>;       // grace 0
  isProcessAlive(podUid: string, container: string): boolean | undefined | Promise<boolean | undefined>; // the container's process, as the runtime sees it; undefined: this tier cannot say
  waitFor(what: string, cond: () => Promise<boolean>, timeoutMs: number): Promise<void>;
  advanceReviewClock(ms: number): Promise<void>;     // fake: moves the logical clock; cluster: sleeps
  mintToken(podName: string, audience: string): Promise<string>;
  expireDeadline(jobName: string): Promise<void>;    // fake: the Job controller's verdict; cluster: waits it out
  namespace: string;
  uniqueSuffix(): string;
  record(key: string, value: string): void;
  // Cluster only: does RBAC allow `as` (a service account name in the namespace) this verb on this resource? A resource of the form
  // `nonResourceURL:<path>` asks about a non-resource URL (the runner needs `get` on /openid/v1/jwks).
  // `storageclasses@<name>` asks about one named object.
  canI?(as: string, verb: string, resource: string): Promise<boolean>;
  runnerServiceAccount?: string; supervisorServiceAccount?: string;          // what a tier observed and the design does not depend on (row 9's order)
};

const SEL = (k: string, v: string): string => `${k}=${v}`;

export function registerConformance(tier: string, make: () => Promise<{ kube: KubeApi; driver: ConformanceDriver; close: () => Promise<void> }>, opts: { cluster?: boolean } = {}): void {
  describe(`Kubernetes conformance (${tier})`, () => {
    const withSubject = async (f: (s: { kube: KubeApi; driver: ConformanceDriver; run: string }) => Promise<void>): Promise<void> => {
      const s = await make();
      try { await f({ ...s, run: s.driver.uniqueSuffix() }); } finally { await s.close(); }
    };
    // Restricted pod security is enforced in the cluster's execution namespace, so the suite's pods meet it on every tier (the fake ignores it).
    const container = (name: string, image: string, over: Partial<ContainerSpec> = {}): ContainerSpec => ({ name, image, terminationMessagePolicy: 'File',
      securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] }, runAsUser: 10001, runAsGroup: 10001 }, ...over });
    const job = (ns: string, name: string, run: string, containers: ContainerSpec[], o: { init?: ContainerSpec[]; claim?: string } = {}): JobManifest => ({
      apiVersion: 'batch/v1', kind: 'Job', metadata: { name, namespace: ns, labels: { 'conf/run': run, 'conf/job': name.slice(0, 40) }, annotations: {} },
      spec: { backoffLimit: 0, activeDeadlineSeconds: 600, template: { metadata: { labels: { 'conf/run': run, 'conf/job': name.slice(0, 40) }, annotations: {} }, spec: {
        restartPolicy: 'Never', terminationGracePeriodSeconds: 15, serviceAccountName: 'factory-allocation-supervisor', automountServiceAccountToken: false, shareProcessNamespace: false, securityContext: { runAsNonRoot: true, seccompProfile: { type: 'RuntimeDefault' } },
        ...(o.init ? { initContainers: o.init } : {}), containers, volumes: o.claim ? [{ name: 'workspace', persistentVolumeClaim: { claimName: o.claim } }] : [] } } } });
    const pvc = (ns: string, name: string, run: string, mode: string): PvcManifest => ({ apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name, namespace: ns, labels: { 'conf/run': run }, annotations: {} },
      spec: { accessModes: [mode], storageClassName: 'local-path', resources: { requests: { storage: '64Mi' } } } });
    const podsOf = async (kube: KubeApi, run: string, jobName: string): Promise<KubePod[]> => (await kube.listPods(`${SEL('conf/run', run)},${SEL('conf/job', jobName.slice(0, 40))}`)).items;
    const onePod = async (kube: KubeApi, d: ConformanceDriver, run: string, jobName: string): Promise<KubePod> => {
      await d.waitFor(`a pod of ${jobName}`, async () => (await podsOf(kube, run, jobName)).length > 0, 30_000);
      return (await podsOf(kube, run, jobName))[0] as KubePod;
    };
    const running = (c: string) => (p: KubePod): boolean => p.status.containerStatuses?.find((x) => x.name === c)?.state.running !== undefined;

    it('1. a second create of a Job name is 409 AlreadyExists, and the first UID is still there', () => withSubject(async ({ kube, driver, run }) => {
      const name = `conf-${run}-1`;
      const first = await kube.createJob(job(driver.namespace, name, run, [container('c', driver.images.exitOnTerm)]));
      const err = await kube.createJob(job(driver.namespace, name, run, [container('c', driver.images.exitOnTerm)])).catch((e: unknown) => e as KubeError);
      expect(err).toMatchObject({ status: 409, reason: 'AlreadyExists' });
      expect((await kube.getJob(name)).metadata.uid).toBe(first.metadata.uid);
    }));

    it('2. a 63-byte name is accepted and a 64-byte one refused', () => withSubject(async ({ kube, driver, run }) => {
      const pad = (n: number): string => `conf-${run}-`.padEnd(n, 'x');
      await expect(kube.createJob(job(driver.namespace, pad(63), run, [container('c', driver.images.exitOnTerm)]))).resolves.toBeDefined();
      await expect(kube.createJob(job(driver.namespace, pad(64), run, [container('c', driver.images.exitOnTerm)]))).rejects.toMatchObject({ status: 422 });
    }));

    it('3. a Job delete with Background ends its pods; control: a raw delete with no policy leaves the pod running with no owner', () => withSubject(async ({ kube, driver, run }) => {
      const a = `conf-${run}-3a`; const b = `conf-${run}-3b`;
      const ja = await kube.createJob(job(driver.namespace, a, run, [container('c', driver.images.exitOnTerm)]));
      const jb = await kube.createJob(job(driver.namespace, b, run, [container('c', driver.images.exitOnTerm)]));
      const pa = await onePod(kube, driver, run, a); const pb = await onePod(kube, driver, run, b);
      await driver.waitFor('both running', async () => { const x = await podsOf(kube, run, a); const y = await podsOf(kube, run, b); return x.some(running('c')) && y.some(running('c')); }, 30_000);
      await kube.deleteJob(a, ja.metadata.uid);
      await driver.waitFor('the Background delete ends the pod', async () => (await podsOf(kube, run, a)).length === 0, driver.graceMs + 30_000);
      await driver.rawDeleteJob(b);
      await driver.waitFor('the Job is gone', async () => kube.getJob(b).then(() => false, () => true), 10_000);
      await new Promise((r) => setTimeout(r, 300));
      const left = (await podsOf(kube, run, b))[0];
      expect(left?.metadata.uid).toBe(pb.metadata.uid);                                          // the orphan is still there...
      expect(left?.metadata.ownerReferences ?? []).toHaveLength(0);                                // ...with no owner
      expect(left?.status.phase).toBe('Running');                                                  // ...and still running
      expect(pa.metadata.uid).not.toBe(pb.metadata.uid);
      expect(jb.metadata.uid).toBeDefined();
      await kube.deletePod(pb.metadata.name, pb.metadata.uid);
    }));

    it('4. TERM reaches both containers at once: the one that exits is gone from the runtime while the pod is still listed with a deletion timestamp, and the pod goes when the other is killed', () => withSubject(async ({ kube, driver, run }) => {
      const name = `conf-${run}-4`;
      await kube.createJob(job(driver.namespace, name, run, [container('polite', driver.images.exitOnTerm), container('stubborn', driver.images.ignoreTerm)]));
      const pod = await onePod(kube, driver, run, name);
      await driver.waitFor('both running', async () => { const p = (await podsOf(kube, run, name))[0]; return p !== undefined && running('polite')(p) && running('stubborn')(p); }, 30_000);
      const t0 = Date.now();
      await kube.deletePod(pod.metadata.name, pod.metadata.uid);
      // What the runtime shows: the polite process is gone at once (TERM reached both), the stubborn one is not (TERM ignored).
      // "At once": within about 3 s, long before the other container's grace period could have ended it. A runtime that cannot be asked
      // (an undefined answer) is a failure, not a pass.
      await driver.waitFor('the polite process has exited (answer exactly false)', async () => (await driver.isProcessAlive(pod.metadata.uid, 'polite')) === false, 3000);
      const mid = (await podsOf(kube, run, name))[0];
      expect(mid?.metadata.deletionTimestamp).toBeDefined();                                       // still listed, Terminating
      expect(mid?.status.containerStatuses?.find((c) => c.name === 'stubborn')?.state.terminated).toBeUndefined();
      const polite = await driver.isProcessAlive(pod.metadata.uid, 'polite');
      const stubborn = await driver.isProcessAlive(pod.metadata.uid, 'stubborn');
      expect(polite).toBe(false);
      expect(stubborn).toBe(true);                                                                // control: TERM did not end the one that ignores it
      driver.record('row4.runtime_polite_alive', String(polite)); driver.record('row4.runtime_stubborn_alive', String(stubborn));
      // What the API shows differs by tier, and the proof is safe either way: it reads a Terminating pod as "not finished" until it is gone.
      // k3s 1.36.6 keeps the polite container `running` in the pod status until the pod is gone; the fake publishes the exit.
      driver.record('row4.polite_status_while_terminating', mid?.status.containerStatuses?.find((c) => c.name === 'polite')?.state.terminated !== undefined ? 'terminated' : 'running');
      await driver.waitFor('the pod is gone', async () => (await podsOf(kube, run, name)).length === 0, driver.graceMs + 30_000);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(driver.graceMs * 0.5);                      // not before the grace period had run (about)
    }));

    it('5. a second pod on a ReadWriteOncePod claim stays Pending; control: on ReadWriteOnce both run', () => withSubject(async ({ kube, driver, run }) => {
      for (const [mode, bothRun] of [['ReadWriteOncePod', false], ['ReadWriteOnce', true]] as const) {
        const claim = `conf-${run}-5-${mode.toLowerCase()}`;
        await kube.createPvc(pvc(driver.namespace, claim, run, mode));
        const j1 = `${claim}-a`; const j2 = `${claim}-b`;
        await kube.createJob(job(driver.namespace, j1, run, [container('c', driver.images.exitOnTerm)], { claim }));
        await driver.waitFor('first running', async () => (await podsOf(kube, run, j1)).some(running('c')), 30_000);
        await kube.createJob(job(driver.namespace, j2, run, [container('c', driver.images.exitOnTerm)], { claim }));
        await onePod(kube, driver, run, j2);
        if (bothRun) await driver.waitFor('second running', async () => (await podsOf(kube, run, j2)).some(running('c')), 30_000);
        else { await new Promise((r) => setTimeout(r, 500)); expect((await podsOf(kube, run, j2))[0]?.status.phase).toBe('Pending'); }
      }
    }));

    it('6. a claim with no pod stays Pending; it binds once a pod is scheduled', () => withSubject(async ({ kube, driver, run }) => {
      const claim = `conf-${run}-6`;
      await kube.createPvc(pvc(driver.namespace, claim, run, 'ReadWriteOncePod'));
      await new Promise((r) => setTimeout(r, 300));
      expect((await kube.getPvc(claim)).status.phase).toBe('Pending');
      await kube.createJob(job(driver.namespace, claim, run, [container('c', driver.images.exitOnTerm)], { claim }));
      await driver.waitFor('bound', async () => (await kube.getPvc(claim)).status.phase === 'Bound', 30_000);
    }));

    it('7. a claim with no owner reference survives its Job\'s delete; deleted while in use it stays, with a deletion timestamp, until the pod is gone', () => withSubject(async ({ kube, driver, run }) => {
      const claim = `conf-${run}-7`;
      const c = await kube.createPvc(pvc(driver.namespace, claim, run, 'ReadWriteOncePod'));
      const j = await kube.createJob(job(driver.namespace, claim, run, [container('c', driver.images.exitOnTerm)], { claim }));
      await driver.waitFor('running', async () => (await podsOf(kube, run, claim)).some(running('c')), 30_000);
      await kube.deletePvc(claim, c.metadata.uid);
      expect((await kube.getPvc(claim)).metadata.deletionTimestamp).toBeDefined();               // in use: stays, Terminating
      await kube.deleteJob(claim, j.metadata.uid);
      await driver.waitFor('the pod is gone', async () => (await podsOf(kube, run, claim)).length === 0, driver.graceMs + 30_000);
      await driver.waitFor('the claim is gone', async () => kube.getPvc(claim).then(() => false, () => true), 30_000);
      // The first half: a claim that is not in use is untouched by a Job delete.
      const keep = `conf-${run}-7k`;
      await kube.createPvc(pvc(driver.namespace, keep, run, 'ReadWriteOncePod'));
      const jk = await kube.createJob(job(driver.namespace, keep, run, [container('c', driver.images.exitZero)], { claim: keep }));
      await driver.waitFor('finished', async () => (await podsOf(kube, run, keep)).every((p) => p.status.phase === 'Succeeded'), 30_000);
      await kube.deleteJob(keep, jk.metadata.uid);
      await driver.waitFor('the pod is gone', async () => (await podsOf(kube, run, keep)).length === 0, driver.graceMs + 30_000); // the Job delete has finished its work...
      expect((await kube.getPvc(keep)).metadata.uid).toBeDefined();   // ...and the claim, which had no owner reference, is still there
      expect((await kube.getPvc(keep)).metadata.ownerReferences ?? []).toHaveLength(0);
    }));

    it('8. a delete with a wrong UID is 409 Conflict; a precondition on an absent object is 404', () => withSubject(async ({ kube, driver, run }) => {
      const name = `conf-${run}-8`;
      const j = await kube.createJob(job(driver.namespace, name, run, [container('c', driver.images.exitOnTerm)]));
      await expect(kube.deleteJob(name, '00000000-0000-4000-8000-00000000dead')).rejects.toMatchObject({ status: 409, reason: 'Conflict' });
      expect((await kube.getJob(name)).metadata.uid).toBe(j.metadata.uid);                       // control: the Job is still there
      await kube.deleteJob(name, j.metadata.uid);
      await expect(kube.deleteJob(name, j.metadata.uid)).rejects.toMatchObject({ status: 404 });
    }));

    it('9. after its pod is deleted a backoffLimit 0 Job gets no replacement pod', () => withSubject(async ({ kube, driver, run }) => {
      const name = `conf-${run}-9`;
      // The container ignores TERM, so its process lives for the whole grace period and the proof has something to stay unproved about.
      await kube.createJob(job(driver.namespace, name, run, [container('c', driver.images.ignoreTerm)]));
      const pod = await onePod(kube, driver, run, name);
      await driver.waitFor('running', async () => (await podsOf(kube, run, name)).some(running('c')), 30_000);
      await kube.deletePod(pod.metadata.name, pod.metadata.uid);
      // Record which the cluster shows first: the Job's Failed condition or the container's exit. The proof reads pod status, so
      // the design does not depend on the answer; the answer is recorded for the k3s run's build-log line.
      const seen: string[] = [];
      const t0 = Date.now();
      let gone = false;
      let checked = 0;
      while (!gone && Date.now() - t0 < driver.graceMs + 30_000) {
        const pods = await podsOf(kube, run, name);
        // The proof (as if the Job were absent) reads pod status only. While the process is still alive, it must stay unproved at every
        // poll, whichever of the Job's Failed and the container's exit the cluster shows first. The pods are read BEFORE the process, so a
        // process alive now was alive then.
        const alive = await driver.isProcessAlive(pod.metadata.uid, 'c');
        if (alive === true) {
          expect(evaluateQuiescence({ jobAbsent: true, pods, podsTruncated: false, jobUidRecorded: true, stoppingForMs: 60_000, requestDeadlineMs: 10_000 }).proved, 'the proof stays unproved while the process lives').toBe(false);
          checked += 1;
        }
        gone = pods.length === 0;
        const exited = pods.some((p) => p.status.containerStatuses?.some((c) => c.state.terminated !== undefined));
        const failed = ((await kube.getJob(name)).status.conditions ?? []).some((c) => c.type === 'Failed');
        if (failed && !seen.includes('job_failed')) seen.push('job_failed');
        if (exited && !seen.includes('container_exit')) seen.push('container_exit');
        if (!gone) await new Promise((r) => setTimeout(r, 20));
      }
      expect(gone).toBe(true);
      expect(checked, 'the unproved-while-alive assertion ran at least once').toBeGreaterThan(0);
      expect(evaluateQuiescence({ jobAbsent: true, pods: [], podsTruncated: false, jobUidRecorded: true, stoppingForMs: 60_000, requestDeadlineMs: 10_000 }).proved).toBe(true); // control: with the pod gone it is proved
      await new Promise((r) => setTimeout(r, 1500));
      expect(await podsOf(kube, run, name)).toHaveLength(0);                                     // no replacement
      const order = seen.length === 0 ? 'neither_observed_before_the_pod_went' : seen.join('_then_');
      driver.record('row9.order', order);
      expect(['neither_observed_before_the_pod_went', 'job_failed', 'container_exit', 'job_failed_then_container_exit', 'container_exit_then_job_failed']).toContain(order); // recorded, not asserted: the design does not depend on the order
    }));

    it('10. File policy: an init container\'s message and exit code are in the pod status while the app containers run; a longer message is cut at 4,096 bytes; a failed step that wrote only to its log has an empty message', () => withSubject(async ({ kube, driver, run }) => {
      const ok = `conf-${run}-10a`;
      await kube.createJob(job(driver.namespace, ok, run, [container('app', driver.images.exitOnTerm)], { init: [container('materialize', driver.images.message, { args: ['{"hello":"world"}'] })] }));
      await driver.waitFor('app running', async () => (await podsOf(kube, run, ok)).some(running('app')), 30_000);
      const st = (await podsOf(kube, run, ok))[0]?.status.initContainerStatuses?.[0]?.state.terminated;
      expect(st).toMatchObject({ exitCode: 0, message: '{"hello":"world"}' });
      const long = `conf-${run}-10b`;
      await kube.createJob(job(driver.namespace, long, run, [container('app', driver.images.exitOnTerm)], { init: [container('materialize', driver.images.message, { args: ['x'.repeat(5000)] })] }));
      await driver.waitFor('long app running', async () => (await podsOf(kube, run, long)).some(running('app')), 30_000);
      expect(Buffer.byteLength((await podsOf(kube, run, long))[0]?.status.initContainerStatuses?.[0]?.state.terminated?.message ?? '')).toBe(4096);
      const bad = `conf-${run}-10c`;
      await kube.createJob(job(driver.namespace, bad, run, [container('app', driver.images.exitOnTerm)], { init: [container('materialize', driver.images.stderrFail, { args: ['fatal: no such remote'] })] }));
      await driver.waitFor('failed', async () => (await podsOf(kube, run, bad))[0]?.status.initContainerStatuses?.[0]?.state.terminated !== undefined, 30_000);
      const failed = (await podsOf(kube, run, bad))[0]?.status.initContainerStatuses?.[0]?.state.terminated;
      expect(failed?.exitCode).toBe(1);
      expect(failed?.message ?? '').toBe('');                                                    // File: the log line never arrives as a message
      // Control: under the fallback policy the same step's stderr line does arrive, which is why the policy is pinned.
      const fb = `conf-${run}-10d`;
      await kube.createJob(job(driver.namespace, fb, run, [container('app', driver.images.exitOnTerm)], { init: [container('materialize', driver.images.stderrFail, { args: ['fatal: no such remote'], terminationMessagePolicy: 'FallbackToLogsOnError' })] }));
      await driver.waitFor('fallback failed', async () => (await podsOf(kube, run, fb))[0]?.status.initContainerStatuses?.[0]?.state.terminated !== undefined, 30_000);
      expect((await podsOf(kube, run, fb))[0]?.status.initContainerStatuses?.[0]?.state.terminated?.message).toContain('fatal: no such remote');
    }));

    it('11. a token bound to a pod with audience A reviews as authenticated for A, lists A, and names the pod; it fails for B and for none; after the pod is gone a token reviewed just before still passes briefly and one never reviewed fails at once', () => withSubject(async ({ kube, driver, run }) => {
      const name = `conf-${run}-11`;
      await kube.createJob(job(driver.namespace, name, run, [container('c', driver.images.exitOnTerm)]));
      const pod = await onePod(kube, driver, run, name);
      const aud = `factory-allocation:o:${run}`;
      const token = await driver.mintToken(pod.metadata.name, aud);
      const ok = await kube.reviewToken(token, [aud]);
      expect(ok.authenticated).toBe(true);
      expect(ok.audiences).toContain(aud);
      expect(ok.user?.extra?.['authentication.kubernetes.io/pod-name']).toEqual([pod.metadata.name]);
      expect(ok.user?.extra?.['authentication.kubernetes.io/pod-uid']).toEqual([pod.metadata.uid]);
      expect((await kube.reviewToken(token, ['factory-allocation:o:other'])).authenticated).toBe(false);
      expect((await kube.reviewToken(token, [])).authenticated).toBe(false);
      const unreviewed = await driver.mintToken(pod.metadata.name, aud);
      await driver.waitFor('running', async () => (await podsOf(kube, run, name)).some(running('c')), 30_000);
      await kube.deletePod(pod.metadata.name, pod.metadata.uid);
      await driver.waitFor('gone', async () => (await podsOf(kube, run, name)).length === 0, driver.graceMs + 30_000);
      expect((await kube.reviewToken(unreviewed, [aud])).authenticated).toBe(false);             // never reviewed: refused at once
      expect((await kube.reviewToken(token, [aud])).authenticated).toBe(true);                    // reviewed just before: still passes for a few seconds
      await driver.advanceReviewClock(30_000);
      expect((await kube.reviewToken(token, [aud])).authenticated).toBe(false);                   // within 30 s it is refused
    }));

    it('12. activeDeadlineSeconds ends the pod and the Job reports DeadlineExceeded', () => withSubject(async ({ kube, driver, run }) => {
      const name = `conf-${run}-12`;
      await kube.createJob(job(driver.namespace, name, run, [container('c', driver.images.exitOnTerm)]));
      await onePod(kube, driver, run, name);
      await driver.expireDeadline(name);
      await driver.waitFor('the Job failed', async () => (await kube.getJob(name)).status.conditions?.some((c) => c.type === 'Failed' && c.reason === 'DeadlineExceeded') === true, 90_000);
      await driver.waitFor('the pod ended', async () => (await podsOf(kube, run, name)).every((p) => p.status.phase !== 'Running'), driver.graceMs + 30_000);
    }));

    it('14. (driver only) a force delete removes the pod object at once while its process is still alive; this is why the port has no grace parameter', () => withSubject(async ({ kube, driver, run }) => {
      const name = `conf-${run}-14`;
      await kube.createJob(job(driver.namespace, name, run, [container('c', driver.images.ignoreTerm)]));
      const pod = await onePod(kube, driver, run, name);
      await driver.waitFor('running', async () => (await podsOf(kube, run, name)).some(running('c')), 30_000);
      await driver.forceDeletePod(pod.metadata.name);
      // A Job's pod carries the Job controller's tracking finalizer, so on k3s the object lingers for a moment (marked for deletion)
      // until the controller lets it go; the fake removes it at once. Either way the object goes and the process is still there.
      await driver.waitFor('the pod object is gone', async () => !(await podsOf(kube, run, name)).some((p) => p.metadata.uid === pod.metadata.uid), 10_000);
      const alive = await driver.isProcessAlive(pod.metadata.uid, 'c');
      expect(alive).toBe(true);                                                                   // ...the process is not (an undefined answer fails)
      driver.record('row14.runtime_alive_after_object_gone', String(alive));
      // Whether the Job controller starts a replacement pod after a force delete (backoffLimit 0; a normal delete, row 9, gets none)
      // is recorded, not asserted: the design does not depend on it, and a duplicate pod is handled by the writer claim either way.
      await new Promise((r) => setTimeout(r, 1500));
      driver.record('row14.replacement_pod', String((await podsOf(kube, run, name)).length > 0));
    }));

    // Rows 13 and 15 are about the cluster's RBAC and exist only where there is one (the k3s tier, 17b); the fake registers neither.
    if (opts.cluster === true) {
      it('13. every call the suite makes succeeds under the runner\'s Role; the supervisor\'s service account is refused a patch of pods/status and a read of any pod', () => withSubject(async ({ driver }) => {
        const can = driver.canI?.bind(driver);
        if (!can || !driver.runnerServiceAccount || !driver.supervisorServiceAccount) throw new Error('a cluster driver supplies canI and the two service account names');
        for (const [verb, res] of [['create', 'jobs'], ['get', 'jobs'], ['list', 'jobs'], ['delete', 'jobs'], ['get', 'pods'], ['list', 'pods'], ['delete', 'pods'], ['create', 'persistentvolumeclaims'], ['get', 'persistentvolumeclaims'], ['list', 'persistentvolumeclaims'], ['delete', 'persistentvolumeclaims'], ['create', 'tokenreviews'], ['get', 'storageclasses@local-path'], ['get', 'nonResourceURL:/openid/v1/jwks']] as const) {
          expect(await can(driver.runnerServiceAccount, verb, res), `runner ${verb} ${res}`).toBe(true);
        }
        expect(await can(driver.runnerServiceAccount, 'get', 'storageclasses@some-other-class')).toBe(false); // the read is limited to the configured class
        expect(await can(driver.runnerServiceAccount, 'patch', 'pods/status')).toBe(false);
        expect(await can(driver.supervisorServiceAccount, 'patch', 'pods/status')).toBe(false);
        expect(await can(driver.supervisorServiceAccount, 'get', 'pods')).toBe(false);
      }));

      it('15. deployment invariant: only the runner\'s service account and the Job controller create Jobs, pods and claims in the execution namespace, and nothing else may use the supervisor\'s service account', () => withSubject(async ({ driver }) => {
        const can = driver.canI?.bind(driver);
        if (!can || !driver.runnerServiceAccount || !driver.supervisorServiceAccount) throw new Error('a cluster driver supplies canI and the two service account names');
        for (const other of [driver.supervisorServiceAccount, 'default']) {
          for (const res of ['jobs', 'pods', 'persistentvolumeclaims']) expect(await can(other, 'create', res), `${other} create ${res}`).toBe(false);
          expect(await can(other, 'create', 'serviceaccounts/token'), `${other} may not mint tokens for the supervisor account`).toBe(false);
        }
        expect(await can(driver.runnerServiceAccount, 'create', 'pods')).toBe(false); // the runner creates Jobs; the Job controller creates their pods
        expect(await can(driver.runnerServiceAccount, 'create', 'serviceaccounts/token')).toBe(false);
        expect(await can(driver.runnerServiceAccount, 'create', 'jobs')).toBe(true);
      }));
    }
  });
}
