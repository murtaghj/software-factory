// Event worker (fixture): consumes order.placed events from the outbox table and records a
// fulfillment request, continuing the trace carried on the event.
import type { ServiceDeps } from '../deps.ts';
import { parseTraceparent } from '../tracing.ts';

export type EventWorker = { drain: () => Promise<number> };

export function createEventWorker(deps: ServiceDeps): EventWorker {
  return {
    drain: async () => {
      let processed = 0;
      for (;;) {
        const client = await deps.pool.connect();
        try {
          await client.query('BEGIN');
          const next = await client.query<{ id: number; order_id: string; traceparent: string }>(
            'SELECT id, order_id, traceparent FROM order_events WHERE processed_at IS NULL ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED');
          const event = next.rows[0];
          if (!event) { await client.query('COMMIT'); return processed; }
          const span = deps.collector.start('event-worker', 'consume order.placed', 'consumer', parseTraceparent(event.traceparent));
          await client.query('INSERT INTO fulfillment_requests (order_id, event_id) VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING', [event.order_id, event.id]);
          await client.query('UPDATE order_events SET processed_at = now() WHERE id = $1', [event.id]);
          await client.query('COMMIT');
          deps.collector.end(span);
          processed += 1;
        } catch (e) {
          await client.query('ROLLBACK');
          throw e;
        } finally {
          client.release();
        }
      }
    },
  };
}
