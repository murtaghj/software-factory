// The launcher: nothing starts before `start: true`, the program gets umask 027 and its own process group, TERM reaches the group and KILL follows, and no pid is negative but the group helper's.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { groupAlive } from '../src/group.ts';
import { runLauncher } from '../src/launcher.ts';
import { startLocalEndpoint } from '../src/local-endpoint.ts';
import { State } from '../src/state.ts';

let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'w019-launcher-')); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });
const wait = async (what: string, cond: () => boolean, ms = 8000): Promise<void> => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`); await new Promise((r) => setTimeout(r, 25)); } };
async function rig() {
  const state = new State();
  const e = await startLocalEndpoint({ state, port: 0, pollMs: 300, onHint: () => undefined });
  const term = new AbortController();
  return { state, e, term, url: `http://127.0.0.1:${String(e.port)}` };
}
const script = (name: string, code: string): string => { const p = join(dir, name); writeFileSync(p, code); return p; };

describe('W-019 the launcher', () => {
  it('no program starts before start:true (a marker file is absent while the poll is held); control: it appears after', async () => {
    const r = await rig();
    const marker = join(dir, 'marker-1');
    const prog = script('marker.js', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'); setTimeout(() => process.exit(0), 50);`);
    const done = runLauncher({ argv: ['harness', '--supervisor', r.url, '--', process.execPath, prog], term: r.term.signal });
    await new Promise((x) => setTimeout(x, 800)); // several held polls
    expect(existsSync(marker)).toBe(false);
    r.state.set('running');
    await wait('the marker', () => existsSync(marker));
    expect(await done).toBe(0);
    await r.e.close();
  });

  it('start:false exits non-zero with no program; TERM before the start exits 143 with no program; a bad command line is 64', async () => {
    const r = await rig();
    const marker = join(dir, 'marker-2');
    const prog = script('marker2.js', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x');`);
    r.state.fence('gate_failed');
    expect(await runLauncher({ argv: ['harness', '--supervisor', r.url, '--', process.execPath, prog], term: r.term.signal })).toBe(1);
    expect(existsSync(marker)).toBe(false);
    const r2 = await rig();
    const early = runLauncher({ argv: ['harness', '--supervisor', r2.url, '--', process.execPath, prog], term: r2.term.signal });
    await new Promise((x) => setTimeout(x, 300));
    r2.term.abort();
    expect(await early).toBe(143);
    expect(existsSync(marker)).toBe(false);
    expect(await runLauncher({ argv: ['harness', '--supervisor', 'http://10.0.0.1:8765', '--', 'x'], term: new AbortController().signal })).toBe(64); // not the loopback endpoint
    expect(await runLauncher({ argv: ['harness', '--supervisor', r.url], term: new AbortController().signal })).toBe(64);
    await r.e.close(); await r2.e.close();
  });

  it('TERM reaches the program\'s group and KILL follows for a program that ignores it; the program\'s umask is 027; the exit hint is sent after the program ends', async () => {
    const r = await rig();
    r.state.set('running');
    const out = join(dir, 'umask-file'); const pidFile = join(dir, 'pid');
    const prog = script('ignore.js', `process.on('SIGTERM', () => {}); require('fs').writeFileSync(${JSON.stringify(out)}, 'x'); require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
    let hints = 0;
    const e2 = await startLocalEndpoint({ state: r.state, port: 0, pollMs: 300, onHint: () => { hints += 1; } });
    const done = runLauncher({ argv: ['harness', '--supervisor', `http://127.0.0.1:${String(e2.port)}`, '--', process.execPath, prog], term: r.term.signal, killAfterMs: 400 });
    await wait('the program', () => existsSync(pidFile));
    expect(statSync(out).mode & 0o777).toBe(0o640); // umask 027 on a 0666 create
    const pid = Number(readFileSync(pidFile, 'utf8'));
    expect(groupAlive(pid)).toBe(true); // it leads its own process group
    r.term.abort();
    expect(await done).toBe(137); // TERM was ignored; KILL ended it
    expect(groupAlive(pid)).toBe(false);
    expect(hints).toBe(1);
    // control: a program that handles TERM ends with its own code, before the KILL
    const r3 = await rig();
    r3.state.set('running');
    const polite = script('polite.js', `process.on('SIGTERM', () => process.exit(7)); require('fs').writeFileSync(${JSON.stringify(join(dir, 'polite-up'))}, 'x'); setInterval(() => {}, 1000);`);
    const done3 = runLauncher({ argv: ['harness', '--supervisor', r3.url, '--', process.execPath, polite], term: r3.term.signal, killAfterMs: 5000 });
    await wait('polite up', () => existsSync(join(dir, 'polite-up')));
    r3.term.abort();
    expect(await done3).toBe(7);
    await r.e.close(); await e2.close(); await r3.e.close();
  });

  it('the supervisor\'s stop answers: the launcher sends TERM to the group when /v1/stop answers', async () => {
    const r = await rig();
    r.state.set('running');
    const up = join(dir, 'stop-up');
    const prog = script('stopme.js', `process.on('SIGTERM', () => process.exit(9)); require('fs').writeFileSync(${JSON.stringify(up)}, 'x'); setInterval(() => {}, 1000);`);
    const done = runLauncher({ argv: ['harness', '--supervisor', r.url, '--', process.execPath, prog], term: r.term.signal });
    await wait('up', () => existsSync(up));
    r.state.setStop();
    expect(await done).toBe(9);
    await r.e.close();
  });

  it('structural: no negative pid in the supervisor\'s source but the group helper\'s', () => {
    const src = join(import.meta.dirname, '..', 'src');
    const files = readdirSync(src, { recursive: true, withFileTypes: true }).filter((d) => d.isFile() && d.name.endsWith('.ts')).map((d) => join(d.parentPath, d.name));
    const bad = files.filter((f) => !f.endsWith('/group.ts') && /process\.kill\(\s*-/.test(readFileSync(f, 'utf8')));
    expect(bad).toEqual([]);
    expect(/process\.kill\(-pgid/.test(readFileSync(join(src, 'group.ts'), 'utf8'))).toBe(true); // control: the helper has it
    expect(() => groupAlive(1)).not.toThrow();
  });
});
