import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openCandidate } from '../src/git-reader/index.ts';
import { openCandidateWithHooks } from '../src/git-reader/testing.ts';
import { makeKit, sha1Object, type CandidateFixture, type Kit } from './git-reader-kit.ts';
import { expectCode, refusalAsync } from './git-reader-helpers.ts';

// AC-230's material at the library level (7.3, 7.8): a repository planted with everything Git would act on, and a reader that acts on none of it.
let kit: Kit;
beforeAll(() => { kit = makeKit(); });
afterAll(() => { kit.cleanup(); });

const FILES = { 'a.txt': 'original a\n', 'dir/b.txt': 'b\n', '.gitattributes': '* filter=evil diff=evil\n' };
const HOOKS = ['applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit', 'pre-rebase', 'post-checkout', 'post-merge', 'pre-push', 'pre-receive', 'update', 'post-receive', 'post-update', 'reference-transaction', 'push-to-checkout', 'pre-auto-gc', 'post-rewrite', 'sendemail-validate', 'fsmonitor-watchman', 'post-index-change'];

const snapOf = async (c: CandidateFixture) => { const r = openCandidate(c.mountRoot, c.target); try { return await r.snapshot(); } finally { r.close(); } };

// A script that records that it ran: it touches `<canary>/<name>` and succeeds.
function canaryScript(dir: string, canary: string, name: string, body = ''): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\ntouch '${canary}/${name}'\n${body}`);
  chmodSync(path, 0o755);
  return path;
}

describe('a planted repository', () => {
  it('the reader writes no canary and reads the same digests as the unplanted repository; Git run directly in it fires every canary and shows the replaced blob', async () => {
    const clean = kit.makeCandidate(FILES, { more: [{ 'a.txt': 'second version of a\n' }] });
    const planted = kit.makeCandidate(FILES, { more: [{ 'a.txt': 'second version of a\n' }] });
    expect(planted.head).toBe(clean.head); // same commits, so the same digests are expected

    const canary = kit.dir('canary');
    const evil = kit.dir('evil');
    const script = (name: string, body = ''): string => canaryScript(evil, canary, name, body);
    const aBlob = planted.inWork(['rev-parse', 'HEAD:a.txt']).trim();
    const replacement = planted.inWork(['hash-object', '-w', '--stdin'], 'REPLACED CONTENT\n').trim();

    // configuration
    const cfg = (key: string, value: string): void => { planted.inCommon(['config', '--file', join(planted.gitDir, 'config'), key, value]); };
    cfg('core.fsmonitor', script('fsmonitor', 'printf "\\0"\n'));
    cfg('core.hooksPath', join(evil, 'hooks'));
    for (const hook of HOOKS) { script(`hook-${hook}`); mkdirSync(join(evil, 'hooks'), { recursive: true }); writeFileSync(join(evil, 'hooks', hook), `#!/bin/sh\ntouch '${canary}/hook-${hook}'\n`); chmodSync(join(evil, 'hooks', hook), 0o755); writeFileSync(join(planted.gitDir, 'hooks', hook), `#!/bin/sh\ntouch '${canary}/dothooks-${hook}'\n`, { mode: 0o755 }); }
    cfg('filter.evil.clean', `${script('filter-clean')} %f`);
    cfg('filter.evil.smudge', `${script('filter-smudge')} %f`);
    cfg('diff.evil.textconv', script('textconv', 'cat "$1"\n'));
    cfg('diff.evil.command', script('diffdriver'));
    cfg('core.sshCommand', script('ssh'));
    // attributes outside the tree
    mkdirSync(join(planted.gitDir, 'info'), { recursive: true });
    writeFileSync(join(planted.gitDir, 'info', 'attributes'), '* filter=evil diff=evil text eol=crlf\n');
    writeFileSync(join(planted.gitDir, 'info', 'exclude'), '*\n');
    // history and objects
    writeFileSync(join(planted.gitDir, 'info', 'grafts'), `${planted.head}\n`); // HEAD is parentless as far as Git is told
    writeFileSync(join(planted.gitDir, 'shallow'), `${planted.head}\n`);
    planted.inCommon(['update-ref', `refs/replace/${aBlob}`, replacement]);
    // the worktree's own pointers
    const decoy = kit.dir('decoy');
    cpSync(planted.gitDir, join(decoy, 'common.git'), { recursive: true });
    writeFileSync(join(planted.admin, 'commondir'), `${join(decoy, 'common.git')}\n`);
    writeFileSync(join(planted.admin, 'gitdir'), `${join(decoy, 'elsewhere', '.git')}\n`);
    writeFileSync(join(planted.admin, 'config.worktree'), `[core]\n\thooksPath = ${join(evil, 'hooks')}\n`);
    writeFileSync(join(planted.gitDir, 'objects', 'info', 'http-alternates'), 'http://127.0.0.1:1/nothing\n');

    for (const f of readdirSync(canary)) rmSync(join(canary, f)); // planting ran Git itself (update-ref fired a hook): start the reader from silence
    const before = await snapOf(clean);
    const seen: string[] = [];
    const r = openCandidateWithHooks(planted.mountRoot, planted.target, {}, { onFs: (op, p) => { seen.push(p.toString()); } });
    let after;
    try { after = await r.snapshot(); } finally { r.close(); }

    expect(readdirSync(canary)).toEqual([]); // the reader ran nothing
    expect(after.committed).toEqual(before.committed);
    expect(after.head).toEqual(before.head);
    expect(after.index).toEqual(before.index);
    expect(after.worktree).toEqual(before.worktree);
    // and it never even opened what it must not honour
    for (const never of ['/config', '/info/attributes', '/info/grafts', '/shallow', '/info/exclude', 'commondir', '/gitdir', 'config.worktree', '/hooks', 'alternates', '/refs/replace', 'commit-graph', 'multi-pack-index']) {
      expect(seen.filter((p) => p.includes(never)), never).toEqual([]);
    }

    // The control: the fixtures are live. Git run directly in the planted repository fires the canaries and honours the replaced blob.
    appendFileSync(join(planted.work, 'a.txt'), 'edited after the reader ran\n');
    const run = (args: string[]): string => { try { return execFileSync('/usr/bin/git', args, { cwd: planted.work, env: kit.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return (e as { stdout?: string }).stdout ?? ''; } };
    run(['status']);
    run(['diff']);
    run(['log', '-p']);
    const fired = readdirSync(canary);
    expect(fired.length).toBeGreaterThan(0);
    expect(fired).toEqual(expect.arrayContaining(['fsmonitor']));
    expect(run(['cat-file', '-p', aBlob])).toBe('REPLACED CONTENT\n'); // the replace ref swapped the blob for Git
    expect(run(['log', '--oneline']).trim().split('\n').length).toBe(1); // the graft and the shallow file hide the parent from Git
    expect(planted.inCommon(['rev-parse', '--git-common-dir']).trim()).not.toBe(planted.gitDir);
  });

  it('an alternate holding objects that were pruned locally: Git finds them, the reader reports them missing', async () => {
    const c = kit.makeCandidate({ 'a.txt': 'a\n' });
    const alt = kit.dir('alt-objects');
    const body = Buffer.from('only in the alternate\n');
    const oid = sha1Object('blob', body);
    kit.git(alt, ['init', '--quiet', '--bare', '.']);
    kit.git(alt, ['hash-object', '-w', '--stdin'], body);
    mkdirSync(join(c.gitDir, 'objects', 'info'), { recursive: true });
    writeFileSync(join(c.gitDir, 'objects', 'info', 'alternates'), `${join(alt, 'objects')}\n`);
    expect(c.inCommon(['cat-file', '-p', oid])).toBe('only in the alternate\n'); // the control: Git reads it through the alternate
    // an index entry that names it
    c.inWork(['update-index', '--add', '--cacheinfo', `100644,${oid},from-alternate.txt`]);
    const e = await refusalAsync(() => snapOf(c));
    expectCode(e, 'object_missing');
    expect(e.contentHex).toBe(oid);
    rmSync(join(c.gitDir, 'objects', 'info', 'alternates'));
    c.inWork(['update-index', '--force-remove', 'from-alternate.txt']);
    expect((await snapOf(c)).head.commit).toBe(c.head);
  });
});
