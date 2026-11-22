import { createHash } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openCandidate } from '../src/git-reader/index.ts';
import { parseIndex } from '../src/git-reader/index-file.ts';
import { DEFAULT_LIMITS } from '../src/git-reader/limits.ts';
import { buildIndex, makeKit, sha1Object, type CandidateFixture, type IndexSpecEntry, type Kit } from './git-reader-kit.ts';
import { expectCode, refusal, refusalAsync } from './git-reader-helpers.ts';

let kit: Kit;
beforeAll(() => { kit = makeKit(); });
afterAll(() => { kit.cleanup(); });

const EMPTY_BLOB = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';
const FILES = { 'a.txt': 'a\n', 'b.txt': 'b\n', 'bin/run.sh': { content: '#!/bin/sh\n', mode: 0o755 }, 'dir/c.txt': 'c\n', link: { symlink: 'a.txt' } };

async function snap(c: CandidateFixture, limits = {}) {
  const r = openCandidate(c.mountRoot, c.target, limits);
  try { return await r.snapshot(); } finally { r.close(); }
}

// Git's reading of the index: `ls-files -s` (mode, oid, stage, path) and `ls-files -t -v` (the flag letters).
function oracle(c: CandidateFixture): Array<{ path: string; mode: string; oid: string; tag: string }> {
  const staged = c.inWork(['ls-files', '-s', '-z']).split('\0').filter((l) => l !== '').map((l) => {
    const [meta = '', path = ''] = l.split('\t');
    const [mode = '', oid = ''] = meta.split(' ');
    return { path, mode, oid };
  });
  const tags = new Map(c.inWork(['ls-files', '-t', '-v', '-z']).split('\0').filter((l) => l !== '').map((l) => [l.slice(2), l[0] ?? ''] as const));
  return staged.map((s) => ({ ...s, tag: tags.get(s.path) ?? '?' }));
}

describe('indexes written by real Git', () => {
  it.each([2, 4] as const)('version %i: entries and flags equal git ls-files', async (version) => {
    const c = kit.makeCandidate(FILES);
    c.inWork(['update-index', `--index-version=${String(version)}`]);
    const s = await snap(c);
    expect(s.index.indexVersion).toBe(version);
    expect(s.index.checksum).toBe('verified');
    const want = oracle(c);
    expect(s.index.entries.map((e) => [e.path, e.mode, e.oid])).toEqual(want.map((w) => [w.path, w.mode, w.oid]));
    expect(s.index.entries.every((e) => !e.assumeValid && !e.skipWorktree && !e.intentToAdd)).toBe(true);
    expect(want.every((w) => w.tag === 'H')).toBe(true);
  });

  it('version 3 (extended flags), add -N, --skip-worktree and --assume-unchanged', async () => {
    const c = kit.makeCandidate(FILES);
    kit.writeFiles(c.work, { 'new.txt': 'untracked until add -N\n' });
    c.inWork(['add', '-N', 'new.txt']);
    c.inWork(['update-index', '--skip-worktree', 'b.txt']);
    c.inWork(['update-index', '--assume-unchanged', 'dir/c.txt']);
    const s = await snap(c);
    expect(s.index.indexVersion).toBe(3); // Git writes version 3 when an entry has extended flags
    const want = oracle(c);
    expect(s.index.entries.map((e) => [e.path, e.mode, e.oid])).toEqual(want.map((w) => [w.path, w.mode, w.oid]));
    const flag = (path: string) => s.index.entries.find((e) => e.path === path);
    expect(flag('new.txt')).toMatchObject({ intentToAdd: true, oid: EMPTY_BLOB, skipWorktree: false, assumeValid: false });
    expect(flag('b.txt')).toMatchObject({ skipWorktree: true, intentToAdd: false });
    expect(flag('dir/c.txt')).toMatchObject({ assumeValid: true });
    expect(flag('a.txt')).toMatchObject({ skipWorktree: false, assumeValid: false, intentToAdd: false });
    expect(want.find((w) => w.path === 'b.txt')?.tag).toBe('S');
    expect(want.find((w) => w.path === 'dir/c.txt')?.tag).toBe('h');
    // the same flags in a version 4 index
    c.inWork(['update-index', '--index-version=4']);
    const v4 = await snap(c);
    expect(v4.index.indexVersion).toBe(4);
    expect(v4.index.entries).toEqual(s.index.entries);
  });

  it('a path of 4,096 bytes (the name-length field saturates at 4,095) reads, and one of 5,000 bytes is refused as maxPathBytes', async () => {
    const component = (n: number): string => 'x'.repeat(n);
    const longPath = [...Array.from({ length: 19 }, () => component(204)), component(201)].join('/'); // 4,096 bytes, 20 components
    expect(Buffer.byteLength(longPath)).toBe(4096);
    const c = kit.makeCandidate(FILES);
    const blob = c.inWork(['hash-object', '-w', '--stdin'], 'long\n').trim();
    c.inWork(['update-index', '--add', '--cacheinfo', `100644,${blob},${longPath}`]);
    const s = await snap(c);
    expect(s.index.entries.map((e) => e.path)).toContain(longPath);
    expect(s.index.entries.map((e) => e.path)).toEqual(oracle(c).map((w) => w.path));
    const tooLong = Array.from({ length: 25 }, () => component(199)).join('/');
    expect(Buffer.byteLength(tooLong)).toBeGreaterThan(4096);
    c.inWork(['update-index', '--add', '--cacheinfo', `100644,${blob},${tooLong}`]);
    const e = await refusalAsync(() => snap(c));
    expectCode(e, 'limit_exceeded');
    expect(e.limit).toBe('maxPathBytes');
  });

  it('index.skipHash: the all-zero trailer Git writes is accepted and recorded as skipped; the same index with a normal trailer is verified', async () => {
    const c = kit.makeCandidate(FILES);
    kit.writeFiles(c.work, { 'extra.txt': 'extra\n' });
    c.inWork(['-c', 'index.skipHash=true', 'add', 'extra.txt']);
    const s = await snap(c);
    expect(s.index.checksum).toBe('skipped');
    expect(s.index.entries.map((e) => e.path)).toEqual(oracle(c).map((w) => w.path));
    c.inWork(['-c', 'index.skipHash=false', 'update-index', '--add', 'extra.txt', 'a.txt']);
    c.inWork(['-c', 'index.skipHash=false', 'rm', '--cached', '--quiet', 'extra.txt']);
    expect((await snap(c)).index.checksum).toBe('verified');
  });
});

describe('what the reader refuses in an index', () => {
  const read = (bytes: Buffer): ReturnType<typeof parseIndex> => parseIndex(bytes, DEFAULT_LIMITS, 'index');
  const ok: IndexSpecEntry[] = [{ path: 'a' }, { path: 'b' }, { path: 'dir/c' }];

  it('control: a well-formed index of every version reads', () => {
    for (const version of [2, 3, 4] as const) expect(read(buildIndex(ok, { version })).entries.map((e) => e.pathBytes.toString())).toEqual(['a', 'b', 'dir/c']);
  });

  it('a merge conflict (stage 1 to 3), from a real conflicted merge', async () => {
    const c = kit.makeCandidate({ 'f.txt': 'base\n' });
    c.inWork(['checkout', '--quiet', '-b', 'side']);
    kit.writeFiles(c.work, { 'f.txt': 'side\n' });
    c.inWork(['commit', '--quiet', '-am', 'side']);
    c.inWork(['checkout', '--quiet', '-b', 'other', c.head]);
    kit.writeFiles(c.work, { 'f.txt': 'other\n' });
    c.inWork(['commit', '--quiet', '-am', 'other']);
    expect(() => c.inWork(['merge', '--quiet', 'side'])).toThrow();
    expect(c.inWork(['ls-files', '-u'])).toContain('f.txt');
    expectCode(await refusalAsync(() => snap(c)), 'unmerged_index');
    // control: the same repository once the conflict is resolved
    kit.writeFiles(c.work, { 'f.txt': 'resolved\n' });
    c.inWork(['add', 'f.txt']);
    expect((await snap(c)).index.entries.map((e) => e.path)).toEqual(['f.txt']);
  });

  it('--split-index, from real Git', async () => {
    const c = kit.makeCandidate(FILES);
    c.inWork(['update-index', '--split-index']);
    expectCode(await refusalAsync(() => snap(c)), 'split_index');
    c.inWork(['update-index', '--no-split-index']);
    expect((await snap(c)).index.entries.length).toBe(5); // control
  });

  it('a sparse index, from real Git', async () => {
    const c = kit.makeCandidate({ 'one/a.txt': 'a\n', 'two/b.txt': 'b\n', 'three/c.txt': 'c\n', 'root.txt': 'r\n' });
    c.inWork(['sparse-checkout', 'init', '--cone', '--sparse-index']);
    c.inWork(['sparse-checkout', 'set', 'one']);
    expect(c.inWork(['ls-files', '--sparse', '-s'])).toContain('two/'); // the index holds a directory entry
    expectCode(await refusalAsync(() => snap(c)), 'sparse_index');
    c.inWork(['sparse-checkout', 'disable']);
    expect((await snap(c)).index.entries.length).toBe(4); // control
  });

  it('entries out of order, a duplicate name, a bad checksum, a bad signature, a short file', () => {
    expectCode(refusal(() => read(buildIndex([{ path: 'b' }, { path: 'a' }]))), 'invalid_index', 'ascending');
    expectCode(refusal(() => read(buildIndex([{ path: 'a' }, { path: 'a' }]))), 'invalid_index', 'same name');
    expectCode(refusal(() => read(buildIndex(ok, { badChecksum: true }))), 'invalid_index', 'checksum');
    const noSig = buildIndex(ok);
    noSig.write('XXXX', 0, 'latin1');
    expectCode(refusal(() => read(noSig)), 'invalid_index', 'DIRC');
    expectCode(refusal(() => read(Buffer.alloc(10))), 'invalid_index', 'too short');
    expectCode(refusal(() => read(buildIndex(ok, { version: 2, declaredCount: 4 }))), 'invalid_index', 'cut off');
    const v5 = buildIndex(ok);
    v5.writeUInt32BE(5, 4);
    expectCode(refusal(() => parseIndex(Buffer.concat([v5.subarray(0, v5.length - 20), Buffer.alloc(20)]), DEFAULT_LIMITS, 'index')), 'unsupported_index', 'version 5');
  });

  it('modes: only 100644, 100755 and 120000; a submodule and any other are refused', () => {
    expect(read(buildIndex([{ path: 'x', mode: 0o100755 }, { path: 'y', mode: 0o120000 }])).entries.map((e) => e.mode)).toEqual(['100755', '120000']);
    expectCode(refusal(() => read(buildIndex([{ path: 'x', mode: 0o160000 }]))), 'submodule');
    expectCode(refusal(() => read(buildIndex([{ path: 'x', mode: 0o100664 }]))), 'invalid_index', 'mode');
    expectCode(refusal(() => read(buildIndex([{ path: 'x', stage: 2 }]))), 'unmerged_index');
  });

  it('a file and a directory that share a name', () => {
    expectCode(refusal(() => read(buildIndex([{ path: 'a' }, { path: 'a/b' }]))), 'invalid_index', 'share a name');
    expect(read(buildIndex([{ path: 'a-b' }, { path: 'a/b' }])).entries.length).toBe(2); // control
  });

  it('extensions: an unknown lower-case one is refused, an unknown upper-case one is skipped (control), the known ones are skipped', () => {
    expectCode(refusal(() => read(buildIndex(ok, { extensions: [{ sig: 'zzzz', data: Buffer.from('x') }] }))), 'unsupported_index', 'required extension');
    expect(read(buildIndex(ok, { extensions: [{ sig: 'ZZZZ', data: Buffer.from('x') }] })).entries.length).toBe(3);
    for (const sig of ['TREE', 'REUC', 'UNTR', 'FSMN', 'EOIE', 'IEOT']) expect(read(buildIndex(ok, { extensions: [{ sig, data: Buffer.alloc(3) }] })).entries.length).toBe(3);
    expectCode(refusal(() => read(buildIndex(ok, { extensions: [{ sig: 'link', data: Buffer.alloc(20) }] }))), 'split_index');
    expectCode(refusal(() => read(buildIndex(ok, { extensions: [{ sig: 'sdir' }] }))), 'sparse_index');
    const cut = buildIndex(ok, { extensions: [{ sig: 'ZZZZ', data: Buffer.alloc(40) }] });
    cut.writeUInt32BE(1000, cut.length - 20 - 40 - 4);
    expectCode(refusal(() => parseIndex(Buffer.concat([cut.subarray(0, cut.length - 20), Buffer.alloc(20)]), DEFAULT_LIMITS, 'index')), 'invalid_index', 'past the trailer');
  });

  it('padding and lengths: a non-NUL pad byte, an extended entry in a version 2 index, an unknown extended flag, a long name that is not terminated', () => {
    expectCode(refusal(() => read(buildIndex([{ path: 'a' }], { raw: (parts) => parts.map((p) => { const q = Buffer.from(p); q[q.length - 1] = 0x41; return q; }) }))), 'invalid_index', 'padded');
    expectCode(refusal(() => read(buildIndex([{ path: 'a', skipWorktree: true }], { version: 2 }))), 'invalid_index', 'version 2');
    expectCode(refusal(() => read(buildIndex([{ path: 'a', skipWorktree: true }], { version: 3, raw: (parts) => parts.map((p) => { const q = Buffer.from(p); q.writeUInt16BE(0x8000, 62); return q; }) }))), 'invalid_index', 'extended flag');
    expect(read(buildIndex([{ path: 'a', skipWorktree: true }], { version: 3 })).entries[0]).toMatchObject({ skipWorktree: true }); // control
  });

  it('version 4: a strip count past the previous name is refused, and a prefix-compressed index reads', () => {
    const good = buildIndex([{ path: 'abc/def' }, { path: 'abc/xyz' }, { path: 'abd' }], { version: 4 });
    expect(read(good).entries.map((e) => e.pathBytes.toString())).toEqual(['abc/def', 'abc/xyz', 'abd']);
    // the second entry's strip count (one byte, 3) is raised to 40
    const bad = buildIndex([{ path: 'abc/def' }, { path: 'abc/xyz' }], { version: 4, raw: (parts) => parts.map((p, i) => { const q = Buffer.from(p); if (i === 1) q[62] = 40; return q; }) });
    expectCode(refusal(() => read(bad)), 'invalid_index', 'strip count');
  });

  it('an intent-to-add entry must name the empty blob (review, Livia 8 and Furio L6); a missing index file is an empty index, as Git reads it', async () => {
    const parse = (spec: Parameters<typeof buildIndex>[0]): unknown => parseIndex(buildIndex(spec, { version: 3 }), DEFAULT_LIMITS, 'index');
    expect(parse([{ path: 'new', intentToAdd: true, oid: EMPTY_BLOB }])).toBeDefined();
    expectCode(refusal(() => parse([{ path: 'new', intentToAdd: true, oid: sha1Object('blob', Buffer.from('not empty')) }])), 'invalid_index', 'empty blob');
    const c = kit.makeCandidate({ 'a.txt': 'a\n' });
    rmSync(join(c.admin, 'index'));
    const s = await snap(c);
    expect(s.index).toMatchObject({ entries: [], checksum: 'absent', indexVersion: 2 });
    expect(s.counts.worktreeDeleted).toBe(0); // nothing in the index, so nothing deleted; a.txt is just an untracked file now
    expect(s.worktree.files.map((f) => f.path)).toEqual(['a.txt']);
    expect(c.inWork(['ls-files']).trim()).toBe(''); // Git agrees: no index file, no tracked paths
  });

  it('an index symlink must be as contained as a tree\'s: an absolute or escaping target staged only in the index is refused (review, Furio L5); a contained one reads', async () => {
    const c = kit.makeCandidate({ 'a.txt': 'a\n' });
    const stage = (target: string): void => {
      const blob = c.inWork(['hash-object', '-w', '--stdin'], target).trim();
      c.inWork(['update-index', '--add', '--cacheinfo', `120000,${blob},staged-link`]);
    };
    stage('a.txt');
    expect((await snap(c)).index.entries.map((e) => e.path)).toContain('staged-link'); // control
    stage('/etc/hosts');
    expectCode(await refusalAsync(() => snap(c)), 'escaping_symlink');
    stage('../../outside');
    expectCode(await refusalAsync(() => snap(c)), 'escaping_symlink');
  });

  it('a version 4 index cannot spend the deadline: a 4 MiB first name is refused at once, and 2,000 long entries after one that is within the limit take milliseconds (review, Livia 3)', () => {
    const header = (count: number): Buffer => { const h = Buffer.alloc(12); h.write('DIRC', 0, 'latin1'); h.writeUInt32BE(4, 4); h.writeUInt32BE(count, 8); return h; };
    const withTrailer = (body: Buffer): Buffer => Buffer.concat([body, createHash('sha1').update(body).digest()]);
    const entryOf = (path: string): Buffer => buildIndex([{ path }], { version: 4 }).subarray(12, -20); // 62 bytes, strip 0, the path, NUL
    const within3900 = `${`${'a'.repeat(99)}/`.repeat(38)}${'a'.repeat(50)}`; // 3,852 bytes in components of at most 99
    const extra = entryOf('x'); // strip count 0 and one more byte: it extends the previous name
    const start = performance.now();
    const refused = refusal(() => parseIndex(withTrailer(Buffer.concat([header(2001), entryOf('a'.repeat(4 * 1024 * 1024)), ...Array.from({ length: 2000 }, () => extra)])), DEFAULT_LIMITS, 'index'));
    const refusedMs = performance.now() - start;
    expectCode(refused, 'limit_exceeded');
    expect(refused.limit).toBe('maxPathBytes');
    console.log(`v4 index, 4 MiB first name and 2,000 entries after it: refused in ${refusedMs.toFixed(1)} ms (before the fix: 18.0 s for 2,001 entries)`);
    expect(refusedMs).toBeLessThan(500); // before the fix: 18 s for 2,001 entries
    // control: a first name within the limit, then entries that each add a byte until the limit is reached, are read or refused in a blink
    const t = performance.now();
    const within = refusal(() => parseIndex(withTrailer(Buffer.concat([header(5001), entryOf(within3900), ...Array.from({ length: 5000 }, () => extra)])), DEFAULT_LIMITS, 'index'));
    expect(within.limit).toBe('maxPathBytes'); // 3,852 bytes and then one more each: the limit is crossed at the 245th
    expect(performance.now() - t).toBeLessThan(500);
    expect(parseIndex(withTrailer(Buffer.concat([header(51), entryOf(within3900), ...Array.from({ length: 50 }, () => extra)])), DEFAULT_LIMITS, 'index').entries).toHaveLength(51);
    // an error that is already pending does not make the loop build names: 50,000 entries after a mode error are skipped over cheaply
    const replacing = Buffer.from(extra); // strip count 1: the name is replaced by one byte, so no name ever grows
    replacing[62] = 1;
    const t2 = performance.now();
    const pendingFirst = Buffer.concat([header(50_000), buildIndex([{ path: 'a', mode: 0o100664 }], { version: 4 }).subarray(12, -20), ...Array.from({ length: 49_999 }, () => replacing)]);
    expectCode(refusal(() => parseIndex(withTrailer(pendingFirst), { ...DEFAULT_LIMITS, maxEntries: 50_000 }, 'index')), 'invalid_index', 'mode');
    const pendingMs = performance.now() - t2;
    console.log(`v4 index, 50,000 entries after a first error: ${pendingMs.toFixed(0)} ms`);
    expect(pendingMs).toBeLessThan(1500);
  });

  it('every blob the index names must be in the object store, except the empty blob of an intent-to-add entry', async () => {
    const c = kit.makeCandidate(FILES);
    const idx = join(c.admin, 'index');
    const missing = sha1Object('blob', Buffer.from('not in the store\n'));
    writeFileSync(idx, buildIndex([{ path: 'a.txt', oid: missing }]));
    const e = await refusalAsync(() => snap(c));
    expectCode(e, 'object_missing');
    expect(e.contentHex).toBe(missing);
    writeFileSync(idx, buildIndex([{ path: 'a.txt', oid: EMPTY_BLOB, intentToAdd: true }], { version: 3 }));
    expect((await snap(c)).index.entries[0]).toMatchObject({ intentToAdd: true }); // control: the empty blob is not required
    expect(() => c.inCommon(['cat-file', '-e', EMPTY_BLOB])).toThrow(); // the empty blob is not in this repository at all
  });
});
