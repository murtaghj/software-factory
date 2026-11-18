// Command authority Activity (authority-v1). The API authorizes commands and decision responses at
// ingress; this re-checks the issuing principal at the moment the workflow applies them, from the
// current database state (A-24). The public refusal is the single word `authority_revoked`; the
// specific reason is recorded in an audit_event row.
import { ROLES } from '@factory/domain';
import type { Tx } from '@factory/database';
import type { TaskActivities } from '../workflows/types.ts';
import type { ActivityKit } from './shared.ts';

type CommandAuthority = Pick<TaskActivities, 'checkCommandAuthority'>;
type Verdict = { ok: true } | { ok: false; reason: string };

async function decide(tx: Tx, taskId: string, pendingLimit: number | undefined, command: { principal_id: string; kind: string; authority_basis: string | null; payload: { budgetMicroUsd?: unknown } }): Promise<Verdict> {
  const principalId = command.principal_id;
  const task = await tx.query<{ owner_principal_id: string; interactive_holder_principal_id: string | null; primary_application_id: string; owner_ids: unknown }>(
    'SELECT t.owner_principal_id, t.interactive_holder_principal_id, t.primary_application_id, a.owner_ids FROM factory.task t JOIN factory.application a ON a.org_id = t.org_id AND a.id = t.primary_application_id WHERE t.id = $1', [taskId]);
  const t = task.rows[0];
  if (!t) return { ok: false, reason: 'task_not_found' };
  const active = await tx.query('SELECT 1 FROM factory.principal WHERE id = $1 AND disabled_at IS NULL', [principalId]);
  if ((active.rowCount ?? 0) === 0) return { ok: false, reason: 'principal_disabled' };
  // Only known roles on a membership whose scope is an array naming this application or '*', as at ingress.
  const memberships = await tx.query<{ role: string }>("SELECT m.role FROM factory.membership m WHERE m.principal_id = $1 AND m.revoked_at IS NULL AND m.role = ANY($3::text[]) AND jsonb_typeof(m.application_scope) = 'array' AND (m.application_scope ? $2 OR m.application_scope ? '*')", [principalId, t.primary_application_id, [...ROLES]]);
  const roles = memberships.rows.map((m) => m.role);
  const owners = Array.isArray(t.owner_ids) ? (t.owner_ids as unknown[]) : [];
  // Ownership by principal ID, or by a group the token asserted at ingress: valid while that group is
  // still listed (a group basis never adds more than the application-owner role it gave).
  const group = command.authority_basis?.startsWith('group:') ? command.authority_basis.slice('group:'.length) : undefined;
  const ownsApplication = owners.includes(principalId) || (group !== undefined && owners.includes(group));
  if (roles.length === 0 && !ownsApplication) return { ok: false, reason: 'no_current_access' };
  // A decision response is answered by a reviewer; it does not need control of the task.
  if (command.kind === 'respond_decision') return roles.includes('reviewer') ? { ok: true } : { ok: false, reason: 'reviewer_authority_required' };
  const controls = t.owner_principal_id === principalId || t.interactive_holder_principal_id === principalId || roles.includes('operator');
  if (!controls) return { ok: false, reason: 'not_task_controller' };
  if (command.kind === 'change_budget') {
    // Raising a limit needs the application owner or an operator; a controller may only lower it.
    const account = await tx.query<{ limit_micro_usd: string }>('SELECT limit_micro_usd FROM factory.budget_account WHERE task_id = $1', [taskId]);
    // A change already applied but not yet written counts: the effective limit is the pending one.
    const limit = pendingLimit ?? (account.rows[0] ? Number(account.rows[0].limit_micro_usd) : undefined);
    const requested = Number(command.payload.budgetMicroUsd);
    const raises = limit === undefined || !Number.isFinite(requested) || requested > limit;
    if (raises && !(ownsApplication || roles.includes('operator') || roles.includes('application_owner'))) return { ok: false, reason: 'budget_increase_not_authorized' };
  }
  return { ok: true };
}

export function commandAuthorityActivities({ tenant }: ActivityKit): CommandAuthority {
  return {
    async checkCommandAuthority({ orgId, taskId, commandId, pendingBudgetMicroUsd }) {
      return tenant(orgId, async (tx) => {
        const row = await tx.query<{ principal_id: string; kind: string; request_hash: string; authority_basis: string | null; payload: { budgetMicroUsd?: unknown } }>('SELECT principal_id, kind, authority_basis, request_hash, payload FROM factory.command WHERE id = $1 AND task_id = $2', [commandId, taskId]);
        const command = row.rows[0];
        const verdict: Verdict = command ? await decide(tx, taskId, pendingBudgetMicroUsd, command) : { ok: false, reason: 'command_not_recorded' };
        if (!verdict.ok) {
          // One row per command however many times the Activity retries.
          await tx.query("INSERT INTO factory.audit_event (org_id, id, actor_id, action, resource_kind, resource_id, outcome, correlation_id, request_digest, details_ref) VALUES ($1, md5($2)::uuid, $3, 'command.authority_refused', 'task', $4, 'denied', $2, $5, $6) ON CONFLICT (org_id, id) DO NOTHING",
            [orgId, commandId, command?.principal_id ?? 'unknown', taskId, command?.request_hash ?? 'none', JSON.stringify({ reason: verdict.reason, kind: command?.kind ?? null })]);
        }
        return verdict;
      });
    },
  };
}
