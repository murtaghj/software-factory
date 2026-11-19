// The permit client against a local node:https server: the CA is the only trust, the name is checked, the token is read per call, and the supervisor's exit codes.
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ArgsRefused, parseServeArgs } from '../src/args.ts';
import { RunnerClient } from '../src/runner-client.ts';
import { runSupervisorWith } from '../src/testing.ts';
import { IDS, denial, fakeRunner, makePki, type Pki } from './kit.ts';

let good: Pki; let other: Pki; let wrongName: Pki; let dir: string;
beforeAll(() => { good = makePki(); other = makePki(); wrongName = makePki('IP:10.9.9.9'); dir = mkdtempSync(join(tmpdir(), 'w019-client-')); });
afterAll(() => { good.cleanup(); other.cleanup(); wrongName.cleanup(); rmSync(dir, { recursive: true, force: true }); });

const client = (url: URL, ca: Buffer | undefined, readToken: () => string, limitMs?: number) => new RunnerClient({ url, ca, readToken, now: () => performance.now(), ...(limitMs === undefined ? {} : { limitMs }) });
const freePort = (): Promise<number> => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => { resolve(p); }); }); });

describe('W-019 the permit client', () => {
  it('the CA is pinned and system roots are not used; a certificate from the right CA with the wrong name is refused; control: the right CA and name connect', async () => {
    const ok = await fakeRunner({ pki: good });
    expect((await client(ok.url, good.ca, () => 'tok').acquire(IDS)).kind).toBe('granted'); // control
    expect(await client(ok.url, good.ca, () => 'tok').probe()).toBe(true);
    const refused = await client(ok.url, other.ca, () => 'tok').acquire(IDS); // another CA: this client trusts that one CA and nothing else
    expect(refused).toMatchObject({ kind: 'transport' });
    expect(await client(ok.url, other.ca, () => 'tok').probe()).toBe(false);
    expect(await client(ok.url, undefined, () => 'tok').probe()).toBe(false); // no CA given: no system root vouches for a throwaway certificate
    await ok.close();
    const named = await fakeRunner({ pki: wrongName });
    expect(await client(named.url, wrongName.ca, () => 'tok').acquire(IDS)).toMatchObject({ kind: 'transport' }); // signed by the CA it trusts, for another address
    await named.close();
  });

  it('a CA file whose digest is not the argument\'s is refused at boot (exit 64) and nothing is sent; control: the right digest boots and reaches the runner', async () => {
    const srv = await fakeRunner({ pki: good, script: () => ({ body: denial('duplicate_writer') }) });
    const caFile = join(dir, 'ca.crt'); const tokenFile = join(dir, 'token');
    writeFileSync(caFile, good.ca); writeFileSync(tokenFile, 'tok');
    const argv = (digest: string, port: number): string[] => ['serve', '--org', IDS.orgId, '--allocation', IDS.allocationId, '--epoch', '1', '--generation', '1', '--runner', srv.url.href.replace(/\/$/, ''), '--runner-ca-sha256', digest, '--listen', `127.0.0.1:${String(port)}`, '--network-gate', 'disabled'];
    const run = async (digest: string) => runSupervisorWith({ argv: argv(digest, await freePort()), paths: { token: tokenFile, ca: caFile, workspace: dir }, term: new AbortController().signal }, { allowPlainLoopbackRunner: true });
    expect(await run('0'.repeat(64))).toBe(64);
    expect(srv.seen).toHaveLength(0);
    expect(await run(createHash('sha256').update(good.ca).digest('hex'))).toBe(65); // the control got as far as the acquire, and its denial is a duplicate writer
    expect(srv.seen).toHaveLength(1);
    await srv.close();
  });

  it('the production argument parser refuses http:, https://127.0.0.1, https://[::1], https://169.254.1.1 and https://0.0.0.0; control: a routable https host', () => {
    const argv = (url: string): string[] => ['serve', '--org', IDS.orgId, '--allocation', IDS.allocationId, '--epoch', '1', '--generation', '1', '--runner', url, '--runner-ca-sha256', 'a'.repeat(64), '--listen', '127.0.0.1:8765', '--network-gate', 'disabled'];
    for (const bad of ['http://192.168.127.254:18443', 'https://127.0.0.1:18443', 'https://[::1]:18443', 'https://169.254.1.1:18443', 'https://0.0.0.0:18443', 'https://localhost:18443']) expect(() => parseServeArgs(argv(bad)), bad).toThrow(ArgsRefused);
    expect(parseServeArgs(argv('https://192.168.127.254:18443')).runnerUrl.hostname).toBe('192.168.127.254');
    expect(parseServeArgs(argv('http://127.0.0.1:18443'), { allowPlainLoopbackRunner: true }).runnerUrl.protocol).toBe('http:'); // the test entry only
    expect(() => parseServeArgs(argv('ftp://192.168.127.254:18443'), { allowPlainLoopbackRunner: true })).toThrow(ArgsRefused);
  });

  it('the token is read once per call (a rotated token is what the server sees next); one unauthenticated is retried once, a second is final; one connection is reused for every call', async () => {
    let token = 'first';
    let reads = 0;
    const srv = await fakeRunner({ pki: good, script: (s) => (s.auth === 'Bearer stale' ? { status: 401, body: denial('unauthenticated') } : undefined) });
    const c = client(srv.url, good.ca, () => { reads += 1; return token; });
    await c.renew(IDS);
    token = 'rotated';
    await c.renew(IDS);
    expect(srv.seen.map((s) => s.auth)).toEqual(['Bearer first', 'Bearer rotated']);
    expect(reads).toBe(2);
    // an unauthenticated answer: re-read and retried ONCE (the rotation landed between the read and the review); a second one is final
    const reads2 = ['stale', 'fresh'];
    const rotating = client(srv.url, good.ca, () => reads2.shift() ?? 'fresh');
    expect((await rotating.renew(IDS)).kind).toBe('granted');
    const before = srv.seen.length;
    const stuck = client(srv.url, good.ca, () => 'stale');
    expect((await stuck.renew(IDS)).kind).toBe('denied');
    expect(srv.seen.length - before).toBe(2); // read, answered 401, read again, answered 401: final
    expect(srv.connections()).toBe(3); // one connection per client (three clients), each kept alive across its calls: c made 2 calls on 1
    await srv.close();
  });

  it('the request limit is 5 s by default and a hung answer is a transport failure at the limit', async () => {
    const srv = await fakeRunner({ pki: good, script: () => ({ hang: true }) });
    const t0 = performance.now();
    const r = await client(srv.url, good.ca, () => 'tok', 300).renew(IDS);
    expect(r).toMatchObject({ kind: 'transport' });
    expect(performance.now() - t0).toBeLessThan(2000);
    const { REQUEST_LIMIT_MS } = await import('../src/runner-client.ts');
    expect(REQUEST_LIMIT_MS).toBe(5000);
    await srv.close();
  });

  it('each final denial maps to its exit code: duplicate_writer 65, any other final denial 66; a retryable one is retried until the grant', async () => {
    const tokenFile = join(dir, 'token2'); writeFileSync(tokenFile, 'tok');
    const exitFor = async (code: string, retryable = false): Promise<number> => {
      const srv = await fakeRunner({ script: () => ({ body: denial(code, undefined, retryable) }) });
      const port = await freePort();
      const clockStub = { now: () => performance.now(), sleep: (): Promise<void> => Promise.resolve() };
      const rc = await runSupervisorWith({ argv: ['serve', '--org', IDS.orgId, '--allocation', IDS.allocationId, '--epoch', '1', '--generation', '1', '--runner', srv.url.href.replace(/\/$/, ''), '--runner-ca-sha256', 'a'.repeat(64), '--listen', `127.0.0.1:${String(port)}`, '--network-gate', 'disabled'],
        paths: { token: tokenFile, ca: join(dir, 'none'), workspace: dir }, term: new AbortController().signal, clock: clockStub, acquireCapMs: 50 }, { allowPlainLoopbackRunner: true });
      await srv.close();
      return rc;
    };
    expect(await exitFor('duplicate_writer')).toBe(65);
    for (const code of ['not_startable', 'stale_epoch', 'not_this_job', 'invalid_request', 'unauthenticated', 'no_receipt']) expect(await exitFor(code), code).toBe(66);
    // a retryable denial is retried until the cap, then 66: it never fenced anything
    expect(await exitFor('throttled', true)).toBe(66);
  });

  it('a request never outlives the fence time and none is begun after it: a hung server is cut at `untilMs`, a 401 is not retried once it has passed, and a call begun after it sends nothing', async () => {
    const hung = await fakeRunner({ pki: good, script: () => ({ hang: true }) });
    const t0 = performance.now();
    const r = await client(hung.url, good.ca, () => 'tok').renew(IDS, { untilMs: performance.now() + 300 }); // the limit is 5 s; what is left is 300 ms
    expect(r).toMatchObject({ kind: 'transport' });
    expect(performance.now() - t0).toBeLessThan(1500);
    await hung.close();
    const unauth = await fakeRunner({ pki: good, script: () => ({ status: 401, body: denial('unauthenticated') }) });
    const c = client(unauth.url, good.ca, () => 'tok');
    expect((await c.renew(IDS, { untilMs: performance.now() + 60_000 })).kind).toBe('denied');
    expect(unauth.seen).toHaveLength(2); // control: with time left the 401 is retried once
    const before = unauth.seen.length;
    expect(await c.renew(IDS, { untilMs: performance.now() - 1 })).toMatchObject({ kind: 'transport', message: 'the fence time has passed' });
    expect(unauth.seen).toHaveLength(before); // nothing was sent
    // the fence passes WHILE the first call runs: its 401 is not retried
    let n = 0;
    const slow401 = await fakeRunner({ pki: good, script: () => { n += 1; return { status: 401, body: denial('unauthenticated') }; } });
    const deadline = performance.now() + 5;
    const lateClient = client(slow401.url, good.ca, () => { const t = performance.now(); while (performance.now() - t < 20) { /* the token read takes longer than what is left */ } return 'tok'; });
    await lateClient.renew(IDS, { untilMs: deadline });
    expect(n).toBeLessThanOrEqual(1);
    await unauth.close(); await slow401.close();
  });

  it('the CA file must be exactly one valid X.509 CA certificate: an empty file (whose digest anyone can compute), garbage, two certificates and a leaf are each refused at boot, and nothing is sent; control: the real CA', async () => {
    const srv = await fakeRunner({ pki: good, script: () => ({ body: denial('duplicate_writer') }) });
    const tokenFile = join(dir, 'token3'); writeFileSync(tokenFile, 'tok');
    const exitFor = async (bytes: Buffer): Promise<number> => {
      const caFile = join(dir, `ca-${String(Math.random()).slice(2)}.crt`);
      writeFileSync(caFile, bytes);
      return runSupervisorWith({ argv: ['serve', '--org', IDS.orgId, '--allocation', IDS.allocationId, '--epoch', '1', '--generation', '1', '--runner', srv.url.href.replace(/\/$/, ''), '--runner-ca-sha256', createHash('sha256').update(bytes).digest('hex'),
        '--listen', `127.0.0.1:${String(await freePort())}`, '--network-gate', 'disabled'], paths: { token: tokenFile, ca: caFile, workspace: dir }, term: new AbortController().signal }, { allowPlainLoopbackRunner: true });
    };
    expect(await exitFor(Buffer.alloc(0))).toBe(64); // the digest of the empty string passes the digest check; the content check refuses it
    expect(await exitFor(Buffer.from('not a certificate\n'))).toBe(64);
    expect(await exitFor(Buffer.concat([good.ca, other.ca]))).toBe(64); // a bundle
    expect(await exitFor(Buffer.from(good.cert))).toBe(64); // a leaf: not a CA
    expect(srv.seen).toHaveLength(0);
    expect(await exitFor(good.ca)).toBe(65); // control: it boots and reaches the acquire
    expect(srv.seen).toHaveLength(1);
    await srv.close();
  });
});
