import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { type Tx, Database, chargeBudget, createMigratedDatabase, openBudgetAccount, provisionOrganization, reserveBudget, budgetUsage, type MigratedDatabase } from '../src/index.ts';

describe('AC-34 budget concurrency', () => {
  let m: MigratedDatabase;
  let db: Database;
  const orgId = randomUUID();
  const principalId = randomUUID();
  const appId = randomUUID();
  beforeAll(async () => {
    m = await createMigratedDatabase('ac34');
    await provisionOrganization(m.migratorUrl, { id: orgId, name: 'Org' });
    db = Database.connect(m.runtimeUrl, 30);
    await db.withTenant({ orgId }, async (tx) => {
      await tx.query("INSERT INTO factory.principal (org_id, id, issuer, subject, display_name) VALUES ($1,$2,'i','s','u')", [orgId, principalId]);
      await tx.query("INSERT INTO factory.application (org_id, id, app_key, name, owner_ids, lifecycle) VALUES ($1,$2,'orders','Orders','[]','production')", [orgId, appId]);
    });
  });
  afterAll(async () => { await db.close(); await m.drop(); });

  async function task(parent?: string): Promise<string> {
    const id = randomUUID();
    await db.withTenant({ orgId }, (tx) => tx.query("INSERT INTO factory.task (org_id, id, parent_task_id, creator_id, primary_application_id, target_kind, target_context, work_type, change_class, delivery_scope, status) VALUES ($1,$2,$3,$4,$5,'existing_application',$6,'feature','feature','pr','running')",
      [orgId, id, parent ?? null, principalId, appId, JSON.stringify({ kind: 'existing_application', applicationId: appId })]));
    return id;
  }
  const tx = <T>(fn: (t: Tx) => Promise<T>) => db.withTenant({ orgId }, fn);

  it('two child stages contending for the parent\'s remaining allowance cannot oversubscribe it', async () => {
    const parentTask = await task();
    const parent = await tx((t) => openBudgetAccount(t, { orgId, taskId: parentTask, limitMicroUsd: 100, deliveryScope: 'pr' }));
    const children = await Promise.all([task(parentTask), task(parentTask)]);
    const accounts = await Promise.all(children.map((c) => tx((t) => openBudgetAccount(t, { orgId, taskId: c, limitMicroUsd: 80, parentAccountId: parent, deliveryScope: 'pr' }))));
    const results = await Promise.all(accounts.map((a, i) => tx((t) => reserveBudget(t, { orgId, accountId: a, operationKey: `stage-${String(i)}`, amountMicroUsd: 60 }))));
    expect(results.map((r) => r.admitted).sort()).toEqual([false, true]);
    const denied = results.find((r) => !r.admitted);
    expect(denied?.admitted === false ? denied.blockingAccountId : undefined).toBe(parent);
    expect(await tx((t) => budgetUsage(t, parent))).toMatchObject({ reservedMicroUsd: 60, chargedMicroUsd: 0, limitMicroUsd: 100 });
  });

  it('many concurrent reservations admit exactly what fits, under every limit in the chain', async () => {
    const parentTask = await task();
    const parent = await tx((t) => openBudgetAccount(t, { orgId, taskId: parentTask, limitMicroUsd: 100, deliveryScope: 'pr' }));
    const children = await Promise.all(Array.from({ length: 10 }, () => task(parentTask)));
    const accounts = await Promise.all(children.map((c) => tx((t) => openBudgetAccount(t, { orgId, taskId: c, limitMicroUsd: 30, parentAccountId: parent, deliveryScope: 'pr' }))));
    const results = await Promise.all(accounts.flatMap((a) => [0, 1].map((k) => tx((t) => reserveBudget(t, { orgId, accountId: a, operationKey: `op-${String(k)}`, amountMicroUsd: 15 })))));
    expect(results.filter((r) => r.admitted).length).toBe(6); // 6 x 15 = 90 <= 100; a 7th would exceed the parent
    const usage = await tx((t) => budgetUsage(t, parent));
    expect(usage?.reservedMicroUsd).toBe(90);
    expect((usage?.reservedMicroUsd ?? 0) + (usage?.chargedMicroUsd ?? 0)).toBeLessThanOrEqual(100);
  });

  it('a retried reservation with the same key is reconciled, not double-reserved', async () => {
    const t1 = await task();
    const account = await tx((t) => openBudgetAccount(t, { orgId, taskId: t1, limitMicroUsd: 100, deliveryScope: 'pr' }));
    const [a, b] = await Promise.all([0, 1].map(() => tx((t) => reserveBudget(t, { orgId, accountId: account, operationKey: 'same-stage', amountMicroUsd: 70 }))));
    expect([a?.admitted, b?.admitted]).toEqual([true, true]);
    expect([a, b].filter((r) => r && r.admitted && r.duplicate)).toHaveLength(1);
    expect((await tx((t) => budgetUsage(t, account)))?.reservedMicroUsd).toBe(70);
  });

  it('a late actual charge above its estimate is recorded truthfully and stops new admissions', async () => {
    const t1 = await task();
    const account = await tx((t) => openBudgetAccount(t, { orgId, taskId: t1, limitMicroUsd: 100, deliveryScope: 'pr' }));
    expect((await tx((t) => reserveBudget(t, { orgId, accountId: account, operationKey: 'stage-1', amountMicroUsd: 40 }))).admitted).toBe(true);
    const after = await tx((t) => chargeBudget(t, { orgId, accountId: account, operationKey: 'stage-1', actualMicroUsd: 130 }));
    expect(after.at(-1)).toMatchObject({ chargedMicroUsd: 130, reservedMicroUsd: 0 }); // exceeds the limit, recorded as observed
    expect((await tx((t) => reserveBudget(t, { orgId, accountId: account, operationKey: 'stage-2', amountMicroUsd: 1 }))).admitted).toBe(false);
    const again = await tx((t) => chargeBudget(t, { orgId, accountId: account, operationKey: 'stage-1', actualMicroUsd: 130 }));
    expect(again.at(-1)?.chargedMicroUsd).toBe(130); // a retried charge is not counted twice
  });
});
