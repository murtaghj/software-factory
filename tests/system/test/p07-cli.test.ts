// P-07 (docs/plan-additions.md): the `factory` CLI against the real API. A developer submits and
// follows a task, a reviewer answers from an interactive terminal, and the same decision commands
// refuse to run without one (INV-29: an agent's shell cannot give a human approval).
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { EXIT, run, type CliIo } from '@factory/cli';
import { FactoryClient } from '@factory/client';
import { createSystemHarness, type SystemHarness, type SystemUser } from '../src/index.ts';
import { investigation, pendingDecision, pump, waitStatus } from './support.ts';

describe('P-07 factory CLI', () => {
  let h: SystemHarness;
  let developer: SystemUser;
  let reviewer: SystemUser;
  let operator: SystemUser;
  let dir: string;
  beforeAll(async () => {
    h = await createSystemHarness('p07', { temporal: { fakeStage: { delayMs: (n) => (n === 'investigate' ? 1200 : 0) } } });
    developer = await h.user([{ role: 'contributor', scope: [h.applicationId] }]);
    reviewer = await h.user([{ role: 'reviewer', scope: [h.applicationId] }]);
    operator = await h.user([{ role: 'operator', scope: [h.applicationId] }]);
    dir = mkdtempSync(join(tmpdir(), 'factory-cli-'));
  }, 300_000);
  afterAll(async () => { await h.close(); rmSync(dir, { recursive: true, force: true }); });

  type Shell = { code: number; out: string[]; err: string[]; asked: string[] };
  // Runs the CLI as `user`. `typed` is what the person types at a confirmation prompt; leaving it
  // out means there is no interactive terminal. The harness dispatches while the CLI waits.
  const factory = async (user: SystemUser, argv: string[], typed?: string): Promise<Shell> => {
    const s: Shell = { code: -1, out: [], err: [], asked: [] };
    const io: CliIo = {
      client: new FactoryClient({ baseUrl: h.apiUrl, token: () => user.token() }),
      out: (l) => { s.out.push(l); }, err: (l) => { s.err.push(l); },
      isTTY: typed !== undefined, ask: (q) => { s.asked.push(q); return Promise.resolve(typed ?? ''); },
      readFile: (p) => Promise.resolve(readFileSync(p, 'utf8')), writeFile: (p, t) => { writeFileSync(p, t, { flag: 'wx' }); return Promise.resolve(); },
      now: () => Date.now(), uuid: () => randomUUID(), sleep: async (ms) => { await h.temporal?.dispatch(); await new Promise((r) => setTimeout(r, Math.min(ms, 50))); },
    };
    s.code = await run(argv, io);
    return s;
  };
  const requestFile = (name: string, body: unknown): string => { const p = join(dir, name); writeFileSync(p, JSON.stringify(body)); return p; };

  it('submit, status, list and evidence; a reviewer approves from a terminal; the operator exports the outcome', async () => {
    const file = requestFile('task.json', investigation(h.applicationId));
    const submitted = await factory(developer, ['submit', file, '--key', 'cli-submit-0001', '--json']);
    expect(submitted.code).toBe(EXIT.ok);
    const taskId = (JSON.parse(submitted.out.join('\n')) as { taskId: string }).taskId;
    expect((JSON.parse((await factory(developer, ['submit', file, '--key', 'cli-submit-0001', '--json'])).out.join('\n')) as { taskId: string }).taskId).toBe(taskId);
    const d = await pendingDecision(h, developer, taskId);

    const status = await factory(developer, ['status', taskId]);
    expect(status.out[0]).toContain('waiting_decision');
    expect(status.out.join('\n')).toContain('waiting: plan_review');
    const inbox = await factory(reviewer, ['inbox']);
    expect(inbox.out[0]).toBe('1 waiting on you.');
    expect(inbox.out[1]).toContain(d.id);
    expect((await factory(developer, ['inbox'])).out).toEqual(['Nothing is waiting on you.']);

    // No interactive terminal: refused before anything is sent, whatever flags are given.
    const scripted = await factory(reviewer, ['approve', d.id, '--reason', 'automated', '--reviewed-all']);
    expect(scripted).toMatchObject({ code: EXIT.usage, asked: [] });
    expect(scripted.err.join(' ')).toMatch(/human decision and needs an interactive terminal/);
    // At a terminal: partial coverage is refused, a wrong confirmation sends nothing.
    expect((await factory(reviewer, ['approve', d.id, '--reason', 'skimmed', '--reviewed', 'design'], 'approve')).err.join(' ')).toMatch(/every section reviewed/);
    const declined = await factory(reviewer, ['approve', d.id, '--reason', 'Read in full.', '--reviewed-all'], 'yes');
    expect(declined).toMatchObject({ code: EXIT.refused });
    expect(declined.err).toEqual(['factory: not confirmed; nothing was sent.']);
    expect((await h.call(reviewer, 'GET', `/v2/decisions/${d.id}`)).body).toMatchObject({ state: 'pending' });
    // The author cannot approve their own plan: the API's refusal is shown with its code.
    const self = await factory(developer, ['approve', d.id, '--reason', 'mine', '--reviewed-all'], 'approve');
    expect(self.code).toBe(EXIT.refused);
    expect(self.err[0]).toMatch(/^factory: not_the_required_peer/);

    const approved = await factory(reviewer, ['approve', d.id, '--reason', 'Read in full.', '--reviewed-all', '--wait'], 'approve');
    expect(approved.code, approved.err.join('\n')).toBe(EXIT.ok);
    expect(approved.asked).toEqual(['Type "approve" to approve as yourself: ']);
    expect(approved.out.join('\n')).toContain('you confirm you reviewed: intent_scope');
    expect(approved.out.at(-1)).toMatch(/: applied$/);

    await waitStatus(h, developer, taskId, ['succeeded']);
    expect((await factory(developer, ['list', '--status', 'succeeded'])).out.join('\n')).toContain(taskId);
    const evidence = (await factory(developer, ['evidence', taskId])).out.join('\n');
    expect(evidence).toMatch(/deliver\s+attempt 1\s+passed/);
    expect(evidence).toMatch(/outcome_recorded\s+passed/);

    // Export: operators only; the file is written once and never overwritten.
    const out = join(dir, 'bundle.json');
    const denied = await factory(developer, ['export', taskId, '--out', out]);
    expect(denied.code).toBe(EXIT.refused);
    expect(denied.err[0]).toMatch(/^factory: outcome_export_not_authorized/);
    expect(existsSync(out)).toBe(false);
    const exported = await factory(operator, ['export', taskId, '--out', out]);
    expect(exported.code).toBe(EXIT.ok);
    expect((JSON.parse(readFileSync(out, 'utf8')) as { taskId: string; reviewMode: string })).toMatchObject({ taskId, reviewMode: 'human' });
    await expect(factory(operator, ['export', taskId, '--out', out])).rejects.toThrow(/EEXIST/);
  }, 180_000);

  it('pause, resume and cancel with --wait report what the workflow did; a closed task is refused', async () => {
    const taskId = (JSON.parse((await factory(developer, ['submit', requestFile('t2.json', investigation(h.applicationId)), '--json'])).out.join('\n')) as { taskId: string }).taskId;
    const d = await pendingDecision(h, developer, taskId);
    expect((await factory(reviewer, ['approve', d.id, '--reason', 'ok', '--reviewed-all', '--wait'], 'approve')).code).toBe(EXIT.ok);
    await pump(h, async () => ((await factory(developer, ['status', taskId, '--json'])).out.join('').includes('"currentNodeId": "investigate"') ? true : undefined));
    expect((await factory(developer, ['pause', taskId])).err).toEqual(['factory: pause needs --reason']);
    const paused = await factory(developer, ['pause', taskId, '--reason', 'hold on', '--wait']);
    expect(paused.out.at(-1)).toMatch(/: applied$/);
    expect((await waitStatus(h, developer, taskId, ['paused'])).status).toBe('paused');
    expect((await factory(developer, ['resume', taskId, '--reason', 'go', '--wait'])).out.at(-1)).toMatch(/: applied$/);
    const cancelled = await factory(developer, ['cancel', taskId, '--reason', 'no longer needed', '--wait', '--json']);
    const receipt = JSON.parse(cancelled.out.join('\n')) as { commandId: string; state: string };
    expect(receipt.state).toBe('applied');
    expect((await factory(developer, ['receipt', receipt.commandId])).out).toEqual([`command ${receipt.commandId}: applied`]);
    await waitStatus(h, developer, taskId, ['cancelled']);
    const late = await factory(developer, ['pause', taskId, '--reason', 'too late']);
    expect(late.code).toBe(EXIT.refused);
    expect(late.err[0]).toMatch(/^factory: task_terminal/);
  }, 120_000);

  it('usage errors never reach the API; an invalid request file lists what is wrong', async () => {
    expect((await factory(developer, ['status', 'not-a-uuid'])).err).toEqual(['factory: taskId must be a UUID']);
    expect((await factory(developer, ['frobnicate'])).code).toBe(EXIT.usage);
    expect((await factory(developer, ['list', '--bogus'])).code).toBe(EXIT.usage);
    const bad = await factory(developer, ['submit', requestFile('bad.json', { title: 'nope' })]);
    expect(bad.code).toBe(EXIT.usage);
    expect(bad.err[0]).toMatch(/not a valid TaskRequest/);
    expect((await factory(developer, ['--help'])).out.join('\n')).toContain('factory inbox');
    expect((await factory(developer, ['status', randomUUID()])).err[0]).toMatch(/^factory: not_found/);
  });
});
