// P-21 (docs/plan-additions.md): the board view. It shows who a task waits on, admits truncation,
// renders untrusted titles as text, and offers no control that could change a task. What to do next
// is the server's ranked queue (P-24; apps/dashboard/test/p24-queue-view.test.tsx).
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BoardView, type Board, type TaskCard } from '../src/index.ts';

const card = (n: number, over: Partial<TaskCard> = {}): TaskCard => ({ taskId: `t${String(n)}`, applicationId: 'app-1', title: `Task ${String(n)}`, status: 'running', column: 'running', workType: 'investigation', creatorId: 'dana', ownerPrincipalId: 'dana', updatedAt: `2026-11-13T10:0${String(n)}:00Z`, ...over });
const people = { dana: 'Dana', riley: 'Riley' };
const href = (id: string) => `/tasks/${id}`;

describe('P-21 board view', () => {
  const stopped = card(2, { title: 'Why is checkout slow?', status: 'failed', column: 'stopped' });
  const waiting = card(3, { title: 'Trace the timeout', status: 'waiting_decision', column: 'waiting', waitingOnPrincipalId: 'riley', decisionId: 'd3' });

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
