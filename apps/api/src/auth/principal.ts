// Maps an authenticated identity to its principal and current role grants inside its organization.
import type { Database, Tx } from '@factory/database';
import { ROLES, type Principal, type Role, type RoleGrant } from './rbac.ts';
import type { VerifiedIdentity } from './oidc.ts';

export class AuthorizationError extends Error {
  constructor(message: string) { super(message); this.name = 'AuthorizationError'; }
}

export async function loadGrants(tx: Tx, principalId: string): Promise<RoleGrant[]> {
  const rows = await tx.query<{ id: string; role: string; application_scope: unknown }>('SELECT id, role, application_scope FROM factory.membership WHERE principal_id = $1 AND revoked_at IS NULL ORDER BY role, id', [principalId]);
  const grants: RoleGrant[] = [];
  for (const r of rows.rows) {
    if (!(ROLES as readonly string[]).includes(r.role)) continue; // unknown roles grant nothing
    const scope = Array.isArray(r.application_scope) ? r.application_scope.filter((x): x is string => typeof x === 'string') : [];
    grants.push({ membershipId: r.id, role: r.role as Role, applicationScope: scope.includes('*') ? 'all' : scope });
  }
  return grants;
}

export async function resolvePrincipal(db: Database, identity: VerifiedIdentity): Promise<Principal> {
  return db.withTenant({ orgId: identity.orgId }, async (tx) => {
    const r = await tx.query<{ id: string }>('SELECT id FROM factory.principal WHERE issuer = $1 AND subject = $2 AND disabled_at IS NULL', [identity.issuer, identity.subject]);
    const row = r.rows[0];
    if (!row) throw new AuthorizationError('no active principal for this identity');
    return { orgId: identity.orgId, principalId: row.id, issuer: identity.issuer, subject: identity.subject, groups: identity.groups, grants: await loadGrants(tx, row.id) };
  });
}
