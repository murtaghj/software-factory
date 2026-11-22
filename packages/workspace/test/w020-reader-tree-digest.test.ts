import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TREE_DIGEST_TEST_VECTOR, computeTreeDigest, treeEntries } from '../src/tree-digest.ts';
import { claimFactoryOwned, GitRunner } from '../src/git.ts';
import { readTree } from '../src/materializer.ts';
import { openCandidate } from '../src/git-reader/index.ts';
import { makeKit, type CandidateFixture, type Kit } from './git-reader-kit.ts';
import { openCandidate as openReader } from '../src/git-reader/index.ts';
import { refusalAsync, expectCode } from './git-reader-helpers.ts';

// The differential test (7.3, 7.8): the reader's treeDigest equals W-018's readTree plus computeTreeDigest on the same commit, byte for byte.
// Cases that W-018 accepts and the reader refuses, by name (7.8 requires them listed; the earlier comment here, that there were none, was wrong):
//   'a backslash in a name'     D28: legal on Linux, unrepresentable on a host a restore may go to
//   'a component of 300 bytes'  no file system a restore writes to can hold it (NAME_MAX is 255), and the cap keeps every per-name scan short
//   'directories that hold no file, only empty trees, past the directory budget'  W-018 counts files and so accepts a million such directories (Furio's fan-out is this shape);
//                               the reader's budget for directories is derived from W-018's limits and never refuses a tree whose directories hold files, but it does refuse these at 4 Mi
//   'deep delta chains for HEAD's blobs once the cache share is used up'  W-018 asks Git, which keeps its own delta cache; the reader pays for every re-inflation in `maxWorkBytes`,
//                               so a repository whose blobs are all deep chains, with HEAD's blobs holding the whole 96 MiB cache share, could reach 4 GiB of work and be refused
//                               (not a case a fixture can make cheaply; it is named here and in the README)
// Every other case below is read by both with the same digest, or refused by both. The list is asserted at the end of the file.
let kit: Kit;
const git = new GitRunner({ allowFileTransport: true });
beforeAll(() => { kit = makeKit(); });
afterAll(() => { kit.cleanup(); });

const RECORDED = '8b2c1f5a222b30d83283009118ead7519fa5be095884acf36ac2d5787253c58c';
const u = (s: string): Buffer => Buffer.from(s, 'utf8');

async function w018(c: CandidateFixture): Promise<{ digest: string; files: ReturnType<typeof treeEntries> }> {
  const items = await readTree(git, claimFactoryOwned(c.common), c.head);
  return { digest: computeTreeDigest(items), files: treeEntries(items) };
}
async function theReader(c: CandidateFixture, limits = {}): Promise<{ digest: string; files: ReturnType<typeof treeEntries> }> {
  const r = openCandidate(c.mountRoot, c.target, limits);
  try { const s = await r.snapshot(); return { digest: s.committed.treeDigest, files: s.committed.files }; } finally { r.close(); }
}
async function agree(c: CandidateFixture): Promise<string> {
  const [a, b] = [await w018(c), await theReader(c)];
  expect(b.digest).toBe(a.digest);
  expect(b.files).toEqual(a.files);
  return b.digest;
}
// W-018's refusal code and the reader's, for the same commit.
async function bothRefuse(c: CandidateFixture): Promise<{ w: string; r: string }> {
  const w = await w018(c).then(() => 'accepted', (e: unknown) => (e as { code: string }).code);
  const r = await refusalAsync(() => theReader(c));
  return { w, r: r.code };
}

describe('treeDigest reproduced', () => {
  it("W-018's committed vector: the digest is the recorded one, from real Git, by both", async () => {
    const c = kit.makeCandidate({ 'a.txt': 'hello\n', 'bin/run.sh': { content: '#!/bin/sh\necho hi\n', mode: 0o755 }, link: { symlink: 'a.txt' }, 'dir/sub/deep.txt': 'deep\n', empty: '' });
    expect(TREE_DIGEST_TEST_VECTOR.digest).toBe(RECORDED);
    expect(await agree(c)).toBe(RECORDED);
  });

  it("G1: trees with entries of mode 100664 and 100775 are read as 100644 and 100755, as Git reads them", async () => {
    const source = kit.plumbingSource([
      { mode: '100664', name: u('plain.txt'), content: u('plain\n') },
      { mode: '100775', name: u('tool.sh'), content: u('#!/bin/sh\n') },
      { mode: '100644', name: u('normal.txt'), content: u('normal\n') },
    ]);
    const c = kit.makeCandidate({}, { source, noCheckout: true });
    const digest = await agree(c);
    const files = (await theReader(c)).files;
    expect(files.map((f) => [f.path, f.mode])).toEqual([['normal.txt', '100644'], ['plain.txt', '100644'], ['tool.sh', '100755']]);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('an unsorted tree written with --literally gives the same digest (both sort by path bytes)', async () => {
    const source = kit.plumbingSource([
      { mode: '100644', name: u('z.txt'), content: u('z\n') },
      { mode: '100644', name: u('a.txt'), content: u('a\n') },
      { mode: '100644', name: u('m.txt'), content: u('m\n') },
    ]);
    const c = kit.makeCandidate({}, { source, noCheckout: true });
    await agree(c);
    expect((await theReader(c)).files.map((f) => f.path)).toEqual(['a.txt', 'm.txt', 'z.txt']);
  });

  it('paths 256 components deep, and a name with a BOM, combining marks and case-only differences', async () => {
    const deep = `${'d/'.repeat(255)}leaf.txt`; // 256 components
    const c = kit.makeCandidate({ [deep]: 'deep\n', 'top.txt': 'top\n' });
    await agree(c);
    const names = kit.plumbingSource([
      { mode: '100644', name: u('﻿bom.txt'), content: u('bom\n') },
      { mode: '100644', name: u('é.txt'), content: u('combining\n') },
      { mode: '100644', name: u('é.txt'), content: u('precomposed\n') },
      { mode: '100644', name: u('Case.txt'), content: u('upper\n') },
      { mode: '100644', name: u('case.txt'), content: u('lower\n') },
      { mode: '100644', name: u('empty.txt'), content: u('') },
    ]);
    const n = kit.makeCandidate({}, { source: names, noCheckout: true });
    await agree(n);
    expect((await theReader(n)).files.map((f) => f.path)).toContain('﻿bom.txt'); // the BOM is part of the path
  });

  it('a path one component past the limit is refused by both (W-018: tree_too_large; the reader: limit_exceeded, maxDepth)', async () => {
    const tooDeep = kit.makeCandidate({ [`${'d/'.repeat(256)}leaf.txt`]: 'x\n' }, { noCheckout: true });
    const { w, r } = await bothRefuse(tooDeep);
    expect(w).toBe('tree_too_large');
    expect(r).toBe('limit_exceeded');
    const e = await refusalAsync(() => theReader(tooDeep));
    expect(e.limit).toBe('maxDepth');
  });

  it('a submodule entry, a non-UTF-8 name and a non-UTF-8 symlink target are refused by both with the same code', async () => {
    const submodule = kit.makeCandidate({}, { source: kit.plumbingSource([{ mode: '160000', name: u('sub'), oid: 'b'.repeat(40) }]), noCheckout: true });
    expect(await bothRefuse(submodule)).toEqual({ w: 'unsupported_tree_entry', r: 'unsupported_tree_entry' });
    const badName = kit.makeCandidate({}, { source: kit.plumbingSource([{ mode: '100644', name: Buffer.from([0x62, 0xff, 0xfe]), content: u('x') }]), noCheckout: true });
    expect(await bothRefuse(badName)).toEqual({ w: 'non_utf8_path', r: 'non_utf8_path' });
    const badTarget = kit.makeCandidate({}, { source: kit.plumbingSource([{ mode: '120000', name: u('l'), content: Buffer.from([0xc3, 0x28]) }]), noCheckout: true });
    expect(await bothRefuse(badTarget)).toEqual({ w: 'non_utf8_symlink_target', r: 'non_utf8_symlink_target' });
  });

  it('a zero-padded tree is refused by both: the reader as object_corrupt (zero_padded_mode), W-018 at its clone (G3)', async () => {
    // The tree is written by hand: a directory entry whose mode is `040000`.
    const inner = kit.plumbingSource([{ mode: '100644', name: u('f'), content: u('x') }]);
    const innerTree = kit.git(inner.work, ['rev-parse', `${inner.head}^{tree}`]).trim();
    const source = kit.plumbingSource([{ mode: '040000', name: u('dir'), oid: innerTree }]);
    kit.git(source.work, ['fetch', '--quiet', inner.work, inner.head]); // the inner tree is an object of the source, too
    const c = kit.makeCandidate({}, { source, noCheckout: true });
    const e = await refusalAsync(() => theReader(c));
    expectCode(e, 'object_corrupt', 'zero_padded_mode');
    // W-018's clone (transfer.fsckObjects=true) refuses it as well.
    const into = kit.dir('w018-clone');
    const refused = await git.run(['clone', '--no-local', '--no-checkout', '--', source.work, 'g'], { cwd: claimFactoryOwned(into), allowFailure: true });
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toMatch(/zeroPaddedFilemode/);
    // control: the same tree with the plain mode clones and reads
    const plain = kit.plumbingSource([{ mode: '40000', name: u('dir'), oid: innerTree }]);
    kit.git(plain.work, ['fetch', '--quiet', inner.work, inner.head]);
    const ok = kit.makeCandidate({}, { source: plain, noCheckout: true });
    await agree(ok);
  });
});

// ---------------------------------------------------------------- history, modes, and the list of differences
const b = (s: string): Buffer => Buffer.from(s, 'latin1');
// The third, asserted in its own test below, needs a lowered budget to show: 'directories that hold no file, only empty trees, past the directory budget'.
const KNOWN_DIFFERENCES = ['a backslash in a name', 'a component of 300 bytes'];

// W-018's whole flow: its hardened clone (transfer.fsckObjects=true), then readTree and computeTreeDigest on HEAD.
async function w018Flow(source: { work: string; head: string }): Promise<{ accepted: true; digest: string } | { accepted: false; code: string }> {
  const into = kit.dir('w018-flow');
  try {
    await git.run(['clone', '--no-local', '--no-checkout', '--', source.work, 'g'], { cwd: claimFactoryOwned(into) });
    const items = await readTree(git, claimFactoryOwned(join(into, 'g')), source.head);
    return { accepted: true, digest: computeTreeDigest(items) };
  } catch (e) { return { accepted: false, code: (e as { code?: string }).code ?? 'error' }; }
}
async function readerSnap(c: CandidateFixture, limits: Record<string, number> = {}): ReturnType<ReturnType<typeof openReader>['snapshot']> {
  const r = openReader(c.mountRoot, c.target, limits);
  try { return await r.snapshot(); } finally { r.close(); }
}
async function readerFlow(source: { work: string; head: string }): Promise<{ accepted: true; digest: string; exported: boolean } | { accepted: false; code: string }> {
  const c = kit.makeCandidate({}, { source, noCheckout: true, copyObjects: true });
  const r = openReader(c.mountRoot, c.target);
  try {
    const s = await r.snapshot();
    await r.exportPack(join(kit.dir('flow-export'), 'o.pack'));
    return { accepted: true, digest: s.committed.treeDigest, exported: true };
  } catch (e) { return { accepted: false, code: (e as { code?: string }).code ?? 'error' }; } finally { r.close(); }
}

describe('history, mode canonicalisation, and every difference named', () => {
  it('a repository whose old commits had a Latin-1 name and a backslash, and whose HEAD is clean, is accepted by W-018 and is snapshotted and exported by the reader (review, Livia 1)', async () => {
    const source = kit.historySource([
      [{ mode: '100644', name: b('r\xe9sum\xe9.txt'), content: u('old\n') }, { mode: '100644', name: u('win\\path.txt'), content: u('old\n') }, { mode: '100644', name: u('clean.txt'), content: u('c\n') }],
      [{ mode: '100644', name: u('clean.txt'), content: u('c\n') }],
    ]);
    const w = await w018Flow(source);
    expect(w.accepted).toBe(true); // W-018's clone has no objection to an old name
    const r = await readerFlow(source);
    expect(r).toMatchObject({ accepted: true, exported: true });
    expect(r.accepted && w.accepted && r.digest === w.digest).toBe(true);
    // control: the same names in HEAD's own tree are refused (non_utf8_path), which W-018 refuses too at the digest
    const bad = kit.historySource([[{ mode: '100644', name: b('r\xe9sum\xe9.txt'), content: u('x\n') }]]);
    expect(await readerFlow(bad)).toMatchObject({ accepted: false, code: 'non_utf8_path' });
    // and a submodule in an old commit does not stop the export either
    const sub = kit.historySource([[{ mode: '160000', name: u('sub'), oid: 'b'.repeat(40) }, { mode: '100644', name: u('f'), content: u('f\n') }], [{ mode: '100644', name: u('f'), content: u('f\n') }]]);
    expect(await readerFlow(sub)).toMatchObject({ accepted: true, exported: true });
  });

  it('modes with permission bits that Git canonicalises (120755, 40755, 100664, 100775) give W-018\'s digest', async () => {
    const source = kit.historySource([[
      { mode: '120755', name: u('link'), content: u('target.txt') },
      { mode: '40755', name: u('dir'), children: [{ mode: '100664', name: u('plain.txt'), content: u('p\n') }, { mode: '100775', name: u('tool.sh'), content: u('#!/bin/sh\n') }] },
      { mode: '100644', name: u('target.txt'), content: u('t\n') },
    ]]);
    const w = await w018Flow(source);
    const r = await readerFlow(source);
    expect(w).toMatchObject({ accepted: true });
    expect(r).toMatchObject({ accepted: true });
    expect(r.accepted && w.accepted && r.digest === w.digest).toBe(true);
    // the reader's own reading of the modes
    const c = kit.makeCandidate({}, { source, noCheckout: true, copyObjects: true });
    const rd = openReader(c.mountRoot, c.target);
    try { expect((await rd.snapshot()).committed.files.map((f) => `${f.path} ${f.mode}`)).toEqual(['dir/plain.txt 100644', 'dir/tool.sh 100755', 'link 120000', 'target.txt 100644']); } finally { rd.close(); }
  });

  it('every case that W-018 accepts and the reader refuses is in KNOWN_DIFFERENCES, and each of those is one; the other corpus cases agree', async () => {
    const cases: Array<{ name: string; entries: Array<{ mode: string; name: Buffer; content?: Buffer }> }> = [
      { name: 'a plain tree', entries: [{ mode: '100644', name: u('a.txt'), content: u('a\n') }] },
      { name: 'a backslash in a name', entries: [{ mode: '100644', name: u('win\\path.txt'), content: u('a\n') }] },
      { name: 'a component of 300 bytes', entries: [{ mode: '100644', name: u('n'.repeat(300)), content: u('a\n') }] },
      { name: 'a component of 255 bytes', entries: [{ mode: '100644', name: u('n'.repeat(255)), content: u('a\n') }] },
      { name: 'a name that folds to .git', entries: [{ mode: '100644', name: u('.GIT'), content: u('a\n') }] },
      { name: 'an NTFS stream of .git', entries: [{ mode: '100644', name: u('.git:stream'), content: u('a\n') }] },
      { name: 'a symlink named .gitmodules', entries: [{ mode: '120000', name: u('.gitmodules'), content: u('a.txt') }, { mode: '100644', name: u('a.txt'), content: u('a\n') }] },
      { name: 'a non-UTF-8 name', entries: [{ mode: '100644', name: b('caf\xe9'), content: u('a\n') }] },
    ];
    const differences: string[] = [];
    for (const c of cases) {
      const source = kit.historySource([c.entries]);
      const w = await w018Flow(source);
      const r = await readerFlow(source);
      if (w.accepted && !r.accepted) differences.push(c.name);
      if (w.accepted && r.accepted) expect(r.digest, c.name).toBe(w.digest);
      if (!w.accepted) expect(r.accepted, `${c.name}: W-018 refuses, so must the reader`).toBe(false);
    }
    expect(differences.sort()).toEqual([...KNOWN_DIFFERENCES].sort());
  });
});

describe('directories that hold no file', () => {
  it('the third difference: directories that hold no file, only empty trees (Furio\'s fan-out), past the directory budget — W-018 accepts a million of them, the reader refuses at a lower budget', async () => {
    const work = kit.dir('empties');
    kit.git(work, ['init', '--quiet', '--initial-branch=main']);
    const empty = kit.git(work, ['mktree'], '').trim();
    const t1 = kit.git(work, ['mktree'], `${Array.from({ length: 1000 }, (_, i) => `040000 tree ${empty}\td${String(i).padStart(4, '0')}`).join('\n')}\n`).trim();
    const t2 = kit.git(work, ['mktree'], `${Array.from({ length: 1000 }, (_, i) => `040000 tree ${t1}\td${String(i).padStart(4, '0')}`).join('\n')}\n`).trim();
    const head = kit.git(work, ['commit-tree', '-m', 'empties', t2]).trim();
    kit.git(work, ['update-ref', 'refs/heads/main', head]);
    const c = kit.makeCandidate({}, { source: { work, head }, noCheckout: true });
    expect(await readTree(git, claimFactoryOwned(c.common), head)).toEqual([]); // W-018: a million directories, and no row, since none holds a file
    expect((await readerSnap(c)).committed.files).toEqual([]); // the reader at its defaults: 1,001,000 directories is within the budget
    const e = await refusalAsync(() => readerSnap(c, { maxTreeDirectories: 100_000 }));
    expect(e.limit).toBe('maxTreeDirectories'); // and refuses at a lower one: a tree with no file in its directories is what the budget can refuse
  }, 300_000);
});

describe('collisions are counted (7.3: "the manifest counts them"; review, Livia 8)', () => {
  it('names that differ only by case, or only by normalisation form, are kept and counted, in HEAD\'s manifest', async () => {
    const source = kit.historySource([[
      { mode: '100644', name: u('Case.txt'), content: u('1') }, { mode: '100644', name: u('case.txt'), content: u('2') }, { mode: '100644', name: u('CASE.TXT'), content: u('3') },
      { mode: '100644', name: u('caf\u00e9.txt'), content: u('4') }, { mode: '100644', name: u('cafe\u0301.txt'), content: u('5') },
      { mode: '40000', name: u('Dir'), children: [{ mode: '100644', name: u('x'), content: u('6') }] }, { mode: '40000', name: u('dir'), children: [{ mode: '100644', name: u('x'), content: u('7') }] },
      { mode: '100644', name: u('unrelated.txt'), content: u('8') },
    ]]);
    const c = kit.makeCandidate({}, { source, noCheckout: true, copyObjects: true });
    const r = openReader(c.mountRoot, c.target);
    try {
      const s = await r.snapshot();
      expect(s.committed.files).toHaveLength(8); // every one of them is kept
      expect(s.committed.collisions).toEqual({ caseOnly: 3, normalization: 1 }); // case.txt and CASE.TXT; dir (and dir/x, which follows it); the second spelling of café
      expect(s.worktree.collisions).toEqual({ caseOnly: 0, normalization: 0 }); // nothing is checked out
    } finally { r.close(); }
    // control: a tree with none counts none
    const plain = kit.makeCandidate({ 'a.txt': 'a\n', 'b/c.txt': 'c\n' });
    const p = openReader(plain.mountRoot, plain.target);
    try { expect((await p.snapshot()).committed.collisions).toEqual({ caseOnly: 0, normalization: 0 }); } finally { p.close(); }
  });
});
