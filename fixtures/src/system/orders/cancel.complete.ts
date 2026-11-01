// Cancellation feature, complete implementation (release 2.0.0): only the owning customer may
// cancel; repeated cancellation is idempotent; every effective cancellation is audited.
import { callJson } from '../http.ts';
import { contextOf, formatTraceparent, type TraceContext } from '../tracing.ts';
import type { HandlerResult, ServiceDeps } from '../deps.ts';

export async function cancelOrder(deps: ServiceDeps, inventoryUrl: string, parent: TraceContext, orderId: string, customerId: string | undefined): Promise<HandlerResult> {
  if (!customerId) return { status: 401, body: { error: 'unauthenticated' } };
  const order = await deps.pool.query<{ customer_id: string; status: string }>('SELECT customer_id, status FROM orders WHERE id = $1', [orderId]);
  const row = order.rows[0];
  if (!row) return { status: 404, body: { error: 'not_found' } };
  if (row.customer_id !== customerId) return { status: 403, body: { error: 'forbidden' } };
  if (row.status === 'cancelled') return { status: 200, body: { orderId, status: 'cancelled' } };
  const span = deps.collector.start('orders', 'POST inventory /reservations/release', 'client', parent);
  span.boundary = { callee: 'inventory', interfaceId: 'inventory-http-v1', operation: 'ReleaseRequest', request: { orderId } };
  const res = await callJson(`${inventoryUrl}/reservations/release`, { method: 'POST', body: { orderId }, headers: { traceparent: formatTraceparent(contextOf(span)) } });
  span.boundary.responseStatus = res.status;
  deps.collector.end(span, { status: res.status >= 500 ? 'error' : 'ok', httpStatus: res.status });
  if (res.status !== 200) return { status: 502, body: { error: 'inventory_unavailable' } };
  const client = await deps.pool.connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query("UPDATE orders SET status = 'cancelled' WHERE id = $1 AND status <> 'cancelled'", [orderId]);
    if (updated.rowCount === 1) await client.query("INSERT INTO order_audit (order_id, actor, action) VALUES ($1, $2, 'cancelled')", [orderId, customerId]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  return { status: 200, body: { orderId, status: 'cancelled' } };
}
