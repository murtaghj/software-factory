// The pod-facing listener (W-019): routes, TLS always, the admission order and its four limits. Every refusal has the accepted case beside it.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ROUTES } from '@factory/runner-protocol';
import { tokenAudience } from '../src/index.ts';
import { BucketTable } from '../src/listener/buckets.ts';
import { startPodListener, type PodListener } from '../src/listener/pod-listener.ts';
import { createConfig } from '../src/config.ts';
import { createTestConfig } from '../src/testing.ts';
import { createEnv, hex, type Env, type Instance } from './harness.ts';
import { closedWithin, connectAs, json, makePki, request, sourceByPortBlock, tryConnectAs, type Pki } from './listener-kit.ts';

let e: Env;
let pki: Pki;
beforeAll(async () => { pki = makePki(); e = await createEnv('w019_listener', { config: { podRate: { burst: 1000, intervalMs: 1 } } }); });
afterAll(async () => { await e.close(); pki.cleanup(); });
const open: PodListener[] = [];
afterEach(async () => { while (open.length > 0) await open.pop()?.close(); vi.restoreAllMocks(); });

type Over = Parameters<typeof e.newRunner>[0] extends infer O ? NonNullable<O> extends { config?: infer C } ? C : never : never;
async function serve(over: Over = {}, timeouts?: { handshakeMs?: number; bodyMs?: number; requestMs?: number }, plaintext = false) {
  const inst = e.newRunner({ config: { podListener: { host: '127.0.0.1', port: 0, cert: pki.cert, key: pki.key }, test: { sourceOf: sourceByPortBlock, ...(plaintext ? { plaintext: true } : {}), ...(over.test ?? {}) }, podRate: { burst: 1000, intervalMs: 1 }, ...over } });
  const l = await startPodListener({ runner: inst.runner, config: inst.config, ...(timeouts ? { timeouts } : {}) });
  open.push(l);
  return { inst, l };
}
async function started(inst: Instance) {
  const s = await e.newStage(e.a);
  await inst.runner.startOrAttach(e.ctx(e.a), e.input(e.a, s), hex('e'));
  const a = (await e.allocations(e.a, s)).at(-1) as NonNullable<Awaited<ReturnType<typeof e.allocations>>[number]>;
  const pod = inst.kube.driver.podsOf(a.jobName)[0] as NonNullable<ReturnType<typeof inst.kube.driver.podsOf>[number]>;
  inst.kube.driver.startPod(pod.metadata.name);
  return { s, a, pod, token: inst.kube.mintToken(pod, tokenAudience(e.a.orgId, a.id)) };
}
const body = (a: { id: string }) => JSON.stringify({ orgId: e.a.orgId, allocationId: a.id, epoch: 1 });
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const snapshot = async () => JSON.stringify([await e.tables(e.a), await e.auditCount(e.a, 'true')]);

describe('W-019 the pod listener', () => {
  it('the three routes reach their service; a wrong method, path, content type and a 17 KiB body are 405, 404, 415 and 413 with nothing written', async () => {
    const { inst, l } = await serve();
    const x = await started(inst);
    const c = await connectAs(l, 0, { tls: true, ca: pki.ca });
    const acquire = await request(c, { path: ROUTES.acquire, body: body(x.a), headers: auth(x.token) });
    expect(acquire.status).toBe(200);
    expect(json(acquire)).toMatchObject({ granted: true, allocationId: x.a.id, harness: { state: 'running' } });
    const renew = await request(c, { path: ROUTES.renew, body: body(x.a), headers: auth(x.token) });
    expect(json(renew)).toMatchObject({ granted: true });
    await e.db.withTenant({ orgId: e.a.orgId }, (tx) => tx.query("UPDATE factory.execution_allocation SET state = 'stopping' WHERE id = $1", [x.a.id]));
    // renewal for a stopping allocation: the typed denial, status 409
    const denied = await request(c, { path: ROUTES.renew, body: body(x.a), headers: auth(x.token) });
    expect(denied.status).toBe(409);
    expect(json(denied)).toMatchObject({ granted: false, code: 'not_renewable', reason: 'stopping' });
    const ack = await request(c, { path: ROUTES.stopAck, body: body(x.a), headers: auth(x.token) });
    expect(json(ack)).toEqual({ acknowledged: true });
    const before = await snapshot();
    expect((await request(c, { path: ROUTES.renew, method: 'GET', body: '', headers: auth(x.token) })).status).toBe(405);
    expect((await request(c, { path: '/pod/v1/nothing', body: body(x.a), headers: auth(x.token) })).status).toBe(404);
    expect((await request(c, { path: ROUTES.renew, body: body(x.a), contentType: 'text/plain', headers: auth(x.token) })).status).toBe(415);
    const big = await request(c, { path: ROUTES.renew, body: JSON.stringify({ pad: 'x'.repeat(17 * 1024) }), headers: auth(x.token) });
    expect(big.status).toBe(413);
    expect(big.closed).toBe(true); // answered, then the connection is destroyed: nothing keeps draining the body
    expect(await closedWithin(c, 1000)).toBe(true);
    const c3 = await connectAs(l, 0, { tls: true, ca: pki.ca }); // control: a 404 leaves its connection open
    expect((await request(c3, { path: '/pod/v1/nothing', body: body(x.a), headers: auth(x.token) })).closed).toBe(false);
    expect(await snapshot()).toBe(before);
  });

  it('configuration: a listener with no certificate is refused on any address, loopback included, and 0.0.0.0 is refused; the test configuration\'s flag accepts plaintext on 127.0.0.1; a production configuration cannot carry the test keys', () => {
    const d = 'sha256:' + 'a'.repeat(64);
    const prod = { runnerIdentity: 'runner:factory', controlPlaneIdentities: ['service:worker'], identityOrgs: { 'service:worker': '00000000-0000-4000-8000-000000000001' }, images: { supervisor: `s@${d}`, harness: `h@${d}`, materializer: `m@${d}` }, networkGate: { mode: 'required' as const, denyTargets: ['10.43.0.1:443'] }, supervisor: { runnerUrl: 'https://192.168.127.254:18443', caConfigMap: 'factory-runner-ca', caSha256: 'b'.repeat(64), localPort: 8765 }, podListener: { host: '127.0.0.1', port: 1, cert: pki.cert, key: pki.key } };
    expect(() => createConfig({ ...prod, podListener: { host: '127.0.0.1', port: 1, cert: '', key: '' } })).toThrow(/certificate/);
    expect(() => createConfig({ ...prod, podListener: { host: '10.0.0.5', port: 1, cert: '', key: '' } })).toThrow(/certificate/);
    expect(() => createConfig({ ...prod, podListener: { host: '0.0.0.0', port: 1, cert: pki.cert, key: pki.key } })).toThrow(/named address/);
    expect(() => createConfig({ ...prod, podListener: { host: '::', port: 1, cert: pki.cert, key: pki.key } })).toThrow(/named address/);
    expect(createConfig({ ...prod, podListener: { host: '127.0.0.1', port: 1, cert: pki.cert, key: pki.key } }).podListener?.host).toBe('127.0.0.1'); // control
    expect(createTestConfig({ runnerIdentity: 'r', controlPlaneIdentities: ['c'], podListener: { host: '127.0.0.1', port: 1, cert: '', key: '' }, test: { plaintext: true } }).podListener).toBeDefined(); // control
    expect(() => createTestConfig({ runnerIdentity: 'r', controlPlaneIdentities: ['c'], podListener: { host: '127.0.0.1', port: 1, cert: '', key: '' } })).toThrow(/certificate/);
    for (const k of ['test', 'plaintext', 'relaxSourceLimits', 'sourceOf']) expect(() => createConfig({ ...prod, [k]: k === 'sourceOf' ? () => 's' : { plaintext: true } }), k).toThrow(/test switches/);
  });

  it('a handshake that stalls and a slow body are cut at their limits; control: the same limits let a prompt request through', async () => {
    const defaults = await import('../src/listener/pod-listener.ts');
    expect([defaults.HANDSHAKE_MS, defaults.BODY_MS, defaults.REQUEST_MS, defaults.MAX_HEADER_BYTES]).toEqual([5000, 5000, 10000, 16384]);
    const { inst, l } = await serve({}, { handshakeMs: 300, bodyMs: 300, requestMs: 2000 });
    const x = await started(inst);
    const raw = await tryConnectAs(l, 1, { tls: false }); // a plain socket that never starts a handshake
    expect(raw.socket && await closedWithin(raw.socket, 2000)).toBe(true);
    const c = await connectAs(l, 2, { tls: true, ca: pki.ca });
    c.write(`POST ${ROUTES.renew} HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"orgId"`); // the body never completes
    expect(await closedWithin(c, 2000)).toBe(true);
    const ok = await connectAs(l, 3, { tls: true, ca: pki.ca });
    expect(json(await request(ok, { path: ROUTES.acquire, body: body(x.a), headers: auth(x.token) }))).toMatchObject({ granted: true }); // control
  });

  it('connections: the fifth open connection from one source is refused while a second source connects; configuration refuses a per-source cap whose product with the pools exceeds 512, and a per-pod rate above the review ceiling\'s share', async () => {
    const { l } = await serve({ sourceNewConnections: { perSecond: 100, burst: 100 } });
    const four = await Promise.all([0, 1, 2, 3].map(() => connectAs(l, 4, { tls: true, ca: pki.ca })));
    const fifth = await tryConnectAs(l, 4, { tls: true, ca: pki.ca });
    expect(fifth.refused).toBe(true);
    const other = await tryConnectAs(l, 5, { tls: true, ca: pki.ca });
    expect(other.refused).toBe(false);
    expect(l.stats()['open_connection_refused']).toBeGreaterThanOrEqual(1);
    for (const s of [...four, other.socket]) s?.destroy();
    const d = 'sha256:' + 'a'.repeat(64);
    const prod = { runnerIdentity: 'r', controlPlaneIdentities: ['c'], identityOrgs: { c: '00000000-0000-4000-8000-000000000001' }, images: { supervisor: `s@${d}`, harness: `h@${d}`, materializer: `m@${d}` }, networkGate: { mode: 'required' as const, denyTargets: ['10.43.0.1:443'] }, supervisor: { runnerUrl: 'https://192.168.127.254:18443', caConfigMap: 'factory-runner-ca', caSha256: 'b'.repeat(64), localPort: 8765 }, podListener: { host: '127.0.0.1', port: 1, cert: pki.cert, key: pki.key } };
    expect(() => createConfig({ ...prod, sourceConnections: 5, pools: { authoring: 60, verifier: 60 } })).toThrow(/512/); // 5 x 120 = 600
    expect(() => createConfig({ ...prod, sourceConnections: 4, pools: { authoring: 60, verifier: 60 } })).not.toThrow(); // 480
    expect(() => createConfig({ ...prod, sourceConnections: 1, pools: { authoring: 150, verifier: 150 } })).toThrow(/review ceiling/); // 2 x 0.5 x 300 = 300 > 200
    expect(() => createConfig({ ...prod, sourceConnections: 1, pools: { authoring: 100, verifier: 100 } })).not.toThrow(); // 200
  });

  it('charging: junk tokens from one source empty its bucket (burst 50) and the next is 429 with the connection closed, while a valid token from that same source is granted; the same with one failed token repeated, with random key ids, and with a wrong path. Control: with the old order the valid request is 429', async () => {
    const { inst, l } = await serve();
    const x = await started(inst);
    expect(await inst.runner.acquireStartPermit({ token: x.token, orgId: e.a.orgId, allocationId: x.a.id, epoch: 1 })).toMatchObject({ granted: true });
    const junk = () => `a.${Buffer.from(JSON.stringify({ alg: 'ES256', kid: `k-${Math.random()}` })).toString('base64url')}.c`;
    const scenarios: Array<[string, (c: Awaited<ReturnType<typeof connectAs>>) => Promise<number>]> = [
      ['junk tokens', async (c) => (await request(c, { path: ROUTES.renew, body: body(x.a), headers: auth('not.a.token') })).status],
      ['one failed token repeated', async (c) => (await request(c, { path: ROUTES.renew, body: body(x.a), headers: auth('repeated.same.token') })).status],
      ['random key ids', async (c) => (await request(c, { path: ROUTES.renew, body: body(x.a), headers: auth(junk()) })).status],
      ['wrong path', async (c) => (await request(c, { path: '/nothing/here', body: '{}', headers: auth('x') })).status],
    ];
    let block = 6;
    for (const [name, send] of scenarios) {
      block += 1;
      const c = await connectAs(l, block, { tls: true, ca: pki.ca });
      let last = 0;
      for (let i = 0; i < 50; i += 1) last = await send(c);
      expect(last, `${name}: still inside the burst`).not.toBe(429);
      const over = await request(c, { path: ROUTES.renew, body: body(x.a), headers: auth('not.a.token') });
      expect(over.status, name).toBe(429);
      expect(over.closed, name).toBe(true);
      const valid = await connectAs(l, block, { tls: true, ca: pki.ca }); // the same source, a new connection
      expect(json(await request(valid, { path: ROUTES.renew, body: body(x.a), headers: auth(inst.kube.mintToken(x.pod, tokenAudience(e.a.orgId, x.a.id))) })), `${name}: a valid token`).toMatchObject({ granted: true });
      valid.destroy();
    }
    // control: the old order (charge before verification, a test switch)
    const old = await serve({ test: { sourceOf: sourceByPortBlock, chargeBeforeVerification: true } });
    const y = await started(old.inst);
    const c = await connectAs(old.l, 15, { tls: true, ca: pki.ca });
    for (let i = 0; i < 50 && !c.destroyed; i += 1) await request(c, { path: ROUTES.renew, body: body(y.a), headers: auth('not.a.token') });
    const c2 = await connectAs(old.l, 15, { tls: true, ca: pki.ca });
    expect((await request(c2, { path: ROUTES.acquire, body: body(y.a), headers: auth(y.token) })).status).toBe(429);
  });

  it('the failed-token memory holds 4,096 entries after 5,000 distinct failures, the oldest gone and the newest kept; a full bucket table evicts its oldest and still admits a new source', async () => {
    const inst = e.newRunner();
    const x = await started(inst);
    const req = (token: string) => ({ token, orgId: e.a.orgId, allocationId: x.a.id, epoch: 1 });
    for (let i = 0; i < 5000; i += 1) await inst.runner.renewPermit(req(`junk.${String(i)}.x`));
    expect(await inst.runner.renewPermit(req('junk.4999.x'))).toMatchObject({ reason: 'recently_failed' });
    expect(await inst.runner.renewPermit(req('junk.0.x'))).toMatchObject({ reason: 'local_malformed_token' }); // evicted: judged again, not remembered
    const t = new BucketTable(3, 1, 1);
    for (const k of ['a', 'b', 'c', 'd']) expect(t.take(k, 0)).toBe(true);
    expect(t.size).toBe(3);
    expect(t.take('a', 0)).toBe(true); // 'a' was evicted: a new bucket, admitted
    expect(t.take('d', 0)).toBe(false); // control: a source still in the table has spent its token
  });

  it('no counter name and no log line contains a path, a source or a token', async () => {
    const logs: string[] = [];
    for (const m of ['log', 'warn', 'error', 'info'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
    const { inst, l } = await serve();
    const x = await started(inst);
    const c = await connectAs(l, 20, { tls: true, ca: pki.ca });
    await request(c, { path: '/some/unique/path', body: '{}', headers: auth('unique.secret.token') });
    await request(c, { path: ROUTES.renew, body: body(x.a), headers: auth(x.token) });
    const names = [...Object.keys(l.stats()), ...Object.keys(inst.runner.permitRefusals()), ...Object.keys(inst.runner.refusalCounts())];
    for (const n of names) expect(n).toMatch(/^[a-z][a-z_]*$/);
    expect(names.join(' ')).not.toMatch(/unique|src\d|secret/);
    expect(logs.join('\n')).not.toMatch(/unique\.secret|some\/unique|src2/);
    expect(logs.join('\n')).not.toContain(x.token);
  });

  it('a route answers first and reconciles after: with the pass held by a fault the client already has its answer, and a repeat of stop-ack starts no second pass', async () => {
    const { inst, l } = await serve({ cancelCheckpointWaitSeconds: 30 });
    const s = await e.newStage(e.a);
    const run = await e.runningAllocation(e.a, s, inst);
    await inst.runner.cancel(e.ctx(e.a), s.logicalId, '00000000-0000-4000-8000-0000000000aa', 'stop'); // the hold: nothing is deleted
    const hold = inst.faults.holdAt('runner.after_stop_ack');
    const c = await connectAs(l, 21, { tls: true, ca: pki.ca });
    const bodyText = JSON.stringify({ orgId: e.a.orgId, allocationId: run.allocationId, epoch: 1 });
    const reply = await request(c, { path: ROUTES.stopAck, body: bodyText, headers: auth(run.token) });
    expect(json(reply)).toEqual({ acknowledged: true }); // answered
    await hold.reached; // and the pass is waiting at its fault
    expect(inst.kube.writes.filter((w) => w.startsWith('delete'))).toEqual([]);
    const again = await request(c, { path: ROUTES.stopAck, body: bodyText, headers: auth(run.token) });
    expect(json(again)).toEqual({ acknowledged: true });
    expect(l.stats()['passes_started']).toBe(1); // a repeat starts nothing
    hold.release();
    await vi.waitFor(async () => { expect((await e.allocation(e.a, run.allocationId)).state).toBe('terminated'); }, { timeout: 10_000 });
  });

  it('plaintext exists only behind the test flag: an HTTP request on a plaintext test listener works, and the same on a TLS listener does not', async () => {
    const plain = await serve({}, undefined, true);
    const x = await started(plain.inst);
    const p = await connectAs(plain.l, 22, { tls: false });
    expect(json(await request(p, { path: ROUTES.acquire, body: body(x.a), headers: auth(x.token) }))).toMatchObject({ granted: true });
    const secure = await serve();
    const n = await connectAs(secure.l, 23, { tls: false });
    n.write('GET / HTTP/1.1\r\n\r\n');
    expect(await closedWithin(n, 3000)).toBe(true); // a TLS server answers a plain request with nothing it can use
  });
});
