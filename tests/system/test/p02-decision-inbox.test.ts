// P-02 (docs/plan-additions.md): the dashboard's decision inbox against the real API. The inbox is
// the caller's own; the response it builds for the human is accepted and applied; and an answered
// item leaves the inbox.
import { randomUUID } from 'node:crypto';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { PLAN_SECTION_IDS, buildDecisionResponse, fetchInbox } from '@factory/dashboard';
import { createSystemHarness, type SystemHarness, type SystemUser } from '../src/index.ts';
import { commandState, createTask, getTask, pendingDecision, waitStatus } from './support.ts';

describe('P-02 decision inbox (full stack)', () => {
  let h: SystemHarness;
  let developer: SystemUser;
  let reviewer: SystemUser;
  beforeAll(async () => {
    h = await createSystemHarness('p02', { temporal: {} });
    developer = await h.user([{ role: 'contributor', scope: [h.applicationId] }]);
    reviewer = await h.user([{ role: 'reviewer', scope: [h.applicationId] }]);
  }, 300_000);
  afterAll(async () => { await h.close(); });
  const inbox = (user: SystemUser) => fetchInbox((path) => h.call(user, 'GET', path), Date.now());

  it('shows the reviewer exactly what waits on them; their built response is applied and the item leaves the inbox', async () => {
    const first = await createTask(h, developer);
    const second = await createTask(h, developer);
    const d1 = await pendingDecision(h, developer, first);
    const d2 = await pendingDecision(h, developer, second);
    expect((await inbox(developer)).items).toEqual([]); // the author is never asked
    const mine = await inbox(reviewer);
    expect(mine.items.map((i) => i.id).sort()).toEqual([d1.id, d2.id].sort());
    expect(mine.summary).toBe('2 waiting on you.');
    const item = mine.items.find((i) => i.id === d1.id);
    if (!item) throw new Error('decision not in inbox');

    const revision = (await getTask(h, reviewer, first)).revision;
    // Skipping a section is refused before any request is sent.
    expect(buildDecisionResponse(item, { outcome: 'approve', reason: 'Looks fine.', reviewedSectionIds: ['design'], commandId: randomUUID(), expectedRevision: revision }).ok).toBe(false);
    const built = buildDecisionResponse(item, { outcome: 'approve', reason: 'Read every section.', reviewedSectionIds: [...PLAN_SECTION_IDS], commandId: randomUUID(), expectedRevision: revision });
    if (!built.ok) throw new Error(built.problems.join('; '));
    const sent = await h.call(reviewer, 'POST', `/v2/decisions/${item.id}/responses`, built.body, { 'idempotency-key': randomUUID() });
    expect(sent.status).toBe(202);
    expect(await commandState(h, reviewer, built.body.commandId)).toMatchObject({ state: 'applied' });
    expect((await waitStatus(h, developer, first, ['succeeded'])).status).toBe('succeeded');
    expect((await inbox(reviewer)).items.map((i) => i.id)).toEqual([d2.id]);
  }, 120_000);
});
