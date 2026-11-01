// Known-good reservation: deduplicates on idempotency key, so a retried request returns the
// original reservation instead of reserving stock twice.
import type pg from 'pg';
import type { HandlerResult } from '../deps.ts';

export type ReserveInput = { orderId: unknown; sku: unknown; quantity: unknown; idempotencyKey: unknown };

export async function reserve(pool: pg.Pool, input: ReserveInput): Promise<HandlerResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query<{ id: number; order_id: string; sku: string; quantity: number; released: boolean }>(
      'SELECT id, order_id, sku, quantity, released FROM reservations WHERE idempotency_key = $1 FOR UPDATE', [input.idempotencyKey]);
    const prior = existing.rows[0];
    if (prior) {
      await client.query('COMMIT');
      return { status: 200, body: { reservationId: prior.id, orderId: prior.order_id, sku: prior.sku, quantity: prior.quantity, released: prior.released } };
    }
    const row = await client.query<{ id: number }>('INSERT INTO reservations (order_id, sku, quantity, idempotency_key) VALUES ($1, $2, $3, $4) RETURNING id',
      [input.orderId, input.sku, input.quantity, input.idempotencyKey]);
    const stock = await client.query('UPDATE stock SET available = available - $2 WHERE sku = $1 AND available >= $2 RETURNING available', [input.sku, input.quantity]);
    if (stock.rowCount !== 1) { await client.query('ROLLBACK'); return { status: 409, body: { error: 'insufficient_stock' } }; }
    await client.query('COMMIT');
    return { status: 201, body: { reservationId: row.rows[0]?.id, orderId: input.orderId, sku: input.sku, quantity: input.quantity, released: false } };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
