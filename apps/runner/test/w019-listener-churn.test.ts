// The churn flood (R2-1): a source that opens connections as fast as it can must not cost the event loop that answers everyone's renewals. The new-connection
// bucket acts on the plain socket, before any TLS work. The control asserts how many handshakes the server began, not a delay: a delay on this machine
// depends on what else is running, and a control that sometimes passes for the wrong reason is worse than none.
import { X509Certificate } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ROUTES } from '@factory/runner-protocol';
import { tokenAudience } from '../src/index.ts';
import { startPodListener, type PodListener } from '../src/listener/pod-listener.ts';
import { createEnv, hex, sleep, type Env } from './harness.ts';
import { connectAs, json, makePki, request, type Pki } from './listener-kit.ts';

let e: Env;
let pki: Pki;
beforeAll(async () => { pki = makePki(); e = await createEnv('w019_churn'); });
afterAll(async () => { await e.close(); pki.cleanup(); });
const open: PodListener[] = [];
afterEach(async () => { while (open.length > 0) await open.pop()?.close(); });

// B's connections come from a reserved port block; everything else (the churner's ephemeral ports) is source A.
const sourceOf = ({ remotePort }: { remoteAddress: string | undefined; remotePort: number | undefined }): string => ((remotePort ?? 0) >= 30_000 && (remotePort ?? 0) < 31_000 ? 'B' : 'A');
const ECDSA = /BEGIN CERTIFICATE/;

async function flood(over: { noNewConnectionBucket?: boolean }) {
  const inst = e.newRunner({ config: { podListener: { host: '127.0.0.1', port: 0, cert: pki.cert, key: pki.key }, test: { sourceOf, ...over }, podRate: { burst: 1000, intervalMs: 1 } } });
  const l = await startPodListener({ runner: inst.runner, config: inst.config });
  open.push(l);
  const s = await e.newStage(e.a);
  await inst.runner.startOrAttach(e.ctx(e.a), e.input(e.a, s), hex('e'));
  const a = (await e.allocations(e.a, s))[0] as NonNullable<Awaited<ReturnType<typeof e.allocations>>[number]>;
  const pod = inst.kube.driver.podsOf(a.jobName)[0] as NonNullable<ReturnType<typeof inst.kube.driver.podsOf>[number]>;
  inst.kube.driver.startPod(pod.metadata.name);
  const token = inst.kube.mintToken(pod, tokenAudience(e.a.orgId, a.id));
  expect(await inst.runner.acquireStartPermit({ token, orgId: e.a.orgId, allocationId: a.id, epoch: 1 })).toMatchObject({ granted: true });
  const body = JSON.stringify({ orgId: e.a.orgId, allocationId: a.id, epoch: 1 });
  const b = await connectAs(l, 10, { tls: true, ca: pki.ca }); // source B: one kept-alive connection (block 30)
  const startedHandshakes = l.stats()['handshakes_begun'] as number;

  let attempts = 0;
  let stop = false;
  const churn = async (shape: 'hello-and-hangup' | 'full-handshake'): Promise<void> => {
    while (!stop) {
      attempts += 1;
      await new Promise<void>((resolve) => {
        const raw = net.connect({ host: l.host, port: l.port });
        raw.once('error', () => { resolve(); });
        raw.once('close', () => { resolve(); });
        raw.once('connect', () => {
          const t = tls.connect({ socket: raw, host: l.host, ca: pki.ca });
          t.once('error', () => { resolve(); });
          if (shape === 'hello-and-hangup') { setImmediate(() => { raw.destroy(); resolve(); }); return; }
          t.once('secureConnect', () => { t.write('POST /junk HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n'); setTimeout(() => { t.destroy(); resolve(); }, 1); });
        });
      });
    }
  };
  const latencies: number[] = [];
  const granted: boolean[] = [];
  const started = performance.now();
  const churners = [churn('hello-and-hangup'), churn('full-handshake')];
  while (performance.now() - started < 3000) {
    const t0 = performance.now();
    const r = json(await request(b, { path: ROUTES.renew, body, headers: { Authorization: `Bearer ${token}` } }));
    latencies.push(performance.now() - t0);
    granted.push(r['granted'] === true);
    await sleep(250);
  }
  stop = true;
  await Promise.all(churners);
  const stats = l.stats();
  return { stats, attempts, begunForA: (stats['handshakes_begun'] as number) - startedHandshakes, latencies, granted };
}

describe('W-019 connection churn', () => {
  it('the listener certificate is ECDSA P-256', () => {
    expect(ECDSA.test(pki.cert)).toBe(true);
    expect(new X509Certificate(pki.cert).publicKey.asymmetricKeyDetails).toMatchObject({ namedCurve: 'prime256v1' });
  });

  it('source A churns for three seconds in two shapes: the server begins at most the burst plus the refill (20 + 5 a second) handshakes for A, the rest are destroyed before any TLS work and counted; source B\'s renewals are all granted inside the 5 s request limit', async () => {
    const r = await flood({});
    expect(r.begunForA).toBeLessThanOrEqual(20 + 5 * 4); // 3 s of refill, with a second's slack
    expect(r.stats['new_connection_refused']).toBeGreaterThan(50);
    expect(r.attempts).toBeGreaterThan(r.begunForA * 2); // the churner really did churn
    expect(r.granted.length).toBeGreaterThanOrEqual(8);
    expect(r.granted.every(Boolean)).toBe(true);
    expect(Math.max(...r.latencies)).toBeLessThan(5000);
    console.info(`[w019-churn] limited: attempts=${String(r.attempts)} begun=${String(r.begunForA)} B max latency ${Math.round(Math.max(...r.latencies))} ms`);
  }, 30_000);

  it('control: with the new-connection bucket off the churner reaches the handshake far more often than the limit allows, and nothing is refused by the bucket', async () => {
    const r = await flood({ noNewConnectionBucket: true });
    expect(r.stats['new_connection_refused']).toBe(0);
    // every attempt was either begun or refused by the open-connection cap: none was dropped for its rate
    expect(r.begunForA + (r.stats['open_connection_refused'] as number)).toBeGreaterThanOrEqual(r.attempts - 2);
    expect(r.begunForA).toBeGreaterThan(20 + 5 * 4);
    console.info(`[w019-churn] control: attempts=${String(r.attempts)} begun=${String(r.begunForA)} B max latency ${Math.round(Math.max(...r.latencies))} ms`);
  }, 30_000);
});
