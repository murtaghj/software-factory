// Per-developer allowances (plan-additions P-09; A-17). The creator pays: a task's budget account
// draws on its creator's allowance for the month it starts in. Only an organization admin sets a
// limit; anyone may read their own. A principal with no allowance is not enrolled and not limited.
import { randomUUID } from 'node:crypto';
import { canonicalHash } from '@factory/domain';
import { currentAllowance, setAllowance, type Allowance, type Database, type Tx } from '@factory/database';
import type { Principal } from '../auth/rbac.ts';
import { ApiError } from '../tasks/service.ts';

export type AllowanceView = { principalId: string; enrolled: false } | ({ enrolled: true } & Omit<Allowance, 'allowanceId'>);
const view = (principalId: string, a: Allowance | undefined): AllowanceView => (a
  ? { enrolled: true, principalId: a.principalId, periodStart: a.periodStart, periodEnd: a.periodEnd, limitMicroUsd: a.limitMicroUsd, reservedMicroUsd: a.reservedMicroUsd, chargedMicroUsd: a.chargedMicroUsd, remainingMicroUsd: a.remainingMicroUsd }
  : { principalId, enrolled: false });
const isAdmin = (p: Principal): boolean => p.grants.some((g) => g.role === 'organization_admin');

export class AllowanceService {
  private readonly db: Database;
  constructor(o: { db: Database }) { this.db = o.db; }
  private tenant<T>(p: Principal, fn: (tx: Tx) => Promise<T>): Promise<T> { return this.db.withTenant({ orgId: p.orgId, principalId: p.principalId }, fn); }

  mine(p: Principal): Promise<AllowanceView> {
    return this.tenant(p, async (tx) => view(p.principalId, await currentAllowance(tx, { orgId: p.orgId, principalId: p.principalId })));
  }

  // Another principal's allowance is visible to organization admins only; to anyone else it is
  // indistinguishable from an unknown principal.
  get(p: Principal, principalId: string): Promise<AllowanceView> {
    if (principalId !== p.principalId && !isAdmin(p)) throw new ApiError(404, 'not_found', 'unknown or inaccessible resource');
    return this.tenant(p, async (tx) => {
      const exists = await tx.query('SELECT 1 FROM factory.principal WHERE id = $1', [principalId]);
      if (exists.rowCount !== 1) throw new ApiError(404, 'not_found', 'unknown or inaccessible resource');
      return view(principalId, await currentAllowance(tx, { orgId: p.orgId, principalId }));
    });
  }

  set(p: Principal, principalId: string, raw: unknown, correlationId: string): Promise<AllowanceView> {
    if (!isAdmin(p)) throw new ApiError(403, 'allowance_not_authorized', 'setting an allowance requires the organization_admin role');
    const limit = (typeof raw === 'object' && raw !== null ? (raw as { monthlyLimitMicroUsd?: unknown }).monthlyLimitMicroUsd : undefined);
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 0) throw new ApiError(422, 'invalid_allowance', 'monthlyLimitMicroUsd must be a non-negative integer of micro-USD');
    return this.tenant(p, async (tx) => {
      const exists = await tx.query('SELECT 1 FROM factory.principal WHERE id = $1 AND disabled_at IS NULL', [principalId]);
      if (exists.rowCount !== 1) throw new ApiError(404, 'not_found', 'unknown or inaccessible resource');
      const a = await setAllowance(tx, { orgId: p.orgId, principalId, monthlyLimitMicroUsd: limit, setByPrincipalId: p.principalId });
      await tx.query("INSERT INTO factory.audit_event (org_id, id, actor_id, action, resource_kind, resource_id, outcome, correlation_id, request_digest) VALUES ($1,$2,$3,'allowance.set','principal',$4,'allowed',$5,$6)", [p.orgId, randomUUID(), p.principalId, principalId, correlationId, canonicalHash({ principalId, monthlyLimitMicroUsd: limit })]);
      return view(principalId, a);
    });
  }
}
