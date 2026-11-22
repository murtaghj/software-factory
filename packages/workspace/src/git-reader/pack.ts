// Packs and their version 2 indexes (W-020a, 7.3). Neither file is read whole: the index is read in the
// few ranges it is made of, the pack only by positioned reads of one entry at a time, and both trailers
// are checked by streaming the file through SHA-1. An entry's compressed length is the distance to the
// next entry in the index's sorted offsets, so the bytes an inflate consumed can be compared with it (Z1).
import { crc32 } from 'node:zlib';
import { limitError, refuse } from './errors.ts';
import { deflateBound, inflateBounded, requireConsumed } from './inflate.ts';
import { join, type RandomFile, type SafeFs } from './fs-safe.ts';
import type { Budget } from './limits.ts';
import type { ObjectType } from './loose.ts';

const IDX_MAGIC = Buffer.from([0xff, 0x74, 0x4f, 0x63]);
const PACK_HEADER = 12;
const TRAILER = 20;
const TYPES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export type PackEntry =
  | { kind: 'base'; type: ObjectType; data: Buffer }
  | { kind: 'ofs'; data: Buffer; baseOffset: number }
  | { kind: 'ref'; data: Buffer; baseOid: string };

export class Pack {
  readonly id: number;
  readonly name: string;
  readonly count: number;
  readonly #file: RandomFile;
  readonly #idx: RandomFile;
  readonly #fanout: Uint32Array;
  readonly #names: Buffer;
  readonly #crcs: Uint32Array;
  readonly #offsets: Float64Array;
  readonly #order: Uint32Array;
  readonly #rank: Uint32Array;
  readonly #budget: Budget;

  private constructor(id: number, name: string, packFile: RandomFile, idxFile: RandomFile, parts: { fanout: Uint32Array; names: Buffer; crcs: Uint32Array; offsets: Float64Array; order: Uint32Array; rank: Uint32Array }, budget: Budget) {
    this.id = id;
    this.name = name;
    this.count = parts.names.length / 20;
    this.#file = packFile;
    this.#idx = idxFile;
    this.#fanout = parts.fanout;
    this.#names = parts.names;
    this.#crcs = parts.crcs;
    this.#offsets = parts.offsets;
    this.#order = parts.order;
    this.#rank = parts.rank;
    this.#budget = budget;
  }

  static load(fs: SafeFs, id: number, name: string, idxPath: Buffer, packPath: Buffer, budget: Budget, objectsLeft: number): Pack {
    const limits = budget.limits;
    const idxName = fs.show(idxPath);
    const packName = fs.show(packPath);
    const idx = fs.openRandom(idxPath, limits.maxPackBytes, 'maxPackBytes');
    let pack: RandomFile | undefined;
    try {
      pack = fs.openRandom(packPath, limits.maxPackBytes, 'maxPackBytes');
      const head = idx.size >= 8 + 1024 ? idx.readAt(0, 8 + 1024) : undefined;
      if (head === undefined) throw refuse('unsupported_pack', 'the index is too short', idxName);
      if (!head.subarray(0, 4).equals(IDX_MAGIC)) throw refuse('unsupported_pack', 'an index of version 1 (or not an index)', idxName);
      if (head.readUInt32BE(4) !== 2) throw refuse('unsupported_pack', 'only version 2 indexes are read', idxName);
      const fanout = new Uint32Array(256);
      for (let i = 0; i < 256; i += 1) {
        fanout[i] = head.readUInt32BE(8 + i * 4);
        if (i > 0 && (fanout[i] ?? 0) < (fanout[i - 1] ?? 0)) throw refuse('object_corrupt', 'the index fan-out is not monotone', idxName);
      }
      const n = fanout[255] ?? 0;
      if (n > objectsLeft) throw limitError('maxObjects', 'the pack indexes list more objects than the limit', idxName);
      const fixed = 8 + 1024 + n * 28 + 40;
      if (idx.size < fixed || (idx.size - fixed) % 8 !== 0) throw refuse('object_corrupt', 'the index size does not match its object count', idxName);
      const largeCount = (idx.size - fixed) / 8;
      // Git's rule (packfile.c): at most n - 1 offsets can need the 64-bit table. This also bounds the one read of the table below by the object count.
      if (largeCount > Math.max(0, n - 1)) throw refuse('object_corrupt', 'the index has a 64-bit offset table larger than its object count allows', idxName);
      const names = n === 0 ? Buffer.alloc(0) : idx.readAt(8 + 1024, n * 20);
      const crcBuf = n === 0 ? Buffer.alloc(0) : idx.readAt(8 + 1024 + n * 20, n * 4);
      const offBuf = n === 0 ? Buffer.alloc(0) : idx.readAt(8 + 1024 + n * 24, n * 4);
      const largeBuf = largeCount === 0 ? Buffer.alloc(0) : idx.readAt(8 + 1024 + n * 28, largeCount * 8);
      const trailer = idx.readAt(idx.size - 40, 40);
      // Names: strictly ascending, and each in the fan-out bucket of its first byte.
      for (let i = 0; i < n; i += 1) {
        const first = names[i * 20] ?? 0;
        if (i < (first === 0 ? 0 : (fanout[first - 1] ?? 0)) || i >= (fanout[first] ?? 0)) throw refuse('object_corrupt', 'an object name lies outside its fan-out bucket', idxName);
        if (i > 0 && Buffer.compare(names.subarray(i * 20 - 20, i * 20), names.subarray(i * 20, i * 20 + 20)) >= 0) throw refuse('object_corrupt', 'the index names are not strictly ascending', idxName);
      }
      const crcs = new Uint32Array(n);
      const offsets = new Float64Array(n);
      const packSize = pack.size;
      for (let i = 0; i < n; i += 1) {
        crcs[i] = crcBuf.readUInt32BE(i * 4);
        let off = offBuf.readUInt32BE(i * 4);
        if (off >= 0x80000000) {
          const slot = off - 0x80000000;
          if (slot >= largeCount) throw refuse('object_corrupt', 'a large offset points outside the 64-bit table', idxName);
          const big = largeBuf.readBigUInt64BE(slot * 8);
          if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw refuse('object_corrupt', 'a large offset is out of range', idxName);
          off = Number(big);
        }
        if (off < PACK_HEADER || off >= packSize - TRAILER) throw refuse('object_corrupt', 'an object offset lies outside the pack', idxName);
        offsets[i] = off;
      }
      const order = new Uint32Array(n);
      for (let i = 0; i < n; i += 1) order[i] = i;
      order.sort((a, b) => (offsets[a] ?? 0) - (offsets[b] ?? 0));
      const rank = new Uint32Array(n);
      for (let k = 0; k < n; k += 1) {
        const entry = order[k] ?? 0;
        rank[entry] = k;
        if (k > 0 && (offsets[order[k - 1] ?? 0] ?? 0) === (offsets[entry] ?? 0)) throw refuse('object_corrupt', 'two objects share an offset', idxName);
      }
      if (n > 0 && (offsets[order[0] ?? 0] ?? 0) !== PACK_HEADER) throw refuse('object_corrupt', 'the first object does not start right after the pack header', idxName);
      // The pack's own header and both trailers.
      if (packSize < PACK_HEADER + TRAILER) throw refuse('object_corrupt', 'the pack is too short', packName);
      const ph = pack.readAt(0, PACK_HEADER);
      if (ph.toString('latin1', 0, 4) !== 'PACK') throw refuse('unsupported_pack', 'not a pack (no PACK signature)', packName);
      const version = ph.readUInt32BE(4);
      if (version !== 2 && version !== 3) throw refuse('unsupported_pack', 'only pack versions 2 and 3 are read', packName);
      if (ph.readUInt32BE(8) !== n) throw refuse('object_corrupt', 'the pack and its index disagree on the object count', packName);
      const idxSum = idx.sha1(0, idx.size - TRAILER, () => { budget.tick(); });
      if (!idxSum.equals(trailer.subarray(20, 40))) throw refuse('object_corrupt', 'the index trailer SHA-1 does not verify', idxName);
      const packSum = pack.sha1(0, packSize - TRAILER, () => { budget.tick(); });
      const stored = pack.readAt(packSize - TRAILER, TRAILER);
      if (!packSum.equals(stored)) throw refuse('object_corrupt', 'the pack trailer SHA-1 does not verify', packName);
      if (!stored.equals(trailer.subarray(0, 20))) throw refuse('object_corrupt', 'the pack trailer differs from the checksum its index records', packName);
      return new Pack(id, name, pack, idx, { fanout, names, crcs, offsets, order, rank }, budget);
    } catch (e) {
      try { pack?.close(); } catch { /* the error below is the one that matters */ }
      try { idx.close(); } catch { /* likewise */ }
      throw e;
    }
  }

  close(): void {
    this.#file.close();
    this.#idx.close();
  }

  // The entry number of an object name, or -1.
  find(oid: Buffer): number {
    const first = oid[0] ?? 0;
    let lo = first === 0 ? 0 : (this.#fanout[first - 1] ?? 0);
    let hi = this.#fanout[first] ?? 0;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const c = Buffer.compare(this.#names.subarray(mid * 20, mid * 20 + 20), oid);
      if (c === 0) return mid;
      if (c < 0) lo = mid + 1; else hi = mid;
    }
    return -1;
  }

  nameOf(entry: number): string { return this.#names.toString('hex', entry * 20, entry * 20 + 20); }
  offsetOf(entry: number): number { return this.#offsets[entry] ?? 0; }

  // The entry that starts exactly at `offset`, or -1.
  entryAtOffset(offset: number): number {
    let lo = 0;
    let hi = this.count;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const at = this.#offsets[this.#order[mid] ?? 0] ?? 0;
      if (at === offset) return this.#order[mid] ?? -1;
      if (at < offset) lo = mid + 1; else hi = mid;
    }
    return -1;
  }

  #endOf(entry: number): number {
    const next = (this.#rank[entry] ?? 0) + 1;
    return next >= this.count ? this.#file.size - TRAILER : (this.#offsets[this.#order[next] ?? 0] ?? 0);
  }

  // The header of an entry, parsed from its first bytes: what it is and what it is based on. Nothing is inflated.
  #head(entry: number): { typeCode: number; size: number; headerLen: number; baseOffset: number; baseOid: string; off: number; len: number; file: string } {
    const file = `${this.name}.pack@${String(this.offsetOf(entry))}`;
    const off = this.offsetOf(entry);
    const len = this.#endOf(entry) - off;
    const limits = this.#budget.limits;
    const head = this.#file.readAt(off, Math.min(len, 64));
    let p = 0;
    const b0 = head[p] ?? 0;
    p += 1;
    const typeCode = (b0 >> 4) & 7;
    let size = b0 & 15;
    let scale = 16;
    let more = (b0 & 0x80) !== 0;
    while (more) {
      if (p >= 10 || p >= head.length) throw refuse('object_corrupt', 'an entry size varint is too long or cut off', file);
      const b = head[p] ?? 0;
      p += 1;
      size += (b & 0x7f) * scale;
      scale *= 128;
      if (size > Number.MAX_SAFE_INTEGER) throw refuse('object_corrupt', 'an entry size is out of range', file);
      more = (b & 0x80) !== 0;
    }
    const isDelta = typeCode === 6 || typeCode === 7;
    if (!isDelta && TYPES[typeCode] === undefined) throw refuse('object_corrupt', `an entry of type ${String(typeCode)}`, file);
    const sizeCap = isDelta ? 2 * limits.maxObjectBytes + 32 : limits.maxObjectBytes;
    if (size > sizeCap) throw limitError('maxObjectBytes', 'an entry declares a size past the object limit', file);
    let baseOffset = 0;
    let baseOid = '';
    if (typeCode === 6) {
      let c = head[p];
      if (c === undefined) throw refuse('object_corrupt', 'an offset delta ends early', file);
      p += 1;
      let rel = c & 0x7f;
      let count = 1;
      while ((c & 0x80) !== 0) {
        c = head[p];
        if (c === undefined || count >= 10) throw refuse('object_corrupt', 'an offset delta varint is too long or cut off', file);
        p += 1;
        count += 1;
        rel = (rel + 1) * 128 + (c & 0x7f);
        if (rel > Number.MAX_SAFE_INTEGER) throw refuse('object_corrupt', 'an offset delta is out of range', file);
      }
      if (rel === 0 || rel > off - PACK_HEADER) throw refuse('object_corrupt', 'an offset delta does not point at an earlier entry of this pack', file);
      baseOffset = off - rel;
    } else if (typeCode === 7) {
      if (head.length < p + 20) throw refuse('object_corrupt', 'a reference delta ends early', file);
      baseOid = head.toString('hex', p, p + 20);
      p += 20;
    }
    return { typeCode, size, headerLen: p, baseOffset, baseOid, off, len, file };
  }

  // What an entry is, and what it is based on, without inflating it (a delta chain is walked on these before any link is read).
  readHead(entry: number): { kind: 'base' } | { kind: 'ofs'; baseOffset: number } | { kind: 'ref'; baseOid: string } {
    const h = this.#head(entry);
    if (h.typeCode === 6) return { kind: 'ofs', baseOffset: h.baseOffset };
    if (h.typeCode === 7) return { kind: 'ref', baseOid: h.baseOid };
    return { kind: 'base' };
  }

  // One entry: its header, its CRC-32, and its inflated data (a whole object, or a delta stream). The bytes are charged to the work budget.
  readEntry(entry: number): PackEntry {
    const { typeCode, size, headerLen, baseOffset, baseOid, off, len, file } = this.#head(entry);
    const compLen = len - headerLen;
    if (compLen < 1) throw refuse('truncated', 'an entry has no compressed data', file);
    if (compLen > deflateBound(size)) throw refuse('trailing_data', 'an entry is longer than any stream of its declared size', file);
    const raw = this.#file.readAt(off, len);
    if (crc32(raw) !== (this.#crcs[entry] ?? -1)) throw refuse('object_corrupt', 'the CRC-32 of an entry does not match the index', file);
    this.#budget.charge(size);
    const r = inflateBounded(raw.subarray(headerLen), { maxOutput: size, file, onTooLarge: 'size_mismatch' });
    if (r.out.length !== size) throw refuse('object_corrupt', 'an entry inflates to fewer bytes than its header declares', file);
    requireConsumed(r, compLen, file, this.#budget.hooks);
    if (typeCode === 6) return { kind: 'ofs', data: r.out, baseOffset };
    if (typeCode === 7) return { kind: 'ref', data: r.out, baseOid };
    return { kind: 'base', type: TYPES[typeCode] as ObjectType, data: r.out };
  }
}

// Every pack of `objects/pack`, found by file name only: pack-<40 hex>.idx with its .pack. Anything else in the directory is never opened.
export class PackSet {
  readonly #fs: SafeFs;
  readonly #dir: Buffer;
  readonly #budget: Budget;
  #packs: Pack[] | undefined;

  constructor(fs: SafeFs, packDir: Buffer, budget: Budget) {
    this.#fs = fs;
    this.#dir = packDir;
    this.#budget = budget;
  }

  packs(): Pack[] {
    if (this.#packs !== undefined) return this.#packs;
    const limits = this.#budget.limits;
    const listing = this.#fs.listDir(this.#dir, 4 * limits.maxPackFiles + 1024, 'maxPackFiles').map((n) => n.toString('latin1'));
    const idx = listing.filter((n) => /^pack-[0-9a-f]{40}\.idx$/.test(n)).sort();
    const packFiles = new Set(listing.filter((n) => /^pack-[0-9a-f]{40}\.pack$/.test(n)));
    if (idx.length > limits.maxPackFiles) throw limitError('maxPackFiles', 'more packs than the limit');
    let total = 0;
    const found: Array<{ name: string; idx: Buffer; pack: Buffer }> = [];
    for (const i of idx) {
      const name = i.slice(0, -4);
      if (!packFiles.has(`${name}.pack`)) throw refuse('unsupported_pack', 'an index without its pack', `objects/pack/${i}`);
      const idxPath = join(this.#dir, i);
      const packPath = join(this.#dir, `${name}.pack`);
      for (const p of [idxPath, packPath]) {
        const st = this.#fs.lstat(p);
        if (st === undefined) throw refuse('path_unsafe', 'a pack file is missing', this.#fs.show(p));
        if (!st.isFile()) throw refuse(st.isSymbolicLink() ? 'path_unsafe' : 'not_regular_file', 'a pack file is not a regular file', this.#fs.show(p));
        total += Number(st.size);
        if (total > limits.maxPackBytes) throw limitError('maxPackBytes', 'the packs together are larger than the limit', 'objects/pack');
      }
      found.push({ name, idx: idxPath, pack: packPath });
    }
    const loaded: Pack[] = [];
    let objectsLeft = limits.maxObjects;
    try {
      for (const [id, f] of found.entries()) {
        const pack = Pack.load(this.#fs, id, f.name, f.idx, f.pack, this.#budget, objectsLeft);
        objectsLeft -= pack.count;
        loaded.push(pack);
      }
    } catch (e) { for (const p of loaded) { try { p.close(); } catch { /* the original error matters */ } } throw e; }
    this.#packs = loaded;
    return loaded;
  }

  find(oid: string): { pack: Pack; entry: number } | undefined {
    const raw = Buffer.from(oid, 'hex');
    for (const pack of this.packs()) {
      const entry = pack.find(raw);
      if (entry !== -1) return { pack, entry };
    }
    return undefined;
  }

  close(): void { for (const p of this.#packs ?? []) { try { p.close(); } catch { /* the first error was already reported */ } } }
}
