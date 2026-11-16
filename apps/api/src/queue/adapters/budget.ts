// Tier 2: the caller's monthly allowance is nearly or fully used (P-24). An unenrolled person has no
// allowance and gets no item. Dismissible; "used up" has its own key, so it returns after "low" was
// marked as seen.
import { peekAllowance } from '@factory/database';
import type { QueueAdapter } from '../types.ts';

export const budgetAdapter: QueueAdapter = {
  id: 'factory.budget', kind: 'factory',
  async collect(ctx) {
    // Read-only and on the request's clock: a GET never opens a new period.
    const a = await peekAllowance(ctx.tx, { principalId: ctx.principal.principalId, at: ctx.now });
    if (!a || a.remainingMicroUsd * 100 > a.limitMicroUsd * ctx.rules.allowanceLowPercent) return { items: [], truncated: false };
    return { truncated: false, items: [{
      need: 'running_out', dismissible: true, priority: 'normal', since: ctx.now.toISOString(),
      // The limit is part of the key: raising the limit makes a later notice a new item, so an earlier "seen" does not hide it.
      subject: { kind: 'allowance', id: `${a.periodStart}.l${String(a.limitMicroUsd)}`, title: 'Your monthly allowance' },
      reason: { code: a.remainingMicroUsd === 0 ? 'allowance_used_up' : 'allowance_low', remainingMicroUsd: a.remainingMicroUsd, limitMicroUsd: a.limitMicroUsd },
      action: { kind: 'open_budget' },
    }] };
  },
};
