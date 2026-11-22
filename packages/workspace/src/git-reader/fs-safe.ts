// The only module of the reader that imports node:fs (W-020a, 7.3 "File access"). Every path is a
// Buffer of raw bytes and is walked component by component from the claim's mount root with `lstat`.
// A candidate's files are opened `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` and checked with `fstat` (a
// regular file, the same device and inode as the `lstat`, no larger than the cap for its kind). A FIFO
// that is opened without O_NONBLOCK blocks until a writer appears (P3); O_NOFOLLOW covers only the last
// component (P2), which is why every directory above it is `lstat`ed here as well.
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, opendirSync, openSync, readlinkSync, readSync, unlinkSync, writeSync } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { ReaderError, limitError, printable, refuse } from './errors.ts';
import type { ReaderHooks } from './limits.ts';

const SEP = Buffer.from('/');
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const HASH_CHUNK = 1024 * 1024;

export const join = (...parts: Array<Buffer | string>): Buffer => {
  const out: Buffer[] = [];
  for (const [i, p] of parts.entries()) { if (i > 0) out.push(SEP); out.push(typeof p === 'string' ? Buffer.from(p) : p); }
  return Buffer.concat(out);
};

type Errno = NodeJS.ErrnoException;
const errno = (e: unknown): string | undefined => (e as Errno | undefined)?.code;

export class RandomFile {
  readonly size: number;
  readonly #fd: number;
  readonly #fs: SafeFs;
  readonly #name: string;
  #closed = false;

  constructor(fs: SafeFs, fd: number, size: number, name: string) {
    this.#fs = fs;
    this.#fd = fd;
    this.size = size;
    this.#name = name;
  }

  // A positioned read of exactly `length` bytes.
  readAt(offset: number, length: number): Buffer {
    if (offset < 0 || length < 0 || offset + length > this.size) throw refuse('object_corrupt', 'a read outside the file', this.#name);
    const buf = Buffer.allocUnsafe(length);
    let filled = 0;
    while (filled < length) {
      let n: number;
      try { n = readSync(this.#fd, buf, filled, length - filled, offset + filled); } catch (e) { throw this.#fs.mapError(e, this.#name); }
      if (n === 0) throw refuse('file_changed', 'the file ended early', this.#name);
      filled += n;
    }
    return buf;
  }

  // SHA-1 of bytes [start, end), streamed in 1 MiB chunks; `tick` runs between chunks.
  sha1(start: number, end: number, tick: () => void): Buffer {
    const h = createHash('sha1');
    const chunk = Buffer.allocUnsafe(HASH_CHUNK);
    let pos = start;
    while (pos < end) {
      tick();
      const want = Math.min(HASH_CHUNK, end - pos);
      let got = 0;
      while (got < want) {
        let n: number;
        try { n = readSync(this.#fd, chunk, got, want - got, pos + got); } catch (e) { throw this.#fs.mapError(e, this.#name); }
        if (n === 0) throw refuse('file_changed', 'the file ended early', this.#name);
        got += n;
      }
      h.update(chunk.subarray(0, want));
      pos += want;
    }
    return h.digest();
  }

  // Closes the file, and refuses if it changed size while it was open.
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const changed = ((): boolean => { try { return fstatSync(this.#fd, { bigint: true }).size !== BigInt(this.size); } catch { return true; } })();
    try { closeSync(this.#fd); } catch { /* nothing to recover */ }
    if (changed) throw refuse('file_changed', 'the file changed size while it was open', this.#name);
  }
}

// The file the export pack is written to: created exclusively, never followed, never inside what is read.
export class OutFile {
  readonly #fd: number;
  readonly #fs: SafeFs;
  readonly #name: string;
  readonly #path: string;
  size = 0;

  constructor(fs: SafeFs, fd: number, name: string, path: string) {
    this.#fs = fs;
    this.#fd = fd;
    this.#name = name;
    this.#path = path;
  }

  append(data: Uint8Array): void {
    let written = 0;
    while (written < data.length) {
      try { written += writeSync(this.#fd, data, written, data.length - written, this.size + written); } catch (e) { throw this.#fs.mapError(e, this.#name); }
    }
    this.size += data.length;
  }

  writeAt(data: Uint8Array, position: number): void {
    let written = 0;
    while (written < data.length) {
      try { written += writeSync(this.#fd, data, written, data.length - written, position + written); } catch (e) { throw this.#fs.mapError(e, this.#name); }
    }
  }

  sha1(start: number, end: number, tick: () => void): Buffer {
    const h = createHash('sha1');
    const chunk = Buffer.allocUnsafe(HASH_CHUNK);
    let pos = start;
    while (pos < end) {
      tick();
      const want = Math.min(HASH_CHUNK, end - pos);
      let got = 0;
      while (got < want) {
        let n: number;
        try { n = readSync(this.#fd, chunk, got, want - got, pos + got); } catch (e) { throw this.#fs.mapError(e, this.#name); }
        if (n === 0) throw refuse('file_changed', 'the output ended early', this.#name);
        got += n;
      }
      h.update(chunk.subarray(0, want));
      pos += want;
    }
    return h.digest();
  }

  // Removes the file this object created (and only that one: it was made with O_EXCL).
  discard(): void { try { unlinkSync(this.#path); } catch { /* the file stays as it is */ } }
  close(): void { try { closeSync(this.#fd); } catch { /* nothing to recover */ } }
}

export class SafeFs {
  readonly #hooks: ReaderHooks;
  // The directory every `file` in an error is shown relative to (the generation directory once the walk has reached it).
  #shownFrom: Buffer = Buffer.alloc(0);

  constructor(hooks: ReaderHooks = {}) { this.#hooks = hooks; }

  showRelativeTo(dir: Buffer): void { this.#shownFrom = dir; }

  show(path: Buffer): string {
    const from = this.#shownFrom;
    if (from.length > 0 && path.length > from.length && path.subarray(0, from.length).equals(from) && path[from.length] === 0x2f) return printable(path.subarray(from.length + 1));
    return printable(path);
  }

  mapError(e: unknown, file: string): ReaderError {
    if (e instanceof ReaderError) return e;
    const code = errno(e);
    if (code === 'ELOOP') return refuse('path_unsafe', 'a symbolic link where none is allowed', file);
    if (code === 'ENOENT' || code === 'ENOTDIR') return refuse('path_unsafe', 'a path component is missing or is not a directory', file);
    if (code === 'EACCES' || code === 'EPERM') return refuse('unreadable', 'permission denied', file);
    if (code === 'EEXIST') return refuse('output_exists', 'the output file already exists', file);
    return refuse('unreadable', `the file system refused (${code ?? 'unknown'})`, file);
  }

  #note(op: string, path: Buffer): void { this.#hooks.onFs?.(op, path); }

  // lstat, undefined when the entry does not exist (or a parent is not a directory).
  lstat(path: Buffer): BigIntStats | undefined {
    this.#note('lstat', path);
    try { return lstatSync(path, { bigint: true }); } catch (e) {
      if (errno(e) === 'ENOENT' || errno(e) === 'ENOTDIR') return undefined;
      throw this.mapError(e, this.show(path));
    }
  }

  // The walk: from `root`, each name in turn must be a real directory (never a symlink). Returns the final path.
  walk(root: Buffer, names: ReadonlyArray<Buffer | string>): Buffer {
    let path = root;
    for (const name of names) {
      path = join(path, name);
      const st = this.lstat(path);
      if (st === undefined) throw refuse('path_unsafe', 'a path component is missing', this.show(path));
      if (st.isSymbolicLink()) throw refuse('path_unsafe', 'a path component is a symbolic link', this.show(path));
      if (!st.isDirectory()) throw refuse('path_unsafe', 'a path component is not a directory', this.show(path));
    }
    return path;
  }

  // Like walk, for one directory under one already walked: undefined when it does not exist.
  child(parent: Buffer, name: Buffer | string): Buffer | undefined {
    const path = join(parent, name);
    const st = this.lstat(path);
    if (st === undefined) return undefined;
    if (st.isSymbolicLink()) throw refuse('path_unsafe', 'a path component is a symbolic link', this.show(path));
    if (!st.isDirectory()) throw refuse('path_unsafe', 'a path component is not a directory', this.show(path));
    return path;
  }

  // Common to the whole-file and the positioned readers: lstat, the kind and size checks, the open, and the fstat that must agree with the lstat.
  #open(path: Buffer, cap: number, capName: string, optional: boolean): { fd: number; size: number } | undefined {
    const name = this.show(path);
    const before = this.lstat(path);
    if (before === undefined) { if (optional) return undefined; throw refuse('path_unsafe', 'the file is missing', name); }
    if (before.isSymbolicLink()) throw refuse('path_unsafe', 'a symbolic link where a file is expected', name);
    if (!before.isFile()) throw refuse('not_regular_file', 'not a regular file', name);
    if (before.size > BigInt(cap)) throw limitError(capName, 'the file is larger than its cap', name);
    this.#hooks.afterLstat?.(path);
    this.#note('open', path);
    let fd: number;
    try { fd = openSync(path, READ_FLAGS); } catch (e) {
      if (errno(e) === 'ENOENT' && optional) return undefined;
      throw this.mapError(e, name);
    }
    try {
      const st = fstatSync(fd, { bigint: true });
      if (!st.isFile()) throw refuse('not_regular_file', 'not a regular file after open', name);
      if (st.dev !== before.dev || st.ino !== before.ino) throw refuse('file_changed', 'the file was replaced between lstat and open', name);
      if (st.size > BigInt(cap)) throw limitError(capName, 'the file is larger than its cap', name);
      return { fd, size: Number(st.size) };
    } catch (e) { try { closeSync(fd); } catch { /* the error below is the one that matters */ } throw e; }
  }

  // A small file, read whole: exactly st.size bytes, and the size must be the same afterwards. `optional`: undefined when it does not exist.
  readSmall(path: Buffer, cap: number, capName: string, optional = false): Buffer | undefined {
    const opened = this.#open(path, cap, capName, optional);
    if (opened === undefined) return undefined;
    const name = this.show(path);
    const { fd, size } = opened;
    try {
      const buf = Buffer.allocUnsafe(size);
      let filled = 0;
      while (filled < size) {
        let n: number;
        try { n = readSync(fd, buf, filled, size - filled, filled); } catch (e) { throw this.mapError(e, name); }
        if (n === 0) throw refuse('file_changed', 'the file ended early', name);
        filled += n;
      }
      if (fstatSync(fd, { bigint: true }).size !== BigInt(size)) throw refuse('file_changed', 'the file changed size while it was read', name);
      return buf;
    } finally { try { closeSync(fd); } catch { /* nothing to recover */ } }
  }

  // A file that is never read whole (a pack, an index): positioned reads and streamed hashing.
  openRandom(path: Buffer, cap: number, capName: string): RandomFile {
    const opened = this.#open(path, cap, capName, false);
    if (opened === undefined) throw refuse('path_unsafe', 'the file is missing', this.show(path));
    return new RandomFile(this, opened.fd, opened.size, this.show(path));
  }

  // Names as bytes; each is later lstat'ed, never followed. At most `max` entries.
  listDir(path: Buffer, max: number, capName: string): Buffer[] {
    this.#note('readdir', path);
    const out: Buffer[] = [];
    let dir;
    try { dir = opendirSync(path, { encoding: 'buffer' as BufferEncoding }); } catch (e) { throw this.mapError(e, this.show(path)); }
    try {
      for (;;) {
        const entry = dir.readSync();
        if (entry === null) break;
        const name = entry.name as unknown as Buffer;
        if (out.length >= max) throw limitError(capName, 'the directory has too many entries', this.show(path));
        out.push(Buffer.from(name));
      }
    } catch (e) { throw this.mapError(e, this.show(path)); } finally { try { dir.closeSync(); } catch { /* nothing to recover */ } }
    for (const extra of this.#hooks.extraDirEntries?.(path) ?? []) out.push(extra);
    return out;
  }

  readlink(path: Buffer): Buffer {
    this.#note('readlink', path);
    try { return Buffer.from(readlinkSync(path, { encoding: 'buffer' })); } catch (e) { throw this.mapError(e, this.show(path)); }
  }

  // The export's output file: it must not exist, it is not followed, and it is created 0644.
  createExclusive(path: string): OutFile {
    this.#note('create', Buffer.from(path));
    let fd: number;
    try { fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644); } catch (e) { throw this.mapError(e, printable(Buffer.from(path))); }
    return new OutFile(this, fd, printable(Buffer.from(path)), path);
  }
}
