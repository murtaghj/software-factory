import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { type Tx, Database, MIGRATIONS_DIR, createMigratedDatabase, heartbeatSchemaReader, migrate, provisionOrganization, retireSchemaReader, type MigratedDatabase } from '../src/index.ts';

const forward = join(import.meta.dirname, 'forward-migrations');
const dirs = [MIGRATIONS_DIR, forward];

// Two worker builds coexisting during the rollout.
const oldWriter = (tx: Tx, orgId: string, key: string) =>
  tx.query("INSERT INTO factory.application (org_id, id, app_key, name, owner_ids, lifecycle) VALUES ($1, $2, $3, $4, '[]', 'production')", [orgId, randomUUID(), key, `Name ${key}`]);
const newWriter = (tx: Tx, orgId: string, key: string) =>
  tx.query("INSERT INTO factory.application (org_id, id, app_key, display_name, owner_ids, lifecycle) VALUES ($1, $2, $3, $4, '[]', 'production')", [orgId, randomUUID(), key, `Name ${key}`]);
const oldReader = async (tx: Tx) => (await tx.query<{ app_key: string; name: string }>('SELECT app_key, name FROM factory.application ORDER BY app_key')).rows.map((r) => `${r.app_key}=${r.name}`);
const newReader = async (tx: Tx) => (await tx.query<{ app_key: string; display_name: string }>('SELECT app_key, display_name FROM factory.application ORDER BY app_key')).rows.map((r) => `${r.app_key}=${r.display_name}`);

describe('AC-58 migrations across worker versions', () => {
  let m: MigratedDatabase;
  let db: Database;
  const orgs = [randomUUID(), randomUUID()];
  beforeAll(async () => {
    m = await createMigratedDatabase('ac58');
    for (const [i, id] of orgs.entries()) await provisionOrganization(m.migratorUrl, { id, name: `Org ${String(i)}` });
    db = Database.connect(m.runtimeUrl);
  });
  afterAll(async () => { await db.close(); await m.drop(); });

  const each = async <T>(fn: (tx: Tx, orgId: string) => Promise<T>): Promise<T[]> => Promise.all(orgs.map((orgId) => db.withTenant({ orgId }, (tx) => fn(tx, orgId))));

  it('expand → backfill → contract keeps old and new readers working until the old reader is retired', async () => {
    // Before the rollout: an old worker build writes and reads the legacy column.
    await each(async (tx, orgId) => { for (const k of ['a1', 'a2', 'a3']) await oldWriter(tx, orgId, `${orgId.slice(0, 4)}-${k}`); });
    await db.withoutTenant((tx) => heartbeatSchemaReader(tx, 'worker-build-1', ['application.name']));

    // Expand: old readers and writers are unaffected; new writers can write the new column.
    expect((await migrate(m.migratorUrl, { dirs, upTo: 9001 })).applied.map((a) => a.version)).toEqual([9001]);
    await each(async (tx, orgId) => { await oldWriter(tx, orgId, `${orgId.slice(0, 4)}-b1`); await newWriter(tx, orgId, `${orgId.slice(0, 4)}-b2`); });
    for (const rows of await each((tx) => oldReader(tx))) expect(rows).toHaveLength(5);

    // Backfill: bounded batches per tenant, restartable after an interruption.
    await expect(migrate(m.migratorUrl, { dirs, upTo: 9002, backfillBatchLimit: 1 })).rejects.toMatchObject({ code: 'invalid_migration' });
    const partial = await each(async (tx) => (await tx.query<{ n: string }>('SELECT count(*) AS n FROM factory.application WHERE display_name IS NULL')).rows[0]?.n);
    expect(partial.map(Number).reduce((x, y) => x + y)).toBe(4); // one batch of 2 committed before the interruption
    const backfill = await migrate(m.migratorUrl, { dirs, upTo: 9002 });
    expect(backfill.applied).toEqual([{ version: 9002, name: 'backfill_application_display_name', phase: 'backfill', backfilledRows: 4 }]);
    const oldView = await each((tx) => oldReader(tx));
    const newView = await each((tx) => newReader(tx));
    expect(newView).toEqual(oldView); // both builds read the same data

    // Contract is refused while the old build still reads the legacy column.
    await expect(migrate(m.migratorUrl, { dirs })).rejects.toMatchObject({ code: 'retirement_blocked' });
    for (const rows of await each((tx) => oldReader(tx))) expect(rows).toHaveLength(5);

    // After the old build retires, contract proceeds and only the new reader remains valid.
    await db.withoutTenant((tx) => retireSchemaReader(tx, 'worker-build-1'));
    expect((await migrate(m.migratorUrl, { dirs })).applied.map((a) => a.version)).toEqual([9003]);
    expect(await each((tx) => newReader(tx))).toEqual(newView);
    await expect(db.withTenant({ orgId: orgs[0] ?? '' }, (tx) => oldReader(tx))).rejects.toMatchObject({ code: '42703' });
  });

  it('a fresh reader heartbeat blocks contraction; a reader silent past the window does not', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'contract-'));
    try {
      writeFileSync(join(tmp, '9101_contract_capability_x.sql'), '-- phase: contract\n-- retires: capability.x\nSET LOCAL search_path = factory, public;\nCOMMENT ON TABLE application IS NULL;\n');
      await db.withoutTenant((tx) => heartbeatSchemaReader(tx, 'worker-build-2', ['capability.x']));
      await expect(migrate(m.migratorUrl, { dirs: [...dirs, tmp] })).rejects.toMatchObject({ code: 'retirement_blocked' });
      await db.withoutTenant((tx) => tx.query("UPDATE factory_migration.schema_reader SET last_seen_at = now() - interval '1 hour' WHERE reader_id = 'worker-build-2'"));
      expect((await migrate(m.migratorUrl, { dirs: [...dirs, tmp] })).applied.map((a) => a.version)).toEqual([9101]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
