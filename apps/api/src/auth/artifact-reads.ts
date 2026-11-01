// RBAC-backed artifact read authority: a human may read an artifact through a caller-visible task
// link whose application grants them artifact.read for the artifact's classification. Service
// identities stay bound to their own task. Artifacts with no visible link are not readable here.
import type { ReadAuthority } from '@factory/artifacts';
import { TASK_BOUND_READS } from '@factory/artifacts';
import { loadGrants } from './principal.ts';
import { authorize } from './rbac.ts';

export const RBAC_ARTIFACT_READS: ReadAuthority = {
  async canRead(ctx, artifact, tx) {
    if (ctx.actorKind !== 'human') return TASK_BOUND_READS.canRead(ctx, artifact, tx);
    if (!ctx.principalId) return false;
    const grants = await loadGrants(tx, ctx.principalId);
    const principal = { orgId: ctx.orgId, principalId: ctx.principalId, issuer: '', subject: '', groups: ctx.groups ?? [], grants };
    for (const link of artifact.links) {
      const r = await tx.query<{ application_id: string; owner_ids: unknown }>(
        'SELECT a.id AS application_id, a.owner_ids FROM factory.task t JOIN factory.application a ON a.org_id = t.org_id AND a.id = t.primary_application_id WHERE t.id = $1', [link.taskId]);
      const app = r.rows[0];
      if (!app) continue;
      const owners = Array.isArray(app.owner_ids) ? app.owner_ids.filter((x): x is string => typeof x === 'string') : [];
      if (authorize(principal, 'artifact.read', { applicationId: app.application_id, applicationOwnerIds: owners, classification: artifact.classification }).allowed) return true;
    }
    return false;
  },
};
