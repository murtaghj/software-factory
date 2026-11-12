// Minimal HTTP client for the factory API. It carries the signed-in developer's bearer token and
// nothing else: every authorization, gate and budget rule is enforced by the API.
import { randomUUID } from 'node:crypto';

export type ApiResult = { status: number; body: unknown };
export type FactoryClientOptions = { baseUrl: string; token: () => Promise<string> | string; fetch?: typeof fetch };

export class FactoryClient {
  private readonly o: FactoryClientOptions;
  constructor(o: FactoryClientOptions) { this.o = { ...o, baseUrl: o.baseUrl.replace(/\/+$/, '') }; }

  async call(method: 'GET' | 'POST', path: string, body?: unknown, headers: Record<string, string> = {}): Promise<ApiResult> {
    const res = await (this.o.fetch ?? fetch)(`${this.o.baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${await this.o.token()}`, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let parsed: unknown = text;
    if (text.length > 0) { try { parsed = JSON.parse(text) as unknown; } catch { parsed = text; } }
    return { status: res.status, body: text.length > 0 ? parsed : undefined };
  }

  get(path: string): Promise<ApiResult> { return this.call('GET', path); }
  post(path: string, body: unknown, idempotencyKey: string = randomUUID(), headers: Record<string, string> = {}): Promise<ApiResult> { return this.call('POST', path, body, { 'idempotency-key': idempotencyKey, ...headers }); }
}
