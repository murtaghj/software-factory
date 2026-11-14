// P-02 (docs/plan-additions.md): the decision inbox view model, response builder and component.
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DecisionView } from '@factory/contracts';
import { DecisionInbox, INBOX_PATH, PLAN_SECTION_IDS, buildDecisionResponse, fetchInbox, inboxModel } from '../src/index.ts';

const NOW = Date.parse('2026-11-12T12:00:00Z');
const ref = (n: string) => ({ artifactId: `00000000-0000-4000-8000-${n.padStart(12, '0')}`, sha256: n.repeat(64).slice(0, 64), mediaType: 'application/json', schemaVersion: '2.0', sizeBytes: 10 });
const decision = (n: string, over: Partial<DecisionView> = {}): DecisionView => ({ id: `00000000-0000-4000-8000-${n.padStart(12, '0')}`, taskId: '00000000-0000-4000-8000-0000000000aa', action: 'approve_plan', subjectHash: n.repeat(64).slice(0, 64), subjectRef: ref('1'), policyRef: ref('2'), evidenceRefs: [ref('1')], eligibleRoles: ['reviewer'], state: 'pending', reason: 'Approve the exact plan <b>packet</b>', expiresAt: '2026-11-15T12:00:00Z', requiredPrincipalId: '00000000-0000-4000-8000-0000000000bb', ...over });
const input = { outcome: 'approve' as const, reason: 'Read in full.', reviewedSectionIds: [...PLAN_SECTION_IDS], commandId: '00000000-0000-4000-8000-0000000000cc', expectedRevision: 3 };

describe('P-02 decision inbox', () => {
  it('lists only pending items, soonest expiry first, with honest urgency', () => {
    const m = inboxModel([decision('1'), decision('2', { expiresAt: '2026-11-12T20:00:00Z' }), decision('3', { state: 'approved' }), decision('4', { expiresAt: '2026-11-12T11:00:00Z' })], NOW);
    expect(m.items.map((i) => [i.id.slice(-1), i.urgency])).toEqual([['4', 'expired'], ['2', 'soon'], ['1', 'normal']]);
    expect(m.summary).toBe('3 waiting on you, 1 expiring within a day.');
    expect(inboxModel([], NOW).summary).toBe('Nothing is waiting on you.');
    expect(m.items[2]?.sectionsToReview).toEqual(PLAN_SECTION_IDS);
  });

  it('builds a valid human response bound to the exact subject and revision', () => {
    const item = inboxModel([decision('1')], NOW).items[0];
    if (!item) throw new Error('no item');
    const built = buildDecisionResponse(item, input);
    expect(built).toEqual({ ok: true, body: { commandId: input.commandId, expectedRevision: 3, subjectHash: item.subjectHash, outcome: 'approve', reason: 'Read in full.', reviewedSectionIds: [...PLAN_SECTION_IDS], actorKind: 'human' } });
  });

  it('refuses an approval that skipped a section, an empty reason and an expired item; it never fills sections in', () => {
    const item = inboxModel([decision('1')], NOW).items[0];
    if (!item) throw new Error('no item');
    const partial = buildDecisionResponse(item, { ...input, reviewedSectionIds: PLAN_SECTION_IDS.filter((s) => s !== 'design') });
    expect(partial).toEqual({ ok: false, problems: ['Approval needs every section reviewed; missing: design.'] });
    expect(buildDecisionResponse(item, { ...input, reason: '   ' })).toMatchObject({ ok: false, problems: ['A reason is required.'] });
    // Rejecting or asking for changes does not need full coverage, and reports only what was read.
    const reject = buildDecisionResponse(item, { ...input, outcome: 'request_changes', reviewedSectionIds: ['design'] });
    expect(reject).toMatchObject({ ok: true, body: { outcome: 'request_changes', reviewedSectionIds: ['design'] } });
    const expired = inboxModel([decision('1', { expiresAt: '2026-11-12T11:59:59Z' })], NOW).items[0];
    if (!expired) throw new Error('no item');
    expect(buildDecisionResponse(expired, input)).toMatchObject({ ok: false, problems: ['This request has expired and can no longer be answered.'] });
  });

  it('fetches the caller\'s own inbox and refuses a malformed reply', async () => {
    const paths: string[] = [];
    const m = await fetchInbox((path) => { paths.push(path); return Promise.resolve({ status: 200, body: { items: [decision('1')] } }); }, NOW);
    expect(paths).toEqual([INBOX_PATH]);
    expect(INBOX_PATH).toContain('assignedTo=me');
    expect(m.items).toHaveLength(1);
    await expect(fetchInbox(() => Promise.resolve({ status: 403, body: {} }), NOW)).rejects.toThrow(/status 403/);
    await expect(fetchInbox(() => Promise.resolve({ status: 200, body: { items: [{ id: 'x' }] } }), NOW)).rejects.toThrow(/invalid DecisionView/);
  });

  it('renders text, not markup; says when nothing is waiting; and gives an expired item no answer link', () => {
    const href = { taskHref: (id: string) => `/tasks/${id}`, decisionHref: (id: string) => `/decisions/${id}` };
    const html = renderToStaticMarkup(<DecisionInbox model={inboxModel([decision('1'), decision('4', { expiresAt: '2026-11-12T11:00:00Z' })], NOW)} {...href} now={NOW} context={{ '00000000-0000-4000-8000-0000000000aa': { title: 'Why is checkout slow?', project: 'Orders API', askedBy: 'Dana (developer)' } }} />);
    expect(html).toContain('&lt;b&gt;packet&lt;/b&gt;');
    expect(html).not.toContain('<b>packet</b>');
    expect(html).toContain('Why is checkout slow?'); // which task, which project, who is asking
    expect(html).toContain('Orders API');
    expect(html).toContain('asked by Dana');
    expect(html).toContain('href="/decisions/00000000-0000-4000-8000-000000000001"');
    expect(html).not.toContain('href="/decisions/00000000-0000-4000-8000-000000000004"');
    expect(html).toContain('data-urgency="expired"');
    expect(html).toContain('No longer answerable');
    expect(html).toContain('in 3 days');
    const empty = renderToStaticMarkup(<DecisionInbox model={inboxModel([], NOW)} {...href} />);
    expect(empty).toContain('Nothing is waiting on you.');
    expect(empty).not.toContain('class="inbox"');
  });
});
