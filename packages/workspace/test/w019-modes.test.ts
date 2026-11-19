// The 0750 pod mode (W-019, C1): reachable only through the pod export. Every host path keeps 0700, and no exported signature carries a mode.
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as index from '../src/index.ts';
import { LocalMaterializer, ensureSafeChild } from '../src/index.ts';
import { POD_MODE_KEY } from '../src/internal/pod-mode.ts';
import * as podExports from '../src/pod-exports.ts';
import { createEnv, fileGit, type Env } from './harness.ts';

let e: Env;
const roots: string[] = [];
beforeAll(async () => { e = await createEnv('w019_modes'); });
afterAll(async () => { for (const r of roots) rmSync(r, { recursive: true, force: true }); await e.close(); });

const mode = (p: string): number => statSync(p).mode & 0o7777;
const target = () => ({ orgId: randomUUID(), workspaceId: randomUUID(), generation: 1 });
const req = (t: ReturnType<typeof target>) => ({ kind: 'remote' as const, target: t, taskId: e.a.taskId, cloneUrl: e.repoA.bare, commit: e.repoA.base, subpath: '' });
const freshRoot = (): string => { const r = mkdtempSync(join(tmpdir(), 'w019-modes-')); roots.push(r); return r; };
const levels = (root: string, t: ReturnType<typeof target>): string[] => [root, join(root, t.orgId), join(root, t.orgId, t.workspaceId), join(root, t.orgId, t.workspaceId, 'g1'), join(root, t.orgId, t.workspaceId, 'g1', 'work')];

describe('W-019 modes', () => {
  it('through the package index every level is 0700, as today, and neither the materializer nor the host offers a way to ask for another mode', async () => {
    const root = freshRoot();
    const t = target();
    const m = new LocalMaterializer({ root, git: fileGit() });
    expect((await m.materialize(req(t))).ok).toBe(true);
    expect(levels(root, t).slice(1).map(mode)).toEqual([0o700, 0o700, 0o700, 0o700]);
    // the host's own helper
    expect(e.host).toBeDefined();
    const dir = ensureSafeChild(freshRoot(), 'child', true);
    expect(mode(dir)).toBe(0o700);
    expect(ensureSafeChild.length).toBe(3); // three arguments, no mode
  });

  it('structural: the package index exports no createPodMaterializer, no PodMode, nothing from internal/; the pod export has createPodMaterializer and no mode token', () => {
    const names = Object.keys(index);
    expect(names).not.toContain('createPodMaterializer');
    expect(names).not.toContain('PodMode');
    expect(names).not.toContain('POD_MODE_KEY');
    expect(names.filter((n) => /pod.?mode|internal/i.test(n))).toEqual([]);
    expect(readFileSync(join(import.meta.dirname, '..', 'src', 'index.ts'), 'utf8')).not.toMatch(/internal|pod-mode/);
    expect(Object.keys(podExports)).toContain('createPodMaterializer');
    expect(Object.keys(podExports).filter((n) => /mode/i.test(n))).toEqual([]);
  });

  it('a PodMode built by hand throws, and so does a value that is not the token; control: the real thing works', () => {
    const root = freshRoot();
    expect(() => new LocalMaterializer({ root, [POD_MODE_KEY]: { dirMode: 0o750 } } as never)).toThrow(/not a pod mode/);
    expect(() => new LocalMaterializer({ root, [POD_MODE_KEY]: 'pod' } as never)).toThrow(/not a pod mode/);
    expect(() => podExports.createPodMaterializer({ root })).not.toThrow();
  });

  it('through createPodMaterializer the organization, workspace, generation and work levels are 0750, nothing is group- or world-writable; a 0770 root is still unsafe_root', async () => {
    const root = freshRoot();
    const t = target();
    const m = podExports.createPodMaterializer({ root, git: fileGit() });
    expect((await m.materialize(req(t))).ok).toBe(true);
    const ls = levels(root, t);
    expect(ls.slice(1).map(mode)).toEqual([0o750, 0o750, 0o750, 0o750]);
    for (const p of ls) expect(mode(p) & 0o022).toBe(0);
    const open = freshRoot();
    chmodSync(open, 0o770);
    expect(await podExports.createPodMaterializer({ root: open, git: fileGit() }).materialize(req(target()))).toMatchObject({ ok: false, code: 'unsafe_root' });
    chmodSync(open, 0o750); // control
    expect((await podExports.createPodMaterializer({ root: open, git: fileGit() }).materialize(req(target()))).ok).toBe(true);
  });

  it('the publisher\'s scratch levels and the host helper stay 0700 whatever the materializer does', () => {
    const scratch = freshRoot();
    expect(mode(ensureSafeChild(scratch, 'org', true))).toBe(0o700);
    expect(mode(ensureSafeChild(join(scratch, 'org'), 'workspace', true))).toBe(0o700);
  });
});
