// HttpsKube against a local node:https server with a throwaway CA.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpsKube, KubeError } from '../src/index.ts';

let dir: string;
const pem = (n: string): string => readFileSync(join(dir, n), 'utf8');
const ossl = (...args: string[]): void => { execFileSync('/usr/bin/openssl', args, { cwd: dir, stdio: 'pipe' }); };

function makeCa(name: string): void {
  ossl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.crt`, '-days', '2', '-subj', `/CN=${name}`);
}
function makeLeaf(name: string, ca: string, san: string): void {
  writeFileSync(join(dir, `${name}.ext`), `subjectAltName=${san}\nbasicConstraints=CA:FALSE\n`);
  ossl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=${name}`);
  ossl('x509', '-req', '-in', `${name}.csr`, '-CA', `${ca}.crt`, '-CAkey', `${ca}.key`, '-CAcreateserial', '-out', `${name}.crt`, '-days', '2', '-extfile', `${name}.ext`);
}

type Seen = { method: string; url: string; auth: string | undefined; body: string; clientCn: string | undefined; accept: string | undefined };
let server: Server;
let base: string;
const seen: Seen[] = [];
let handler: (req: IncomingMessage, res: ServerResponse, s: Seen) => void = () => undefined;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'w017-pki-'));
  makeCa('ca'); makeCa('rogue-ca');
  makeLeaf('server', 'ca', 'IP:127.0.0.1');
  makeLeaf('client', 'ca', 'DNS:client');
  server = createServer({ key: pem('server.key'), cert: pem('server.crt'), ca: pem('ca.crt'), requestCert: true, rejectUnauthorized: false }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const peer = (req.socket as unknown as { getPeerCertificate: () => { subject?: { CN?: string } } }).getPeerCertificate();
      const s: Seen = { method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization, body: Buffer.concat(chunks).toString(), clientCn: peer.subject?.CN, accept: req.headers.accept };
      seen.push(s);
      handler(req, res, s);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `https://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); rmSync(dir, { recursive: true, force: true }); });

const json = (res: ServerResponse, status: number, body: unknown): void => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const client = (over: Partial<ConstructorParameters<typeof HttpsKube>[0]> = {}): HttpsKube => new HttpsKube({ server: base, ca: pem('ca.crt'), namespace: 'factory-exec-local', token: 'tok', ...over });

describe('W-017 HttpsKube', () => {
  it('authenticates with a bearer token, or with a client certificate', async () => {
    handler = (_q, res) => { json(res, 200, { metadata: { name: 'p', uid: 'u' } }); };
    await client().getPod('p');
    expect(seen.at(-1)).toMatchObject({ method: 'GET', url: '/api/v1/namespaces/factory-exec-local/pods/p', auth: 'Bearer tok' });
    await client({ token: undefined as never, cert: pem('client.crt'), key: pem('client.key') }).getPod('p');
    expect(seen.at(-1)).toMatchObject({ clientCn: 'client' });
    expect(seen.at(-1)?.auth).toBeUndefined();
    expect(() => new HttpsKube({ server: base, ca: pem('ca.crt'), namespace: 'x' })).toThrow(/token or a client certificate/);
    expect(() => new HttpsKube({ server: 'http://127.0.0.1:1', ca: pem('ca.crt'), namespace: 'x', token: 't' })).toThrow(/https only/);
  });

  it('a server whose certificate the pinned CA did not sign is refused (control: the right CA works)', async () => {
    handler = (_q, res) => { json(res, 200, { metadata: { name: 'p' } }); };
    const before = seen.length;
    await expect(client({ ca: pem('rogue-ca.crt') }).getPod('p')).rejects.toMatchObject({ name: 'KubeError', status: 0 });
    expect(seen.length).toBe(before); // the request never reached the handler
    await client().getPod('p');
    expect(seen.length).toBe(before + 1);
  });

  it('the per-request deadline gives an unknown outcome (status 0, Timeout)', async () => {
    handler = () => undefined; // never answers
    const t0 = performance.now();
    const e = await client({ requestTimeoutMs: 150 }).createPvc({ apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: 'c', namespace: 'x', labels: {}, annotations: {} }, spec: { accessModes: [], storageClassName: 's', resources: { requests: { storage: '1Gi' } } } }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(KubeError);
    expect(e).toMatchObject({ status: 0, reason: 'Timeout' });
    expect((e as KubeError).isUnknownOutcome).toBe(true);
    expect(performance.now() - t0).toBeLessThan(3000);
  });

  it('a response over the cap is refused, and a redirect is not followed (control: a small answer passes)', async () => {
    handler = (_q, res) => { res.writeHead(200); res.end('{"x":"' + 'a'.repeat(5000) + '"}'); };
    await expect(client({ maxResponseBytes: 1024 }).getJob('j')).rejects.toMatchObject({ status: 0, message: expect.stringContaining('larger than') as unknown as string });
    await expect(client({ maxResponseBytes: 10_000 }).getJob('j')).resolves.toBeDefined();
    const before = seen.length;
    handler = (_q, res) => { res.writeHead(307, { location: '/elsewhere' }); res.end(); };
    await expect(client().getJob('j')).rejects.toMatchObject({ status: 307 });
    expect(seen.length).toBe(before + 1); // one request, no second one to the Location
  });

  it('409 is branched on the reason, and a 404 is a not-found error', async () => {
    handler = (_q, res) => { json(res, 409, { kind: 'Status', reason: 'AlreadyExists', message: 'exists' }); };
    const a = await client().getJob('j').catch((x: unknown) => x as KubeError);
    expect(a).toMatchObject({ status: 409, reason: 'AlreadyExists', isAlreadyExists: true, isConflict: false });
    handler = (_q, res) => { json(res, 409, { kind: 'Status', reason: 'Conflict', message: 'Precondition failed' }); };
    const c = await client().deletePod('p', 'u').catch((x: unknown) => x as KubeError);
    expect(c).toMatchObject({ status: 409, reason: 'Conflict', isConflict: true, isAlreadyExists: false });
    handler = (_q, res) => { json(res, 404, { kind: 'Status', reason: 'NotFound', message: 'gone' }); };
    expect(await client().deleteJob('j', 'u').catch((x: unknown) => x as KubeError)).toMatchObject({ isNotFound: true });
  });

  it('a list stops at the page cap and says so; a short list does not', async () => {
    let page = 0;
    handler = (_q, res) => { page += 1; json(res, 200, { items: Array.from({ length: 50 }, (_, i) => ({ metadata: { name: `p${String(page)}-${String(i)}` } })), metadata: { continue: `t${String(page)}` } }); };
    const before = seen.length;
    const r = await client().listPods('a=b');
    expect(r.truncated).toBe(true);
    expect(r.items).toHaveLength(500);
    expect(seen.length - before).toBe(10);
    expect(seen.at(-1)?.url).toContain('limit=50');
    expect(seen.at(-1)?.url).toContain('labelSelector=a%3Db');
    page = 0;
    handler = (_q, res) => { json(res, 200, { items: [{ metadata: { name: 'x' } }] }); };
    expect(await client().listPods('a=b')).toMatchObject({ truncated: false, items: [{ metadata: { name: 'x' } }] });
  });

  it('every delete carries Background, a pod delete carries grace 15, and each carries its UID precondition', async () => {
    handler = (_q, res) => { json(res, 200, {}); };
    const c = client();
    const mark = seen.length;
    await c.deleteJob('j', 'uj'); await c.deletePod('p', 'up'); await c.deletePvc('c', 'uc');
    const bodies = seen.slice(mark).map((s): Record<string, unknown> => ({ method: s.method, ...(JSON.parse(s.body) as Record<string, unknown>) }));
    expect(bodies).toHaveLength(3);
    for (const b of bodies) expect(b).toMatchObject({ method: 'DELETE', propagationPolicy: 'Background' });
    expect(bodies.map((b) => (b['preconditions'] as { uid: string }).uid)).toEqual(['uj', 'up', 'uc']);
    expect(bodies[1]).toMatchObject({ gracePeriodSeconds: 15 });
    expect(bodies.filter((b) => 'gracePeriodSeconds' in b)).toHaveLength(1);
  });

  it('a token review sends the audience and returns what the cluster said; a storage class with another reclaim policy is refused at start', async () => {
    handler = (req, res) => {
      if (req.url?.includes('tokenreviews')) json(res, 201, { status: { authenticated: true, audiences: ['aud'], user: { username: 'u' } } });
      else json(res, 200, { reclaimPolicy: 'Retain', volumeBindingMode: 'WaitForFirstConsumer' });
    };
    const c = client();
    expect(await c.reviewToken('t', ['aud'])).toEqual({ authenticated: true, audiences: ['aud'], user: { username: 'u' } });
    expect(JSON.parse(seen.at(-1)?.body ?? '{}')).toMatchObject({ spec: { token: 't', audiences: ['aud'] } });
    await expect(c.assertStorageClass('local-path')).rejects.toThrow(/Retain/);
    handler = (_q, res) => { json(res, 200, { reclaimPolicy: 'Delete' }); };
    await expect(c.assertStorageClass('local-path')).resolves.toBeUndefined();
  });

  it('the service-account key set is read from the cluster\'s JWKS route', async () => {
    handler = (_q, res) => { json(res, 200, { keys: [{ kty: 'EC', kid: 'k1', crv: 'P-256', x: 'a', y: 'b' }] }); };
    expect(await client().getServiceAccountJwks()).toEqual({ keys: [{ kty: 'EC', kid: 'k1', crv: 'P-256', x: 'a', y: 'b' }] });
    expect(seen.at(-1)).toMatchObject({ method: 'GET', url: '/openid/v1/jwks' });
    // k3s 1.36.6 answers 406 to a request that accepts only application/json: the key set is application/jwk-set+json.
    handler = (q, res) => { if (q.headers.accept?.includes('application/jwk-set+json') === true) json(res, 200, { keys: [{ kty: 'RSA', kid: 'k2' }] }); else json(res, 406, { reason: 'NotAcceptable' }); };
    expect(await client().getServiceAccountJwks()).toEqual({ keys: [{ kty: 'RSA', kid: 'k2' }] });
    expect(seen.at(-1)?.accept).toBe('application/jwk-set+json, application/json;q=0.9');
    await expect(client().getPod('p')).rejects.toMatchObject({ status: 406 }); // control: every other route still asks for application/json only
    expect(seen.at(-1)?.accept).toBe('application/json');
    handler = (_q, res) => { json(res, 200, {}); };
    expect(await client().getServiceAccountJwks()).toEqual({ keys: [] });
  });

  it('a list stops paging when its deadline signal fires, instead of reading all ten pages', async () => {
    let page = 0;
    handler = (_q, res) => { page += 1; setTimeout(() => { json(res, 200, { items: [{ metadata: { name: `p${String(page)}` } }], metadata: { continue: `t${String(page)}` } }); }, 80); };
    const before = seen.length;
    const t0 = performance.now();
    await expect(client().listPods('a=b', { signal: AbortSignal.timeout(220) })).rejects.toMatchObject({ status: 0, reason: 'Timeout' });
    expect(seen.length - before).toBeLessThan(6); // it stopped well short of the ten pages
    expect(performance.now() - t0).toBeLessThan(2000);
    // Control: without a signal the same server is read to the cap.
    page = 0;
    handler = (_q, res) => { page += 1; json(res, 200, { items: [{ metadata: { name: `p${String(page)}` } }], metadata: { continue: `t${String(page)}` } }); };
    expect((await client().listPods('a=b')).truncated).toBe(true);
  });
});
