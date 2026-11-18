// Budget Activities: the task's account, stage reservations and charges, and change_budget.
import { budgetUsage, chargeBudget, currentAllowance, openBudgetAccount, reserveBudget } from '@factory/database';
import type { TaskActivities } from '../workflows/types.ts';
import type { ActivityKit } from './shared.ts';

type Budget = Pick<TaskActivities, 'openBudget' | 'reserveStageBudget' | 'chargeStageBudget' | 'adjustBudget'>;

export function budgetActivities({ deps, tenant }: ActivityKit): Budget {
  return {
    async openBudget({ orgId, taskId, limitMicroUsd }) {
      return tenant(orgId, async (tx) => {
        const scope = await tx.query<{ delivery_scope: string; creator_id: string }>('SELECT delivery_scope, creator_id FROM factory.task WHERE id = $1', [taskId]);
        const task = scope.rows[0];
        // The creator pays: the task draws on the creator's allowance for the period it starts in.
        const personal = task ? await currentAllowance(tx, { orgId, principalId: task.creator_id }) : undefined;
        return { accountId: await openBudgetAccount(tx, { orgId, taskId, limitMicroUsd, deliveryScope: task?.delivery_scope ?? 'report', ...(personal ? { allowanceId: personal.allowanceId } : {}) }) };
      });
    },

    async reserveStageBudget({ orgId, taskId, operationKey, nodeId }) {
      return tenant(orgId, async (tx) => {
        const account = await tx.query<{ id: string }>('SELECT id FROM factory.budget_account WHERE task_id = $1', [taskId]);
        const accountId = account.rows[0]?.id;
        if (!accountId) return { admitted: false, reasons: ['no budget account'], chargedMicroUsd: 0, reservedMicroUsd: 0, limitMicroUsd: 0 };
        const r = await reserveBudget(tx, { orgId, accountId, operationKey, amountMicroUsd: deps.fakeStage?.estimateMicroUsd?.(nodeId) ?? 1_000_000 });
        const own = r.chain.at(-1);
        return { admitted: r.admitted, reasons: r.admitted ? [] : [`${r.reason} on account ${r.blockingAccountId}`], chargedMicroUsd: own?.chargedMicroUsd ?? 0, reservedMicroUsd: own?.reservedMicroUsd ?? 0, limitMicroUsd: own?.limitMicroUsd ?? 0 };
      });
    },

    async chargeStageBudget({ orgId, taskId, operationKey, nodeId, actualMicroUsd }) {
      return tenant(orgId, async (tx) => {
        const account = await tx.query<{ id: string }>('SELECT id FROM factory.budget_account WHERE task_id = $1', [taskId]);
        const accountId = account.rows[0]?.id;
        if (!accountId) return { admitted: false, reasons: ['no budget account'], chargedMicroUsd: 0, reservedMicroUsd: 0, limitMicroUsd: 0 };
        await chargeBudget(tx, { orgId, accountId, operationKey, actualMicroUsd: actualMicroUsd ?? deps.fakeStage?.actualMicroUsd?.(nodeId) ?? deps.fakeStage?.estimateMicroUsd?.(nodeId) ?? 1_000_000 });
        const u = await budgetUsage(tx, accountId);
        return { admitted: true, reasons: [], chargedMicroUsd: u?.chargedMicroUsd ?? 0, reservedMicroUsd: u?.reservedMicroUsd ?? 0, limitMicroUsd: u?.limitMicroUsd ?? 0 };
      });
    },

    // change_budget: a decrease never erases actual charges.
    async adjustBudget({ orgId, taskId, limitMicroUsd }) {
      return tenant(orgId, async (tx) => {
        const r = await tx.query<{ charged_micro_usd: string; reserved_micro_usd: string; limit_micro_usd: string }>(
          'UPDATE factory.budget_account SET limit_micro_usd = GREATEST($2::bigint, charged_micro_usd), revision = revision + 1, updated_at = now() WHERE task_id = $1 RETURNING charged_micro_usd, reserved_micro_usd, limit_micro_usd', [taskId, limitMicroUsd]);
        const row = r.rows[0];
        return { admitted: row !== undefined, reasons: row ? [] : ['no budget account'], chargedMicroUsd: Number(row?.charged_micro_usd ?? 0), reservedMicroUsd: Number(row?.reserved_micro_usd ?? 0), limitMicroUsd: Number(row?.limit_micro_usd ?? 0) };
      });
    },
  };
}
