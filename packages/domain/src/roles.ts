// The role vocabulary of the role matrix (chapter 12). Shared so every component that reads
// memberships ignores unknown roles the same way: an unknown role grants nothing.
export const ROLES = ['viewer', 'contributor', 'task_owner', 'application_owner', 'policy_owner', 'reviewer', 'release_manager', 'operator', 'organization_admin'] as const;
export type Role = (typeof ROLES)[number];
