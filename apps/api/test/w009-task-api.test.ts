import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { validateContract } from '@factory/contracts';
import { createApiHarness, type ApiHarness, type User } from './harness.ts';
import { taskRequest } from './task-fixtures.ts';

describe('W-009 task API: validation, admission, detail and list', () => {
  let h: ApiHarness;
  let alice: User;
  let viewer: User;
  beforeAll(async () => {
    h = await createApiHarness('w009');
    alice = await h.user(h.a, [{ role: 'contributor', scope: [h.a.applicationId] }]);
    viewer = await h.user(h.a, [{ role: 'viewer', scope: [h.a.applicationId] }]);
  });
  afterAll(async () => { await h.close(); });

  let n = 0;
  const post = async (user: User, body: unknown, key = `k-${String(++n)}`) => h.app.inject({ method: 'POST', url: '/v2/tasks', headers: { authorization: `Bearer ${await user.token()}`, 'content-type': 'application/json', 'idempotency-key': key }, payload: body as Record<string, unknown> });
  const get = async (user: User, url: string) => h.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${await user.token()}` } });

  it('rejects malformed, unsupported and unauthorized requests with typed problems', async () => {
    expect((await h.app.inject({ method: 'POST', url: '/v2/tasks', headers: { authorization: `Bearer ${await alice.token()}`, 'content-type': 'application/json' }, payload: taskRequest(h.a.applicationId) as unknown as Record<string, unknown> })).json()).toMatchObject({ status: 400, code: 'idempotency_key_required' });
    const cases: Array<[unknown, number, string]> = [
      [{ ...taskRequest(h.a.applicationId), unexpected: true }, 422, 'invalid_task_request'],
      [taskRequest(h.a.applicationId, { workType: 'investigation', deliveryScope: 'production' }), 422, 'invalid_task_request'],
      [taskRequest(h.a.applicationId, { applicationIds: [h.a.otherApplicationId] }), 422, 'invalid_target'],
      [taskRequest(h.a.otherApplicationId), 403, 'application_not_authorized'],
      [taskRequest(h.b.applicationId), 403, 'application_not_authorized'],
      [taskRequest(h.a.applicationId, { priorityClass: 'incident' }), 403, 'incident_priority_unauthorized'],
      [taskRequest(h.a.applicationId, { parentTaskId: '00000000-0000-4000-8000-000000000001' }), 422, 'child_tasks_not_supported'],
    ];
    for (const [body, status, code] of cases) {
      const r = await post(alice, body);
      expect({ status: r.statusCode, code: r.json<{ code: string }>().code }).toEqual({ status, code });
    }
    expect((await post(viewer, taskRequest(h.a.applicationId))).statusCode).toBe(403);
  });

  it('accepted tasks are readable as contract-valid TaskViews with stable workflow identity and explicit defaults', async () => {
    const r = await post(alice, taskRequest(h.a.applicationId));
    expect(r.headers.location).toBe(r.json<{ statusUrl: string }>().statusUrl);
    const taskId = r.json<{ taskId: string }>().taskId;
    const view = await get(viewer, `/v2/tasks/${taskId}`);
    expect(view.statusCode).toBe(200);
    const body = view.json<Record<string, unknown>>();
    const valid = validateContract('TaskView', body);
    expect(valid.ok, JSON.stringify(valid.ok ? [] : valid.errors.slice(0, 3))).toBe(true);
    expect(body).toMatchObject({ id: taskId, status: 'accepted', revision: 1, planVersion: 1, projectionSequence: 0, lastEventSequence: 1, workflowId: `factory/${h.a.orgId}/${taskId}`, ownerPrincipalId: alice.principalId, creatorId: alice.principalId, priorityClass: 'normal', changeClass: 'feature' });
    expect((body.spec as { prCompletion: unknown }).prCompletion).toEqual({ mode: 'pr_created', maxReviewRounds: 3, maxWaitSeconds: 604800 });
    const event = await h.tx(h.a, (t) => t.query<{ event_type: string; sequence: string; payload_ref: { artifactId: string } }>('SELECT event_type, sequence, payload_ref FROM factory.task_event WHERE task_id = $1', [taskId]));
    expect(event.rows.map((e) => [e.event_type, Number(e.sequence)])).toEqual([['task.accepted', 1]]);
    const payload = await h.artifacts.readVerified({ orgId: h.a.orgId, actorId: 'control-plane', actorKind: 'service', taskId, grantIds: [], correlationId: 'x' }, event.rows[0]?.payload_ref as never);
    expect(JSON.parse(payload.toString())).toMatchObject({ eventType: 'task.accepted', taskId, specVersion: 1 });
  });

  it('detail is denied for other applications and organizations, indistinguishably', async () => {
    const taskId = (await post(alice, taskRequest(h.a.applicationId))).json<{ taskId: string }>().taskId;
    const outsider = await h.user(h.a, [{ role: 'viewer', scope: [h.a.otherApplicationId] }]);
    const bob = await h.user(h.b, [{ role: 'viewer', scope: ['*'] }]);
    for (const u of [outsider, bob]) expect((await get(u, `/v2/tasks/${taskId}`)).statusCode).toBe(404);
    expect((await get(alice, '/v2/tasks/not-a-uuid')).statusCode).toBe(404);
  });

  it('lists with stable descending cursors, filters and authorization', async () => {
    const lister = await h.user(h.a, [{ role: 'contributor', scope: [h.a.applicationId, h.a.otherApplicationId] }]);
    const mine: string[] = [];
    for (let i = 0; i < 5; i += 1) mine.push((await post(lister, taskRequest(h.a.applicationId, { title: `list ${String(i)}` }))).json<{ taskId: string }>().taskId);
    await post(lister, taskRequest(h.a.otherApplicationId, { workType: 'bug', title: 'other app bug' }));
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await get(lister, `/v2/tasks?limit=2&creatorId=${lister.principalId}&applicationId=${h.a.applicationId}${cursor ? `&cursor=${cursor}` : ''}`);
      expect(page.statusCode).toBe(200);
      const body = page.json<{ items: Array<{ id: string }>; nextCursor?: string }>();
      expect(validateContract('TaskPage', body).ok).toBe(true);
      seen.push(...body.items.map((t) => t.id));
      cursor = body.nextCursor;
    } while (cursor);
    expect(seen).toEqual([...mine].reverse());
    const bugs = (await get(lister, `/v2/tasks?workType=bug&creatorId=${lister.principalId}`)).json<{ items: Array<{ spec: { title: string } }> }>();
    expect(bugs.items.map((t) => t.spec.title)).toEqual(['other app bug']);
    const viewerList = (await get(viewer, `/v2/tasks?creatorId=${lister.principalId}`)).json<{ items: Array<{ spec: { applicationIds: string[] } }> }>();
    expect(viewerList.items.length).toBe(5); // the viewer cannot see the other application's task
    expect((await get(lister, '/v2/tasks?limit=101')).statusCode).toBe(422);
    expect((await get(lister, '/v2/tasks?cursor=@@@')).statusCode).toBe(422);
    expect((await get(lister, '/v2/tasks?reviewMode=ai_only')).json()).toEqual({ items: [] });
  });
});
