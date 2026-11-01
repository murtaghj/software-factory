import { describe, expect, it, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { appendTaskEvent } from '@factory/database';
import { TaskEventStream, TaskStore } from '@factory/dashboard';
import { createSystemHarness, type SystemHarness } from '../src/index.ts';

const taskBody = (applicationId: string) => ({
  schemaVersion: '2.0', title: 'Stream resume', intent: 'Exercise event resume.', applicationIds: [applicationId], workType: 'investigation', acceptanceCriteria: ['Answer the question.'], assurance: 'standard', deliveryScope: 'report',
  budget: { maxMicroUsd: 1_000_000, maxActiveSeconds: 600, maxCalendarSeconds: 3600, maxAuthoringInvocations: 2, maxSemanticAttemptsPerNode: 2, maxDesignReturns: 1, invocationMode: 'bounded' },
  targetContext: { kind: 'existing_application', applicationId },
});
const until = async (fn: () => boolean, ms = 10_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); }
};

describe('AC-52 event stream resume', () => {
  let h: SystemHarness | undefined;
  afterEach(async () => { await h?.close(); h = undefined; });

  async function setup(events?: { retentionMs: number }) {
    h = await createSystemHarness('ac52', events ? { events: { ...events, pollMs: 25 } } : { events: { retentionMs: 3_600_000, pollMs: 25 } });
    const sys = h;
    const user = await sys.user([{ role: 'contributor', scope: [sys.applicationId] }]);
    const res = await fetch(`${sys.apiUrl}/v2/tasks`, { method: 'POST', headers: { authorization: `Bearer ${await user.token()}`, 'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: JSON.stringify(taskBody(sys.applicationId)) });
    const taskId = (await res.json() as { taskId: string }).taskId;
    const payloadRef = { artifactId: randomUUID(), sha256: 'a'.repeat(64), mediaType: 'application/json', schemaVersion: '2.0', sizeBytes: 1 };
    const emit = (n: number) => sys.tx((t) => appendTaskEvent(t, { orgId: sys.orgId, taskId, eventType: 'stage.progress', source: 'runner', payloadRef, correlationId: 'c', producerEventId: `p-${taskId}-${String(n)}` }));
    return { sys, user, taskId, emit };
  }

  it('a client that disconnects resumes after its last applied event: no gaps, no duplicate application', async () => {
    const { sys, user, taskId, emit } = await setup();
    for (let i = 0; i < 4; i += 1) await emit(i);
    const store = new TaskStore();
    const outcomes: string[] = [];
    const original = store.applyEvent.bind(store);
    store.applyEvent = (e) => { const r = original(e); outcomes.push(r); return r; };
    const stream = new TaskEventStream({ apiBase: sys.apiUrl, taskId, token: user.token, store, reconnectDelayMs: 50 });
    const running = stream.run();
    await until(() => store.state.lastEventSequence === 5);
    stream.dropConnection(); // the network drops
    for (let i = 4; i < 7; i += 1) await emit(i); // events keep happening while disconnected
    await until(() => store.state.lastEventSequence === 8);
    stream.stop();
    await running;
    expect(store.state.events.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(outcomes.filter((o) => o !== 'applied')).toEqual([]); // resumed exactly after 5: nothing re-sent or re-applied
    expect(store.state.integrityErrors).toEqual([]);
  });

  it('a client starting with an expired cursor refreshes the snapshot and resumes from it without replaying old events', async () => {
    const { sys, user, taskId, emit } = await setup({ retentionMs: 300 });
    for (let i = 0; i < 3; i += 1) await emit(i);
    await new Promise((r) => setTimeout(r, 400)); // events 1-4 fall outside the retained window
    await emit(3); // event 5 is retained
    const store = new TaskStore();
    const stream = new TaskEventStream({ apiBase: sys.apiUrl, taskId, token: user.token, store, reconnectDelayMs: 50 });
    const running = stream.run();
    await until(() => store.state.task !== undefined && store.state.lastEventSequence >= 5);
    expect(stream.refreshes).toBe(1);
    expect(store.state.task?.lastEventSequence).toBe(5);
    expect(store.state.events).toEqual([]); // nothing before the snapshot was applied as an event
    await emit(4);
    await until(() => store.state.lastEventSequence === 6);
    stream.stop();
    await running;
    expect(store.state.events.map((e) => e.sequence)).toEqual([6]);
  });
});
