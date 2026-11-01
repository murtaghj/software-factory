import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TaskEvent, TaskView } from '@factory/contracts';
import { TaskDetail, TaskStore, parseSse, taskModel, STALE_AFTER_MS } from '../src/index.ts';

const ev = (sequence: number, eventId = `e-${String(sequence)}`): TaskEvent => ({ eventId, orgId: 'o', taskId: 't', sequence, eventType: 'stage.completed', occurredAt: '2026-11-01T12:00:00Z', recordedAt: '2026-11-01T12:00:00Z', source: 'workflow', correlationId: 'c', payloadRef: { artifactId: 'a', sha256: 'b'.repeat(64), mediaType: 'application/json', schemaVersion: '2.0', sizeBytes: 1 }, schemaVersion: '2.0' });
const view = (over: Partial<TaskView> = {}): TaskView => ({ id: 't', orgId: 'o', creatorId: 'u', ownerPrincipalId: 'u', spec: { title: 'Investigate <script>alert(1)</script> failures' } as TaskView['spec'], status: 'running', revision: 1, planVersion: 1, projectionSequence: 5, projectedAt: '2026-11-01T12:00:00.000Z', createdAt: '2026-11-01T11:00:00Z', updatedAt: '2026-11-01T12:00:00Z', cleanupState: 'pending', lastEventSequence: 5, priorityClass: 'normal', changeClass: 'investigation', ...over });

describe('AC-04 projection ordering (client side)', () => {
  it('older or duplicate events never overwrite newer state; a conflicting duplicate is an integrity error', () => {
    const s = new TaskStore();
    for (const n of [1, 2, 3]) expect(s.applyEvent(ev(n))).toBe('applied');
    expect(s.applyEvent(ev(3))).toBe('duplicate');
    expect(s.applyEvent(ev(2, 'e-2'))).toBe('duplicate');
    expect(s.applyEvent(ev(3, 'forged'))).toBe('conflict');
    expect(s.state.integrityErrors).toHaveLength(1);
    expect(s.state.events.map((e) => e.sequence)).toEqual([1, 2, 3]);
    expect(s.applyEvent(ev(5))).toBe('gap');
    expect(s.state.gapDetected).toBe(true);
    expect(s.state.lastEventSequence).toBe(3);
  });

  it('an older snapshot is refused; a newer one replaces state and moves the cursor', () => {
    const s = new TaskStore();
    expect(s.applySnapshot(view({ lastEventSequence: 9, projectionSequence: 7 }))).toBe('applied');
    expect(s.applySnapshot(view({ lastEventSequence: 8, projectionSequence: 7 }))).toBe('stale');
    expect(s.applySnapshot(view({ lastEventSequence: 9, projectionSequence: 6 }))).toBe('stale');
    expect(s.state.lastEventSequence).toBe(9);
    expect(s.applyEvent(ev(9))).toBe('stale');
    expect(s.applyEvent(ev(10))).toBe('applied');
  });
});

describe('W-014 dashboard views', () => {
  it('parses SSE frames incrementally, ignoring keepalive comments', () => {
    const a = parseSse(': keepalive\n\nid: 1\nevent: task.accepted\ndata: {"x":1}\n\nid: 2\nda');
    expect(a.messages).toEqual([{ id: '1', event: 'task.accepted', data: '{"x":1}' }]);
    const b = parseSse(`${a.rest}ta: {"y":2}\n\n`);
    expect(b.messages).toEqual([{ id: '2', event: 'message', data: '{"y":2}' }]);
  });

  it('staleness is honest: disconnected or silent beyond the threshold is labelled, terminal state is not', () => {
    const t = Date.parse('2026-11-01T12:00:00Z');
    expect(taskModel(view(), [], [], 'live', t + 1000).freshness).toMatchObject({ stale: false, message: 'Live — state as of 2026-11-01T12:00:00.000Z' });
    expect(taskModel(view(), [], [], 'live', t + STALE_AFTER_MS + 5000).freshness).toMatchObject({ stale: true });
    expect(taskModel(view(), [], [], 'disconnected', t + 1000).freshness.message).toBe('Disconnected — showing the last known state as of 2026-11-01T12:00:00.000Z');
    expect(taskModel(view({ status: 'succeeded' }), [], [], 'live', t + 10 * STALE_AFTER_MS).freshness.stale).toBe(false);
  });

  it('renders stages, gates (including superseded evidence) and the freshness banner as text only', () => {
    const model = taskModel(view({ currentNodeId: 'investigate' }), [
      { id: 'task-t/plan-1/scope/attempt-1', taskId: 't', nodeId: 'scope', planVersion: 1, semanticAttempt: 1, status: 'passed', role: 'discovery', inputHash: 'a'.repeat(64), allocationGeneration: 0, usage: [], supersededAt: '2026-11-01T12:00:00Z', supersededByPlanVersion: 2 },
      { id: 'task-t/plan-2/scope/attempt-1', taskId: 't', nodeId: 'scope', planVersion: 2, semanticAttempt: 1, status: 'passed', role: 'discovery', inputHash: 'b'.repeat(64), allocationGeneration: 0, usage: [] },
    ], [
      { id: 'g1', taskId: 't', gateId: 'scope_accepted', inputBinding: {} as never, inputHash: 'c'.repeat(64), verdict: 'passed', evidenceRefs: [], evaluatorId: 'e', reasonCodes: ['criteria_mapped'], evaluatedAt: '2026-11-01T12:00:00Z', supersededBy: 'g2' },
    ], 'disconnected', Date.parse('2026-11-01T12:00:01Z'));
    const html = renderToStaticMarkup(<TaskDetail model={model} />);
    expect(html).toContain('passed (superseded)');
    expect(html).toContain('no — superseded');
    expect(html).toContain('data-stale="true"');
    expect(html).toContain('Disconnected — showing the last known state');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
