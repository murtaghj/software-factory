// Hidden acceptance package for the order-cancellation feature (orders-2.0.0 candidates).
// Covers user, error and permission criteria. Imports nothing at runtime.
import type { Scenario, TestKit } from '../../runner/kit.ts';

export default function scenarios(t: TestKit): Scenario[] {
  const place = async (customer: string, sku: string, quantity: number): Promise<string> => {
    const r = await t.env.storefront.placeOrder(customer, [{ sku, quantity }]);
    t.expectEqual('order status code', 201, r.status);
    return (r.body as { orderId: string }).orderId;
  };
  return [
    {
      id: 'customer-cancels-own-order', title: 'Owner cancels and stock is released', criterionIds: ['CAN-USER'],
      run: async () => {
        const before = await t.stock('SKU-RED-1');
        const orderId = await place('cust-alice', 'SKU-RED-1', 2);
        const r = await t.env.storefront.cancelOrder('cust-alice', orderId);
        t.expectEqual('cancel status code', 200, r.status);
        t.expectEqual('order status', 'cancelled', ((await t.env.storefront.viewOrder('cust-alice', orderId)).body as { status: string }).status);
        t.expectEqual('stock after cancel', before, await t.stock('SKU-RED-1'));
      },
    },
    {
      id: 'repeated-cancellation-is-idempotent', title: 'A second cancel changes nothing', criterionIds: ['CAN-IDEMPOTENT', 'CAN-AUDIT'],
      run: async () => {
        const before = await t.stock('SKU-BLUE-2');
        const orderId = await place('cust-alice', 'SKU-BLUE-2', 1);
        t.expectEqual('first cancel status code', 200, (await t.env.storefront.cancelOrder('cust-alice', orderId)).status);
        t.expectEqual('second cancel status code', 200, (await t.env.storefront.cancelOrder('cust-alice', orderId)).status);
        t.expectEqual('stock after repeated cancel', before, await t.stock('SKU-BLUE-2'));
        const audit = (await t.env.storefront.viewAudit('cust-alice', orderId)).body as { items: unknown[] };
        t.expectEqual('audit entries after repeated cancel', 1, audit.items.length);
      },
    },
    {
      id: 'other-customer-cannot-cancel', title: 'A different customer is refused', criterionIds: ['CAN-PERMISSION'],
      run: async () => {
        const orderId = await place('cust-alice', 'SKU-GREEN-3', 1);
        t.expectEqual('foreign cancel status code', 403, (await t.env.storefront.cancelOrder('cust-bob', orderId)).status);
        t.expectEqual('order status after refused cancel', 'reserved', ((await t.env.storefront.viewOrder('cust-alice', orderId)).body as { status: string }).status);
      },
    },
    {
      id: 'cancel-unknown-order', title: 'Unknown order is not found', criterionIds: ['CAN-ERROR'],
      run: async () => {
        t.expectEqual('unknown order cancel status code', 404, (await t.env.storefront.cancelOrder('cust-alice', '00000000-0000-4000-8000-00000000dead')).status);
      },
    },
    {
      id: 'audit-history-queryable', title: 'Audit records who cancelled', criterionIds: ['CAN-AUDIT'],
      run: async () => {
        const orderId = await place('cust-bob', 'SKU-RED-1', 1);
        await t.env.storefront.cancelOrder('cust-bob', orderId);
        const audit = (await t.env.storefront.viewAudit('cust-bob', orderId)).body as { items?: Array<{ actor: string; action: string }> };
        t.expectEqual('audit history', [{ actor: 'cust-bob', action: 'cancelled' }], audit.items);
      },
    },
  ];
}
