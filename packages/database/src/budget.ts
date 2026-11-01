// Hierarchical budget reservations (chapter 02 "For budget admission ..."; AC-34).
//
// reserve(): lock the account chain in a stable root-to-leaf order, reconcile the unique
// reservation key, and admit only if charged + outstanding reservations + requested fits every
// applicable limit; then record the ledger entry and raise `reserved` on every account in the chain.
// charge(): convert a reservation into the actual charge, recorded truthfully even when it exceeds
// the estimate; later admissions see the overrun and stop.
import { randomUUID } from 'node:crypto';
import type { Tx } from './db.ts';

type AccountRow = { id: string; parent_account_id: string | null; limit_micro_usd: string; reserved_micro_usd: string; charged_micro_usd: string };
export type BudgetUsage = { accountId: string; limitMicroUsd: number; reservedMicroUsd: number; chargedMicroUsd: number };
export type ReserveResult =
  | { admitted: true; duplicate: boolean; chain: BudgetUsage[] }
  | { admitted: false; reason: 'insufficient_allowance'; blockingAccountId: string; chain: BudgetUsage[] };

const usage = (r: AccountRow): BudgetUsage => ({ accountId: r.id, limitMicroUsd: Number(r.limit_micro_usd), reservedMicroUsd: Number(r.reserved_micro_usd), chargedMicroUsd: Number(r.charged_micro_usd) });

export async function openBudgetAccount(tx: Tx, input: { orgId: string; taskId: string; limitMicroUsd: number; parentAccountId?: string; deliveryScope: string }): Promise<string> {
  if (!Number.isSafeInteger(input.limitMicroUsd) || input.limitMicroUsd < 0) throw new Error('budget limit must be a non-negative integer of micro-USD');
  await tx.query(`INSERT INTO factory.budget_account (org_id, id, task_id, parent_account_id, limit_micro_usd, budget_class, task_delivery_scope)
    VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (org_id, task_id) DO NOTHING`,
    [input.orgId, randomUUID(), input.taskId, input.parentAccountId ?? null, input.limitMicroUsd, input.deliveryScope === 'design' ? 'design' : 'task', input.deliveryScope]);
  const r = await tx.query<{ id: string }>('SELECT id FROM factory.budget_account WHERE task_id = $1', [input.taskId]);
  const id = r.rows[0]?.id;
  if (!id) throw new Error('budget account not visible');
  return id;
}

// The account and its ancestors, root first, each row locked FOR UPDATE in that order.
async function lockChain(tx: Tx, accountId: string): Promise<AccountRow[]> {
  const ids: string[] = [];
  for (let cur: string | null = accountId; cur !== null; ) {
    if (ids.includes(cur) || ids.length > 16) throw new Error('budget account hierarchy is cyclic or too deep');
    ids.push(cur);
    const r: { rows: Array<{ parent_account_id: string | null }> } = await tx.query<{ parent_account_id: string | null }>('SELECT parent_account_id FROM factory.budget_account WHERE id = $1', [cur]);
    const row = r.rows[0];
    if (!row) throw new Error(`budget account ${cur} not found`);
    cur = row.parent_account_id;
  }
  const rootFirst = [...ids].reverse();
  const locked: AccountRow[] = [];
  for (const id of rootFirst) {
    const r = await tx.query<AccountRow>('SELECT id, parent_account_id, limit_micro_usd, reserved_micro_usd, charged_micro_usd FROM factory.budget_account WHERE id = $1 FOR UPDATE', [id]);
    const row = r.rows[0];
    if (!row) throw new Error(`budget account ${id} not found`);
    locked.push(row);
  }
  return locked;
}

export async function reserveBudget(tx: Tx, input: { orgId: string; accountId: string; operationKey: string; amountMicroUsd: number }): Promise<ReserveResult> {
  if (!Number.isSafeInteger(input.amountMicroUsd) || input.amountMicroUsd < 0) throw new Error('reservation must be a non-negative integer of micro-USD');
  const chain = await lockChain(tx, input.accountId);
  const existing = await tx.query("SELECT 1 FROM factory.budget_ledger WHERE account_id = $1 AND operation_key = $2 AND kind = 'reservation'", [input.accountId, input.operationKey]);
  if (existing.rowCount === 1) return { admitted: true, duplicate: true, chain: chain.map(usage) };
  for (const a of chain) {
    const u = usage(a);
    if (u.chargedMicroUsd + u.reservedMicroUsd + input.amountMicroUsd > u.limitMicroUsd) return { admitted: false, reason: 'insufficient_allowance', blockingAccountId: a.id, chain: chain.map(usage) };
  }
  await tx.query("INSERT INTO factory.budget_ledger (org_id, id, account_id, operation_key, kind, amount_micro_usd) VALUES ($1,$2,$3,$4,'reservation',$5)", [input.orgId, randomUUID(), input.accountId, input.operationKey, input.amountMicroUsd]);
  for (const a of chain) await tx.query('UPDATE factory.budget_account SET reserved_micro_usd = reserved_micro_usd + $2, revision = revision + 1, updated_at = now() WHERE id = $1', [a.id, input.amountMicroUsd]);
  const after = await tx.query<AccountRow>('SELECT id, parent_account_id, limit_micro_usd, reserved_micro_usd, charged_micro_usd FROM factory.budget_account WHERE id = ANY($1)', [chain.map((a) => a.id)]);
  return { admitted: true, duplicate: false, chain: chain.map((a) => usage(after.rows.find((r) => r.id === a.id) ?? a)) };
}

export async function chargeBudget(tx: Tx, input: { orgId: string; accountId: string; operationKey: string; actualMicroUsd: number; providerRequestId?: string }): Promise<BudgetUsage[]> {
  if (!Number.isSafeInteger(input.actualMicroUsd) || input.actualMicroUsd < 0) throw new Error('charge must be a non-negative integer of micro-USD');
  const chain = await lockChain(tx, input.accountId);
  const reservation = await tx.query<{ amount_micro_usd: string }>("SELECT amount_micro_usd FROM factory.budget_ledger WHERE account_id = $1 AND operation_key = $2 AND kind = 'reservation'", [input.accountId, input.operationKey]);
  const reserved = Number(reservation.rows[0]?.amount_micro_usd ?? 0);
  const inserted = await tx.query("INSERT INTO factory.budget_ledger (org_id, id, account_id, operation_key, kind, amount_micro_usd, provider_request_id) VALUES ($1,$2,$3,$4,'observed_usage',$5,$6) ON CONFLICT (org_id, account_id, operation_key, kind) DO NOTHING",
    [input.orgId, randomUUID(), input.accountId, input.operationKey, input.actualMicroUsd, input.providerRequestId ?? null]);
  if (inserted.rowCount === 1) {
    for (const a of chain) {
      await tx.query('UPDATE factory.budget_account SET reserved_micro_usd = GREATEST(0, reserved_micro_usd - $2), charged_micro_usd = charged_micro_usd + $3, revision = revision + 1, updated_at = now() WHERE id = $1', [a.id, reserved, input.actualMicroUsd]);
    }
  }
  const after = await tx.query<AccountRow>('SELECT id, parent_account_id, limit_micro_usd, reserved_micro_usd, charged_micro_usd FROM factory.budget_account WHERE id = ANY($1)', [chain.map((a) => a.id)]);
  return chain.map((a) => usage(after.rows.find((r) => r.id === a.id) ?? a));
}

export async function budgetUsage(tx: Tx, accountId: string): Promise<BudgetUsage | undefined> {
  const r = await tx.query<AccountRow>('SELECT id, parent_account_id, limit_micro_usd, reserved_micro_usd, charged_micro_usd FROM factory.budget_account WHERE id = $1', [accountId]);
  return r.rows[0] ? usage(r.rows[0]) : undefined;
}
