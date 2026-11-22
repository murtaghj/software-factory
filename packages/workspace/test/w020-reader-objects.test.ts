import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openCandidate, ReaderError } from '../src/git-reader/index.ts';
import { parseTree } from '../src/git-reader/tree.ts';
import { buildIndex, buildPack, installPack, looseBytes, makeDelta, makeKit, sha1, sha1Object, writeLoose, type Kit, type PackItem } from './git-reader-kit.ts';
import { expectCode, refusal, refusalAsync } from './git-reader-helpers.ts';

// Every packed and loose object the reader returns equals `git cat-file`, and every hostile object has its own refusal (7.3, 7.8).
let kit: Kit;
beforeAll(() => { kit = makeKit(); });
afterAll(() => { kit.cleanup(); });

// A repository whose history makes Git write deltas: one large file changed a line at a time.
function deltaHeavy(commits: number): { first: Record<string, string>; more: Array<Record<string, string>> } {
  // Version k has its first k lines edited, so each version differs least from its neighbours and Git builds long chains.
  const text = (k: number): string => Array.from({ length: 400 }, (_, i) => (i < k ? `line ${String(i)} edited in version ${String(i)}` : `line ${String(i)} same text that repeats`)).join('\n') + '\n';
  return { first: { 'big.txt': text(0), 'small.txt': 'small\n' }, more: Array.from({ length: commits }, (_, i) => ({ 'big.txt': text(i + 1) })) };
}

// What `git verify-pack -v` says about the packs of a repository: the deepest chain, and how many entries are deltas.
function packStats(gitDir: string): { depth: number; deltas: number } {
  const packDir = join(gitDir, 'objects', 'pack');
  let depth = 0;
  let deltas = 0;
  for (const f of readdirSync(packDir).filter((n) => n.endsWith('.idx'))) {
    for (const line of kit.git(gitDir, ['verify-pack', '-v', join(packDir, f)]).split('\n')) {
      const cols = line.split(/\s+/);
      if (cols.length === 7 && /^[0-9a-f]{40}$/.test(cols[0] ?? '')) { deltas += 1; depth = Math.max(depth, Number(cols[5])); }
    }
  }
  return { depth, deltas };
}

function expectEveryObjectEquals(c: ReturnType<Kit['makeCandidate']>): number {
  const oracle = kit.oracleObjects(c.common);
  const { store } = kit.openStore(c);
  for (const [oid, want] of oracle) {
    const got = store.mustRead(oid);
    expect(got.type).toBe(want.type);
    expect(got.body.equals(want.body)).toBe(true);
  }
  store.close();
  return oracle.size;
}

describe('objects as Git reads them', () => {
  it('loose objects, and packs after gc, repack --depth=50 and --depth=400 (offset and reference deltas), equal git cat-file', () => {
    // Loose: commits made in the working tree after the clone are loose files, beside the clone's pack.
    const small = deltaHeavy(8);
    const l = kit.makeCandidate(small.first, { more: small.more });
    for (let i = 0; i < 3; i += 1) { kit.writeFiles(l.work, { [`new-${String(i)}.txt`]: `new file ${String(i)}\n`, 'dir/deep/x.txt': `x ${String(i)}\n` }); l.inWork(['add', '-A']); l.inWork(['commit', '--quiet', '-m', `loose ${String(i)}`]); }
    expect(readdirSync(join(l.gitDir, 'objects')).filter((n) => /^[0-9a-f]{2}$/.test(n)).length).toBeGreaterThan(10); // the fixture really has loose objects
    expect(readdirSync(join(l.gitDir, 'objects', 'pack')).length).toBeGreaterThan(0);
    expect(expectEveryObjectEquals(l)).toBeGreaterThan(20);

    const { first, more } = deltaHeavy(60);
    const c = kit.makeCandidate(first, { more });

    c.inCommon(['gc', '--quiet']);
    expect(packStats(c.gitDir).deltas).toBeGreaterThan(20); // the control: deltas were written and are read
    expectEveryObjectEquals(c);

    c.inCommon(['repack', '-a', '-d', '-f', '--quiet', '--depth=50', '--window=100']);
    const d50 = packStats(c.gitDir);
    expect(d50.depth).toBeGreaterThan(5);
    expect(d50.depth).toBeLessThanOrEqual(50);
    expectEveryObjectEquals(c);

    // Reference deltas: the same history, with offsets switched off.
    c.inCommon(['-c', 'pack.useDeltaBaseOffset=false', 'repack', '-a', '-d', '-f', '--quiet', '--depth=400', '--window=500']);
    const d400 = packStats(c.gitDir);
    expect(d400.depth).toBeGreaterThan(d50.depth - 1);
    expect(d400.depth).toBeLessThanOrEqual(400);
    expectEveryObjectEquals(c);
  });

  it('a deep real chain (more than 50 deltas) is read', () => {
    const { first, more } = deltaHeavy(180);
    const c = kit.makeCandidate(first, { more });
    c.inCommon(['repack', '-a', '-d', '-f', '--quiet', '--depth=400', '--window=500']);
    expect(packStats(c.gitDir).depth).toBeGreaterThan(50);
    expectEveryObjectEquals(c);
  });
});

describe('loose objects: each refusal, and the control', () => {
  const body = Buffer.from('a blob body that is long enough to compress a little, a little, a little\n');
  const oid = sha1Object('blob', body);
  const plant = (bytes: Buffer, name = oid): ReturnType<Kit['makeBareLayout']> => {
    const l = kit.makeBareLayout();
    writeLoose(l.objects, name, bytes);
    return l;
  };
  const read = (l: ReturnType<Kit['makeBareLayout']>, name = oid, limits = {}): unknown => { const { store } = kit.openStore(l, limits); try { return store.read(name); } finally { store.close(); } };

  it('control: the unmodified object reads', () => {
    const l = plant(looseBytes('blob', body));
    expect(read(l)).toMatchObject({ type: 'blob', body });
  });

  it('a body byte changed and recompressed is a SHA-1 mismatch', () => {
    const changed = Buffer.from(body);
    changed[3] = (changed[3] ?? 0) ^ 1;
    expectCode(refusal(() => read(plant(looseBytes('blob', changed)))), 'object_corrupt', 'does not match the object name');
  });

  it('12 bytes after the zlib stream are trailing data (Z1), and the same file without them reads', () => {
    const good = looseBytes('blob', body);
    expectCode(refusal(() => read(plant(Buffer.concat([good, Buffer.alloc(12, 0x61)])))), 'trailing_data');
    expect(read(plant(good))).toMatchObject({ type: 'blob' });
  });

  it('a stream cut short is truncated (Z3)', () => {
    const good = looseBytes('blob', body);
    expectCode(refusal(() => read(plant(good.subarray(0, good.length - 3)))), 'truncated');
  });

  it('garbage is a zlib error, and a preset dictionary is refused (Z3)', () => {
    expectCode(refusal(() => read(plant(Buffer.from('not zlib at all')))), 'zlib_error');
    const withDict = deflateSync(Buffer.concat([Buffer.from(`blob ${String(body.length)}\0`), body]), { dictionary: Buffer.from('a shared dictionary') });
    expectCode(refusal(() => read(plant(withDict))), 'preset_dictionary');
  });

  it('a header size one too large is refused', () => {
    expectCode(refusal(() => read(plant(looseBytes('blob', body, `blob ${String(body.length + 1)}\0`)))), 'object_corrupt', 'header size differs');
    expectCode(refusal(() => read(plant(looseBytes('blob', body, `blob ${String(body.length - 1)}\0`)))), 'object_corrupt', 'header size differs');
  });

  it('a malformed header is refused: unknown type, leading zero, no NUL', () => {
    expectCode(refusal(() => read(plant(looseBytes('blob', body, `thing ${String(body.length)}\0`)))), 'object_corrupt', 'header');
    expectCode(refusal(() => read(plant(looseBytes('blob', body, `blob 0${String(body.length)}\0`)))), 'object_corrupt', 'header');
    expectCode(refusal(() => read(plant(deflateSync(Buffer.from('blob 5 and no nul byte anywhere in the first forty bytes of it')) ))), 'object_corrupt', 'no header');
  });

  it('a 1 KiB file that inflates past the cap is refused by the inflate itself, having inflated nothing (Z2); the same object under a cap that allows it reads (control)', () => {
    const zeros = Buffer.alloc(1048576);
    const name = sha1Object('blob', zeros);
    const bomb = looseBytes('blob', zeros);
    expect(bomb.length).toBeLessThan(2048);
    const l = plant(bomb, name);
    const capped = kit.openStore(l, { maxObjectBytes: 4096 });
    const e = refusal(() => capped.store.read(name));
    expectCode(e, 'limit_exceeded', 'inflates past its cap'); // from `maxOutputLength`, not from the header check after the fact
    expect(e.limit).toBe('maxObjectBytes');
    expect(capped.budget.work).toBe(0); // nothing was inflated, so nothing was charged
    capped.store.close();
    const roomy = kit.openStore(l);
    expect(roomy.store.read(name)).toMatchObject({ type: 'blob' }); // control: the very same bytes read under the default cap
    expect(roomy.budget.work).toBe(1048576 + 'blob 1048576\0'.length); // and are charged for what was inflated
    roomy.store.close();
  });

  it('maxObjectBytes binds at its value: an object of exactly that size reads, one byte more is refused', () => {
    const exact = Buffer.alloc(4096, 0x61);
    const over = Buffer.alloc(4097, 0x61);
    expect(read(plant(looseBytes('blob', exact), sha1Object('blob', exact)), sha1Object('blob', exact), { maxObjectBytes: 4096 })).toMatchObject({ type: 'blob' });
    expectCode(refusal(() => read(plant(looseBytes('blob', over), sha1Object('blob', over)), sha1Object('blob', over), { maxObjectBytes: 4096 })), 'limit_exceeded');
  });

  it('an incompressible object of exactly maxObjectBytes reads even though its zlib stream is a little longer than the object', () => {
    const noise = randomBytes(4096);
    const name = sha1Object('blob', noise);
    const bytes = looseBytes('blob', noise);
    expect(bytes.length).toBeGreaterThan(4096);
    expect(read(plant(bytes, name), name, { maxObjectBytes: 4096 })).toMatchObject({ type: 'blob' });
  });

  it('a symlink where a fan-out directory should be is refused, and the real directory reads (control)', () => {
    const l = kit.makeBareLayout();
    const outside = kit.dir('outside');
    writeLoose(outside, oid, looseBytes('blob', body)); // outside/<xx>/<rest>
    symlinkSync(join(outside, oid.slice(0, 2)), join(l.objects, oid.slice(0, 2)));
    expectCode(refusal(() => read(l)), 'path_unsafe');
    expect(read(plant(looseBytes('blob', body)))).toMatchObject({ type: 'blob' });
  });
});

describe('packs: each refusal, and the controls', () => {
  const blob = (text: string): PackItem => ({ kind: 'base', type: 'blob', body: Buffer.from(text) });
  const withPack = (items: PackItem[], o: Parameters<typeof buildPack>[1] = {}, limits = {}): { read: (oid: string) => unknown; built: ReturnType<typeof buildPack>; layout: ReturnType<Kit['makeBareLayout']> } => {
    const layout = kit.makeBareLayout();
    const built = buildPack(items, o);
    installPack(layout.packDir, built);
    return { built, layout, read: (oid) => { const { store } = kit.openStore(layout, limits); try { return store.read(oid); } finally { store.close(); } } };
  };
  const appendOne = (base: Buffer, extra: string): { delta: Buffer; result: Buffer } => ({
    delta: makeDelta(base.length, base.length + extra.length, [{ copy: { offset: 0, size: base.length } }, { insert: Buffer.from(extra) }]),
    result: Buffer.concat([base, Buffer.from(extra)]),
  });

  it('control: whole objects, an offset delta and a reference delta all read and equal what was written', () => {
    const base = Buffer.from('the base object, with some text in it for the deltas to copy\n');
    const a = appendOne(base, 'one');
    const b = appendOne(base, 'two');
    const p = withPack([
      { kind: 'base', type: 'blob', body: base },
      { kind: 'ofs', base: 0, body: a.delta, name: sha1Object('blob', a.result) },
      { kind: 'ref', baseOid: sha1Object('blob', base), body: b.delta, name: sha1Object('blob', b.result) },
    ]);
    expect(p.read(sha1Object('blob', base))).toMatchObject({ type: 'blob', body: base });
    expect(p.read(sha1Object('blob', a.result))).toMatchObject({ type: 'blob', body: a.result });
    expect(p.read(sha1Object('blob', b.result))).toMatchObject({ type: 'blob', body: b.result });
    expect(p.read(sha1('absent'))).toBeUndefined();
  });

  it('offsets through the 64-bit table read, and a reference delta whose base is a loose object reads (a thin pack)', () => {
    const base = Buffer.from('a base that lives only as a loose object, copied from by the delta\n');
    const result = Buffer.concat([base, Buffer.from('plus')]);
    const baseOid = sha1Object('blob', base);
    const layout = kit.makeBareLayout();
    writeLoose(layout.objects, baseOid, looseBytes('blob', base));
    installPack(layout.packDir, buildPack([
      { kind: 'base', type: 'blob', body: Buffer.from('another whole object\n') },
      { kind: 'ref', baseOid, body: makeDelta(base.length, result.length, [{ copy: { offset: 0, size: base.length } }, { insert: Buffer.from('plus') }]), name: sha1Object('blob', result) },
    ], { forceLargeOffsets: true }));
    const { store } = kit.openStore(layout);
    expect(store.read(sha1Object('blob', result))).toMatchObject({ type: 'blob', body: result });
    expect(store.read(sha1Object('blob', Buffer.from('another whole object\n')))).toMatchObject({ type: 'blob' });
    store.close();
  });

  it('a packed empty blob and empty tree read (Z4: size 0 is inflated with a cap of 1)', () => {
    const p = withPack([{ kind: 'base', type: 'blob', body: Buffer.alloc(0) }, { kind: 'base', type: 'tree', body: Buffer.alloc(0) }]);
    expect(p.read('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391')).toMatchObject({ type: 'blob', body: Buffer.alloc(0) });
    expect(p.read('4b825dc642cb6eb9a060e54bf8d69288fbee4904')).toMatchObject({ type: 'tree', body: Buffer.alloc(0) });
  });

  it('12 bytes after a pack entry stream are trailing data (Z1); the same pack without them reads', () => {
    const items = (trailing?: Buffer): PackItem[] => [{ kind: 'base', type: 'blob', body: Buffer.from('entry with trailing bytes'), ...(trailing === undefined ? {} : { trailing }) }];
    const name = sha1Object('blob', Buffer.from('entry with trailing bytes'));
    expectCode(refusal(() => withPack(items(Buffer.alloc(12, 0x7a))).read(name)), 'trailing_data');
    expect(withPack(items()).read(name)).toMatchObject({ type: 'blob' });
  });

  it('a stream cut short, a preset dictionary, and an entry whose header size is wrong', () => {
    const body = Buffer.from('some bytes that make a stream worth cutting short, short, short\n');
    const whole = deflateSync(body);
    expectCode(refusal(() => withPack([{ kind: 'base', type: 'blob', body, compressed: whole.subarray(0, whole.length - 3) }]).read(sha1Object('blob', body))), 'truncated');
    expectCode(refusal(() => withPack([{ kind: 'base', type: 'blob', body, dictionary: Buffer.from('dict') }]).read(sha1Object('blob', body))), 'preset_dictionary');
    // declared one too large: the stream inflates to fewer bytes
    expectCode(refusal(() => withPack([{ kind: 'base', type: 'blob', body, declaredSize: body.length + 1 }]).read(sha1Object('blob', body))), 'object_corrupt', 'fewer bytes');
    // declared one too small: the stream inflates past the size its header gives
    expectCode(refusal(() => withPack([{ kind: 'base', type: 'blob', body, declaredSize: body.length - 1 }]).read(sha1Object('blob', body))), 'object_corrupt', 'past the size');
  });

  it('a body changed and recompressed in a pack is a SHA-1 mismatch', () => {
    const body = Buffer.from('original content of the packed blob\n');
    const changed = Buffer.from('changed  content of the packed blob\n');
    expectCode(refusal(() => withPack([{ kind: 'base', type: 'blob', body: changed, name: sha1Object('blob', body) }]).read(sha1Object('blob', body))), 'object_corrupt', 'does not match the object name');
  });

  it('a wrong idx trailer, a wrong pack trailer, an idx recording another pack checksum, and a wrong CRC-32', () => {
    const body = Buffer.from('four ways to be wrong\n');
    const name = sha1Object('blob', body);
    expectCode(refusal(() => withPack([blob('four ways to be wrong\n')], { badIdxTrailer: true }).read(name)), 'object_corrupt', 'index trailer');
    expectCode(refusal(() => withPack([blob('four ways to be wrong\n')], { badPackTrailer: true }).read(name)), 'object_corrupt', 'pack trailer');
    expectCode(refusal(() => withPack([blob('four ways to be wrong\n')], { idxPackChecksumWrong: true }).read(name)), 'object_corrupt', 'differs from the checksum');
    expectCode(refusal(() => withPack([{ kind: 'base', type: 'blob', body, crc: 12345 }]).read(name)), 'object_corrupt', 'CRC-32');
    expect(withPack([blob('four ways to be wrong\n')]).read(name)).toMatchObject({ type: 'blob' });
  });

  it('an idx of version 1, an entry of type 5, a version 4 pack, and a count that disagrees', () => {
    const body = Buffer.from('structure\n');
    const name = sha1Object('blob', body);
    expectCode(refusal(() => withPack([blob('structure\n')], { idxVersion1: true }).read(name)), 'unsupported_pack', 'version 1');
    expectCode(refusal(() => withPack([{ kind: 'base', type: 'blob', body, typeCode: 5 }]).read(name)), 'object_corrupt', 'type 5');
    expectCode(refusal(() => withPack([blob('structure\n')], { version: 4 }).read(name)), 'unsupported_pack', 'versions 2 and 3');
    expectCode(refusal(() => withPack([blob('structure\n')], { countInPack: 2 }).read(name)), 'object_corrupt', 'object count');
    expect(withPack([blob('structure\n')], { version: 3 }).read(name)).toMatchObject({ type: 'blob' }); // control: version 3 is read
  });

  it('an offset delta that points forward (at itself) and one that points outside the pack', () => {
    const base = Buffer.from('base for the bad offset deltas\n');
    const a = appendOne(base, 'x');
    const mk = (relative: number): PackItem[] => [{ kind: 'base', type: 'blob', body: base }, { kind: 'ofs', relative, body: a.delta, name: sha1Object('blob', a.result) }];
    const tip = sha1Object('blob', a.result);
    expectCode(refusal(() => withPack(mk(0)).read(tip)), 'object_corrupt', 'earlier entry');
    expectCode(refusal(() => withPack(mk(100000)).read(tip)), 'object_corrupt', 'earlier entry');
    // the offset is inside the pack but not at the start of any entry the index lists
    const built = buildPack(mk(1));
    expect(built.offsets[1]).toBeGreaterThan(13);
    expectCode(refusal(() => withPack(mk(1)).read(tip)), 'object_corrupt', 'does not list');
    expect(withPack([mk(0)[0] as PackItem, { kind: 'ofs', base: 0, body: a.delta, name: tip }]).read(tip)).toMatchObject({ body: a.result }); // control
  });

  it('a reference-delta cycle is refused, and a reference delta whose base is missing is object_missing', () => {
    const delta = makeDelta(4, 4, [{ copy: { offset: 0, size: 4 } }]);
    const nameA = sha1('A');
    const nameB = sha1('B');
    expectCode(refusal(() => withPack([{ kind: 'ref', baseOid: nameB, body: delta, name: nameA }, { kind: 'ref', baseOid: nameA, body: delta, name: nameB }]).read(nameA)), 'object_corrupt', 'loops');
    expectCode(refusal(() => withPack([{ kind: 'ref', baseOid: sha1('nowhere'), body: delta, name: nameA }]).read(nameA)), 'object_missing');
  });

  it('delta bodies: a copy outside the base, opcode 0, a wrong base size, a wrong result size, a short insert', () => {
    const base = Buffer.from('0123456789');
    const bad = (delta: Buffer): unknown => {
      const p = withPack([{ kind: 'base', type: 'blob', body: base }, { kind: 'ofs', base: 0, body: delta, name: sha1('tip') }]);
      return p.read(sha1('tip'));
    };
    expectCode(refusal(() => bad(makeDelta(10, 4, [{ copy: { offset: 8, size: 4 } }]))), 'object_corrupt', 'outside its base');
    expectCode(refusal(() => bad(makeDelta(10, 1, [{ raw: [0] }]))), 'object_corrupt', 'opcode 0');
    expectCode(refusal(() => bad(makeDelta(11, 4, [{ copy: { offset: 0, size: 4 } }]))), 'object_corrupt', 'another size');
    expectCode(refusal(() => bad(makeDelta(10, 5, [{ copy: { offset: 0, size: 4 } }]))), 'object_corrupt', 'fewer bytes');
    expectCode(refusal(() => bad(makeDelta(10, 3, [{ copy: { offset: 0, size: 4 } }]))), 'object_corrupt', 'past its result size');
    expectCode(refusal(() => bad(makeDelta(10, 5, [{ raw: [5, 0x61, 0x62] }]))), 'object_corrupt', 'insert ends early');
    // control: a copy that ends exactly at the end of the base, and a size-0 copy (0x10000) are not what is refused here
    const ok = withPack([{ kind: 'base', type: 'blob', body: base }, { kind: 'ofs', base: 0, body: makeDelta(10, 4, [{ copy: { offset: 6, size: 4 } }]), name: sha1Object('blob', Buffer.from('6789')) }]);
    expect(ok.read(sha1Object('blob', Buffer.from('6789')))).toMatchObject({ body: Buffer.from('6789') });
  });

  it('a delta whose result is larger than the object limit is refused before it is built', () => {
    const base = Buffer.alloc(100, 0x61);
    const delta = makeDelta(100, 5000, [{ copy: { offset: 0, size: 100 } }]);
    const p = withPack([{ kind: 'base', type: 'blob', body: base }, { kind: 'ofs', base: 0, body: delta, name: sha1('tip') }], {}, { maxObjectBytes: 4096 });
    const e = refusal(() => p.read(sha1('tip')));
    expectCode(e, 'limit_exceeded');
    expect(e.limit).toBe('maxObjectBytes');
  });

  // A chain of `depth` deltas, each copying the object so far and adding one byte.
  function chain(depth: number): { items: PackItem[]; tip: string; tipBody: Buffer } {
    let body: Buffer = Buffer.from('chain base\n');
    const items: PackItem[] = [{ kind: 'base', type: 'blob', body }];
    for (let k = 1; k <= depth; k += 1) {
      const next: Buffer = Buffer.concat([body, Buffer.from('x')]);
      items.push({ kind: 'ofs', base: k - 1, body: makeDelta(body.length, next.length, [{ copy: { offset: 0, size: body.length } }, { insert: Buffer.from('x') }]), name: sha1Object('blob', next) });
      body = next;
    }
    return { items, tip: sha1Object('blob', body), tipBody: body };
  }

  it('depth 512 reads; depth 513 is refused as maxDeltaDepth', () => {
    const ok = chain(512);
    expect(withPack(ok.items).read(ok.tip)).toMatchObject({ body: ok.tipBody });
    const tooDeep = chain(513);
    const e = refusal(() => withPack(tooDeep.items).read(tooDeep.tip));
    expectCode(e, 'limit_exceeded');
    expect(e.limit).toBe('maxDeltaDepth');
  });

  it('the base cache is bounded: a chain read with a tiny cache gives the same bytes, a re-read costs the same either way (a hit is charged), and eviction is paid for in re-inflation', () => {
    const c = chain(40);
    const big = withPack(c.items);
    const layout = big.layout;
    const roomy = kit.openStore(layout, {}, {});
    const tiny = kit.openStore(layout, { deltaCacheBytes: 1 }, {});
    expect(roomy.store.mustRead(c.tip).body.equals(c.tipBody)).toBe(true);
    expect(tiny.store.mustRead(c.tip).body.equals(c.tipBody)).toBe(true);
    expect(tiny.budget.work).toBe(roomy.budget.work); // one chain, read once: same bytes either way
    // a second object that shares the chain: the roomy cache holds its bases, the tiny one has to inflate them again, and a hit is charged what it is worth
    const mid = c.items[39]?.name ?? '';
    const midSize = 11 + 39; // the base is 11 bytes and each link adds one
    const roomyBefore = roomy.budget.work;
    roomy.store.mustRead(mid);
    expect(roomy.budget.work - roomyBefore).toBe(midSize); // a cache hit costs the size of what it returns, no more
    const tinyBefore = tiny.budget.work;
    tiny.store.mustRead(mid);
    expect(tiny.budget.work - tinyBefore).toBeGreaterThan(10 * midSize); // evicted: the chain below it is inflated and applied again
    for (const s of [roomy, tiny]) s.store.close();
  });

  it('a zero-padded tree mode is refused as object_corrupt, reason zero_padded_mode (G3), and the same tree written plainly parses', () => {
    const entry = (mode: string, name: string): Buffer => Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.alloc(20, 0xab)]);
    const zero = refusal(() => parseTree(entry('040000', 'dir'), 'tree'));
    expectCode(zero, 'object_corrupt', 'zero_padded_mode');
    expectCode(refusal(() => parseTree(entry('0100644', 'file'), 'tree')), 'object_corrupt', 'zero_padded_mode');
    expect(parseTree(entry('40000', 'dir'), 'tree')).toMatchObject([{ kind: 'dir', mode: '40000' }]);
    expect(parseTree(Buffer.concat([entry('100664', 'a'), entry('100775', 'b'), entry('120000', 'c')]), 'tree').map((e) => e.mode)).toEqual(['100644', '100755', '120000']); // G1: canonical modes
  });
});

describe('the packs directory', () => {
  it('an index without its pack, and a pack without its index (ignored, as Git does)', () => {
    const body = Buffer.from('lonely\n');
    const built = buildPack([{ kind: 'base', type: 'blob', body }]);
    const l = kit.makeBareLayout();
    kit.git(l.packDir, ['--version']); // the directory exists and is empty
    writeFileSync(join(l.packDir, `${built.name}.idx`), built.idx);
    const { store } = kit.openStore(l);
    expectCode(refusal(() => store.read(sha1Object('blob', body))), 'unsupported_pack', 'without its pack');
    const l2 = kit.makeBareLayout();
    writeFileSync(join(l2.packDir, `${built.name}.pack`), built.pack);
    const s2 = kit.openStore(l2);
    expect(s2.store.read(sha1Object('blob', body))).toBeUndefined();
    // other names in the directory are never opened
    writeFileSync(join(l2.packDir, `${built.name}.keep`), '');
    writeFileSync(join(l2.packDir, 'tmp_pack_x'), 'junk');
    expect(kit.openStore(l2).store.read(sha1Object('blob', body))).toBeUndefined();
  });
});

describe('exportPack: one pack with no deltas that Git verifies', () => {
  it('holds HEAD\'s closure, the index\'s blobs and the working tree\'s blobs, each once; Git index-pack --strict accepts it and reads every object as the reader did', async () => {
    const c = kit.makeCandidate({ 'a.txt': 'a\n', 'dir/b.txt': 'b\n' }, { more: [{ 'a.txt': 'a second version\n' }] });
    kit.writeFiles(c.work, { 'staged.txt': 'staged\n' });
    c.inWork(['add', 'staged.txt']);
    kit.writeFiles(c.work, { 'dirty.txt': 'only in the working tree\n', 'a.txt': 'a dirty edit\n' });
    const out = join(kit.dir('export-ok'), 'objects.pack');
    const r = openCandidate(c.mountRoot, c.target);
    try {
      const summary = await r.exportPack(out);
      const bytes = readFileSync(out);
      expect(bytes.subarray(0, 4).toString('latin1')).toBe('PACK');
      expect(bytes.readUInt32BE(4)).toBe(2);
      expect(bytes.readUInt32BE(8)).toBe(summary.objects);
      expect(summary.bytes).toBe(bytes.length);
      expect(summary.commits).toBe(2);
      // Git, as the oracle: the pack verifies strictly, and has no delta in it
      const scratch = kit.dir('export-verify');
      kit.git(scratch, ['init', '--quiet', '--bare', '.']);
      kit.git(scratch, ['index-pack', '--strict', '--stdin'], bytes);
      const listing = kit.git(scratch, ['cat-file', '--batch-all-objects', '--batch-check']).trim().split('\n');
      expect(listing.length).toBe(summary.objects); // no object twice, none missing from the count
      const want = new Set([...kit.oracleObjects(c.common).keys(), c.inWork(['hash-object', '--stdin'], 'only in the working tree\n').trim(), c.inWork(['hash-object', '--stdin'], 'a dirty edit\n').trim(), c.inWork(['rev-parse', ':staged.txt']).trim()]);
      expect(new Set(listing.map((l) => l.split(' ')[0]))).toEqual(want);
      const packIdx = readdirSync(join(scratch, 'objects', 'pack')).find((n) => n.endsWith('.idx')) ?? '';
      expect(kit.git(scratch, ['verify-pack', '-v', join(scratch, 'objects', 'pack', packIdx)]).split('\n').filter((l) => l.split(/\s+/).length === 7)).toEqual([]); // a delta line has seven columns; there is none
      expect(summary.packSha1).toBe(bytes.subarray(bytes.length - 20).toString('hex'));
    } finally { r.close(); }
  });

  it('an object id that history names as both a tree and a blob is refused (type confusion), and the same history without the confusion exports', async () => {
    const make = (confuse: boolean): ReturnType<Kit['makeCandidate']> => {
      const work = kit.dir('confusion');
      kit.git(work, ['init', '--quiet', '--initial-branch=main']);
      const blob = kit.git(work, ['hash-object', '-w', '--stdin'], 'content\n').trim();
      const inner = kit.git(work, ['mktree'], `100644 blob ${blob}\tleaf\n`).trim(); // a tree X
      const raw = (mode: string, name: string, oid: string): Buffer => Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(oid, 'hex')]);
      const oldTree = kit.gitRaw(work, ['hash-object', '-t', 'tree', '-w', '--literally', '--stdin'], raw('100644', 'f', confuse ? inner : blob)).toString().trim(); // X as a blob, or the real blob
      const newTree = kit.gitRaw(work, ['hash-object', '-t', 'tree', '-w', '--literally', '--stdin'], raw('40000', 'd', inner)).toString().trim(); // X as a tree
      const first = kit.git(work, ['commit-tree', '-m', 'old', oldTree]).trim();
      const head = kit.git(work, ['commit-tree', '-m', 'new', '-p', first, newTree]).trim();
      kit.git(work, ['update-ref', 'refs/heads/main', head]);
      return kit.makeCandidate({}, { source: { work, head }, noCheckout: true, copyObjects: true });
    };
    const ok = make(false);
    const r = openCandidate(ok.mountRoot, ok.target);
    try { expect((await r.exportPack(join(kit.dir('confusion-ok'), 'o.pack'))).commits).toBe(2); } finally { r.close(); }
    const bad = make(true);
    const r2 = openCandidate(bad.mountRoot, bad.target);
    try { expectCode(await refusalAsync(() => r2.exportPack(join(kit.dir('confusion-bad'), 'o.pack'))), 'object_corrupt', 'both a tree and a blob'); } finally { r2.close(); }
  });

  it('a working-tree file that changes between the snapshot and the export is refused, and nothing is left behind (the export reads each file again and checks its hash)', async () => {
    const c = kit.makeCandidate({ 'a.txt': 'a\n' });
    kit.writeFiles(c.work, { 'dirty.txt': 'as scanned\n' });
    const out = join(kit.dir('export-changed'), 'objects.pack');
    const r = openCandidate(c.mountRoot, c.target);
    try {
      await r.snapshot();
      writeFileSync(join(c.work, 'dirty.txt'), 'changed after\n');
      expectCode(await refusalAsync(() => r.exportPack(out)), 'file_changed');
      expect(existsSync(out)).toBe(false);
      writeFileSync(join(c.work, 'dirty.txt'), 'as scanned\n'); // control: put back, the same reader exports
      expect((await r.exportPack(out)).objects).toBeGreaterThan(3);
    } finally { r.close(); }
  });

  it('an entry that names the empty tree, in a repository that does not store it, is snapshotted and exported: Git holds the empty tree in every repository (review, Livia)', async () => {
    const empty = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
    const source = kit.historySource([[{ mode: '40000', name: Buffer.from('empty-dir'), oid: empty }, { mode: '100644', name: Buffer.from('f.txt'), content: Buffer.from('f\n') }]]);
    const c = kit.makeCandidate({}, { source, noCheckout: true, copyObjects: true });
    expect(existsSync(join(c.gitDir, 'objects', empty.slice(0, 2), empty.slice(2)))).toBe(false); // not stored as a loose object
    expect(readdirSync(join(c.gitDir, 'objects', 'pack')).filter((n) => n.endsWith('.pack'))).toEqual([]); // nor in a pack
    expect(c.inCommon(['cat-file', '-t', empty]).trim()).toBe('tree'); // Git has it all the same
    const r = openCandidate(c.mountRoot, c.target);
    try {
      expect((await r.snapshot()).committed.files.map((f) => f.path)).toEqual(['f.txt']);
      const out = join(kit.dir('export-empty'), 'objects.pack');
      expect((await r.exportPack(out)).objects).toBe(4); // the commit, the root tree, the blob and the empty tree, written from memory
      const scratch = kit.dir('export-empty-verify');
      kit.git(scratch, ['init', '--quiet', '--bare', '.']);
      kit.git(scratch, ['index-pack', '--strict', '--stdin'], readFileSync(out));
    } finally { r.close(); }
  });

  it('the output file must not exist (and is left alone), may not be inside the directory being read, and is removed when the export fails', async () => {
    const c = kit.makeCandidate({ 'a.txt': 'a\n' });
    const dir = kit.dir('export-refused');
    const existing = join(dir, 'there.pack');
    writeFileSync(existing, 'precious');
    const r = openCandidate(c.mountRoot, c.target);
    try {
      expectCode(await refusalAsync(() => r.exportPack(existing)), 'output_exists');
      expect(readFileSync(existing, 'utf8')).toBe('precious');
      symlinkSync(existing, join(dir, 'link.pack'));
      expectCode(await refusalAsync(() => r.exportPack(join(dir, 'link.pack'))), 'output_exists'); // a link is not followed
      expectCode(await refusalAsync(() => r.exportPack(join(c.gen, 'work', 'main', 'inside.pack'))), 'invalid_request');
      expect(existsSync(join(c.work, 'inside.pack'))).toBe(false);
    } finally { r.close(); }
    // an export that fails leaves no file behind
    const broken = kit.makeCandidate({ 'a.txt': 'a\n' });
    writeFileSync(join(broken.admin, 'index'), buildIndex([{ path: 'a.txt', oid: sha1Object('blob', Buffer.from('not in the store')) }]));
    const out = join(kit.dir('export-failed'), 'objects.pack');
    const r2 = openCandidate(broken.mountRoot, broken.target);
    try { expectCode(await refusalAsync(() => r2.exportPack(out)), 'object_missing'); } finally { r2.close(); }
    expect(existsSync(out)).toBe(false);
  });
});

describe('what a refusal says', () => {
  it('carries the code, the file and the rule, and at most 64 bytes of content, as hex', () => {
    const e = new ReaderError('object_corrupt', { reason: 'a test', file: 'objects/ab/cdef', content: Buffer.alloc(200, 0xab) });
    expect(e.contentHex).toBe('ab'.repeat(64));
    expect(e.message).not.toContain('ab'.repeat(65));
    expect(e).toMatchObject({ code: 'object_corrupt', file: 'objects/ab/cdef', reason: 'a test' });
  });
});
