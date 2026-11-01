// Application-scoped RBAC (chapter 12 role matrix). Pure decision function: callers re-evaluate it
// at the moment of use (command application, delivery), never cache a past "allowed".
export const ROLES = ['viewer', 'contributor', 'task_owner', 'application_owner', 'policy_owner', 'reviewer', 'release_manager', 'operator', 'organization_admin'] as const;
export type Role = (typeof ROLES)[number];
export type RoleGrant = { membershipId: string; role: Role; applicationScope: string[] | 'all' };

export type Principal = {
  orgId: string;
  principalId: string;
  issuer: string;
  subject: string;
  groups: string[];
  grants: RoleGrant[];
};

export type Action = 'task.read' | 'task.create' | 'artifact.read' | 'release.authorize' | 'roles.manage' | 'outcome.export';
export type ArtifactClassification = 'ordinary' | 'restricted' | 'sensitive_session';
export type Resource = { applicationId: string; applicationOwnerIds?: string[]; classification?: ArtifactClassification; taskCreatorId?: string; taskOwnerId?: string };
export type Decision = { allowed: boolean; reason: string; viaRole?: Role };

const ACTION_ROLES: Record<Action, readonly Role[]> = {
  'task.read': ROLES,
  'task.create': ['contributor', 'application_owner'],
  'artifact.read': ROLES,
  'release.authorize': ['release_manager'],
  'roles.manage': ['organization_admin'],
  // Chapter 12 "Audit interaction": operators export a task outcome bundle.
  'outcome.export': ['operator'],
};

const inScope = (g: RoleGrant, applicationId: string): boolean => g.applicationScope === 'all' || g.applicationScope.includes(applicationId);

// Application ownership also comes from ApplicationDefinition.ownerIds: a principal ID, or a group
// such as team:commerce that the authenticated token asserts membership of.
export function effectiveRoles(p: Principal, r: Resource): RoleGrant[] {
  const grants = p.grants.filter((g) => inScope(g, r.applicationId));
  const owners = r.applicationOwnerIds ?? [];
  if (owners.includes(p.principalId) || p.groups.some((g) => owners.includes(g))) {
    grants.push({ membershipId: 'application-owner-designation', role: 'application_owner', applicationScope: [r.applicationId] });
  }
  return grants;
}

export function authorize(p: Principal, action: Action, r: Resource): Decision {
  const roles = effectiveRoles(p, r);
  const allowedRoles = ACTION_ROLES[action];
  let candidates = roles.filter((g) => allowedRoles.includes(g.role));
  if (action === 'artifact.read') {
    // Viewers see nonrestricted evidence only; native session state is operator-only.
    if (r.classification === 'restricted') candidates = candidates.filter((g) => g.role !== 'viewer');
    if (r.classification === 'sensitive_session') candidates = candidates.filter((g) => g.role === 'operator');
    if (r.classification === undefined) return { allowed: false, reason: 'artifact classification unknown' };
  }
  if (action === 'release.authorize' && (r.taskCreatorId === p.principalId || r.taskOwnerId === p.principalId)) {
    return { allowed: false, reason: 'separation of duties: the task author or owner cannot authorize its release' };
  }
  const via = candidates[0];
  return via ? { allowed: true, reason: `role ${via.role}`, viaRole: via.role } : { allowed: false, reason: `no role permitting ${action} on application ${r.applicationId}` };
}
