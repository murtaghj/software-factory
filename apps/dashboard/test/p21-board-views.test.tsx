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
    expect(focusOf(work({ needsYou: [ask], stopped: [stopped], inProgress: [card(4)], waitingOnOthers: [waiting] }))).toEqual({ kind: 'answer', taskId: 't1', decisionId: 'd1', text: '1 decision is waiting on you. Start with "Review the retry plan" (expires 2026-11-14T09:00:00Z).' });
    expect(focusOf(work({ stopped: [stopped], inProgress: [card(4)], waitingOnOthers: [waiting] }))).toMatchObject({ kind: 'look', taskId: 't2' });
    expect(focusOf(work({ inProgress: [card(4), card(5)], waitingOnOthers: [waiting] }))).toEqual({ kind: 'running', text: 'Nothing needs you. 2 tasks are in progress.' });
    expect(focusOf(work({ waitingOnOthers: [waiting] }))).toEqual({ kind: 'waiting', taskId: 't3', text: 'Nothing needs you. "Trace the timeout" is waiting on Riley.' });
    expect(focusOf(work())).toEqual({ kind: 'clear', text: 'Nothing needs you and nothing is running.' });
  });

  it('my work leads with the next thing, names projects and people, and has no controls', () => {
    const html = renderToStaticMarkup(<MyWorkView work={work({ needsYou: [ask], waitingOnOthers: [waiting], truncated: true })} taskHref={href} />);
    expect(html.indexOf('<strong>Next:</strong>')).toBeLessThan(html.indexOf('Needs you (1)'));
    expect(html).toContain('data-focus="answer"');
    expect(html).toContain('Orders API');
    expect(html).toContain('waiting on Riley');
    expect(html).toContain('some tasks are not listed');
    expect(html).not.toContain('In progress'); // empty sections are left out
    expect(html).not.toMatch(/<button|<form|<input|draggable/);
  });

  it('a board shows every column with its count, who each task waits on, spend, and titles as text', () => {
    const board: Board = { applicationId: 'app-1', name: 'Orders API', generatedAt: '2026-11-13T12:00:00Z', needsPerson: [waiting], spentThisMonthMicroUsd: 12_340_000, people, truncated: false,
      columns: { queued: [], running: [card(4, { title: '<img src=x onerror=alert(1)>', currentNodeId: 'investigate' })], waiting: [waiting], paused: [], done: [card(6, { status: 'succeeded', column: 'done' })], stopped: [stopped] } };
    const html = renderToStaticMarkup(<BoardView board={board} taskHref={href} />);
    for (const heading of ['Needs a person (1)', 'Queued (0)', 'Running (1)', 'Waiting on a person (1)', 'Paused (0)', 'Done (1)', 'Stopped (1)']) expect(html).toContain(heading);
    expect(html).toContain('spent this month $12.34');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img');
    expect(html).toContain('stage <code>investigate</code>');
    expect(html).toContain('href="/tasks/t3"');
    expect(html).not.toMatch(/<button|<form|<input|draggable/);
    expect(renderToStaticMarkup(<BoardView board={{ ...board, truncated: true }} taskHref={href} />)).toContain('too large to show in full');
  });
});
