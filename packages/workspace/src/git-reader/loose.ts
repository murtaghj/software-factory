// Loose objects (W-020a, 7.3): `objects/xx/<38 hex>`, zlib of `<type> <size>\0<body>`.
import { createHash } from 'node:crypto';
import { limitError, refuse } from './errors.ts';
import { deflateBound, inflateBounded, requireConsumed } from './inflate.ts';
import { join, type SafeFs } from './fs-safe.ts';
import type { Budget } from './limits.ts';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';
export type RawObject = { type: ObjectType; body: Buffer };

export const OID = /^[0-9a-f]{40}$/;

export const sha1Object = (type: ObjectType, body: Buffer): string =>
  createHash('sha1').update(`${type} ${String(body.length)}\0`).update(body).digest('hex');

const HEADER = /^(commit|tree|blob|tag) (0|[1-9][0-9]*)$/;

export class LooseStore {
  readonly #fs: SafeFs;
  readonly #objects: Buffer;
  readonly #budget: Budget;
  // Fan-out directories already shown to be real directories ('xx' -> path, or null when absent).
  readonly #dirs = new Map<string, Buffer | null>();

  constructor(fs: SafeFs, objectsDir: Buffer, budget: Budget) {
    this.#fs = fs;
    this.#objects = objectsDir;
    this.#budget = budget;
  }

  #fanout(xx: string): Buffer | null {
    const known = this.#dirs.get(xx);
    if (known !== undefined) return known;
    const dir = this.#fs.child(this.#objects, xx) ?? null;
    this.#dirs.set(xx, dir);
    return dir;
  }

  #path(oid: string): Buffer | undefined {
    const dir = this.#fanout(oid.slice(0, 2));
    return dir === null ? undefined : join(dir, oid.slice(2));
  }

  // Existence only, by lstat (an intent-to-add or index blob that is never read).
  has(oid: string): boolean {
    const p = this.#path(oid);
    return p !== undefined && this.#fs.lstat(p) !== undefined;
  }

  read(oid: string): RawObject | undefined {
    const path = this.#path(oid);
    if (path === undefined) return undefined;
    const limits = this.#budget.limits;
    const raw = this.#fs.readSmall(path, deflateBound(limits.maxObjectBytes + 64), 'maxObjectBytes', true);
    if (raw === undefined) return undefined;
    const file = this.#fs.show(path);
    const r = inflateBounded(raw, { maxOutput: limits.maxObjectBytes + 64, file, onTooLarge: 'limit', limitName: 'maxObjectBytes' });
    requireConsumed(r, raw.length, file, this.#budget.hooks);
    this.#budget.charge(r.out.length);
    const nul = r.out.subarray(0, 40).indexOf(0);
    if (nul === -1) throw refuse('object_corrupt', 'a loose object has no header', file);
    const m = HEADER.exec(r.out.subarray(0, nul).toString('latin1'));
    if (m === null) throw refuse('object_corrupt', 'a loose object header is not `<type> <size>`', file);
    const body = r.out.subarray(nul + 1);
    if (Number(m[2]) > limits.maxObjectBytes) throw limitError('maxObjectBytes', 'the object is larger than the object limit', file);
    if (Number(m[2]) !== body.length) throw refuse('object_corrupt', 'the header size differs from the body', file);
    const type = m[1] as ObjectType;
    if (createHash('sha1').update(r.out).digest('hex') !== oid) throw refuse('object_corrupt', 'the content does not match the object name', file);
    return { type, body };
  }
}
