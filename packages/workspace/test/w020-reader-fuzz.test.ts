import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ReaderError } from '../src/git-reader/errors.ts';
import { parseCommit } from '../src/git-reader/commit.ts';
import { parseIndex } from '../src/git-reader/index-file.ts';
import { SafeFs } from '../src/git-reader/fs-safe.ts';
import { Budget, DEFAULT_LIMITS, resolveLimits, type ReaderHooks } from '../src/git-reader/limits.ts';
import { Refs } from '../src/git-reader/refs.ts';
import { parseTree } from '../src/git-reader/tree.ts';
import { buildIndex, buildPack, looseBytes, makeDelta, makeKit, sha1Object, writeLoose, type Kit, type PackItem } from './git-reader-kit.ts';

// Fixed-seed mutation fuzzing (7.3, 7.8). 2,000 mutations of each of seven inputs. Every case ends in a ReaderError or in output that Git also
// reads the same way; none throws anything else, none takes more than 2 s, and the resident memory grows by less than 256 MiB over the run.
// Where the reader accepts a mutated input, the same bytes are given to Git (for the structured inputs, to the first CASES_FOR_GIT accepted cases).
let kit: Kit;
beforeAll(() => { kit = makeKit(); });
beforeEach(() => { stats.wrong.length = 0; });
afterAll(() => { kit.cleanup(); });

const MUTATIONS = 2000;
const CASES_FOR_GIT = 60;
const mulberry32 = (seed: number): (() => number) => () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

type Rng = { int: (n: number) => number };
const makeRng = (seed: number): Rng => { const r = mulberry32(seed); return { int: (n) => Math.floor(r() * n) }; };
const EXTREME32 = [0, 1, 0x7fffffff, 0x80000000, 0xfffffffe, 0xffffffff, 0x00ffffff, 0x10000];

// One to two mutations: a bit flip, a byte set to an extreme, truncation, insertion, appended bytes (trailing data), a 32-bit field set to an extreme, a duplicated chunk.
function mutate(rng: Rng, input: Buffer): Buffer {
  let out = Buffer.from(input);
  for (let n = 1 + rng.int(2); n > 0 && out.length > 0; n -= 1) {
    const pos = rng.int(out.length);
    switch (rng.int(7)) {
      case 0: out[pos] = (out[pos] ?? 0) ^ (1 << rng.int(8)); break;
      case 1: out[pos] = [0x00, 0xff, 0x80, 0x7f][rng.int(4)] ?? 0; break;
      case 2: out = out.subarray(0, pos); break;
      case 3: out = Buffer.concat([out.subarray(0, pos), Buffer.from(Array.from({ length: 1 + rng.int(16) }, () => rng.int(256))), out.subarray(pos)]); break;
      case 4: out = Buffer.concat([out, Buffer.from(Array.from({ length: 1 + rng.int(16) }, () => rng.int(256)))]); break;
      case 5: if (out.length >= 4) out.writeUInt32BE(EXTREME32[rng.int(EXTREME32.length)] ?? 0, Math.min(pos, out.length - 4)); break;
      default: { const len = 1 + rng.int(Math.min(32, out.length)); out = Buffer.concat([out.subarray(0, pos + len), out.subarray(pos)]); }
    }
  }
  return out;
}

const stats = { codes: new Map<string, number>(), cases: 0, accepted: 0, refused: 0, gitRuns: 0, maxMs: 0, wrong: [] as string[], bugs: [] as string[] };

// Runs one case: counts its time, classifies a ReaderError as a refusal, and anything else as a bug.
function runCase(label: string, f: () => boolean): boolean {
  const started = performance.now();
  stats.cases += 1;
  let accepted = false;
  try { accepted = f(); } catch (e) {
    if (!(e instanceof ReaderError)) stats.bugs.push(`${label}: ${String(e)}`);
    else stats.codes.set(e.code, (stats.codes.get(e.code) ?? 0) + 1);
  }
  const ms = performance.now() - started;
  stats.maxMs = Math.max(stats.maxMs, ms);
  if (ms > 2000) stats.bugs.push(`${label}: took ${String(Math.round(ms))} ms`);
  if (accepted) stats.accepted += 1; else stats.refused += 1;
  return accepted;
}

// How many Git runs the structured inputs may cost is bounded by CASES_FOR_GIT per input; the loose object is checked for every accepted case.
const git = (cwd: string, args: string[], env: Record<string, string> = {}, input?: Buffer): Buffer | undefined => {
  stats.gitRuns += 1;
  try { return execFileSync('/usr/bin/git', args, { cwd, env: { ...kit.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1 << 26, ...(input === undefined ? {} : { input }) }); } catch { return undefined; }
};

describe('fixed-seed mutation fuzzing', () => {
  const rssAtStart = process.memoryUsage().rss;

  it('a loose object: every case is a refusal, or the object Git reads from the same bytes; with the trailing-data check switched off a wrong acceptance is found (the control)', () => {
    const body = Buffer.from('fuzz target: a blob with enough text in it to compress into something with structure\n'.repeat(4));
    const oid = sha1Object('blob', body);
    const scratch = kit.dir('fuzz-loose');
    git(scratch, ['init', '--quiet', '--bare', '.']);
    const wrongWith = (hooks: ReaderHooks, seed: number, stopAtFirstWrong: boolean): string[] => {
      const rng = makeRng(seed);
      const wrong: string[] = [];
      const good = looseBytes('blob', body);
      for (let i = 0; i < MUTATIONS && !(stopAtFirstWrong && wrong.length > 0); i += 1) {
        const bytes = mutate(rng, good);
        const layout = kit.makeBareLayout();
        writeLoose(layout.objects, oid, bytes);
        const accepted = runCase(`loose ${String(i)}`, () => {
          const { store } = kit.openStore(layout, {}, hooks);
          try { const o = store.read(oid); if (o === undefined) return false; if (!o.body.equals(body) || o.type !== 'blob') wrong.push(`loose ${String(i)}: a different object`); return true; } finally { store.close(); }
        });
        if (accepted) {
          // Git on the same bytes (Git itself tolerates bytes after the stream, so this cannot catch that: the next check can)
          writeLoose(join(scratch, 'objects'), oid, bytes);
          const read = git(scratch, ['cat-file', 'blob', oid]);
          if (read === undefined || !read.equals(body)) wrong.push(`loose ${String(i)}: accepted by the reader, refused or read differently by Git`);
          rmSync(join(scratch, 'objects', oid.slice(0, 2)), { recursive: true, force: true });
          // An accepted loose object must be exactly one zlib stream: nothing after it.
          const consumed = (inflateSync(bytes, { info: true }) as unknown as { engine: { bytesWritten: number } }).engine.bytesWritten;
          if (consumed !== bytes.length) wrong.push(`loose ${String(i)}: accepted with ${String(bytes.length - consumed)} bytes after the zlib stream (trailing data)`);
        }
        rmSync(layout.mount, { recursive: true, force: true });
      }
      return wrong;
    };
    expect(wrongWith({}, 0x20a1, false)).toEqual([]);
    // control: the same inputs, with the trailing-data check off, include a case that the reader accepts with bytes after the stream (Git tolerates those, fsck does not)
    const wrong = wrongWith({ skipTrailingDataCheck: true }, 0x20a1, true);
    expect(wrong.length).toBeGreaterThan(0);
    expect(wrong[0]).toContain('trailing data');
  }, 240_000);

  it('a pack (mutated entries and mutated files) and an index file (mutated, trailer recomputed): refusals, or objects equal to the originals that Git reads from the same files', () => {
    const base = Buffer.from('pack fuzz base object, long enough for a delta to copy from it. '.repeat(3));
    const appended = Buffer.concat([base, Buffer.from('tail')]);
    const refResult = Buffer.concat([Buffer.from('head '), base]);
    const tree = Buffer.concat([Buffer.from('100644 file.txt\0'), Buffer.from(sha1Object('blob', base), 'hex')]);
    const commit = Buffer.from(`tree ${sha1Object('tree', tree)}\nauthor A <a@x> 1 +0000\ncommitter A <a@x> 1 +0000\n\nmessage\n`);
    const items: PackItem[] = [
      { kind: 'base', type: 'blob', body: base },
      { kind: 'base', type: 'tree', body: tree },
      { kind: 'base', type: 'commit', body: commit },
      { kind: 'ofs', base: 0, body: makeDelta(base.length, appended.length, [{ copy: { offset: 0, size: base.length } }, { insert: Buffer.from('tail') }]), name: sha1Object('blob', appended) },
      { kind: 'ref', baseOid: sha1Object('blob', base), body: makeDelta(base.length, refResult.length, [{ insert: Buffer.from('head ') }, { copy: { offset: 0, size: base.length } }]), name: sha1Object('blob', refResult) },
    ];
    const originals = new Map<string, Buffer>([[sha1Object('blob', base), base], [sha1Object('tree', tree), tree], [sha1Object('commit', commit), commit], [sha1Object('blob', appended), appended], [sha1Object('blob', refResult), refResult]]);
    const good = buildPack(items);
    const fixTrailers = (pack: Buffer, idx: Buffer): { pack: Buffer; idx: Buffer } => {
      if (pack.length < 20 || idx.length < 40) return { pack, idx };
      const packSum = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
      const p = Buffer.concat([pack.subarray(0, pack.length - 20), packSum]);
      const i = Buffer.from(idx);
      packSum.copy(i, i.length - 40);
      createHash('sha1').update(i.subarray(0, i.length - 20)).digest().copy(i, i.length - 20);
      return { pack: p, idx: i };
    };
    const scratch = kit.dir('fuzz-pack');
    git(scratch, ['init', '--quiet', '--bare', '.']);
    const rng = makeRng(0x20a2);
    let gitCases = 0;
    for (let i = 0; i < 2 * MUTATIONS; i += 1) {
      let pack: Buffer;
      let idx: Buffer;
      // 2,000 mutations of the pack (alternately of one entry, with the CRC and trailers right, and of the file, with the trailers right) and 2,000 of the index (trailer right)
      if (i < MUTATIONS && i % 2 === 0) { const target = rng.int(items.length); ({ pack, idx } = buildPack(items, { rawEntry: (k, raw) => (k === target ? mutate(rng, raw) : raw) })); }
      else if (i < MUTATIONS) ({ pack, idx } = fixTrailers(mutate(rng, good.pack), good.idx));
      else ({ pack, idx } = fixTrailers(good.pack, mutate(rng, good.idx)));
      const layout = kit.makeBareLayout();
      writeFileSync(join(layout.packDir, `${good.name}.pack`), pack);
      writeFileSync(join(layout.packDir, `${good.name}.idx`), idx);
      const read = new Map<string, Buffer>();
      const accepted = runCase(`pack ${String(i)}`, () => {
        const { store } = kit.openStore(layout);
        try {
          let any = false;
          for (const [oid, want] of originals) {
            const o = store.read(oid);
            if (o === undefined) continue;
            any = true;
            if (!o.body.equals(want)) stats.wrong.push(`pack ${String(i)}: a different object for ${oid}`);
            read.set(oid, o.body);
          }
          return any;
        } finally { store.close(); }
      });
      if (accepted && gitCases < CASES_FOR_GIT) {
        gitCases += 1;
        const objects = join(scratch, 'objects', 'pack');
        for (const f of readdirSync(objects)) rmSync(join(objects, f));
        writeFileSync(join(objects, `${good.name}.pack`), pack);
        writeFileSync(join(objects, `${good.name}.idx`), idx);
        for (const [oid, body] of read) {
          const theirs = git(scratch, ['cat-file', '-p', oid]);
          if (theirs === undefined || (theirs.length !== body.length && !oid.startsWith('tree'))) {
            // `cat-file -p` pretty-prints trees, so only blobs and commits are compared byte for byte
            const type = git(scratch, ['cat-file', '-t', oid])?.toString().trim();
            if (theirs === undefined || (type !== 'tree' && !theirs.equals(body))) stats.wrong.push(`pack ${String(i)}: ${oid} read by the reader, not by Git`);
          }
        }
      }
      rmSync(layout.mount, { recursive: true, force: true });
    }
    expect(stats.wrong).toEqual([]);
  }, 600_000);

  it('an index: refusals or entries equal to git ls-files -s', () => {
    const entries = [{ path: 'a.txt' }, { path: 'dir/b.txt', mode: 0o100755 }, { path: 'dir/sub/c', mode: 0o120000 }, { path: 'z', skipWorktree: true }, { path: 'zz', intentToAdd: true }].map((e) => ({ oid: 'intentToAdd' in e ? 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391' : sha1Object('blob', Buffer.from(e.path)), ...e }));
    const scratch = kit.dir('fuzz-index');
    git(scratch, ['init', '--quiet', '.']);
    const rng = makeRng(0x20a3);
    let gitCases = 0;
    for (const version of [2, 3, 4] as const) {
      const spec = version === 2 ? entries.slice(0, 3) : entries;
      const good = buildIndex(spec, { version });
      for (let i = 0; i < Math.ceil(MUTATIONS / 3); i += 1) {
        let bytes = mutate(rng, good);
        if (rng.int(10) < 7 && bytes.length >= 20) bytes = Buffer.concat([bytes.subarray(0, bytes.length - 20), createHash('sha1').update(bytes.subarray(0, bytes.length - 20)).digest()]); // most keep a right checksum
        let parsed: ReturnType<typeof parseIndex> | undefined;
        const accepted = runCase(`index v${String(version)} ${String(i)}`, () => { parsed = parseIndex(bytes, DEFAULT_LIMITS, 'index'); return true; });
        if (accepted && parsed !== undefined && gitCases < CASES_FOR_GIT) {
          gitCases += 1;
          const file = join(scratch, 'fuzz-index-file');
          writeFileSync(file, bytes);
          const theirs = git(scratch, ['ls-files', '-s', '-z'], { GIT_INDEX_FILE: file });
          const ours = parsed.entries.map((e) => `${e.mode} ${e.oid} 0\t${e.pathBytes.toString('latin1')}`).join('\0') + (parsed.entries.length > 0 ? '\0' : '');
          if (theirs === undefined || theirs.toString('latin1') !== ours) stats.wrong.push(`index v${String(version)} ${String(i)}: accepted, Git reads it ${theirs === undefined ? 'as an error' : 'differently'}`);
        }
      }
    }
    expect(stats.wrong).toEqual([]);
  }, 300_000);

  it('packed-refs: refusals, or the commit Git resolves HEAD to', () => {
    const c = kit.makeCandidate({ 'a.txt': 'a\n' });
    c.inWork(['checkout', '--quiet', '-b', 'fuzz-branch']);
    c.inCommon(['pack-refs', '--all']);
    const path = join(c.gitDir, 'packed-refs');
    const good = readFileSync(path);
    const rng = makeRng(0x20a4);
    let gitCases = 0;
    const fs = new SafeFs();
    for (let i = 0; i < MUTATIONS; i += 1) {
      const bytes = mutate(rng, good);
      writeFileSync(path, bytes);
      let commit = '';
      const accepted = runCase(`packed-refs ${String(i)}`, () => { commit = new Refs(fs, Buffer.from(c.gitDir), Buffer.from(c.admin), new Budget(resolveLimits())).resolveHead().commit; return true; });
      if (accepted && gitCases < CASES_FOR_GIT) {
        gitCases += 1;
        const theirs = git(c.work, ['rev-parse', 'HEAD'])?.toString().trim();
        if (theirs !== commit) stats.wrong.push(`packed-refs ${String(i)}: accepted as ${commit}, Git says ${String(theirs)}: ${JSON.stringify(bytes.toString('latin1'))}`);
      }
    }
    writeFileSync(path, good);
    expect(stats.wrong).toEqual([]);
  }, 300_000);

  it('a tree and a commit: refusals, or what Git reads from the same bytes', () => {
    const scratch = kit.dir('fuzz-tree');
    git(scratch, ['init', '--quiet', '--bare', '.']);
    const blob = Buffer.from('x');
    const blobOid = git(scratch, ['hash-object', '-w', '--stdin'], {}, blob)?.toString().trim() ?? '';
    const tree = Buffer.concat([Buffer.from('100644 a.txt\0'), Buffer.from(blobOid, 'hex'), Buffer.from('100755 b.sh\0'), Buffer.from(blobOid, 'hex'), Buffer.from('120000 link\0'), Buffer.from(blobOid, 'hex'), Buffer.from('40000 dir\0'), Buffer.from(sha1Object('tree', Buffer.alloc(0)), 'hex')]);
    const commit = Buffer.from(`tree ${sha1Object('tree', tree)}\nparent ${'1'.repeat(40)}\nparent ${'2'.repeat(40)}\nauthor A <a@x> 1 +0000\ncommitter A <a@x> 1 +0000\n\nmessage\n`);
    const rng = makeRng(0x20a5);
    let treeGit = 0;
    let commitGit = 0;
    for (let i = 0; i < MUTATIONS; i += 1) {
      const t = mutate(rng, tree);
      let parsed: ReturnType<typeof parseTree> = [];
      if (runCase(`tree ${String(i)}`, () => { parsed = parseTree(t, 'tree'); return true; }) && treeGit < CASES_FOR_GIT) {
        treeGit += 1;
        const oid = git(scratch, ['hash-object', '-t', 'tree', '--literally', '-w', '--stdin'], {}, t)?.toString().trim();
        const theirs = oid === undefined ? undefined : git(scratch, ['ls-tree', '-z', oid])?.toString('latin1');
        const ours = parsed.map((e) => `${e.mode.padStart(6, '0')} ${e.kind === 'dir' ? 'tree' : 'blob'} ${e.oid}\t${e.name.toString('latin1')}\0`).join('');
        if (theirs !== ours) stats.wrong.push(`tree ${String(i)}: accepted, Git's ls-tree differs`);
      }
      const c = mutate(rng, commit);
      let pc: ReturnType<typeof parseCommit> | undefined;
      if (runCase(`commit ${String(i)}`, () => { pc = parseCommit(c, 'commit'); return true; }) && pc !== undefined && commitGit < CASES_FOR_GIT) {
        commitGit += 1;
        const oid = git(scratch, ['hash-object', '-t', 'commit', '--literally', '-w', '--stdin'], {}, c)?.toString().trim();
        const treeOf = oid === undefined ? undefined : git(scratch, ['rev-parse', '--verify', '--quiet', `${oid}^{tree}`])?.toString().trim();
        if (treeOf !== undefined && treeOf !== pc.tree) stats.wrong.push(`commit ${String(i)}: tree ${pc.tree}, Git says ${treeOf}`);
      }
    }
    expect(stats.wrong).toEqual([]);
  }, 300_000);

  it('the whole run: no bug, no case over 2 s, and resident memory grew by less than 256 MiB', () => {
    console.log(`fuzz: ${String(stats.cases)} cases, ${String(stats.accepted)} accepted, ${String(stats.refused)} refused, ${String(stats.gitRuns)} Git runs, slowest ${stats.maxMs.toFixed(1)} ms, refusals by code ${JSON.stringify(Object.fromEntries([...stats.codes].sort()))}, rss +${String(Math.round((process.memoryUsage().rss - rssAtStart) / 1048576))} MiB`);
    expect(stats.bugs).toEqual([]);
    expect(stats.maxMs).toBeLessThan(2000);
    expect(stats.cases).toBeGreaterThanOrEqual(7 * MUTATIONS);
    expect(process.memoryUsage().rss - rssAtStart).toBeLessThan(256 * 1048576);
  });
});

