import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openCandidate } from '../src/git-reader/index.ts';
import { makeKit, readInChild, type CandidateFixture, type Kit } from './git-reader-kit.ts';
import { expectCode, refusalAsync } from './git-reader-helpers.ts';

let kit: Kit;
beforeAll(() => { kit = makeKit(); });
afterAll(() => { kit.cleanup(); });

const FILES = { 'a.txt': 'a\n', 'dir/b.txt': 'b\n' };
async function snap(c: CandidateFixture, limits = {}) {
  const r = openCandidate(c.mountRoot, c.target, limits);
  try { return await r.snapshot(); } finally { r.close(); }
}
const head = (c: CandidateFixture): string => c.inWork(['rev-parse', 'HEAD']).trim();

describe('HEAD and the refs it names', () => {
  it('detached HEAD (as W-018 creates it), a loose branch ref, and packed refs after pack-refs --all', async () => {
    const c = kit.makeCandidate(FILES);
    const detached = await snap(c);
    expect(detached.head).toMatchObject({ commit: head(c), ref: null });
    c.inWork(['checkout', '--quiet', '-b', 'factory/task-1']);
    kit.writeFiles(c.work, { 'a.txt': 'changed\n' });
    c.inWork(['commit', '--quiet', '-am', 'on the branch']);
    const loose = await snap(c);
    expect(loose.head).toMatchObject({ commit: head(c), ref: 'refs/heads/factory/task-1' });
    expect(readdirSync(join(c.gitDir, 'refs', 'heads', 'factory'))).toContain('task-1');
    c.inCommon(['pack-refs', '--all']);
    expect(existsSync(join(c.gitDir, 'refs', 'heads', 'factory', 'task-1'))).toBe(false); // the loose file is gone
    expect(readFileSync(join(c.gitDir, 'packed-refs'), 'latin1')).toContain('refs/heads/factory/task-1');
    const packed = await snap(c);
    expect(packed.head).toMatchObject({ commit: head(c), ref: 'refs/heads/factory/task-1' });
  });

  it('a chain of five refs read (HEAD, three symbolic refs and the branch) reads, and a chain of six is refused, as Git does', async () => {
    // HEAD -> s1 -> ... -> s(n-1) -> a branch that holds the commit: n symbolic names including HEAD, then the ref that holds the oid.
    const build = (symrefs: number): CandidateFixture => {
      const c = kit.makeCandidate(FILES);
      c.inCommon(['update-ref', 'refs/heads/target', c.head]);
      let next = 'refs/heads/target';
      for (let i = symrefs - 1; i >= 1; i -= 1) { c.inCommon(['symbolic-ref', `refs/heads/s${String(i)}`, next]); next = `refs/heads/s${String(i)}`; }
      writeFileSync(join(c.admin, 'HEAD'), `ref: ${next}\n`);
      return c;
    };
    const five = build(4); // HEAD, s1, s2, s3 and the branch: five refs read
    expect(head(five)).toBe(five.head); // Git resolves it
    expect((await snap(five)).head.commit).toBe(five.head);
    const six = build(5); // one more
    expect(() => head(six)).toThrow(); // Git refuses it
    expectCode(await refusalAsync(() => snap(six)), 'invalid_ref', 'longer than five');
  });

  it('HEAD naming a tag is refused (control: the commit it tags is read)', async () => {
    const c = kit.makeCandidate(FILES);
    c.inCommon(['tag', '-a', '-m', 'annotated', 'v1', c.head]);
    const tagOid = c.inCommon(['rev-parse', 'refs/tags/v1']).trim();
    expect(c.inCommon(['cat-file', '-t', tagOid]).trim()).toBe('tag');
    writeFileSync(join(c.admin, 'HEAD'), `${tagOid}\n`);
    expectCode(await refusalAsync(() => snap(c)), 'object_corrupt', 'not a commit');
    writeFileSync(join(c.admin, 'HEAD'), `${c.head}\n`);
    expect((await snap(c)).head.commit).toBe(c.head);
  });

  it('a reftable repository is refused by the existence of `reftable` alone', async () => {
    const probe = kit.dir('reftable-probe');
    let real = true;
    try { kit.git(probe, ['init', '--quiet', '--ref-format=reftable']); } catch { real = false; }
    if (real) expect(readdirSync(join(probe, '.git'))).toContain('reftable'); // the fixture is what Git makes
    const c = kit.makeCandidate(FILES);
    expect((await snap(c)).head.commit).toBe(c.head); // control: without it, the repository reads
    mkdirSync(join(c.gitDir, 'reftable'));
    expectCode(await refusalAsync(() => snap(c)), 'unsupported_ref_storage');
  });

  it('a ref name with .., and other names Git refuses, and a ref outside refs/heads/', async () => {
    const c = kit.makeCandidate(FILES);
    for (const name of ['refs/heads/a..b', 'refs/heads/a b', 'refs/heads/.hidden', 'refs/heads/x.lock', 'refs/heads/a~1', 'refs/heads/a@{1}', 'refs/heads/', 'refs/heads/a//b', 'refs/heads/end.', 'refs/remotes/origin/main', 'refs/heads/a\\b', 'refs/heads/a:b']) {
      writeFileSync(join(c.admin, 'HEAD'), `ref: ${name}\n`);
      expectCode(await refusalAsync(() => snap(c)), 'invalid_ref');
    }
    c.inCommon(['update-ref', 'refs/heads/fine-name_1.0', c.head]);
    writeFileSync(join(c.admin, 'HEAD'), 'ref: refs/heads/fine-name_1.0\n');
    expect((await snap(c)).head.ref).toBe('refs/heads/fine-name_1.0'); // control
    // names with bytes of 0x80 and above are Git's to allow, and are read when they are well-formed UTF-8 (review, Livia 5); a lone 0xff is not
    c.inCommon(['update-ref', 'refs/heads/caf\u00e9-\u0432\u0435\u0440\u0441\u0438\u044f', c.head]);
    writeFileSync(join(c.admin, 'HEAD'), 'ref: refs/heads/caf\u00e9-\u0432\u0435\u0440\u0441\u0438\u044f\n');
    expect((await snap(c)).head.ref).toBe('refs/heads/caf\u00e9-\u0432\u0435\u0440\u0441\u0438\u044f');
    writeFileSync(join(c.admin, 'HEAD'), Buffer.concat([Buffer.from('ref: refs/heads/bad'), Buffer.from([0xff]), Buffer.from('\n')]));
    expectCode(await refusalAsync(() => snap(c)), 'invalid_ref', 'UTF-8');
  });

  it('a HEAD that is neither `ref:` nor an oid, a 64-digit oid, an oversized HEAD, and a ref that does not exist', async () => {
    const c = kit.makeCandidate(FILES);
    const put = (text: string | Buffer): void => { writeFileSync(join(c.admin, 'HEAD'), text); };
    put('garbage\n');
    expectCode(await refusalAsync(() => snap(c)), 'invalid_ref');
    put(`${'a'.repeat(64)}\n`);
    expectCode(await refusalAsync(() => snap(c)), 'unsupported_hash');
    put(`ref: refs/heads/${'x'.repeat(5000)}\n`);
    const big = await refusalAsync(() => snap(c));
    expectCode(big, 'limit_exceeded');
    expect(big.limit).toBe('maxRefFileBytes');
    put('ref: refs/heads/nothing-here\n');
    expectCode(await refusalAsync(() => snap(c)), 'invalid_ref', 'does not exist');
    put(`${c.head.toUpperCase()}\n`);
    expectCode(await refusalAsync(() => snap(c)), 'invalid_ref'); // lower-case hex only
    put(`${c.head}\n`);
    expect((await snap(c)).head.commit).toBe(c.head);
  });

  it('packed-refs: malformed lines, a 64-digit id, and a file over its cap are refused (control: Git-written packed-refs read)', async () => {
    const c = kit.makeCandidate(FILES);
    c.inWork(['checkout', '--quiet', '-b', 'packed-branch']);
    c.inCommon(['pack-refs', '--all']);
    const packedPath = join(c.gitDir, 'packed-refs');
    const original = readFileSync(packedPath);
    expect((await snap(c)).head.ref).toBe('refs/heads/packed-branch'); // control
    const put = (text: string): void => { writeFileSync(packedPath, text); };
    put(`# pack-refs with: peeled fully-peeled sorted \n${c.head} refs/heads/packed-branch\nnot a line\n`);
    expectCode(await refusalAsync(() => snap(c)), 'invalid_ref', 'malformed');
    put(`${'b'.repeat(64)} refs/heads/packed-branch\n`);
    expectCode(await refusalAsync(() => snap(c)), 'unsupported_hash');
    put(`^${c.head}\n`);
    expectCode(await refusalAsync(() => snap(c)), 'invalid_ref', 'peel');
    put(`${c.head} outside/refs\n`);
    expectCode(await refusalAsync(() => snap(c)), 'invalid_ref', 'does not exist'); // a broken name is skipped, as Git skips it, and HEAD's ref is not there
    writeFileSync(packedPath, original);
    expect((await snap(c)).head.ref).toBe('refs/heads/packed-branch');
    const small = await refusalAsync(() => snap(c, { maxPackedRefsBytes: original.length - 1 }));
    expect(small.limit).toBe('maxPackedRefsBytes');
    const lines = await refusalAsync(() => snap(c, { maxPackedRefsLines: 1 }));
    expect(lines.limit).toBe('maxPackedRefsLines');
    expect((await snap(c, { maxPackedRefsBytes: original.length })).head.commit).toBe(head(c)); // at the cap it reads
  });

  it('a packed tag with a Cyrillic name does not stop the branch HEAD names from being read (review, Livia 5); an unrelated broken line is skipped, and order matters only when the header says sorted', async () => {
    const c = kit.makeCandidate(FILES);
    c.inCommon(['tag', '\u0432\u0435\u0440\u0441\u0438\u044f-1', c.head]);
    c.inWork(['checkout', '--quiet', '-b', 'work']);
    c.inCommon(['pack-refs', '--all']);
    expect(readFileSync(join(c.gitDir, 'packed-refs'), 'utf8')).toContain('refs/tags/\u0432\u0435\u0440\u0441\u0438\u044f-1');
    expect(c.inWork(['rev-parse', 'HEAD']).trim()).toBe(c.head); // Git resolves it
    expect((await snap(c)).head).toMatchObject({ commit: c.head, ref: 'refs/heads/work' });
    // a line with a name Git marks broken is skipped; the line HEAD needs is still read
    const packed = join(c.gitDir, 'packed-refs');
    const ok = `# pack-refs with: peeled fully-peeled sorted \n${c.head} refs/heads/work\n`;
    writeFileSync(packed, `${ok}${c.head} refs/heads/zz..broken\n`);
    expect((await snap(c)).head.commit).toBe(c.head);
    // without the sorted trait the order is nobody's business; with it, an unsorted file is refused
    writeFileSync(packed, `# pack-refs with: peeled\n${c.head} refs/heads/work\n${c.head} refs/heads/another\n`);
    expect((await snap(c)).head.commit).toBe(c.head);
    writeFileSync(packed, `# pack-refs with: peeled sorted\n${c.head} refs/heads/work\n${c.head} refs/heads/another\n`);
    expectCode(await refusalAsync(() => snap(c)), 'invalid_ref', 'sorted');
  });

  it('a directory symlink inside refs/heads is refused, not followed', async () => {
    const c = kit.makeCandidate(FILES);
    const outside = kit.dir('outside-refs');
    writeFileSync(join(outside, 'main'), `${c.head}\n`);
    mkdirSync(join(c.gitDir, 'refs', 'heads'), { recursive: true });
    symlinkSync(outside, join(c.gitDir, 'refs', 'heads', 'linked'));
    writeFileSync(join(c.admin, 'HEAD'), 'ref: refs/heads/linked/main\n');
    expectCode(await refusalAsync(() => snap(c)), 'path_unsafe');
  });
});

describe('a FIFO planted where a file is expected is refused without blocking', () => {
  const mkfifo = (path: string): void => { rmSync(path, { force: true }); execFileSync('mkfifo', [path]); };

  it('control: the unmodified fixture reads in a child process', () => {
    const c = kit.makeCandidate(FILES);
    const r = readInChild(c);
    expect(r.timedOut).toBe(false);
    expect(r.result).toMatchObject({ ok: true, commit: c.head });
  });

  const cases: Array<[string, (c: CandidateFixture) => string]> = [
    ['worktrees/main/HEAD', (c) => join(c.admin, 'HEAD')],
    ['worktrees/main/index', (c) => join(c.admin, 'index')],
    ['packed-refs', (c) => join(c.gitDir, 'packed-refs')],
  ];
  for (const [name, where] of cases) {
    it(name, () => {
      const c = kit.makeCandidate(FILES);
      if (name === 'packed-refs') { c.inWork(['checkout', '--quiet', '-b', 'b']); c.inCommon(['pack-refs', '--all']); rmSync(join(c.gitDir, 'refs', 'heads', 'b'), { force: true }); }
      mkfifo(where(c));
      const r = readInChild(c);
      expect(r.timedOut).toBe(false);
      expect(r.result).toMatchObject({ ok: false, code: 'not_regular_file' });
    });
  }

  it('a regular file swapped for a FIFO between lstat and open is refused without blocking (O_NONBLOCK, then fstat)', () => {
    const c = kit.makeCandidate(FILES);
    const r = readInChild(c, undefined, 5000, join(c.admin, 'HEAD'));
    expect(r.timedOut).toBe(false);
    expect(r.result).toMatchObject({ ok: false, code: 'not_regular_file' });
  });

  for (const ext of ['idx', 'pack'] as const) {
    it(`a .${ext} in objects/pack`, () => {
      const c = kit.makeCandidate(FILES);
      c.inCommon(['gc', '--quiet', '--prune=now']);
      const file = readdirSync(join(c.gitDir, 'objects', 'pack')).find((n) => n.endsWith(`.${ext}`)) ?? '';
      expect(file).not.toBe('');
      const full = join(c.gitDir, 'objects', 'pack', file);
      renameSync(full, `${full}.moved`);
      mkfifo(full);
      const r = readInChild(c);
      expect(r.timedOut).toBe(false);
      expect(r.result).toMatchObject({ ok: false, code: 'not_regular_file' });
    });
  }
});
