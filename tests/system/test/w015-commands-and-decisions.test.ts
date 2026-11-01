import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { canonicalJson } from '@factory/domain';
import { createSystemHarness, type SystemHarness, type SystemUser } from '../src/index.ts';
import { command, commandState, createTask, getTask, investigation, pendingDecision, pump, respond, waitStatus } from './support.ts';

describe('W-015 command and decision workflow (full stack)', () => {
  let h: SystemHarness;
  let owner: SystemUser;
  let reviewer: SystemUser;
  let outsider: SystemUser;
  beforeAll(async () => {
    h = await createSystemHarness('w015', { temporal: { fakeStage: { delayMs: (n) => (n === 'investigate' ? 1500 : 0) } } });
    owner = await h.user([{ role: 'contributor', scope: [h.applicationId] }, { role: 'reviewer', scope: [h.applicationId] }]);
    reviewer = await h.user([{ role: 'reviewer', scope: [h.applicationId] }]);
    outsider = await h.user([{ role: 'contributor', scope: [h.applicationId] }]);
  }, 300_000);
  afterAll(async () => { await h.close(); });

  const gateRows = (taskId: string) => h.tx(async (t) => (await t.query<{ gate_id: string; verdict: string; reason_codes: string[]; resolved_mode: string | null }>('SELECT gate_id, verdict, reason_codes, resolved_mode FROM factory.gate_evaluation WHERE task_id = $1 ORDER BY created_at', [taskId])).rows);

  it('the plan waits for an independent peer: the creator is never asked, and only an exact full-scope approval passes plan_peer_approved', async () => {
    const taskId = await createTask(h, owner);
    const d = await pendingDecision(h, owner, taskId);
    expect(d).toMatchObject({ action: 'approve_plan', state: 'pending', requiredPrincipalId: reviewer.principalId, eligibleRoles: ['reviewer'] });
    expect((await waitStatus(h, owner, taskId, ['waiting_decision'])).waitingReason).toBe('plan_review');
    expect((await respond(h, owner, taskId, d)).status).toBe(403); // the creator is not the assigned peer
    expect((await respond(h, outsider, taskId, d)).status).toBe(403);
    expect((await respond(h, reviewer, taskId, d, { subjectHash: 'f'.repeat(64) })).status).toBe(409); // stale subject
    const partial = await respond(h, reviewer, taskId, d, { reviewedSectionIds: ['design'] });
    expect(partial.status).toBe(202);
    expect(await commandState(h, reviewer, (partial.body as { commandId: string }).commandId)).toMatchObject({ state: 'rejected', reason: 'reviewed_scope_incomplete' });
    const ok = await respond(h, reviewer, taskId, d);
    expect(await commandState(h, reviewer, (ok.body as { commandId: string }).commandId)).toMatchObject({ state: 'applied' });
    const done = await waitStatus(h, owner, taskId, ['succeeded', 'failed', 'incomplete']);
    expect(done.status).toBe('succeeded');
    expect((await gateRows(taskId)).find((g) => g.gate_id === 'plan_peer_approved')).toMatchObject({ verdict: 'passed', resolved_mode: 'human', reason_codes: ['exact_subject_peer_approval'] });
    const decision = await h.tx(async (t) => (await t.query<{ decider_id: string; outcome: string; reviewed_section_ids: string[] }>('SELECT decider_id, outcome, reviewed_section_ids FROM factory.decision WHERE request_id = $1', [d.id])).rows[0]);
    expect(decision).toMatchObject({ decider_id: reviewer.principalId, outcome: 'approve' });
    expect(decision?.reviewed_section_ids).toHaveLength(12);
  });

  it('approve_plan responses are refused on the generic command endpoint', async () => {
    const taskId = await createTask(h, owner);
    const d = await pendingDecision(h, owner, taskId);
    const r = await command(h, reviewer, taskId, 'respond_decision', { decisionId: d.id, decisionOutcome: 'approve', subjectHash: d.subjectHash });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ code: 'decision_requires_response_endpoint' });
    await command(h, owner, taskId, 'cancel');
    await waitStatus(h, owner, taskId, ['cancelled']);
  });

  describe('AC-07 workflow command race (approval half)', () => {
    it('a new spec revision supersedes the pending approval: the old subject is rejected and the new plan needs its own approval', async () => {
      const taskId = await createTask(h, owner);
      const first = await pendingDecision(h, owner, taskId);
      const spec2 = investigation(h.applicationId, { title: 'Revised: is the inventory retry the cause?' });
      const object = await h.artifacts.putControllerObject(h.orgId, Buffer.from(canonicalJson(spec2)));
      const specRef = await h.tx((t) => h.artifacts.registerControllerArtifact(t, { orgId: h.orgId, taskId, producerId: `principal:${owner.principalId}`, object, mediaType: 'application/json', schemaVersion: '2.0', classification: 'ordinary', purpose: 'amended_spec' }));
      // The amendment and a racing approval of the old subject are both submitted.
      const amend = await command(h, owner, taskId, 'amend_spec', { specRef });
      expect(amend.status).toBe(202);
      expect(await commandState(h, owner, amend.commandId)).toMatchObject({ state: 'applied' });
      const second = await pendingDecision(h, owner, taskId, first.id);
      expect(second.subjectHash).not.toBe(first.subjectHash);
      expect((await h.call(owner, 'GET', `/v2/decisions/${first.id}`)).body).toMatchObject({ state: 'superseded' });
      // The stale approval is refused at ingress, and also by the workflow if delivered directly.
      expect((await respond(h, reviewer, taskId, first)).status).toBe(409);
      const direct = await h.temporal?.env.client.workflow.getHandle(`factory/${h.orgId}/${taskId}`).executeUpdate('applyCommand', { args: [{ workflowId: '', commandId: randomUUID(), kind: 'respond_decision', expectedRevision: (await getTask(h, owner, taskId)).revision, decisionId: second.id, subjectHash: first.subjectHash, outcome: 'approve', reviewedSectionIds: [], deciderPrincipalId: reviewer.principalId, channel: 'decision_response_endpoint' }] });
      expect(direct).toMatchObject({ state: 'rejected', reason: 'stale_subject: response names a different subject' });
      const ok = await respond(h, reviewer, taskId, second);
      expect(await commandState(h, reviewer, (ok.body as { commandId: string }).commandId)).toMatchObject({ state: 'applied' });
      const done = await waitStatus(h, owner, taskId, ['succeeded', 'failed', 'incomplete']);
      expect(done).toMatchObject({ status: 'succeeded', planVersion: 2 });
      expect((await gateRows(taskId)).filter((g) => g.gate_id === 'plan_peer_approved').map((g) => g.verdict)).toEqual(['passed']);
    });
  });

  it('pause stops new stages at the next safe point and resume continues; cancel stops the in-flight stage', async () => {
    const taskId = await createTask(h, owner);
    const d = await pendingDecision(h, owner, taskId);
    await respond(h, reviewer, taskId, d);
    await pump(h, async () => ((await getTask(h, owner, taskId)).currentNodeId === 'investigate' ? true : undefined));
    const pause = await command(h, owner, taskId, 'pause');
    expect(await commandState(h, owner, pause.commandId)).toMatchObject({ state: 'applied' });
    await waitStatus(h, owner, taskId, ['paused']);
    const runsAtPause = ((await h.call(owner, 'GET', `/v2/tasks/${taskId}/runs`)).body as { items: unknown[] }).items.length;
    await new Promise((r) => setTimeout(r, 1800));
    expect(((await h.call(owner, 'GET', `/v2/tasks/${taskId}/runs`)).body as { items: unknown[] }).items.length).toBe(runsAtPause); // nothing new scheduled while paused
    expect((await command(h, outsider, taskId, 'resume')).status).toBe(403);
    const resume = await command(h, owner, taskId, 'resume');
    expect(await commandState(h, owner, resume.commandId)).toMatchObject({ state: 'applied' });
    expect((await waitStatus(h, owner, taskId, ['succeeded'])).status).toBe('succeeded');
  });

  it('cancel during an in-flight stage ends cancelled with the actual results; a repeat cancel is idempotent and terminal tasks do not reopen', async () => {
    const taskId = await createTask(h, owner);
    const d = await pendingDecision(h, owner, taskId);
    await respond(h, reviewer, taskId, d);
    await pump(h, async () => ((await getTask(h, owner, taskId)).currentNodeId === 'investigate' ? true : undefined));
    const cancel = await command(h, owner, taskId, 'cancel');
    expect(await commandState(h, owner, cancel.commandId)).toMatchObject({ state: 'applied' });
    const done = await waitStatus(h, owner, taskId, ['cancelled']);
    expect(done.status).toBe('cancelled');
    const runs = ((await h.call(owner, 'GET', `/v2/tasks/${taskId}/runs`)).body as { items: Array<{ nodeId: string; status: string }> }).items;
    expect(runs.find((r) => r.nodeId === 'investigate')?.status).toBe('inconclusive');
    expect(runs.some((r) => r.nodeId === 'evidence_review')).toBe(false);
    const again = await command(h, owner, taskId, 'cancel');
    expect(again.status).toBe(409); // terminal tasks do not reopen
    expect(again.body).toMatchObject({ code: 'task_terminal' });
  });

  it('change_budget lowering below actual charges cannot erase them; the next admission is refused and the task is incomplete', async () => {
    const taskId = await createTask(h, owner);
    const d = await pendingDecision(h, owner, taskId);
    const lower = await command(h, owner, taskId, 'change_budget', { budget: { ...investigation(h.applicationId).budget, maxMicroUsd: 0 } });
    expect(await commandState(h, owner, lower.commandId)).toMatchObject({ state: 'applied' });
    await pump(h, async () => ((await getTask(h, owner, taskId)).revision >= 2 ? true : undefined)); // projected while waiting
    await respond(h, reviewer, taskId, d);
    const done = await waitStatus(h, owner, taskId, ['incomplete', 'succeeded', 'failed']);
    expect(done).toMatchObject({ status: 'incomplete', waitingReason: 'budget_exhausted' });
    const account = await h.tx(async (t) => (await t.query<{ limit_micro_usd: string; charged_micro_usd: string }>('SELECT limit_micro_usd, charged_micro_usd FROM factory.budget_account WHERE task_id = $1', [taskId])).rows[0]);
    expect(account?.limit_micro_usd).toBe(account?.charged_micro_usd);
    expect(Number(account?.charged_micro_usd)).toBeGreaterThan(0);
  });

  it('commands are deduplicated by commandId, stale If-Match is 412, and only owners or operators control a task', async () => {
    const taskId = await createTask(h, owner);
    await pendingDecision(h, owner, taskId);
    const t = await getTask(h, owner, taskId);
    const body = { commandId: randomUUID(), expectedRevision: t.revision, kind: 'pause', reason: 'dedupe' };
    const headers = { 'idempotency-key': randomUUID(), 'if-match': String(t.revision) };
    const a = await h.call(owner, 'POST', `/v2/tasks/${taskId}/commands`, body, headers);
    const b = await h.call(owner, 'POST', `/v2/tasks/${taskId}/commands`, body, headers);
    expect([a.status, b.status]).toEqual([202, 202]);
    expect(b.body).toEqual(a.body);
    expect((await h.call(owner, 'POST', `/v2/tasks/${taskId}/commands`, { ...body, reason: 'different' }, headers)).status).toBe(409);
    expect((await h.call(owner, 'POST', `/v2/tasks/${taskId}/commands`, { ...body, commandId: randomUUID(), expectedRevision: t.revision + 5 }, { 'idempotency-key': randomUUID(), 'if-match': String(t.revision + 5) })).status).toBe(412);
    expect((await command(h, outsider, taskId, 'cancel')).status).toBe(403);
    const outboxRows = await h.tx(async (tx) => (await tx.query("SELECT 1 FROM factory.outbox WHERE dedupe_key = $1", [`command:${body.commandId}`])).rowCount);
    expect(outboxRows).toBe(1);
    expect(await commandState(h, owner, body.commandId)).toMatchObject({ state: 'applied' });
    await pump(h, async () => ((await getTask(h, owner, taskId)).revision > t.revision ? true : undefined)); // the pause is projected
    await command(h, owner, taskId, 'cancel');
    await waitStatus(h, owner, taskId, ['cancelled']);
  });
});

describe('AC-44 stale approval (decision expiry and authority at application time)', () => {
  let h: SystemHarness;
  let owner: SystemUser;
  let reviewer: SystemUser;
  beforeAll(async () => {
    h = await createSystemHarness('ac44sys', { temporal: { decisionTtlMs: 2500 } });
    owner = await h.user([{ role: 'contributor', scope: [h.applicationId] }]);
    reviewer = await h.user([{ role: 'reviewer', scope: [h.applicationId] }]);
  }, 300_000);
  afterAll(async () => { await h.close(); });

  it('an unanswered decision expires: the task is incomplete, never approved, and a late response is refused', async () => {
    const taskId = await createTask(h, owner);
    const d = await pendingDecision(h, owner, taskId);
    const done = await waitStatus(h, owner, taskId, ['incomplete', 'succeeded']);
    expect(done).toMatchObject({ status: 'incomplete', waitingReason: 'decision_expired' });
    expect((await h.call(owner, 'GET', `/v2/decisions/${d.id}`)).body).toMatchObject({ state: 'expired' });
    expect((await respond(h, reviewer, taskId, d)).status).toBe(409);
  });

  it('an approval accepted at ingress but applied after the reviewer lost authority does not pass the gate', async () => {
    const taskId = await createTask(h, owner);
    const d = await pendingDecision(h, owner, taskId);
    const r = await respond(h, reviewer, taskId, d);
    expect(r.status).toBe(202); // accepted while authorized; not yet delivered (no dispatch pass ran)
    await h.tx((t) => t.query("UPDATE factory.membership SET revoked_at = now() WHERE principal_id = $1 AND role = 'reviewer'", [reviewer.principalId]));
    const done = await waitStatus(h, owner, taskId, ['incomplete', 'succeeded']);
    expect(done.status).toBe('incomplete');
    const gate = await h.tx(async (t) => (await t.query<{ verdict: string; reason_codes: string[] }>("SELECT verdict, reason_codes FROM factory.gate_evaluation WHERE task_id = $1 AND gate_id = 'plan_peer_approved'", [taskId])).rows[0]);
    expect(gate).toEqual({ verdict: 'failed', reason_codes: ['decider_authority_revoked'] });
  });
});
