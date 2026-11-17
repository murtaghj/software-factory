// P-21 (docs/plan-additions.md): the board view. It shows who a task waits on, admits truncation,
// renders untrusted titles as text, and offers no control that could change a task. What to do next
// is the server's ranked queue (P-24; apps/dashboard/test/p24-queue-view.test.tsx).
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BoardView, type Board, type TaskCard } from '../src/index.ts';

const card = (n: number, over: Partial<TaskCard> = {}): TaskCard => ({ taskId: `t${String(n)}`, applicationId: 'app-1', title: `Task ${String(n)}`, status: 'running', column: 'running', workType: 'investigation', creatorId: 'dana', ownerPrincipalId: 'dana', updatedAt: `2026-11-13T10:0${String(n)}:00Z`, ...over });
const people = { dana: 'Dana', riley: 'Riley' };
const href = (id: string) => `/tasks/${id}`;
const LINE = [{ nodeId: 'scope', label: 'Scope', gate: false }, { nodeId: 'plan_review', label: 'Plan review', gate: true }, { nodeId: 'investigate', label: 'Investigate', gate: false }];

describe('P-21 board view', () => {
  const stopped = card(2, { title: 'Why is checkout slow?', status: 'failed', column: 'stopped' });
  const waiting = card(3, { title: 'Trace the timeout', status: 'waiting_decision', column: 'waiting', waitingOnPrincipalId: 'riley', decisionId: 'd3' });

  it('a board shows every column with its count, who each task waits on, spend, and titles as text', () => {
    const board: Board = { applicationId: 'app-1', name: 'Orders API', generatedAt: '2026-11-13T12:00:00Z', needsPerson: [waiting], stations: LINE, spentThisMonthMicroUsd: 12_340_000, people, truncated: false,
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
    // Where a task is, as the server said it: the card's mark is the line in miniature, and says so in words.
    const placed = renderToStaticMarkup(<BoardView board={{ ...board, columns: { ...board.columns, running: [card(4, { title: 'Placed', stage: { nodeId: 'plan_review', label: 'Plan review', index: 2, count: 3, gate: true } })] } }} taskHref={href} now={Date.parse('2026-11-13T12:00:00Z')} />);
    expect(placed).toContain('role="img" aria-label="Stage 2 of 3: Plan review"');
    expect(placed).toContain('<i class="done"></i><i class="gate here"></i><i></i>');
    expect(html).not.toContain('class="mini"'); // no position from the server: no mark
    // A merged line longer than the card's own plan is not drawn: only the card's own 3 stations, and the words match.
    const own = renderToStaticMarkup(<BoardView board={{ ...board, stations: [...LINE, { nodeId: 'extra', label: 'Extra', gate: false }, { nodeId: 'more', label: 'More', gate: false }], columns: { ...board.columns, running: [card(4, { title: 'Own', stage: { nodeId: 'investigate', label: 'Investigate', index: 3, count: 3, gate: false } })] } }} taskHref={href} now={Date.parse('2026-11-13T12:00:00Z')} />);
    expect(own).toContain('aria-label="Stage 3 of 3: Investigate"');
    expect(own).toContain('<i class="done"></i><i class="done"></i><i class="here"></i></span>'); // three marks, no more
    expect(html).toContain('href="/tasks/t3"');
    expect(html).not.toMatch(/<button|<form|<input|draggable/);
    expect(renderToStaticMarkup(<BoardView board={{ ...board, truncated: true }} taskHref={href} />)).toContain('too large to show in full');
  });
});
