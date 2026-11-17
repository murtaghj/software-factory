// Dashboard design pass, direction B (docs/plan-additions.md; docs/assumptions.md A-23): where a task
// is on its plan's line. The stage descriptor and the shared station list are derived on the server
// from the task's pinned plan and current node, on the queue, on boards and on "my work", and the
// plan route says which nodes are gates. Read-only; a plan that cannot be read costs only a position.
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApiHarness, AUDIENCE, DASHBOARD_ORIGIN, type ApiHarness, type Org, type User } from './harness.ts';
import { BoardService, OidcVerifier, PLAN_MEMORY, QueueService, READ_ATTEMPTS, buildApi, forgetPlans, mergeStations, resolveStages, stageOf, stageRows, type Board, type MyWork, type Queue, type Station } from '../src/index.ts';

const node = (id: string, stageKind: string) => ({ id, stageKind, role: 'x', dependsOn: [], mandatory: true });
const INVESTIGATION = [node('scope', 'discover'), node('plan', 'plan'), node('plan_review', 'plan_peer_review'), node('investigate', 'investigate'), node('evidence_review', 'review'), node('deliver', 'deliver'), node('close', 'learn_close')];
const SHORT = [node('scope', 'discover'), node('build', 'implement'), node('plan_review', 'plan_peer_review'), node('close', 'learn_close')];
const st = (nodeId: string, gate = false): Station => ({ nodeId, label: nodeId.charAt(0).toUpperCase() + nodeId.slice(1).replaceAll('_', ' '), gate });

describe('A-23 stations and stage descriptors (pure)', () => {
  it('one shared list when every plan agrees; the order-preserving union when they differ', () => {
    const a = [st('scope'), st('plan'), st('plan_review', true), st('close')];
    expect(mergeStations([a, a])).toEqual(a);
    const b = [st('scope'), st('build'), st('plan_review', true), st('close')];
    expect(mergeStations([a, b]).map((s) => s.nodeId)).toEqual(['scope', 'build', 'plan', 'plan_review', 'close']); // build goes right after scope, the station before it in b
    expect(mergeStations([b, a]).map((s) => s.nodeId)).toEqual(['scope', 'plan', 'build', 'plan_review', 'close']);
    expect(mergeStations([[st('plan_review')], [st('plan_review', true)]])[0]?.gate).toBe(true); // a gate if any plan says so
    expect(mergeStations([])).toEqual([]);
  });

  it('a descriptor counts from 1, says whether the station is a gate, and gives a finished task the last station', () => {
    const line = [st('scope'), st('plan'), st('plan_review', true), st('close')];
    expect(stageOf(line, 'waiting_decision', 'plan_review')).toEqual({ nodeId: 'plan_review', label: 'Plan review', index: 3, count: 4, gate: true });
    expect(stageOf(line, 'running', 'scope')).toMatchObject({ index: 1, count: 4, gate: false });
    expect(stageOf(line, 'succeeded', undefined)).toMatchObject({ nodeId: 'close', index: 4 });
    expect(stageOf(line, 'running', undefined)).toBeUndefined(); // no position yet
    expect(stageOf(line, 'running', 'not_in_plan')).toBeUndefined();
  });

  it('a plan that cannot be read leaves its tasks without a stage and never throws', async () => {
    const row = { task_id: 't1', status: 'running', current_node_id: 'scope', org_id: 'o', template_id: 'broken', template_version: '1', plan_ref: {} };
    const r = await resolveStages([row, { ...row, task_id: 't2', template_id: null, template_version: null }], () => Promise.reject(new Error('artifact_unavailable')));
    expect(r.stations).toEqual([]);
    expect(r.stages.size).toBe(0);
    expect((await resolveStages([row], undefined)).stages.size).toBe(0);
  });
});

describe('A-23 reading plans (pure)', () => {
  const row = (taskId: string, template: string, over: Record<string, unknown> = {}) => ({ task_id: taskId, status: 'running', current_node_id: 'scope', org_id: 'o', template_id: template, template_version: '1', plan_ref: {}, ...over });
  const planBytes = Buffer.from(JSON.stringify({ nodes: INVESTIGATION }));

  it('one unreadable plan does not blank its template: the next task on it tries its own read', async () => {
    forgetPlans();
    let calls = 0;
    const read = (taskId: string): Promise<Buffer> => { calls += 1; return taskId === 'broken' ? Promise.reject(new Error('artifact_unavailable')) : Promise.resolve(planBytes); };
    const r = await resolveStages([row('broken', 'flaky'), row('fine', 'flaky')], read);
    expect(r.stages.has('broken')).toBe(false);
    expect(r.stages.get('fine')).toMatchObject({ nodeId: 'scope', index: 1, count: 7 });
    expect(r.stations).toHaveLength(7);
    expect(calls).toBe(2);
  });

  it('a broken template costs at most READ_ATTEMPTS reads in one request, and a corrupt plan is not remembered', async () => {
    forgetPlans();
    let calls = 0;
    const read = (): Promise<Buffer> => { calls += 1; return Promise.resolve(Buffer.from('not json')); };
    const rows = Array.from({ length: 10 }, (_, i) => row(`t${String(i)}`, 'corrupt'));
    expect((await resolveStages(rows, read)).stages.size).toBe(0);
    expect(calls).toBe(READ_ATTEMPTS);
    await resolveStages(rows, read); // the next request tries again
    expect(calls).toBe(READ_ATTEMPTS * 2);
  });

  it('the memory is a bounded LRU: past PLAN_MEMORY template versions the oldest is read again', async () => {
    forgetPlans();
    const reads: string[] = [];
    const read = (taskId: string): Promise<Buffer> => { reads.push(taskId); return Promise.resolve(planBytes); };
    for (let i = 0; i <= PLAN_MEMORY; i += 1) await resolveStages([row(`t${String(i)}`, `tpl${String(i)}`)], read);
    expect(reads).toHaveLength(PLAN_MEMORY + 1);
    await resolveStages([row('again-1', `tpl${String(PLAN_MEMORY)}`)], read); // the newest is still remembered
    expect(reads).toHaveLength(PLAN_MEMORY + 1);
    await resolveStages([row('again-0', 'tpl0')], read); // the oldest was pushed out
    expect(reads.at(-1)).toBe('again-0');
    forgetPlans();
  });
});

describe('A-23 stage descriptors on the queue, boards and my work', () => {
  let h: ApiHarness;
  let alice: User; // reviewer: decisions wait on her
  let bob: User; // creator
  let held: string; let other: string; let unreadable: string; let queued: string;
  let heldDecision: string;
  beforeAll(async () => {
    h = await createApiHarness('stations');
    alice = await h.user(h.a, [{ role: 'reviewer', scope: [h.a.applicationId] }]);
    bob = await h.user(h.a, [{ role: 'contributor', scope: [h.a.applicationId] }]);
    held = await plannedTask(h.a, bob, 'investigation', INVESTIGATION, 'plan_review', 'waiting_decision');
    other = await plannedTask(h.a, bob, 'short_flow', SHORT, 'build', 'running');
    unreadable = (await h.task(h.a, bob)).taskId; // its plan_ref is {}: it cannot be read
    queued = await plannedTask(h.a, bob, 'investigation', INVESTIGATION, undefined, 'queued');
    heldDecision = await decisionOn(held);
  }, 120_000);
  afterAll(async () => { await h.close(); });

  async function plannedTask(org: Org, creator: User, templateId: string, nodes: unknown[] | string, current: string | undefined, status: string, taskId: string = randomUUID(), applicationId: string = org.applicationId): Promise<string> {
    await h.tx(org, async (t) => {
      await t.query("INSERT INTO factory.task (org_id, id, creator_id, primary_application_id, target_kind, target_context, work_type, change_class, delivery_scope, status, current_node_id) VALUES ($1,$2,$3,$4,'existing_application',$5,'feature','feature','pr',$6,$7)",
        [org.orgId, taskId, creator.principalId, applicationId, JSON.stringify({ kind: 'existing_application', applicationId }), status, current ?? null]);
      await t.query("INSERT INTO factory.task_spec_version (org_id, id, task_id, version, spec, spec_hash, actor_id) VALUES ($1,$2,$3,1,$4,$5,$6)", [org.orgId, randomUUID(), taskId, JSON.stringify({ title: `Task in ${templateId}` }), 'a'.repeat(64), creator.principalId]);
    });
    const object = await h.artifacts.putControllerObject(org.orgId, Buffer.from(typeof nodes === 'string' ? nodes : JSON.stringify({ nodes })));
    await h.tx(org, async (t) => {
      const ref = await h.artifacts.registerControllerArtifact(t, { orgId: org.orgId, taskId, producerId: 'control-plane:worker', object, mediaType: 'application/json', schemaVersion: '2.0', classification: 'ordinary', purpose: 'execution_plan' });
      await t.query("INSERT INTO factory.execution_plan (org_id, id, task_id, version, spec_version, plan_ref, policy_ref, plan_hash, template_id, template_version, template_ref) VALUES ($1,$2,$3,1,1,$4,'{}',$5,$6,'1.0.0','{}')", [org.orgId, randomUUID(), taskId, JSON.stringify(ref), 'b'.repeat(64), templateId]);
    });
    return taskId;
  }
  async function decisionOn(taskId: string, expiresIn = '2 days'): Promise<string> {
    const id = randomUUID();
    await h.tx(h.a, (t) => t.query(`INSERT INTO factory.decision_request (org_id, id, task_id, action, subject_hash, subject_ref, policy_ref, evidence_refs, eligible_roles, required_principal_id, state, expires_at, reason)
      VALUES ($1,$2,$3,'approve_plan',$4,'{}','{}','[]','["reviewer"]',$5,'pending',now() + interval '${expiresIn}','Approve the plan')`, [h.a.orgId, id, taskId, 'c'.repeat(64), alice.principalId]));
    return id;
  }
  const get = async (user: User, url: string): Promise<{ status: number; body: unknown }> => {
    const verifier = new OidcVerifier([h.a, h.b].map((o) => ({ issuer: o.issuer.issuer, audience: AUDIENCE, jwksUrl: o.issuer.jwksUrl, orgId: o.orgId })));
    const app = buildApi({ db: h.db, verifier, artifacts: h.artifacts, tasks: h.tasks, boards: new BoardService({ db: h.db }), queue: new QueueService({ db: h.db, log: () => undefined }), dashboardOrigin: DASHBOARD_ORIGIN });
    try {
      const res = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${await user.token()}` } });
      return { status: res.statusCode, body: res.json<unknown>() };
    } finally { await app.close(); }
  };

  it('the queue item carries its stage, and the queue carries the merged line, gate marked, for the items and the caller\'s own tasks', async () => {
    const q = ((await get(alice, '/v2/me/queue')).body as Queue);
    const item = q.items.find((i) => i.action.kind === 'answer_decision' && i.subject.id === heldDecision);
    expect(item?.stage).toEqual({ nodeId: 'plan_review', label: 'Plan review', index: 3, count: 7, gate: true });
    expect(q.stations.map((s) => [s.nodeId, s.gate])).toEqual([['scope', false], ['plan', false], ['plan_review', true], ['investigate', false], ['evidence_review', false], ['deliver', false], ['close', false]]);
    expect(q.stations.map((s) => s.label)).toContain('Evidence review');
    // Bob's own open tasks put their plans on his line too: the short flow's "build" joins the union, after "scope".
    const mine = ((await get(bob, '/v2/me/queue')).body as Queue);
    expect(mine.stations.map((s) => s.nodeId)).toEqual(['scope', 'build', 'plan', 'plan_review', 'investigate', 'evidence_review', 'deliver', 'close']);
  });

  it('a board card carries its stage on its own plan, and the board carries the merged line; unreadable and unplanned tasks have none', async () => {
    const b = ((await get(alice, `/v2/applications/${h.a.applicationId}/board`)).body as Board);
    const cards = new Map(Object.values(b.columns).flat().map((c) => [c.taskId, c]));
    expect(cards.get(held)?.stage).toEqual({ nodeId: 'plan_review', label: 'Plan review', index: 3, count: 7, gate: true });
    expect(cards.get(other)?.stage).toEqual({ nodeId: 'build', label: 'Build', index: 2, count: 4, gate: false }); // 2 of its own 4 stations, not of the line
    expect(cards.get(unreadable)?.stage).toBeUndefined();
    expect(cards.get(queued)?.stage).toBeUndefined();
    expect(cards.get(unreadable)).toBeDefined(); // still on the board
    expect(b.stations.map((s) => s.nodeId)).toEqual(['scope', 'build', 'plan', 'plan_review', 'investigate', 'evidence_review', 'deliver', 'close']);
  });

  it('my work carries the stage on every card it lists', async () => {
    const w = ((await get(alice, '/v2/me/work')).body as MyWork);
    expect(w.needsYou.find((c) => c.taskId === held)?.stage).toMatchObject({ nodeId: 'plan_review', index: 3, count: 7, gate: true });
    const mine = ((await get(bob, '/v2/me/work')).body as MyWork);
    expect(mine.inProgress.find((c) => c.taskId === other)?.stage).toMatchObject({ nodeId: 'build', index: 2, count: 4 });
  });

  it('the plan route says which nodes are gates and gives each a label', async () => {
    const p = (await get(alice, `/v2/tasks/${held}/plan`)).body as { nodes: Array<{ id: string; label: string; gate: boolean }> };
    expect(p.nodes.map((n) => [n.id, n.label, n.gate])).toEqual([['scope', 'Scope', false], ['plan', 'Plan', false], ['plan_review', 'Plan review', true], ['investigate', 'Investigate', false], ['evidence_review', 'Evidence review', false], ['deliver', 'Deliver', false], ['close', 'Close', false]]);
  });

  it('a corrupt plan on one task leaves the others on its template with their stage and the line', async () => {
    forgetPlans();
    const org = h.a;
    // Same template version; the broken task sorts first, as it would on every poll.
    const broken = await plannedTask(org, bob, 'flaky_flow', 'this is not a plan', 'scope', 'running', '00000000-0000-4000-8000-0000000000a1');
    const fine = await plannedTask(org, bob, 'flaky_flow', INVESTIGATION, 'investigate', 'running', '00000000-0000-4000-8000-0000000000a2');
    const b = (await get(alice, `/v2/applications/${org.applicationId}/board`)).body as Board;
    const cards = new Map(Object.values(b.columns).flat().map((c) => [c.taskId, c]));
    expect(cards.get(broken)?.stage).toBeUndefined();
    expect(cards.get(fine)?.stage).toMatchObject({ nodeId: 'investigate', index: 4, count: 7 });
    expect(b.stations.length).toBeGreaterThanOrEqual(7);
  });

  it('a paused task keeps its position: with no current node it takes the node of its latest stage run', async () => {
    const paused = await plannedTask(h.a, bob, 'investigation', INVESTIGATION, undefined, 'paused');
    const run = (node: string, at: string) => h.tx(h.a, (t) => t.query(`INSERT INTO factory.stage_run (org_id, id, task_id, plan_version, node_id, semantic_attempt, logical_id, input_hash, input_ref, role, status, limits, created_at) VALUES ($1,$2,$3,1,$4,1,$5,$6,'{}','x','passed','{}', ${at})`, [h.a.orgId, randomUUID(), paused, node, `task-${paused}/${node}`, 'd'.repeat(64)]));
    await run('scope', "now() - interval '2 hours'");
    await run('investigate', "now() - interval '1 hour'");
    const w = (await get(bob, '/v2/me/work')).body as MyWork;
    expect(w.waitingOnOthers.find((c) => c.taskId === paused)?.stage).toMatchObject({ nodeId: 'investigate', index: 4, count: 7 });
    // A task that is not paused is not guessed at: no current node, no position.
    const idle = await plannedTask(h.a, bob, 'investigation', INVESTIGATION, undefined, 'running');
    const b = (await get(alice, `/v2/applications/${h.a.applicationId}/board`)).body as Board;
    expect(Object.values(b.columns).flat().find((c) => c.taskId === idle)?.stage).toBeUndefined();
  });

  it('a task that is a queue item is left out of "Your other work", so it never shows twice', async () => {
    const expiring = await plannedTask(h.a, bob, 'investigation', INVESTIGATION, 'plan_review', 'waiting_decision');
    await decisionOn(expiring, '2 hours'); // Alice has not answered, and it runs out within a day: tier 2 on Bob's queue
    const q = (await get(bob, '/v2/me/queue')).body as Queue;
    expect(q.items.find((i) => i.subject.taskId === expiring)).toMatchObject({ tier: 2, reason: { code: 'review_expiring' }, stage: { nodeId: 'plan_review' } });
    const w = (await get(bob, '/v2/me/work')).body as MyWork;
    expect([...w.waitingOnOthers, ...w.inProgress].map((c) => c.taskId)).not.toContain(expiring);
    expect(w.waitingOnOthers.map((c) => c.taskId)).toContain(held); // a waiting task that is not a queue item stays
  });

  it('only tasks in projects the caller can read are placed: a same-organization user with a task in a project they cannot read gets nothing from it', async () => {
    const dave = await h.user(h.a, [{ role: 'reviewer', scope: [h.a.otherApplicationId] }]); // Billing only
    const secret = [node('secret_stage', 'discover'), node('close', 'learn_close')];
    const hidden = await plannedTask(h.a, dave, 'secret_flow', secret, 'secret_stage', 'running'); // Dave created it, in Orders
    const q = (await get(dave, '/v2/me/queue')).body as Queue;
    expect(q.stations.map((s) => s.nodeId)).not.toContain('secret_stage');
    expect(JSON.stringify(q)).not.toContain('secret_stage');
    expect((await get(dave, `/v2/applications/${h.a.applicationId}/board`)).status).toBe(404);
    expect(JSON.stringify((await get(dave, '/v2/me/work')).body)).not.toContain('secret_stage');
    // The lookup itself refuses it: asking for the task with a project list that excludes its project returns nothing.
    expect(await h.tx(h.a, (t) => stageRows(t, [hidden], [h.a.otherApplicationId]))).toEqual([]);
    expect(await h.tx(h.a, (t) => stageRows(t, [hidden], [h.a.applicationId]))).toHaveLength(1);
  });

  it('another organization adds nothing to the line', async () => {
    const carol = await h.user(h.b, [{ role: 'reviewer', scope: [h.b.applicationId] }]);
    const q = (await get(carol, '/v2/me/queue')).body as Queue;
    expect(q.stations).toEqual([]);
    expect(q.items).toEqual([]);
  });
});
