// The directories of a tree walk (W-020a, review Livia and Furio M1), held as a table and not as one path per directory. A directory is a row of small
// numbers (its parent, where its name is in one arena, the length of its full path, its depth) and, for a tree of objects, 20 bytes of object id; its
// full path is built only when something needs it. Directories are counted, and their names are counted in bytes, against budgets of their own, when
// a directory is first seen and not when it is visited, so that a tree whose every entry names another tree cannot fill memory before anything is judged.
//
// The budgets are derived from W-018's limits, and are the least that never refuses a tree W-018 accepts (README, "Directories"). W-018 counts files:
// at most `maxEntries`, with paths of at most `maxPathBytes` and `maxDepth` components, 8 MiB (`maxTotalPathBytes`) of file paths in all. Every directory
// of a tree that W-018 can check out holds a file somewhere below it, so it is a component of that file's path; a directory is first seen by one such
// file, and each of its components takes at least two bytes of that path (a name and a slash). So the directories are at most `maxTotalPathBytes / 2`, and
// their names, a slash each, are at most `maxTotalPathBytes` in all.
import { limitError } from './errors.ts';
import type { ReaderLimits } from './limits.ts';

export class DirTable {
  readonly #limits: ReaderLimits;
  #parent = new Uint32Array(1024);
  #nameOff = new Uint32Array(1024);
  #nameLen = new Uint16Array(1024);
  #pathLen = new Uint16Array(1024);
  #depth = new Uint16Array(1024);
  #flags = new Uint8Array(1024);
  #names = Buffer.alloc(4096);
  #namesUsed = 0;
  #oids: Buffer | undefined;
  #rootOid: string | undefined;
  readonly #maxRows: number;
  #rows = 1; // row 0 is the root
  #counted = 0; // directories seen, including those that were not given a row
  #nameBytes = 0;

  constructor(limits: ReaderLimits, rootOid?: string) {
    this.#limits = limits;
    this.#maxRows = limits.maxTreeDirectories + 1;
    this.#rootOid = rootOid;
    if (rootOid !== undefined) this.#oids = Buffer.alloc(1024 * 20);
  }

  get count(): number { return this.#counted; }

  depthOf(id: number): number { return this.#depth[id] ?? 0; }
  flagsOf(id: number): number { return this.#flags[id] ?? 0; }
  setFlags(id: number, flags: number): void { this.#flags[id] = flags; }
  // The length of the path of a file named `nameLength` bytes in directory `id`.
  fileLength(id: number, nameLength: number): number { return id === 0 ? nameLength : (this.#pathLen[id] ?? 0) + 1 + nameLength; }

  oidOf(id: number): string {
    if (id === 0) return this.#rootOid ?? '';
    return (this.#oids ?? Buffer.alloc(0)).toString('hex', id * 20, id * 20 + 20);
  }

  // Counts a directory and its name, and judges its path and depth, without giving it a row: for a directory that has nothing in it to visit.
  charge(parent: number, nameLength: number): void {
    const limits = this.#limits;
    this.#counted += 1;
    if (this.#counted > limits.maxTreeDirectories) throw limitError('maxTreeDirectories', 'there are more directories than the limit');
    this.#nameBytes += nameLength + 1;
    if (this.#nameBytes > limits.maxTreeDirectoryPathBytes) throw limitError('maxTreeDirectoryPathBytes', 'the directory names together are larger than the limit');
    if (this.fileLength(parent, nameLength) > limits.maxPathBytes) throw limitError('maxPathBytes', 'a path is longer than the limit');
    if ((this.#depth[parent] ?? 0) + 1 > limits.maxDepth) throw limitError('maxDepth', 'a path has more components than the limit');
  }

  // A directory to visit: counted, judged, and given a row. `oid` is the 40-digit id of its tree, for a walk of objects.
  add(parent: number, name: Buffer, flags = 0, oid?: Uint8Array): number {
    this.charge(parent, name.length);
    const id = this.#rows;
    if (id >= this.#parent.length) this.#grow();
    this.#rows += 1;
    if (this.#namesUsed + name.length > this.#names.length) { const bigger = Buffer.alloc(Math.min(Math.max(this.#names.length * 2, this.#namesUsed + name.length), Math.max(this.#limits.maxTreeDirectoryPathBytes, this.#namesUsed + name.length))); this.#names.copy(bigger, 0, 0, this.#namesUsed); this.#names = bigger; }
    name.copy(this.#names, this.#namesUsed);
    this.#parent[id] = parent;
    this.#nameOff[id] = this.#namesUsed;
    this.#nameLen[id] = name.length;
    this.#namesUsed += name.length;
    this.#pathLen[id] = this.fileLength(parent, name.length);
    this.#depth[id] = (this.#depth[parent] ?? 0) + 1;
    this.#flags[id] = flags;
    if (this.#oids !== undefined) {
      if ((id + 1) * 20 > this.#oids.length) { const bigger = Buffer.alloc(Math.min(this.#oids.length * 2, this.#maxRows * 20)); this.#oids.copy(bigger); this.#oids = bigger; }
      if (oid !== undefined) this.#oids.set(oid, id * 20);
    }
    return id;
  }

  #grow(): void {
    const size = Math.min(this.#parent.length * 2, this.#maxRows); // never past the most rows the directory budget allows
    const widen = <T extends Uint8Array | Uint16Array | Uint32Array>(a: T, make: (n: number) => T): T => { const b = make(size); b.set(a); return b; };
    this.#parent = widen(this.#parent, (n) => new Uint32Array(n));
    this.#nameOff = widen(this.#nameOff, (n) => new Uint32Array(n));
    this.#nameLen = widen(this.#nameLen, (n) => new Uint16Array(n));
    this.#pathLen = widen(this.#pathLen, (n) => new Uint16Array(n));
    this.#depth = widen(this.#depth, (n) => new Uint16Array(n));
    this.#flags = widen(this.#flags, (n) => new Uint8Array(n));
  }

  // The full path of directory `id`, or of the entry called `tail` in it.
  pathOf(id: number, tail?: Buffer): Buffer {
    const total = tail === undefined ? (id === 0 ? 0 : (this.#pathLen[id] ?? 0)) : this.fileLength(id, tail.length);
    const out = Buffer.allocUnsafe(total);
    let pos = total;
    if (tail !== undefined) { pos -= tail.length; tail.copy(out, pos); if (id !== 0) { pos -= 1; out[pos] = 0x2f; } }
    for (let node = id; node !== 0;) {
      const len = this.#nameLen[node] ?? 0;
      pos -= len;
      this.#names.copy(out, pos, this.#nameOff[node] ?? 0, (this.#nameOff[node] ?? 0) + len);
      node = this.#parent[node] ?? 0;
      if (node !== 0) { pos -= 1; out[pos] = 0x2f; }
    }
    return out;
  }
}

// A stack of row numbers: four bytes each, grown no further than the rows a table can have.
export class RowStack {
  #items = new Uint32Array(1024);
  #size = 0;
  readonly #max: number;

  constructor(limits: ReaderLimits) { this.#max = limits.maxTreeDirectories + 1; }

  get size(): number { return this.#size; }

  push(row: number): void {
    if (this.#size >= this.#items.length) { const bigger = new Uint32Array(Math.min(this.#items.length * 2, this.#max)); bigger.set(this.#items); this.#items = bigger; }
    this.#items[this.#size] = row;
    this.#size += 1;
  }

  pop(): number { this.#size -= 1; return this.#items[this.#size] ?? 0; }
}
