// P-21 (docs/plan-additions.md): the board and "my work" views. They state the next thing first,
// show who a task waits on, admit truncation, render untrusted titles as text, and offer no control
// that could change a task.
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BoardView, MyWorkView, focusOf, type Board, type MyWork, type TaskCard } from '../src/index.ts';

const card = (n: number, over: Partial<TaskCard> = {}): TaskCard => ({ taskId: `t${String(n)}`, applicationId: 'app-1', title: `Task ${String(n)}`, status: 'running', column: 'running', workType: 'investigation', creatorId: 'dana', ownerPrincipalId: 'dana', updatedAt: `2026-11-13T10:0${String(n)}:00Z`, ...over });
const people = { dana: 'Dana', riley: 'Riley' };
const work = (over: Partial<MyWork> = {}): MyWork => ({ principalId: 'dana', generatedAt: '2026-11-13T12:00:00Z', needsYou: [], stopped: [], waitingOnOthers: [], inProgress: [], recentlyDone: [], applications: { 'app-1': 'Orders API' }, people, truncated: false, ...over });
const href = (id: string) => `/tasks/${id}`;

describe('P-21 what to do next', () => {
  const ask = card(1, { title: 'Review the retry plan', status: 'waiting_decision', column: 'waiting', waitingOnPrincipalId: 'dana', decisionId: 'd1', decisionExpiresAt: '2026-11-14T09:00:00Z' });
  const stopped = card(2, { title: 'Why is checkout slow?', status: 'failed', column: 'stopped' });
  const waiting = card(3, { title: 'Trace the timeout', status: 'waiting_decision', column: 'waiting', waitingOnPrincipalId: 'riley', decisionId: 'd3' });

  it('answering others comes before your own stopped work, which comes before anything else', () => {
    expect(focusOf(work({ needsYou: [ask], stopped: [stopped], inProgress: [card(4)], waitingOnOthers: [waiting] }))).toEqual({ kind: 'answer', taskId: 't1', decisionId: 'd1', text: '1 decision is waiting on you. Start with "Review the retry plan" — the request expires in 21 hours.' });
    expect(focusOf(work({ stopped: [stopped], inProgress: [card(4)], waitingOnOthers: [waiting] }))).toMatchObject({ kind: 'look', taskId: 't2' });
    expect(focusOf(work({ inProgress: [card(4), card(5)], waitingOnOthers: [waiting] }))).toEqual({ kind: 'running', text: 'Nothing needs you. 2 tasks are in progress.' });
    expect(focusOf(work({ waitingOnOthers: [waiting] }))).toEqual({ kind: 'waiting', taskId: 't3', text: 'Nothing needs you. "Trace the timeout" is waiting on Riley.' });
    expect(focusOf(work())).toEqual({ kind: 'clear', text: 'Nothing needs you and nothing is running.' });
  });

  it('my work leads with the next thing, names projects and people, and has no controls', () => {
    const NOW = Date.parse('2026-11-13T12:00:00Z');
    const html = renderToStaticMarkup(<MyWorkView work={work({ needsYou: [ask], waitingOnOthers: [waiting], truncated: true })} taskHref={href} decisionHref={(id) => `/decisions/${id}`} now={NOW} />);
    expect(html.indexOf('Next:')).toBeLessThan(html.indexOf('id="work-needsYou"')); // the next thing comes first
    expect(html).toContain('data-focus="answer"');
    expect(html).toContain('href="/decisions/d1"'); // the next thing is one click away
    expect(html).toContain('Review now');
    expect(html).toContain('Orders API');
    expect(html).toContain('Waiting on Riley');
    expect(html).toContain('expires <time dateTime="2026-11-14T09:00:00Z"'); // relative wording, exact time kept in the markup
    expect(html).toContain('in 21 hours');
    expect(html).not.toMatch(/>\s*2026-11-1\dT/); // no raw timestamp is shown as text
    expect(html).toContain('some tasks are not listed');
    expect(html).not.toContain('id="work-inProgress"'); // empty sections are left out
    expect(html).not.toMatch(/<button|<form|<input|draggable/);
  });

  it('a board shows every column with its count, who each task waits on, spend, and titles as text', () => {
    const board: Board = { applicationId: 'app-1', name: 'Orders API', generatedAt: '2026-11-13T12:00:00Z', needsPerson: [waiting], spentThisMonthMicroUsd: 12_340_000, people, truncated: false,
      columns: { queued: [], running: [card(4, { title: '<img src=x onerror=alert(1)>', currentNodeId: 'investigate' })], waiting: [waiting], paused: [], done: [card(6, { status: 'succeeded', column: 'done' })], stopped: [stopped] } };
    const html = renderToStaticMarkup(<BoardView board={board} taskHref={href} now={Date.parse('2026-11-13T12:00:00Z')} />);
    const columns = [...html.matchAll(/data-column="(\w+)" data-empty="(\w+)"><h2 id="board-\w+"><span>([^<]+)<\/span> <span class="count-pill">(\d+)/g)].map((m) => [m[1], m[3], Number(m[4]), m[2]]);
    expect(columns).toEqual([['queued', 'Queued', 0, 'true'], ['running', 'Running', 1, 'false'], ['waiting', 'Waiting on a person', 1, 'false'], ['paused', 'Paused', 0, 'true'], ['done', 'Done', 1, 'false'], ['stopped', 'Stopped', 1, 'false']]);
    expect(html).toContain('<strong>1</strong> waiting on a person');
    expect(html).toContain('<strong>$12.34</strong> spent this month');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img');
    expect(html).toContain('Investigate'); // the stage in words, not its code
    expect(html).not.toContain('>investigate<');
    expect(html).toContain('Waiting on Riley');
    expect(html).toContain('href="/tasks/t3"');
    expect(html).not.toMatch(/<button|<form|<input|draggable/);
    expect(renderToStaticMarkup(<BoardView board={{ ...board, truncated: true }} taskHref={href} />)).toContain('too large to show in full');
  });
});
