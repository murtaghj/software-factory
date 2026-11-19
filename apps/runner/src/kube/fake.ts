// FakeKube: an in-memory KubeApi with fault controls and a test driver (section 5, "FakeKube"). It models
// the behaviours of the section 2 conformance list: the two 409s, 63-byte names, label selection, UID
// preconditions, a Job delete that orphans pods unless Background is sent (the port always sends it), the
// access modes, WaitForFirstConsumer, PVC protection while a pod uses the claim, token review bound to a
// pod and an audience with a short memory of successes, termination messages cut at 4,096 bytes under the
// File policy, and activeDeadlineSeconds. Time is a logical clock the test advances; nothing sleeps.
//
// The driver (not the port) can do two things the port cannot: a raw Job delete with no propagation policy
// and a force delete of a pod. Both behave as on a cluster.
import { generateKeyPairSync, randomUUID, sign as cryptoSign, type KeyObject } from 'node:crypto';
import {
  KubeError, LIST_MAX_PAGES, LIST_PAGE_SIZE,
  type ContainerStatus, type Jwks, type JobManifest, type KubeApi, type ListOptions, type KubeJob, type KubePod, type KubePvc, type ListResult, type PodPhase, type PvcManifest, type StorageClassInfo, type KubeNode, type ApiServiceInfo, type TokenReviewResult,
} from './api.ts';

export const TERMINATION_MESSAGE_CAP = 4096;
export const REVIEW_MEMORY_MS = 10_000;
const MAX_NAME = 63;
const MAX_LABEL_VALUE = 63;
const EPOCH_MS = Date.UTC(2026, 0, 1);

// The kubelet side: the fake kubelet implements it, and calls back into the driver as containers start and exit.
export interface PodRuntime {
  // Does any process of the pod still run? A pod is never removed from the cluster while this is true, whatever
  // the container statuses say (a container reads `waiting` until its process has said it is ready).
  hasLiveProcesses(podUid: string): boolean;
  onPodScheduled(pod: KubePod): void;
  onPodDeleting(pod: KubePod, graceMs: number): void;
  // STOP or CONT for one container's process group (W-019: a paused supervisor is not a dead one).
  signalContainer?(podUid: string, container: string, sig: 'SIGSTOP' | 'SIGCONT'): void;
}

type Match = (labels: Record<string, string>) => boolean;
export function parseSelector(selector: string): Match {
  const terms = selector === '' ? [] : selector.split(',').map((t) => t.trim());
  const tests = terms.map((t): Match => {
    const ne = /^([^!=]+)!=(.*)$/.exec(t);
    if (ne) return (l) => l[ne[1] ?? ''] !== ne[2];
    const eq = /^([^!=]+)==?(.*)$/.exec(t);
    if (eq) return (l) => l[eq[1] ?? ''] === eq[2];
    if (t.startsWith('!')) return (l) => !(t.slice(1) in l);
    return (l) => t in l;
  });
  return (l) => tests.every((f) => f(l));
}

type TokenBinding = { podName: string; podUid: string; audience: string; serviceAccount: string; reviewedAt: number | undefined };
type CallFault = { method: string; error: Error; times: number };

const clone = <T>(v: T): T => structuredClone(v);

// One signing key for every fake cluster in the process (key generation is slow): the cluster's service-account issuer.
let signing: { priv: KeyObject; pub: KeyObject; kid: string } | undefined;
const keyPair = (): { priv: KeyObject; pub: KeyObject; kid: string } => {
  if (!signing) { const k = generateKeyPairSync('ec', { namedCurve: 'P-256' }); signing = { priv: k.privateKey, pub: k.publicKey, kid: 'fake-sa-key-1' }; }
  return signing;
};
type SigningKey = { priv: KeyObject; pub: KeyObject; kid: string };
const b64 = (b: Buffer | string): string => Buffer.from(b).toString('base64url');
export const wallSeconds = (): number => Math.floor(new Date().getTime() / 1000);

export class FakeKube implements KubeApi {
  readonly namespace: string;
  readonly driver: FakeDriver;
  // Every call, by method name and object, for "the fake saw no request" and for before/after comparison.
  readonly calls: string[] = [];
  readonly writes: string[] = [];
  readonly jobs = new Map<string, KubeJob>();
  readonly pods = new Map<string, KubePod>();
  readonly pvcs = new Map<string, KubePvc>();
  readonly storageClasses = new Map<string, StorageClassInfo>([['local-path', { name: 'local-path', reclaimPolicy: 'Delete', volumeBindingMode: 'WaitForFirstConsumer' }]]);
  readonly tokens = new Map<string, TokenBinding>();
  // One node by default; a pod is given its name when it is scheduled. `driver.loseNode` removes one with its pod objects.
  readonly nodes = new Map<string, KubeNode>([['fake-node-1', { name: 'fake-node-1', uid: 'fake-node-uid-1' }]]);
  apiService: ApiServiceInfo = { address: '10.96.0.1', port: 443 };
  readonly scheduled = new Set<string>(); // pod uids that hold a node
  readonly created = { jobs: 0, pvcs: 0 };  // successful creates (a create that answered AlreadyExists is not one)
  jwksCalls = 0;
  #rotated: SigningKey[] | undefined; // after a rotation: the keys the cluster publishes, newest last
  #current: SigningKey | undefined;
  // A new signing key: tokens minted from now on carry its key id. With `keepOld` (the default) the old key stays published.
  rotateSigningKey(o: { keepOld?: boolean } = {}): string {
    const k = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const next: SigningKey = { priv: k.privateKey, pub: k.publicKey, kid: `fake-sa-key-${String((this.#rotated?.length ?? 1) + 1)}` };
    this.#rotated = [...((o.keepOld ?? true) ? (this.#rotated ?? [keyPair()]) : []), next];
    this.#current = next;
    return next.kid;
  }
  readonly #callFaults: CallFault[] = [];
  readonly #dieAfter = new Set<string>();
  runtime: PodRuntime | undefined;
  clockMs = 0;
  delayDeletes = false;
  listOrder: 'forward' | 'reverse' = 'forward'; // two controllers need not read a list in the same order
  reviewIgnoresAudiences = false;
  autoPod = true;
  #podCounter = 0;
  #tokenCounter = 0;

  constructor(opts: { namespace?: string } = {}) {
    this.namespace = opts.namespace ?? 'factory-exec-local';
    this.driver = new FakeDriver(this);
  }

  now(): string { return new Date(EPOCH_MS + this.clockMs).toISOString(); }

  // ---------------------------------------------------------------- fault controls
  failNext(method: string, error: Error, times = 1): void { this.#callFaults.push({ method, error, times }); }
  // The call is applied, then fails with an unknown outcome: "die after a create and before the answer".
  dieAfter(method: string): void { this.#dieAfter.add(method); }
  #enter(method: string, target: string, write: boolean): void {
    this.calls.push(`${method} ${target}`);
    if (write) this.writes.push(`${method} ${target}`);
    const f = this.#callFaults.find((x) => x.method === method);
    if (f) { f.times -= 1; if (f.times <= 0) this.#callFaults.splice(this.#callFaults.indexOf(f), 1); throw f.error; }
  }
  #leave(method: string): void {
    if (this.#dieAfter.delete(method)) throw new KubeError(0, 'Timeout', `${method}: no answer (the request may have been applied)`);
  }

  #deadline(opts: ListOptions): void { if (opts.signal?.aborted === true) throw new KubeError(0, 'Timeout', 'the pass deadline ended the list'); }

  // ---------------------------------------------------------------- validation
  #checkName(kind: string, name: string): void {
    if (Buffer.byteLength(name) > MAX_NAME) throw new KubeError(422, 'Invalid', `${kind} name ${name} is longer than ${String(MAX_NAME)} bytes`);
    if (!/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/.test(name)) throw new KubeError(422, 'Invalid', `${kind} name ${name} is not a valid DNS label`);
  }
  #checkLabels(labels: Record<string, string>): void {
    for (const [k, v] of Object.entries(labels)) if (Buffer.byteLength(v) > MAX_LABEL_VALUE) throw new KubeError(422, 'Invalid', `label ${k} value is longer than ${String(MAX_LABEL_VALUE)} bytes`);
  }
  #ns(ns: string): void { if (ns !== this.namespace) throw new KubeError(404, 'NotFound', `namespace ${ns} not found`); }

  // ---------------------------------------------------------------- jobs
  createJob(job: JobManifest): Promise<KubeJob> {
    return this.#run(() => {
      this.#enter('createJob', job.metadata.name, true);
      this.#ns(job.metadata.namespace);
      this.#checkName('Job', job.metadata.name);
      this.#checkLabels(job.metadata.labels);
      this.#checkLabels(job.spec.template.metadata.labels);
      if (this.jobs.has(job.metadata.name)) throw new KubeError(409, 'AlreadyExists', `jobs.batch "${job.metadata.name}" already exists`);
      const created: KubeJob = { ...clone(job), metadata: { ...clone(job.metadata), uid: randomUUID(), creationTimestamp: this.now() }, status: {} };
      this.jobs.set(job.metadata.name, created);
      this.created.jobs += 1;
      if (this.autoPod) this.driver.spawnPod(created.metadata.name);
      this.#leave('createJob');
      return clone(created);
    });
  }
  getJob(name: string): Promise<KubeJob> {
    return this.#run(() => { this.#enter('getJob', name, false); return clone(this.#job(name)); });
  }
  listJobs(selector: string, opts: ListOptions = {}): Promise<ListResult<KubeJob>> {
    return this.#run(() => { this.#enter('listJobs', selector, false); this.#deadline(opts); return this.#list([...this.jobs.values()], selector); });
  }
  deleteJob(name: string, uid: string): Promise<void> {
    return this.#run(() => {
      this.#enter('deleteJob', name, true);
      const job = this.#job(name);
      if (job.metadata.uid !== uid) throw new KubeError(409, 'Conflict', `Precondition failed: UID in precondition: ${uid}, UID in object meta: ${job.metadata.uid}`);
      this.jobs.delete(name); // propagationPolicy: Background, always: the Job's pods are deleted too
      for (const p of [...this.pods.values()]) if (p.metadata.ownerReferences?.some((o) => o.kind === 'Job' && o.uid === uid)) this.#terminate(p);
      this.#leave('deleteJob');
    });
  }
  #job(name: string): KubeJob {
    const j = this.jobs.get(name);
    if (!j) throw new KubeError(404, 'NotFound', `jobs.batch "${name}" not found`);
    return j;
  }

  // ---------------------------------------------------------------- pods
  listPods(selector: string, opts: ListOptions = {}): Promise<ListResult<KubePod>> {
    return this.#run(() => { this.#enter('listPods', selector, false); this.#deadline(opts); return this.#list([...this.pods.values()], selector); });
  }
  getPod(name: string): Promise<KubePod> {
    return this.#run(() => { this.#enter('getPod', name, false); return clone(this.#pod(name)); });
  }
  deletePod(name: string, uid: string): Promise<void> {
    return this.#run(() => {
      this.#enter('deletePod', name, true);
      const pod = this.#pod(name);
      if (pod.metadata.uid !== uid) throw new KubeError(409, 'Conflict', `Precondition failed: UID in precondition: ${uid}, UID in object meta: ${pod.metadata.uid}`);
      this.#terminate(pod); // grace is always 15 s
      this.#leave('deletePod');
    });
  }
  #pod(name: string): KubePod {
    const p = this.pods.get(name);
    if (!p) throw new KubeError(404, 'NotFound', `pods "${name}" not found`);
    return p;
  }

  // The kubelet's side of a delete: the pod stays visible with a deletion timestamp until every container has exited.
  #terminate(pod: KubePod): void {
    pod.metadata.deletionTimestamp ??= this.now();
    // A held delete (W-019, `ac-12`): the pod is Terminating and the kubelet has not been told yet, so nothing in it has received TERM (a partitioned or paused node).
    if (this.delayDeletes) return;
    if (this.runtime) { this.runtime.onPodDeleting(clone(pod), 15_000); this.driver.settleIfStopped(pod.metadata.uid); return; }
    this.driver.killContainers(pod, 143);
    this.driver.removePod(pod.metadata.name);
  }

  // ---------------------------------------------------------------- claims
  createPvc(pvc: PvcManifest): Promise<KubePvc> {
    return this.#run(() => {
      this.#enter('createPvc', pvc.metadata.name, true);
      this.#ns(pvc.metadata.namespace);
      this.#checkName('PersistentVolumeClaim', pvc.metadata.name);
      this.#checkLabels(pvc.metadata.labels);
      if (this.pvcs.has(pvc.metadata.name)) throw new KubeError(409, 'AlreadyExists', `persistentvolumeclaims "${pvc.metadata.name}" already exists`);
      const created: KubePvc = { ...clone(pvc), metadata: { ...clone(pvc.metadata), uid: randomUUID(), creationTimestamp: this.now() }, status: { phase: 'Pending' } };
      this.pvcs.set(pvc.metadata.name, created);
      this.created.pvcs += 1;
      this.driver.schedule();
      this.#leave('createPvc');
      return clone(created);
    });
  }
  getPvc(name: string): Promise<KubePvc> {
    return this.#run(() => { this.#enter('getPvc', name, false); return clone(this.#pvc(name)); });
  }
  listPvcs(selector: string, opts: ListOptions = {}): Promise<ListResult<KubePvc>> {
    return this.#run(() => { this.#enter('listPvcs', selector, false); this.#deadline(opts); return this.#list([...this.pvcs.values()], selector); });
  }
  deletePvc(name: string, uid: string): Promise<void> {
    return this.#run(() => {
      this.#enter('deletePvc', name, true);
      const pvc = this.#pvc(name);
      if (pvc.metadata.uid !== uid) throw new KubeError(409, 'Conflict', `Precondition failed: UID in precondition: ${uid}, UID in object meta: ${pvc.metadata.uid}`);
      pvc.metadata.deletionTimestamp ??= this.now();
      this.driver.sweepClaims(); // pvc-protection: stays, terminating, while a pod uses it
      this.#leave('deletePvc');
    });
  }
  #pvc(name: string): KubePvc {
    const p = this.pvcs.get(name);
    if (!p) throw new KubeError(404, 'NotFound', `persistentvolumeclaims "${name}" not found`);
    return p;
  }

  // ---------------------------------------------------------------- review and storage classes
  reviewToken(token: string, audiences: readonly string[]): Promise<TokenReviewResult> {
    return this.#run(() => {
      this.#enter('reviewToken', 'token', false);
      const b = this.tokens.get(token);
      if (!b) return { authenticated: false, error: 'invalid bearer token' };
      // With no audience named the API server's own audiences are used, which a pod token never carries.
      if (audiences.length === 0 || !audiences.includes(b.audience)) return { authenticated: false, error: `token audiences [${b.audience}] is invalid for the target audiences [${audiences.join(',')}]` };
      const pod = this.pods.get(b.podName);
      const exists = pod !== undefined && pod.metadata.uid === b.podUid;
      const remembered = b.reviewedAt !== undefined && this.clockMs - b.reviewedAt < REVIEW_MEMORY_MS;
      if (!exists && !remembered) return { authenticated: false, error: 'service account token has been invalidated' };
      if (exists) b.reviewedAt = this.clockMs;
      return {
        authenticated: true,
        user: { username: `system:serviceaccount:${this.namespace}:${b.serviceAccount}`, uid: `sa-${b.serviceAccount}`, extra: { 'authentication.kubernetes.io/pod-name': [b.podName], 'authentication.kubernetes.io/pod-uid': [b.podUid] } },
        audiences: this.reviewIgnoresAudiences ? [] : [b.audience],
      };
    });
  }
  getStorageClass(name: string): Promise<StorageClassInfo> {
    return this.#run(() => {
      this.#enter('getStorageClass', name, false);
      const s = this.storageClasses.get(name);
      if (!s) throw new KubeError(404, 'NotFound', `storageclasses "${name}" not found`);
      return clone(s);
    });
  }

  getNode(name: string): Promise<KubeNode> {
    return this.#run(() => {
      this.#enter('getNode', name, false);
      const n = this.nodes.get(name);
      if (!n) throw new KubeError(404, 'NotFound', `nodes "${name}" not found`);
      return clone(n);
    });
  }
  getApiService(): Promise<ApiServiceInfo> {
    return this.#run(() => { this.#enter('getApiService', 'kubernetes', false); return clone(this.apiService); });
  }

  // ---------------------------------------------------------------- helpers
  // A service-account token as the kubelet projects it: a JWT signed by the cluster's key, bound to the pod.
  mintToken(pod: KubePod, audience: string, o: { expiresInSeconds?: number; serviceAccount?: string; namespace?: string } = {}): string {
    this.#tokenCounter += 1;
    const k = this.#current ?? keyPair();
    const sa = o.serviceAccount ?? pod.spec.serviceAccountName;
    const ns = o.namespace ?? this.namespace;
    const now = wallSeconds();
    const head = b64(JSON.stringify({ alg: 'ES256', kid: k.kid, typ: 'JWT' }));
    const body = b64(JSON.stringify({ iss: 'https://kubernetes.default.svc', aud: [audience], iat: now, exp: now + (o.expiresInSeconds ?? 3600), jti: `t${String(this.#tokenCounter)}`,
      sub: `system:serviceaccount:${ns}:${sa}`, 'kubernetes.io': { namespace: ns, pod: { name: pod.metadata.name, uid: pod.metadata.uid }, serviceaccount: { name: sa, uid: `sa-${sa}` } } }));
    const sig = cryptoSign('sha256', Buffer.from(`${head}.${body}`), { key: k.priv, dsaEncoding: 'ieee-p1363' });
    const token = `${head}.${body}.${b64(sig)}`;
    this.tokens.set(token, { podName: pod.metadata.name, podUid: pod.metadata.uid, audience, serviceAccount: sa, reviewedAt: undefined });
    return token;
  }
  getServiceAccountJwks(): Promise<Jwks> {
    return this.#run(() => {
      this.#enter('getServiceAccountJwks', 'jwks', false);
      this.jwksCalls += 1;
      const published = this.#rotated ?? [keyPair()];
      return { keys: published.map((k) => ({ ...k.pub.export({ format: 'jwk' }), kid: k.kid, alg: 'ES256', use: 'sig' }) as Jwks['keys'][number]) };
    });
  }
  nextPodName(job: string): string { this.#podCounter += 1; return `${job}-p${String(this.#podCounter).padStart(4, '0')}`; }

  #list<T extends { metadata: { labels: Record<string, string> } }>(all: T[], selector: string): ListResult<T> {
    const match = parseSelector(selector);
    const hits = all.filter((o) => match(o.metadata.labels));
    if (this.listOrder === 'reverse') hits.reverse();
    const cap = LIST_PAGE_SIZE * LIST_MAX_PAGES;
    return { items: clone(hits.slice(0, cap)), truncated: hits.length > cap };
  }
  async #run<T>(f: () => T): Promise<T> {
    await Promise.resolve(); // every call is asynchronous, as a network call is
    return f();
  }

  // A stable text of every object, for "the whole object set is identical before and after".
  snapshot(): string {
    const by = <T extends { metadata: { name: string } }>(m: Map<string, T>): T[] => [...m.values()].sort((a, b) => (a.metadata.name < b.metadata.name ? -1 : 1));
    return JSON.stringify({ jobs: by(this.jobs), pods: by(this.pods), pvcs: by(this.pvcs) });
  }
}

export type FinishInit = { exitCode: number; message?: string; stderr?: string };

export class FakeDriver {
  readonly kube: FakeKube;
  constructor(kube: FakeKube) { this.kube = kube; }

  advance(ms: number): void { this.kube.clockMs += ms; }

  // The Job controller: one pod from the Job's template, owned by the Job.
  spawnPod(jobName: string): KubePod {
    const job = this.kube.jobs.get(jobName);
    if (!job) throw new Error(`no job ${jobName}`);
    const t = job.spec.template;
    const waiting = (name: string): ContainerStatus => ({ name, state: { waiting: { reason: 'PodInitializing' } } });
    const pod: KubePod = {
      metadata: { name: this.kube.nextPodName(jobName), namespace: this.kube.namespace, uid: randomUUID(), labels: { ...t.metadata.labels }, annotations: { ...t.metadata.annotations },
        creationTimestamp: this.kube.now(), ownerReferences: [{ apiVersion: 'batch/v1', kind: 'Job', name: jobName, uid: job.metadata.uid }] },
      spec: clone(t.spec),
      status: { phase: 'Pending', initContainerStatuses: (t.spec.initContainers ?? []).map((c) => waiting(c.name)), containerStatuses: t.spec.containers.map((c) => waiting(c.name)) },
    };
    // The API omits an empty `volumes`: a Job whose template mounts nothing gets pods with the field absent, as on a cluster.
    if ((pod.spec.volumes ?? []).length === 0) delete pod.spec.volumes;
    this.kube.pods.set(pod.metadata.name, pod);
    this.schedule();
    return clone(pod);
  }
  // A second pod for one Job: a duplicate, as node loss or a partition can leave.
  addDuplicatePod(jobName: string): KubePod { return this.spawnPod(jobName); }

  pod(name: string): KubePod {
    const p = this.kube.pods.get(name);
    if (!p) throw new Error(`no pod ${name}`);
    return p;
  }
  podsOf(jobName: string): KubePod[] { return [...this.kube.pods.values()].filter((p) => p.metadata.ownerReferences?.some((o) => o.name === jobName)); }

  // Scheduling: a pod is placed unless a ReadWriteOncePod claim it needs is held by another pod. Placing a pod binds its claims.
  schedule(): void {
    for (const pod of this.kube.pods.values()) {
      if (this.kube.scheduled.has(pod.metadata.uid) || pod.metadata.deletionTimestamp !== undefined) continue;
      const claims = (pod.spec.volumes ?? []).flatMap((v) => (v.persistentVolumeClaim ? [v.persistentVolumeClaim.claimName] : []));
      const blocked = claims.some((c) => {
        const pvc = this.kube.pvcs.get(c);
        if (!pvc) return true; // no claim yet: the pod waits
        if (pvc.metadata.deletionTimestamp !== undefined) return true;
        return pvc.spec.accessModes.includes('ReadWriteOncePod') && this.holders(c).some((h) => h.metadata.uid !== pod.metadata.uid);
      });
      if (blocked) continue;
      this.kube.scheduled.add(pod.metadata.uid);
      const node = this.kube.nodes.values().next().value;
      if (node) pod.spec.nodeName = node.name;
      for (const c of claims) { const pvc = this.kube.pvcs.get(c); if (pvc) pvc.status.phase = 'Bound'; }
      this.kube.runtime?.onPodScheduled(clone(pod));
    }
    this.sweepClaims();
  }
  holders(claim: string): KubePod[] {
    return [...this.kube.pods.values()].filter((p) => this.kube.scheduled.has(p.metadata.uid) && p.status.phase !== 'Succeeded' && p.status.phase !== 'Failed'
      && (p.spec.volumes ?? []).some((v) => v.persistentVolumeClaim?.claimName === claim));
  }
  // pvc-protection: a terminating claim goes when no pod uses it.
  sweepClaims(): void {
    for (const pvc of [...this.kube.pvcs.values()]) if (pvc.metadata.deletionTimestamp !== undefined && this.holders(pvc.metadata.name).length === 0) this.kube.pvcs.delete(pvc.metadata.name);
  }

  // ---- container status, as the kubelet reports it
  #status(pod: KubePod, kind: 'init' | 'app', name: string): ContainerStatus {
    const list = kind === 'init' ? pod.status.initContainerStatuses : pod.status.containerStatuses;
    const s = list?.find((x) => x.name === name);
    if (!s) throw new Error(`no ${kind} container ${name} in ${pod.metadata.name}`);
    return s;
  }
  containerStarted(podUid: string, kind: 'init' | 'app', name: string): void {
    const pod = this.#byUid(podUid);
    if (!pod) return;
    this.#status(pod, kind, name).state = { running: { startedAt: this.kube.now() } };
    if (kind === 'app' && pod.status.phase === 'Pending') pod.status.phase = 'Running';
  }
  // The message follows the container's policy: File keeps only what the container wrote to its message
  // file; the fallback policy puts the log tail in a failed container's message when the file is empty.
  containerExited(podUid: string, kind: 'init' | 'app', name: string, r: FinishInit): void {
    const pod = this.#byUid(podUid);
    if (!pod) return;
    const spec = [...(pod.spec.initContainers ?? []), ...pod.spec.containers].find((c) => c.name === name);
    let message = r.message ?? '';
    if (message === '' && r.exitCode !== 0 && spec?.terminationMessagePolicy === 'FallbackToLogsOnError') message = r.stderr ?? '';
    const cut = Buffer.from(message).subarray(0, TERMINATION_MESSAGE_CAP).toString('utf8');
    this.#status(pod, kind, name).state = { terminated: { exitCode: r.exitCode, ...(cut === '' ? {} : { message: cut }), finishedAt: this.kube.now() } };
    this.#advancePhase(pod);
    this.settleIfStopped(podUid);
  }
  #advancePhase(pod: KubePod): void {
    if (pod.status.phase === 'Succeeded' || pod.status.phase === 'Failed') return;
    const inits = pod.status.initContainerStatuses ?? [];
    if (inits.some((s) => (s.state.terminated?.exitCode ?? 0) !== 0)) { pod.status.phase = 'Failed'; return; }
    const apps = pod.status.containerStatuses ?? [];
    if (apps.length > 0 && apps.every((s) => s.state.terminated)) pod.status.phase = apps.every((s) => s.state.terminated?.exitCode === 0) ? 'Succeeded' : 'Failed';
  }
  // A pod being deleted goes once none of its containers is running.
  settleIfStopped(podUid: string): void {
    const pod = this.#byUid(podUid);
    if (!pod || pod.metadata.deletionTimestamp === undefined) return;
    const all = [...(pod.status.initContainerStatuses ?? []), ...(pod.status.containerStatuses ?? [])];
    if (all.some((s) => s.state.running)) return;
    if (this.kube.runtime?.hasLiveProcesses(podUid) === true) return; // a process the kubelet has started is still there, whatever the statuses say
    if (pod.status.phase !== 'Succeeded') pod.status.phase = 'Failed';
    this.removePod(pod.metadata.name);
  }
  #byUid(uid: string): KubePod | undefined { return [...this.kube.pods.values()].find((p) => p.metadata.uid === uid); }
  removePod(name: string): void {
    const pod = this.kube.pods.get(name);
    if (!pod) return;
    this.kube.pods.delete(name);
    this.kube.scheduled.delete(pod.metadata.uid);
    this.schedule(); // a waiting pod may now be placed; terminating claims may go
  }
  killContainers(pod: KubePod, exitCode: number): void {
    for (const s of [...(pod.status.initContainerStatuses ?? []), ...(pod.status.containerStatuses ?? [])]) {
      if (s.state.running) s.state = { terminated: { exitCode, finishedAt: this.kube.now() } };
    }
  }

  // ---- helpers for tests that inject statuses by hand (no kubelet)
  initFinished(podName: string, r: FinishInit, container = 'materialize'): void {
    const pod = this.pod(podName);
    this.containerExited(pod.metadata.uid, 'init', container, r);
    const inits = pod.status.initContainerStatuses ?? [];
    if (inits.every((s) => s.state.terminated?.exitCode === 0)) for (const c of pod.spec.containers) this.containerStarted(pod.metadata.uid, 'app', c.name);
  }
  startPod(podName: string): void {
    const pod = this.pod(podName);
    for (const c of pod.spec.initContainers ?? []) this.containerExited(pod.metadata.uid, 'init', c.name, { exitCode: 0 });
    for (const c of pod.spec.containers) this.containerStarted(pod.metadata.uid, 'app', c.name);
  }
  setPhase(podName: string, phase: PodPhase): void { this.pod(podName).status.phase = phase; }
  finishApp(podName: string, container: string, exitCode: number): void { this.containerExited(this.pod(podName).metadata.uid, 'app', container, { exitCode }); }
  // The kubelet has not yet reaped a deleted pod; completes every held delete.
  finishDeletes(): void {
    for (const pod of [...this.kube.pods.values()]) if (pod.metadata.deletionTimestamp !== undefined) { this.killContainers(pod, 143); this.removePod(pod.metadata.name); }
  }

  // ---- faults
  losePod(name: string): void { this.removePod(name); }                      // the object is gone; nothing else changes
  markJobFailed(name: string, reason = 'BackoffLimitExceeded'): void {       // the Job controller's verdict, while containers may still run
    const j = this.kube.jobs.get(name);
    if (!j) throw new Error(`no job ${name}`);
    j.status.conditions = [...(j.status.conditions ?? []), { type: 'Failed', status: 'True', reason }];
  }
  expireDeadline(name: string): void {                                       // activeDeadlineSeconds: pods ended, Job Failed/DeadlineExceeded
    for (const p of this.podsOf(name)) {
      p.metadata.deletionTimestamp ??= this.kube.now();
      if (this.kube.runtime) { this.kube.runtime.onPodDeleting(clone(p), 15_000); continue; }
      this.killContainers(p, 137);
      this.removePod(p.metadata.name);
    }
    this.markJobFailed(name, 'DeadlineExceeded');
  }
  // A raw Job delete with no propagation policy: the Job goes and its pods keep running, with no owner.
  rawDeleteJob(name: string): void {
    const job = this.kube.jobs.get(name);
    if (!job) throw new KubeError(404, 'NotFound', `jobs.batch "${name}" not found`);
    this.kube.jobs.delete(name);
    for (const p of this.kube.pods.values()) if (p.metadata.ownerReferences?.some((o) => o.uid === job.metadata.uid)) delete p.metadata.ownerReferences;
  }
  // Pod garbage collection after a node is deleted: the node and the pod objects that named it go, and nothing stops the processes the
  // kubelet started (the fake kubelet's children run on). A fake-only fault, never reported as cluster evidence.
  loseNode(name: string): void {
    this.kube.nodes.delete(name);
    for (const p of [...this.kube.pods.values()]) if (p.spec.nodeName === name) this.removePod(p.metadata.name);
  }
  // The driver pauses and resumes a container's process group: STOP and CONT. Fake-only, never reported as cluster evidence.
  pause(podUid: string, container: string): void { this.kube.runtime?.signalContainer?.(podUid, container, 'SIGSTOP'); }
  resume(podUid: string, container: string): void { this.kube.runtime?.signalContainer?.(podUid, container, 'SIGCONT'); }
  // A force delete (grace 0): the pod object is gone at once and its processes are still on the node.
  forceDeletePod(name: string): void { this.removePod(name); }
}
