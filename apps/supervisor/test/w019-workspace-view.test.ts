// The workspace view: built only from a grant, and only in `preparing`.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mintGrant } from '../src/grant.ts';
import { State, type SupervisorState } from '../src/state.ts';
import { ViewRefused, WorkspaceView } from '../src/workspace-view.ts';
import { IDS } from './kit.ts';

let root: string;
const ORG = IDS.orgId; const WS = '33333333-3333-4333-8333-333333333333';
beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'w019-view-')); });
afterAll(() => { rmSync(root, { recursive: true, force: true }); });
const grant = mintGrant({ granted: true, allocationId: IDS.allocationId, generation: 1, epoch: 1, podUid: 'p', leaseSeconds: 60, beatSeconds: 10 });
const tree = (name: string): string => { const w = join(root, name); mkdirSync(join(w, 'factory', ORG, WS, 'g1', 'work', 'main'), { recursive: true }); writeFileSync(join(w, 'factory', ORG, WS, 'g1', 'work', 'main', 'README.md'), 'x'); return w; };
const view = (w: string, state: State, g = grant): WorkspaceView => new WorkspaceView({ grant: g, state, workspaceRoot: w, org: ORG, workspace: WS, generation: 1, log: () => undefined });
const inState = (s: SupervisorState): State => { const st = new State(); st.set(s); return st; };

describe('W-019 the workspace view', () => {
  it('in preparing a materialized tree passes and is listed; every call is logged', () => {
    const w = tree('ok');
    const ev: Array<[string, Record<string, unknown> | undefined]> = [];
    const events = { filter: (f: (e: string) => boolean): string[] => ev.map(([e]) => e).filter(f) };
    const v = new WorkspaceView({ grant, state: inState('preparing'), workspaceRoot: w, org: ORG, workspace: WS, generation: 1, log: (e, d) => ev.push([e, d]) });
    expect(v.checkout()).toEqual(['README.md']);
    expect(events.filter((e) => e === 'workspace_view_lstat')).toHaveLength(6);
    expect(ev.map(([e]) => e)).toContain('workspace_view_list');
    // an unreadable work/main logs no listing line (the 0700 failure this evidence is for)
    const w2 = tree('unreadable'); chmodSync(join(w2, 'factory', ORG, WS, 'g1', 'work', 'main'), 0o000);
    const ev2: Array<[string, Record<string, unknown> | undefined]> = [];
    const v2 = new WorkspaceView({ grant, state: inState('preparing'), workspaceRoot: w2, org: ORG, workspace: WS, generation: 1, log: (e, d) => ev2.push([e, d]) });
    expect(() => v2.checkout()).toThrow(ViewRefused);
    expect(ev2.some(([e]) => e === 'workspace_view_list')).toBe(false);
    chmodSync(join(w2, 'factory', ORG, WS, 'g1', 'work', 'main'), 0o755);
    expect(ev.find(([e]) => e === 'workspace_view_list')?.[1]).toEqual({ entries: 1 });
  });

  it('it cannot be built without a grant: a hand-made object, a spread copy of a real grant and nothing at all are all refused at runtime', () => {
    const w = tree('nogrant');
    const forged = { ...grant };
    expect(() => view(w, inState('preparing'), forged)).toThrow(TypeError);
    expect(() => view(w, inState('preparing'), {} as never)).toThrow(TypeError);
    expect(() => view(w, inState('preparing'), null as never)).toThrow(TypeError);
    expect(() => view(w, inState('preparing'))).not.toThrow(); // control: the real grant
  });

  it('every method throws in any state but preparing, running included; control: the same call in preparing works', () => {
    const w = tree('states');
    for (const s of ['boot', 'gating', 'acquiring', 'running', 'ending', 'fenced'] as const) {
      expect(() => view(w, inState(s)).checkout(), s).toThrow(ViewRefused);
      expect(() => view(w, inState(s)).checkout(), s).toThrow(/only in preparing/);
    }
    expect(view(w, inState('preparing')).checkout()).toEqual(['README.md']);
    // and a state that changes between the walk and the listing is caught by the second assertion
    const st = inState('preparing');
    const v = view(w, st);
    st.set('running');
    expect(() => v.checkout()).toThrow(ViewRefused);
  });

  it('a symlink at any component, a file where a directory should be, and a missing work each fail with their own reason', () => {
    const reasons = (w: string): string => { try { view(w, inState('preparing')).checkout(); return 'passed'; } catch (e) { return e instanceof ViewRefused ? e.reason : 'other'; } };
    const a = tree('symlink'); const real = join(a, 'elsewhere'); mkdirSync(real);
    rmSync(join(a, 'factory', ORG, WS, 'g1', 'work'), { recursive: true }); symlinkSync(real, join(a, 'factory', ORG, WS, 'g1', 'work'));
    expect(reasons(a)).toBe('symlink_component');
    const b = tree('file');
    rmSync(join(b, 'factory', ORG, WS, 'g1', 'work'), { recursive: true }); writeFileSync(join(b, 'factory', ORG, WS, 'g1', 'work'), 'a file');
    expect(reasons(b)).toBe('not_a_directory');
    const c = tree('missing');
    rmSync(join(c, 'factory', ORG, WS, 'g1', 'work'), { recursive: true });
    expect(reasons(c)).toBe('missing_component');
    const d = tree('top-symlink'); const real2 = join(d, 'real'); mkdirSync(real2);
    rmSync(join(d, 'factory'), { recursive: true }); symlinkSync(real2, join(d, 'factory'));
    expect(reasons(d)).toBe('symlink_component');
    expect(reasons(tree('control'))).toBe('passed');
  });

  it('structural: only workspace-view.ts and token-file.ts (and src/scripts) import node:fs, and nothing but the permit client mints a grant', () => {
    const src = join(import.meta.dirname, '..', 'src');
    const files = readdirSync(src, { recursive: true, withFileTypes: true }).filter((d) => d.isFile() && d.name.endsWith('.ts')).map((d) => ({ path: join(d.parentPath, d.name), text: readFileSync(join(d.parentPath, d.name), 'utf8') }));
    const fsUsers = files.filter((f) => /['"](node:)?(fs|module)(\/[^'"]*)?['"]|createRequire/.test(f.text) && !f.path.includes('/scripts/')).map((f) => f.path.slice(src.length + 1)).sort();
    expect(fsUsers).toEqual(['token-file.ts', 'workspace-view.ts']);
    const minters = files.filter((f) => /\bmintGrant\b/.test(f.text)).map((f) => f.path.slice(src.length + 1)).sort();
    expect(minters).toEqual(['grant.ts', 'runner-client.ts']);
  });
});
