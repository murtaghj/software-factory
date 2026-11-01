// Canonical regression package for the duplicate-reservation bug (orders-1.1.0).
// Injected kit only: this file imports nothing at runtime, so its digest is its whole behaviour.
import type { Scenario, TestKit } from '../../runner/kit.ts';

export default function scenarios(t: TestKit): Scenario[] {
  const place = async (sku: string, quantity: number): Promise<string> => {
    const r = await t.env.storefront.placeOrder('cust-alice', [{ sku, quantity }]);
    t.expectEqual('order status code', 201, r.status);
    return (r.body as { orderId: string }).orderId;
  };
  return [
    {
      id: 'duplicate-reservation',
      title: 'A retried reservation after a lost response is applied once',
      criterionIds: ['BUG-1'],
      run: async () => {
        const orderId = await place('SKU-RED-1', 2);
        const rows = await t.reservations(orderId);
        if (rows.length !== 1) t.fail(`expected reservation count 1; observed ${String(rows.length)}`);
      },
    },
    {
      id: 'stock-decrement',
      title: 'Stock decreases by exactly the ordered quantity',
      criterionIds: ['REG-1'],
      run: async () => {
        const before = await t.stock('SKU-BLUE-2');
        await place('SKU-BLUE-2', 3);
        t.expectEqual('stock decrement', 3, before - (await t.stock('SKU-BLUE-2')));
      },
    },
    {
      id: 'fulfillment-on-trace',
      title: 'The event worker records one fulfillment request on the order trace',
      criterionIds: ['REG-2'],
      run: async () => {
        const r = await t.env.storefront.placeOrder('cust-bob', [{ sku: 'SKU-GREEN-3', quantity: 1 }]);
        t.expectEqual('order status code', 201, r.status);
        const orderId = (r.body as { orderId: string }).orderId;
        await t.env.worker.drain();
        t.expectEqual('fulfillment requests', 1, await t.fulfillments(orderId));
        const services = new Set(t.env.collector.trace(r.traceId).map((s) => s.service));
        t.expectEqual('services on the trace', ['event-worker', 'inventory', 'orders', 'web'], [...services].sort());
      },
    },
  ];
}
