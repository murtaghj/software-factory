// Shared runtime dependencies and controllable failure injection for the fixture services.
import type pg from 'pg';
import type { TraceCollector } from './tracing.ts';

export type FaultConfig = {
  // Inventory commits a reservation and then drops the HTTP response for the first request with a
  // given idempotency key (timeout after side effect). Orders retries with the same key.
  inventoryDropFirstReserveResponse?: boolean;
  // Inventory fails with 500 on a valid request (control case: the downstream really is at fault).
  inventoryFailOnValidInput?: boolean;
};

export type ServiceDeps = { pool: pg.Pool; collector: TraceCollector; faults: FaultConfig };

export type HandlerResult = { status: number; body?: unknown };
