// Known-good inventory client: sends the inventory-http-v1 ReservationRequest. On a transport
// failure it retries once with the same idempotency key (identical in every release).
import { callJson } from '../http.ts';
import { contextOf, formatTraceparent, type TraceContext } from '../tracing.ts';
import type { ServiceDeps } from '../deps.ts';

export type ReserveLine = { orderId: string; sku: string; quantity: number };
export type ReserveOutcome = { ok: boolean; status: number };

export function reservationBody(line: ReserveLine): Record<string, unknown> {
  return { orderId: line.orderId, sku: line.sku, quantity: line.quantity, idempotencyKey: `${line.orderId}:${line.sku}` };
}

export function makeInventoryClient(buildBody: (line: ReserveLine) => Record<string, unknown>) {
  return async function reserveLine(deps: ServiceDeps, inventoryUrl: string, parent: TraceContext, line: ReserveLine): Promise<ReserveOutcome> {
    const body = buildBody(line);
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const span = deps.collector.start('orders', 'POST inventory /reservations', 'client', parent);
      span.boundary = { callee: 'inventory', interfaceId: 'inventory-http-v1', operation: 'ReservationRequest', request: structuredClone(body) };
      try {
        const res = await callJson(`${inventoryUrl}/reservations`, { method: 'POST', body, headers: { traceparent: formatTraceparent(contextOf(span)) }, timeoutMs: 2000 });
        span.boundary.responseStatus = res.status;
        span.boundary.response = res.body;
        deps.collector.end(span, { status: res.status >= 500 ? 'error' : 'ok', httpStatus: res.status });
        return { ok: res.status === 200 || res.status === 201, status: res.status };
      } catch (e) {
        deps.collector.end(span, { status: 'error', error: e instanceof Error ? e.message : String(e) });
        if (attempt === 2) return { ok: false, status: 504 };
      }
    }
    return { ok: false, status: 504 };
  };
}

export const reserveLine = makeInventoryClient(reservationBody);
