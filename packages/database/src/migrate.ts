// Ordered SQL migrations with expand/backfill/contract phases (chapter 02 "Use expand/backfill/
// contract migrations"; AC-58).
//
// - Every migration runs as factory_migrator (SET LOCAL ROLE), in its own transaction, recorded
//   with its SHA-256. A changed already-applied file stops the run (migrations are immutable).
// - phase: backfill files hold one statement that processes a bounded batch; it is re-run in
//   separate transactions until it touches no rows, so it is restartable and measured.
// - phase: contract files declare `-- retires: <capability>`. They are refused while any worker
//   that still reads that capability has heartbeated within the reader window: old readers keep
//   working until safe retirement.
import pg from 'pg';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations');
export type Phase = 'expand' | 'backfill' | 'contract';
export type Migration = { version: number; name: string; sql: string; checksum: string; phase: Phase; retires: string[] };

export class MigrationError extends Error {
  readonly code: 'checksum_mismatch' | 'retirement_blocked' | 'invalid_migration' | 'out_of_order';
  constructor(code: MigrationError['code'], message: string) {
    super(message);
    this.name = 'MigrationError';
    this.code = code;
  }
}

export function loadMigrations(dirs: string[] = [MIGRATIONS_DIR]): Migration[] {
  const all: Migration[] = [];
  for (const dir of dirs) {
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      const m = /^(\d{4})_([a-z0-9_]+)\.sql$/.exec(file);
      if (!m?.[1] || !m[2]) throw new MigrationError('invalid_migration', `bad migration file name ${file}`);
      const sql = readFileSync(join(dir, file), 'utf8');
      const phase = /^-- phase: (expand|backfill|contract)$/m.exec(sql)?.[1] as Phase | undefined;
      if (!phase) throw new MigrationError('invalid_migration', `${file} declares no phase`);
      const retires = [...sql.matchAll(/^-- retires: ([A-Za-z0-9_.:-]+)$/gm)].map((r) => r[1] ?? '');
      if (phase === 'contract' && retires.length === 0) throw new MigrationError('invalid_migration', `${file} is a contract migration without a retired capability`);
      all.push({ version: Number(m[1]), name: m[2], sql, checksum: createHash('sha256').update(sql).digest('hex'), phase, retires });
    }
  }
  all.sort((a, b) => a.version - b.version);
  for (let i = 1; i < all.length; i += 1) if (all[i]?.version === all[i - 1]?.version) throw new MigrationError('invalid_migration', `duplicate migration version ${String(all[i]?.version)}`);
  return all;
}

const TRACKING = `
CREATE SCHEMA IF NOT EXISTS factory_migration;
CREATE TABLE IF NOT EXISTS factory_migration.applied (
  version integer PRIMARY KEY, name text NOT NULL, checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  phase text NOT NULL CHECK (phase IN ('expand','backfill','contract')), backfilled_rows bigint NOT NULL DEFAULT 0,
  applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS factory_migration.schema_reader (
  reader_id text NOT NULL, capability text NOT NULL, last_seen_at timestamptz NOT NULL, retired_at timestamptz,
  PRIMARY KEY (reader_id, capability));
GRANT USAGE ON SCHEMA factory_migration TO factory_runtime;
GRANT SELECT ON factory_migration.applied TO factory_runtime;
GRANT SELECT, INSERT ON factory_migration.schema_reader TO factory_runtime;
GRANT UPDATE (last_seen_at, retired_at) ON factory_migration.schema_reader TO factory_runtime;`;

export type MigrateOptions = { dirs?: string[]; upTo?: number; readerWindowSeconds?: number; backfillBatchLimit?: number };
export type MigrateResult = { applied: Array<{ version: number; name: string; phase: Phase; backfilledRows: number }> };

export async function migrate(migratorUrl: string, options: MigrateOptions = {}): Promise<MigrateResult> {
  const migrations = loadMigrations(options.dirs);
  const client = new pg.Client({ connectionString: migratorUrl });
  await client.connect();
  const result: MigrateResult = { applied: [] };
  try {
    await client.query('SET ROLE factory_migrator'); // the whole session acts as the owning role
    await client.query("SELECT pg_advisory_lock(hashtext('factory_migration'))");
    await client.query('BEGIN');
    await client.query(TRACKING);
    await client.query('COMMIT');
    const applied = new Map((await client.query<{ version: number; checksum: string }>('SELECT version, checksum FROM factory_migration.applied')).rows.map((r) => [r.version, r.checksum]));
    const highest = Math.max(0, ...applied.keys());
    for (const m of migrations) {
      const prior = applied.get(m.version);
      if (prior !== undefined) {
        if (prior !== m.checksum) throw new MigrationError('checksum_mismatch', `migration ${String(m.version)}_${m.name} changed after it was applied`);
        continue;
      }
      if (options.upTo !== undefined && m.version > options.upTo) break;
      if (m.version < highest) throw new MigrationError('out_of_order', `migration ${String(m.version)} is older than applied ${String(highest)}`);
      if (m.phase === 'contract') await assertRetired(client, m, options.readerWindowSeconds ?? 300);
      const rows = m.phase === 'backfill' ? await runBackfill(client, m, options.backfillBatchLimit ?? 10_000) : await runOnce(client, m);
      await client.query('INSERT INTO factory_migration.applied (version, name, checksum, phase, backfilled_rows) VALUES ($1, $2, $3, $4, $5)', [m.version, m.name, m.checksum, m.phase, rows]);
      result.applied.push({ version: m.version, name: m.name, phase: m.phase, backfilledRows: rows });
    }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('factory_migration'))").catch(() => undefined);
    await client.end();
  }
  return result;
}

async function runOnce(client: pg.Client, m: Migration): Promise<number> {
  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL ROLE factory_migrator');
    await client.query(m.sql);
    await client.query('COMMIT');
    return 0;
  } catch (e) {
    await client.query('ROLLBACK');
    throw new MigrationError('invalid_migration', `${String(m.version)}_${m.name} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// Backfills run per organization: forced RLS applies to the owning role too, so each batch opens a
// transaction scoped to one tenant (as the dispatcher does). A batch statement must touch a bounded
// set of not-yet-backfilled rows; it is repeated until it touches none for every tenant.
async function runBackfill(client: pg.Client, m: Migration, maxBatches: number): Promise<number> {
  const statement = m.sql.replace(/^SET LOCAL search_path.*$/m, '');
  const orgs = (await client.query<{ id: string }>('SELECT id FROM factory.organization ORDER BY id')).rows.map((r) => r.id);
  let total = 0;
  let batches = 0;
  for (const orgId of orgs) {
    for (;;) {
      if (batches >= maxBatches) throw new MigrationError('invalid_migration', `${String(m.version)}_${m.name} did not converge within ${String(maxBatches)} batches`);
      batches += 1;
      await client.query('BEGIN');
      let affected: number;
      try {
        await client.query('SET LOCAL search_path = factory, public');
        await client.query("SELECT set_config('factory.org_id', $1, true)", [orgId]);
        affected = (await client.query(statement)).rowCount ?? 0;
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw new MigrationError('invalid_migration', `${String(m.version)}_${m.name} backfill failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      total += affected;
      if (affected === 0) break;
    }
  }
  return total;
}

async function assertRetired(client: pg.Client, m: Migration, windowSeconds: number): Promise<void> {
  const active = await client.query<{ reader_id: string; capability: string }>(
    `SELECT reader_id, capability FROM factory_migration.schema_reader
     WHERE capability = ANY($1) AND retired_at IS NULL AND last_seen_at > now() - make_interval(secs => $2)`, [m.retires, windowSeconds]);
  if (active.rows.length > 0) {
    throw new MigrationError('retirement_blocked', `${String(m.version)}_${m.name} retires ${m.retires.join(', ')} still read by ${active.rows.map((r) => r.reader_id).join(', ')}`);
  }
}

// Workers declare the schema capabilities they read; contract migrations wait for their retirement.
export async function heartbeatSchemaReader(client: pg.ClientBase, readerId: string, capabilities: string[]): Promise<void> {
  for (const capability of capabilities) {
    await client.query(`INSERT INTO factory_migration.schema_reader (reader_id, capability, last_seen_at) VALUES ($1, $2, now())
      ON CONFLICT (reader_id, capability) DO UPDATE SET last_seen_at = now(), retired_at = NULL`, [readerId, capability]);
  }
}

export async function retireSchemaReader(client: pg.ClientBase, readerId: string): Promise<void> {
  await client.query('UPDATE factory_migration.schema_reader SET retired_at = now() WHERE reader_id = $1 AND retired_at IS NULL', [readerId]);
}
