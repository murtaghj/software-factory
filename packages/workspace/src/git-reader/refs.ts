// Refs and HEAD (W-020a, 7.3 "Refs and HEAD"). Only `worktrees/main/HEAD` and what it names are read:
// one loose ref or `packed-refs`, up to four more symref hops, and nothing else. `reftable` is refused by
// its existence alone.
import { limitError, refuse } from './errors.ts';
import { join, type SafeFs } from './fs-safe.ts';
import type { Budget } from './limits.ts';
import { OID } from './loose.ts';

const OID64 = /^[0-9a-f]{64}$/;
const SYMREF_HOPS_AFTER_HEAD = 4;

export type ResolvedHead = { commit: string; ref: string | null };

// Ref names are handled as byte strings (latin1 text, one character per byte), so the bytes of a name and its characters are the same thing and
// a path is built from them exactly. A name that has bytes of 0x80 and above must be well-formed UTF-8 (Git allows any bytes; the factory does not).
const utf8 = new TextDecoder('utf-8', { fatal: true });
const isUtf8 = (byteString: string): boolean => { try { utf8.decode(Buffer.from(byteString, 'latin1')); return true; } catch { return false; } };

// Git's check-ref-format rules for a full ref name.
export function checkRefFormat(name: string, file: string): void {
  const bad = (why: string): never => { throw refuse('invalid_ref', `a ref name ${why}`, file); };
  if (!name.startsWith('refs/') || name.length === 'refs/'.length) bad('is not under refs/');
  for (let i = 0; i < name.length; i += 1) {
    const c = name.charCodeAt(i);
    if (c <= 0x20 || c === 0x7f || '~^:?*[\\'.includes(name.charAt(i))) bad('has a forbidden character');
  }
  if (name.includes('..') || name.includes('@{') || name.includes('//')) bad('has a forbidden sequence');
  if (name.endsWith('/') || name.endsWith('.') || name === '@') bad('ends in a forbidden character');
  for (const comp of name.split('/')) {
    if (comp.startsWith('.') || comp.endsWith('.lock')) bad('has a component that starts with a dot or ends in .lock');
  }
  if (name.length > 1024) bad('is too long');
  if (!isUtf8(name)) bad('is not well-formed UTF-8');
}

// The ref a worktree's HEAD may name: under refs/heads/ and well formed.
export function checkHeadsRefName(name: string, file: string): void {
  if (!name.startsWith('refs/heads/') || name.length === 'refs/heads/'.length) throw refuse('invalid_ref', 'a ref name is not under refs/heads/', file);
  checkRefFormat(name, file);
}

type RefValue = { kind: 'oid'; oid: string } | { kind: 'symref'; target: string };

export class Refs {
  readonly #fs: SafeFs;
  readonly #gitDir: Buffer;
  readonly #wtDir: Buffer;
  readonly #budget: Budget;
  #packed: Map<string, string> | undefined;

  constructor(fs: SafeFs, gitDir: Buffer, wtDir: Buffer, budget: Budget) {
    this.#fs = fs;
    this.#gitDir = gitDir;
    this.#wtDir = wtDir;
    this.#budget = budget;
  }

  #parseValue(text: string, file: string): RefValue {
    const body = text.endsWith('\n') ? text.slice(0, -1) : text;
    if (body.startsWith('ref: ')) {
      const target = body.slice(5);
      checkHeadsRefName(target, file);
      return { kind: 'symref', target };
    }
    if (OID.test(body)) return { kind: 'oid', oid: body };
    if (OID64.test(body)) throw refuse('unsupported_hash', 'a 64-digit object id (SHA-256 repository)', file);
    throw refuse('invalid_ref', 'a ref file holds neither `ref: <name>` nor an object id', file);
  }

  #loose(name: string): RefValue | undefined {
    // refs/heads/a/b: `refs`, `heads` and every directory below are lstat'ed; the last component is the file.
    const parts = name.split('/');
    let dir = this.#gitDir;
    for (const part of parts.slice(0, -1)) {
      const next = this.#fs.child(dir, Buffer.from(part, 'latin1'));
      if (next === undefined) return undefined;
      dir = next;
    }
    const path = join(dir, Buffer.from(parts[parts.length - 1] ?? '', 'latin1'));
    const st = this.#fs.lstat(path);
    if (st === undefined) return undefined;
    // A directory where the ref file would be (refs/heads/a exists as a directory because refs/heads/a/b does) is simply no loose ref of that name.
    if (st.isDirectory()) return undefined;
    const raw = this.#fs.readSmall(path, this.#budget.limits.maxRefFileBytes, 'maxRefFileBytes');
    return this.#parseValue((raw ?? Buffer.alloc(0)).toString('latin1'), this.#fs.show(path));
  }

  // packed-refs, read the way Git reads it: the file must end in a newline; a header, if there is one, starts `# pack-refs with:`; every line is
  // `<oid> <name>` or a `^<oid>` peel line after a ref (anything else is refused); a name that fails the ref-name rules is skipped, as Git marks
  // it broken, and is never the ref HEAD names; and the names must be in ascending order only when the header says `sorted`.
  #packedRefs(): Map<string, string> {
    if (this.#packed !== undefined) return this.#packed;
    const limits = this.#budget.limits;
    const path = join(this.#gitDir, 'packed-refs');
    const raw = this.#fs.readSmall(path, limits.maxPackedRefsBytes, 'maxPackedRefsBytes', true);
    const map = new Map<string, string>();
    this.#packed = map;
    if (raw === undefined) return map;
    const file = this.#fs.show(path);
    const text = raw.toString('latin1');
    if (text.length === 0) return map;
    if (!text.endsWith('\n')) throw refuse('invalid_ref', 'packed-refs ends in an unterminated line', file);
    const lines = text.slice(0, -1).split('\n');
    if (lines.length > limits.maxPackedRefsLines) throw limitError('maxPackedRefsLines', 'packed-refs has too many lines', file);
    let sorted = false;
    let previous = false;
    let last: string | undefined;
    for (const [i, line] of lines.entries()) {
      if (i % 4096 === 4095) this.#budget.tick();
      if (i === 0 && line.startsWith('#')) {
        if (!/^# pack-refs with:[ -~]*$/.test(line)) throw refuse('invalid_ref', 'packed-refs has an unrecognised header', file);
        sorted = line.slice('# pack-refs with:'.length).split(' ').includes('sorted');
        continue;
      }
      if (line.startsWith('^')) {
        if (!previous) throw refuse('invalid_ref', 'a peel line with no ref before it', file);
        const peeled = line.slice(1);
        if (!OID.test(peeled)) { if (OID64.test(peeled)) throw refuse('unsupported_hash', 'a 64-digit object id', file); throw refuse('invalid_ref', 'a malformed peel line', file); }
        previous = false;
        continue;
      }
      const sp = line.indexOf(' ');
      const oid = sp === -1 ? '' : line.slice(0, sp);
      const name = sp === -1 ? '' : line.slice(sp + 1);
      if (!OID.test(oid)) { if (OID64.test(oid)) throw refuse('unsupported_hash', 'a 64-digit object id', file); throw refuse('invalid_ref', 'a malformed packed-refs line', file); }
      previous = true;
      if (sorted) {
        if (last !== undefined && Buffer.compare(Buffer.from(last, 'latin1'), Buffer.from(name, 'latin1')) >= 0) throw refuse('invalid_ref', 'packed-refs says it is sorted and is not', file);
        last = name;
      }
      try { checkRefFormat(name, file); } catch { continue; } // a broken name: skipped
      map.set(name, oid);
    }
    return map;
  }

  resolveHead(): ResolvedHead {
    if (this.#fs.lstat(join(this.#gitDir, 'reftable')) !== undefined) throw refuse('unsupported_ref_storage', 'reftable repositories are not read', 'reftable');
    const headPath = join(this.#wtDir, 'HEAD');
    const head = this.#fs.readSmall(headPath, this.#budget.limits.maxRefFileBytes, 'maxRefFileBytes');
    const headFile = this.#fs.show(headPath);
    let value = this.#parseValue((head ?? Buffer.alloc(0)).toString('latin1'), headFile);
    if (value.kind === 'oid') return { commit: value.oid, ref: null };
    let hops = 0;
    const first = value.target;
    for (;;) {
      this.#budget.tick();
      if (value.kind === 'oid') return { commit: value.oid, ref: Buffer.from(first, 'latin1').toString('utf8') };
      if (hops >= SYMREF_HOPS_AFTER_HEAD) throw refuse('invalid_ref', 'a symbolic ref chain is longer than five', headFile);
      hops += 1;
      const loose = this.#loose(value.target);
      if (loose !== undefined) { value = loose; continue; }
      const packed = this.#packedRefs().get(value.target);
      if (packed === undefined) throw refuse('invalid_ref', 'HEAD names a ref that does not exist', headFile);
      value = { kind: 'oid', oid: packed };
    }
  }
}

