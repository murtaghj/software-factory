// The local endpoint (`--listen 127.0.0.1:8765`, as `examples/kubernetes-job.json`): loopback peers only, eight connections, three routes and 404 for the rest.
// None of the three grants anything. The authenticated tool routes are W-075's.
//   GET  /v1/start  long poll: { start: true } once the state is `running`; { start: false, reason } once the supervisor is fenced or ending.
//   GET  /v1/stop   long poll: answers when the stop flag is set.
//   POST /v1/exit   the hint (256 bytes). Nothing decides on it (rule 5).
import http from 'node:http';
import type { State } from './state.ts';

export const MAX_LOCAL_CONNECTIONS = 8;
export const MAX_HINT_BYTES = 256;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const POLL_MS = 20_000;

export type LocalEndpoint = { port: number; close: () => Promise<void> };
export async function startLocalEndpoint(o: { state: State; port: number; onHint: () => void; pollMs?: number }): Promise<LocalEndpoint> {
  const { state } = o;
  const server = http.createServer((req, res) => {
    const reply = (status: number, body?: unknown): void => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(body === undefined ? undefined : JSON.stringify(body)); };
    if (!LOOPBACK.has(req.socket.remoteAddress ?? '')) { req.socket.destroy(); return; }
    const poll = (decide: () => unknown): void => {
      const first = decide();
      if (first !== undefined) { reply(200, first); return; }
      const off = state.onChange(() => { const d = decide(); if (d !== undefined) { cleanup(); reply(200, d); } });
      const t = setTimeout(() => { cleanup(); reply(200, { pending: true }); }, o.pollMs ?? POLL_MS);
      const cleanup = (): void => { off(); clearTimeout(t); };
      req.on('close', cleanup);
    };
    if (req.method === 'GET' && req.url === '/v1/start') { poll(() => state.startDecision()); return; }
    if (req.method === 'GET' && req.url === '/v1/stop') { poll(() => (state.stopFlag ? { stop: true } : undefined)); return; }
    if (req.method === 'POST' && req.url === '/v1/exit') {
      let size = 0;
      let over = false;
      req.on('data', (c: Buffer) => { size += c.length; if (size > MAX_HINT_BYTES && !over) { over = true; reply(413); req.destroy(); } });
      req.on('end', () => { if (over) return; o.onHint(); reply(204); });
      return;
    }
    req.resume();
    reply(404);
  });
  server.maxConnections = MAX_LOCAL_CONNECTIONS;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(o.port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  return { port: (server.address() as { port: number }).port, close: async () => { server.closeAllConnections(); await new Promise<void>((r) => { server.close(() => { r(); }); }); } };
}
