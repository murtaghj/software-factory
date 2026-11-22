// The index (W-020a, 7.3 "The index manifest"): `DIRC`, versions 2, 3 and 4. Everything that is
// checked is checked on the bytes: name lengths, NUL padding (versions 2 and 3), prefix compression
// (version 4), the extended flags (version 3 on), the order, the modes, the extensions and the trailer.
// Stat fields are read past and dropped. Extensions are skipped by their length and never honoured.
import { createHash } from 'node:crypto';
import { ReaderError, limitError, refuse } from './errors.ts';
import type { ReaderLimits } from './limits.ts';
import { checkPath } from './path-rules.ts';

export type IndexMode = '100644' | '100755' | '120000';
export type RawIndexEntry = { pathBytes: Buffer; mode: IndexMode; oid: string; assumeValid: boolean; skipWorktree: boolean; intentToAdd: boolean };
export type ParsedIndex = { version: 2 | 3 | 4; checksum: 'verified' | 'skipped'; entries: RawIndexEntry[] };

const SKIPPED_EXTENSIONS = new Set(['TREE', 'REUC', 'UNTR', 'FSMN', 'EOIE', 'IEOT']);
const MODES: Record<number, IndexMode> = { 0o100644: '100644', 0o100755: '100755', 0o120000: '120000' };

export const EMPTY_BLOB = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';

// `tick` (the deadline) runs once per entry.
export function parseIndex(buf: Buffer, limits: ReaderLimits, file: string, tick?: () => void): ParsedIndex {
  if (buf.length < 12 + 20) throw refuse('invalid_index', 'the index is too short', file);
  if (buf.toString('latin1', 0, 4) !== 'DIRC') throw refuse('invalid_index', 'the index has no DIRC signature', file);
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3 && version !== 4) throw refuse('unsupported_index', `index version ${String(version)}`, file);
  const count = buf.readUInt32BE(8);
  if (count > limits.maxEntries) throw limitError('maxEntries', 'the index has more entries than the limit', file);
  const end = buf.length - 20;
  const trailer = buf.subarray(end);
  let checksum: 'verified' | 'skipped';
  if (trailer.every((b) => b === 0)) checksum = 'skipped'; // index.skipHash
  else {
    if (!createHash('sha1').update(buf.subarray(0, end)).digest().equals(trailer)) throw refuse('invalid_index', 'the index checksum does not verify', file);
    checksum = 'verified';
  }

  const entries: RawIndexEntry[] = [];
  let pos = 12;
  let previous: Buffer = Buffer.alloc(0);
  let totalPath = 0;
  let pending: ReaderError | undefined; // the first thing wrong with an entry; see below
  const files = new Set<string>();
  const dirs = new Set<string>();
  let previousLength = 0;
  for (let i = 0; i < count; i += 1) {
    tick?.();
    if (pos + 62 > end) throw refuse('invalid_index', 'an index entry is cut off', file);
    const modeBits = buf.readUInt32BE(pos + 24);
    const oid = buf.toString('hex', pos + 40, pos + 60);
    const flags = buf.readUInt16BE(pos + 60);
    const extended = (flags & 0x4000) !== 0;
    const stage = (flags >> 12) & 3;
    let fixed = 62;
    let skipWorktree = false;
    let intentToAdd = false;
    if (extended) {
      if (version === 2) throw refuse('invalid_index', 'an extended entry in a version 2 index', file);
      if (pos + 64 > end) throw refuse('invalid_index', 'an index entry is cut off', file);
      const ext = buf.readUInt16BE(pos + 62);
      if ((ext & ~0x6000) !== 0) throw refuse('invalid_index', 'an unknown extended flag', file);
      skipWorktree = (ext & 0x4000) !== 0;
      intentToAdd = (ext & 0x2000) !== 0;
      fixed = 64;
    }
    // The name, and where the entry ends.
    let name: Buffer;
    let next: number;
    if (version === 4) {
      let p = pos + fixed;
      let c = buf[p];
      if (c === undefined) throw refuse('invalid_index', 'an index entry is cut off', file);
      p += 1;
      let strip = c & 0x7f;
      let used = 1;
      while ((c & 0x80) !== 0) {
        c = buf[p];
        if (c === undefined || used >= 10) throw refuse('invalid_index', 'a strip count is cut off or too long', file);
        p += 1;
        used += 1;
        strip = (strip + 1) * 128 + (c & 0x7f);
        if (strip > Number.MAX_SAFE_INTEGER) throw refuse('invalid_index', 'a strip count is out of range', file);
      }
      if (strip > previousLength) throw refuse('invalid_index', 'a strip count is longer than the previous name', file);
      const nul = buf.indexOf(0, p);
      if (nul === -1 || nul >= end) throw refuse('invalid_index', 'a name is not terminated', file);
      // The name is judged by its length before it is built: a prefix-compressed name cannot grow the work of the entries after it past the path limit.
      const length = previousLength - strip + (nul - p);
      if (length > limits.maxPathBytes) throw limitError('maxPathBytes', 'a path is longer than the limit', file);
      name = pending === undefined ? Buffer.concat([previous.subarray(0, previousLength - strip), buf.subarray(p, nul)]) : Buffer.alloc(0);
      next = nul + 1;
      previousLength = length;
    } else {
      const declared = flags & 0xfff;
      const start = pos + fixed;
      let len = declared;
      if (declared === 0xfff) {
        const nul = buf.indexOf(0, start + declared);
        if (nul === -1 || nul >= end) throw refuse('invalid_index', 'a long name is not terminated', file);
        len = nul - start;
      }
      if (start + len >= end) throw refuse('invalid_index', 'an index entry is cut off', file);
      name = buf.subarray(start, start + len);
      next = pos + ((fixed + len + 8) & ~7);
      if (next > end) throw refuse('invalid_index', 'an index entry is cut off', file);
      for (let q = start + len; q < next; q += 1) if (buf[q] !== 0) throw refuse('invalid_index', 'an index entry is not NUL padded', file);
    }
    pos = next;
    if (version === 4) previous = name;

    // What is wrong with an entry is reported after the extensions have been read: a split or sparse index holds entries that are not
    // plain files, and the refusal that names the real reason (`split_index`, `sparse_index`) is the useful one. A cut-off entry is not deferred.
    try {
      if (stage !== 0) throw refuse('unmerged_index', 'a merge conflict entry (stage 1 to 3)', file);
      if (modeBits === 0o160000) throw refuse('submodule', 'a submodule entry', file);
      if (modeBits === 0o040000) throw refuse('invalid_index', 'a directory entry (a sparse index?)', file);
      if (intentToAdd && oid !== EMPTY_BLOB) throw refuse('invalid_index', 'an intent-to-add entry that does not name the empty blob', file);
      const mode = MODES[modeBits];
      if (mode === undefined) throw refuse('invalid_index', 'an entry mode other than 100644, 100755 or 120000', file);
      const display = Buffer.from(name);
      totalPath += display.length;
      if (totalPath > limits.maxTotalPathBytes) throw limitError('maxTotalPathBytes', 'the index paths together are larger than the limit', file);
      checkPath(display, limits, file, mode === '120000');
      const last = entries[entries.length - 1];
      if (last !== undefined) {
        const c = Buffer.compare(last.pathBytes, display);
        if (c === 0) throw refuse('invalid_index', 'two entries have the same name', file);
        if (c > 0) throw refuse('invalid_index', 'the entries are not in ascending order', file);
      }
      // A name may not be both a file and a directory.
      const key = display.toString('latin1');
      if (dirs.has(key)) throw refuse('invalid_index', 'a file and a directory share a name', file);
      for (let s = key.indexOf('/'); s !== -1; s = key.indexOf('/', s + 1)) {
        const dir = key.slice(0, s);
        if (files.has(dir)) throw refuse('invalid_index', 'a file and a directory share a name', file);
        dirs.add(dir);
      }
      files.add(key);
      entries.push({ pathBytes: display, mode, oid, assumeValid: (flags & 0x8000) !== 0, skipWorktree, intentToAdd });
    } catch (e) {
      if (!(e instanceof ReaderError)) throw e;
      pending ??= e;
    }
  }

  let sparse = false;
  let split = false;
  while (pos < end) {
    if (pos + 8 > end) throw refuse('invalid_index', 'an extension header is cut off', file);
    const sig = buf.toString('latin1', pos, pos + 4);
    const size = buf.readUInt32BE(pos + 4);
    if (pos + 8 + size > end) throw refuse('invalid_index', 'an extension runs past the trailer', file);
    pos += 8 + size;
    if (SKIPPED_EXTENSIONS.has(sig)) continue;
    if (sig === 'link') { split = true; continue; }
    if (sig === 'sdir') { sparse = true; continue; }
    if (sig.charCodeAt(0) >= 0x41 && sig.charCodeAt(0) <= 0x5a) continue; // optional, and unknown
    throw refuse('unsupported_index', `a required extension that is not understood (${JSON.stringify(sig)})`, file);
  }
  if (split) throw refuse('split_index', 'a split index (link extension)', file);
  if (sparse) throw refuse('sparse_index', 'a sparse index (sdir extension)', file);
  if (pending !== undefined) throw pending;
  return { version, checksum, entries };
}
