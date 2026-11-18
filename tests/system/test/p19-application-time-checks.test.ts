import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { createSystemHarness, type SystemHarness, type SystemUser } from '../src/index.ts';
import { createTask, pendingDecision, pump, respond, waitStatus } from './support.ts';

// P-19: two review fixes that act when a decision is applied or when the outcome is recorded.
describe('P-19 checks made at application time (full stack)', () => {
  const latch: { promise: Promise<void>; release: () => void } = (() => { let release: () => void = () => undefined; const promise = new Promise<void>((r) => { release = r; }); return { promise, release }; })();
  let h: SystemHarness;
  let owner: SystemUser;
  let reviewer: SystemUser;
  beforeAll(async () => {
    // The investigate stage waits on a latch the test releases, so the window between approval and the
    // outcome lasts exactly as long as the test needs it, however loaded the machine is.
    h = await createSystemHarness('p19sys', { temporal: { fakeStage: { hold: (n) => (n === 'investigate' ? latch.promise : undefined) } } });
    owner = await h.user([{ role: 'contributor', scope: [h.applicationId] }]);
    reviewer = await h.user([{ role: 'reviewer', scope: [h.applicationId] }]);
  }, 300_000);
  afterAll(async () => { latch.release(); await h.close(); });

  const gate = (taskId: string) => h.tx(async (t) => (await t.query<{ verdict: string; reason_codes: string[] }>("SELECT verdict, reason_codes FROM factory.gate_evaluation WHERE task_id = $1 AND gate_id = 'plan_peer_approved'", [taskId])).rows[0]);

  // Expiry is not stored in a column the application role may change, so the test moves it as the
  // database administrator.
  const expireNow = async (decisionId: string) => {
    const admin = new pg.Client({ connectionString: h.m.adminUrl });
    await admin.connect();
    try { await admin.query("UPDATE factory.decision_request SET expires_at = now() - interval '1 second' WHERE id = $1", [decisionId]); } finally { await admin.end(); }
  };

  it('an approval accepted at ingress but applied after the request expired does not pass the gate', async () => {
    const taskId = await createTask(h, owner);
    const d = await pendingDecision(h, owner, taskId);
    const r = await respond(h, reviewer, taskId, d);
    expect(r.status).toBe(202); // accepted while the request was live; not delivered yet (no dispatch pass ran)
    await expireNow(d.id);
    const done = await waitStatus(h, owner, taskId, ['incomplete', 'succeeded', 'failed']);
    expect(done.status).toBe('incomplete');
    expect(await gate(taskId)).toEqual({ verdict: 'failed', reason_codes: ['decision_expired'] });
  });

  it('a human-mode gate that is not backed by a cited human decision stops the outcome from being recorded', async () => {
    const taskId = await createTask(h, owner);
    const d = await pendingDecision(h, owner, taskId);
    expect((await respond(h, reviewer, taskId, d)).status).toBe(202);
    // The plan_peer_approved gate passes on the approval; then, while the investigation runs, the
    // approval stops being a recorded human approval of that subject.
    await pump(h, async () => ((await h.tx(async (t) => (await t.query("SELECT 1 FROM factory.stage_run WHERE task_id = $1 AND node_id = 'investigate' AND status = 'running'", [taskId])).rowCount)) ? true : undefined));
    expect((await gate(taskId))?.verdict).toBe('passed');
    await h.tx((t) => t.query("UPDATE factory.decision_request SET state = 'rejected' WHERE id = $1", [d.id]));
    latch.release();
    const done = await waitStatus(h, owner, taskId, ['succeeded', 'incomplete', 'failed']);
    expect(done.status).toBe('failed');
    const close = await h.tx(async (t) => (await t.query<{ status: string; error_class: string }>("SELECT status, error_class FROM factory.stage_run WHERE task_id = $1 AND node_id = 'close'", [taskId])).rows[0]);
    expect(close).toEqual({ status: 'failed', error_class: 'human_gate_without_decision:plan_peer_approved' });
  });
});
