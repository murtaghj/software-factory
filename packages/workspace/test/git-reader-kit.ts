// Fixtures for the reader's tests (W-020a): real Git builds every repository in a temporary directory, in
// the layout W-018 creates, and a small independent pack writer builds the hostile packs that Git itself
// would never write. Nothing here is used by the reader.
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { SafeFs } from '../src/git-reader/fs-safe.ts';
import { Budget, resolveLimits, type ReaderHooks, type ReaderLimits } from '../src/git-reader/limits.ts';
import { ObjectStore } from '../src/git-reader/objects.ts';

export const sha1 = (b: Buffer | string): string => createHash('sha1').update(b).digest('hex');
export const sha1Object = (type: string, body: Buffer): string => createHash('sha1').update(`${type} ${String(body.length)}\0`).update(body).digest('hex');

export type Kit = ReturnType<typeof makeKit>;
export type FileSpec = string | Buffer | { content?: string | Buffer; mode?: number; symlink?: string };

export function makeKit() {
  const base = mkdtempSync(join(tmpdir(), 'w020-'));
  const home = join(base, 'home');
  mkdirSync(home);
  const env = {
    PATH: '/usr/bin:/bin', HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z', LC_ALL: 'C',
  };
  let n = 0;
  const dir = (name: string): string => { n += 1; const d = join(base, `${name}-${String(n)}`); mkdirSync(d, { recursive: true }); return d; };
  const git = (cwd: string, args: string[], input?: Buffer | string): string =>
    execFileSync('/usr/bin/git', args, { cwd, env, encoding: 'utf8', maxBuffer: 1 << 30, ...(input === undefined ? {} : { input }), stdio: ['pipe', 'pipe', 'pipe'] });
  const gitRaw = (cwd: string, args: string[], input?: Buffer | string): Buffer =>
    execFileSync('/usr/bin/git', args, { cwd, env, maxBuffer: 1 << 30, ...(input === undefined ? {} : { input }), stdio: ['pipe', 'pipe', 'pipe'] });

  function writeFiles(root: string, files: Record<string, FileSpec>): void {
    for (const [path, spec] of Object.entries(files)) {
      const full = join(root, path);
      mkdirSync(dirname(full), { recursive: true });
      rmSync(full, { force: true });
      if (typeof spec === 'object' && !Buffer.isBuffer(spec) && spec.symlink !== undefined) { symlinkSync(spec.symlink, full); continue; }
      const content = typeof spec === 'string' || Buffer.isBuffer(spec) ? spec : (spec.content ?? '');
      writeFileSync(full, content);
      if (typeof spec === 'object' && !Buffer.isBuffer(spec) && spec.mode !== undefined) chmodSync(full, spec.mode);
    }
  }

  // A source repository (the "remote"): files committed on main.
  function makeSource(files: Record<string, FileSpec>, more: Array<Record<string, FileSpec>> = []): { work: string; head: string } {
    const work = dir('src');
    git(work, ['init', '--quiet', '--initial-branch=main']);
    writeFiles(work, files);
    git(work, ['add', '-A']);
    git(work, ['commit', '--quiet', '-m', 'base']);
    for (const [i, m] of more.entries()) {
      writeFiles(work, m);
      git(work, ['add', '-A']);
      git(work, ['commit', '--quiet', '-m', `change ${String(i)}`]);
    }
    return { work, head: git(work, ['rev-parse', 'HEAD']).trim() };
  }

  // The layout W-018 creates: <mount>/factory/<org>/<workspace>/g<n>/{git, work/main}.
  // A source whose HEAD tree is written by hand, so a mode, a name or an order can be anything: `entries` are the root tree's own entries.
  function plumbingSource(entries: Array<{ mode: string; name: Buffer; content?: Buffer; oid?: string }>): { work: string; head: string } {
    const work = dir('plumb');
    git(work, ['init', '--quiet', '--initial-branch=main']);
    const chunks: Buffer[] = [];
    for (const e of entries) {
      const oid = e.oid ?? (e.content === undefined ? 'a'.repeat(40) : gitRaw(work, ['hash-object', '-w', '--stdin'], e.content).toString().trim());
      chunks.push(Buffer.from(`${e.mode} `), e.name, Buffer.from([0]), Buffer.from(oid, 'hex'));
    }
    const tree = gitRaw(work, ['hash-object', '-t', 'tree', '-w', '--literally', '--stdin'], Buffer.concat(chunks)).toString().trim();
    const head = git(work, ['commit-tree', '-m', 'plumbing', tree]).trim();
    git(work, ['update-ref', 'refs/heads/main', head]);
    return { work, head };
  }

  // Trees written by hand: `children` makes a directory entry from a subtree. The last of `history` is HEAD, and each commit has the one before as its parent.
  type TreeSpec = { mode: string; name: Buffer; content?: Buffer; oid?: string; children?: TreeSpec[] };
  function historySource(history: TreeSpec[][]): { work: string; head: string } {
    const work = dir('history');
    git(work, ['init', '--quiet', '--initial-branch=main']);
    const write = (entries: TreeSpec[]): string => {
      const chunks: Buffer[] = [];
      const key = (e: TreeSpec): Buffer => Buffer.concat([e.name, e.children !== undefined || e.mode === '40000' || e.mode === '40755' ? Buffer.from('/') : Buffer.alloc(0)]);
      for (const e of [...entries].sort((a, c) => Buffer.compare(key(a), key(c)))) { // Git's order: by name, a directory as if its name ended in a slash
        const oid = e.children !== undefined ? write(e.children) : (e.oid ?? (e.content === undefined ? 'a'.repeat(40) : gitRaw(work, ['hash-object', '-w', '--stdin'], e.content).toString().trim()));
        chunks.push(Buffer.from(`${e.mode} `), e.name, Buffer.from([0]), Buffer.from(oid, 'hex'));
      }
      return gitRaw(work, ['hash-object', '-t', 'tree', '-w', '--literally', '--stdin'], Buffer.concat(chunks)).toString().trim();
    };
    let head = '';
    for (const entries of history) head = git(work, ['commit-tree', '-m', 'history', ...(head === '' ? [] : ['-p', head]), write(entries)]).trim();
    git(work, ['update-ref', 'refs/heads/main', head]);
    return { work, head };
  }

  function makeCandidate(files: Record<string, FileSpec>, o: { more?: Array<Record<string, FileSpec>>; generation?: number; source?: { work: string; head: string }; noCheckout?: boolean; copyObjects?: boolean } = {}) {
    const mount = dir('mount');
    const orgId = randomUUID();
    const workspaceId = randomUUID();
    const generation = o.generation ?? 1;
    const gen = join(mount, 'factory', orgId, workspaceId, `g${String(generation)}`);
    mkdirSync(gen, { recursive: true });
    const source = o.source ?? makeSource(files, o.more);
    // copyObjects: a plain local clone copies the object files without the checks that a transfer makes (for repositories that Git would not send)
    git(gen, o.copyObjects === true ? ['clone', '--quiet', '--no-hardlinks', '--no-checkout', source.work, 'git'] : ['-c', 'protocol.file.allow=always', 'clone', '--quiet', '--no-local', '--no-checkout', source.work, 'git']);
    const common = join(gen, 'git');
    mkdirSync(join(gen, 'work'));
    git(common, ['worktree', 'add', '--quiet', '--relative-paths', '--detach', ...(o.noCheckout === true ? ['--no-checkout'] : []), '../work/main', source.head]);
    if (o.noCheckout === true) git(join(gen, 'work', 'main'), ['read-tree', '--empty']);
    const c = {
      mount, mountRoot: Buffer.from(mount), orgId, workspaceId, generation, gen, common, gitDir: join(common, '.git'), admin: join(common, '.git', 'worktrees', 'main'),
      work: join(gen, 'work', 'main'), head: source.head, source,
      target: { orgId, workspaceId, generation },
      // Git as the oracle, run in the working tree (hooks and all: the fixture's own Git, not the reader's).
      inWork: (args: string[], input?: Buffer | string): string => git(c.work, args, input),
      inCommon: (args: string[], input?: Buffer | string): string => git(common, args, input),
      rawInCommon: (args: string[], input?: Buffer | string): Buffer => gitRaw(common, args, input),
    };
    return c;
  }

  // A bare layout with no repository in it, for tests that plant their own objects: only the directories the reader walks.
  function makeBareLayout() {
    const mount = dir('mount');
    const orgId = randomUUID();
    const workspaceId = randomUUID();
    const gen = join(mount, 'factory', orgId, workspaceId, 'g1');
    const gitDir = join(gen, 'git', '.git');
    for (const p of [join(gitDir, 'objects', 'pack'), join(gitDir, 'worktrees', 'main'), join(gitDir, 'refs', 'heads'), join(gen, 'work', 'main')]) mkdirSync(p, { recursive: true });
    return { mount, mountRoot: Buffer.from(mount), orgId, workspaceId, gen, gitDir, packDir: join(gitDir, 'objects', 'pack'), objects: join(gitDir, 'objects'), admin: join(gitDir, 'worktrees', 'main'), work: join(gen, 'work', 'main'), target: { orgId, workspaceId, generation: 1 } };
  }

  // The object store of a layout, as the reader builds it.
  function openStore(l: { gen: string; gitDir: string; objects?: string; packDir?: string }, limits: Partial<ReaderLimits> = {}, hooks: ReaderHooks = {}) {
    const objects = l.objects ?? join(l.gitDir, 'objects');
    const packDir = l.packDir ?? join(objects, 'pack');
    const budget = new Budget(resolveLimits(limits), hooks);
    const fs = new SafeFs(hooks);
    const store = new ObjectStore(fs, Buffer.from(objects), Buffer.from(packDir), budget);
    return { store, budget, fs };
  }

  // Every object of a repository, with git's own reading of it: oid -> { type, body }.
  function oracleObjects(repo: string): Map<string, { type: string; body: Buffer }> {
    const out = new Map<string, { type: string; body: Buffer }>();
    const all = gitRaw(repo, ['cat-file', '--batch-all-objects', '--batch']);
    let p = 0;
    while (p < all.length) {
      const nl = all.indexOf(0x0a, p);
      const [oid = '', type = '', size = '0'] = all.toString('latin1', p, nl).split(' ');
      const n = Number(size);
      out.set(oid, { type, body: Buffer.from(all.subarray(nl + 1, nl + 1 + n)) });
      p = nl + 1 + n + 1;
    }
    return out;
  }

  return { base, home, env, dir, git, gitRaw, writeFiles, makeSource, plumbingSource, historySource, makeCandidate, makeBareLayout, openStore, oracleObjects, cleanup: (): void => { rmSync(base, { recursive: true, force: true }); } } as const;
}

export type CandidateFixture = ReturnType<Kit['makeCandidate']>;
export type BareLayout = ReturnType<Kit['makeBareLayout']>;

// ---------------------------------------------------------------- the pack writer
const varintSize = (type: number, size: number): Buffer => {
  const out: number[] = [];
  let s = Math.floor(size / 16);
  let b = (type << 4) | (size & 15);
  while (s > 0) { out.push(b | 0x80); b = s & 0x7f; s = Math.floor(s / 128); }
  out.push(b);
  return Buffer.from(out);
};
export const offsetVarint = (rel: number): Buffer => {
  const out = [rel & 0x7f];
  let r = Math.floor(rel / 128);
  while (r > 0) { r -= 1; out.unshift(0x80 | (r & 0x7f)); r = Math.floor(r / 128); }
  return Buffer.from(out);
};
export const deltaVarint = (n: number): Buffer => {
  const out: number[] = [];
  let r = n;
  for (;;) { const b = r % 128; r = Math.floor(r / 128); if (r > 0) out.push(b | 0x80); else { out.push(b); break; } }
  return Buffer.from(out);
};

export type DeltaOp = { copy: { offset: number; size: number } } | { insert: Buffer } | { raw: number[] };
export function makeDelta(baseSize: number, resultSize: number, ops: DeltaOp[]): Buffer {
  const parts: Buffer[] = [deltaVarint(baseSize), deltaVarint(resultSize)];
  for (const op of ops) {
    if ('insert' in op) { for (let i = 0; i < op.insert.length; i += 127) { const chunk = op.insert.subarray(i, i + 127); parts.push(Buffer.from([chunk.length]), chunk); } continue; }
    if ('raw' in op) { parts.push(Buffer.from(op.raw)); continue; }
    const { offset, size } = op.copy;
    const bytes: number[] = [];
    let flags = 0x80;
    for (let i = 0; i < 4; i += 1) { const b = Math.floor(offset / 256 ** i) & 0xff; if (b !== 0) { flags |= 1 << i; bytes.push(b); } }
    const s = size === 0x10000 ? 0 : size;
    for (let i = 0; i < 3; i += 1) { const b = Math.floor(s / 256 ** i) & 0xff; if (b !== 0) { flags |= 0x10 << i; bytes.push(b); } }
    parts.push(Buffer.from([flags, ...bytes]));
  }
  return Buffer.concat(parts);
}

export type PackItem = {
  // 'base': a whole object. 'ofs': a delta against the item `base` positions earlier (or a literal relative offset in `relative`). 'ref': a delta against `baseOid`.
  kind: 'base' | 'ofs' | 'ref';
  type?: 'commit' | 'tree' | 'blob' | 'tag';
  body?: Buffer;          // base: the object; deltas: the delta stream
  base?: number;          // ofs: index of the base item
  relative?: number;      // ofs: a literal relative offset, overriding `base`
  baseOid?: string;       // ref
  name?: string;          // the object name the index lists (default: the hash of a base object)
  typeCode?: number;      // override the type bits
  declaredSize?: number;  // override the size in the entry header
  compressed?: Buffer;    // override the compressed stream
  trailing?: Buffer;      // bytes after the zlib stream, inside the entry
  dictionary?: Buffer;    // compress with a preset dictionary
  crc?: number;           // override the CRC-32 in the index
};
export type PackOptions = { forceLargeOffsets?: boolean; rawEntry?: (index: number, raw: Buffer) => Buffer; badIdxTrailer?: boolean; badPackTrailer?: boolean; idxVersion1?: boolean; idxPackChecksumWrong?: boolean; countInPack?: number; version?: number };

export function buildPack(items: PackItem[], o: PackOptions = {}): { pack: Buffer; idx: Buffer; names: string[]; offsets: number[]; name: string } {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'latin1');
  header.writeUInt32BE(o.version ?? 2, 4);
  header.writeUInt32BE(o.countInPack ?? items.length, 8);
  const chunks: Buffer[] = [header];
  const offsets: number[] = [];
  const crcs: number[] = [];
  const names: string[] = [];
  let pos = 12;
  for (const [i, it] of items.entries()) {
    offsets.push(pos);
    const body = it.body ?? Buffer.alloc(0);
    const typeCode = it.typeCode ?? (it.kind === 'ofs' ? 6 : it.kind === 'ref' ? 7 : ({ commit: 1, tree: 2, blob: 3, tag: 4 } as const)[it.type ?? 'blob']);
    const parts: Buffer[] = [varintSize(typeCode, it.declaredSize ?? body.length)];
    if (it.kind === 'ofs') {
      const rel = it.relative ?? (pos - (offsets[it.base ?? 0] ?? 0));
      parts.push(offsetVarint(rel));
    } else if (it.kind === 'ref') parts.push(Buffer.from(it.baseOid ?? '', 'hex'));
    parts.push(it.compressed ?? (it.dictionary === undefined ? deflateSync(body) : deflateSync(body, { dictionary: it.dictionary })));
    if (it.trailing !== undefined) parts.push(it.trailing);
    const raw = o.rawEntry === undefined ? Buffer.concat(parts) : o.rawEntry(i, Buffer.concat(parts)); // a mutation made here is covered by the CRC and the trailers, which are computed after it
    crcs.push(it.crc ?? crc32(raw));
    chunks.push(raw);
    pos += raw.length;
    names.push(it.name ?? (it.kind === 'base' ? sha1Object(it.type ?? 'blob', body) : sha1(`delta-${String(i)}`)));
  }
  const withoutTrailer = Buffer.concat(chunks);
  const packSum = createHash('sha1').update(withoutTrailer).digest();
  const pack = Buffer.concat([withoutTrailer, o.badPackTrailer === true ? Buffer.alloc(20, 0x11) : packSum]);

  const order = items.map((_, i) => i).sort((a, b) => Buffer.compare(Buffer.from(names[a] ?? '', 'hex'), Buffer.from(names[b] ?? '', 'hex')));
  const fan = Buffer.alloc(1024);
  const counts = new Array<number>(256).fill(0);
  for (const i of order) counts[Buffer.from(names[i] ?? '', 'hex')[0] ?? 0] = (counts[Buffer.from(names[i] ?? '', 'hex')[0] ?? 0] ?? 0) + 1;
  let acc = 0;
  for (let b = 0; b < 256; b += 1) { acc += counts[b] ?? 0; fan.writeUInt32BE(acc, b * 4); }
  const big: bigint[] = [];
  const offBuf = Buffer.alloc(order.length * 4);
  const crcBuf = Buffer.alloc(order.length * 4);
  for (const [k, i] of order.entries()) {
    crcBuf.writeUInt32BE((crcs[i] ?? 0) >>> 0, k * 4);
    const off = offsets[i] ?? 0;
    if (off >= 0x80000000 || (o.forceLargeOffsets === true && k > 0)) { offBuf.writeUInt32BE(0x80000000 + big.length, k * 4); big.push(BigInt(off)); } else offBuf.writeUInt32BE(off, k * 4);
  }
  const bigBuf = Buffer.alloc(big.length * 8);
  for (const [k, v] of big.entries()) bigBuf.writeBigUInt64BE(v, k * 8);
  const magic = o.idxVersion1 === true ? Buffer.alloc(0) : Buffer.concat([Buffer.from([0xff, 0x74, 0x4f, 0x63]), Buffer.from([0, 0, 0, 2])]);
  const idxBody = Buffer.concat([magic, fan, Buffer.concat(order.map((i) => Buffer.from(names[i] ?? '', 'hex'))), crcBuf, offBuf, bigBuf, o.idxPackChecksumWrong === true ? Buffer.alloc(20, 0x22) : packSum]);
  const idx = Buffer.concat([idxBody, o.badIdxTrailer === true ? Buffer.alloc(20, 0x33) : createHash('sha1').update(idxBody).digest()]);
  return { pack, idx, names, offsets, name: `pack-${packSum.toString('hex')}` };
}

export function installPack(packDir: string, built: { pack: Buffer; idx: Buffer; name: string }): string {
  writeFileSync(join(packDir, `${built.name}.pack`), built.pack);
  writeFileSync(join(packDir, `${built.name}.idx`), built.idx);
  return built.name;
}

// A zlib stream's raw bytes for a loose object file: `<type> <size>\0<body>`.
export function looseBytes(type: string, body: Buffer, header?: string): Buffer {
  return deflateSync(Buffer.concat([Buffer.from(header ?? `${type} ${String(body.length)}\0`), body]));
}
export function writeLoose(objectsDir: string, oid: string, bytes: Buffer): string {
  const d = join(objectsDir, oid.slice(0, 2));
  mkdirSync(d, { recursive: true });
  const f = join(d, oid.slice(2));
  writeFileSync(f, bytes);
  return f;
}

export const listFiles = (dirPath: string): string[] => (existsSync(dirPath) ? readdirSync(dirPath) : []);
export const readText = (p: string): string => readFileSync(p, 'utf8');

// ---------------------------------------------------------------- the index writer
export type IndexSpecEntry = { path: string | Buffer; mode?: number; oid?: string; stage?: number; assumeValid?: boolean; skipWorktree?: boolean; intentToAdd?: boolean; size?: number };
export type IndexOptions = { version?: 2 | 3 | 4; extensions?: Array<{ sig: string; data?: Buffer }>; skipHash?: boolean; badChecksum?: boolean; declaredCount?: number; raw?: (entries: Buffer[]) => Buffer[] };

export function buildIndex(entries: IndexSpecEntry[], o: IndexOptions = {}): Buffer {
  const version = o.version ?? 2;
  const head = Buffer.alloc(12);
  head.write('DIRC', 0, 'latin1');
  head.writeUInt32BE(version, 4);
  head.writeUInt32BE(o.declaredCount ?? entries.length, 8);
  let previous: Buffer = Buffer.alloc(0);
  const parts = entries.map((e) => {
    const name = Buffer.isBuffer(e.path) ? e.path : Buffer.from(e.path);
    const extended = e.skipWorktree === true || e.intentToAdd === true;
    const fixed = Buffer.alloc(extended ? 64 : 62);
    fixed.writeUInt32BE(e.mode ?? 0o100644, 24);
    fixed.writeUInt32BE(e.size ?? 0, 36);
    Buffer.from(e.oid ?? sha1Object('blob', Buffer.from(name)), 'hex').copy(fixed, 40);
    fixed.writeUInt16BE((e.assumeValid === true ? 0x8000 : 0) | (extended ? 0x4000 : 0) | ((e.stage ?? 0) << 12) | Math.min(name.length, 0xfff), 60);
    if (extended) fixed.writeUInt16BE((e.skipWorktree === true ? 0x4000 : 0) | (e.intentToAdd === true ? 0x2000 : 0), 62);
    if (version === 4) {
      let common = 0;
      while (common < previous.length && common < name.length && previous[common] === name[common]) common += 1;
      const strip = previous.length - common;
      previous = Buffer.from(name);
      return Buffer.concat([fixed, offsetVarint(strip), name.subarray(common), Buffer.from([0])]);
    }
    const total = (fixed.length + name.length + 8) & ~7;
    return Buffer.concat([fixed, name, Buffer.alloc(total - fixed.length - name.length)]);
  });
  const exts = (o.extensions ?? []).map((x) => { const d = x.data ?? Buffer.alloc(0); const h = Buffer.alloc(8); h.write(x.sig, 0, 'latin1'); h.writeUInt32BE(d.length, 4); return Buffer.concat([h, d]); });
  const body = Buffer.concat([head, ...(o.raw === undefined ? parts : o.raw(parts)), ...exts]);
  const trailer = o.skipHash === true ? Buffer.alloc(20) : o.badChecksum === true ? Buffer.alloc(20, 0x44) : createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// Runs git-reader-child.ts with a hard time limit. A reader that blocked on a FIFO would be killed at the limit and report `timedOut`.
import { spawnSync } from 'node:child_process';
export function readInChild(c: { mount: string; orgId: string; workspaceId: string; generation: number }, limits?: Record<string, number>, timeoutMs = 5000, swapForFifo?: string): { timedOut: boolean; result?: { ok: boolean; code?: string; limit?: string; reason?: string; commit?: string; bug?: string; files?: string[]; excluded?: Array<{ path: string; reason: string }> } } {
  const r = spawnSync(process.execPath, [join(import.meta.dirname, 'git-reader-child.ts'), JSON.stringify({ mount: c.mount, orgId: c.orgId, workspaceId: c.workspaceId, generation: c.generation, ...(limits === undefined ? {} : { limits }), ...(swapForFifo === undefined ? {} : { swapForFifo }) })], { timeout: timeoutMs, encoding: 'utf8' });
  if (r.error !== undefined || r.signal !== null) return { timedOut: true };
  return { timedOut: false, result: JSON.parse(r.stdout) as { ok: boolean } };
}

// A chain of `depth` deltas over a base of `baseSize` bytes: each delta copies the whole object so far (in copies of at most 0xffffff
// bytes, the largest a copy instruction can say) and adds one byte. Only the tip's name is real; the other names are fillers.
export function deltaChain(depth: number, baseSize: number): { items: PackItem[]; tip: string; tipBody: () => Buffer } {
  const base = Buffer.alloc(baseSize, 0x61);
  const items: PackItem[] = [{ kind: 'base', type: 'blob', body: base }];
  for (let k = 1; k <= depth; k += 1) {
    const before = baseSize + k - 1;
    const ops: DeltaOp[] = [];
    for (let off = 0; off < before; off += 0xffffff) ops.push({ copy: { offset: off, size: Math.min(0xffffff, before - off) } });
    ops.push({ insert: Buffer.from('x') });
    items.push({ kind: 'ofs', base: k - 1, body: makeDelta(before, before + 1, ops), name: sha1(`link-${String(k)}`) });
  }
  const tipBody = (): Buffer => Buffer.concat([base, Buffer.alloc(depth, 0x78)]);
  const tip = depth === 0 ? sha1Object('blob', base) : sha1Object('blob', tipBody());
  if (depth > 0) items[depth] = { ...(items[depth] as PackItem), name: tip };
  return { items, tip, tipBody };
}

// Runs git-reader-mem-child.ts: one scenario in its own process, with the peak of heapUsed + arrayBuffers it sampled.
export type MemResult = { ok: boolean; code?: string; limit?: string; reason?: string; bug?: string; baselineMiB: number; peakMiB: number; liveMiB: number; ms: number; [k: string]: unknown };
export function measureInChild(args: object, timeoutMs = 300_000): MemResult {
  const r = spawnSync(process.execPath, ['--expose-gc', join(import.meta.dirname, 'git-reader-mem-child.ts'), JSON.stringify(args)], { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1 << 24 });
  if (r.error !== undefined || r.status !== 0) throw new Error(`the child failed: ${String(r.error ?? r.stderr).slice(0, 500)}`);
  return JSON.parse(r.stdout) as MemResult;
}
