// The permit client: the supervisor's only way to the runner. One connection to the listener is kept alive and reused for every call (the listener's per-source
// numbers are sized on this); it opens a new one only when that one is lost. The CA is pinned (the one file, no system roots), and the certificate's name is checked.
// The token is read from its file on every call and never kept; one `unauthenticated` is retried once after a fresh read.
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { ROUTES, parsePermitAnswer, parseStopAckAnswer, type PermitAnswer, type PermitDenialAnswer, type StopAckAnswer } from '@factory/runner-protocol';
import { mintGrant, type Grant } from './grant.ts';

export type Ids = { orgId: string; allocationId: string; epoch: number };
export type CallResult<T> = { kind: 'answer'; status: number; answer: T } | { kind: 'transport'; message: string };
export type Granted = { kind: 'granted'; grant: Grant; harness: 'waiting' | 'running' | 'terminated' | 'unknown' | undefined; sentAtMs: number };
export type PermitOutcome = Granted | { kind: 'denied'; denial: PermitDenialAnswer } | { kind: 'transport'; message: string };

export const REQUEST_LIMIT_MS = 5000;

export class RunnerClient {
  readonly #url: URL;
  readonly #agent: http.Agent;
  readonly #ca: Buffer | undefined;
  readonly #readToken: () => string;
  readonly #now: () => number;
  readonly #limitMs: number;
  readonly #plain: boolean;

  constructor(o: { url: URL; ca?: Buffer | undefined; readToken: () => string; now: () => number; limitMs?: number }) {
    this.#url = o.url; this.#ca = o.ca; this.#readToken = o.readToken; this.#now = o.now; this.#limitMs = o.limitMs ?? REQUEST_LIMIT_MS;
    this.#plain = o.url.protocol === 'http:';
    // `ca` replaces the default roots: this client trusts that one CA and nothing else.
    this.#agent = this.#plain ? new http.Agent({ keepAlive: true, maxSockets: 1 }) : new https.Agent({ keepAlive: true, maxSockets: 1, ...(o.ca ? { ca: o.ca } : {}), minVersion: 'TLSv1.2' });
  }
  close(): void { this.#agent.destroy(); }

  // One request, with the token read now. A failure to read the token is a transport failure: the runner would answer `unauthenticated` anyway.
  #post(path: string, body: unknown, token: string, limitMs: number): Promise<CallResult<unknown>> {
    return new Promise((resolve) => {
      const payload = Buffer.from(JSON.stringify(body));
      const opts: https.RequestOptions = {
        protocol: this.#url.protocol, hostname: this.#url.hostname.replace(/^\[|\]$/g, ''), port: this.#url.port, path, method: 'POST', agent: this.#agent,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': payload.length }, signal: AbortSignal.timeout(Math.max(1, Math.ceil(limitMs))),
      };
      const done = (r: CallResult<unknown>): void => { resolve(r); };
      const req = (this.#plain ? http : https).request(opts, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => { size += c.length; if (size > 64 * 1024) { res.destroy(); done({ kind: 'transport', message: 'the answer is too large' }); return; } chunks.push(c); });
        res.on('end', () => {
          try { done({ kind: 'answer', status: res.statusCode ?? 0, answer: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }); } catch { done({ kind: 'transport', message: 'the answer is not JSON' }); }
        });
        res.on('error', (e) => { done({ kind: 'transport', message: e.message }); });
      });
      req.on('error', (e) => { done({ kind: 'transport', message: e.name === 'AbortError' || e.name === 'TimeoutError' ? 'the request limit passed' : e.message }); });
      req.end(payload);
    });
  }

  // `untilMs` (a point on the monotonic clock) is the fence time: no request may outlive it, and none is begun after it. The request limit is the lesser of 5 s and what is left.
  async #call(path: string, body: unknown, untilMs?: number): Promise<CallResult<unknown>> {
    const left = (): number => (untilMs === undefined ? this.#limitMs : Math.min(this.#limitMs, untilMs - this.#now()));
    if (left() <= 0) return { kind: 'transport', message: 'the fence time has passed' };
    let token: string;
    try { token = this.#readToken(); } catch { return { kind: 'transport', message: 'the token file could not be read' }; }
    const first = await this.#post(path, body, token, left());
    // One `unauthenticated` is retried once after a fresh read: the token may have been rotated between the read and the review.
    if (first.kind === 'answer' && first.status === 401) {
      if (left() <= 0) return first; // the fence time passed while the first call ran: no retry is sent after it
      let again: string;
      try { again = this.#readToken(); } catch { return first; }
      return this.#post(path, body, again, left());
    }
    return first;
  }

  async #permit(path: string, ids: Ids, extra: { report?: string } = {}, untilMs?: number): Promise<PermitOutcome> {
    const sentAtMs = this.#now();
    const r = await this.#call(path, { ...ids, ...extra }, untilMs);
    if (r.kind === 'transport') return r;
    const parsed = parsePermitAnswer(r.answer);
    if (!parsed.ok) return { kind: 'transport', message: 'the answer is not a permit answer' };
    const a: PermitAnswer = parsed.value;
    if (!a.granted) return { kind: 'denied', denial: a };
    return { kind: 'granted', grant: mintGrant(a), harness: a.harness?.state, sentAtMs };
  }
  acquire(ids: Ids, report?: string): Promise<PermitOutcome> { return this.#permit(ROUTES.acquire, ids, report === undefined ? {} : { report }); }
  renew(ids: Ids, o: { untilMs?: number } = {}): Promise<PermitOutcome> { return this.#permit(ROUTES.renew, ids, {}, o.untilMs); }
  async stopAck(ids: Ids): Promise<{ kind: 'acknowledged' } | { kind: 'denied'; denial: PermitDenialAnswer } | { kind: 'transport'; message: string }> {
    const r = await this.#call(ROUTES.stopAck, ids);
    if (r.kind === 'transport') return r;
    const parsed = parseStopAckAnswer(r.answer);
    if (!parsed.ok) return { kind: 'transport', message: 'the answer is not a stop answer' };
    const a: StopAckAnswer = parsed.value;
    return 'acknowledged' in a ? { kind: 'acknowledged' } : { kind: 'denied', denial: a };
  }

  // One handshake with the listener, and nothing else: what the network gate may spend once its rounds have passed. (Plain: one connect.)
  probe(): Promise<boolean> {
    return new Promise((resolve) => {
      const port = Number(this.#url.port || (this.#plain ? 80 : 443));
      const host = this.#url.hostname.replace(/^\[|\]$/g, '');
      const s = tls.connect({ host, port, ...(this.#ca ? { ca: this.#ca } : {}), servername: host.match(/^[0-9.]+$|:/) ? '' : host, minVersion: 'TLSv1.2' });
      const end = (ok: boolean): void => { s.destroy(); resolve(ok); };
      s.setTimeout(this.#limitMs, () => { end(false); });
      s.once('secureConnect', () => { end(s.authorized); });
      s.once('error', () => { end(false); });
    });
  }
}
