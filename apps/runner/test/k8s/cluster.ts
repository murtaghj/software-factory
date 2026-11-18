// The k3s tier's connection to the cluster (17b): the environment `scripts/k3s.sh up` wrote, the runner's own client
// (bearer token, the runner's Role), and the test driver (the admin certificate, which is for the driver only: raw
// requests the port does not offer, token minting, RBAC questions, and cleanup).
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { HttpsKube } from '../../src/index.ts';
import type { ConformanceDriver } from '../conformance/suite.ts';

export type K3sEnv = {
  server: string; caFile: string; adminCertFile: string; adminKeyFile: string; runnerTokenFile: string; namespace: string; fixtureCommit: string; imageDigest: string;
};

export const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
export const ENV_FILE = process.env['FACTORY_K3S_ENV'] ?? join(REPO_ROOT, '.k3s', 'env');
export const RUNNER_SA = 'factory-runner';
export const SUPERVISOR_SA = 'factory-allocation-supervisor';
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function loadK3sEnv(file = ENV_FILE): K3sEnv {
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch { throw new Error(`k3s tier: ${file} is missing; run "sh scripts/k3s.sh up" (a missing cluster is a failure, not a skip)`); }
  const m = new Map<string, string>();
  for (const line of text.split('\n')) { const i = line.indexOf('='); if (i > 0) m.set(line.slice(0, i), line.slice(i + 1)); }
  const get = (k: string): string => { const v = m.get(k); if (v === undefined || v === '') throw new Error(`k3s tier: ${file} has no ${k}`); return v; };
  return { server: get('FACTORY_K3S_SERVER'), caFile: get('FACTORY_K3S_CA_FILE'), adminCertFile: get('FACTORY_K3S_ADMIN_CERT_FILE'), adminKeyFile: get('FACTORY_K3S_ADMIN_KEY_FILE'),
    runnerTokenFile: get('FACTORY_K3S_RUNNER_TOKEN_FILE'), namespace: get('FACTORY_K3S_NAMESPACE'), fixtureCommit: get('FACTORY_K3S_FIXTURE_COMMIT'), imageDigest: get('FACTORY_K3S_IMAGE_DIGEST') };
}

// The runner's own client: the runner's service-account token, so a call outside its Role fails here the way it would in production.
export const runnerKube = (env: K3sEnv): HttpsKube => new HttpsKube({ server: env.server, ca: readFileSync(env.caFile), namespace: env.namespace, token: readFileSync(env.runnerTokenFile, 'utf8').trim() });

type Json = Record<string, unknown>;
const parseJson = (text: string): Json => { try { return text === '' ? {} : (JSON.parse(text) as Json); } catch { return { raw: text }; } };
export type AdminAnswer = { status: number; json: Json };

// Raw requests with the admin certificate. Never used by the code under test.
export class AdminClient {
  readonly env: K3sEnv;
  readonly #ca: Buffer; readonly #cert: Buffer; readonly #key: Buffer;
  constructor(env: K3sEnv) { this.env = env; this.#ca = readFileSync(env.caFile); this.#cert = readFileSync(env.adminCertFile); this.#key = readFileSync(env.adminKeyFile); }

  call(method: string, path: string, body?: unknown, contentType = 'application/json'): Promise<AdminAnswer> {
    const url = new URL(this.env.server);
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const req = request({ protocol: 'https:', hostname: url.hostname, port: url.port, method, path, ca: this.#ca, cert: this.#cert, key: this.#key,
        headers: { accept: 'application/json', ...(payload ? { 'content-type': contentType, 'content-length': payload.length } : {}) } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, json: parseJson(text) });
        });
      });
      req.setTimeout(30_000, () => { req.destroy(new Error(`${method} ${path}: no answer in 30 s`)); });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }
  async ok(method: string, path: string, body?: unknown, contentType?: string): Promise<Json> {
    const r = await this.call(method, path, body, contentType);
    if (r.status < 200 || r.status >= 300) throw new Error(`${method} ${path}: HTTP ${String(r.status)} ${JSON.stringify(r.json).slice(0, 400)}`);
    return r.json;
  }
  readonly ns = (kind: string): string => `/api/v1/namespaces/${this.env.namespace}/${kind}`;
  readonly jobs = (): string => `/apis/batch/v1/namespaces/${this.env.namespace}/jobs`;

  items(path: string, selector?: string): Promise<Json[]> {
    return this.ok('GET', selector === undefined ? path : `${path}?labelSelector=${encodeURIComponent(selector)}`).then((j) => (j['items'] as Json[] | undefined) ?? []);
  }

  // A token bound to one pod, as the kubelet's projected volume would give it (TokenRequest API).
  async mintToken(podName: string, audience: string, serviceAccount = SUPERVISOR_SA): Promise<string> {
    const pod = await this.ok('GET', `${this.ns('pods')}/${podName}`);
    const uid = (pod['metadata'] as { uid: string }).uid;
    const r = await this.ok('POST', `${this.ns('serviceaccounts')}/${serviceAccount}/token`, {
      apiVersion: 'authentication.k8s.io/v1', kind: 'TokenRequest', spec: { audiences: [audience], expirationSeconds: 600, boundObjectRef: { apiVersion: 'v1', kind: 'Pod', name: podName, uid } } });
    return (r['status'] as { token: string }).token;
  }

  // Does RBAC allow this service account of the execution namespace the verb on the resource? Groups are the ones the
  // API server gives a service account, so the answer is the real one. `nonResourceURL:<path>` asks about a non-resource URL.
  async canI(as: string, verb: string, resource: string): Promise<boolean> {
    const ns = this.env.namespace;
    const spec: Json = { user: `system:serviceaccount:${ns}:${as}`, groups: ['system:serviceaccounts', `system:serviceaccounts:${ns}`, 'system:authenticated'] };
    if (resource.startsWith('nonResourceURL:')) spec['nonResourceAttributes'] = { path: resource.slice('nonResourceURL:'.length), verb };
    else {
      const [named = '', sub] = resource.split('/');
      const [name = '', objectName] = named.split('@');
      const group = name === 'jobs' ? 'batch' : name === 'tokenreviews' ? 'authentication.k8s.io' : name === 'storageclasses' ? 'storage.k8s.io' : '';
      const clusterScoped = name === 'tokenreviews' || name === 'storageclasses';
      spec['resourceAttributes'] = { ...(clusterScoped ? {} : { namespace: ns }), verb, group, resource: name, ...(sub === undefined ? {} : { subresource: sub }), ...(objectName === undefined ? {} : { name: objectName }) };
    }
    const r = await this.ok('POST', '/apis/authorization.k8s.io/v1/subjectaccessreviews', { apiVersion: 'authorization.k8s.io/v1', kind: 'SubjectAccessReview', spec });
    return (r['status'] as { allowed: boolean }).allowed;
  }

  // Everything this test run left in the namespace, by label. Pods are removed at once: this is cleanup after a test, not code under test.
  async clean(selector: string): Promise<void> {
    for (const j of await this.items(this.jobs(), selector)) await this.call('DELETE', `${this.jobs()}/${(j['metadata'] as { name: string }).name}`, { propagationPolicy: 'Background' });
    for (const p of await this.items(this.ns('pods'), selector)) await this.call('DELETE', `${this.ns('pods')}/${(p['metadata'] as { name: string }).name}`, { gracePeriodSeconds: 0 });
    for (const c of await this.items(this.ns('persistentvolumeclaims'), selector)) await this.call('DELETE', `${this.ns('persistentvolumeclaims')}/${(c['metadata'] as { name: string }).name}`);
  }
  // Anything left in the namespace at all (the teardown check of every file).
  async leftovers(): Promise<string[]> {
    const out: string[] = [];
    for (const [kind, path] of [['job', this.jobs()], ['pod', this.ns('pods')], ['pvc', this.ns('persistentvolumeclaims')]] as const) {
      for (const o of await this.items(path)) out.push(`${kind} ${(o['metadata'] as { name: string }).name}`);
    }
    return out;
  }
}

const exec = promisify(execFile);
const PODMAN = process.env['PODMAN'] ?? join(homedir(), '.local', 'bin', 'podman');
const CONNECTION = process.env['K3S_CONNECTION'] ?? 'podman-machine-default-root';
export const K3S_CONTAINER = process.env['K3S_NAME'] ?? 'factory-k3s';
// Runs a command inside the k3s container (the node). For what the API cannot show: the backing directory of a volume,
// and a token read from a pod's projected volume.
export async function inNode(...args: string[]): Promise<string> {
  const r = await exec(PODMAN, ['--connection', CONNECTION, 'exec', K3S_CONTAINER, ...args], { timeout: 60_000, maxBuffer: 1024 * 1024 });
  return r.stdout;
}

// Is this container's process running, as the container runtime sees it? (The pod object may be gone while the process is not.)
export async function containerRunning(podUid: string, container: string): Promise<boolean | undefined> {
  const out = JSON.parse(await inNode('crictl', 'ps', '-a', '-o', 'json')) as { containers?: Array<{ metadata: { name: string }; state: string; labels?: Record<string, string> }> };
  const mine = (out.containers ?? []).filter((c) => c.labels?.['io.kubernetes.pod.uid'] === podUid && c.metadata.name === container);
  if (mine.length === 0) return undefined;
  return mine.some((c) => c.state === 'CONTAINER_RUNNING');
}

// The conformance driver for the cluster. `labelSelector` finds what the run created, so its cleanup is exact.
export function k3sDriver(env: K3sEnv, admin: AdminClient, runs: string[], recorded: string[]): ConformanceDriver {
  const wait = async (what: string, cond: () => Promise<boolean>, timeoutMs: number): Promise<void> => {
    const t0 = performance.now();
    while (!(await cond())) { if (performance.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`); await sleep(250); }
  };
  return {
    images: { exitOnTerm: 'factory-stub:local', ignoreTerm: 'factory-stub-ignore-term:local', message: 'factory-stub-message:local', stderrFail: 'factory-stub-stderr-fail:local', exitZero: 'factory-stub-exit0:local' },
    graceMs: 15_000, namespace: env.namespace,
    uniqueSuffix: () => { const r = randomUUID().slice(0, 6); runs.push(r); return r; },
    rawDeleteJob: async (name) => { await admin.ok('DELETE', `${admin.jobs()}/${name}`); },                                  // no propagation policy: batch/v1 orphans
    forceDeletePod: async (name) => { await admin.ok('DELETE', `${admin.ns('pods')}/${name}`, { gracePeriodSeconds: 0 }); },
    isProcessAlive: (podUid, container) => containerRunning(podUid, container),                                               // the runtime's own view, through crictl in the node
    waitFor: wait,
    advanceReviewClock: (ms) => sleep(ms),                                                                                    // a cluster's clock is real
    mintToken: (podName, audience) => admin.mintToken(podName, audience),
    // The Job controller's verdict, sooner: lower the deadline of the running Job (a Job's activeDeadlineSeconds may be lowered).
    expireDeadline: async (jobName) => { await admin.ok('PATCH', `${admin.jobs()}/${jobName}`, { spec: { activeDeadlineSeconds: 1 } }, 'application/merge-patch+json'); },
    record: (k, v) => { recorded.push(`${k}=${v}`); },
    canI: (as, verb, resource) => admin.canI(as, verb, resource),
    runnerServiceAccount: RUNNER_SA, supervisorServiceAccount: SUPERVISOR_SA,
  };
}
