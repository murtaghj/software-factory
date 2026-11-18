import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { readFileSync, readdirSync, mkdtempSync, cpSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBootstrappedDatabase, createMigratedDatabase, migrate, loadMigrations, MIGRATIONS_DIR, MigrationError, type MigratedDatabase } from '../src/index.ts';
import { importReferenceSchema } from '../scripts/import-reference-schema.ts';
import { catalogSnapshot, diffCatalog } from './catalog.ts';

const reference = readFileSync(join(import.meta.dirname, '..', '..', '..', 'docs', 'spec', 'contracts', 'schema.sql'), 'utf8');

async function exec(url: string, sql: string): Promise<void> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try { await c.query(sql); } finally { await c.end(); }
}

describe('W-006 migrations reproduce the reference DDL', () => {
  let ref: MigratedDatabase;
  let mig: MigratedDatabase;
  beforeAll(async () => {
    ref = await createBootstrappedDatabase('ref_schema');
    await exec(ref.adminUrl, reference); // the reference script as an administrator would run it
    mig = await createBootstrappedDatabase('mig_schema');
    await migrate(mig.migratorUrl, { upTo: 10 });
  });
  afterAll(async () => { await ref.drop(); await mig.drop(); });

  it('the committed migrations 0001–0010 are exactly the verbatim import of schema.sql', () => {
    const imported = importReferenceSchema();
    const committed = readdirSync(MIGRATIONS_DIR).filter((f) => f <= '0010_z');
    expect(committed).toEqual([...imported.keys()].sort());
    for (const [file, body] of imported) expect(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'), file).toBe(body);
  });

  it('applying 0001–0010 as factory_migrator yields the same catalog as the reference script, except the documented owner fix', async () => {
    const diff = diffCatalog(await catalogSnapshot(ref.adminUrl), await catalogSnapshot(mig.adminUrl));
    // SI-05: the reference never reassigns guard_environment_generation() to factory_migrator.
    expect(diff.length).toBe(2);
    expect(diff.every((d) => d.startsWith('functions:') && d.includes('"name":"guard_environment_generation"'))).toBe(true);
    expect(diff.some((d) => d.includes('only in first') && d.includes('"owner":"factory_admin"'))).toBe(true);
    expect(diff.some((d) => d.includes('only in second') && d.includes('"owner":"factory_migrator"'))).toBe(true);
  });

  it('0011 changes only the factory_tool_call request_hash check (SI-04)', async () => {
    const before = await catalogSnapshot(mig.adminUrl);
    await migrate(mig.migratorUrl, { upTo: 11 });
    const diff = diffCatalog(before, await catalogSnapshot(mig.adminUrl));
    expect(diff).toEqual([
      'constraints: only in first: {"table":"factory.factory_tool_call","name":"factory_tool_call_request_hash_check","def":"CHECK ((request_hash ~ \'^[0-9a-f]64$\'::text))"}',
      'constraints: only in second: {"table":"factory.factory_tool_call","name":"factory_tool_call_request_hash_check","def":"CHECK ((request_hash ~ \'^[0-9a-f]{64}$\'::text))"}',
    ]);
  });
});

describe('W-006 forward fix 0012 pins function search_path (SI-06)', () => {
  it('every factory function is pinned to the factory schema after 0012', async () => {
    const db = await createMigratedDatabase('pinned');
    try {
      const c = new pg.Client({ connectionString: db.adminUrl });
      await c.connect();
      try {
        const r = await c.query<{ proname: string; proconfig: string[] | null }>("SELECT proname, proconfig FROM pg_proc WHERE pronamespace = 'factory'::regnamespace ORDER BY proname");
        expect(r.rows.length).toBe(9);
        for (const f of r.rows) expect(f.proconfig, f.proname).toEqual(['search_path=factory, pg_catalog']);
      } finally { await c.end(); }
    } finally { await db.drop(); }
  });
});

describe('W-006 role split and migration integrity', () => {
  let db: MigratedDatabase;
  beforeAll(async () => { db = await createMigratedDatabase('roles'); });
  afterAll(async () => { await db.drop(); });

  it('runtime and migrator logins are non-superuser, cannot bypass RLS, and runtime owns nothing', async () => {
    const c = new pg.Client({ connectionString: db.adminUrl });
    await c.connect();
    try {
      const roles = await c.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean }>(
        "SELECT rolname, rolsuper, rolbypassrls, rolcreaterole FROM pg_roles WHERE rolname IN ('factory_runtime','factory_migrator','factory_app_login','factory_migrate_login','factory_retention_login') ORDER BY rolname");
      expect(roles.rows).toHaveLength(5);
      // Only the dedicated retention job role may bypass RLS, and it can read just the sweep columns.
      const retention = await c.query<{ rolbypassrls: boolean; rolcanlogin: boolean }>("SELECT rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = 'factory_retention'");
      expect(retention.rows[0]).toEqual({ rolbypassrls: true, rolcanlogin: false });
      const retentionGrants = await c.query<{ table_name: string; column_name: string; privilege_type: string }>("SELECT table_name, column_name, privilege_type FROM information_schema.column_privileges WHERE grantee = 'factory_retention' AND table_schema = 'factory' ORDER BY 1, 2, 3");
      expect(retentionGrants.rows.map((g) => `${g.privilege_type} ${g.table_name}.${g.column_name}`).sort()).toEqual([
        'SELECT artifact.id', 'SELECT artifact.org_id', 'SELECT artifact.storage_key',
        'INSERT audit_event.actor_id', 'INSERT audit_event.action', 'INSERT audit_event.correlation_id', 'INSERT audit_event.created_at', 'INSERT audit_event.details_ref', 'INSERT audit_event.embargo_group_id', 'INSERT audit_event.id', 'INSERT audit_event.org_id', 'INSERT audit_event.outcome', 'INSERT audit_event.request_digest', 'INSERT audit_event.resource_id', 'INSERT audit_event.resource_kind', 'INSERT audit_event.updated_at',
        'SELECT artifact_upload.expires_at', 'SELECT artifact_upload.id', 'SELECT artifact_upload.org_id', 'SELECT artifact_upload.state', 'SELECT artifact_upload.temporary_key', 'UPDATE artifact_upload.state', 'UPDATE artifact_upload.updated_at',
        'SELECT organization.id',
      ].sort());
      for (const r of roles.rows) expect([r.rolname, r.rolsuper, r.rolbypassrls, r.rolcreaterole]).toEqual([r.rolname, false, false, false]);
      const owners = await c.query<{ owner: string; n: string }>("SELECT pg_get_userbyid(relowner) AS owner, count(*) AS n FROM pg_class WHERE relnamespace = 'factory'::regnamespace GROUP BY 1");
      expect(owners.rows.map((r) => r.owner)).toEqual(['factory_migrator']);
      const tables = await c.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>("SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relnamespace = 'factory'::regnamespace AND relkind = 'r' AND relname <> 'organization'");
      expect(tables.rows).toHaveLength(61); // 58 reference tables + principal_allowance and budget_account_allowance (0014) + queue_ack (0015)
      expect(tables.rows.filter((t) => !t.relrowsecurity || !t.relforcerowsecurity)).toEqual([]);
    } finally { await c.end(); }
  });

  it('the runtime login cannot run DDL or assume the migrator role', async () => {
    const c = new pg.Client({ connectionString: db.runtimeUrl });
    await c.connect();
    try {
      await expect(c.query('CREATE TABLE factory.evil (id int)')).rejects.toMatchObject({ code: '42501' });
      await expect(c.query('SET ROLE factory_migrator')).rejects.toMatchObject({ code: '42501' });
      await expect(c.query('ALTER TABLE factory.task DISABLE ROW LEVEL SECURITY')).rejects.toMatchObject({ code: '42501' });
      await expect(c.query('SELECT * FROM factory_migration.applied')).resolves.toBeDefined();
      await expect(c.query("INSERT INTO factory_migration.applied (version, name, checksum, phase) VALUES (9999, 'x', $1, 'expand')", ['a'.repeat(64)])).rejects.toMatchObject({ code: '42501' });
    } finally { await c.end(); }
  });

  it('re-running is a no-op, and an edited applied migration stops the run', async () => {
    expect((await migrate(db.migratorUrl)).applied).toEqual([]);
    const dir = mkdtempSync(join(tmpdir(), 'migrations-'));
    try {
      cpSync(MIGRATIONS_DIR, dir, { recursive: true });
      const file = join(dir, '0007_indexes.sql');
      writeFileSync(file, `${readFileSync(file, 'utf8')}\n-- tampered\n`);
      await expect(migrate(db.migratorUrl, { dirs: [dir] })).rejects.toMatchObject({ code: 'checksum_mismatch' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('every migration declares a phase and contract migrations must declare what they retire', () => {
    expect(loadMigrations().map((m) => m.phase)).toEqual(Array(16).fill('expand'));
    const dir = mkdtempSync(join(tmpdir(), 'bad-migrations-'));
    try {
      writeFileSync(join(dir, '0001_drop_things.sql'), '-- phase: contract\nDROP TABLE x;\n');
      expect(() => loadMigrations([dir])).toThrow(MigrationError);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
