// P-24 (docs/plan-additions.md): "Mark as seen" storage. A person sees and writes only their own
// acknowledgements; another person and another organization see none; rows can be neither changed
// nor deleted; row security is forced.
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Database, createMigratedDatabase, peekAllowance, provisionOrganization, type MigratedDatabase } from '../src/index.ts';

describe('P-24 queue acknowledgements', () => {
  let m: MigratedDatabase;
  let db: Database;
  const orgId = randomUUID();
  const otherOrg = randomUUID();
  const dana = randomUUID();
  const riley = randomUUID();
  const outsider = randomUUID();
  const key = 'task:11111111-1111-4111-8111-111111111111:task_finished';
  beforeAll(async () => {
    m = await createMigratedDatabase('p24ack');
    await provisionOrganization(m.migratorUrl, { id: orgId, name: 'Org' });
    await provisionOrganization(m.migratorUrl, { id: otherOrg, name: 'Other' });
    db = Database.connect(m.runtimeUrl, 10);
    for (const [org, id] of [[orgId, dana], [orgId, riley], [otherOrg, outsider]] as const) {
      await db.withTenant({ orgId: org }, (tx) => tx.query("INSERT INTO factory.principal (org_id, id, issuer, subject, display_name) VALUES ($1,$2,'i',$3,'p')", [org, id, `s-${id}`]));
    }
  });
  afterAll(async () => { await db.close(); await m.drop(); });
  const keysOf = (org: string, principalId: string) => db.withTenant({ orgId: org, principalId }, async (tx) => (await tx.query<{ item_key: string }>('SELECT item_key FROM factory.queue_ack')).rows.map((r) => r.item_key));
  const insert = (org: string, principalId: string, forPrincipal: string, k = key) => db.withTenant({ orgId: org, principalId }, (tx) => tx.query('INSERT INTO factory.queue_ack (org_id, principal_id, item_key) VALUES ($1,$2,$3)', [org, forPrincipal, k]));

  it('a person sees only their own acknowledgements', async () => {
    await insert(orgId, dana, dana);
    expect(await keysOf(orgId, dana)).toEqual([key]);
    expect(await keysOf(orgId, riley)).toEqual([]);
    expect(await keysOf(otherOrg, outsider)).toEqual([]);
    expect(await db.withTenant({ orgId }, async (tx) => (await tx.query<{ one: number }>('SELECT 1 AS one FROM factory.queue_ack')).rows)).toEqual([]); // no principal in the context: nothing
  });

  it('a person cannot write an acknowledgement for someone else or another organization', async () => {
    await expect(insert(orgId, riley, dana, 'task:x:task_stopped')).rejects.toMatchObject({ code: '42501' });
    await expect(insert(otherOrg, outsider, dana)).rejects.toMatchObject({ code: '42501' });
    await expect(insert(orgId, dana, riley)).rejects.toMatchObject({ code: '42501' });
  });

  it('the same key twice is refused by the primary key, and a malformed key by the check', async () => {
    await expect(insert(orgId, dana, dana)).rejects.toMatchObject({ code: '23505' });
    await expect(insert(orgId, dana, dana, 'x')).rejects.toMatchObject({ code: '23514' });
    await expect(insert(orgId, dana, dana, 'k'.repeat(301))).rejects.toMatchObject({ code: '23514' });
  });

  it('rows can be neither changed nor deleted, and row security is forced', async () => {
    await expect(db.withTenant({ orgId, principalId: dana }, (tx) => tx.query("UPDATE factory.queue_ack SET item_key = 'abc'"))).rejects.toMatchObject({ code: '42501' });
    await expect(db.withTenant({ orgId, principalId: dana }, (tx) => tx.query('DELETE FROM factory.queue_ack'))).rejects.toMatchObject({ code: '42501' });
    const flags = await db.withTenant({ orgId }, (tx) => tx.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'factory.queue_ack'::regclass"));
    expect(flags.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    expect(await keysOf(orgId, dana)).toEqual([key]);
  });

  // peekAllowance carries the latest earlier month's limit into a month that has no row yet.
  it('a month with no row shows the limit of the latest earlier month, whatever order the rows were written in', async () => {
    const row = (principal: string, month: string, limit: number) => db.withTenant({ orgId }, (tx) => tx.query(
      "INSERT INTO factory.principal_allowance (org_id, id, principal_id, period_start, period_end, limit_micro_usd, set_by_principal_id) VALUES ($1,$2,$3,$4::date,($4::date + interval '1 month')::date,$5,$3)", [orgId, randomUUID(), principal, month, limit]));
    const peek = (principal: string) => db.withTenant({ orgId }, (tx) => peekAllowance(tx, { principalId: principal, at: new Date('2026-11-16T12:00:00Z') }));
    const latestHigh = randomUUID();
    const latestZero = randomUUID();
    for (const id of [latestHigh, latestZero]) await db.withTenant({ orgId }, (tx) => tx.query("INSERT INTO factory.principal (org_id, id, issuer, subject, display_name) VALUES ($1,$2,'i',$3,'p')", [orgId, id, `s-${id}`]));
    await row(latestHigh, '2026-09-01', 0); await row(latestHigh, '2026-10-01', 50_000_000); // September written first
    await row(latestZero, '2026-10-01', 50_000_000); await row(latestZero, '2026-09-01', 0); // October written first
    expect(await peek(latestHigh)).toMatchObject({ periodStart: '2026-11-01', limitMicroUsd: 50_000_000, remainingMicroUsd: 50_000_000 });
    expect(await peek(latestZero)).toMatchObject({ limitMicroUsd: 50_000_000 });
    // The reverse: the latest month's limit is the zero one.
    const reverse = randomUUID();
    await db.withTenant({ orgId }, (tx) => tx.query("INSERT INTO factory.principal (org_id, id, issuer, subject, display_name) VALUES ($1,$2,'i',$3,'p')", [orgId, reverse, `s-${reverse}`]));
    await row(reverse, '2026-10-01', 0); await row(reverse, '2026-09-01', 50_000_000);
    expect(await peek(reverse)).toMatchObject({ limitMicroUsd: 0 });
    expect(await peek(randomUUID())).toBeUndefined();
    const count = await db.withTenant({ orgId }, async (tx) => Number((await tx.query<{ n: string }>('SELECT count(*) AS n FROM factory.principal_allowance WHERE principal_id = $1', [latestHigh])).rows[0]?.n));
    expect(count).toBe(2); // nothing was written
  });
});
