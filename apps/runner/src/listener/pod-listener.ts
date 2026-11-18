// The pod-facing HTTPS listener (W-019, "The listener"). A thin transport over the permit service and the stop-acknowledgement service: it
// never touches the database. Admission, in this order, each step there so that the next cannot be starved by someone who failed the one before:
//   1. new connections, per source, on the plain socket, BEFORE any TLS work (a destroyed socket costs nothing);
//   2. open connections: 512 in all and a few per source, then the handshake, header and request time limits;
//   3. source charge: every request is charged to its source unless its token verified locally (the guard does that, through `admitSource`);
//   4. local verification; 5. the per-pod bucket; 6. the shared review budget; 7. the guard.
// Steps 4 to 7 are `PodGuard.review` and `authorizePodCall`.
//
// TLS always (D23): the certificate and key are required whatever the address. Plaintext exists only behind a flag the test configuration alone can set.
// A route answers first and reconciles after: the pass a stop-ack or a renewal sets off runs after the response is written, single-flight per allocation.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { BODY_MAX_BYTES, ROUTES, parseAcquireRequest, parseRenewRequest, parseStopAckRequest, statusOf, type PermitAnswer, type StopAckAnswer } from '@factory/runner-protocol';
import type { RunnerConfig } from '../config.ts';
import type { RunnerService } from '../runner.ts';
import { afterStopAck } from '../stop-ack.ts';
import { deny } from '../pod-guard.ts';
import { BucketTable } from './buckets.ts';

export const HANDSHAKE_MS = 5_000;
export const BODY_MS = 5_000;
export const REQUEST_MS = 10_000;
export const MAX_HEADER_BYTES = 16 * 1024;
export const MAX_OPEN_CONNECTIONS = 512;

export type PodListenerOptions = { runner: RunnerService; config: RunnerConfig; timeouts?: { handshakeMs?: number; bodyMs?: number; requestMs?: number }; onError?: (e: unknown) => void };
export type PodListener = {
  readonly port: number; readonly host: string;
  // Counters have fixed names: never a path, a source or a token.
  stats(): Record<string, number>;
  close(): Promise<void>;
};

const COUNTERS = ['connections', 'new_connection_refused', 'open_connection_refused', 'handshakes_begun', 'source_charge_refused', 'requests', 'bad_requests', 'passes_started'] as const;

export async function startPodListener(o: PodListenerOptions): Promise<PodListener> {
  const { runner, config } = o;
  const l = config.podListener;
  if (!l) throw new Error('no podListener is configured');
  const sw = config.test;
  const plaintext = sw?.plaintext === true;
  const t = { handshakeMs: o.timeouts?.handshakeMs ?? HANDSHAKE_MS, bodyMs: o.timeouts?.bodyMs ?? BODY_MS, requestMs: o.timeouts?.requestMs ?? REQUEST_MS };
  const now = (): number => (runner.deps.monotonicNowMs ?? ((): number => performance.now()))();
  const counts = Object.fromEntries(COUNTERS.map((c) => [c, 0])) as Record<(typeof COUNTERS)[number], number>;
  const sourceOf = (s: net.Socket): string => (sw?.sourceOf ? sw.sourceOf({ remoteAddress: s.remoteAddress, remotePort: s.remotePort }) : (s.remoteAddress ?? 'unknown'));

  const newConns = new BucketTable(4096, config.sourceNewConnections.perSecond, config.sourceNewConnections.burst);
  const charges = new BucketTable(4096, config.sourceRate.perSecond, config.sourceRate.burst);
  const open = new Map<string, number>();
  const sockets = new Set<net.Socket>();
  const sourceOfSocket = new WeakMap<object, string>();
  let total = 0;

  // The charge: called by the guard for every request whose token did not verify locally, and here for what never reaches it.
  const charge = (source: string | undefined): boolean => {
    if (sw?.relaxSourceLimits === true) return true;
    const ok = charges.take(source ?? 'unknown', now());
    if (!ok) counts.source_charge_refused += 1;
    return ok;
  };
  runner.deps.admitSource = charge;

  const inflight = new Set<string>();
  const kickPass = (orgId: string, allocationId: string, beforePass?: () => Promise<void>): void => {
    if (inflight.has(allocationId)) return; // single-flight per allocation: a repeat while one runs starts nothing
    inflight.add(allocationId);
    counts.passes_started += 1;
    void (async (): Promise<void> => {
      try { await beforePass?.(); await runner.reconcileOne(orgId, allocationId); } catch (e) { o.onError?.(e); } finally { inflight.delete(allocationId); }
    })();
  };

  const send = (res: http.ServerResponse, status: number, body: unknown, close = false): void => {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...(close ? { connection: 'close' } : {}) });
    res.end(text);
  };
  // No detail: a refusal that is not a typed denial says only its status.
  const bare = (res: http.ServerResponse, status: number, close = false): void => { res.writeHead(status, { 'content-length': 0, ...(close ? { connection: 'close' } : {}) }); res.end(); };

  const handler = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    counts.requests += 1;
    const source = sourceOfSocket.get(req.socket) ?? sourceOf(req.socket);
    // A request that is refused before its token is looked at is charged like any other unverified one; an empty bucket is a 429 and the connection is closed.
    const refuse = (status: number): void => {
      counts.bad_requests += 1;
      if (!charge(source)) { send(res, 429, deny('throttled', 'source_capped'), true); return; }
      if (status === 413) { // an oversized body: answer, then destroy the connection, so that nothing keeps draining it
        res.once('finish', () => { req.socket.destroy(); });
        bare(res, 413, true);
        return;
      }
      bare(res, status);
    };
    const path = req.url ?? '';
    const route = path === ROUTES.acquire ? 'acquire' : path === ROUTES.renew ? 'renew' : path === ROUTES.stopAck ? 'stopAck' : undefined;
    if (route === undefined) { req.resume(); refuse(404); return; }
    if (req.method !== 'POST') { req.resume(); refuse(405); return; }
    if (!/^application\/json(\s*;.*)?$/i.test(req.headers['content-type'] ?? '')) { req.resume(); refuse(415); return; }
    const len = Number(req.headers['content-length'] ?? '0');
    if (Number.isFinite(len) && len > BODY_MAX_BYTES) { req.resume(); refuse(413); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; counts.bad_requests += 1; req.socket.destroy(); } }, t.bodyMs); // a slow body is cut
    req.on('data', (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > BODY_MAX_BYTES) { done = true; clearTimeout(timer); req.resume(); refuse(413); return; }
      chunks.push(c);
    });
    req.on('error', () => { done = true; clearTimeout(timer); });
    req.on('end', () => {
      if (done) return;
      done = true; clearTimeout(timer);
      void respond(route, chunks, req, res, source).catch((e: unknown) => { o.onError?.(e); if (!res.headersSent) bare(res, 500, true); });
    });
  };

  async function respond(route: 'acquire' | 'renew' | 'stopAck', chunks: Buffer[], req: http.IncomingMessage, res: http.ServerResponse, source: string): Promise<void> {
    let json: unknown;
    try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; } catch { json = undefined; }
    const parsed = route === 'acquire' ? parseAcquireRequest(json) : route === 'renew' ? parseRenewRequest(json) : parseStopAckRequest(json);
    const auth = req.headers['authorization'];
    const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!parsed.ok) {
      counts.bad_requests += 1;
      if (!charge(source)) { send(res, 429, deny('throttled', 'source_capped'), true); return; }
      send(res, 400, deny('invalid_request', 'body'));
      return;
    }
    const v = parsed.value;
    const base = { token, orgId: v.orgId, allocationId: v.allocationId, epoch: v.epoch, source };
    let answer: PermitAnswer | StopAckAnswer;
    let after: (() => void) | undefined;
    if (route === 'stopAck') {
      const r = await runner.stopAck(base);
      if ('acknowledged' in r) { answer = { acknowledged: true }; if (!r.repeat) after = () => { kickPass(v.orgId, v.allocationId, () => afterStopAck(runner.deps)); }; } else answer = r;
    } else {
      const r = route === 'acquire' ? await runner.acquireStartPermit({ ...base, ...('report' in v && typeof v.report === 'string' ? { report: v.report } : {}) }) : await runner.renewPermit(base);
      answer = r;
      // A harness that has exited is stopped by the pass this sets off, after the answer has been written.
      if (r.granted && r.harness?.state === 'terminated') after = () => { kickPass(v.orgId, v.allocationId); };
    }
    const close = !('acknowledged' in answer) && !answer.granted && answer.reason === 'source_capped';
    res.on('finish', () => { after?.(); });
    send(res, statusOf(answer), answer, close);
  }

  const httpOpts = { maxHeaderSize: MAX_HEADER_BYTES, headersTimeout: t.bodyMs, requestTimeout: t.requestMs, connectionsCheckingInterval: 250, keepAliveTimeout: 60_000 };
  const inner: http.Server = plaintext
    ? http.createServer(httpOpts, handler)
    : https.createServer({ ...httpOpts, cert: l.cert, key: l.key, handshakeTimeout: t.handshakeMs } as https.ServerOptions, handler);
  inner.on('tlsClientError', () => { /* a failed handshake is the client's; nothing is logged */ });
  inner.on('clientError', (_e, s: net.Socket) => { if (!s.destroyed) s.destroy(); });

  // The plain socket in front: steps 1 and 2 run here, before any TLS work.
  const front = net.createServer((sock) => {
    counts.connections += 1;
    const source = sourceOf(sock);
    if (sw?.noNewConnectionBucket !== true && !newConns.take(source, now())) { counts.new_connection_refused += 1; sock.destroy(); return; }
    const mine = open.get(source) ?? 0;
    if (total >= MAX_OPEN_CONNECTIONS || mine >= config.sourceConnections) { counts.open_connection_refused += 1; sock.destroy(); return; }
    total += 1; open.set(source, mine + 1); sockets.add(sock);
    sourceOfSocket.set(sock, source);
    sock.on('close', () => {
      total -= 1; sockets.delete(sock);
      const n = (open.get(source) ?? 1) - 1;
      if (n <= 0) open.delete(source); else open.set(source, n);
    });
    sock.on('error', () => { /* the close handler runs next */ });
    if (!plaintext) counts.handshakes_begun += 1;
    inner.emit('connection', sock);
  });
  await new Promise<void>((resolve, reject) => { front.once('error', reject); front.listen(l.port, l.host, () => { front.off('error', reject); resolve(); }); });
  const addr = front.address() as net.AddressInfo;
  return {
    port: addr.port, host: l.host,
    stats: () => ({ ...counts, open_connections: total }),
    close: async (): Promise<void> => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => { front.close(() => { r(); }); });
      await new Promise<void>((r) => { inner.close(() => { r(); }); inner.closeAllConnections(); });
    },
  };
}
