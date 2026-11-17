// P-24 (docs/plan-additions.md): the pure ranking rules of the "what needs you next" queue.
import { describe, expect, it } from 'vitest';
import { QUEUE_CAP, keyOf, rankQueue, tierOf, validateCandidate, type Ranked } from '../src/queue/rank.ts';
import { QUEUE_NEEDS, type QueueCandidate, type QueueNeed } from '../src/queue/types.ts';

const APP = 'app-1';
let n = 0;
function cand(need: QueueNeed, over: Partial<QueueCandidate> = {}, id = `id-${String(++n)}`): QueueCandidate {
  const decision = need === 'blocked_on_you';
  return {
    need, dismissible: need === 'stopped' || need === 'finished', priority: 'normal', since: '2026-11-10T00:00:00Z',
    subject: { kind: decision ? 'decision' : 'task', id, title: `Item ${id}`, applicationId: APP },
    reason: { code: decision ? 'answer_needed' : need === 'stopped' ? 'task_stopped' : need === 'finished' ? 'task_finished' : 'review_expiring' },
    action: decision ? { kind: 'answer_decision', decisionId: id } : { kind: 'open_task', taskId: id },
    ...over,
  };
}
const ranked = (c: QueueCandidate, sourceOrder = 0, sourceId = `src-${String(sourceOrder)}`): Ranked => ({ candidate: c, sourceId, sourceOrder });
const rank = (cs: QueueCandidate[], acked: string[] = [], cap?: number) => rankQueue(cs.map((c) => ranked(c)), new Set(acked), cap);
const ids = (cs: QueueCandidate[], acked: string[] = []) => rank(cs, acked).items.map((i) => i.subject.id);

// A small seeded generator so the shuffle is repeatable.
function shuffle<T>(xs: T[], seed: number): T[] {
  const out = [...xs];
  let s = seed;
  const next = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
  for (let i = out.length - 1; i > 0; i -= 1) { const j = Math.floor(next() * (i + 1)); [out[i], out[j]] = [out[j] as T, out[i] as T]; }
  return out;
}

describe('P-24 queue ranking', () => {
  it('tier beats every other field', () => {
    const oldFinished = cand('finished', { since: '2020-01-01T00:00:00Z', priority: 'incident' }, 'old');
    const newBlocked = cand('blocked_on_you', { since: '2026-11-15T00:00:00Z', priority: 'background' }, 'new');
    expect(ids([oldFinished, newBlocked])).toEqual(['new', 'old']);
  });

  it('inside a tier: incident, then normal, then background', () => {
    expect(ids([cand('stopped', { priority: 'background' }, 'b'), cand('stopped', { priority: 'normal' }, 'n'), cand('stopped', { priority: 'incident' }, 'i')])).toEqual(['i', 'n', 'b']);
  });

  it('then the soonest deadline, with items that have none after those that do', () => {
    expect(ids([
      cand('blocked_on_you', {}, 'none'), cand('blocked_on_you', { expiresAt: '2026-11-17T00:00:00Z' }, 'late'), cand('blocked_on_you', { expiresAt: '2026-11-16T12:00:00Z' }, 'soon'),
    ])).toEqual(['soon', 'late', 'none']);
  });

  it('then the longest waiting, then the key; the order does not depend on the input order', () => {
    const all = [
      cand('stopped', { since: '2026-11-01T00:00:00Z' }, 'old'), cand('stopped', { since: '2026-11-05T00:00:00Z' }, 'mid-a'), cand('stopped', { since: '2026-11-05T00:00:00Z' }, 'mid-b'),
      cand('finished', { since: '2026-11-02T00:00:00Z' }, 'f'), cand('blocked_on_you', { expiresAt: '2026-11-17T00:00:00Z' }, 'd1'), cand('blocked_on_you', { expiresAt: '2026-11-17T00:00:00Z', since: '2026-11-09T00:00:00Z' }, 'd0'),
      cand('stopped', { priority: 'incident', since: '2026-11-09T00:00:00Z' }, 'inc'),
    ];
    const expected = ['d0', 'd1', 'inc', 'old', 'mid-a', 'mid-b', 'f'];
    expect(ids(all)).toEqual(expected);
    for (let seed = 1; seed <= 50; seed += 1) expect(ids(shuffle(all, seed))).toEqual(expected);
  });

  it('rank is 1..n with no gaps and tier is the position of the need plus one', () => {
    const r = rank(QUEUE_NEEDS.flatMap((need) => [cand(need), cand(need)])).items;
    expect(r.map((i) => i.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    for (const i of r) expect(i.tier).toBe(QUEUE_NEEDS.indexOf(i.need) + 1);
    expect(tierOf('finished')).toBe(4);
  });

  it('the key is kind:id:code', () => {
    const c = cand('finished', {}, 'abc');
    expect(keyOf(c)).toBe('task:abc:task_finished');
    expect(rank([c]).items[0]?.key).toBe('task:abc:task_finished');
  });

  it('the same key from two sources is one item: the lower tier wins, then the earlier source', () => {
    const lowTier = cand('running_out', { reason: { code: 'task_stopped' } }, 'same');
    const highTier = cand('stopped', {}, 'same');
    const r = rankQueue([ranked(highTier, 0, 'a'), ranked(lowTier, 1, 'b')], new Set());
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ tier: 2, sourceId: 'b' });
    const twin = rankQueue([ranked(cand('stopped', {}, 'same'), 1, 'later'), ranked(cand('stopped', {}, 'same'), 0, 'earlier')], new Set());
    expect(twin.items).toHaveLength(1);
    expect(twin.items[0]?.sourceId).toBe('earlier');
  });

  it('an acknowledged dismissible item is removed; an acknowledged blocking item stays', () => {
    const done = cand('finished', {}, 'done');
    const ask = cand('blocked_on_you', {}, 'ask');
    expect(ids([done, ask], [keyOf(done), keyOf(ask)])).toEqual(['ask']);
    expect(ids([done])).toEqual(['done']);
  });

  it('more than the cap: truncated is true and the tail is cut', () => {
    const many = Array.from({ length: QUEUE_CAP + 5 }, (_, i) => cand('stopped', { since: new Date(Date.UTC(2026, 10, 1) + i * 1000).toISOString() }, `t${String(i)}`));
    const r = rank(many);
    expect(r.truncated).toBe(true);
    expect(r.items).toHaveLength(QUEUE_CAP);
    expect(r.items.at(-1)?.subject.id).toBe(`t${String(QUEUE_CAP - 1)}`);
    expect(rank(many.slice(0, 3)).truncated).toBe(false);
  });

  it('validation rejects what it must', () => {
    const readable = new Map([[APP, 'Orders']]);
    expect(validateCandidate(cand('stopped'), readable, 'factory.tasks')).toBeUndefined();
    expect(validateCandidate({ ...cand('stopped'), need: 'urgent' }, readable, 'factory.tasks')).toBe('unknown need');
    const noAction: Partial<QueueCandidate> = cand('stopped');
    delete noAction.action;
    expect(validateCandidate(noAction, readable, 'factory.tasks')).toBe('unknown action');
    expect(validateCandidate(cand('stopped', { subject: { kind: 'task', id: 'x', title: 'x', applicationId: 'someone-elses' } }), readable, 'factory.tasks')).toBe('application not readable');
    expect(validateCandidate(cand('blocked_on_you', { dismissible: true }), readable, 'factory.tasks')).toBe('a blocking item cannot be dismissed');
    expect(validateCandidate(cand('stopped', { reason: { code: 'made_up' as never } }), readable, 'factory.tasks')).toBe('unknown reason');
    expect(validateCandidate(cand('stopped', { since: 'yesterday-ish' }), readable, 'factory.tasks')).toBe('bad since');
    expect(validateCandidate(null, readable, 'factory.tasks')).toBe('not an object');
  });

  it('validation hardening: projects are required, allowances come only from the budget source, actors are UUIDs, action and subject agree', () => {
    const readable = new Map([[APP, 'Orders']]);
    const noApp = cand('stopped');
    delete noApp.subject.applicationId;
    expect(validateCandidate(noApp, readable, 'factory.tasks')).toBe('application not readable');
    const allowance = cand('running_out', { dismissible: true, subject: { kind: 'allowance', id: '2026-11-01.l5', title: 'Your monthly allowance' }, reason: { code: 'allowance_low' }, action: { kind: 'open_budget' } });
    expect(validateCandidate(allowance, readable, 'factory.budget')).toBeUndefined();
    expect(validateCandidate(allowance, readable, 'factory.tasks')).toBe('allowance subject from another source');
    expect(validateCandidate(cand('stopped', { reason: { code: 'task_stopped', actorPrincipalId: 'not-a-uuid' } }), readable, 'factory.tasks')).toBe('bad actor');
    expect(validateCandidate(cand('stopped', { reason: { code: 'task_stopped', actorPrincipalId: '3f2c1b9e-8d4a-4f6e-9a1b-2c3d4e5f6a7b' } }), readable, 'factory.tasks')).toBeUndefined();
    const one = '3f2c1b9e-8d4a-4f6e-9a1b-2c3d4e5f6a7b';
    const two = '4a2c1b9e-8d4a-4f6e-9a1b-2c3d4e5f6a7b';
    const mismatch = cand('stopped', { subject: { kind: 'task', id: 'a', title: 't', taskId: one, applicationId: APP }, action: { kind: 'open_task', taskId: two } });
    expect(validateCandidate(mismatch, readable, 'factory.tasks')).toBe('action and subject name different tasks');
    // A task id that is not a UUID is refused: it is used to look the task up, to place it on the line.
    const loose = cand('stopped', { subject: { kind: 'task', id: 'a', title: 't', taskId: "x'; DROP TABLE task;--", applicationId: APP }, action: { kind: 'open_task', taskId: "x'; DROP TABLE task;--" } });
    expect(validateCandidate(loose, readable, 'factory.tasks')).toBe('bad task id');
  });

  it('validation: priority is an own property, a decision action needs a UUID, and a shown item must be acknowledgeable', () => {
    const readable = new Map([[APP, 'Orders']]);
    expect(validateCandidate(cand('stopped', { priority: 'toString' as never }), readable, 'factory.tasks')).toBe('bad priority');
    expect(validateCandidate(cand('stopped', { priority: 'constructor' as never }), readable, 'factory.tasks')).toBe('bad priority');
    const ask = (decisionId: unknown) => cand('blocked_on_you', { action: { kind: 'answer_decision', decisionId } as never });
    expect(validateCandidate(ask('3f2c1b9e-8d4a-4f6e-9a1b-2c3d4e5f6a7b'), readable, 'factory.decisions')).toBeUndefined();
    expect(validateCandidate(ask('not-a-uuid'), readable, 'factory.decisions')).toBe('bad decision id');
    expect(validateCandidate(ask(undefined), readable, 'factory.decisions')).toBe('bad decision id');
    expect(validateCandidate(ask(42), readable, 'factory.decisions')).toBe('bad decision id');
    const longId = cand('stopped', { subject: { kind: 'task', id: 'x'.repeat(101), title: 't', applicationId: APP } });
    expect(validateCandidate(longId, readable, 'factory.tasks')).toBe('key cannot be acknowledged');
    const spaced = cand('stopped', { subject: { kind: 'task', id: 'has space', title: 't', applicationId: APP } });
    expect(validateCandidate(spaced, readable, 'factory.tasks')).toBe('key cannot be acknowledged');
  });

  it('empty in, empty out', () => {
    expect(rank([])).toEqual({ items: [], truncated: false });
  });
});
