// Trees (W-020a, 7.3 "Commits and trees"). An entry is `<octal mode> <name>\0<20 bytes>`. The mode is
// canonicalised the way Git does when it reads a tree (G1): a regular file is 100755 when the owner's
// execute bit is set and 100644 otherwise, 120000 is a symlink, 40000 a directory. A zero-padded mode is
// refused (G3). Entries are returned in the order stored; the digest sorts them itself.
import { refuse } from './errors.ts';
import { checkTreeName } from './path-rules.ts';

export type TreeEntry = { kind: 'dir' | 'file' | 'symlink' | 'gitlink'; mode: '100644' | '100755' | '120000' | '40000'; name: Buffer; oid: string };

export type ParseTreeOptions = {
  // A tree of history, not of HEAD: only the structure is judged (mode, zero padding, layout, duplicates), never the path rules, and a gitlink is
  // returned as `gitlink` for the caller to skip. W-018 reads only HEAD's tree, and its clone accepts any name that Git itself stores.
  structureOnly?: boolean;
  // Runs every few thousand entries, so a large tree cannot outrun the deadline inside one call.
  tick?: () => void;
};

// What `scanTree` shows its callback for each entry: offsets into the tree body, in one object that is reused. A tree of a million entries costs a few bytes
// of offsets per entry (for the duplicate check), not an object, a copied name and a hex id each (review, Furio L9).
export type TreeCursor = { kind: 'dir' | 'file' | 'symlink' | 'gitlink'; mode: '100644' | '100755' | '120000' | '40000'; nameStart: number; nameEnd: number; oidStart: number };

const compareNames = (body: Buffer, aStart: number, aEnd: number, bStart: number, bEnd: number): number => body.compare(body, bStart, bEnd, aStart, aEnd);

// Walks a tree body once, calling `visit` for every entry in the order stored. Judges the mode (canonicalised as Git does, zero padding refused), the layout and,
// unless `structureOnly`, the name. A duplicate name is found afterwards, by sorting the offsets and not the names, and is refused before `scanTree` returns; a caller
// that acts on entries as they come must be ready for the whole walk to be refused.
export function scanTree(body: Buffer, file: string, options: ParseTreeOptions, visit: (entry: TreeCursor) => void): void {
  const cursor: TreeCursor = { kind: 'file', mode: '100644', nameStart: 0, nameEnd: 0, oidStart: 0 };
  let starts = new Uint32Array(256);
  let ends = new Uint32Array(256);
  let count = 0;
  let ascending = true;
  let p = 0;
  while (p < body.length) {
    if (count % 4096 === 4095) options.tick?.();
    // the mode: up to seven octal digits, then a space
    let q = p;
    let mode = 0;
    while (q < body.length && body[q] !== 0x20) {
      const d = (body[q] ?? 0) - 0x30;
      if (d < 0 || d > 7 || q - p >= 7) throw refuse('object_corrupt', q - p >= 7 ? 'a tree entry has no mode' : 'a tree entry mode is not octal', file, body.subarray(p, Math.min(q + 1, p + 8)));
      mode = mode * 8 + d;
      q += 1;
    }
    if (q >= body.length || q === p) throw refuse('object_corrupt', 'a tree entry has no mode', file);
    if (body[p] === 0x30) throw refuse('object_corrupt', 'zero_padded_mode', file, body.subarray(p, q));
    const nameStart = q + 1;
    const nul = body.indexOf(0, nameStart);
    if (nul === -1 || nul + 21 > body.length) throw refuse('object_corrupt', 'a tree entry is cut off', file);
    if (count >= starts.length) { const n = starts.length * 2; const s2 = new Uint32Array(n); s2.set(starts); starts = s2; const e2 = new Uint32Array(n); e2.set(ends); ends = e2; }
    if (ascending && count > 0 && compareNames(body, starts[count - 1] ?? 0, ends[count - 1] ?? 0, nameStart, nul) >= 0) ascending = false;
    starts[count] = nameStart;
    ends[count] = nul;
    count += 1;
    p = nul + 21;
    const typeBits = mode & 0o170000;
    cursor.nameStart = nameStart;
    cursor.nameEnd = nul;
    cursor.oidStart = nul + 1;
    if (typeBits === 0o160000) {
      if (options.structureOnly !== true) throw refuse('unsupported_tree_entry', 'a submodule entry', file, body.subarray(nameStart, nul));
      cursor.kind = 'gitlink'; cursor.mode = '40000'; // history only: no object is named by it that this repository holds
    } else if (typeBits === 0o120000) {
      if (options.structureOnly !== true) checkTreeName(body.subarray(nameStart, nul), true, file);
      cursor.kind = 'symlink'; cursor.mode = '120000';
    } else if (typeBits === 0o040000) {
      if (options.structureOnly !== true) checkTreeName(body.subarray(nameStart, nul), false, file);
      cursor.kind = 'dir'; cursor.mode = '40000';
    } else if (typeBits === 0o100000) {
      if (options.structureOnly !== true) checkTreeName(body.subarray(nameStart, nul), false, file);
      cursor.kind = 'file'; cursor.mode = (mode & 0o100) !== 0 ? '100755' : '100644';
    } else throw refuse('unsupported_tree_entry', 'an entry of an unknown type', file, body.subarray(nameStart, nul));
    visit(cursor);
  }
  if (ascending || count < 2) return;
  const order = new Uint32Array(count);
  for (let i = 0; i < count; i += 1) order[i] = i;
  order.sort((a, b) => compareNames(body, starts[a] ?? 0, ends[a] ?? 0, starts[b] ?? 0, ends[b] ?? 0));
  for (let i = 1; i < count; i += 1) {
    const a = order[i - 1] ?? 0;
    const b = order[i] ?? 0;
    if (compareNames(body, starts[a] ?? 0, ends[a] ?? 0, starts[b] ?? 0, ends[b] ?? 0) === 0) throw refuse('duplicate_path', 'a tree names the same entry twice', file, body.subarray(starts[a] ?? 0, ends[a] ?? 0));
  }
}

// The same walk, as an array of entries, for callers that want them (a test, a small tree). A name is a copy.
export function parseTree(body: Buffer, file: string, options: ParseTreeOptions = {}): TreeEntry[] {
  const out: TreeEntry[] = [];
  scanTree(body, file, options, (e) => { out.push({ kind: e.kind, mode: e.mode, name: Buffer.from(body.subarray(e.nameStart, e.nameEnd)), oid: body.toString('hex', e.oidStart, e.oidStart + 20) }); });
  return out;
}
