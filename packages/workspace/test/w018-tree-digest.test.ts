import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TREE_DIGEST_ALGORITHM, TREE_DIGEST_TEST_VECTOR, computeTreeDigest, treeEntries } from '../src/index.ts';
import { createEnv, generationDir, specFor, treeDigestOf, type Env } from './harness.ts';

// The recorded digest of the committed vector. W-020's reader must reproduce it byte for byte.
const RECORDED = '8b2c1f5a222b30d83283009118ead7519fa5be095884acf36ac2d5787253c58c';
const blob = (path: string | Buffer, mode: string, content: string | Buffer) => ({ pathBytes: Buffer.isBuffer(path) ? path : Buffer.from(path), mode, blob: Buffer.isBuffer(content) ? content : Buffer.from(content) });

let e: Env;
beforeAll(async () => {
  e = await createEnv('w018_digest', { files: { 'a.txt': 'hello\n', 'bin/run.sh': { content: '#!/bin/sh\necho hi\n', mode: 0o755 }, link: { symlink: 'a.txt' }, 'dir/sub/deep.txt': 'deep\n', empty: '' } });
});
afterAll(async () => { await e.close(); });

describe('treeDigest (SI-16)', () => {
  it('the committed vector gives the recorded digest, whatever order the entries arrive in', () => {
    expect(TREE_DIGEST_TEST_VECTOR.digest).toBe(RECORDED);
    expect(TREE_DIGEST_ALGORITHM).toBe('factory-tree-digest/1');
    expect(computeTreeDigest(TREE_DIGEST_TEST_VECTOR.items)).toBe(RECORDED);
    expect(computeTreeDigest([...TREE_DIGEST_TEST_VECTOR.items].reverse())).toBe(RECORDED);
    const entries = treeEntries(TREE_DIGEST_TEST_VECTOR.items);
    expect(entries.map((x) => x.path)).toEqual(['a.txt', 'bin/run.sh', 'dir/sub/deep.txt', 'empty', 'link']);
    expect(entries.find((x) => x.path === 'link')).toMatchObject({ kind: 'symlink', mode: '120000', symlinkTarget: 'a.txt' });
    expect(entries.find((x) => x.path === 'bin/run.sh')).toMatchObject({ kind: 'file', mode: '100755' });
    expect(entries.find((x) => x.path === 'a.txt')).not.toHaveProperty('symlinkTarget');
  });

  it('the same tree committed to real Git, and materialized, gives the same digest', async () => {
    expect(treeDigestOf(e.fx, e.repoA.work, e.repoA.base)).toBe(RECORDED);
    const id = randomUUID();
    await e.manager.allocateOrAttach(e.runner(e.a), id, specFor(e.a, await e.setupRef(e.a), e.repoA.base));
    expect(await e.host.ensureMaterialized(e.runner(e.a), id)).toMatchObject({ receipt: { treeDigest: RECORDED } });
  });

  it('a non-UTF-8 path, a non-UTF-8 symlink target and a submodule entry are each refused', async () => {
    expect(() => computeTreeDigest([blob(Buffer.from([0x66, 0xff, 0xfe]), '100644', 'x')])).toThrow(expect.objectContaining({ code: 'non_utf8_path' }) as Error);
    expect(() => computeTreeDigest([blob('l', '120000', Buffer.from([0xc3, 0x28]))])).toThrow(expect.objectContaining({ code: 'non_utf8_symlink_target' }) as Error);
    expect(() => computeTreeDigest([blob('sub', '160000', '')])).toThrow(expect.objectContaining({ code: 'unsupported_tree_entry' }) as Error);
    expect(() => computeTreeDigest([blob('odd', '100664', 'x')])).toThrow(expect.objectContaining({ code: 'unsupported_tree_entry' }) as Error);

    // And through real Git objects, refused before any file is checked out.
    const cases: Array<[string, Parameters<typeof e.fx.plumbingCommit>[0], string]> = [
      ['non_utf8_path', [{ mode: '100644', path: Buffer.from([0x62, 0xff, 0xfe]), content: Buffer.from('x') }], 'weird1'],
      ['non_utf8_symlink_target', [{ mode: '120000', path: Buffer.from('l'), content: Buffer.from([0xc3, 0x28]) }], 'weird2'],
      ['unsupported_tree_entry', [{ mode: '160000', path: Buffer.from('submodule'), content: 'commit' }], 'weird3'],
    ];
    for (const [code, entries, branch] of cases) {
      const p = e.fx.plumbingCommit(entries);
      e.fx.git(p.repo, ['push', '--quiet', e.repoA.bare, `main:refs/heads/${branch}`]);
      const id = randomUUID();
      await e.manager.allocateOrAttach(e.runner(e.a), id, specFor(e.a, await e.setupRef(e.a), p.commit, { branch: `factory/${e.a.taskId}/${branch}` }));
      await expect(e.host.ensureMaterialized(e.runner(e.a), id)).rejects.toMatchObject({ code });
      expect(existsSync(generationDir(e, e.a, id, 1))).toBe(false);
    }
  });

  it('byte order differs from UTF-16 order on a chosen pair of paths, and the byte order wins', () => {
    const bmp = '｡';      // UTF-8 EF BD A1, UTF-16 FF61
    const astral = '\u{1F600}'; // UTF-8 F0 9F 98 80, UTF-16 D83D DE00
    expect([bmp, astral].sort()).toEqual([astral, bmp]);                       // JavaScript string order: astral first
    expect(Buffer.compare(Buffer.from(bmp), Buffer.from(astral))).toBeLessThan(0); // byte order: bmp first
    const entries = treeEntries([blob(astral, '100644', 'a'), blob(bmp, '100644', 'b')]);
    expect(entries.map((x) => x.path)).toEqual([bmp, astral]);
    expect(computeTreeDigest([blob(astral, '100644', 'a'), blob(bmp, '100644', 'b')])).toBe(computeTreeDigest([blob(bmp, '100644', 'b'), blob(astral, '100644', 'a')]));
  });

  it('a leading BOM is part of the path, never stripped (so it cannot collide with the same name without it), and a duplicate path is refused', () => {
    const plain = treeEntries([blob('a.txt', '100644', 'x')]);
    const bom = treeEntries([blob('\uFEFFa.txt', '100644', 'x')]);
    expect(bom[0]?.path).toBe('\uFEFFa.txt');
    expect(bom[0]?.path).not.toBe(plain[0]?.path);
    expect(computeTreeDigest([blob('\uFEFFa.txt', '100644', 'x')])).not.toBe(computeTreeDigest([blob('a.txt', '100644', 'x')]));
    // Both names in one tree are two entries, not one.
    expect(treeEntries([blob('a.txt', '100644', 'x'), blob('\uFEFFa.txt', '100644', 'y')]).map((x) => x.path)).toEqual(['a.txt', '\uFEFFa.txt'].sort((p, q) => Buffer.compare(Buffer.from(p), Buffer.from(q))));
    expect(() => treeEntries([blob('dup', '100644', 'x'), blob('dup', '100644', 'y')])).toThrow(expect.objectContaining({ code: 'duplicate_path' }) as Error);
  });

  it('paths that share one blob are hashed once and still each get an entry', () => {
    const shared = Buffer.from('same bytes');
    const entries = treeEntries([{ pathBytes: Buffer.from('p1'), mode: '100644', blob: shared }, { pathBytes: Buffer.from('p2'), mode: '100644', blob: shared }]);
    expect(entries.map((x) => x.sha256)).toEqual([entries[0]?.sha256, entries[0]?.sha256]);
    expect(entries).toHaveLength(2);
  });
});
