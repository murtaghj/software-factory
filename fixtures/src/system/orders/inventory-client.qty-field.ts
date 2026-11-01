// Faulty release 3.0.0: an orders refactor renamed the field to `qty`, so the request no longer
// satisfies inventory-http-v1 (missing `quantity`, unknown `qty`). Inventory then fails with 500.
import { makeInventoryClient, type ReserveLine } from './inventory-client.ts';

export const reserveLine = makeInventoryClient((line: ReserveLine) => ({
  orderId: line.orderId, sku: line.sku, qty: line.quantity, idempotencyKey: `${line.orderId}:${line.sku}`,
}));
