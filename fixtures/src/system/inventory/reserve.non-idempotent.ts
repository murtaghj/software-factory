// Faulty release 1.1.0: a refactor dropped the idempotency-key lookup, so a retried request
// reserves stock a second time (the duplicate-reservation bug).
import type pg from 'pg';
import type { HandlerResult } from '../deps.ts';
import type { ReserveInput } from './reserve.idempotent.ts';

export async function reserve(pool: pg.Pool, input: ReserveInput): Promise<HandlerResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
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
