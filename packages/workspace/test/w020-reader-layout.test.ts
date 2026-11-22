import { cpSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openCandidate } from '../src/git-reader/index.ts';
import { openCandidateWithHooks } from '../src/git-reader/testing.ts';
import { makeKit, type CandidateFixture, type Kit } from './git-reader-kit.ts';
import { expectCode, refusalAsync } from './git-reader-helpers.ts';

// The walk from the claim's mount root (7.3, Furio L2): every fixed component is lstat'ed, and a symlink at any of them stops the walk.
let kit: Kit;
beforeAll(() => { kit = makeKit(); });
afterAll(() => { kit.cleanup(); });

const FILES = { 'a.txt': 'a\n', 'dir/b.txt': 'b\n' };

// The fixed components, as paths below the generation directory (the first four are above it).
function components(c: CandidateFixture): Array<[string, string]> {
  const fixed = join(c.mount, 'factory');
  return [
    ['factory', fixed],
    ['the organization', join(fixed, c.orgId)],
    ['the workspace', join(fixed, c.orgId, c.workspaceId)],
    ['g<n>', c.gen],
    ['git', join(c.gen, 'git')],
    ['.git', c.gitDir],
    ['objects', join(c.gitDir, 'objects')],
    ['objects/pack', join(c.gitDir, 'objects', 'pack')],
    ['worktrees/main', c.admin],
    ['work', join(c.gen, 'work')],
    ['main', c.work],
  ];
}

describe('a symlink at each fixed component', () => {
  it('control: the real layout reads, and the spy sees every component lstat\'ed', async () => {
    const c = kit.makeCandidate(FILES);
    c.inCommon(['gc', '--quiet']); // objects/pack is a real, non-empty directory
    const seen: string[] = [];
    const r = openCandidateWithHooks(c.mountRoot, c.target, {}, { onFs: (op, p) => { seen.push(`${op} ${p.toString()}`); } });
    try { expect((await r.snapshot()).head.commit).toBe(c.head); } finally { r.close(); }
    for (const [name, path] of components(c)) expect(seen, name).toContain(`lstat ${path}`);
  });

  for (const index of Array.from({ length: 11 }, (_, i) => i)) {
    it(`component ${String(index)} replaced by a symlink to a complete copy elsewhere is path_unsafe, and nothing outside is opened`, async () => {
      const c = kit.makeCandidate(FILES);
      c.inCommon(['gc', '--quiet']);
      const [name, path] = components(c)[index] ?? ['', ''];
      const outside = kit.dir('elsewhere');
      const copy = join(outside, 'copy');
      cpSync(path, copy, { recursive: true, verbatimSymlinks: true });
      rmSync(path, { recursive: true });
      symlinkSync(copy, path);
      const seen: string[] = [];
      const r = openCandidateWithHooks(c.mountRoot, c.target, {}, { onFs: (op, p) => { seen.push(p.toString()); } });
      try { expectCode(await refusalAsync(() => r.snapshot()), 'path_unsafe'); } finally { r.close(); }
      expect(seen.filter((p) => p.startsWith(outside)), name).toEqual([]); // nothing outside the claim's root
      expect(seen.filter((p) => p.startsWith(`${path}/`)), name).toEqual([]); // and nothing through the link
      expect(seen).toContain(path); // the link itself was looked at
      // control: put the real directory back and the same reader reads
      rmSync(path);
      renameSync(copy, path);
      const again = openCandidate(c.mountRoot, c.target);
      try { expect((await again.snapshot()).head.commit).toBe(c.head); } finally { again.close(); }
    });
  }

  it('a mount root that is itself a symlink, a missing component, and a file where a directory belongs', async () => {
    const c = kit.makeCandidate(FILES);
    const link = join(kit.dir('rootlink'), 'mount');
    symlinkSync(c.mount, link);
    const viaLink = openCandidate(Buffer.from(link), c.target);
    try { expectCode(await refusalAsync(() => viaLink.snapshot()), 'path_unsafe'); } finally { viaLink.close(); }
    const missing = openCandidate(c.mountRoot, { ...c.target, generation: 2 });
    try { expectCode(await refusalAsync(() => missing.snapshot()), 'path_unsafe'); } finally { missing.close(); }
    const other = kit.makeCandidate(FILES);
    rmSync(other.work, { recursive: true });
    mkdirSync(join(other.gen, 'work'), { recursive: true });
    writeFileSync(other.work, 'a file where main should be');
    const r = openCandidate(other.mountRoot, other.target);
    try { expectCode(await refusalAsync(() => r.snapshot()), 'path_unsafe'); } finally { r.close(); }
  });

  it('the target is checked before anything is opened: a path-like organization or a generation of 0 is refused', () => {
    expect(() => openCandidate(Buffer.from('/tmp'), { orgId: '../..', workspaceId: '00000000-0000-4000-8000-000000000000', generation: 1 })).toThrow(expect.objectContaining({ code: 'invalid_request' }) as Error);
    expect(() => openCandidate(Buffer.from('/tmp'), { orgId: '00000000-0000-4000-8000-000000000000', workspaceId: '00000000-0000-4000-8000-000000000000', generation: 0 })).toThrow(expect.objectContaining({ code: 'invalid_request' }) as Error);
    expect(() => openCandidate(Buffer.from('relative/mount'), { orgId: '00000000-0000-4000-8000-000000000000', workspaceId: '00000000-0000-4000-8000-000000000000', generation: 1 })).toThrow(expect.objectContaining({ code: 'invalid_request' }) as Error);
    expect(() => openCandidate(Buffer.from('/tmp'), { orgId: '00000000-0000-4000-8000-000000000000', workspaceId: '00000000-0000-4000-8000-000000000000', generation: 1 }, { maxObjectBytes: 2 ** 40 })).toThrow(expect.objectContaining({ code: 'invalid_limits' }) as Error);
  });
});

