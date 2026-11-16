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
  | { admitted: false; reason: 'insufficient_allowance' | 'principal_allowance_exhausted'; blockingAccountId: string; chain: BudgetUsage[] };

const usage = (r: AccountRow): BudgetUsage => ({ accountId: r.id, limitMicroUsd: Number(r.limit_micro_usd), reservedMicroUsd: Number(r.reserved_micro_usd), chargedMicroUsd: Number(r.charged_micro_usd) });

export async function openBudgetAccount(tx: Tx, input: { orgId: string; taskId: string; limitMicroUsd: number; parentAccountId?: string; deliveryScope: string; allowanceId?: string }): Promise<string> {
  if (!Number.isSafeInteger(input.limitMicroUsd) || input.limitMicroUsd < 0) throw new Error('budget limit must be a non-negative integer of micro-USD');
  await tx.query(`INSERT INTO factory.budget_account (org_id, id, task_id, parent_account_id, limit_micro_usd, budget_class, task_delivery_scope)
    VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (org_id, task_id) DO NOTHING`,
    [input.orgId, randomUUID(), input.taskId, input.parentAccountId ?? null, input.limitMicroUsd, input.deliveryScope === 'design' ? 'design' : 'task', input.deliveryScope]);
  const r = await tx.query<{ id: string }>('SELECT id FROM factory.budget_account WHERE task_id = $1', [input.taskId]);
  const id = r.rows[0]?.id;
  if (!id) throw new Error('budget account not visible');
  // The allowance a task draws on is fixed when its account is opened and never re-pointed.
  if (input.allowanceId) await tx.query('INSERT INTO factory.budget_account_allowance (org_id, account_id, allowance_id) VALUES ($1,$2,$3) ON CONFLICT (org_id, account_id) DO NOTHING', [input.orgId, id, input.allowanceId]);
  return id;
}

// --- Per-principal allowances (plan-additions P-09). One row per principal and calendar month
// (UTC, by the database clock). A principal with no allowance row at all is not enrolled and is
// not limited here; an enrolled principal's next month is opened with the same limit.
export type Allowance = { allowanceId: string; principalId: string; periodStart: string; periodEnd: string; limitMicroUsd: number; reservedMicroUsd: number; chargedMicroUsd: number; remainingMicroUsd: number };
type AllowanceRow = { id: string; principal_id: string; period_start: string; period_end: string; limit_micro_usd: string; reserved_micro_usd: string; charged_micro_usd: string };
const ALLOWANCE_COLUMNS = 'id, principal_id, period_start::text, period_end::text, limit_micro_usd, reserved_micro_usd, charged_micro_usd';
const PERIOD = "date_trunc('month', now() AT TIME ZONE 'UTC')::date";
function allowance(r: AllowanceRow): Allowance {
  const limit = Number(r.limit_micro_usd), reserved = Number(r.reserved_micro_usd), charged = Number(r.charged_micro_usd);
  return { allowanceId: r.id, principalId: r.principal_id, periodStart: r.period_start, periodEnd: r.period_end, limitMicroUsd: limit, reservedMicroUsd: reserved, chargedMicroUsd: charged, remainingMicroUsd: Math.max(0, limit - reserved - charged) };
}

// Sets the principal's limit for the current period (enrolling them if needed). Usage is kept.
export async function setAllowance(tx: Tx, input: { orgId: string; principalId: string; monthlyLimitMicroUsd: number; setByPrincipalId: string }): Promise<Allowance> {
  if (!Number.isSafeInteger(input.monthlyLimitMicroUsd) || input.monthlyLimitMicroUsd < 0) throw new Error('allowance must be a non-negative integer of micro-USD');
  const r = await tx.query<AllowanceRow>(`INSERT INTO factory.principal_allowance (org_id, id, principal_id, period_start, period_end, limit_micro_usd, set_by_principal_id)
    VALUES ($1,$2,$3, ${PERIOD}, (${PERIOD} + interval '1 month')::date, $4, $5)
    ON CONFLICT (org_id, principal_id, period_start) DO UPDATE SET limit_micro_usd = EXCLUDED.limit_micro_usd, set_by_principal_id = EXCLUDED.set_by_principal_id, revision = principal_allowance.revision + 1, updated_at = now()
    RETURNING ${ALLOWANCE_COLUMNS}`, [input.orgId, randomUUID(), input.principalId, input.monthlyLimitMicroUsd, input.setByPrincipalId]);
  const row = r.rows[0];
  if (!row) throw new Error('allowance not written');
  return allowance(row);
}

// The principal's allowance for the current period, or undefined when they are not enrolled.
export async function currentAllowance(tx: Tx, input: { orgId: string; principalId: string }): Promise<Allowance | undefined> {
  const current = await tx.query<AllowanceRow>(`SELECT ${ALLOWANCE_COLUMNS} FROM factory.principal_allowance WHERE principal_id = $1 AND period_start = ${PERIOD}`, [input.principalId]);
  if (current.rows[0]) return allowance(current.rows[0]);
  const last = await tx.query<{ limit_micro_usd: string; set_by_principal_id: string }>('SELECT limit_micro_usd, set_by_principal_id FROM factory.principal_allowance WHERE principal_id = $1 ORDER BY period_start DESC LIMIT 1', [input.principalId]);
  const prior = last.rows[0];
  if (!prior) return undefined;
  // Enrolled, new period: same limit, fresh usage. A concurrent opener's row wins.
  await tx.query(`INSERT INTO factory.principal_allowance (org_id, id, principal_id, period_start, period_end, limit_micro_usd, set_by_principal_id)
    VALUES ($1,$2,$3, ${PERIOD}, (${PERIOD} + interval '1 month')::date, $4, $5) ON CONFLICT (org_id, principal_id, period_start) DO NOTHING`, [input.orgId, randomUUID(), input.principalId, prior.limit_micro_usd, prior.set_by_principal_id]);
  const opened = await tx.query<AllowanceRow>(`SELECT ${ALLOWANCE_COLUMNS} FROM factory.principal_allowance WHERE principal_id = $1 AND period_start = ${PERIOD}`, [input.principalId]);
  if (!opened.rows[0]) throw new Error('allowance period not opened');
  return allowance(opened.rows[0]);
}

// Read-only view of the principal's allowance for the period containing `at` (UTC month). Unlike
// currentAllowance it never inserts: a period that has not been opened yet is shown as what opening
// it would create, the latest limit with no usage. Not enrolled: undefined.
export type AllowancePeek = Pick<Allowance, 'principalId' | 'periodStart' | 'limitMicroUsd' | 'reservedMicroUsd' | 'chargedMicroUsd' | 'remainingMicroUsd'>;
export async function peekAllowance(tx: Tx, input: { principalId: string; at: Date }): Promise<AllowancePeek | undefined> {
  const period = "date_trunc('month', $2::timestamptz AT TIME ZONE 'UTC')::date";
  const current = await tx.query<AllowanceRow>(`SELECT ${ALLOWANCE_COLUMNS} FROM factory.principal_allowance WHERE principal_id = $1 AND period_start = ${period}`, [input.principalId, input.at]);
  if (current.rows[0]) { const a = allowance(current.rows[0]); return { principalId: a.principalId, periodStart: a.periodStart, limitMicroUsd: a.limitMicroUsd, reservedMicroUsd: a.reservedMicroUsd, chargedMicroUsd: a.chargedMicroUsd, remainingMicroUsd: a.remainingMicroUsd }; }
  const last = await tx.query<{ limit_micro_usd: string; peek_period: string }>(`SELECT limit_micro_usd, ${period}::text AS peek_period FROM factory.principal_allowance WHERE principal_id = $1 ORDER BY principal_allowance.period_start DESC LIMIT 1`, [input.principalId, input.at]);
  const prior = last.rows[0];
  if (!prior) return undefined;
  const limit = Number(prior.limit_micro_usd);
  return { principalId: input.principalId, periodStart: prior.peek_period, limitMicroUsd: limit, reservedMicroUsd: 0, chargedMicroUsd: 0, remainingMicroUsd: limit };
}

// Locks the allowance a task account draws on, if any. Always taken before the account chain, so
// every reservation and charge locks in the same order.
async function lockAllowance(tx: Tx, accountId: string): Promise<AllowanceRow | undefined> {
  const link = await tx.query<{ allowance_id: string }>('SELECT allowance_id FROM factory.budget_account_allowance WHERE account_id = $1', [accountId]);
  const allowanceId = link.rows[0]?.allowance_id;
  if (!allowanceId) return undefined;
  const r = await tx.query<AllowanceRow>(`SELECT ${ALLOWANCE_COLUMNS} FROM factory.principal_allowance WHERE id = $1 FOR UPDATE`, [allowanceId]);
  if (!r.rows[0]) throw new Error(`allowance ${allowanceId} not found`);
  return r.rows[0];
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
  const personal = await lockAllowance(tx, input.accountId);
  const chain = await lockChain(tx, input.accountId);
  const existing = await tx.query("SELECT 1 FROM factory.budget_ledger WHERE account_id = $1 AND operation_key = $2 AND kind = 'reservation'", [input.accountId, input.operationKey]);
  if (existing.rowCount === 1) return { admitted: true, duplicate: true, chain: chain.map(usage) };
  if (personal && Number(personal.charged_micro_usd) + Number(personal.reserved_micro_usd) + input.amountMicroUsd > Number(personal.limit_micro_usd)) return { admitted: false, reason: 'principal_allowance_exhausted', blockingAccountId: personal.id, chain: chain.map(usage) };
  for (const a of chain) {
    const u = usage(a);
    if (u.chargedMicroUsd + u.reservedMicroUsd + input.amountMicroUsd > u.limitMicroUsd) return { admitted: false, reason: 'insufficient_allowance', blockingAccountId: a.id, chain: chain.map(usage) };
  }
  await tx.query("INSERT INTO factory.budget_ledger (org_id, id, account_id, operation_key, kind, amount_micro_usd) VALUES ($1,$2,$3,$4,'reservation',$5)", [input.orgId, randomUUID(), input.accountId, input.operationKey, input.amountMicroUsd]);
  for (const a of chain) await tx.query('UPDATE factory.budget_account SET reserved_micro_usd = reserved_micro_usd + $2, revision = revision + 1, updated_at = now() WHERE id = $1', [a.id, input.amountMicroUsd]);
  if (personal) await tx.query('UPDATE factory.principal_allowance SET reserved_micro_usd = reserved_micro_usd + $2, revision = revision + 1, updated_at = now() WHERE id = $1', [personal.id, input.amountMicroUsd]);
  const after = await tx.query<AccountRow>('SELECT id, parent_account_id, limit_micro_usd, reserved_micro_usd, charged_micro_usd FROM factory.budget_account WHERE id = ANY($1)', [chain.map((a) => a.id)]);
  return { admitted: true, duplicate: false, chain: chain.map((a) => usage(after.rows.find((r) => r.id === a.id) ?? a)) };
}

export async function chargeBudget(tx: Tx, input: { orgId: string; accountId: string; operationKey: string; actualMicroUsd: number; providerRequestId?: string }): Promise<BudgetUsage[]> {
  if (!Number.isSafeInteger(input.actualMicroUsd) || input.actualMicroUsd < 0) throw new Error('charge must be a non-negative integer of micro-USD');
  const personal = await lockAllowance(tx, input.accountId);
  const chain = await lockChain(tx, input.accountId);
  const reservation = await tx.query<{ amount_micro_usd: string }>("SELECT amount_micro_usd FROM factory.budget_ledger WHERE account_id = $1 AND operation_key = $2 AND kind = 'reservation'", [input.accountId, input.operationKey]);
  const reserved = Number(reservation.rows[0]?.amount_micro_usd ?? 0);
  const inserted = await tx.query("INSERT INTO factory.budget_ledger (org_id, id, account_id, operation_key, kind, amount_micro_usd, provider_request_id) VALUES ($1,$2,$3,$4,'observed_usage',$5,$6) ON CONFLICT (org_id, account_id, operation_key, kind) DO NOTHING",
    [input.orgId, randomUUID(), input.accountId, input.operationKey, input.actualMicroUsd, input.providerRequestId ?? null]);
  if (inserted.rowCount === 1) {
    for (const a of chain) {
      await tx.query('UPDATE factory.budget_account SET reserved_micro_usd = GREATEST(0, reserved_micro_usd - $2), charged_micro_usd = charged_micro_usd + $3, revision = revision + 1, updated_at = now() WHERE id = $1', [a.id, reserved, input.actualMicroUsd]);
    }
    // The actual charge is recorded truthfully on the allowance too, even past its limit.
    if (personal) await tx.query('UPDATE factory.principal_allowance SET reserved_micro_usd = GREATEST(0, reserved_micro_usd - $2), charged_micro_usd = charged_micro_usd + $3, revision = revision + 1, updated_at = now() WHERE id = $1', [personal.id, reserved, input.actualMicroUsd]);
  }
  const after = await tx.query<AccountRow>('SELECT id, parent_account_id, limit_micro_usd, reserved_micro_usd, charged_micro_usd FROM factory.budget_account WHERE id = ANY($1)', [chain.map((a) => a.id)]);
  return chain.map((a) => usage(after.rows.find((r) => r.id === a.id) ?? a));
}

export async function budgetUsage(tx: Tx, accountId: string): Promise<BudgetUsage | undefined> {
  const r = await tx.query<AccountRow>('SELECT id, parent_account_id, limit_micro_usd, reserved_micro_usd, charged_micro_usd FROM factory.budget_account WHERE id = $1', [accountId]);
  return r.rows[0] ? usage(r.rows[0]) : undefined;
}
