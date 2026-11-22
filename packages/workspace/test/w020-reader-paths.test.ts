import { spawnSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openCandidateWithHooks } from '../src/git-reader/testing.ts';
import type { ReaderHooks } from '../src/git-reader/testing.ts';
import { parseIndex } from '../src/git-reader/index-file.ts';
import { DEFAULT_LIMITS } from '../src/git-reader/limits.ts';
import { parseTree } from '../src/git-reader/tree.ts';
import { buildIndex, makeKit, type Kit } from './git-reader-kit.ts';
import { expectCode, refusal, refusalAsync } from './git-reader-helpers.ts';

// Each path rule, through a tree entry, an index entry and a directory name (7.3 "Path rules").
let kit: Kit;
beforeAll(() => { kit = makeKit(); });
afterAll(() => { kit.cleanup(); });

const cp = (...points: number[]): string => String.fromCodePoint(...points);
const oid20 = Buffer.alloc(20, 0xcd);
const treeWith = (name: Buffer | string, mode = '100644'): Buffer => Buffer.concat([Buffer.from(`${mode} `), Buffer.from(name), Buffer.from([0]), oid20]);
const viaTree = (name: string | Buffer, mode?: string): unknown => parseTree(treeWith(name, mode), 'tree');
const viaIndex = (path: string, mode = 0o100644): unknown => parseIndex(buildIndex([{ path, mode }]), DEFAULT_LIMITS, 'index');

// Names that Git's verify_path refuses (with core.protectHFS and core.protectNTFS), and what is wrong with each.
const DOT_GIT_FORMS = ['.git', '.GIT', '.Git', '.git ', '.git.', '.git. .', 'git~1', 'GIT~1', `.g${cp(0x200c)}it`, `${cp(0x200d)}.git`, `.gi${cp(0xfeff)}t`, `.git${cp(0x202e)}`, '.git:foo', '.git::$INDEX_ALLOCATION', 'GIT~1:x', '.git . :s'];
// Git accepts these and so does the reader: the HFS check removes ignorable code points but strips no trailing dot, the NTFS check strips dots but ignores nothing.
const GIT_ACCEPTS_BOTH = [`.git${cp(0x200c)}.`, `.g${cp(0x200c)}it.x`, `${cp(0x200c)}git~1`];
const REFUSED_COMPONENTS: Array<[string, string]> = [['..', '`.` or `..`'], ['.', '`.` or `..`'], ['back\\slash', 'backslash']];
const ACCEPTED = ['.github', 'git', '.gitx', 'a.git', '.gitignore', 'gitt~1', '.git-keep', 'x.git.y', 'é', `${cp(0x1f600)}.txt`];

describe('through a tree entry', () => {
  it('every form of .git, `..`, `.` and a backslash is refused; the control names are accepted', () => {
    for (const name of DOT_GIT_FORMS) expectCode(refusal(() => viaTree(name)), 'invalid_path', 'treats as .git');
    for (const name of DOT_GIT_FORMS.slice(0, 4)) expectCode(refusal(() => viaTree(name, '40000')), 'invalid_path', 'treats as .git'); // a directory too
    for (const [name, why] of REFUSED_COMPONENTS) expectCode(refusal(() => viaTree(name)), 'invalid_path', why);
    expectCode(refusal(() => viaTree('')), 'invalid_path', 'empty');
    expectCode(refusal(() => viaTree(Buffer.from([0x62, 0xff]))), 'non_utf8_path');
    for (const name of ACCEPTED) expect(viaTree(name), name).toHaveLength(1);
  });

  it('a symlink named .gitmodules, .gitattributes, .gitignore or .mailmap is refused under the same folding; the same names as files are accepted', () => {
    for (const name of ['.gitmodules', '.gitattributes', '.gitignore', '.mailmap', '.GITMODULES', '.gitmodules ', '.gitmodules.', `.git${cp(0x200c)}modules`]) {
      expectCode(refusal(() => viaTree(name, '120000')), 'invalid_path', 'symlink named like a file Git reads');
      expect(viaTree(name, '100644'), name).toHaveLength(1); // a regular file of that name is data
    }
    expect(viaTree('.gitmodulesx', '120000')).toHaveLength(1); // control: a different name
  });

  it('duplicate names inside one tree are refused (control: distinct names, even ones that differ only in case)', () => {
    expectCode(refusal(() => parseTree(Buffer.concat([treeWith('same'), treeWith('same')]), 'tree')), 'duplicate_path');
    expect(parseTree(Buffer.concat([treeWith('same'), treeWith('Same')]), 'tree')).toHaveLength(2); // legal on Linux, kept
  });
});

describe('agrees with Git\'s own verify_path (review, Livia 6, Furio L4)', () => {
  // `git update-index --cacheinfo` runs verify_path with protectHFS and protectNTFS on, which is the rule 7.3 cites.
  const repo = (): { dir: string; blob: string } => { const dir = kit.dir('verify-path'); kit.git(dir, ['init', '--quiet']); return { dir, blob: kit.git(dir, ['hash-object', '-w', '--stdin'], 'x\n').trim() }; };
  const gitAccepts = (r: { dir: string; blob: string }, mode: string, path: string): boolean => {
    try { kit.git(r.dir, ['-c', 'core.protectHFS=true', '-c', 'core.protectNTFS=true', 'update-index', '--add', '--cacheinfo', `${mode},${r.blob},${path}`]); return true; } catch { return false; }
  };
  const readerAccepts = (mode: '100644' | '120000', name: string): boolean => { try { viaTree(name, mode); return true; } catch { return false; } };

  it('every .git form is refused by Git and by the reader; the control names and the two forms Git accepts are accepted by both', () => {
    const r = repo();
    for (const name of DOT_GIT_FORMS) { expect(gitAccepts(r, '100644', name), `git: ${name}`).toBe(false); expect(readerAccepts('100644', name), `reader: ${name}`).toBe(false); }
    for (const name of [...ACCEPTED, ...GIT_ACCEPTS_BOTH]) { expect(gitAccepts(r, '100644', name), `git: ${name}`).toBe(true); expect(readerAccepts('100644', name), `reader: ${name}`).toBe(true); }
  });

  it('a symlink named like .gitmodules (and its NTFS and HFS forms) is refused by Git and by the reader; as a regular file it is accepted by both', () => {
    const r = repo();
    const refused = ['.gitmodules', '.GITMODULES', '.gitmodules ', '.gitmodules.', '.gitmodules:x', 'gitmod~1', 'gitmod~2', 'GITMOD~3', 'gitmod~4 ', 'gitmod~1.:s', 'gi7eba~1', 'GI7EBA~9', 'gi7e~123', 'gi~12345', `.git${cp(0x200c)}modules`];
    // names that look similar and are not short names of it: Git accepts them as symlinks, and so must the reader
    const fine = ['gi7eba~1234', 'gi7e~12345', 'gitmod~5', 'gitmod~', 'gitmod', 'gi7ebb~1', 'gitmodx~1', 'gi7eba~0', 'gi7eba~', 'gi7eba1', 'gi7eba~1x', 'gitig~1', 'maba3~1', 'gitmodules', '.gitmodulesx'];
    for (const name of refused) { expect(gitAccepts(r, '120000', name), `git: ${name}`).toBe(false); expect(readerAccepts('120000', name), `reader: ${name}`).toBe(false); expect(gitAccepts(r, '100644', name), `git file: ${name}`).toBe(true); expect(readerAccepts('100644', name), `reader file: ${name}`).toBe(true); }
    for (const name of fine) { expect(gitAccepts(r, '120000', name), `git fine: ${name}`).toBe(true); expect(readerAccepts('120000', name), `reader fine: ${name}`).toBe(true); }
  });

  // `update-index` enforces the symlink rule for .gitmodules alone; for the other three Git's own judge is fsck (gitattributesSymlink, gitignoreSymlink, mailmapSymlink),
  // which is run here on a tree holding one symlink of the name.
  const fsckSays = (name: string, token: string): boolean => {
    const dir = kit.dir('fsck-symlink');
    kit.git(dir, ['init', '--quiet']);
    const blob = kit.git(dir, ['hash-object', '-w', '--stdin'], 'x').trim();
    kit.gitRaw(dir, ['hash-object', '-t', 'tree', '-w', '--literally', '--stdin'], Buffer.concat([Buffer.from('120000 '), Buffer.from(name), Buffer.from([0]), Buffer.from(blob, 'hex')]));
    const r = spawnSync('/usr/bin/git', ['fsck', '--strict', '--no-dangling'], { cwd: dir, env: kit.env, encoding: 'utf8' });
    return `${r.stdout}${r.stderr}`.includes(token);
  };

  it('a symlink named like .gitattributes, .gitignore or .mailmap, in every short-name form, is what Git\'s fsck calls a symlink of it, and the reader refuses exactly those', () => {
    const groups: Array<[string, string[], string[]]> = [
      ['gitignoreSymlink', ['.gitignore', '.GITIGNORE', '.gitignore ', '.gitignore.:x', 'gitign~1', 'gitign~4.', 'gi250a~1', 'gi250a~7 ', 'gi2~12345'.slice(0, 8)], ['gitign~5', 'gitign~', 'gi250b~1', 'gitignor', 'gi250a~1x', '.gitignorex']],
      ['gitattributesSymlink', ['.gitattributes', '.GITATTRIBUTES.', 'gitatt~2', 'gitatt~4', 'gi7d29~1', 'gi7d29~8'], ['gitatt~5', 'gi7d28~1', 'gitattr', '.gitattributesx']],
      ['mailmapSymlink', ['.mailmap', '.MAILMAP', '.mailmap ', 'mailma~1', 'mailma~3', 'maba30~1', 'maba30~5:x'], ['mailma~5', 'maba31~1', 'mailmap', '.mailmapx']],
    ];
    for (const [token, refused, fine] of groups) {
      for (const name of refused) { expect(fsckSays(name, token), `git: ${name}`).toBe(true); expect(readerAccepts('120000', name), `reader: ${name}`).toBe(false); expect(readerAccepts('100644', name), `reader file: ${name}`).toBe(true); }
      for (const name of fine) { expect(fsckSays(name, token), `git fine: ${name}`).toBe(false); expect(readerAccepts('120000', name), `reader fine: ${name}`).toBe(true); }
    }
  });
});

describe('no name makes the checks slow (review, Furio L2)', () => {
  it('a 4,001-byte name of dots and spaces is refused at once (components are capped at 255 bytes), and the fold of the longest legal such name is linear', () => {
    const hostile = '. '.repeat(1996) + '000000001';
    expect(Buffer.byteLength(hostile)).toBeGreaterThan(255);
    const t0 = performance.now();
    expectCode(refusal(() => viaTree(hostile)), 'invalid_path', '255');
    expect(performance.now() - t0).toBeLessThan(50);
    const longest = '. '.repeat(126) + 'x'; // 253 bytes: legal, and as bad for a backtracking regex as a name can be
    const t1 = performance.now();
    for (let i = 0; i < 200; i += 1) viaTree(longest);
    const perCall = (performance.now() - t1) / 200;
    console.log(`fold of a 253-byte dots-and-spaces name: ${perCall.toFixed(3)} ms per call; a 4,001-byte one is refused in ${(t1 - t0).toFixed(2)} ms (before the fix: 9.04 ms per call at 4,001 bytes, quadratic)`);
    expect(perCall).toBeLessThan(1);
  });

  it('a 4 MiB tree of 255-byte names of dots and spaces is parsed in well under a second, and parseTree ticks every few thousand entries (before: 20 s in one call)', () => {
    const parts: Buffer[] = [];
    let size = 0;
    for (let n = 0; size < 4 * 1024 * 1024; n += 1) {
      const e = Buffer.concat([Buffer.from('100644 '), Buffer.from('. '.repeat(120) + String(n).padStart(9, '0')), Buffer.from([0]), Buffer.alloc(20, 1)]);
      parts.push(e);
      size += e.length;
    }
    const body = Buffer.concat(parts);
    let ticks = 0;
    const t = performance.now();
    const out = parseTree(body, 'probe', { tick: () => { ticks += 1; } });
    const ms = performance.now() - t;
    console.log(`${String(out.length)} entries, ${String(body.length)} bytes: ${ms.toFixed(0)} ms, ${String(ticks)} ticks`);
    expect(ms).toBeLessThan(2000);
    expect(ticks).toBe(Math.floor(out.length / 4096));
    expect(ticks).toBeGreaterThanOrEqual(2);
  });
});

describe('through an index entry', () => {
  it('a .git component anywhere in the path, `..`, `.`, an empty component and a backslash are refused; the control names are accepted', () => {
    for (const name of DOT_GIT_FORMS) { expectCode(refusal(() => viaIndex(name)), 'invalid_path', 'treats as .git'); expectCode(refusal(() => viaIndex(`dir/${name}/file`)), 'invalid_path', 'treats as .git'); }
    for (const [name, why] of REFUSED_COMPONENTS) expectCode(refusal(() => viaIndex(`a/${name}/b`)), 'invalid_path', why);
    expectCode(refusal(() => viaIndex('a//b')), 'invalid_path', 'empty');
    expectCode(refusal(() => viaIndex('a/')), 'invalid_path', 'empty');
    expectCode(refusal(() => viaIndex('/abs')), 'invalid_path', 'empty');
    for (const name of ACCEPTED) expect(viaIndex(`dir/${name}/file`), name).toBeDefined();
  });

  it('a symlinked .gitmodules (at any depth) is refused, a regular one is accepted', () => {
    expectCode(refusal(() => viaIndex('sub/.gitmodules', 0o120000)), 'invalid_path', 'symlink named like a file Git reads');
    expectCode(refusal(() => viaIndex('.GitAttributes ', 0o120000)), 'invalid_path', 'symlink named like a file Git reads');
    expect(viaIndex('sub/.gitmodules', 0o100644)).toBeDefined();
    expect(viaIndex('sub/.gitmodules.d', 0o120000)).toBeDefined(); // control
  });

  it('a name that is not UTF-8, in an index entry, is refused', () => {
    expectCode(refusal(() => parseIndex(buildIndex([{ path: Buffer.from([0x61, 0xc3, 0x28]) }]), DEFAULT_LIMITS, 'index')), 'non_utf8_path');
  });
});

describe('through a directory name (the working tree)', () => {
  const FILES = { 'a.txt': 'a\n' };
  const snap = async (c: ReturnType<Kit['makeCandidate']>, hooks?: ReaderHooks) => { const r = openCandidateWithHooks(c.mountRoot, c.target, {}, hooks); try { return await r.snapshot(); } finally { r.close(); } };

  it('a directory whose name folds to .git is not entered and is listed as nested_git, in every form', async () => {
    const forms = ['.GIT', '.git ', '.git.', 'git~1', `.g${cp(0x200c)}it`];
    const c = kit.makeCandidate(FILES);
    for (const f of forms) { mkdirSync(join(c.work, 'sub', f), { recursive: true }); writeFileSync(join(c.work, 'sub', f, 'inside'), 'x'); }
    const s = await snap(c);
    expect(s.worktree.excluded.map((x) => x.path).sort()).toEqual(forms.map((f) => `sub/${f}`).sort());
    expect(s.worktree.excluded.every((x) => x.reason === 'nested_git')).toBe(true);
    expect(s.worktree.files.some((f) => f.path.includes('inside'))).toBe(false);
  });

  it('a backslash in a directory name is refused; `..` and an empty name (which no file system holds) are refused before any lstat', async () => {
    const c = kit.makeCandidate(FILES);
    mkdirSync(join(c.work, 'a\\b'));
    writeFileSync(join(c.work, 'a\\b', 'f'), 'x');
    expectCode(await refusalAsync(() => snap(c)), 'invalid_path', 'backslash');
    for (const name of ['..', '', '.']) {
      const c2 = kit.makeCandidate(FILES);
      const calls: string[] = [];
      const hooks: ReaderHooks = { onFs: (_op, p) => { calls.push(p.toString()); }, extraDirEntries: (dir) => (dir.toString() === c2.work ? [Buffer.from(name)] : []) };
      expectCode(await refusalAsync(() => snap(c2, hooks)), 'invalid_path');
      expect(calls.filter((p) => p === `${c2.work}/${name}` || p === `${c2.work}/`)).toEqual([]);
    }
  });

  it('control: .github, git, .gitx and a.git are ordinary directories, entered and read', async () => {
    const c = kit.makeCandidate(FILES);
    for (const name of ['.github', 'git', '.gitx', 'a.git']) { mkdirSync(join(c.work, name)); writeFileSync(join(c.work, name, 'file.txt'), name); }
    const s = await snap(c);
    expect(s.worktree.files.map((f) => f.path)).toEqual(expect.arrayContaining(['.github/file.txt', 'git/file.txt', '.gitx/file.txt', 'a.git/file.txt']));
    expect(s.worktree.excluded).toEqual([]);
  });

  it('a symlink named .gitmodules is refused; the same name as a regular file is data', async () => {
    const c = kit.makeCandidate(FILES);
    symlinkSync('a.txt', join(c.work, '.gitmodules'));
    expectCode(await refusalAsync(() => snap(c)), 'invalid_path', 'symlink named like a file Git reads');
  });
});
