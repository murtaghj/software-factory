// Inventory API (fixture). Implements contracts/inventory-http-v1. It does not validate input
// itself, so a contract-violating request surfaces as a downstream 500.
import { serve, type RunningServer } from '../http.ts';
import type { TraceContext } from '../tracing.ts';
import type { HandlerResult, ServiceDeps } from '../deps.ts';
import type { ReserveInput } from './reserve.idempotent.ts';

export type InventoryVariant = { reserve: (pool: ServiceDeps['pool'], input: ReserveInput) => Promise<HandlerResult> };

export async function startInventory(deps: ServiceDeps, variant: InventoryVariant): Promise<RunningServer> {
  const dropped = new Set<string>();
  const traced = (operation: string, fn: (body: Record<string, unknown>) => Promise<HandlerResult>) =>
    async (req: { body: unknown; trace: TraceContext | undefined }): Promise<HandlerResult> => {
      const span = deps.collector.start('inventory', operation, 'server', req.trace);
      try {
        const res = await fn((req.body ?? {}) as Record<string, unknown>);
        deps.collector.end(span, { status: res.status >= 500 ? 'error' : 'ok', httpStatus: res.status });
        return res;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        deps.collector.end(span, { status: 'error', httpStatus: 500, error: message });
        return { status: 500, body: { error: 'internal_error', detail: message } };
      }
    };
  return serve([
    {
      method: 'POST', pattern: /^\/reservations$/, handler: traced('POST /reservations', async (body) => {
        if (deps.faults.inventoryFailOnValidInput === true) throw new Error('inventory storage unavailable');
        return variant.reserve(deps.pool, { orderId: body.orderId, sku: body.sku, quantity: body.quantity, idempotencyKey: body.idempotencyKey });
      }),
    },
    {
      method: 'POST', pattern: /^\/reservations\/release$/, handler: traced('POST /reservations/release', async (body) => {
        const client = await deps.pool.connect();
        try {
          await client.query('BEGIN');
          const rows = await client.query<{ sku: string; quantity: number }>('UPDATE reservations SET released = true WHERE order_id = $1 AND released = false RETURNING sku, quantity', [body.orderId]);
          for (const r of rows.rows) await client.query('UPDATE stock SET available = available + $2 WHERE sku = $1', [r.sku, r.quantity]);
          await client.query('COMMIT');
          return { status: 200, body: { released: rows.rowCount ?? 0 } };
        } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
      }),
    },
    {
      method: 'GET', pattern: /^\/reservations$/, handler: async (req) => {
        const orderId = new URL(req.path, 'http://x').searchParams.get('orderId');
        const rows = await deps.pool.query<{ id: number; order_id: string; sku: string; quantity: number; released: boolean }>(
          'SELECT id, order_id, sku, quantity, released FROM reservations WHERE order_id = $1 ORDER BY id', [orderId]);
        return { status: 200, body: { items: rows.rows.map((r) => ({ reservationId: r.id, orderId: r.order_id, sku: r.sku, quantity: r.quantity, released: r.released })) } };
      },
    },
  ], {
    onResponse: (req, _res, raw) => {
      if (deps.faults.inventoryDropFirstReserveResponse !== true || req.method !== 'POST' || req.path !== '/reservations') return false;
      const key = String((req.body as Record<string, unknown> | undefined)?.idempotencyKey);
      if (dropped.has(key)) return false;
      dropped.add(key);
      raw.destroy(); // the reservation committed, but the caller never sees the response
      return true;
    },
  });
}
