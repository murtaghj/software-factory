import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Database, createMigratedDatabase, provisionOrganization, sessionLostSignal, type MigratedDatabase } from '../src/index.ts';

let m: MigratedDatabase;
let db: Database;
const orgId = randomUUID();
beforeAll(async () => {
  m = await createMigratedDatabase('sessionlost');
  await provisionOrganization(m.migratorUrl, { id: orgId, name: 'S' });
  db = Database.connect(m.runtimeUrl, 3);
});
afterAll(async () => { await db.close(); await m.drop(); });

describe('a session lost under a transaction', () => {
  it('raises the session-lost signal, throws the session\'s own error with what failed attached, and does not return the dead client to the pool', async () => {
    let signal: AbortSignal | undefined;
    const error = await db.withTenant({ orgId }, async (tx) => {
      signal = sessionLostSignal(tx);
      expect(signal.aborted).toBe(false);
      await db.pool.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle in transaction'");
      await new Promise((r) => setTimeout(r, 200));
      await tx.query('SELECT 1');
    }).then(() => undefined, (e: unknown) => e as { code?: string; cause?: unknown });
    expect(error).toMatchObject({ code: '57P01' }); // the server's reason, not pg's generic "not queryable"
    expect(error?.cause).toBeInstanceOf(Error); // the query that failed because of it
    expect(signal?.aborted).toBe(true);
    // The pool still works, on fresh connections, many times over (a dead client is destroyed, not reused).
    for (let i = 0; i < 6; i += 1) expect((await db.withTenant({ orgId }, (tx) => tx.query('SELECT 1 AS one'))).rows[0]).toEqual({ one: 1 });
    // A healthy transaction's signal never fires.
    let healthy: AbortSignal | undefined;
    await db.withTenant({ orgId }, (tx) => { healthy = sessionLostSignal(tx); return Promise.resolve(); });
    expect(healthy?.aborted).toBe(false);
  });
});
