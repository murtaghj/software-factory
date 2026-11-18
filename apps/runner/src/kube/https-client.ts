// HttpsKube: the thin client. `node:https`, a client certificate or a bearer token, a pinned CA, a
// 10-second deadline per request, a 4 MiB response cap, no redirects. Exec credential plugins are not
// supported (a run against an organization's cluster uses a service-account token). Every delete carries
// propagationPolicy Background and, for a pod, a grace period of 15 s; no other code in this app may set a
// grace period (a lint rule enforces it).
import { request } from 'node:https';
import { KubeError, GRACE_SECONDS, LIST_MAX_PAGES, LIST_PAGE_SIZE, PROPAGATION,
  type ApiServiceInfo, type JobManifest, type KubeApi, type KubeNode, type KubeJob, type KubePod, type Jwks, type KubePvc, type KubeReason, type ListOptions, type ListResult, type PvcManifest, type StorageClassInfo, type TokenReviewResult } from './api.ts';

export type HttpsKubeOptions = {
  server: string;            // https://host:port
  ca: string | Buffer;       // pinned: the system store is never used
  namespace: string;
  token?: string;
  cert?: string | Buffer; key?: string | Buffer;
  requestTimeoutMs?: number; // default 10 000
  maxResponseBytes?: number; // default 4 MiB
};

const REASONS: readonly KubeReason[] = ['AlreadyExists', 'Conflict', 'NotFound', 'Invalid', 'Timeout', 'Forbidden', 'InternalError', 'Unauthorized'];
type Json = Record<string, unknown>;
type ApiList<T> = { items?: T[]; metadata?: { continue?: string } };

// The API omits an empty `labels` and `annotations`, as it omits an empty `volumes`: the objects the rest of the runner reads always have both maps.
function withMeta(j: Json): Json {
  const fix = (o: unknown): void => {
    if (typeof o !== 'object' || o === null) return;
    const m = (o as { metadata?: unknown }).metadata;
    if (typeof m === 'object' && m !== null) { const mm = m as { labels?: unknown; annotations?: unknown }; mm.labels ??= {}; mm.annotations ??= {}; }
  };
  fix(j);
  const items = (j as { items?: unknown }).items;
  if (Array.isArray(items)) for (const i of items) fix(i);
  return j;
}

export class HttpsKube implements KubeApi {
  readonly #o: Required<Pick<HttpsKubeOptions, 'requestTimeoutMs' | 'maxResponseBytes'>> & HttpsKubeOptions;
  readonly #base: URL;

  constructor(o: HttpsKubeOptions) {
    if (o.token === undefined && (o.cert === undefined || o.key === undefined)) throw new Error('HttpsKube needs a bearer token or a client certificate and key');
    this.#base = new URL(o.server);
    if (this.#base.protocol !== 'https:') throw new Error('HttpsKube talks https only');
    this.#o = { requestTimeoutMs: 10_000, maxResponseBytes: 4 * 1024 * 1024, ...o };
  }

  #call(method: string, path: string, body?: Json, accept = 'application/json'): Promise<Json> {
    const o = this.#o;
    return new Promise<Json>((resolve, reject) => {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      let settled = false;
      const done = (f: () => void): void => { if (!settled) { settled = true; clearTimeout(timer); f(); } };
      const req = request({
        protocol: 'https:', hostname: this.#base.hostname, port: this.#base.port, method, path, ca: o.ca, rejectUnauthorized: true,
        ...(o.cert !== undefined && o.key !== undefined ? { cert: o.cert, key: o.key } : {}),
        headers: { accept, ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}), ...(o.token === undefined ? {} : { authorization: `Bearer ${o.token}` }) },
      }, (res) => {
        const chunks: Buffer[] = []; let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > o.maxResponseBytes) { res.destroy(); done(() => { reject(new KubeError(0, 'Unknown', `response larger than ${String(o.maxResponseBytes)} bytes`)); }); return; }
          chunks.push(c);
        });
        res.on('error', (e) => { done(() => { reject(new KubeError(0, 'Unknown', e.message)); }); });
        res.on('end', () => { done(() => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400) { reject(new KubeError(status, 'Unknown', 'redirects are not followed')); return; }
          let json: Json = {};
          try { json = chunks.length === 0 ? {} : (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Json); } catch { if (status < 300) { reject(new KubeError(status, 'Unknown', 'response is not JSON')); return; } }
          if (status >= 200 && status < 300) { resolve(withMeta(json)); return; }
          const reason = typeof json['reason'] === 'string' && (REASONS as readonly string[]).includes(json['reason']) ? (json['reason'] as KubeReason) : 'Unknown';
          reject(new KubeError(status, reason, typeof json['message'] === 'string' ? json['message'] : `HTTP ${String(status)}`));
        }); });
      });
      // A timeout is an unknown outcome (status 0): the request may have been applied.
      const timer = setTimeout(() => { req.destroy(); done(() => { reject(new KubeError(0, 'Timeout', `${method} ${path}: no answer within ${String(o.requestTimeoutMs)} ms`)); }); }, o.requestTimeoutMs);
      req.on('error', (e) => { done(() => { reject(new KubeError(0, 'Unknown', e.message)); }); });
      if (payload) req.write(payload);
      req.end();
    });
  }

  async #list<T>(path: string, selector: string, opts: ListOptions = {}): Promise<ListResult<T>> {
    const items: T[] = [];
    let cont: string | undefined;
    for (let page = 0; page < LIST_MAX_PAGES; page += 1) {
      if (opts.signal?.aborted === true) throw new KubeError(0, 'Timeout', 'the pass deadline ended the list');
      const q = `labelSelector=${encodeURIComponent(selector)}&limit=${String(LIST_PAGE_SIZE)}${cont === undefined ? '' : `&continue=${encodeURIComponent(cont)}`}`;
      const r = (await this.#call('GET', `${path}?${q}`)) as ApiList<T>;
      items.push(...(r.items ?? []));
      cont = r.metadata?.continue;
      if (cont === undefined || cont === '') return { items, truncated: false };
    }
    return { items, truncated: true }; // stopped at the page cap with more to read
  }

  #jobs(): string { return `/apis/batch/v1/namespaces/${encodeURIComponent(this.#o.namespace)}/jobs`; }
  #pods(): string { return `/api/v1/namespaces/${encodeURIComponent(this.#o.namespace)}/pods`; }
  #claims(): string { return `/api/v1/namespaces/${encodeURIComponent(this.#o.namespace)}/persistentvolumeclaims`; }

  async createJob(job: JobManifest): Promise<KubeJob> { return (await this.#call('POST', this.#jobs(), job)) as unknown as KubeJob; }
  async getJob(name: string): Promise<KubeJob> { return (await this.#call('GET', `${this.#jobs()}/${encodeURIComponent(name)}`)) as unknown as KubeJob; }
  listJobs(selector: string, opts?: ListOptions): Promise<ListResult<KubeJob>> { return this.#list<KubeJob>(this.#jobs(), selector, opts); }
  async deleteJob(name: string, uid: string): Promise<void> {
    await this.#call('DELETE', `${this.#jobs()}/${encodeURIComponent(name)}`, { apiVersion: 'v1', kind: 'DeleteOptions', propagationPolicy: PROPAGATION, preconditions: { uid } });
  }
  listPods(selector: string, opts?: ListOptions): Promise<ListResult<KubePod>> { return this.#list<KubePod>(this.#pods(), selector, opts); }
  async getPod(name: string): Promise<KubePod> { return (await this.#call('GET', `${this.#pods()}/${encodeURIComponent(name)}`)) as unknown as KubePod; }
  async deletePod(name: string, uid: string): Promise<void> {
    await this.#call('DELETE', `${this.#pods()}/${encodeURIComponent(name)}`, { apiVersion: 'v1', kind: 'DeleteOptions', gracePeriodSeconds: GRACE_SECONDS, propagationPolicy: PROPAGATION, preconditions: { uid } });
  }
  async createPvc(pvc: PvcManifest): Promise<KubePvc> { return (await this.#call('POST', this.#claims(), pvc)) as unknown as KubePvc; }
  async getPvc(name: string): Promise<KubePvc> { return (await this.#call('GET', `${this.#claims()}/${encodeURIComponent(name)}`)) as unknown as KubePvc; }
  listPvcs(selector: string, opts?: ListOptions): Promise<ListResult<KubePvc>> { return this.#list<KubePvc>(this.#claims(), selector, opts); }
  async deletePvc(name: string, uid: string): Promise<void> {
    await this.#call('DELETE', `${this.#claims()}/${encodeURIComponent(name)}`, { apiVersion: 'v1', kind: 'DeleteOptions', propagationPolicy: PROPAGATION, preconditions: { uid } });
  }
  async reviewToken(token: string, audiences: readonly string[]): Promise<TokenReviewResult> {
    const r = await this.#call('POST', '/apis/authentication.k8s.io/v1/tokenreviews', { apiVersion: 'authentication.k8s.io/v1', kind: 'TokenReview', spec: { token, audiences: [...audiences] } });
    const s = (r['status'] ?? {}) as { authenticated?: boolean; error?: string; user?: TokenReviewResult['user']; audiences?: string[] };
    return { authenticated: s.authenticated === true, ...(s.error === undefined ? {} : { error: s.error }), ...(s.user === undefined ? {} : { user: s.user }), ...(s.audiences === undefined ? {} : { audiences: s.audiences }) };
  }
  async getServiceAccountJwks(): Promise<Jwks> {
    // The key set is served as application/jwk-set+json; a request that accepts only application/json is answered 406 (measured on k3s 1.36.6).
    const r = await this.#call('GET', '/openid/v1/jwks', undefined, 'application/jwk-set+json, application/json;q=0.9');
    return { keys: Array.isArray(r['keys']) ? (r['keys'] as Jwks['keys']) : [] };
  }
  async getStorageClass(name: string): Promise<StorageClassInfo> {
    const r = await this.#call('GET', `/apis/storage.k8s.io/v1/storageclasses/${encodeURIComponent(name)}`);
    return { name, reclaimPolicy: typeof r['reclaimPolicy'] === 'string' ? r['reclaimPolicy'] : 'Delete', volumeBindingMode: typeof r['volumeBindingMode'] === 'string' ? r['volumeBindingMode'] : 'Immediate' };
  }
  async getNode(name: string): Promise<KubeNode> {
    const r = await this.#call('GET', `/api/v1/nodes/${encodeURIComponent(name)}`);
    const m = (r['metadata'] ?? {}) as { name?: string; uid?: string };
    if (typeof m.uid !== 'string' || m.uid === '') throw new KubeError(0, 'Unknown', 'the node answer carries no uid');
    return { name: m.name ?? name, uid: m.uid };
  }
  async getApiService(): Promise<ApiServiceInfo> {
    const r = await this.#call('GET', '/api/v1/namespaces/default/services/kubernetes');
    const spec = (r['spec'] ?? {}) as { clusterIP?: string; ports?: Array<{ port?: number }> };
    const port = spec.ports?.[0]?.port;
    if (typeof spec.clusterIP !== 'string' || spec.clusterIP === '' || typeof port !== 'number') throw new KubeError(0, 'Unknown', 'the kubernetes Service answer carries no cluster address');
    return { address: spec.clusterIP, port };
  }
  // At start: the workspace claims' storage class must reclaim with Delete, or the runner refuses to start (D15).
  async assertStorageClass(name: string): Promise<void> {
    const sc = await this.getStorageClass(name);
    if (sc.reclaimPolicy !== 'Delete') throw new Error(`storage class ${name} has reclaim policy ${sc.reclaimPolicy}; the runner requires Delete`);
  }
}
