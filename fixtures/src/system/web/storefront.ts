// Web client (fixture storefront): the user-facing entry point. Each action starts a trace.
import { callJson } from '../http.ts';
import { contextOf, formatTraceparent, type TraceCollector } from '../tracing.ts';

export type StorefrontResult = { status: number; body: unknown; traceId: string };

export function createStorefront(ordersUrl: string, collector: TraceCollector) {
  const act = async (operation: string, method: string, path: string, customerId: string | undefined, body?: unknown): Promise<StorefrontResult> => {
    const span = collector.start('web', operation, 'client');
    span.boundary = { callee: 'orders', interfaceId: 'orders-http-v1', operation, request: body ?? null };
    try {
      const res = await callJson(`${ordersUrl}${path}`, { method, body, headers: { traceparent: formatTraceparent(contextOf(span)), ...(customerId ? { 'x-customer-id': customerId } : {}) } });
      span.boundary.responseStatus = res.status;
      span.boundary.response = res.body;
      collector.end(span, { status: res.status >= 500 ? 'error' : 'ok', httpStatus: res.status });
      return { status: res.status, body: res.body, traceId: span.traceId };
    } catch (e) {
      collector.end(span, { status: 'error', error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  };
  return {
    placeOrder: (customerId: string, items: Array<{ sku: string; quantity: number }>) => act('CreateOrderRequest', 'POST', '/orders', customerId, { items }),
    viewOrder: (customerId: string, orderId: string) => act('GetOrder', 'GET', `/orders/${orderId}`, customerId),
    cancelOrder: (customerId: string | undefined, orderId: string) => act('CancelOrder', 'POST', `/orders/${orderId}/cancel`, customerId, {}),
    viewAudit: (customerId: string, orderId: string) => act('GetOrderAudit', 'GET', `/orders/${orderId}/audit`, customerId),
  };
}

export type Storefront = ReturnType<typeof createStorefront>;
