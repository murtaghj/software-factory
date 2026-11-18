// Runtime database access. Every tenant transaction sets factory.org_id (and the authenticated
// principal) with SET LOCAL semantics so forced RLS scopes all reads and writes (chapter 02,
// "Authenticated transactions set factory.org_id and factory.principal_id"). Without a tenant,
// RLS-protected tables read empty and reject writes.
import pg from 'pg';

export type TenantContext = { orgId: string; principalId?: string };
export type Tx = pg.PoolClient;

const sessions = new WeakMap<object, AbortSignal>();
// Fires when the transaction's database session is lost (killed, reset, connection ended). Locks held
// by that session are gone from then on, so anything that relied on them must stop.
export function sessionLostSignal(tx: Tx): AbortSignal {
  return sessions.get(tx) ?? new AbortController().signal;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class Database {
  readonly pool: pg.Pool;
  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  static connect(url: string, max = 10): Database {
    const pool = new pg.Pool({ connectionString: url, max });
    pool.on('error', () => undefined);
    return new Database(pool);
  }

  async withTenant<T>(ctx: TenantContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
    if (!UUID.test(ctx.orgId)) throw new Error('tenant context requires an organization UUID');
    if (ctx.principalId !== undefined && !UUID.test(ctx.principalId)) throw new Error('principal must be a UUID');
    return this.transaction(async (tx) => {
      await tx.query("SELECT set_config('factory.org_id', $1, true), set_config('factory.principal_id', $2, true)", [ctx.orgId, ctx.principalId ?? '']);
      return fn(tx);
    });
  }

  // Only for the intentionally unscoped lookups (organization id/status) and the migration schema.
  async withoutTenant<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.transaction(fn);
  }

  private async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    // A session killed under us (pg_terminate_backend, a restart, a reset) emits 'error' on the
    // checked-out client; without a listener that is an uncaught exception. The first such error is
    // kept: it, not pg's generic "not queryable", is what the caller sees (57P01, ECONNRESET, ...),
    // and the session-lost signal fires so work that depends on the session's locks can stop.
    const lost = new AbortController();
    let lostError: Error | undefined;
    const onLost = (err?: Error): void => { lostError ??= err ?? new Error('database session ended'); lost.abort(lostError); };
    client.on('error', onLost);
    sessions.set(client, lost.signal);
    let releaseWith: Error | undefined;
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK').catch((re: unknown) => { releaseWith = re instanceof Error ? re : new Error(String(re)); });
      if (lostError) {
        // Surface the session's own error, with what failed because of it attached as its cause.
        if (e !== lostError && lostError.cause === undefined) lostError.cause = e;
        throw lostError;
      }
      throw e;
    } finally {
      client.removeListener('error', onLost);
      sessions.delete(client);
      // A client that errored is destroyed (release with an error), not returned to the pool.
      client.release(releaseWith ?? lostError);
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

// Organization provisioning belongs to migration/admin credentials (chapter 02); runtime cannot insert.
export async function provisionOrganization(migratorUrl: string, org: { id: string; name: string; status?: string }): Promise<void> {
  const client = new pg.Client({ connectionString: migratorUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE factory_migrator');
    await client.query('INSERT INTO factory.organization (id, name, status) VALUES ($1, $2, $3)', [org.id, org.name, org.status ?? 'active']);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await client.end();
  }
}
