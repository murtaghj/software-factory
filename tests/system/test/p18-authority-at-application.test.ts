import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { canonicalJson } from '@factory/domain';
import { randomUUID } from 'node:crypto';
import { createSystemHarness, type SystemHarness, type SystemUser } from '../src/index.ts';
import { command, createTask, getTask, investigation, pendingDecision, pump, respond, waitStatus } from './support.ts';

// P-18 (A-13, A-24): pause, resume, cancel and amend are authorized at ingress and again when the
// workflow applies them. A principal who lost authority in between has the command refused with a
// recorded reason, and nothing about the task changes.
describe('P-18 command authority is re-checked when the command is applied', () => {
  let h: SystemHarness;
  let viewer: SystemUser;
  const reviewers: SystemUser[] = [];
  // Holds the investigate stage while a test acts on a task that has a stage in flight.
  const latch: { promise: Promise<void>; release: () => void } = (() => { let release: () => void = () => undefined; const promise = new Promise<void>((r) => { release = r; }); return { promise, release }; })();
  beforeAll(async () => {
    h = await createSystemHarness('p18sys', { temporal: { fakeStage: { hold: (n) => (n === 'investigate' ? latch.promise : undefined) } } });
    viewer = await h.user([{ role: 'viewer', scope: [h.applicationId] }]);
    reviewers.push(await h.user([{ role: 'reviewer', scope: [h.applicationId] }]), await h.user([{ role: 'reviewer', scope: [h.applicationId] }])); // the plan review needs an independent peer to wait on
  }, 300_000);
  afterAll(async () => { latch.release(); await h.close(); });

  const revokeAll = (principalId: string) => h.tx((t) => t.query('UPDATE factory.membership SET revoked_at = now() WHERE principal_id = $1 AND revoked_at IS NULL', [principalId]));
  const commandRow = async (commandId: string) => pump(h, async () => {
    const row = (await h.tx((t) => t.query<{ state: string; rejection_reason: string | null }>('SELECT state, rejection_reason FROM factory.command WHERE id = $1', [commandId]))).rows[0];
    return row && ['applied', 'rejected'].includes(row.state) ? row : undefined;
  });
  // The receipt says only authority_revoked; the specific reason is in the audit trail.
  const expectRefused = async (commandId: string, reason: string) => {
    expect(await commandRow(commandId)).toEqual({ state: 'rejected', rejection_reason: 'authority_revoked' });
    const audit = await h.tx((t) => t.query<{ details_ref: { reason: string } }>("SELECT details_ref FROM factory.audit_event WHERE action = 'command.authority_refused' AND correlation_id = $1", [commandId]));
    expect(audit.rows.map((r) => r.details_ref.reason)).toEqual([reason]);
  };
  // A task parked on its plan review, owned by a fresh contributor.
  const parkedTask = async (): Promise<{ taskId: string; owner: SystemUser; revision: number }> => {
    const who = await h.user([{ role: 'contributor', scope: [h.applicationId] }]);
    const taskId = await createTask(h, who);
    await pendingDecision(h, who, taskId);
    // The decision row can exist before the task's own projection (status and revision) lands; read the revision only once it has.
    const parked = await waitStatus(h, who, taskId, ['waiting_decision']);
    return { taskId, owner: who, revision: parked.revision };
  };
  const unchanged = async (taskId: string, revision: number) => {
    const t = await getTask(h, viewer, taskId);
    expect([t.status, t.revision]).toEqual(['waiting_decision', revision]);
  };
  const cleanup = async (taskId: string) => {
    const operator = await h.user([{ role: 'operator', scope: [h.applicationId] }]);
    await command(h, operator, taskId, 'cancel');
    await pump(h, async () => ((await getTask(h, viewer, taskId)).status === 'cancelled' ? true : undefined));
  };

  for (const kind of ['pause', 'cancel'] as const) {
    it(`a ${kind} accepted at ingress is refused when the owner lost all access before it was applied`, async () => {
      const { taskId, owner: who, revision } = await parkedTask();
      const r = await command(h, who, taskId, kind);
      expect(r.status).toBe(202); // authorized at ingress; not delivered yet (no dispatch pass ran)
      await revokeAll(who.principalId);
      await expectRefused(r.commandId, 'no_current_access');
      await unchanged(taskId, revision);
      await cleanup(taskId);
    });
  }

  it('a resume accepted at ingress is refused after the owner lost access', async () => {
    const { taskId, owner: who } = await parkedTask();
    const paused = await command(h, who, taskId, 'pause');
    expect((await commandRow(paused.commandId)).state).toBe('applied');
    const revision = (await waitStatus(h, viewer, taskId, ['paused'])).revision; // applied is not yet projected (P-25)
    const r = await command(h, who, taskId, 'resume');
    expect(r.status).toBe(202);
    await revokeAll(who.principalId);
    await expectRefused(r.commandId, 'no_current_access');
    const t = await getTask(h, viewer, taskId);
    expect([t.status, t.revision]).toEqual(['paused', revision]);
    await cleanup(taskId);
  });

  it('a cancel by an operator who is demoted to viewer before it is applied is refused as not a task controller', async () => {
    const { taskId, revision } = await parkedTask();
    const operator = await h.user([{ role: 'operator', scope: [h.applicationId] }]);
    const r = await command(h, operator, taskId, 'cancel');
    expect(r.status).toBe(202);
    await h.tx(async (t) => {
      await t.query("UPDATE factory.membership SET revoked_at = now() WHERE principal_id = $1 AND role = 'operator'", [operator.principalId]);
      await t.query("INSERT INTO factory.membership (org_id, id, principal_id, role, application_scope) VALUES ($1,$2,$3,'viewer',$4)", [h.orgId, randomUUID(), operator.principalId, JSON.stringify([h.applicationId])]);
    });
    await expectRefused(r.commandId, 'not_task_controller');
    await unchanged(taskId, revision);
    await cleanup(taskId);
  });

  it('an amend_spec accepted at ingress is refused when its author lost access, and the plan stays as it was', async () => {
    const { taskId, owner: who, revision } = await parkedTask();
    const object = await h.artifacts.putControllerObject(h.orgId, Buffer.from(canonicalJson({ ...investigation(h.applicationId), title: 'Amended after revocation' })));
    const specRef = await h.tx((t) => h.artifacts.registerControllerArtifact(t, { orgId: h.orgId, taskId, producerId: `principal:${who.principalId}`, object, mediaType: 'application/json', schemaVersion: '2.0', classification: 'ordinary', purpose: 'amended_spec' }));
    const r = await command(h, who, taskId, 'amend_spec', { specRef });
    expect(r.status).toBe(202);
    await revokeAll(who.principalId);
    await expectRefused(r.commandId, 'no_current_access');
    await unchanged(taskId, revision);
    expect((await getTask(h, viewer, taskId)).planVersion).toBe(1);
    await cleanup(taskId);
  });

  it('a command from a principal who still has authority is applied as before', async () => {
    const { taskId, owner: who } = await parkedTask();
    const r = await command(h, who, taskId, 'pause');
    expect(r.status).toBe(202);
    expect(await commandRow(r.commandId)).toMatchObject({ state: 'applied', rejection_reason: null });
    expect((await waitStatus(h, viewer, taskId, ['paused'])).status).toBe('paused');
    await cleanup(taskId);
  });

  it('a budget raise accepted at ingress is refused when its issuer stopped being a budget owner before it was applied; lowering stays a controller power', async () => {
    const who = await h.user([{ role: 'contributor', scope: [h.applicationId] }, { role: 'application_owner', scope: [h.applicationId] }]);
    const taskId = await createTask(h, who);
    await pendingDecision(h, who, taskId);
    const revision = (await waitStatus(h, who, taskId, ['waiting_decision'])).revision;
    const budget = (maxMicroUsd: number) => ({ budget: { ...investigation(h.applicationId).budget, maxMicroUsd } });
    const raise = await command(h, who, taskId, 'change_budget', budget(90_000_000));
    expect(raise.status).toBe(202); // an application owner may raise
    await h.tx((t) => t.query("UPDATE factory.membership SET revoked_at = now() WHERE principal_id = $1 AND role = 'application_owner'", [who.principalId]));
    await expectRefused(raise.commandId, 'budget_increase_not_authorized');
    await unchanged(taskId, revision);
    // Still the task's owner with a contributor role, the same principal may still lower the budget...
    const lower = await command(h, who, taskId, 'change_budget', budget(10_000_000));
    expect(lower.status).toBe(202);
    expect(await commandRow(lower.commandId)).toMatchObject({ state: 'applied' });
    await pump(h, async () => ((await getTask(h, who, taskId)).revision > revision ? true : undefined)); // the applied change is projected
    // ...and loses that too when all access is gone before a further lowering is applied.
    const again = await command(h, who, taskId, 'change_budget', budget(5_000_000));
    expect(again.status).toBe(202);
    await revokeAll(who.principalId);
    await expectRefused(again.commandId, 'no_current_access');
    await cleanup(taskId);
  });

  it('a controller cannot undo an operator\'s budget cut while a stage is in flight: a raise is judged against the pending limit', async () => {
    const ctrl = await h.user([{ role: 'contributor', scope: [h.applicationId] }]); // the task owner: controls it, may only lower
    const boss = await h.user([{ role: 'operator', scope: [h.applicationId] }]);
    const taskId = await createTask(h, ctrl);
    const d = await pendingDecision(h, ctrl, taskId);
    const peer = reviewers.find((r) => r.principalId === d.requiredPrincipalId);
    if (!peer) throw new Error('the required peer is not one of the test reviewers');
    expect((await respond(h, peer, taskId, d)).status).toBe(202);
    await pump(h, async () => ((await getTask(h, boss, taskId)).currentNodeId === 'investigate' ? true : undefined)); // the stage is in flight and projected
    const budget = (maxMicroUsd: number) => ({ budget: { ...investigation(h.applicationId).budget, maxMicroUsd } });
    const original = investigation(h.applicationId).budget.maxMicroUsd;
    const projected = async (above: number) => pump(h, async () => { const t = await getTask(h, boss, taskId); return t.revision > above ? t.revision : undefined; });
    const start = (await getTask(h, boss, taskId)).revision;
    const cut = await command(h, boss, taskId, 'change_budget', budget(5_000_000));
    expect(cut.status).toBe(202);
    expect(await commandRow(cut.commandId)).toMatchObject({ state: 'applied' });
    const afterCut = await projected(start);
    // The cut is applied but the stage is still running, so the account still shows the old limit.
    const undo = await command(h, ctrl, taskId, 'change_budget', budget(original));
    expect(undo.status).toBe(202); // not a raise as far as the stored limit goes
    await expectRefused(undo.commandId, 'budget_increase_not_authorized');
    expect((await getTask(h, boss, taskId)).revision).toBe(afterCut);
    // Lowering again is still a controller power.
    const lower = await command(h, ctrl, taskId, 'change_budget', budget(3_000_000));
    expect(lower.status).toBe(202);
    expect(await commandRow(lower.commandId)).toMatchObject({ state: 'applied' });
    latch.release();
    await cleanup(taskId);
  });

  it('a demoted reviewer gets 403 at ingress; a reviewer demoted between ingress and application is refused and the decision stays pending', async () => {
    const author = await h.user([{ role: 'contributor', scope: [h.applicationId] }]);
    const demote = async (u: SystemUser) => {
      await revokeAll(u.principalId);
      await h.tx((t) => t.query("INSERT INTO factory.membership (org_id, id, principal_id, role, application_scope) VALUES ($1,$2,$3,'viewer',$4)", [h.orgId, randomUUID(), u.principalId, JSON.stringify([h.applicationId])]));
    };
    const peerOf = (d: { requiredPrincipalId?: string }): SystemUser => {
      const u = reviewers.find((r) => r.principalId === d.requiredPrincipalId);
      if (!u) throw new Error('the required peer is not one of the test reviewers');
      return u;
    };
    const taskA = await createTask(h, author);
    const dA = await pendingDecision(h, author, taskA);
    await demote(peerOf(dA));
    expect((await respond(h, peerOf(dA), taskA, dA)).status).toBe(403); // can still see the task, no longer a reviewer
    await cleanup(taskA);
    const taskB = await createTask(h, author);
    const dB = await pendingDecision(h, author, taskB);
    const peer = peerOf(dB);
    expect(peer.principalId).not.toBe(peerOf(dA).principalId);
    const r = await respond(h, peer, taskB, dB);
    expect(r.status).toBe(202); // accepted while a reviewer; not delivered yet
    await demote(peer);
    const commandId = (await h.tx((t) => t.query<{ id: string }>("SELECT id FROM factory.command WHERE task_id = $1 AND kind = 'respond_decision'", [taskB]))).rows[0]?.id ?? '';
    await expectRefused(commandId, 'reviewer_authority_required');
    expect(((await h.call(viewer, 'GET', `/v2/decisions/${dB.id}`)).body as { state: string }).state).toBe('pending');
    expect((await getTask(h, viewer, taskB)).status).toBe('waiting_decision');
    await cleanup(taskB);
  });

  // The default application lists the group team:commerce in owner_ids; a token that asserts the
  // group makes its holder an application owner without any membership row.
  const groupOnly = async (): Promise<SystemUser> => {
    reviewers.push(await h.user([{ role: 'reviewer', scope: [h.applicationId] }])); // the demotion test removed the earlier reviewers
    const u = await h.user([], 'Group member');
    return { ...u, token: () => h.issuer.mint({ sub: u.subject, aud: 'software-factory-api', groups: ['team:commerce'] }) };
  };
  const setOwners = (ids: string[]) => h.tx((t) => t.query('UPDATE factory.application SET owner_ids = $2 WHERE id = $1', [h.applicationId, JSON.stringify(ids)]));

  it('an owner whose only authority is a group in owner_ids can pause, resume and cancel', async () => {
    const member = await groupOnly();
    const taskId = await createTask(h, member);
    await waitStatus(h, member, taskId, ['waiting_decision']);
    // Each command waits for the projection of the one before it, so the next sees the status it expects (P-25).
    const projectedAs: Record<string, string> = { pause: 'paused', resume: 'waiting_decision', cancel: 'cancelled' };
    for (const kind of ['pause', 'resume', 'cancel']) {
      const r = await command(h, member, taskId, kind);
      expect(r.status, kind).toBe(202);
      expect(await commandRow(r.commandId), kind).toMatchObject({ state: 'applied', rejection_reason: null });
      await waitStatus(h, member, taskId, [projectedAs[kind] ?? '']);
    }
    expect((await waitStatus(h, member, taskId, ['cancelled'])).status).toBe('cancelled');
  });

  it('a command from a group-only owner is refused when the group stops being listed before it is applied', async () => {
    const member = await groupOnly();
    const taskId = await createTask(h, member);
    await pendingDecision(h, member, taskId);
    const revision = (await waitStatus(h, member, taskId, ['waiting_decision'])).revision;
    const r = await command(h, member, taskId, 'pause');
    expect(r.status).toBe(202);
    await setOwners([]);
    try {
      await expectRefused(r.commandId, 'no_current_access');
    } finally {
      await setOwners(['team:commerce']);
    }
    await unchanged(taskId, revision);
    await cleanup(taskId);
  });
});
