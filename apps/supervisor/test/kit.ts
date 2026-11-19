// Test kit for the supervisor's units: a virtual monotonic clock, a scriptable stand-in for the runner's listener, and a throwaway CA.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Clock } from '../src/heartbeat.ts';

// Time that only the test moves. `sleep` resolves when `advance` passes its deadline (or when its wake signal fires).
export class VirtualClock implements Clock {
  #now = 0;
  readonly #timers: Array<{ at: number; resolve: () => void }> = [];
  readonly now = (): number => this.#now;
  readonly sleep = (ms: number, wake?: AbortSignal): Promise<void> => new Promise<void>((resolve) => {
    if (wake?.aborted === true) { resolve(); return; }
    const t = { at: this.#now + ms, resolve };
    this.#timers.push(t);
    wake?.addEventListener('abort', () => { const i = this.#timers.indexOf(t); if (i >= 0) this.#timers.splice(i, 1); resolve(); }, { once: true });
  });
  // Moves time forward in 100 ms steps, letting every awaiting promise run between steps.
  async advance(ms: number): Promise<void> {
    const end = this.#now + ms;
    while (this.#now < end) {
      await flush();
      this.#now = Math.min(end, this.#now + 100);
      for (const t of this.#timers.filter((x) => x.at <= this.#now)) { this.#timers.splice(this.#timers.indexOf(t), 1); t.resolve(); }
    }
    await flush();
  }
  set(ms: number): void { this.#now = ms; }
}
export const flush = async (): Promise<void> => { for (let i = 0; i < 20; i += 1) await new Promise<void>((r) => { setImmediate(r); }); };

export type Pki = { ca: Buffer; cert: string; key: string; cleanup: () => void };
export function makePki(san = 'IP:127.0.0.1'): Pki {
  const dir = mkdtempSync(join(tmpdir(), 'w019-sup-pki-'));
  const run = (...a: string[]): void => { execFileSync('openssl', a, { cwd: dir, stdio: 'pipe' }); };
  writeFileSync(join(dir, 'ca.cnf'), '[req]\ndistinguished_name=dn\nprompt=no\nx509_extensions=ca\n[dn]\nCN=w019-sup-ca\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n');
  writeFileSync(join(dir, 'leaf.cnf'), `[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=w019-sup-leaf\n[san]\nsubjectAltName=${san}\n`);
  run('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'ca.key');
  run('req', '-x509', '-new', '-key', 'ca.key', '-sha256', '-days', '2', '-config', 'ca.cnf', '-out', 'ca.crt');
  run('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'leaf.key');
  run('req', '-new', '-key', 'leaf.key', '-config', 'leaf.cnf', '-out', 'leaf.csr');
  run('x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-sha256', '-days', '2', '-extfile', 'leaf.cnf', '-extensions', 'san', '-out', 'leaf.crt');
  const out = { ca: readFileSync(join(dir, 'ca.crt')), cert: readFileSync(join(dir, 'leaf.crt'), 'utf8'), key: readFileSync(join(dir, 'leaf.key'), 'utf8') };
  rmSync(join(dir, 'ca.key'));
  return { ...out, cleanup: () => { rmSync(dir, { recursive: true, force: true }); } };
}

export type Seen = { path: string; auth: string; body: Record<string, unknown> };
export type Script = (seen: Seen, n: number) => { status?: number; body?: unknown; hang?: boolean } | undefined;
// A stand-in for the runner's pod listener: every request is recorded, and the script answers it (default: a grant).
export async function fakeRunner(o: { pki?: Pki; script?: Script }): Promise<{ url: URL; seen: Seen[]; connections: () => number; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  let conns = 0;
  const handler: http.RequestListener = (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const s: Seen = { path: req.url ?? '', auth: req.headers['authorization'] ?? '', body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown> };
      seen.push(s);
      const r = o.script?.(s, seen.length) ?? { body: { granted: true, allocationId: String(s.body['allocationId']), generation: 1, epoch: Number(s.body['epoch']), podUid: 'pod-uid-1', leaseSeconds: 60, beatSeconds: 10, harness: { state: 'running' } } };
      if (r.hang === true) return;
      const text = JSON.stringify(r.body ?? {});
      res.writeHead(r.status ?? 200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
      res.end(text);
    });
  };
  const server = o.pki ? https.createServer({ cert: o.pki.cert, key: o.pki.key }, handler) : http.createServer(handler);
  server.on('connection', () => { conns += 1; });
  await new Promise<void>((r) => { server.listen(0, '127.0.0.1', r); });
  const port = (server.address() as { port: number }).port;
  return { url: new URL(`${o.pki ? 'https' : 'http'}://127.0.0.1:${String(port)}`), seen, connections: () => conns, close: async () => { server.closeAllConnections(); await new Promise<void>((r) => { server.close(() => { r(); }); }); } };
}
export const IDS = { orgId: '11111111-1111-4111-8111-111111111111', allocationId: '22222222-2222-4222-8222-222222222222', epoch: 1 };
export const grantBody = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ granted: true, allocationId: IDS.allocationId, generation: 1, epoch: 1, podUid: 'p', leaseSeconds: 60, beatSeconds: 10, ...over });
export const denial = (code: string, reason?: string, retryable = false): Record<string, unknown> => ({ granted: false, code, retryable, ...(reason === undefined ? {} : { reason }) });
