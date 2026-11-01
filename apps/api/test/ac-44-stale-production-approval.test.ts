import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { revalidateRelease, RELEASE_APPROVAL_TTL_MS, type ReleaseApproval, type ReleaseContext, type ReleaseSubject } from '../src/index.ts';
import { createApiHarness, type ApiHarness, type User } from './harness.ts';

describe('AC-44 stale production approval (authority revalidated at apply time)', () => {
  let h: ApiHarness;
  let manager: User;
  let author: User;
  let ctx: ReleaseContext;
  const subject: ReleaseSubject = { candidateDigest: 'c'.repeat(64), environment: 'production-eu', policyRevision: 'policy-7' };
  const t0 = Date.parse('2026-11-01T12:00:00Z');
  const approval = (over: Partial<ReleaseApproval> = {}): ReleaseApproval => ({ decisionId: randomUUID(), approverPrincipalId: manager.principalId, subject, decidedAtMs: t0, expiresAtMs: t0 + RELEASE_APPROVAL_TTL_MS, ...over });

  beforeAll(async () => {
    h = await createApiHarness('ac44');
    manager = await h.user(h.a, [{ role: 'release_manager', scope: [h.a.applicationId] }]);
    author = await h.user(h.a, [{ role: 'contributor', scope: [h.a.applicationId] }, { role: 'release_manager', scope: [h.a.applicationId] }]);
    const t = await h.task(h.a, author);
    ctx = { orgId: h.a.orgId, taskId: t.taskId, applicationId: h.a.applicationId, applicationOwnerIds: ['team:commerce'], taskCreatorId: author.principalId, taskOwnerId: author.principalId };
  });
  afterAll(async () => { await h.close(); });

  it('a current approval on the exact release and environment by a current release manager is accepted', async () => {
    expect(await revalidateRelease(h.db, ctx, approval(), subject, t0 + 1000)).toEqual({ allowed: true, reasons: [] });
  });

  it.each([
    ['candidate changed', { ...subject, candidateDigest: 'd'.repeat(64) }, 'candidate changed since approval'],
    ['policy changed', { ...subject, policyRevision: 'policy-8' }, 'policy changed since approval'],
    ['different environment', { ...subject, environment: 'production-us' }, 'approval names a different environment'],
  ])('%s before apply → denied', async (_l, current, reason) => {
    const v = await revalidateRelease(h.db, ctx, approval(), current, t0 + 1000);
    expect(v.allowed).toBe(false);
    expect(v.reasons).toContain(reason);
  });

  it('an expired approval, or one issued for longer than 24 hours, is denied', async () => {
    expect((await revalidateRelease(h.db, ctx, approval(), subject, t0 + RELEASE_APPROVAL_TTL_MS)).reasons).toContain('approval expired');
    expect((await revalidateRelease(h.db, ctx, approval({ expiresAtMs: t0 + 2 * RELEASE_APPROVAL_TTL_MS }), subject, t0 + 1000)).reasons).toContain('approval expired');
  });

  it('the task author cannot authorize its own release even with the role', async () => {
    const v = await revalidateRelease(h.db, ctx, approval({ approverPrincipalId: author.principalId }), subject, t0 + 1000);
    expect(v.allowed).toBe(false);
    expect(v.reasons.join(' ')).toContain('separation of duties');
  });

  it('revoked authority cannot be revived by replaying the old approval', async () => {
    const old = approval();
    expect((await revalidateRelease(h.db, ctx, old, subject, t0 + 1000)).allowed).toBe(true);
    await h.tx(h.a, (t) => t.query("UPDATE factory.membership SET revoked_at = now() WHERE principal_id = $1 AND role = 'release_manager'", [manager.principalId]));
    const replay = await revalidateRelease(h.db, ctx, old, subject, t0 + 2000);
    expect(replay.allowed).toBe(false);
    expect(replay.reasons.join(' ')).toContain('approver lacks current release authority');
    const audit = await h.tx(h.a, async (t) => (await t.query<{ outcome: string }>("SELECT outcome FROM factory.audit_event WHERE action = 'release.revalidate' AND correlation_id = $1 ORDER BY created_at", [old.decisionId])).rows.map((r) => r.outcome));
    expect(audit).toEqual(['allowed', 'denied']);
  });

  it('no decision at all is denied', async () => {
    expect(await revalidateRelease(h.db, ctx, undefined, subject, t0)).toEqual({ allowed: false, reasons: ['no release decision'] });
  });
});
