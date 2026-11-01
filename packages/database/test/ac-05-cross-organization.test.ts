import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Database, createMigratedDatabase, provisionOrganization, type MigratedDatabase } from '../src/index.ts';
import { seedTenant, sha, type Seeded } from './seed.ts';

describe('AC-05 cross-organization access (tenant-qualified database layer)', () => {
  let m: MigratedDatabase;
  let db: Database;
  let a: Seeded;
  let b: Seeded;
  beforeAll(async () => {
    m = await createMigratedDatabase('ac05');
    const orgA = randomUUID();
    const orgB = randomUUID();
    await provisionOrganization(m.migratorUrl, { id: orgA, name: 'Org A' });
    await provisionOrganization(m.migratorUrl, { id: orgB, name: 'Org B' });
    db = Database.connect(m.runtimeUrl);
    a = await seedTenant(db, orgA);
    b = await seedTenant(db, orgB);
  });
  afterAll(async () => { await db.close(); await m.drop(); });

  it('reads are confined to the caller organization, even when the caller supplies another organization\'s IDs', async () => {
    await db.withTenant({ orgId: a.orgId }, async (tx) => {
      const tasks = await tx.query<{ id: string }>('SELECT id FROM factory.task');
      expect(tasks.rows.map((r) => r.id)).toEqual([a.taskId]);
      for (const [table, id] of [['task', b.taskId], ['artifact', b.artifactId], ['stage_run', b.stageRunId], ['gate_evaluation', b.gateId], ['principal', b.principalId]] as const) {
        expect((await tx.query(`SELECT 1 FROM factory.${table} WHERE id = $1`, [id])).rowCount, table).toBe(0);
        expect((await tx.query(`SELECT 1 FROM factory.${table} WHERE org_id = $1`, [b.orgId])).rowCount, table).toBe(0);
      }
    });
  });

  it('writes stamped with another organization are rejected by row-level security', async () => {
    await expect(db.withTenant({ orgId: a.orgId }, (tx) => tx.query(
      "INSERT INTO factory.principal (org_id, id, issuer, subject, display_name) VALUES ($1, $2, 'https://issuer.test', 'intruder', 'x')", [b.orgId, randomUUID()]))).rejects.toMatchObject({ code: '42501' });
  });

  it('a row in the caller organization cannot reference another organization\'s records (tenant-qualified foreign keys)', async () => {
    // observation has no task-visibility policy, so the composite (org_id, application_id) key itself rejects it.
    await expect(db.withTenant({ orgId: a.orgId }, (tx) => tx.query(
      "INSERT INTO factory.observation (org_id, id, application_id, environment, observation_kind, valid_from, valid_until, evidence_ref) VALUES ($1, $2, $3, 'prod', 'x', now(), now() + interval '1 hour', '{}')",
      [a.orgId, randomUUID(), b.applicationId]))).rejects.toMatchObject({ code: '23503' });
    // task-owned rows are refused by the restrictive task-visibility policy before the foreign key is checked.
    for (const [sql, params] of [
      ["INSERT INTO factory.task_spec_version (org_id, id, task_id, version, spec, spec_hash, actor_id) VALUES ($1, $2, $3, 2, '{}', $4, $5)", [a.orgId, randomUUID(), b.taskId, sha('a'), a.principalId]],
      ["INSERT INTO factory.artifact_link (org_id, id, artifact_id, task_id, purpose, retain_until) VALUES ($1, $2, $3, $4, 'stage_output', now())", [a.orgId, randomUUID(), b.artifactId, a.taskId]],
    ] as const) {
      const err = await db.withTenant({ orgId: a.orgId }, (tx) => tx.query(sql, [...params])).then(() => undefined, (e: unknown) => e as { code?: string });
      expect(['23503', '42501', 'P0001']).toContain(err?.code);
    }
  });

  it('updates aimed at another organization\'s rows affect nothing', async () => {
    const r = await db.withTenant({ orgId: a.orgId }, (tx) => tx.query("UPDATE factory.task SET status = 'cancelled' WHERE id = $1", [b.taskId]));
    expect(r.rowCount).toBe(0);
    const still = await db.withTenant({ orgId: b.orgId }, (tx) => tx.query<{ status: string }>('SELECT status FROM factory.task WHERE id = $1', [b.taskId]));
    expect(still.rows[0]?.status).toBe('accepted');
  });

  it('without a tenant context protected tables read empty and reject writes (fail closed)', async () => {
    await db.withoutTenant(async (tx) => {
      expect((await tx.query('SELECT 1 FROM factory.task')).rowCount).toBe(0);
      expect((await tx.query('SELECT 1 FROM factory.artifact')).rowCount).toBe(0);
    });
    await expect(db.withoutTenant((tx) => tx.query("INSERT INTO factory.principal (org_id, id, issuer, subject, display_name) VALUES ($1, $2, 'i', 's', 'x')", [a.orgId, randomUUID()]))).rejects.toMatchObject({ code: '42501' });
  });

  it('the organization lookup is intentionally unscoped but limited to id and status', async () => {
    await db.withTenant({ orgId: a.orgId }, async (tx) => {
      expect((await tx.query('SELECT id, status FROM factory.organization')).rowCount).toBe(2);
    });
    await expect(db.withTenant({ orgId: a.orgId }, (tx) => tx.query('SELECT name FROM factory.organization'))).rejects.toMatchObject({ code: '42501' });
  });
});
