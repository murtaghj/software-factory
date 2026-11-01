// Minimal JSON-over-HTTP plumbing for the fixture services (node:http, no framework).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseTraceparent, type TraceContext } from './tracing.ts';

export type JsonRequest = { method: string; path: string; headers: IncomingMessage['headers']; body: unknown; trace: TraceContext | undefined };
export type JsonResponse = { status: number; body?: unknown };
export type Handler = (req: JsonRequest) => Promise<JsonResponse>;
export type Route = { method: string; pattern: RegExp; handler: (req: JsonRequest, params: string[]) => Promise<JsonResponse> };

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString('utf8');
  return text.length === 0 ? undefined : JSON.parse(text) as unknown;
}

export type RunningServer = { url: string; close: () => Promise<void>; server: Server };

export async function serve(routes: Route[], hooks: { onResponse?: (req: JsonRequest, res: JsonResponse, raw: ServerResponse) => boolean } = {}): Promise<RunningServer> {
  const server = createServer((raw, out) => {
    void (async () => {
      let request: JsonRequest | undefined;
      try {
        const url = new URL(raw.url ?? '/', 'http://fixture');
        request = { method: raw.method ?? 'GET', path: url.pathname + url.search, headers: raw.headers, body: await readBody(raw), trace: parseTraceparent(raw.headers.traceparent as string | undefined) };
        const req = request;
        const route = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
        const match = route ? route.pattern.exec(url.pathname) : null;
        const res = route && match ? await route.handler(req, match.slice(1)) : { status: 404, body: { error: 'not_found' } };
        if (hooks.onResponse?.(req, res, out) === true) return; // fault injection consumed the response
        out.writeHead(res.status, { 'content-type': 'application/json' });
        out.end(res.body === undefined ? '' : JSON.stringify(res.body));
      } catch (e) {
        out.writeHead(500, { 'content-type': 'application/json' });
        out.end(JSON.stringify({ error: 'internal_error', detail: e instanceof Error ? e.message : String(e) }));
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    server,
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close((err) => { if (err) reject(err); else resolve(); });
    }),
  };
}

export async function callJson(url: string, init: { method: string; body?: unknown; headers?: Record<string, string>; timeoutMs?: number }): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, {
    method: init.method,
    headers: { 'content-type': 'application/json', ...init.headers },
    signal: AbortSignal.timeout(init.timeoutMs ?? 5000),
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text.length > 0 ? JSON.parse(text) as unknown : undefined };
}
