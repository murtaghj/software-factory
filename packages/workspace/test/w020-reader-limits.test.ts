import { createHash, randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openCandidateWithHooks } from '../src/git-reader/testing.ts';
import { DEFAULT_LIMITS, type ReaderLimits } from '../src/git-reader/index.ts';
import { claimFactoryOwned, GitRunner } from '../src/git.ts';
import { MATERIALIZE_LIMITS, readTree } from '../src/materializer.ts';
import { computeTreeDigest } from '../src/tree-digest.ts';
import type { ReaderHooks } from '../src/git-reader/testing.ts';
import { buildIndex, buildPack, deltaChain, installPack, looseBytes, makeDelta, makeKit, measureInChild, sha1, sha1Object, writeLoose, type CandidateFixture, type Kit, type PackItem } from './git-reader-kit.ts';
import { expectCode, refusal, refusalAsync } from './git-reader-helpers.ts';

// Each limit of the table binds, at its value and one past it, and each refusal has its control: the same fixture one under the limit reads (7.3, 7.8).
let kit: Kit;
const wGit = new GitRunner({ allowFileTransport: true });
beforeAll(() => { kit = makeKit(); });
afterAll(() => { kit.cleanup(); });

const MiB = 1024 * 1024;
async function snap(c: CandidateFixture, limits: Partial<ReaderLimits> = {}, hooks?: ReaderHooks) {
  const r = openCandidateWithHooks(c.mountRoot, c.target, limits, hooks);
  try { return await r.snapshot(); } finally { r.close(); }
}
async function exported(c: CandidateFixture, limits: Partial<ReaderLimits> = {}, hooks?: ReaderHooks) {
  const r = openCandidateWithHooks(c.mountRoot, c.target, limits, hooks);
  try { return await r.exportPack(join(kit.dir('export'), 'objects.pack')); } finally { r.close(); }
}
// The limit holds `value` (accepted) and refuses at `value - 1`, naming itself.
async function binds(run: (limits: Partial<ReaderLimits>) => Promise<unknown>, limit: keyof ReaderLimits, value: number): Promise<void> {
  await run({ [limit]: value });
  const e = await refusalAsync(() => run({ [limit]: value - 1 }));
  expectCode(e, 'limit_exceeded');
  expect(e.limit).toBe(limit);
}

describe('the work budget', () => {
  it('maxWorkBytes binds at the exact number of bytes a read costs (inflated bytes plus bytes written by deltas)', () => {
    const chain = deltaChain(40, 4096);
    const layout = kit.makeBareLayout();
    installPack(layout.packDir, buildPack(chain.items));
    const first = kit.openStore(layout);
    expect(first.store.mustRead(chain.tip).body.equals(chain.tipBody())).toBe(true);
    const cost = first.budget.work;
    // the base (4096) and 40 delta streams inflated, and 40 results written
    expect(cost).toBeGreaterThan(4096 + 40 * 4096);
    first.store.close();
    const at = kit.openStore(layout, { maxWorkBytes: cost });
    expect(at.store.mustRead(chain.tip).body.length).toBe(chain.tipBody().length);
    at.store.close();
    const over = kit.openStore(layout, { maxWorkBytes: cost - 1 });
    const e = refusal(() => over.store.mustRead(chain.tip));
    expectCode(e, 'limit_exceeded');
    expect(e.limit).toBe('maxWorkBytes');
    over.store.close();
  });

  it('a 512-deep chain of 20-byte deltas that each copy 32 MiB is refused by the work budget (Furio M2); the same chain over a small base reads', () => {
    const heavy = deltaChain(512, 32 * MiB - 512);
    const layout = kit.makeBareLayout();
    installPack(layout.packDir, buildPack(heavy.items));
    const { store } = kit.openStore(layout); // the defaults: 32 MiB per object, a work budget of 4 GiB
    const e = refusal(() => store.mustRead(heavy.tip));
    expectCode(e, 'limit_exceeded');
    expect(e.limit).toBe('maxWorkBytes');
    store.close();
    const light = deltaChain(512, 1024);
    const l2 = kit.makeBareLayout();
    installPack(l2.packDir, buildPack(light.items));
    const ok = kit.openStore(l2);
    expect(ok.store.mustRead(light.tip).body.equals(light.tipBody())).toBe(true);
    expect(ok.budget.work).toBeLessThan(512 * 1600);
    ok.store.close();
  }, 60_000);
});

describe('packs', () => {
  const three = (): ReturnType<Kit['makeBareLayout']> => {
    const l = kit.makeBareLayout();
    for (const text of ['first pack\n', 'second pack, a little longer\n', 'third pack, longer still than the second one\n']) installPack(l.packDir, buildPack([{ kind: 'base', type: 'blob', body: Buffer.from(text) }]));
    return l;
  };
  const sizes = (l: ReturnType<Kit['makeBareLayout']>): number[] => readdirSync(l.packDir).map((n) => statSync(join(l.packDir, n)).size);
  const readAll = (l: ReturnType<Kit['makeBareLayout']>, limits: Partial<ReaderLimits>): unknown => { const { store } = kit.openStore(l, limits); try { return store.read(sha1Object('blob', Buffer.from('first pack\n'))); } finally { store.close(); } };

  it('maxPackBytes: three packs that are each under it pass it together; the total binds at its value and one past it', () => {
    const l = three();
    const total = sizes(l).reduce((a, b) => a + b, 0);
    const largest = Math.max(...sizes(l));
    expect(largest).toBeLessThan(total - 1); // each file alone is under the limit that refuses the three
    expect(readAll(l, { maxPackBytes: total })).toMatchObject({ type: 'blob' });
    const e = refusal(() => readAll(l, { maxPackBytes: total - 1 }));
    expectCode(e, 'limit_exceeded');
    expect(e.limit).toBe('maxPackBytes');
    // a single file larger than the limit is refused by the same limit
    expect(refusal(() => readAll(l, { maxPackBytes: largest - 1 })).limit).toBe('maxPackBytes');
  });

  it('maxPackFiles binds at its value and one past it', () => {
    const l = three();
    expect(readAll(l, { maxPackFiles: 3 })).toMatchObject({ type: 'blob' });
    const e = refusal(() => readAll(l, { maxPackFiles: 2 }));
    expectCode(e, 'limit_exceeded');
    expect(e.limit).toBe('maxPackFiles');
  });

  it('maxObjects counts the objects the pack indexes list: three objects read at 3 and are refused at 2', () => {
    const l = kit.makeBareLayout();
    const items = ['x', 'yy', 'zzz'].map((t) => ({ kind: 'base', type: 'blob', body: Buffer.from(t) }) as const);
    installPack(l.packDir, buildPack([...items]));
    const name = sha1Object('blob', Buffer.from('x'));
    const read = (limits: Partial<ReaderLimits>): unknown => { const { store } = kit.openStore(l, limits); try { return store.read(name); } finally { store.close(); } };
    expect(read({ maxObjects: 3 })).toMatchObject({ type: 'blob' });
    expect(refusal(() => read({ maxObjects: 2 })).limit).toBe('maxObjects');
  });

  it('maxObjectBytes binds on a packed entry: a blob of exactly the limit reads, one byte more is refused from its header alone', () => {
    const at = Buffer.alloc(4096, 0x61);
    const over = Buffer.alloc(4097, 0x61);
    const read = (body: Buffer, limit: number): unknown => {
      const l = kit.makeBareLayout();
      installPack(l.packDir, buildPack([{ kind: 'base', type: 'blob', body }]));
      const { store } = kit.openStore(l, { maxObjectBytes: limit });
      try { return store.read(sha1Object('blob', body)); } finally { store.close(); }
    };
    expect(read(at, 4096)).toMatchObject({ type: 'blob' });
    expect(refusal(() => read(over, 4096)).limit).toBe('maxObjectBytes');
  });
});

describe('history and objects', () => {
  const history = (n: number): CandidateFixture => kit.makeCandidate({ 'a.txt': 'v0\n' }, { more: Array.from({ length: n - 1 }, (_, i) => ({ 'a.txt': `v${String(i + 1)}\n` })) });

  it('maxCommits binds at the number of commits reachable from HEAD and one under it', async () => {
    const c = history(6);
    const summary = await exported(c);
    expect(summary.commits).toBe(6);
    await binds((limits) => exported(c, limits), 'maxCommits', 6);
  });

  it('maxObjects binds at the number of objects the export writes and one under it', async () => {
    const c = history(4);
    const summary = await exported(c);
    expect(summary.objects).toBe(Number(c.inCommon(['count-objects', '-v']).split('\n').find((l) => l.startsWith('in-pack:'))?.split(' ')[1]));
    await binds((limits) => exported(c, limits), 'maxObjects', summary.objects);
  });

  it('deadlineMs is checked before every object, by the store itself: a 30 ms delay per object ends reads of a 60-object pack at a 100 ms deadline (no index, no working tree)', () => {
    const l = kit.makeBareLayout();
    const bodies = Array.from({ length: 60 }, (_, i) => Buffer.from(`object ${String(i)}\n`));
    installPack(l.packDir, buildPack(bodies.map((body) => ({ kind: 'base', type: 'blob', body }) as const)));
    const sleep = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
    const readAll = (limits: Partial<ReaderLimits>, delay: boolean): number => {
      let ticks = 0;
      const { store } = kit.openStore(l, limits, { beforeObject: () => { ticks += 1; if (delay) sleep(30); } });
      try { for (const body of bodies) store.mustRead(sha1Object('blob', body)); } finally { store.close(); }
      return ticks;
    };
    let ticks = 0;
    let caught: unknown;
    try {
      const { store } = kit.openStore(l, { deadlineMs: 100 }, { beforeObject: () => { ticks += 1; sleep(30); } });
      try { for (const body of bodies) store.mustRead(sha1Object('blob', body)); } finally { store.close(); }
    } catch (e) { caught = e; }
    expect(caught).toMatchObject({ code: 'limit_exceeded', limit: 'deadlineMs' });
    expect(ticks).toBeLessThan(10); // a tick before each object, not every 4,096
    // controls: the same delay under a deadline that allows it reads all 60, and no delay under the short deadline reads all 60
    expect(readAll({ deadlineMs: 60_000 }, true)).toBeGreaterThanOrEqual(60);
    expect(readAll({ deadlineMs: 100 }, false)).toBeGreaterThanOrEqual(60);
  });

  it('deadlineMs also ends a whole snapshot (the index loop and the working-tree walk tick as well)', async () => {
    const c = kit.makeCandidate({ 'a.txt': 'a\n', 'dir/b.txt': 'b\n' });
    const sleep = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
    const hooks: ReaderHooks = { beforeObject: () => { sleep(30); } };
    const e = await refusalAsync(() => snap(c, { deadlineMs: 100 }, hooks));
    expect(e.limit).toBe('deadlineMs');
    expect((await snap(c, { deadlineMs: 60_000 }, hooks)).head.commit).toBe(c.head);
  });
});

describe('the tree', () => {
  // A tree-only candidate: nothing is checked out, so the index and the working tree are empty and only HEAD's tree can bind.
  const tree = (files: Record<string, string>): CandidateFixture => kit.makeCandidate(files, { noCheckout: true });

  it('maxEntries, maxTotalBytes, maxUniqueBytes, maxPathBytes, maxDepth and maxTotalPathBytes each bind at their value and one under it', async () => {
    await binds((l) => snap(tree({ f1: '1', f2: '2', f3: '3' }), l), 'maxEntries', 3);
    const same = tree({ p1: 'y'.repeat(50), p2: 'y'.repeat(50), p3: 'y'.repeat(50) });
    await binds((l) => snap(same, l), 'maxTotalBytes', 150); // a blob counts once for every path that names it
    await binds((l) => snap(same, l), 'maxUniqueBytes', 50); // and once for its content
    await binds((l) => snap(tree({ [`${'n'.repeat(40)}/${'m'.repeat(40)}`]: 'p' }), l), 'maxPathBytes', 81);
    await binds((l) => snap(tree({ 'a/b/c/d/leaf': 'p' }), l), 'maxDepth', 5);
    await binds((l) => snap(tree({ one: 'p', two: 'p' }), l), 'maxTotalPathBytes', 6);
  });

  it('maxObjectBytes binds on a blob of the tree', async () => {
    const c = tree({ big: 'x'.repeat(400) });
    await binds((l) => snap(c, l), 'maxObjectBytes', 400);
  });
});

describe('the index and refs', () => {
  it('maxIndexBytes binds at the size of the index file and one under it', async () => {
    const c = kit.makeCandidate({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
    const size = statSync(join(c.admin, 'index')).size;
    await binds((l) => snap(c, l), 'maxIndexBytes', size);
  });

  it('maxEntries, maxPathBytes, maxDepth and maxTotalPathBytes bind on index entries', async () => {
    const c = kit.makeCandidate({ seed: 's' }, { noCheckout: true });
    const blob = c.inWork(['hash-object', '-w', '--stdin'], 'x\n').trim();
    const put = (paths: string[]): void => { writeFileSync(join(c.admin, 'index'), buildIndex(paths.map((p) => ({ path: p, oid: blob })))); };
    const run = (limits: Partial<ReaderLimits>) => snap(c, limits);
    put(['e1', 'e2', 'e3']);
    await binds(run, 'maxEntries', 3);
    put([`${'n'.repeat(40)}/${'m'.repeat(40)}`]);
    await binds(run, 'maxPathBytes', 81);
    put(['a/b/c/d/leaf']);
    await binds(run, 'maxDepth', 5);
    put(['one', 'two']);
    await binds(run, 'maxTotalPathBytes', 6);
  });

  it('maxRefFileBytes binds on HEAD, and maxPackedRefsLines on packed-refs', async () => {
    const c = kit.makeCandidate({ 'a.txt': 'a\n' });
    const name = 'x'.repeat(100);
    c.inCommon(['update-ref', `refs/heads/${name}`, c.head]);
    const text = `ref: refs/heads/${name}\n`;
    writeFileSync(join(c.admin, 'HEAD'), text);
    await binds((l) => snap(c, l), 'maxRefFileBytes', text.length);
    c.inCommon(['pack-refs', '--all']);
    const lines = readFileSync(join(c.gitDir, 'packed-refs'), 'utf8').trimEnd().split('\n').length;
    await binds((l) => snap(c, l), 'maxPackedRefsLines', lines);
  });
});

describe('directories: their own budgets, derived from W-018\'s limits (review, Furio M1 and Livia)', () => {
  it('maxTreeDirectories and maxTreeDirectoryPathBytes bind at their value and one under it, for HEAD\'s tree and for the working tree', async () => {
    const tree = (files: Record<string, string>): CandidateFixture => kit.makeCandidate(files, { noCheckout: true });
    await binds((l) => snap(tree({ 'a/x': '1', 'b/x': '2', 'c/x': '3' }), l), 'maxTreeDirectories', 3);
    await binds((l) => snap(tree({ 'aa/x': '1', 'bbb/x': '2' }), l), 'maxTreeDirectoryPathBytes', 3 + 4 + 0); // `aa/` and `bbb/`: the names, a slash each
    const c = kit.makeCandidate({ seed: 's' });
    kit.writeFiles(c.work, { 'd1/f': '1', 'd2/f': '2', 'd3/d4/f': '3' });
    await binds((l) => snap(c, l), 'maxTreeDirectories', 4);
    await binds((l) => snap(c, l), 'maxTreeDirectoryPathBytes', 3 * 3 + 3); // d1, d2, d3 and d4: two bytes and a slash each, less d4's parent counted once
  });

  it('directories do not spend the budget of file paths: with maxTotalPathBytes at 7, the one file `aa/bb/f` is read by the reader and by W-018, and at 6 both refuse (review, Livia)', async () => {
    const c = kit.makeCandidate({ 'aa/bb/f': 'x\n' }, { noCheckout: true });
    const w018 = async (maxTotalPathBytes: number): Promise<string> => {
      try { await readTree(wGit, claimFactoryOwned(c.common), c.head, { ...MATERIALIZE_LIMITS, maxTotalPathBytes }); return 'accepted'; } catch (e) { return (e as { code: string }).code; }
    };
    expect(await w018(7)).toBe('accepted');
    expect(await w018(6)).toBe('tree_too_large');
    expect((await snap(c, { maxTotalPathBytes: 7 })).committed.files.map((f) => f.path)).toEqual(['aa/bb/f']);
    const e = await refusalAsync(() => snap(c, { maxTotalPathBytes: 6 }));
    expect(e.limit).toBe('maxTotalPathBytes');
    // and the same for the working tree: files count against it, directories against their own budget
    const w = kit.makeCandidate({ seed: 's' });
    kit.writeFiles(w.work, { 'aa/bb/f': 'x' });
    expect((await snap(w, { maxTotalPathBytes: 4 + 7 })).worktree.files.map((f) => f.path)).toContain('aa/bb/f'); // `seed` and `aa/bb/f`
    expect((await refusalAsync(() => snap(w, { maxTotalPathBytes: 4 + 6 }))).limit).toBe('maxTotalPathBytes');
  });

  it('20,000 files, each in a private chain of 30 directories (600,000 directories), are read by W-018 and by the reader, with the same digest (review, Livia 1: no cap on visits beyond the rows)', async () => {
    const work = kit.dir('chains');
    kit.git(work, ['init', '--quiet', '--initial-branch=main']);
    const lines = ['blob', 'mark :1', 'data 5', 'file\n', 'commit refs/heads/main', 'committer F <f@x> 1 +0000', 'data 3', 'chn'];
    const chain = Array.from({ length: 29 }, () => 'd').join('/');
    for (let i = 0; i < 20000; i += 1) lines.push(`M 100644 :1 p${String(i).padStart(5, '0')}/${chain}/file`);
    lines.push('');
    kit.git(work, ['fast-import', '--quiet'], lines.join('\n'));
    const head = kit.git(work, ['rev-parse', 'HEAD']).trim();
    const c = kit.makeCandidate({}, { source: { work, head }, noCheckout: true });
    const items = await readTree(wGit, claimFactoryOwned(c.common), head);
    expect(items).toHaveLength(20000);
    const s = await snap(c);
    expect(s.committed.files).toHaveLength(20000);
    expect(s.committed.treeDigest).toBe(computeTreeDigest(items));
    expect(20000 * 30).toBeLessThan(DEFAULT_LIMITS.maxTreeDirectories); // 600,000 of 4 Mi
  }, 600_000);

  it('a vendored layout, pkg/<name>/<version>/file with 20,000 names of two versions each (40,000 files, 60,001 directories), is read by W-018 and by the reader, with the same digest', async () => {
    const work = kit.dir('vendored');
    kit.git(work, ['init', '--quiet', '--initial-branch=main']);
    const lines = ['blob', 'mark :1', 'data 5', 'file\n'];
    lines.push('commit refs/heads/main', 'committer F <f@x> 1 +0000', 'data 3', 'vnd');
    for (let i = 0; i < 20000; i += 1) for (const v of ['1.0.0', '2.0.0']) lines.push(`M 100644 :1 pkg/n${String(i).padStart(5, '0')}/${v}/file`);
    lines.push('');
    kit.git(work, ['fast-import', '--quiet'], lines.join('\n'));
    const head = kit.git(work, ['rev-parse', 'HEAD']).trim();
    const c = kit.makeCandidate({}, { source: { work, head }, noCheckout: true });
    const items = await readTree(wGit, claimFactoryOwned(c.common), head);
    expect(items).toHaveLength(40000);
    const s = await snap(c);
    expect(s.committed.files).toHaveLength(40000);
    expect(s.committed.treeDigest).toBe(computeTreeDigest(items));
    // the cap, by its derivation: 60,001 directories against 4 Mi, and their names against 8 MiB
    expect(60_001).toBeLessThan(DEFAULT_LIMITS.maxTreeDirectories);
    expect(DEFAULT_LIMITS.maxTreeDirectories).toBe(DEFAULT_LIMITS.maxTotalPathBytes / 2);
    expect(DEFAULT_LIMITS.maxTreeDirectoryPathBytes).toBe(DEFAULT_LIMITS.maxTotalPathBytes);
    // and at W-018's own limits the worst tree it can accept: files of 2-byte names in directories of 1-byte names are the densest
    const densest = Math.floor(DEFAULT_LIMITS.maxTotalPathBytes / 2); // each component is at least a name byte and a slash
    expect(DEFAULT_LIMITS.maxTreeDirectories).toBe(densest);
  }, 300_000);

});

// Memory, measured the way that cannot be fooled: `heapUsed + arrayBuffers`, sampled in a child process before every object and on every file-system call.
// macOS's resident-set size is not used: it compresses idle pages and showed 324 MiB where these buffers held 901 MiB (review, Livia 2).
describe('memory: the worst fixtures the reviews found, and the largest legal tree', () => {
  const GiB512 = 512;

  it('a chain of 20 legal insert-only deltas, each inflating to 32 MiB: one 32 MiB blob is read, and memory is one base, one delta and one result (review, Livia 2)', () => {
    const zeros = Buffer.alloc(32 * MiB);
    const first = makeDelta(1, zeros.length, [{ insert: zeros }]);
    const later = makeDelta(zeros.length, zeros.length, [{ insert: zeros }]);
    const items: PackItem[] = [{ kind: 'base', type: 'blob', body: Buffer.from('x') }];
    const tip = sha1Object('blob', zeros);
    for (let k = 1; k <= 20; k += 1) items.push({ kind: 'ofs', base: k - 1, body: k === 1 ? first : later, name: k === 20 ? tip : sha1(`link-${String(k)}`) });
    const l = kit.makeBareLayout();
    const built = buildPack(items);
    installPack(l.packDir, built);
    expect(built.pack.length).toBeLessThan(4 * MiB); // a pack of a few MiB
    const r = measureInChild({ kind: 'store', objects: l.objects, packDir: l.packDir, oid: tip });
    console.log(`20 x 32 MiB delta chain: live ${r.liveMiB.toFixed(0)} MiB after a collection at each object, peak ${r.peakMiB.toFixed(0)} MiB without one, baseline ${r.baselineMiB.toFixed(0)} MiB, ${String(r.ms)} ms (before the fix: 901 MiB)`);
    expect(r).toMatchObject({ ok: true, found: true, size: zeros.length });
    expect(r.liveMiB).toBeLessThan(300); // what is held, with the collector run at each object: 202 here (the 96 MiB cache, a base, a stream and a result); a leak of four 32 MiB streams makes it 330
    expect(r.peakMiB).toBeLessThan(400); // without the collector: 236 alone, 328 once under the load of three parallel workers; 901 before the fix, which held 20 streams
  }, 300_000);

  it('Furio\'s chain: links whose streams each inflate to 64 MiB are refused at the first, with one stream held, not six (review, Furio M2)', () => {
    const big = Buffer.alloc(64 * MiB + 32);
    const items: PackItem[] = [{ kind: 'base', type: 'blob', body: Buffer.from('x') }];
    for (let k = 1; k <= 6; k += 1) items.push({ kind: 'ofs', base: k - 1, body: big, name: sha1(`l${String(k)}`) });
    const l = kit.makeBareLayout();
    installPack(l.packDir, buildPack(items));
    const r = measureInChild({ kind: 'store', objects: l.objects, packDir: l.packDir, oid: sha1('l6') });
    console.log(`6 x 64 MiB delta chain: peak ${r.peakMiB.toFixed(0)} MiB, refused as ${String(r.code)} (before the fix: 513 MiB at K=6, and 4 GiB at K=64)`);
    expect(r).toMatchObject({ ok: false, code: 'object_corrupt' });
    expect(r.peakMiB).toBeLessThan(200);
  }, 300_000);

  it('a tree of 20,000 directory entries that all name the next tree, six deep, is refused by the directory budget before memory grows (review, Furio M1)', () => {
    const work = kit.dir('fanout');
    kit.git(work, ['init', '--quiet', '--initial-branch=main']);
    let t = kit.git(work, ['mktree'], '').trim();
    for (let k = 0; k < 6; k += 1) t = kit.git(work, ['mktree'], `${Array.from({ length: 20000 }, (_, i) => `040000 tree ${t}\td${String(i).padStart(5, '0')}`).join('\n')}\n`).trim();
    const head = kit.git(work, ['commit-tree', '-m', 'fan', t]).trim();
    kit.git(work, ['update-ref', 'refs/heads/main', head]);
    expect(kit.git(work, ['fsck', '--strict']).trim()).toBe(''); // Git calls it clean
    const c = kit.makeCandidate({}, { source: { work, head }, noCheckout: true });
    const r = measureInChild({ kind: 'candidate', mount: c.mount, orgId: c.orgId, workspaceId: c.workspaceId, generation: 1 });
    console.log(`fan-out 20,000 x 6: peak ${r.peakMiB.toFixed(0)} MiB, ${String(r.ms)} ms, refused as ${String(r.limit)} (before the first fix: 746 MiB, and 44 s until maxObjects)`);
    expect(r).toMatchObject({ ok: false, code: 'limit_exceeded', limit: 'maxTreeDirectoryPathBytes' }); // 8 MiB of names, 7 bytes each, before 4 Mi directories
    expect(r.peakMiB).toBeLessThan(256); // about 1.2 million directories are rows of a table, 14 bytes and an object id each
    expect(r.ms).toBeLessThan(20_000);
  }, 300_000);

  it('an index whose 64-bit offset table is 128 MiB of unused slots is refused from its size, before any of it is read (review, Furio L1); the same pack with its real index reads', () => {
    const body = Buffer.from('hello\n');
    const built = buildPack([{ kind: 'base', type: 'blob', body }]);
    const l = kit.makeBareLayout();
    const head = built.idx.subarray(0, 8 + 1024 + 28);
    const packSum = built.idx.subarray(built.idx.length - 40, built.idx.length - 20);
    const padded = Buffer.concat([head, Buffer.alloc(128 * MiB), packSum]);
    const idx = Buffer.concat([padded, createHash('sha1').update(padded).digest()]);
    writeFileSync(join(l.packDir, `${built.name}.pack`), built.pack);
    writeFileSync(join(l.packDir, `${built.name}.idx`), idx);
    const r = measureInChild({ kind: 'store', objects: l.objects, packDir: l.packDir, oid: sha1Object('blob', body) });
    console.log(`padded idx 128 MiB: peak ${r.peakMiB.toFixed(0)} MiB, ${String(r.reason)} (before the fix: a 130 MiB allocation for one object)`);
    expect(r).toMatchObject({ ok: false, code: 'object_corrupt' });
    expect(r.reason).toContain('64-bit offset table');
    expect(r.peakMiB - r.baselineMiB).toBeLessThan(40);
    const good = kit.makeBareLayout();
    installPack(good.packDir, built);
    expect(measureInChild({ kind: 'store', objects: good.objects, packDir: good.packDir, oid: sha1Object('blob', body) })).toMatchObject({ ok: true, found: true });
  }, 300_000);

  it('HEAD\'s tree of seven distinct 32 MiB blobs, each stored as a chain of four insert-only deltas: the blobs held and the chains in flight stay under the bound (review, Livia 2)', () => {
    const l = kit.makeBareLayout();
    const blobs = Array.from({ length: 7 }, (_, i) => Buffer.alloc(32 * MiB, 0x41 + i));
    const items: PackItem[] = [];
    const tips: string[] = [];
    for (const [i, blob] of blobs.entries()) {
      const first = items.length;
      items.push({ kind: 'base', type: 'blob', body: Buffer.from(`seed ${String(i)}`) });
      const tip = sha1Object('blob', blob);
      tips.push(tip);
      for (let k = 1; k <= 4; k += 1) items.push({ kind: 'ofs', base: first + k - 1, body: makeDelta(k === 1 ? 6 : blob.length, blob.length, [{ insert: blob }]), name: k === 4 ? tip : sha1(`chain-${String(i)}-${String(k)}`) });
    }
    installPack(l.packDir, buildPack(items));
    const treeBody = Buffer.concat(tips.map((tip, i) => Buffer.concat([Buffer.from(`100644 f${String(i)}\0`), Buffer.from(tip, 'hex')])));
    const treeOid = sha1Object('tree', treeBody);
    const commitBody = Buffer.from(`tree ${treeOid}\nauthor A <a@x> 1 +0000\ncommitter A <a@x> 1 +0000\n\ncombined\n`);
    const commitOid = sha1Object('commit', commitBody);
    writeLoose(l.objects, treeOid, looseBytes('tree', treeBody));
    writeLoose(l.objects, commitOid, looseBytes('commit', commitBody));
    writeFileSync(join(l.admin, 'HEAD'), `${commitOid}\n`);
    writeFileSync(join(l.admin, 'index'), buildIndex([]));
    const r = measureInChild({ kind: 'candidate', mount: l.mount, orgId: l.orgId, workspaceId: l.workspaceId, generation: 1 });
    console.log(`combined fixture (7 x 32 MiB blobs, each a 4-link chain): peak heap+arrayBuffers ${r.peakMiB.toFixed(0)} MiB, ${String(r.ms)} ms`);
    expect(r).toMatchObject({ ok: true, files: 7 });
    // The sampling sees the heap and the buffers at each object and each file call; it cannot see inside one inflate, where `inflateSync` holds its chunks and
    // then their concatenation (at most one more output, 64 MiB for a delta stream). So the figure is a lower bound and the assertion leaves room for that.
    expect(r.peakMiB + 64).toBeLessThan(512);
    expect(r.peakMiB).toBeLessThan(375); // 359 here; 391 when the held blobs do not take the cache's share (the check this assertion guards: `store.reserve`)
  }, 300_000);

  it('the combined worst case: 256 MiB of HEAD blobs (each a 4-link chain), one 32 MiB tree of a million empty-tree directories, and the comb of 1- and 2-byte names below it', () => {
    const l = kit.makeBareLayout();
    // 8 blobs of 32 MiB, each stored as a base and four insert-only deltas: 256 MiB held, chains in flight while they are read
    const blobs = Array.from({ length: 8 }, (_, i) => Buffer.alloc(32 * MiB, 0x41 + i));
    const items: PackItem[] = [];
    const tips: string[] = [];
    for (const [i, blob] of blobs.entries()) {
      const first = items.length;
      items.push({ kind: 'base', type: 'blob', body: Buffer.from(`seed ${String(i)}`) });
      const tip = sha1Object('blob', blob);
      tips.push(tip);
      for (let k = 1; k <= 4; k += 1) items.push({ kind: 'ofs', base: first + k - 1, body: makeDelta(k === 1 ? 6 : blob.length, blob.length, [{ insert: blob }]), name: k === 4 ? tip : sha1(`comb-${String(i)}-${String(k)}`) });
    }
    installPack(l.packDir, buildPack(items));
    const EMPTY = Buffer.from('4b825dc642cb6eb9a060e54bf8d69288fbee4904', 'hex'); // never stored: Git holds it, and so does the reader
    const treeOf = (entries: Array<{ mode: string; name: string; oid: Buffer }>): { oid: string; body: Buffer } => {
      const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)); // ascending by name: no sort is needed to find a duplicate
      const total = sorted.reduce((n, e) => n + e.mode.length + 1 + e.name.length + 1 + 20, 0);
      const body = Buffer.allocUnsafe(total);
      let at = 0;
      for (const e of sorted) { at += body.write(`${e.mode} ${e.name}\0`, at, 'latin1'); e.oid.copy(body, at); at += 20; }
      return { oid: sha1Object('tree', body), body };
    };
    // the comb: three levels of 1,332 names (36 of one character and 1,296 of two), the last naming the empty tree
    const alphabet = Array.from({ length: 36 }, (_, i) => i.toString(36));
    const names = alphabet.flatMap((a) => [a, ...alphabet.map((b) => `${a}${b}`)]);
    expect(names).toHaveLength(36 + 1296);
    const t3 = treeOf(names.map((name) => ({ mode: '40000', name, oid: EMPTY })));
    const t2 = treeOf(names.map((name) => ({ mode: '40000', name, oid: Buffer.from(t3.oid, 'hex') })));
    const t1 = treeOf(names.map((name) => ({ mode: '40000', name, oid: Buffer.from(t2.oid, 'hex') })));
    // the root: eight files, a million directories that name the empty tree, and `comb`
    const root = treeOf([
      ...tips.map((tip, i) => ({ mode: '100644', name: `f${String(i)}`, oid: Buffer.from(tip, 'hex') })),
      ...Array.from({ length: 1_000_000 }, (_, i) => ({ mode: '40000', name: `z${i.toString(36).padStart(4, '0')}`, oid: EMPTY })),
      { mode: '40000', name: 'comb', oid: Buffer.from(t1.oid, 'hex') },
    ]);
    expect(root.body.length).toBeLessThan(32 * MiB); // a tree of the largest size the reader reads
    expect(root.body.length).toBeGreaterThan(30 * MiB);
    const commitBody = Buffer.from(`tree ${root.oid}\nauthor A <a@x> 1 +0000\ncommitter A <a@x> 1 +0000\n\nworst case\n`);
    const commitOid = sha1Object('commit', commitBody);
    for (const t of [t1, t2, t3, root]) writeLoose(l.objects, t.oid, looseBytes('tree', t.body));
    writeLoose(l.objects, commitOid, looseBytes('commit', commitBody));
    writeFileSync(join(l.admin, 'HEAD'), `${commitOid}\n`);
    writeFileSync(join(l.admin, 'index'), buildIndex([]));
    const r = measureInChild({ kind: 'candidate', mount: l.mount, orgId: l.orgId, workspaceId: l.workspaceId, generation: 1 });
    console.log(`combined worst case: live ${r.liveMiB.toFixed(0)} MiB (collected at each object), peak ${r.peakMiB.toFixed(0)} MiB, ${String(r.code)} ${String(r.limit)}, ${String(r.ms)} ms`);
    // The comb is refused when the 8 MiB of directory names is spent, with everything above still held: that moment is the worst case.
    expect(r).toMatchObject({ ok: false, code: 'limit_exceeded', limit: 'maxTreeDirectoryPathBytes' });
    expect(r.peakMiB + 64).toBeLessThan(512); // 64 MiB for the temporaries of one inflate, which no sample can see
  }, 900_000);

  it('the work budget charges a cached read: 200 index entries that name one 32 MiB blob read and hash it once (review, Furio L3), and the cache cannot be read for free', () => {
    const src = kit.makeSource({ big: randomBytes(32 * MiB - 64) });
    kit.git(src.work, ['gc', '--quiet']);
    const c = kit.makeCandidate({}, { source: src, noCheckout: true });
    const oid = kit.git(src.work, ['rev-parse', 'HEAD:big']).trim();
    writeFileSync(join(c.admin, 'index'), buildIndex(Array.from({ length: 200 }, (_, i) => ({ path: `d/f${String(i).padStart(5, '0')}`, oid }))));
    const r = measureInChild({ kind: 'candidate', mount: c.mount, orgId: c.orgId, workspaceId: c.workspaceId, generation: 1 });
    console.log(`200 deleted entries naming one 32 MiB blob: ${String(r.ms)} ms, ${String(r.objectsRead)} objects read (before the fix: 10.7 s, 200 reads)`);
    expect(r).toMatchObject({ ok: true, deleted: 200 });
    expect(Number(r.objectsRead)).toBeLessThanOrEqual(4); // the commit, the tree, the blob; not 200
    expect(r.ms).toBeLessThan(5000);
    // and a read from the cache is charged: reading the same packed object again costs its size again
    const l = kit.makeBareLayout();
    installPack(l.packDir, buildPack([{ kind: 'base', type: 'blob', body: Buffer.alloc(1000, 7) }]));
    const { store, budget } = kit.openStore(l);
    const name = sha1Object('blob', Buffer.alloc(1000, 7));
    store.read(name);
    const once = budget.work;
    store.read(name);
    expect(budget.work).toBe(2 * once);
    store.close();
  }, 300_000);

  it('the largest legal tree: 256 MiB of committed blobs and a different 256 MiB in the working tree, taken and exported, stays under 512 MiB of heap plus buffers', () => {
    const files: Record<string, Buffer> = {};
    for (let i = 0; i < 8; i += 1) files[`big${String(i)}.bin`] = randomBytes(32 * MiB);
    const c = kit.makeCandidate(files);
    for (let i = 0; i < 8; i += 1) writeFileSync(join(c.work, `big${String(i)}.bin`), randomBytes(32 * MiB)); // a different 256 MiB, edited in place
    const out = join(kit.dir('worst'), 'objects.pack');
    const r = measureInChild({ kind: 'candidate', mount: c.mount, orgId: c.orgId, workspaceId: c.workspaceId, generation: 1, out });
    console.log(`largest legal fixture (256 MiB committed + a different 256 MiB in the working tree): peak heap+arrayBuffers ${r.peakMiB.toFixed(0)} MiB, ${String(r.objects)} objects exported, ${String(r.ms)} ms`);
    expect(r).toMatchObject({ ok: true, files: 8 });
    expect(r.peakMiB).toBeLessThan(GiB512);
    const check = kit.dir('indexed');
    kit.git(check, ['init', '--quiet', '--bare', '.']);
    expect(() => kit.git(check, ['index-pack', '--strict', '-o', join(check, 'x.idx'), out])).not.toThrow(); // the export is a real pack
  }, 600_000);
});
