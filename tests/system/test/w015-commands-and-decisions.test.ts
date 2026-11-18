import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { canonicalJson } from '@factory/domain';
import { createSystemHarness, type SystemHarness, type SystemUser } from '../src/index.ts';
import { ALL_SECTIONS, command, commandState, createTask, getTask, investigation, pendingDecision, pump, respond, waitStatus } from './support.ts';

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
      // Delivered directly, the command still needs the command row the API would have recorded for it.
      const directId = randomUUID();
      await h.tx((t) => t.query("INSERT INTO factory.command (org_id, id, task_id, principal_id, expected_revision, kind, request_hash, payload, state) VALUES ($1,$2,$3,$4,1,'respond_decision',$5,'{}','delivered')", [h.orgId, directId, taskId, reviewer.principalId, 'a'.repeat(64)]));
      const direct = await h.temporal?.env.client.workflow.getHandle(`factory/${h.orgId}/${taskId}`).executeUpdate('applyCommand', { args: [{ workflowId: '', commandId: directId, kind: 'respond_decision', expectedRevision: (await getTask(h, owner, taskId)).revision, decisionId: second.id, subjectHash: first.subjectHash, outcome: 'approve', reviewedSectionIds: [], deciderPrincipalId: reviewer.principalId, channel: 'decision_response_endpoint' }] });
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
    // The cancelled stage's spend is recorded and every reservation released (scope, plan and the
    // interrupted investigation at 1 USD each; the plan review is controller work at zero).
    const account = await h.tx(async (t) => (await t.query<{ charged_micro_usd: string; reserved_micro_usd: string }>('SELECT charged_micro_usd, reserved_micro_usd FROM factory.budget_account WHERE task_id = $1', [taskId])).rows[0]);
    expect(account).toEqual({ charged_micro_usd: '3000000', reserved_micro_usd: '0' });
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
    // A retry after the command applied (the revision has moved on) reconciles by commandId: the
    // original receipt, not 412.
    const retried = await h.call(owner, 'POST', `/v2/tasks/${taskId}/commands`, body, headers);
    expect(retried).toMatchObject({ status: 202, body: { commandId: body.commandId, state: 'applied' } });
    const cancel = await command(h, owner, taskId, 'cancel');
    await waitStatus(h, owner, taskId, ['cancelled']);
    // ...and after the task closed, the same cancel still gets its receipt, not 409 task_terminal.
    const c = await h.tx(async (tx) => (await tx.query<{ expected_revision: string; payload: { reason: string } }>('SELECT expected_revision, payload FROM factory.command WHERE id = $1', [cancel.commandId])).rows[0]);
    const cancelBody = { commandId: cancel.commandId, expectedRevision: Number(c?.expected_revision), kind: 'cancel', reason: c?.payload.reason };
    const late = await h.call(owner, 'POST', `/v2/tasks/${taskId}/commands`, cancelBody, { 'idempotency-key': randomUUID(), 'if-match': String(c?.expected_revision) });
    expect(late).toMatchObject({ status: 202, body: { commandId: cancel.commandId, state: 'applied' } });
    // A different principal cannot claim someone else's commandId.
    const operator = await h.user([{ role: 'operator', scope: [h.applicationId] }]);
    expect((await h.call(operator, 'POST', `/v2/tasks/${taskId}/commands`, cancelBody, { 'idempotency-key': randomUUID(), 'if-match': String(c?.expected_revision) })).status).toBe(409);
  });

  it('a retried decision response after it applied returns the original receipt', async () => {
    const taskId = await createTask(h, owner);
    const d = await pendingDecision(h, owner, taskId);
    const t = await getTask(h, owner, taskId);
    const body = { commandId: randomUUID(), expectedRevision: t.revision, subjectHash: d.subjectHash, outcome: 'approve', reason: 'Plan reviewed in full.', reviewedSectionIds: ALL_SECTIONS };
    const first = await h.call(reviewer, 'POST', `/v2/decisions/${d.id}/responses`, body, { 'idempotency-key': randomUUID() });
    expect(first.status).toBe(202);
    expect(await commandState(h, reviewer, body.commandId)).toMatchObject({ state: 'applied' });
    await pump(h, async () => ((await h.call(owner, 'GET', `/v2/decisions/${d.id}`)).body as { state: string }).state === 'approved' ? true : undefined);
    const retry = await h.call(reviewer, 'POST', `/v2/decisions/${d.id}/responses`, body, { 'idempotency-key': randomUUID() });
    expect(retry).toMatchObject({ status: 202, body: { commandId: body.commandId, state: 'applied' } });
    await waitStatus(h, owner, taskId, ['succeeded']);
  });

  it('raising a budget needs the application owner or an operator; a task controller may only lower it', async () => {
    const taskId = await createTask(h, owner);
    await pendingDecision(h, owner, taskId);
    const budget = investigation(h.applicationId).budget;
    const raise = await command(h, owner, taskId, 'change_budget', { budget: { ...budget, maxMicroUsd: budget.maxMicroUsd * 4 } });
    expect(raise).toMatchObject({ status: 403, body: { code: 'budget_increase_not_authorized' } });
    const operator = await h.user([{ role: 'operator', scope: [h.applicationId] }]);
    const byOperator = await command(h, operator, taskId, 'change_budget', { budget: { ...budget, maxMicroUsd: budget.maxMicroUsd * 2 } });
    expect(byOperator.status).toBe(202);
    // Each command is sent only after the previous one's revision has been projected.
    const settled = async (user: SystemUser, commandId: string) => {
      const receipt = await commandState(h, user, commandId) as { state: string; resultingRevision?: number };
      expect(receipt.state).toBe('applied');
      await pump(h, async () => ((await getTask(h, owner, taskId)).revision >= (receipt.resultingRevision ?? Infinity) ? true : undefined));
    };
    await settled(operator, byOperator.commandId);
    await pump(h, async () => ((await h.tx(async (tx) => (await tx.query<{ limit_micro_usd: string }>('SELECT limit_micro_usd FROM factory.budget_account WHERE task_id = $1', [taskId])).rows[0]?.limit_micro_usd)) === String(budget.maxMicroUsd * 2) ? true : undefined));
    const lower = await command(h, owner, taskId, 'change_budget', { budget: { ...budget, maxMicroUsd: budget.maxMicroUsd } });
    expect(lower.status).toBe(202);
    await settled(owner, lower.commandId);
    expect(await h.tx(async (tx) => (await tx.query<{ limit_micro_usd: string }>('SELECT limit_micro_usd FROM factory.budget_account WHERE task_id = $1', [taskId])).rows[0]?.limit_micro_usd)).toBe(String(budget.maxMicroUsd));
    await command(h, owner, taskId, 'cancel');
    await waitStatus(h, owner, taskId, ['cancelled']);
  });

  it('an amended spec is admitted like a new request and cannot change scope, priority or budget', async () => {
    const taskId = await createTask(h, owner);
    await pendingDecision(h, owner, taskId);
    const other = await createTask(h, owner);
    const stage = async (spec: unknown, onTask = taskId) => {
      const object = await h.artifacts.putControllerObject(h.orgId, Buffer.from(canonicalJson(spec)));
      return h.tx((t) => h.artifacts.registerControllerArtifact(t, { orgId: h.orgId, taskId: onTask, producerId: `principal:${owner.principalId}`, object, mediaType: 'application/json', schemaVersion: '2.0', classification: 'ordinary', purpose: 'amended_spec' }));
    };
    const foreignApp = randomUUID();
    await h.tx((t) => t.query("INSERT INTO factory.application (org_id, id, app_key, name, owner_ids, lifecycle) VALUES ($1,$2,'billing','Billing','[]','production')", [h.orgId, foreignApp]));
    const base = investigation(h.applicationId);
    const cases: Array<[unknown, number, string, string?]> = [
      [{ ...base, applicationIds: [h.applicationId, foreignApp] }, 403, 'application_not_authorized'],
      [{ ...base, priorityClass: 'background' }, 422, 'priority_change_not_supported'],
      [{ ...base, budget: { ...base.budget, maxMicroUsd: base.budget.maxMicroUsd * 10 } }, 422, 'budget_change_requires_change_budget'],
      [{ ...base, security: { classification: 'vulnerability' } }, 422, 'invalid_spec'],
      [{ ...base, title: 'Linked to another task' }, 422, 'invalid_spec', other],
    ];
    for (const [spec, status, code, onTask] of cases) {
      const r = await command(h, owner, taskId, 'amend_spec', { specRef: await stage(spec, onTask) });
      expect([r.status, (r.body as { code: string }).code], JSON.stringify(spec).slice(0, 80)).toEqual([status, code]);
    }
    for (const id of [taskId, other]) { await command(h, owner, id, 'cancel'); await waitStatus(h, owner, id, ['cancelled']); }
  });

  it('a command applied while a stage is running projects its revision at once, so the next command is not held until the stage ends; the amendment stays attributed to its author', async () => {
    const taskId = await createTask(h, owner);
    await respond(h, reviewer, taskId, await pendingDecision(h, owner, taskId));
    await pump(h, async () => ((await getTask(h, owner, taskId)).currentNodeId === 'investigate' ? true : undefined));
    const before = await getTask(h, owner, taskId);
    const spec2 = investigation(h.applicationId, { title: 'Revised while investigating' });
    const object = await h.artifacts.putControllerObject(h.orgId, Buffer.from(canonicalJson(spec2)));
    const specRef = await h.tx((t) => h.artifacts.registerControllerArtifact(t, { orgId: h.orgId, taskId, producerId: `principal:${owner.principalId}`, object, mediaType: 'application/json', schemaVersion: '2.0', classification: 'ordinary', purpose: 'amended_spec' }));
    const amend = await command(h, owner, taskId, 'amend_spec', { specRef });
    expect(await commandState(h, owner, amend.commandId)).toMatchObject({ state: 'applied', resultingRevision: before.revision + 1 });
    // The receipt arrives only after the projection: the task already shows the new revision while
    // the investigation is still the running stage and plan 1 is still current.
    const during = await getTask(h, owner, taskId);
    expect(during).toMatchObject({ revision: before.revision + 1, currentNodeId: 'investigate', planVersion: 1 });
    const runs = ((await h.call(owner, 'GET', `/v2/tasks/${taskId}/runs`)).body as { items: Array<{ nodeId: string; status: string }> }).items;
    expect(runs.find((r) => r.nodeId === 'investigate')?.status).toBe('running');
    // A second principal's command is therefore accepted and applied mid-stage.
    const operator = await h.user([{ role: 'operator', scope: [h.applicationId] }]);
    const pause = await command(h, operator, taskId, 'pause');
    expect(pause.status).toBe(202);
    expect(await commandState(h, operator, pause.commandId)).toMatchObject({ state: 'applied', resultingRevision: before.revision + 2 });
    expect((await waitStatus(h, owner, taskId, ['paused'])).revision).toBe(before.revision + 2);
    const resume = await command(h, operator, taskId, 'resume');
    expect(await commandState(h, operator, resume.commandId)).toMatchObject({ state: 'applied' });
    // The operator's commands are the latest receipts, yet spec v2 belongs to the amender.
    const v2 = await pump(h, async () => (await h.tx(async (t) => (await t.query<{ actor_id: string }>('SELECT actor_id FROM factory.task_spec_version WHERE task_id = $1 AND version = 2', [taskId])).rows[0])));
    expect(v2.actor_id).toBe(owner.principalId);
    expect((await waitStatus(h, owner, taskId, ['waiting_decision'])).planVersion).toBe(2);
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

  it('an approval accepted at ingress but applied after the reviewer lost authority is refused and leaves the decision pending (P-18)', async () => {
    const taskId = await createTask(h, owner);
    const d = await pendingDecision(h, owner, taskId);
    const r = await respond(h, reviewer, taskId, d);
    expect(r.status).toBe(202); // accepted while authorized; not yet delivered (no dispatch pass ran)
    await h.tx((t) => t.query("UPDATE factory.membership SET revoked_at = now() WHERE principal_id = $1 AND role = 'reviewer'", [reviewer.principalId]));
    const commandId = (r.body as { commandId: string }).commandId;
    const row = await pump(h, async () => { const c = (await h.tx((t) => t.query<{ state: string; rejection_reason: string | null }>('SELECT state, rejection_reason FROM factory.command WHERE id = $1', [commandId]))).rows[0]; return c && c.state !== 'queued' && c.state !== 'delivered' ? c : undefined; });
    expect(row).toEqual({ state: 'rejected', rejection_reason: 'authority_revoked' });
    // Nothing was decided: the request is still pending and the task still waits; only the expiry ends it.
    expect(((await h.call(owner, 'GET', `/v2/decisions/${d.id}`)).body as { state: string }).state).toBe('pending');
    const done = await waitStatus(h, owner, taskId, ['incomplete', 'succeeded']);
    expect(done).toMatchObject({ status: 'incomplete', waitingReason: 'decision_expired' });
    const gate = await h.tx(async (t) => (await t.query<{ verdict: string; reason_codes: string[] }>("SELECT verdict, reason_codes FROM factory.gate_evaluation WHERE task_id = $1 AND gate_id = 'plan_peer_approved'", [taskId])).rows[0]);
    expect(gate?.verdict).toBe('failed');
    expect(gate?.reason_codes).toContain('decision_expired');
  });
});
