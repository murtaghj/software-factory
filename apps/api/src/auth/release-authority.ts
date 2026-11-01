// Release authority revalidation (AC-44; chapter 03: "Bind identity at ingress and revalidate current
// authority before delayed release. Revoked authority cannot be revived by replaying an old
// command."; chapter 04: a production release decision expires after 24 hours or any bound-input
// change). Called immediately before the release side effect, never earlier.
import { createHash, randomUUID } from 'node:crypto';
import type { Database } from '@factory/database';
import { loadGrants } from './principal.ts';
import { authorize } from './rbac.ts';

export type ReleaseSubject = { candidateDigest: string; environment: string; policyRevision: string };
export type ReleaseApproval = {
  decisionId: string;
  approverPrincipalId: string;
  subject: ReleaseSubject;
  decidedAtMs: number;
  expiresAtMs: number;
};
export type ReleaseContext = { orgId: string; taskId: string; applicationId: string; applicationOwnerIds: string[]; taskCreatorId: string; taskOwnerId: string };
export type ReleaseVerdict = { allowed: boolean; reasons: string[] };

export const RELEASE_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

export async function revalidateRelease(db: Database, ctx: ReleaseContext, approval: ReleaseApproval | undefined, current: ReleaseSubject, nowMs: number): Promise<ReleaseVerdict> {
  const reasons: string[] = [];
  if (!approval) {
    reasons.push('no release decision');
  } else {
    if (approval.subject.candidateDigest !== current.candidateDigest) reasons.push('candidate changed since approval');
    if (approval.subject.environment !== current.environment) reasons.push('approval names a different environment');
    if (approval.subject.policyRevision !== current.policyRevision) reasons.push('policy changed since approval');
    if (!(nowMs < approval.expiresAtMs) || approval.expiresAtMs - approval.decidedAtMs > RELEASE_APPROVAL_TTL_MS) reasons.push('approval expired');
  }
  await db.withTenant({ orgId: ctx.orgId }, async (tx) => {
    if (approval) {
      const p = await tx.query<{ issuer: string; subject: string }>('SELECT issuer, subject FROM factory.principal WHERE id = $1 AND disabled_at IS NULL', [approval.approverPrincipalId]);
      const row = p.rows[0];
      if (!row) {
        reasons.push('approver is no longer an active principal');
      } else {
        const principal = { orgId: ctx.orgId, principalId: approval.approverPrincipalId, issuer: row.issuer, subject: row.subject, groups: [], grants: await loadGrants(tx, approval.approverPrincipalId) };
        const d = authorize(principal, 'release.authorize', { applicationId: ctx.applicationId, applicationOwnerIds: ctx.applicationOwnerIds, taskCreatorId: ctx.taskCreatorId, taskOwnerId: ctx.taskOwnerId });
        if (!d.allowed) reasons.push(`approver lacks current release authority: ${d.reason}`);
      }
    }
    await tx.query('INSERT INTO factory.audit_event (org_id, id, actor_id, action, resource_kind, resource_id, outcome, correlation_id, request_digest, details_ref) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [ctx.orgId, randomUUID(), approval?.approverPrincipalId ?? 'none', 'release.revalidate', 'task', ctx.taskId, reasons.length === 0 ? 'allowed' : 'denied', approval?.decisionId ?? ctx.taskId,
        createHash('sha256').update(JSON.stringify(current)).digest('hex'), JSON.stringify({ reasons })]);
  });
  return { allowed: reasons.length === 0, reasons };
}
