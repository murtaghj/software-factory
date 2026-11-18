// P-18 (docs/plan-additions.md, A-24): commands record a group authority basis at ingress.
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Database, createMigratedDatabase, provisionOrganization, type MigratedDatabase } from '../src/index.ts';

describe('P-18 command authority basis (migration 0016)', () => {
  let m: MigratedDatabase;
  let db: Database;
  const orgId = randomUUID();
  const principalId = randomUUID();
  const applicationId = randomUUID();
  const taskId = randomUUID();
  beforeAll(async () => {
    m = await createMigratedDatabase('p18basis');
    await provisionOrganization(m.migratorUrl, { id: orgId, name: 'Org' });
    db = Database.connect(m.runtimeUrl, 5);
    await db.withTenant({ orgId }, async (tx) => {
      await tx.query("INSERT INTO factory.principal (org_id, id, issuer, subject, display_name) VALUES ($1,$2,'i','s','p')", [orgId, principalId]);
      await tx.query("INSERT INTO factory.application (org_id, id, app_key, name, owner_ids, lifecycle) VALUES ($1,$2,'orders','Orders','[]','production')", [orgId, applicationId]);
      await tx.query("INSERT INTO factory.task (org_id, id, creator_id, primary_application_id, target_kind, target_context, work_type, change_class, delivery_scope, status) VALUES ($1,$2,$3,$4,'existing_application',$5,'feature','feature','pr','running')", [orgId, taskId, principalId, applicationId, JSON.stringify({ kind: 'existing_application', applicationId })]);
    });
  });
  afterAll(async () => { await db.close(); await m.drop(); });

  const insert = (basis: string | null) => db.withTenant({ orgId }, (tx) => tx.query("INSERT INTO factory.command (org_id, id, task_id, principal_id, expected_revision, kind, request_hash, payload, state, authority_basis) VALUES ($1,$2,$3,$4,1,'pause',$5,'{}','queued',$6)", [orgId, randomUUID(), taskId, principalId, 'a'.repeat(64), basis]));

  it('the column is optional and holds only a group basis', async () => {
    await insert(null);
    await insert('group:team:commerce');
    await expect(insert('membership:abc')).rejects.toMatchObject({ code: '23514' });
    await expect(insert('group:')).rejects.toMatchObject({ code: '23514' });
  });

  it('the runtime role cannot change a recorded basis afterwards', async () => {
    const id = randomUUID();
    await db.withTenant({ orgId }, (tx) => tx.query("INSERT INTO factory.command (org_id, id, task_id, principal_id, expected_revision, kind, request_hash, payload, state, authority_basis) VALUES ($1,$2,$3,$4,1,'pause',$5,'{}','queued','group:team:a')", [orgId, id, taskId, principalId, 'b'.repeat(64)]));
    await expect(db.withTenant({ orgId }, (tx) => tx.query("UPDATE factory.command SET authority_basis = 'group:team:b' WHERE id = $1", [id]))).rejects.toMatchObject({ code: '42501' });
    await expect(db.withTenant({ orgId }, (tx) => tx.query('UPDATE factory.command SET authority_basis = NULL WHERE id = $1', [id]))).rejects.toMatchObject({ code: '42501' });
  });
});
