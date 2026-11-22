// The object store of one candidate repository (W-020a, 7.3 "Objects"): packs first, then loose objects,
// and no other source. Every object returned has been verified against its name; a delta chain is
// resolved iteratively with a visited set and a depth limit, and the bases are held in a bounded cache
// whose evictions are paid for again in the work budget when a base has to be re-inflated.
import { limitError, refuse } from './errors.ts';
import { applyDelta } from './delta.ts';
import { LooseStore, OID, sha1Object, type ObjectType, type RawObject } from './loose.ts';
import { PackSet, type Pack } from './pack.ts';
import type { SafeFs } from './fs-safe.ts';
import type { Budget } from './limits.ts';

export type { ObjectType, RawObject };

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export class ObjectStore {
  readonly #loose: LooseStore;
  readonly #packs: PackSet;
  readonly #budget: Budget;
  readonly #cache = new Map<string, RawObject>();
  #cacheBytes = 0;
  #reserved = 0;

  constructor(fs: SafeFs, objectsDir: Buffer, packDir: Buffer, budget: Budget) {
    this.#loose = new LooseStore(fs, objectsDir, budget);
    this.#packs = new PackSet(fs, packDir, budget);
    this.#budget = budget;
  }

  close(): void { this.#packs.close(); }

  // The caller holds this many bytes of its own (the blobs of a tree being digested): the delta-base cache gives up that much of its budget, so that what the
  // caller holds and what the cache holds never add up past `deltaCacheBytes` (review, Livia 2). Evicts at once; a later read re-inflates and is charged for it.
  reserve(bytes: number): void {
    this.#reserved = bytes;
    this.#evict();
  }

  #evict(): void {
    const cap = Math.max(0, this.#budget.limits.deltaCacheBytes - this.#reserved);
    for (const [k, v] of this.#cache) {
      if (this.#cacheBytes <= cap) break;
      this.#cache.delete(k);
      this.#cacheBytes -= v.body.length;
    }
  }

  has(oid: string): boolean {
    if (!OID.test(oid)) return false;
    return this.#packs.find(oid) !== undefined || this.#loose.has(oid);
  }

  // The verified object, or undefined when neither a pack nor a loose file has it.
  read(oid: string): RawObject | undefined {
    if (!OID.test(oid)) throw refuse('object_corrupt', 'an object id is not 40 lowercase hex digits');
    this.#budget.tick();
    const packed = this.#packs.find(oid);
    let obj: RawObject | undefined;
    if (packed !== undefined) obj = this.#resolve(packed.pack, packed.entry);
    else obj = this.#loose.read(oid);
    // Git holds the empty tree in every repository, stored or not (an entry may name it with no object behind it).
    if (obj === undefined && oid === EMPTY_TREE) return { type: 'tree', body: Buffer.alloc(0) };
    if (obj === undefined) return undefined;
    if (packed !== undefined && sha1Object(obj.type, obj.body) !== oid) throw refuse('object_corrupt', 'the content does not match the object name', `objects/pack/${packed.pack.name}.pack`);
    this.#budget.objects += 1;
    return obj;
  }

  // As read, but the object must exist, and be of the type the caller needs.
  mustRead(oid: string, type?: ObjectType): RawObject {
    const obj = this.read(oid);
    if (obj === undefined) throw refuse('object_missing', 'the repository does not hold an object it names', undefined, Buffer.from(oid, 'hex'));
    if (type !== undefined && obj.type !== type) throw refuse('object_corrupt', `an object is a ${obj.type}, not a ${type}`, undefined, Buffer.from(oid, 'hex'));
    return obj;
  }

  #cacheGet(key: string): RawObject | undefined {
    const hit = this.#cache.get(key);
    if (hit === undefined) return undefined;
    this.#cache.delete(key);
    this.#cache.set(key, hit); // most recently used last
    return hit;
  }

  #cacheSet(key: string, obj: RawObject): void {
    const size = obj.body.length;
    if (size > Math.max(0, this.#budget.limits.deltaCacheBytes - this.#reserved)) return;
    const old = this.#cache.get(key);
    if (old !== undefined) { this.#cacheBytes -= old.body.length; this.#cache.delete(key); }
    this.#cache.set(key, obj);
    this.#cacheBytes += size;
    this.#evict();
  }

  // The chain is walked on headers alone (nothing inflated, the depth checked as it grows), then applied from the base up, each delta inflated when it
  // is applied and dropped after: the memory of a read is one base, one delta and one result, however long the chain.
  #resolve(startPack: Pack, startEntry: number): RawObject {
    const chain: Array<{ key: string; pack: Pack; entry: number }> = [];
    const visited = new Set<string>();
    let pack = startPack;
    let entry = startEntry;
    let base: RawObject;
    for (;;) {
      const key = `${String(pack.id)}:${String(entry)}`;
      if (visited.has(key)) throw refuse('object_corrupt', 'a delta chain loops', `objects/pack/${pack.name}.pack`);
      visited.add(key);
      const cached = this.#cacheGet(key);
      if (cached !== undefined) { this.#budget.charge(cached.body.length); base = cached; break; } // using a cached object costs what reading it costs
      this.#budget.tick();
      const head = pack.readHead(entry);
      if (head.kind === 'base') {
        const e = pack.readEntry(entry);
        if (e.kind !== 'base') throw refuse('object_corrupt', 'an entry changed while it was read', `objects/pack/${pack.name}.pack`);
        base = { type: e.type, body: e.data };
        this.#cacheSet(key, base);
        break;
      }
      const file = `${pack.name}.pack@${String(pack.offsetOf(entry))}`;
      if (chain.length >= this.#budget.limits.maxDeltaDepth) throw limitError('maxDeltaDepth', 'a delta chain is deeper than the limit', file);
      chain.push({ key, pack, entry });
      if (head.kind === 'ofs') {
        const next = pack.entryAtOffset(head.baseOffset);
        if (next === -1) throw refuse('object_corrupt', 'an offset delta points at an offset the index does not list', file);
        entry = next;
      } else {
        const found = this.#packs.find(head.baseOid);
        if (found !== undefined) { pack = found.pack; entry = found.entry; continue; }
        const loose = this.#loose.read(head.baseOid);
        if (loose === undefined) throw refuse('object_missing', 'the base of a reference delta is not in the repository', file, Buffer.from(head.baseOid, 'hex'));
        base = loose;
        break;
      }
    }
    for (let i = chain.length - 1; i >= 0; i -= 1) {
      const link = chain[i];
      if (link === undefined) continue;
      this.#budget.tick();
      const e = link.pack.readEntry(link.entry);
      if (e.kind === 'base') throw refuse('object_corrupt', 'an entry changed while it was read', `objects/pack/${link.pack.name}.pack`);
      // applyDelta reads the delta's header (the base size, the result size) and refuses before it allocates anything.
      base = { type: base.type, body: applyDelta(base.body, e.data, this.#budget, `${link.pack.name}.pack@${String(link.pack.offsetOf(link.entry))}`) };
      this.#cacheSet(link.key, base);
    }
    return base;
  }
}
