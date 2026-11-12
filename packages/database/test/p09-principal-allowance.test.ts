// P-09 (docs/plan-additions.md): per-principal allowances. Unrelated tasks of one developer draw on
// the same allowance; concurrent reservations cannot oversubscribe it; actual charges are recorded
// truthfully; another developer and another organization are unaffected.
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { type Tx, Database, chargeBudget, createMigratedDatabase, currentAllowance, openBudgetAccount, provisionOrganization, reserveBudget, setAllowance, type MigratedDatabase } from '../src/index.ts';

describe('P-09 per-principal allowance', () => {
  let m: MigratedDatabase;
  let db: Database;
  const orgId = randomUUID();
  const otherOrg = randomUUID();
  const appId = randomUUID();
  const admin = randomUUID();
  beforeAll(async () => {
    m = await createMigratedDatabase('p09');
    await provisionOrganization(m.migratorUrl, { id: orgId, name: 'Org' });
    await provisionOrganization(m.migratorUrl, { id: otherOrg, name: 'Other' });
    db = Database.connect(m.runtimeUrl, 30);
    await db.withTenant({ orgId }, async (tx) => {
      await tx.query("INSERT INTO factory.principal (org_id, id, issuer, subject, display_name) VALUES ($1,$2,'i','admin','admin')", [orgId, admin]);
      await tx.query("INSERT INTO factory.application (org_id, id, app_key, name, owner_ids, lifecycle) VALUES ($1,$2,'orders','Orders','[]','production')", [orgId, appId]);
    });
  });
  afterAll(async () => { await db.close(); await m.drop(); });
  const tx = <T>(fn: (t: Tx) => Promise<T>) => db.withTenant({ orgId }, fn);
  const developer = async (): Promise<string> => {
    const id = randomUUID();
    await tx((t) => t.query("INSERT INTO factory.principal (org_id, id, issuer, subject, display_name) VALUES ($1,$2,'i',$3,'dev')", [orgId, id, `dev-${id}`]));
    return id;
  };
  // An independent task (no parent) of `creator`, with its own generous task budget, linked to the
  // creator's allowance if they have one.
  const account = async (creator: string): Promise<string> => {
    const taskId = randomUUID();
    return tx(async (t) => {
      await t.query("INSERT INTO factory.task (org_id, id, creator_id, primary_application_id, target_kind, target_context, work_type, change_class, delivery_scope, status) VALUES ($1,$2,$3,$4,'existing_application',$5,'feature','feature','pr','running')",
        [orgId, taskId, creator, appId, JSON.stringify({ kind: 'existing_application', applicationId: appId })]);
      const a = await currentAllowance(t, { orgId, principalId: creator });
      return openBudgetAccount(t, { orgId, taskId, limitMicroUsd: 1_000, deliveryScope: 'pr', ...(a ? { allowanceId: a.allowanceId } : {}) });
    });
  };
  const allowanceOf = (principalId: string) => tx((t) => currentAllowance(t, { orgId, principalId }));

  it('a developer with no allowance is not enrolled and is limited only by the task budget', async () => {
    const dev = await developer();
    expect(await allowanceOf(dev)).toBeUndefined();
    const a = await account(dev);
    expect((await tx((t) => reserveBudget(t, { orgId, accountId: a, operationKey: 's', amountMicroUsd: 900 }))).admitted).toBe(true);
  });

  it('unrelated tasks of one developer share the allowance: twenty concurrent reservations admit exactly what fits', async () => {
    const dev = await developer();
    await tx((t) => setAllowance(t, { orgId, principalId: dev, monthlyLimitMicroUsd: 100, setByPrincipalId: admin }));
    const accounts = await Promise.all(Array.from({ length: 20 }, () => account(dev)));
    const results = await Promise.all(accounts.map((a, i) => tx((t) => reserveBudget(t, { orgId, accountId: a, operationKey: `stage-${String(i)}`, amountMicroUsd: 15 }))));
    expect(results.filter((r) => r.admitted)).toHaveLength(6); // 6 × 15 = 90 ≤ 100 < 105
    const denied = results.find((r) => !r.admitted);
    const personal = await allowanceOf(dev);
    expect(denied).toMatchObject({ admitted: false, reason: 'principal_allowance_exhausted', blockingAccountId: personal?.allowanceId });
    expect(personal).toMatchObject({ limitMicroUsd: 100, reservedMicroUsd: 90, chargedMicroUsd: 0, remainingMicroUsd: 10 });
  });

  it('a retried reservation is not counted twice, and the actual charge replaces the estimate truthfully', async () => {
    const dev = await developer();
    await tx((t) => setAllowance(t, { orgId, principalId: dev, monthlyLimitMicroUsd: 100, setByPrincipalId: admin }));
    const a = await account(dev);
    const reserve = () => tx((t) => reserveBudget(t, { orgId, accountId: a, operationKey: 'stage', amountMicroUsd: 40 }));
    expect(await reserve()).toMatchObject({ admitted: true, duplicate: false });
    expect(await reserve()).toMatchObject({ admitted: true, duplicate: true });
    expect(await allowanceOf(dev)).toMatchObject({ reservedMicroUsd: 40, chargedMicroUsd: 0 });
    await tx((t) => chargeBudget(t, { orgId, accountId: a, operationKey: 'stage', actualMicroUsd: 130 })); // an overrun
    await tx((t) => chargeBudget(t, { orgId, accountId: a, operationKey: 'stage', actualMicroUsd: 130 })); // retried charge
    expect(await allowanceOf(dev)).toMatchObject({ reservedMicroUsd: 0, chargedMicroUsd: 130, remainingMicroUsd: 0 });
    // The overrun is on record, and it stops the developer's next task too.
    const b = await account(dev);
    expect(await tx((t) => reserveBudget(t, { orgId, accountId: b, operationKey: 'next', amountMicroUsd: 1 }))).toMatchObject({ admitted: false, reason: 'principal_allowance_exhausted' });
  });

  it('changing the limit keeps usage; one developer\'s allowance never limits another', async () => {
    const dev = await developer();
    const colleague = await developer();
    await tx((t) => setAllowance(t, { orgId, principalId: dev, monthlyLimitMicroUsd: 10, setByPrincipalId: admin }));
    await tx((t) => setAllowance(t, { orgId, principalId: colleague, monthlyLimitMicroUsd: 500, setByPrincipalId: admin }));
    const a = await account(dev);
    expect((await tx((t) => reserveBudget(t, { orgId, accountId: a, operationKey: 's1', amountMicroUsd: 10 }))).admitted).toBe(true);
    expect((await tx((t) => reserveBudget(t, { orgId, accountId: a, operationKey: 's2', amountMicroUsd: 10 }))).admitted).toBe(false);
    const theirs = await account(colleague);
    expect((await tx((t) => reserveBudget(t, { orgId, accountId: theirs, operationKey: 's', amountMicroUsd: 400 }))).admitted).toBe(true);
    expect(await tx((t) => setAllowance(t, { orgId, principalId: dev, monthlyLimitMicroUsd: 50, setByPrincipalId: admin }))).toMatchObject({ limitMicroUsd: 50, reservedMicroUsd: 10, remainingMicroUsd: 40 });
    expect((await tx((t) => reserveBudget(t, { orgId, accountId: a, operationKey: 's2', amountMicroUsd: 10 }))).admitted).toBe(true);
  });

  it('an enrolled developer\'s new month opens with the same limit and no usage; the old month is kept', async () => {
    const dev = await developer();
    // Last month's row, with usage, written as the migrator would see it after time has passed.
    await tx((t) => t.query("INSERT INTO factory.principal_allowance (org_id, id, principal_id, period_start, period_end, limit_micro_usd, charged_micro_usd, set_by_principal_id) VALUES ($1,$2,$3, (date_trunc('month', now() AT TIME ZONE 'UTC') - interval '1 month')::date, date_trunc('month', now() AT TIME ZONE 'UTC')::date, 70, 65, $4)", [orgId, randomUUID(), dev, admin]));
    const opened = await Promise.all([allowanceOf(dev), allowanceOf(dev), allowanceOf(dev)]); // concurrent first use
    expect(new Set(opened.map((a) => a?.allowanceId)).size).toBe(1);
    expect(opened[0]).toMatchObject({ limitMicroUsd: 70, chargedMicroUsd: 0, reservedMicroUsd: 0, remainingMicroUsd: 70 });
    const rows = await tx(async (t) => (await t.query<{ charged_micro_usd: string }>('SELECT charged_micro_usd FROM factory.principal_allowance WHERE principal_id = $1 ORDER BY period_start', [dev])).rows);
    expect(rows.map((r) => r.charged_micro_usd)).toEqual(['65', '0']);
  });

  it('allowances are tenant-isolated and cannot be deleted or re-pointed by the runtime role', async () => {
    const dev = await developer();
    const a = await tx((t) => setAllowance(t, { orgId, principalId: dev, monthlyLimitMicroUsd: 10, setByPrincipalId: admin }));
    const seen = await db.withTenant({ orgId: otherOrg }, async (t) => (await t.query('SELECT 1 FROM factory.principal_allowance')).rowCount);
    expect(seen).toBe(0);
    await expect(db.withTenant({ orgId: otherOrg }, (t) => t.query('UPDATE factory.principal_allowance SET limit_micro_usd = 999999 WHERE id = $1 RETURNING id', [a.allowanceId]))).resolves.toMatchObject({ rowCount: 0 });
    await expect(tx((t) => t.query('DELETE FROM factory.principal_allowance WHERE id = $1', [a.allowanceId]))).rejects.toMatchObject({ code: '42501' });
    const acct = await account(dev);
    await expect(tx((t) => t.query('UPDATE factory.budget_account_allowance SET allowance_id = $2 WHERE account_id = $1', [acct, a.allowanceId]))).rejects.toMatchObject({ code: '42501' });
    await expect(tx((t) => t.query('DELETE FROM factory.budget_account_allowance WHERE account_id = $1', [acct]))).rejects.toMatchObject({ code: '42501' });
    const forced = await db.withTenant({ orgId }, async (t) => (await t.query<{ relforcerowsecurity: boolean }>("SELECT relforcerowsecurity FROM pg_class WHERE oid IN ('factory.principal_allowance'::regclass, 'factory.budget_account_allowance'::regclass)")).rows);
    expect(forced.map((r) => r.relforcerowsecurity)).toEqual([true, true]);
  });
});
