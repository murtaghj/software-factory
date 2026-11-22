import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openCandidateWithHooks } from '../src/git-reader/testing.ts';
import type { ReaderLimits } from '../src/git-reader/index.ts';
import type { ReaderHooks } from '../src/git-reader/testing.ts';
import { makeKit, readInChild, type CandidateFixture, type Kit } from './git-reader-kit.ts';
import { expectCode, refusalAsync } from './git-reader-helpers.ts';

let kit: Kit;
beforeAll(() => { kit = makeKit(); });
afterAll(() => { kit.cleanup(); });

const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const BASE = { 'a.txt': 'a\n', 'dir/b.txt': 'b\n', 'bin/run.sh': { content: '#!/bin/sh\n', mode: 0o755 }, link: { symlink: 'a.txt' } };

async function snap(c: CandidateFixture, limits: Partial<ReaderLimits> = {}, hooks?: ReaderHooks) {
  const r = openCandidateWithHooks(c.mountRoot, c.target, limits, hooks);
  try { return await r.snapshot(); } finally { r.close(); }
}
const file = (s: Awaited<ReturnType<typeof snap>>, path: string) => s.worktree.files.find((f) => f.path === path);

describe('the working-tree manifest', () => {
  it('a clean checkout: its source digest equals its commit\'s treeDigest, and nothing is deleted or excluded', async () => {
    const c = kit.makeCandidate(BASE);
    const s = await snap(c);
    expect(s.worktree.sourceDigest).toBe(s.committed.treeDigest);
    expect(s.worktree.files).toEqual(s.committed.files);
    expect(s.worktree.excluded).toEqual([]);
    expect(s.counts).toMatchObject({ worktreeDeleted: 0, worktreeExcluded: 0 });
  });

  it('binary files are hashed as raw bytes; the execute bit comes from the owner bit alone (0710 is 100755, 0670 is 100644)', async () => {
    const c = kit.makeCandidate(BASE);
    const binary = Buffer.from([0, 255, 254, 10, 13, 0, 128, 7]);
    kit.writeFiles(c.work, { 'blob.bin': binary, 'owner-exec': { content: 'x', mode: 0o710 }, 'group-write': { content: 'y', mode: 0o670 }, 'other-exec': { content: 'z', mode: 0o645 } });
    const s = await snap(c);
    expect(file(s, 'blob.bin')).toMatchObject({ sha256: sha256(binary), mode: '100644', kind: 'file' });
    expect(file(s, 'owner-exec')?.mode).toBe('100755');
    expect(file(s, 'group-write')?.mode).toBe('100644');
    expect(file(s, 'other-exec')?.mode).toBe('100644');
    expect(file(s, 'bin/run.sh')?.mode).toBe('100755'); // control: a tracked executable
    expect(s.worktree.sourceDigest).not.toBe(s.committed.treeDigest); // the tree now differs from its commit
    expect(s.worktree.blobIds.find((b) => b.path === 'blob.bin')?.blobId).toBe(kit.git(c.work, ['hash-object', '--stdin'], binary).trim());
  });

  it('a symlink is kept as data and never followed; a contained one reads, an escaping one and an absolute one are refused', async () => {
    const c = kit.makeCandidate(BASE);
    expect(file(await snap(c), 'link')).toMatchObject({ kind: 'symlink', mode: '120000', symlinkTarget: 'a.txt', sha256: sha256('a.txt') });
    symlinkSync('../../outside', join(c.work, 'evil'));
    expectCode(await refusalAsync(() => snap(c)), 'escaping_symlink');
    rmSync(join(c.work, 'evil'));
    symlinkSync('/etc/hosts', join(c.work, 'abs'));
    expectCode(await refusalAsync(() => snap(c)), 'escaping_symlink');
    rmSync(join(c.work, 'abs'));
    expect(file(await snap(c), 'abs')).toBeUndefined(); // control: removed, reads again
  });

  it('a directory symlink is listed and never entered; the real directory is entered (control)', async () => {
    const c = kit.makeCandidate(BASE);
    symlinkSync('dir', join(c.work, 'linkdir'));
    const seen: string[] = [];
    const s = await snap(c, {}, { onFs: (op, p) => { seen.push(`${op} ${p.toString()}`); } });
    expect(file(s, 'linkdir')).toMatchObject({ kind: 'symlink', symlinkTarget: 'dir' });
    expect(s.worktree.files.some((f) => f.path.startsWith('linkdir/'))).toBe(false);
    expect(seen.filter((l) => l.startsWith('readdir') && l.endsWith('/linkdir'))).toEqual([]);
    expect(seen.filter((l) => l.startsWith('readdir') && l.endsWith('/work/main/dir')).length).toBe(1); // control: the real directory
    expect(file(s, 'dir/b.txt')).toBeDefined();
  });

  it('a FIFO is listed as excluded and never opened (a child process under a 5 s limit), and a socket is excluded too', async () => {
    const c = kit.makeCandidate(BASE);
    execFileSync('mkfifo', [join(c.work, 'pipe')]);
    const r = readInChild(c);
    expect(r.timedOut).toBe(false);
    expect(r.result?.ok).toBe(true);
    expect(r.result?.excluded).toEqual([{ path: 'pipe', reason: 'special_file' }]);
    expect(r.result?.files).toContain('a.txt'); // control: the rest of the tree is read

    const sockPath = join('/tmp', `w020-${String(process.pid)}-${String(Date.now())}.sock`);
    const server = createServer();
    await new Promise<void>((resolve) => { server.listen(sockPath, resolve); });
    try {
      renameSync(sockPath, join(c.work, 'sock'));
      const s = await snap(c);
      expect(s.worktree.excluded).toEqual(expect.arrayContaining([{ path: 'sock', reason: 'special_file' }, { path: 'pipe', reason: 'special_file' }]));
      expect(file(s, 'sock')).toBeUndefined();
    } finally { await new Promise<void>((resolve) => { server.close(() => { resolve(); }); }); rmSync(join(c.work, 'sock'), { force: true }); }
  });

  it('a nested .git is not entered and is listed as excluded (the root .git is never listed)', async () => {
    const c = kit.makeCandidate(BASE);
    mkdirSync(join(c.work, 'nested', '.git'), { recursive: true });
    writeFileSync(join(c.work, 'nested', '.git', 'config'), '[core]\n\thooksPath = /tmp\n');
    writeFileSync(join(c.work, 'nested', 'src.txt'), 'inside nested\n');
    mkdirSync(join(c.work, 'Other', '.GIT'), { recursive: true });
    const seen: string[] = [];
    const s = await snap(c, {}, { onFs: (op, p) => { seen.push(`${op} ${p.toString()}`); } });
    expect(s.worktree.excluded).toEqual([{ path: 'Other/.GIT', reason: 'nested_git' }, { path: 'nested/.git', reason: 'nested_git' }]);
    expect(seen.some((l) => l.includes('nested/.git/') || l.endsWith('nested/.git'))).toBe(false); // not even lstat'ed
    expect(file(s, 'nested/src.txt')).toBeDefined(); // control: the rest of the nested directory is data
  });

  it('a file with mode 0000 is refused as unreadable (control: 0644 reads)', async () => {
    const c = kit.makeCandidate(BASE);
    kit.writeFiles(c.work, { secret: 'hidden' });
    chmodSync(join(c.work, 'secret'), 0o000);
    try {
      expectCode(await refusalAsync(() => snap(c)), 'unreadable');
    } finally { chmodSync(join(c.work, 'secret'), 0o644); }
    expect(file(await snap(c), 'secret')).toBeDefined();
  });

  it('an inode swapped between lstat and open is refused (a test hook); without the swap the same file reads', async () => {
    const c = kit.makeCandidate(BASE);
    const target = join(c.work, 'a.txt');
    expect(file(await snap(c), 'a.txt')).toBeDefined();
    const swap: ReaderHooks = { afterLstat: (p) => { if (p.toString() === target) { writeFileSync(`${target}.new`, 'swapped\n'); renameSync(`${target}.new`, target); } } };
    expectCode(await refusalAsync(() => snap(c, {}, swap)), 'file_changed');
  });

  it('a name that is not UTF-8 is refused before any lstat of it; the same tree without it reads', async () => {
    const c = kit.makeCandidate(BASE);
    const bad = Buffer.from([0x62, 0xff, 0xfe]);
    const calls: Buffer[] = [];
    const hooks: ReaderHooks = { onFs: (_op, p) => { calls.push(p); }, extraDirEntries: (dir) => (dir.toString() === c.work ? [bad] : []) };
    const e = await refusalAsync(() => snap(c, {}, hooks));
    expectCode(e, 'non_utf8_path');
    expect(calls.some((p) => p.includes(bad))).toBe(false); // nothing was asked about it
    expect((await snap(c)).worktree.files.length).toBeGreaterThan(3);
  });

  it('a backslash in a name is refused (D28), and so is a symlink named like a file Git reads', async () => {
    const c = kit.makeCandidate(BASE);
    kit.writeFiles(c.work, { 'back\\slash.txt': 'x' });
    expectCode(await refusalAsync(() => snap(c)), 'invalid_path', 'backslash');
    rmSync(join(c.work, 'back\\slash.txt'));
    symlinkSync('a.txt', join(c.work, '.gitmodules'));
    expectCode(await refusalAsync(() => snap(c)), 'invalid_path', 'symlink named like a file Git reads');
    rmSync(join(c.work, '.gitmodules'));
    kit.writeFiles(c.work, { '.gitmodules': '[submodule "x"]\n' }); // control: a regular file of that name is data
    expect(file(await snap(c), '.gitmodules')).toBeDefined();
  });

  it('deleted index paths appear as kind deleted, with the SHA-256 of the blob the index records', async () => {
    const c = kit.makeCandidate(BASE);
    rmSync(join(c.work, 'a.txt'));
    rmSync(join(c.work, 'dir'), { recursive: true });
    const s = await snap(c);
    expect(file(s, 'a.txt')).toEqual({ path: 'a.txt', sha256: sha256('a\n'), mode: '100644', kind: 'deleted' });
    expect(file(s, 'dir/b.txt')).toEqual({ path: 'dir/b.txt', sha256: sha256('b\n'), mode: '100644', kind: 'deleted' });
    expect(s.counts.worktreeDeleted).toBe(2);
    expect(s.worktree.blobIds.map((b) => b.path)).not.toContain('a.txt'); // a deleted path has no blob in the working tree
    // the staged blob, not the working tree's, is what the deleted entry records
    kit.writeFiles(c.work, { 'a.txt': 'edited\n' });
    c.inWork(['add', 'a.txt']);
    rmSync(join(c.work, 'a.txt'));
    expect(file(await snap(c), 'a.txt')).toMatchObject({ kind: 'deleted', sha256: sha256('edited\n') });
  });

  it('D34: untracked node_modules and .env are excluded with their reasons; tracked ones and a .gitignore\'d file are captured', async () => {
    const c = kit.makeCandidate({ ...BASE, '.env.example': 'EXAMPLE=1\n', 'node_modules/tracked/index.js': 'tracked\n', '.gitignore': 'ignored.log\n' });
    kit.writeFiles(c.work, { 'node_modules/untracked/x.js': 'u\n', 'node_modules/tracked/extra.js': 'e\n', '.env': 'SECRET=1\n', '.env.local': 'S=2\n', 'ignored.log': 'noise\n', 'deep/.aws/credentials': 'k\n', 'ID_RSA': 'key\n', 'cert.PEM': 'pem\n', 'build/__pycache__/m.pyc': 'c\n', 'src/.venv/lib': 'v\n' });
    const s = await snap(c);
    const excluded = Object.fromEntries(s.worktree.excluded.map((x) => [x.path, x.reason]));
    expect(excluded).toEqual({
      '.env': 'deny_list', '.env.local': 'deny_list', 'deep/.aws/credentials': 'deny_list', ID_RSA: 'deny_list', 'cert.PEM': 'deny_list',
      'node_modules/tracked/extra.js': 'rebuildable_directory', 'node_modules/untracked': 'rebuildable_directory', 'build/__pycache__': 'rebuildable_directory', 'src/.venv': 'rebuildable_directory',
    });
    for (const kept of ['.env.example', 'node_modules/tracked/index.js', 'ignored.log', '.gitignore']) expect(file(s, kept), kept).toBeDefined();
    expect(c.inWork(['status', '--porcelain'])).not.toContain('ignored.log'); // control: git status hides it, so the ignore rule is live
  });

  it('every cap of the working tree binds at its value and one past it', async () => {
    const make = (files: Record<string, string>): CandidateFixture => { const c = kit.makeCandidate({ 'seed.txt': 's\n' }); kit.writeFiles(c.work, files); return c; };
    const bound = async (c: CandidateFixture, limit: keyof ReaderLimits, value: number): Promise<void> => {
      expect((await snap(c, { [limit]: value })).head.commit).toBe(c.head); // at its value
      const e = await refusalAsync(() => snap(c, { [limit]: value - 1 }));
      expectCode(e, 'limit_exceeded');
      expect(e.limit).toBe(limit);
    };
    // maxEntries: seed.txt and four more files are five entries
    await bound(make({ 'f1': '1', 'f2': '2', 'f3': '3', 'f4': '4' }), 'maxEntries', 5);
    // maxObjectBytes: one file of exactly the cap
    await bound(make({ big: 'x'.repeat(400) }), 'maxObjectBytes', 400); // the commit and trees of the fixture are under 400 bytes
    // maxTotalBytes counts a blob once per path; maxUniqueBytes once per distinct content
    const same = make({ p1: 'y'.repeat(50), p2: 'y'.repeat(50), p3: 'y'.repeat(50) });
    await bound(same, 'maxTotalBytes', 2 + 150); // seed.txt is two bytes
    await bound(same, 'maxUniqueBytes', 2 + 50);
    // paths: the longest is `dir/` + name
    await bound(make({ [`${'n'.repeat(40)}/${'m'.repeat(40)}`]: 'p' }), 'maxPathBytes', 81);
    await bound(make({ 'a/b/c/d/leaf': 'p' }), 'maxDepth', 5);
    await bound(make({ 'one': 'p', 'two': 'p' }), 'maxTotalPathBytes', 'seed.txt'.length + 'one'.length + 'two'.length);
  });
});
