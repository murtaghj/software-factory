// Orders API (fixture). Implements contracts/orders-http-v1 and calls inventory-http-v1.
import { randomUUID } from 'node:crypto';
import { serve, type JsonRequest, type RunningServer } from '../http.ts';
import { contextOf, formatTraceparent, type TraceContext } from '../tracing.ts';
import type { HandlerResult, ServiceDeps } from '../deps.ts';
import type { ReserveLine, ReserveOutcome } from './inventory-client.ts';

export type OrdersVariant = {
  reserveLine: (deps: ServiceDeps, inventoryUrl: string, parent: TraceContext, line: ReserveLine) => Promise<ReserveOutcome>;
  cancelOrder?: (deps: ServiceDeps, inventoryUrl: string, parent: TraceContext, orderId: string, customerId: string | undefined) => Promise<HandlerResult>;
};

const SKU = /^SKU-[A-Z0-9-]+$/;

function parseItems(body: unknown): Array<{ sku: string; quantity: number }> | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const items = (body as { items?: unknown }).items;
  if (!Array.isArray(items) || items.length === 0 || items.length > 10) return undefined;
  const out: Array<{ sku: string; quantity: number }> = [];
  for (const item of items as unknown[]) {
    if (typeof item !== 'object' || item === null) return undefined;
    const { sku, quantity } = item as { sku?: unknown; quantity?: unknown };
    if (typeof sku !== 'string' || !SKU.test(sku) || typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1 || quantity > 100) return undefined;
    out.push({ sku, quantity });
  }
  return out;
}

const customerOf = (req: JsonRequest): string | undefined => {
  const v = req.headers['x-customer-id'];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
};

export async function startOrders(deps: ServiceDeps, inventoryUrl: string, variant: OrdersVariant): Promise<RunningServer> {
  const withSpan = (operation: string, fn: (req: JsonRequest, params: string[], ctx: TraceContext) => Promise<HandlerResult>) =>
    async (req: JsonRequest, params: string[]): Promise<HandlerResult> => {
      const span = deps.collector.start('orders', operation, 'server', req.trace);
      try {
        const res = await fn(req, params, contextOf(span));
        deps.collector.end(span, { status: res.status >= 500 ? 'error' : 'ok', httpStatus: res.status });
        return res;
      } catch (e) {
        deps.collector.end(span, { status: 'error', httpStatus: 500, error: e instanceof Error ? e.message : String(e) });
        throw e;
      }
    };

  const routes = [
    {
      method: 'POST', pattern: /^\/orders$/, handler: withSpan('POST /orders', async (req, _p, ctx) => {
        const customerId = customerOf(req);
        if (!customerId) return { status: 401, body: { error: 'unauthenticated' } };
        const items = parseItems(req.body);
        if (!items) return { status: 422, body: { error: 'invalid_order' } };
        const orderId = randomUUID();
        const client = await deps.pool.connect();
        try {
          await client.query('BEGIN');
          await client.query("INSERT INTO orders (id, customer_id, status) VALUES ($1, $2, 'pending')", [orderId, customerId]);
          for (const i of items) await client.query('INSERT INTO order_lines (order_id, sku, quantity) VALUES ($1, $2, $3)', [orderId, i.sku, i.quantity]);
          await client.query('COMMIT');
        } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
        for (const i of items) {
          const r = await variant.reserveLine(deps, inventoryUrl, ctx, { orderId, sku: i.sku, quantity: i.quantity });
          if (!r.ok) {
            await deps.pool.query("UPDATE orders SET status = 'failed' WHERE id = $1", [orderId]);
            return { status: 502, body: { error: 'inventory_unavailable', orderId } };
          }
        }
        await deps.pool.query("UPDATE orders SET status = 'reserved' WHERE id = $1", [orderId]);
        await deps.pool.query("INSERT INTO order_events (order_id, type, traceparent) VALUES ($1, 'order.placed', $2)", [orderId, formatTraceparent(ctx)]);
        return { status: 201, body: { orderId, customerId, status: 'reserved', items } };
      }),
    },
    {
      method: 'GET', pattern: /^\/orders\/([0-9a-f-]{36})$/, handler: withSpan('GET /orders/{id}', async (req, [id]) => {
        const customerId = customerOf(req);
        const order = await deps.pool.query<{ customer_id: string; status: string }>('SELECT customer_id, status FROM orders WHERE id = $1', [id]);
        const row = order.rows[0];
        if (!row || row.customer_id !== customerId) return { status: 404, body: { error: 'not_found' } };
        const lines = await deps.pool.query<{ sku: string; quantity: number }>('SELECT sku, quantity FROM order_lines WHERE order_id = $1 ORDER BY sku', [id]);
        return { status: 200, body: { orderId: id, customerId: row.customer_id, status: row.status, items: lines.rows } };
      }),
    },
  ];
  const cancel = variant.cancelOrder;
  if (cancel) {
    routes.push(
      { method: 'POST', pattern: /^\/orders\/([0-9a-f-]{36})\/cancel$/, handler: withSpan('POST /orders/{id}/cancel', (req, [id], ctx) => cancel(deps, inventoryUrl, ctx, id ?? '', customerOf(req))) },
      {
        method: 'GET', pattern: /^\/orders\/([0-9a-f-]{36})\/audit$/, handler: withSpan('GET /orders/{id}/audit', async (req, [id]) => {
          const owner = await deps.pool.query<{ customer_id: string }>('SELECT customer_id FROM orders WHERE id = $1', [id]);
          if (owner.rows[0]?.customer_id !== customerOf(req)) return { status: 404, body: { error: 'not_found' } };
          const rows = await deps.pool.query<{ actor: string; action: string }>('SELECT actor, action FROM order_audit WHERE order_id = $1 ORDER BY id', [id]);
          return { status: 200, body: { items: rows.rows } };
        }),
      },
    );
  }
  return serve(routes);
}
