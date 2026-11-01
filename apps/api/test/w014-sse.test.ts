import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { validateContract } from '@factory/contracts';
import { appendTaskEvent } from '@factory/database';
import { createApiHarness, type ApiHarness, type User } from './harness.ts';
import { taskRequest } from './task-fixtures.ts';

async function readFrames(res: Response, count: number): Promise<string[]> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error('no body');
  const decoder = new TextDecoder();
  let text = '';
  const frames: string[] = [];
  while (frames.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    const parts = text.split('\n\n');
    text = parts.pop() ?? '';
    frames.push(...parts);
  }
  await reader.cancel();
  return frames;
}

describe('W-014 SSE task event stream', () => {
  let h: ApiHarness;
  let alice: User;
  let base: string;
  let taskId: string;
  beforeAll(async () => {
    h = await createApiHarness('w014');
    alice = await h.user(h.a, [{ role: 'contributor', scope: [h.a.applicationId] }]);
    const app = await h.appWith({});
    base = await app.listen({ port: 0, host: '127.0.0.1' });
    const created = await app.inject({ method: 'POST', url: '/v2/tasks', headers: { authorization: `Bearer ${await alice.token()}`, 'content-type': 'application/json', 'idempotency-key': 'k' }, payload: taskRequest(h.a.applicationId) as unknown as Record<string, unknown> });
    taskId = created.json<{ taskId: string }>().taskId;
    const payloadRef = { artifactId: randomUUID(), sha256: 'a'.repeat(64), mediaType: 'application/json', schemaVersion: '2.0', sizeBytes: 1 };
    for (let i = 0; i < 4; i += 1) await h.tx(h.a, (t) => appendTaskEvent(t, { orgId: h.a.orgId, taskId, eventType: 'stage.progress', source: 'runner', payloadRef, correlationId: 'c', producerEventId: `p-${String(i)}` }));
  });
  afterAll(async () => { await h.close(); });

  const open = async (headers: Record<string, string> = {}, query = '') => fetch(`${base}/v2/tasks/${taskId}/events${query}`, { headers: { authorization: `Bearer ${await alice.token()}`, ...headers } });

  it('streams contract-valid TaskEvents in sequence with id = sequence', async () => {
    const res = await open();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const frames = await readFrames(res, 5);
    const events = frames.map((f) => JSON.parse(f.split('\n').find((l) => l.startsWith('data: '))?.slice(6) ?? '{}') as Record<string, unknown>);
    expect(events.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(frames.map((f) => f.split('\n')[0])).toEqual(['id: 1', 'id: 2', 'id: 3', 'id: 4', 'id: 5']);
    for (const e of events) expect(validateContract('TaskEvent', e).ok).toBe(true);
  });

  it('resumes after Last-Event-ID, which takes precedence over after', async () => {
    const frames = await readFrames(await open({ 'last-event-id': '3' }, '?after=1'), 2);
    expect(frames.map((f) => f.split('\n')[0])).toEqual(['id: 4', 'id: 5']);
    const viaAfter = await readFrames(await open({}, '?after=4'), 1);
    expect(viaAfter.map((f) => f.split('\n')[0])).toEqual(['id: 5']);
    expect((await open({ 'last-event-id': '-1' })).status).toBe(400);
  });

  it('a cursor older than the retained window gets 410 EventCursorExpired with snapshot recovery', async () => {
    // Build a server whose retention window is 1 ms, so every stored event is outside it.
    const { OidcVerifier, buildApi } = await import('../src/index.ts');
    const verifier = new OidcVerifier([{ issuer: h.a.issuer.issuer, audience: 'software-factory-api', jwksUrl: h.a.issuer.jwksUrl, orgId: h.a.orgId }]);
    const strict = buildApi({ db: h.db, verifier, artifacts: h.artifacts, tasks: h.tasks, dashboardOrigin: 'http://localhost:4173', events: { retentionMs: 1 } });
    const url = await strict.listen({ port: 0, host: '127.0.0.1' });
    try {
      await new Promise((r) => setTimeout(r, 20));
      const res = await fetch(`${url}/v2/tasks/${taskId}/events?after=0`, { headers: { authorization: `Bearer ${await alice.token()}` } });
      expect(res.status).toBe(410);
      expect(res.headers.get('location')).toBe(`/v2/tasks/${taskId}`);
      const body = await res.json() as Record<string, unknown>;
      expect(validateContract('EventCursorExpired', body).ok).toBe(true);
      expect(body).toMatchObject({ code: 'event_cursor_expired', snapshotUrl: `/v2/tasks/${taskId}`, resumeAfterSequence: 5 });
      // Resuming from the snapshot's position is allowed (nothing newer is missing).
      const resumed = await fetch(`${url}/v2/tasks/${taskId}/events`, { headers: { authorization: `Bearer ${await alice.token()}`, 'last-event-id': '5' } });
      expect(resumed.status).toBe(200);
      await resumed.body?.cancel();
    } finally {
      await strict.close();
    }
  });

  it('sends keepalives, and ends the stream when the caller loses access', async () => {
    const { OidcVerifier, buildApi } = await import('../src/index.ts');
    const verifier = new OidcVerifier([{ issuer: h.a.issuer.issuer, audience: 'software-factory-api', jwksUrl: h.a.issuer.jwksUrl, orgId: h.a.orgId }]);
    const fast = buildApi({ db: h.db, verifier, artifacts: h.artifacts, tasks: h.tasks, dashboardOrigin: 'http://localhost:4173', events: { retentionMs: 3_600_000, pollMs: 20, keepaliveMs: 50, reauthorizeMs: 100 } });
    const url = await fast.listen({ port: 0, host: '127.0.0.1' });
    const viewer = await h.user(h.a, [{ role: 'viewer', scope: [h.a.applicationId] }]);
    try {
      const res = await fetch(`${url}/v2/tasks/${taskId}/events`, { headers: { authorization: `Bearer ${await viewer.token()}`, 'last-event-id': '5' } });
      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let text = '';
      const start = Date.now();
      while (!text.includes(': keepalive') && Date.now() - start < 3000) { const { value } = await reader?.read() ?? { value: undefined }; text += decoder.decode(value, { stream: true }); }
      expect(text).toContain(': keepalive');
      await h.tx(h.a, (t) => t.query('UPDATE factory.membership SET revoked_at = now() WHERE principal_id = $1', [viewer.principalId]));
      let done = false;
      while (!done && Date.now() - start < 5000) { const r = await reader?.read(); done = r?.done ?? true; if (r?.value) text += decoder.decode(r.value, { stream: true }); }
      expect(text).toContain('event: reauthenticate');
      expect(done).toBe(true);
    } finally {
      await fast.close();
    }
  });

  it('a caller without task access cannot open the stream', async () => {
    const outsider = await h.user(h.a, [{ role: 'viewer', scope: [h.a.otherApplicationId] }]);
    const res = await fetch(`${base}/v2/tasks/${taskId}/events`, { headers: { authorization: `Bearer ${await outsider.token()}` } });
    expect(res.status).toBe(404);
  });
});
