// Cancellation feature, faulty candidate: only the happy path. Any caller may cancel any order,
// and a repeated cancellation releases inventory again and writes a second audit entry.
import { callJson } from '../http.ts';
import { contextOf, formatTraceparent, type TraceContext } from '../tracing.ts';
import type { HandlerResult, ServiceDeps } from '../deps.ts';

export async function cancelOrder(deps: ServiceDeps, inventoryUrl: string, parent: TraceContext, orderId: string, customerId: string | undefined): Promise<HandlerResult> {
  const order = await deps.pool.query<{ customer_id: string }>('SELECT customer_id FROM orders WHERE id = $1', [orderId]);
  if (!order.rows[0]) return { status: 404, body: { error: 'not_found' } };
  const span = deps.collector.start('orders', 'POST inventory /reservations/release', 'client', parent);
  span.boundary = { callee: 'inventory', interfaceId: 'inventory-http-v1', operation: 'ReleaseRequest', request: { orderId } };
  const res = await callJson(`${inventoryUrl}/reservations/release`, { method: 'POST', body: { orderId }, headers: { traceparent: formatTraceparent(contextOf(span)) } });
  span.boundary.responseStatus = res.status;
  deps.collector.end(span, { status: res.status >= 500 ? 'error' : 'ok', httpStatus: res.status });
  await deps.pool.query("UPDATE orders SET status = 'cancelled' WHERE id = $1", [orderId]);
  await deps.pool.query("INSERT INTO order_audit (order_id, actor, action) VALUES ($1, $2, 'cancelled')", [orderId, customerId ?? 'unknown']);
  return { status: 200, body: { orderId, status: 'cancelled' } };
}
