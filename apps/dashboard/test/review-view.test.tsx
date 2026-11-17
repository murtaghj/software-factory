// Direction B review fixes: the decision review. Approve is an ordinary key until every section is read,
// and is lit only at the end; the page reads well to a screen reader and a keyboard.
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DecisionView } from '@factory/contracts';
import { PLAN_SECTION_IDS, inboxModel } from '@factory/client';
import { DecisionReview, Notice, Shell, TaskActions, type ReviewState } from '../src/index.ts';

const NOW = Date.parse('2026-11-12T12:00:00Z');
const ref = { artifactId: '00000000-0000-4000-8000-000000000001', sha256: '1'.repeat(64), mediaType: 'application/json', schemaVersion: '2.0', sizeBytes: 10 };
const decision: DecisionView = { id: '00000000-0000-4000-8000-000000000002', taskId: '00000000-0000-4000-8000-0000000000aa', action: 'approve_plan', subjectHash: '2'.repeat(64), subjectRef: ref, policyRef: ref, evidenceRefs: [ref], eligibleRoles: ['reviewer'], state: 'pending', reason: 'Approve the exact engineering plan packet before implementation', expiresAt: '2026-11-14T12:00:00Z', requiredPrincipalId: '00000000-0000-4000-8000-0000000000bb' };
const item = inboxModel([decision], NOW).items[0];
const render = (state: Partial<ReviewState>) => renderToStaticMarkup(<DecisionReview decision={decision} item={item} taskTitle="Why do orders fail?" now={NOW} state={{ reviewed: [], reason: '', problems: [], sending: false, ...state }} onToggle={() => undefined} onReason={() => undefined} onAnswer={() => undefined} context={{ project: 'Orders API', askedBy: 'Dana (developer)' }} />);
const approve = (html: string) => /<button type="button" class="([^"]*)"([^>]*)>Approve plan<\/button>/.exec(html);

describe('decision review', () => {
  it('Approve is an outlined key until all sections are read, then lit; it says what it waits for', () => {
    const none = approve(render({}));
    expect(none?.[1]).toBe('key tall');
    expect(none?.[2]).toContain('aria-describedby="read-count"');
    expect(render({})).toContain('id="read-count"');
    expect(approve(render({ reviewed: PLAN_SECTION_IDS.slice(0, 11) }))?.[1]).toBe('key tall');
    expect(approve(render({ reviewed: [...PLAN_SECTION_IDS] }))?.[1]).toBe('key on tall');
    expect(render({ reviewed: [...PLAN_SECTION_IDS] })).toContain('12 of 12 read');
  });

  it('reads in numbers and plain words: "all 12", the ask without the worker\'s reason, a refusal shown in place', () => {
    const html = render({ problems: ['Approval needs every section reviewed; missing: Design.'] });
    expect(html).toContain('Approval needs all 12.');
    expect(html).not.toContain('twelve');
    expect(html).not.toContain('engineering plan packet');
    expect(html).toContain('Dana asked you to approve the plan for Orders API.');
    expect(html).toContain('role="alert"');
    expect(html).toContain('tabindex="-1"'); // the first problem can take focus
  });

  it('a checkbox is named by the section alone, and the fields have names and end their placeholders with an ellipsis', () => {
    const html = render({});
    expect(html).toContain('<span class="n" aria-hidden="true">1</span>');
    expect(html).toContain('name="reason"');
    expect(html).toContain('placeholder="What did you check, or what has to change…"');
    const task = renderToStaticMarkup(<TaskActions task={{ status: 'running' } as never} busy={false} reason="" onReason={() => undefined} onCommand={() => undefined} />);
    expect(task).toContain('name="reason"');
    expect(task).toContain('placeholder="Why are you pausing or cancelling…"');
  });

  it('the frame: no aria-label on a bare span, the allowance said in words, and a skip link that does not change the address', () => {
    const me = { principalId: 'p', displayName: 'Riley (reviewer)', roles: ['reviewer'], projects: [] };
    const html = renderToStaticMarkup(<Shell me={me} route={{ page: 'work' }} inboxCount={2} allowance={{ enrolled: true, limitMicroUsd: 60_000_000, remainingMicroUsd: 7_000_000 }} onSignOut={() => undefined}><p>x</p></Shell>);
    expect(html).not.toMatch(/<span[^>]*aria-label/);
    expect(html).toContain('2<span class="visually-hidden"> waiting on you</span>');
    expect(html).toContain('12% of your allowance is left.');
    expect(html).toContain('<a class="skip" href="#main">');
    expect(renderToStaticMarkup(<Notice kind="error" onRetry={() => undefined}>Nope</Notice>)).toContain('Try again');
  });
});
