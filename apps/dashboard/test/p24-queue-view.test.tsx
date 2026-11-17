// P-24 (docs/plan-additions.md): the ranked queue view and its wording. The view renders the order
// the server sent and never sorts; every reason is a sentence, not a code; exact times stay in <time>.
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { timeLeft } from '@factory/client';
import { QueueView, queueHeadline, reasonText, type Queue, type QueueItem } from '../src/index.ts';

const NOW = Date.parse('2026-11-16T12:00:00Z');
const EXPIRES = '2026-11-16T16:00:00Z';
const SINCE = '2026-11-16T09:00:00Z';
const links = { taskHref: (id: string) => `#/tasks/${id}`, decisionHref: (id: string) => `#/decisions/${id}`, budgetHref: '#/budget' };
const LINE = [{ nodeId: 'scope', label: 'Scope', gate: false }, { nodeId: 'plan_review', label: 'Plan review', gate: true }, { nodeId: 'close', label: 'Close', gate: false }];
const people = { me: 'Sam', dana: 'Dana (developer)', riley: 'Riley' };

const item = (rank: number, over: Partial<QueueItem> = {}): QueueItem => ({
  key: `task:t${String(rank)}:task_finished`, rank, tier: 4, sourceId: 'factory.tasks', need: 'finished', dismissible: true, priority: 'normal', since: SINCE,
  subject: { kind: 'task', id: `t${String(rank)}`, title: `Task ${String(rank)}`, taskId: `t${String(rank)}`, applicationId: 'app-1' },
  reason: { code: 'task_finished' }, action: { kind: 'open_task', taskId: `t${String(rank)}` }, ...over,
});
const ask = (rank: number, over: Partial<QueueItem> = {}): QueueItem => item(rank, {
  key: `decision:d${String(rank)}:answer_needed`, tier: 1, need: 'blocked_on_you', dismissible: false, expiresAt: EXPIRES, sourceId: 'factory.decisions',
  subject: { kind: 'decision', id: `d${String(rank)}`, title: `Review ${String(rank)}`, taskId: `t${String(rank)}`, applicationId: 'app-1' },
  reason: { code: 'answer_needed', actorPrincipalId: 'dana', detailCode: 'approve_plan' }, action: { kind: 'answer_decision', decisionId: `d${String(rank)}` }, ...over,
});
const queue = (items: QueueItem[], over: Partial<Queue> = {}): Queue => ({
  schema: 'factory-queue/1', principalId: 'me', generatedAt: '2026-11-16T12:00:00Z', items, degraded: false, truncated: false, applications: { 'app-1': 'Orders API' }, people,
  sources: [{ id: 'factory.decisions', kind: 'factory', status: 'ok', items: 0, truncated: false }, { id: 'factory.tasks', kind: 'factory', status: 'ok', items: 0, truncated: false }, { id: 'factory.budget', kind: 'factory', status: 'ok', items: 0, truncated: false }],
  rules: { tiers: ['blocked_on_you', 'running_out', 'stopped', 'finished'], expiringWithinSeconds: 86_400, allowanceLowPercent: 10, windowDays: 14 }, stations: LINE, ...over,
});
const render = (q: Queue, extra: Partial<Parameters<typeof QueueView>[0]> = {}) => renderToStaticMarkup(<QueueView queue={q} links={links} now={NOW} {...extra} />);
const keysIn = (html: string) => [...html.matchAll(/data-key="([^"]+)"/g)].map((m) => m[1]);
const rowsOf = (html: string) => html.split('<tr ').slice(1).filter((r) => r.includes('data-key='));

describe('P-24 the queue view', () => {
  it('renders the items in the order given, even when that order contradicts the tiers: the client does not rank', () => {
    const html = render(queue([item(1), ask(2), item(3)]));
    expect(keysIn(html)).toEqual(['task:t1:task_finished', 'decision:d2:answer_needed', 'task:t3:task_finished']);
    expect(html.match(/class="first"/g)).toHaveLength(1);
    expect(html).toContain('<tr class="first" data-key="task:t1:task_finished"'); // the raised row is the first item sent, not the most urgent
  });

  it('each item has exactly one primary action to the right place, and only dismissible items can be marked as seen', () => {
    const html = render(queue([ask(1), item(2, { reason: { code: 'task_stopped', detailCode: 'budget_exhausted' }, need: 'stopped', tier: 3, key: 'task:t2:task_stopped' }), item(3, { key: 'allowance:2026-11-01:allowance_low', need: 'running_out', tier: 2, subject: { kind: 'allowance', id: '2026-11-01', title: 'Your monthly allowance' }, reason: { code: 'allowance_low', remainingMicroUsd: 4_000_000, limitMicroUsd: 50_000_000 }, action: { kind: 'open_budget' } })]));
    const rows = rowsOf(html);
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r.match(/<a class="key( on)?" href="[^"]+">[^<]+<\/a><\/td><\/tr>/g)).toHaveLength(1); // one action, last in the row
    const primary = rows.map((r) => /<a class="key(?: on)?" href="([^"]+)">([^<]+)<\/a><\/td><\/tr>/.exec(r)?.slice(1));
    expect(primary).toEqual([['#/decisions/d1', 'Review now'], ['#/tasks/t2', 'See why it stopped'], ['#/budget', 'Open budget']]);
    expect(rows.map((r) => r.includes('data-dismiss'))).toEqual([false, true, true]);
    expect(html).toContain('Mark as seen');
    expect(html.match(/Mark as seen/g)).toHaveLength(2);
  });

  it('says why in words, keeps exact times in <time>, and shows no code or raw timestamp', () => {
    const html = render(queue([ask(1), item(2, { need: 'stopped', tier: 3, key: 'task:t2:task_stopped', reason: { code: 'task_stopped', detailCode: 'budget_exhausted' } })]));
    expect(html).toContain('Dana is blocked on you'); // "(developer)" is dropped, as on every card
    expect(html).toContain(`<time dateTime="${EXPIRES}"`);
    expect(html).toContain('4 hours left');
    expect(html).toContain('It ran out of budget');
    expect(html).toContain('3 hours ago');
    expect(html).toContain('Orders API');
    expect(html).toContain('<span class="visually-hidden">, blocked on you</span>'); // the lamp says what it is, for a screen reader
    expect(html).not.toContain('Stopped —');
    const text = html.replace(/<[^>]*>/g, ' '); // what a person reads
    for (const code of ['answer_needed', 'task_stopped', 'budget_exhausted', 'approve_plan', 'blocked_on_you']) expect(text).not.toContain(code);
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('never says "Nothing needs you." over a list that could not be checked', () => {
    const broken = [{ id: 'factory.tasks', kind: 'factory', status: 'degraded', problem: 'failed', items: 0, truncated: false } as const];
    const withItems = render(queue([ask(1)], { degraded: true, sources: broken }));
    expect(withItems).toContain('Could not check: Your tasks. This list may be incomplete.');
    const empty = render(queue([], { degraded: true, sources: broken }));
    expect(empty).toContain('Could not check: Your tasks. This list may be incomplete.');
    expect(empty).not.toContain('Nothing needs you.');
    expect(queueHeadline(queue([], { degraded: true, sources: broken }), NOW)).toBe('Could not check: Your tasks. This list may be incomplete.');
    // Degraded because the ack lookup failed: every source is fine, but the list still may be incomplete.
    const noSource = render(queue([], { degraded: true }));
    expect(noSource).toContain('Could not check: part of your list. This list may be incomplete.');
    expect(noSource).not.toContain('Nothing needs you.');
    expect(render(queue([]))).toContain('Nothing needs you.');
  });

  it('an empty list that was cut by a cap never says "Nothing needs you."', () => {
    const empty = render(queue([], { truncated: true }));
    expect(empty).toContain('may be incomplete');
    expect(empty).not.toContain('Nothing needs you.');
    expect(queueHeadline(queue([], { truncated: true }), NOW)).toBe('Some items could not be shown here, so this list may be incomplete.');
    expect(render(queue([ask(1)], { truncated: true }))).toContain('the least urgent are not listed');
  });

  it('admits truncation, renders titles as text, and puts an unknown reason into words', () => {
    const html = render(queue([ask(1, { subject: { kind: 'decision', id: 'd1', title: '<img src=x onerror=alert(1)>', applicationId: 'app-1' } }), item(2, { reason: { code: 'pr_review_requested' as never }, key: 'task:t2:pr_review_requested' })], { truncated: true }));
    expect(html).toContain('the least urgent are not listed');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img');
    expect(html).toContain('Pr review requested');
    expect(html).not.toContain('pr_review_requested</');
  });

  it('"How this list is ordered" follows the tiers the server sent', () => {
    const html = render(queue([], { rules: { tiers: ['finished', 'blocked_on_you'], expiringWithinSeconds: 1, allowanceLowPercent: 1, windowDays: 1 } }));
    const lines = [...html.matchAll(/<li>([^<]+)<\/li>/g)].map((m) => m[1]);
    expect(lines).toEqual(['Something of yours finished and needs a look', 'Someone is blocked on you']);
    expect(html).toContain('How this list is ordered');
    expect(html).toContain('incidents first, then the soonest deadline, then the longest waiting');
  });

  it('"Your other work" is folded away and lists what is running or waiting on others', () => {
    const card = { taskId: 'w1', applicationId: 'app-1', title: 'Still running', status: 'running', column: 'running' as const, workType: 'investigation', creatorId: 'dana', ownerPrincipalId: 'dana', updatedAt: '2026-11-16T11:00:00Z' };
    const work = { principalId: 'me', generatedAt: '2026-11-16T12:00:00Z', needsYou: [], stopped: [], waitingOnOthers: [], inProgress: [card], recentlyDone: [], applications: { 'app-1': 'Orders API' }, people, truncated: false };
    const html = render(queue([]), { work });
    expect(html).toContain('Your other work <span>(1)</span>');
    expect(html).toContain('Still running');
    expect(html).toContain('An agent is running this task'); // no stage from the server
    expect(html).toContain('class="tok run"');
    expect(render(queue([]), { work: { ...work, inProgress: [] } })).not.toContain('Your other work');
  });

  it('a deadline that has passed is its own sentence, never "Dana is blocked on you. Expired."', () => {
    const q = queue([], { people: { dana: 'Dana' } });
    const past = ask(1, { expiresAt: '2026-11-16T11:00:00Z' });
    expect(reasonText(past, q, NOW)).toBe('Dana is blocked on you. The request has expired.');
    expect(reasonText(item(1, { reason: { code: 'review_expiring', actorPrincipalId: 'dana' }, expiresAt: '2026-11-16T11:00:00Z' }), q, NOW)).toBe('Dana has not answered your review request. The request has expired.');
    expect(timeLeft('2026-11-16T11:00:00Z', NOW)).toBe('Expired'); // as a phrase in a table cell
    expect(timeLeft(EXPIRES, NOW)).toBe('4 hours left');
  });

  it('amber means held by you: a review request of yours waiting on someone else is a numbered hollow lamp', () => {
    const waiting = item(2, { key: 'decision:d2:review_expiring', tier: 2, need: 'running_out', dismissible: false, expiresAt: EXPIRES, subject: { kind: 'decision', id: 'd2', title: 'Waiting', taskId: 't2', applicationId: 'app-1' }, reason: { code: 'review_expiring', actorPrincipalId: 'riley' }, action: { kind: 'open_task', taskId: 't2' } });
    const html = render(queue([ask(1), waiting]));
    expect(html).toContain('class="tok amber numbered"');
    expect(html).toContain('class="tok else numbered"');
    expect(html.match(/class="tok amber numbered"/g)).toHaveLength(1);
  });

  it('the wording of every reason and the headline, exactly: plain sentences', () => {
    const q = queue([], { people: { dana: 'Dana', riley: 'Riley' } });
    const text = (over: Partial<QueueItem>) => reasonText(item(1, over), q, NOW);
    expect(text(ask(1))).toBe('Dana is blocked on you. 4 hours left.');
    expect(text({ reason: { code: 'answer_needed' }, expiresAt: EXPIRES })).toBe('Your task is waiting for your answer. 4 hours left.');
    expect(text({ reason: { code: 'review_expiring', actorPrincipalId: 'riley' }, expiresAt: EXPIRES })).toBe('Riley has not answered your review request. 4 hours left, and the task stops if it expires.');
    expect(text({ reason: { code: 'review_expiring' }, expiresAt: EXPIRES })).toBe('Someone has not answered your review request. 4 hours left, and the task stops if it expires.');
    expect(text({ reason: { code: 'allowance_low', remainingMicroUsd: 4_000_000, limitMicroUsd: 50_000_000 } })).toBe('You have $4.00 left of your $50.00 allowance this month.');
    expect(text({ reason: { code: 'allowance_used_up' } })).toBe('Your allowance for this month is used up. New tasks are refused until it is raised.');
    expect(text({ reason: { code: 'task_needs_input' } })).toBe('Your task is waiting for input from you.');
    expect(text({ reason: { code: 'task_stopped', detailCode: 'decision_expired' } })).toBe('Stopped in Orders API 3 hours ago. The review request expired.');
    expect(text({ reason: { code: 'task_stopped', detailCode: 'budget_exhausted' } })).toBe('Stopped in Orders API 3 hours ago. It ran out of budget.');
    expect(text({ reason: { code: 'task_stopped' } })).toBe('Stopped in Orders API 3 hours ago.');
    expect(text({ reason: { code: 'task_finished' } })).toBe('Finished in Orders API 3 hours ago. Take a look at the result.');
    expect(reasonText(item(1, { reason: { code: 'task_finished' } }), { people }, NOW)).toBe('Finished 3 hours ago. Take a look at the result.'); // no project names, no "in"
    expect(queueHeadline(queue([ask(1)], { people: { dana: 'Dana' } }), NOW)).toBe('Next: "Review 1" — Dana is blocked on you. 4 hours left.');
    expect(queueHeadline(queue([]), NOW)).toBe('Nothing needs you.');
  });

  it('draws the line from the server\'s stations, puts numbered lamps where the server says, and leaves off a lamp whose station is not on the line', () => {
    const at = (nodeId: string) => ({ nodeId, label: nodeId, index: 1, count: 3, gate: nodeId === 'plan_review' });
    const html = render(queue([ask(1, { stage: at('plan_review') }), ask(2, { stage: at('plan_review') }), item(3, { stage: at('close') }), item(4, { stage: at('somewhere_else') }), item(5)]));
    const lamps = [...html.matchAll(/<li( class="gate")? data-lamps="(\w+)"><div class="toks">(.*?)<\/div><span class="mark"[^>]*><\/span><span class="name">([^<]+)</g)].map((m) => [m[4], m[2], [...(m[3] ?? '').matchAll(/class="tok (\w+)(?: numbered)?"[^>]*>(\d+)/g)].map((l) => `${String(l[1])}${String(l[2])}`)]);
    expect(lamps).toEqual([['Scope', 'false', []], ['Plan review', 'true', ['amber1', 'amber2']], ['Close', 'true', ['green3']]]);
    expect(html).toContain('<li class="gate"'); // the gate is marked
    expect(html).toContain('a person signs here');
    expect(html).toContain('aria-label="Stages, with your tasks at the stage they have reached"');
    // No stations (an older server, or no plans): no line, and the table still stands.
    const bare = render(queue([ask(1)], { stations: [] }));
    expect(bare).not.toContain('class="line"');
    expect(bare).toContain('data-key="decision:d1:answer_needed"');
  });

  it('an empty list says so, and still shows the line when there is work to place on it', () => {
    const html = render(queue([]));
    expect(html).toContain('Nothing needs you.');
    expect(html).toContain('class="line"');
    expect(html).not.toContain('<table aria-label="What needs you');
  });
});
