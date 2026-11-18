import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { provisionOrganization } from '@factory/database';
import { createHash } from 'node:crypto';
import { readdirSync, writeFileSync } from 'node:fs';
import { LocalMaterializer, MATERIALIZE_LIMITS, assertNoFoldedCollisions, assertSymlinksContained, assertTaskBranch, symlinkEscapes, treeEntries, validateSubpath, verifyCheckout } from '../src/index.ts';
import { fileGit, createEnv, generationDir, specFor, type Env, type Tenant } from './harness.ts';

let e: Env;
beforeAll(async () => { e = await createEnv('w018_paths', { files: { 'README.md': 'hi\n', 'src/app.txt': 'app\n', 'dir/sibling.txt': 'sib\n', 'dir/ok': { symlink: 'sibling.txt' } } }); });
afterAll(async () => { await e.close(); });

async function tenantWith(cloneUrl: string, subpath: string): Promise<Tenant> {
  const orgId = randomUUID();
  await provisionOrganization(e.m.migratorUrl, { id: orgId, name: 'P' });
  return e.seedTenant(orgId, cloneUrl, subpath);
}
async function allocate(t: Tenant, base: string, over: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  await e.manager.allocateOrAttach(e.runner(t), id, specFor(t, await e.setupRef(t), base, over));
  return id;
}
const pushMain = (): void => { e.fx.git(e.repoA.work, ['push', '--quiet', e.repoA.bare, 'main']); };

describe('paths, sources and names', () => {
  it('a subpath that leaves the repository is refused, an in-tree one works, a missing one is refused at materialization', async () => {
    for (const bad of ['../outside', 'a/../../b', '/etc', 'a//b', './a', 'a\\b']) {
      const t = await tenantWith(e.repoA.bare, bad);
      await expect(allocate(t, e.repoA.base)).rejects.toMatchObject({ code: 'path_traversal' });
    }
    const good = await tenantWith(e.repoA.bare, 'src');
    const id = await allocate(good, e.repoA.base);
    expect(await e.host.ensureMaterialized(e.runner(good), id)).toMatchObject({ outcome: 'materialized' });
    expect(await e.manager.materializationRequest(e.runner(good), id, 1)).toEqual({ ok: false, code: 'not_materializable' });
    const missing = await tenantWith(e.repoA.bare, 'nope/deeper');
    const mid = await allocate(missing, e.repoA.base);
    await expect(e.host.ensureMaterialized(e.runner(missing), mid)).rejects.toMatchObject({ code: 'invalid_subpath' });
    expect(existsSync(generationDir(e, missing, mid, 1))).toBe(false);
    expect(() => validateSubpath('')).not.toThrow();
  });

  it('a tracked symlink that leaves the root is refused (control: one that stays inside is fine)', async () => {
    const inside = e.repoA.commit({ 'dir/ok2': { symlink: 'sibling.txt' }, 'dir/sub/deeper': { symlink: 'x/y/z' } });
    pushMain();
    const okId = await allocate(e.a, inside);
    expect(await e.host.ensureMaterialized(e.runner(e.a), okId)).toMatchObject({ outcome: 'materialized' });
    for (const [name, target] of [['esc1', '../../etc/passwd'], ['dir/esc2', '../../x'], ['esc3', '/etc/passwd']] as const) {
      const bad = e.repoA.commit({ [name]: { symlink: target } });
      pushMain();
      const id = await allocate(e.a, bad);
      await expect(e.host.ensureMaterialized(e.runner(e.a), id)).rejects.toMatchObject({ code: 'escaping_symlink' });
      expect(existsSync(generationDir(e, e.a, id, 1))).toBe(false);
    }
    expect([['a', '../b'], ['d/a', '../../b'], ['a', '/x'], ['d/a', '../..']].map(([p, t]) => symlinkEscapes(p ?? '', t ?? ''))).toEqual([true, true, true, true]);
    expect([['a', 'b'], ['d/a', '../b'], ['d/e/a', '../../b']].map(([p, t]) => symlinkEscapes(p ?? '', t ?? ''))).toEqual([false, false, false]);
  });

  it('a clone URL named by the caller is refused; so is a registry URL that would be read as an option', async () => {
    const spec = specFor(e.a, await e.setupRef(e.a), e.repoA.base);
    for (const field of ['cloneUrl', 'url', 'remote']) {
      await expect(e.manager.allocateOrAttach(e.runner(e.a), randomUUID(), { ...spec, [field]: '/tmp/evil.git' })).rejects.toMatchObject({ code: 'caller_supplied_url' });
    }
    const optionLike = await tenantWith('--upload-pack=/bin/evil', '');
    await expect(allocate(optionLike, e.repoA.base)).rejects.toMatchObject({ code: 'invalid_clone_url' });
    await expect(e.manager.allocateOrAttach(e.runner(e.a), randomUUID(), { ...spec, repositoryId: randomUUID() })).rejects.toMatchObject({ code: 'repository_not_registered' });
    // The request the materializer gets always carries the registry's URL.
    const id = await allocate(e.a, e.repoA.base);
    expect(await e.manager.materializationRequest(e.runner(e.a), id, 1)).toMatchObject({ request: { cloneUrl: e.repoA.bare } });
  });

  it('a branch outside the task namespace is refused (control: one inside is accepted)', async () => {
    for (const branch of ['main', 'refs/heads/x', `factory/${randomUUID()}/x`, `factory/${e.a.taskId}/../x`, `factory/${e.a.taskId}/`, `factory/${e.a.taskId}/a b`, `factory/${e.a.taskId}/x.lock`, `factory/${e.a.taskId}/-x`]) {
      await expect(allocate(e.a, e.repoA.base, { branch })).rejects.toMatchObject({ code: 'branch_outside_namespace' });
    }
    await expect(allocate(e.a, e.repoA.base, { branch: `factory/${e.a.taskId}/feature-1.2_x` })).resolves.toBeTypeOf('string');
    expect(() => { assertTaskBranch(e.a.taskId, `factory/${e.a.taskId}/ok`); }).not.toThrow();
  });

  it('a workspace root inside any existing checkout is refused (control: a plain directory works)', async () => {
    const inCheckout = join(e.repoA.work, 'nested-root');
    mkdirSync(inCheckout);
    const target = { orgId: e.a.orgId, workspaceId: randomUUID(), generation: 1 };
    const req = { kind: 'remote' as const, target, taskId: e.a.taskId, cloneUrl: e.repoA.bare, commit: e.repoA.base, subpath: '' };
    expect(await new LocalMaterializer({ root: inCheckout, git: fileGit() }).materialize(req)).toMatchObject({ ok: false, code: 'root_inside_checkout' });
    expect(existsSync(join(inCheckout, target.orgId))).toBe(false);
    expect(await new LocalMaterializer({ root: e.root, git: fileGit() }).materialize(req)).toMatchObject({ ok: true });
  });
});

// ---- the strict symlink rule, chains, limits, collisions, checkout fidelity, roots
import { chmodSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { assertCloneUrl } from '../src/index.ts';
import { registerCandidate, treeDigestOf } from './harness.ts';

const MIB = 1024 * 1024;
// Each fixture commit starts from the repository's base commit (detached), so earlier fixtures' links never leak into later ones.
let fixtureCount = 0;
const commitFiles = (files: Parameters<typeof e.repoA.commit>[0]): string => {
  e.fx.git(e.repoA.work, ['checkout', '--quiet', '--detach', e.repoA.base]);
  const c = e.repoA.commit(files);
  e.fx.git(e.repoA.work, ['push', '--quiet', e.repoA.bare, `HEAD:refs/heads/fixture-${String(++fixtureCount)}`]);
  return c;
};

describe('symlinks: the strict rule', () => {
  // `a/b/up -> ../..` points at the root and `escape -> a/b/up/../../..` normalizes to `a`: both pass a
  // lexical check, and on disk the second climbs three levels above the worktree.
  const chains: Array<[string, Record<string, { symlink: string }>, Array<[string, string]>]> = [
    ['up/escape chain', { 'a/b/up': { symlink: '../..' }, escape: { symlink: 'a/b/up/../../..' } }, [['a/b/up', '../..'], ['escape', 'a/b/up/../../..']]],
    ['q/l chain', { 'a/b/q': { symlink: '..' }, 'a/b/l': { symlink: 'q/../..' } }, [['a/b/q', '..'], ['a/b/l', 'q/../..']]],
  ];

  it.each(chains)('positive control: the old lexical check passes every link of the %s', (_name, _files, links) => {
    for (const [path, target] of links) expect(symlinkEscapes(path, target), `${path} -> ${target}`).toBe(false);
  });

  it.each(chains)('the %s is refused on the remote path and on the bundle path', async (_name, files) => {
    const commit = commitFiles(files);
    const id = await allocate(e.a, commit);
    await expect(e.host.ensureMaterialized(e.runner(e.a), id)).rejects.toMatchObject({ code: 'escaping_symlink' });
    expect(existsSync(generationDir(e, e.a, id, 1))).toBe(false);

    const cand = await registerCandidate(e, e.a, e.repoA, treeDigestOf(e.fx, e.repoA.work, commit), e.a.stages.implementer);
    const [copy] = await e.manager.materializeCandidate(e.runner(e.a), cand.manifestRef, 'verifier', { stageRunId: e.a.stages.verifier, setupProfileRef: await e.setupRef(e.a) });
    await expect(e.host.ensureMaterialized(e.runner(e.a), copy?.id ?? '')).rejects.toMatchObject({ code: 'escaping_symlink' });
    expect(existsSync(generationDir(e, e.a, copy?.id ?? '', 1))).toBe(false);
  });

  it('a symlink that resolves through another symlink, or is itself another symlink, is refused even without `..`', async () => {
    for (const files of [{ sub: { symlink: 'dir' }, through: { symlink: 'sub/sibling.txt' } }, { first: { symlink: 'dir/sibling.txt' }, second: { symlink: 'first' } }]) {
      const id = await allocate(e.a, commitFiles(files));
      await expect(e.host.ensureMaterialized(e.runner(e.a), id)).rejects.toMatchObject({ code: 'escaping_symlink' });
    }
  });

  it('any `..` component, absolute and empty targets are refused (control: plain relative links below the link are fine)', async () => {
    const id = await allocate(e.a, commitFiles({ 'dir/dotdot': { symlink: '../README.md' } }));
    await expect(e.host.ensureMaterialized(e.runner(e.a), id)).rejects.toMatchObject({ code: 'escaping_symlink' }); // inside the root, still refused
    const fine = await allocate(e.a, commitFiles({ 'dir/dotdot': { symlink: 'sibling.txt' }, 'plain': { symlink: 'dir/sibling.txt' } }));
    expect(await e.host.ensureMaterialized(e.runner(e.a), fine)).toMatchObject({ outcome: 'materialized' });
  });
});

describe('resource limits on a candidate tree (refused from object headers, before any checkout)', () => {
  const pushWeird = (entries: Parameters<typeof e.fx.plumbingCommit>[0], name: string): string => {
    const p = e.fx.plumbingCommit(entries);
    e.fx.git(p.repo, ['push', '--quiet', e.repoA.bare, `main:refs/heads/${name}`]);
    return p.commit;
  };
  const refused = async (commit: string, name: string): Promise<number> => {
    const id = await allocate(e.a, commit, { branch: `factory/${e.a.taskId}/${name}` });
    const started = Date.now();
    await expect(e.host.ensureMaterialized(e.runner(e.a), id)).rejects.toMatchObject({ code: 'tree_too_large' });
    expect(existsSync(generationDir(e, e.a, id, 1))).toBe(false);
    expect(existsSync(join(e.root, e.a.orgId, id, '.staging-g1'))).toBe(false);
    return Date.now() - started;
  };

  it('many entries pointing at one large blob are refused quickly, counting repeats', async () => {
    const big = Buffer.alloc(31 * MIB); // under the per-blob limit, and it compresses to almost nothing
    const entries = Array.from({ length: 20 }, (_, i) => ({ mode: '100644', path: Buffer.from(`copy-${String(i)}`), content: big })); // 620 MiB expanded
    const ms = await refused(pushWeird(entries, 'repeats'), 'repeats');
    expect(ms).toBeLessThan(10_000);
  });

  it('one blob over the per-blob limit, and more entries than the limit, are refused', async () => {
    await refused(pushWeird([{ mode: '100644', path: Buffer.from('huge'), content: Buffer.alloc(33 * MIB) }], 'huge'), 'huge');
    const many = Array.from({ length: 50_001 }, (_, i) => ({ mode: '100644', path: Buffer.from(`f/${String(i)}`), content: Buffer.from('x') }));
    await refused(pushWeird(many, 'many'), 'many');
  });

  it('the limits are constants, and a small tree is fine (control)', async () => {
    expect(MATERIALIZE_LIMITS).toMatchObject({ maxEntries: 50_000, maxBlobBytes: 32 * MIB, maxTotalBytes: 512 * MIB, maxUniqueBytes: 256 * MIB, maxPathBytes: 4096, maxDepth: 256, maxTotalPathBytes: 8 * MIB, deadlineMs: 300_000 });
    const id = await allocate(e.a, commitFiles({ 'small.txt': 'ok' }));
    expect(await e.host.ensureMaterialized(e.runner(e.a), id)).toMatchObject({ outcome: 'materialized' });
  });

  it('a materialization past its wall-clock deadline is refused and leaves nothing', async () => {
    const slow = e.newManager({ limits: { deadlineMs: 1 } });
    const id = await allocate(e.a, e.repoA.base);
    await expect(slow.host.ensureMaterialized(e.runner(e.a), id)).rejects.toMatchObject({ code: 'git_failed' });
    expect(readdirSync(join(e.root, e.a.orgId, id)).filter((n) => !n.startsWith('.'))).toEqual([]);
  });
});

describe('case folding, checkout fidelity and the workspace root', () => {
  it('trees whose paths collide after case folding or NFC are refused when folding is on (control: a clean tree passes)', async () => {
    const folding = e.newManager({ foldPaths: true });
    const push = (entries: Parameters<typeof e.fx.plumbingCommit>[0], name: string): string => { const p = e.fx.plumbingCommit(entries); e.fx.git(p.repo, ['push', '--quiet', e.repoA.bare, `main:refs/heads/${name}`]); return p.commit; };
    const f = (path: string, content: string) => ({ mode: '100644', path: Buffer.from(path, 'utf8'), content: Buffer.from(content) });
    for (const [name, entries] of [
      ['fold1', [f('README.md', 'a'), f('readme.md', 'b')]],
      ['fold2', [f('café.txt', 'a'), f('café.txt', 'b')]],
      ['fold3', [f('Dir/x', 'a'), f('dir/y', 'b')]],
    ] as const) {
      const id = await allocate(e.a, push([...entries], name), { branch: `factory/${e.a.taskId}/${name}` });
      await expect(folding.host.ensureMaterialized(e.runner(e.a), id)).rejects.toMatchObject({ code: 'path_collision' });
    }
    const ok = await allocate(e.a, push([f('A.md', 'a'), f('b/c.md', 'b'), f('b/d.md', 'c')], 'fold-ok'), { branch: `factory/${e.a.taskId}/fold-ok` });
    expect(await folding.host.ensureMaterialized(e.runner(e.a), ok)).toMatchObject({ outcome: 'materialized' });
  });

  it('in-tree attributes that rewrite files at checkout (eol, ident) do not change the bytes on disk', async () => {
    const commit = commitFiles({ '.gitattributes': '* text eol=crlf\n*.id ident\n', 'lines.txt': 'one\ntwo\n', 'tag.id': '$Id$\n' });
    // Control: a plain clone and checkout rewrites them.
    const plain = join(e.fx.dir('plain-crlf'), 'c');
    e.fx.git(e.fx.base, ['clone', '--quiet', '--no-local', e.repoA.bare, plain]);
    e.fx.git(plain, ['checkout', '--quiet', commit]);
    expect(readFileSync(join(plain, 'lines.txt'), 'utf8')).toBe('one\r\ntwo\r\n');
    expect(readFileSync(join(plain, 'tag.id'), 'utf8')).not.toBe('$Id$\n');
    // The factory's checkout writes exactly the digested bytes.
    const id = await allocate(e.a, commit);
    expect(await e.host.ensureMaterialized(e.runner(e.a), id)).toMatchObject({ outcome: 'materialized', receipt: { treeDigest: treeDigestOf(e.fx, e.repoA.work, commit) } });
    const work = join(generationDir(e, e.a, id, 1), 'work/main');
    expect(readFileSync(join(work, 'lines.txt'), 'utf8')).toBe('one\ntwo\n');
    expect(readFileSync(join(work, 'tag.id'), 'utf8')).toBe('$Id$\n');
    // And the re-hash is the guarantee: a file that differs from its digested bytes fails it.
    const entries = [{ path: 'lines.txt', sha256: createHash('sha256').update('one\ntwo\n').digest('hex'), mode: '100644', kind: 'file' as const }];
    expect(() => { verifyCheckout(work, entries); }).not.toThrow();
    writeFileSync(join(work, 'lines.txt'), 'one\r\ntwo\r\n');
    expect(() => { verifyCheckout(work, entries); }).toThrow(expect.objectContaining({ code: 'tree_digest_mismatch' }) as Error);
  });

  it('a workspace root that is group-writable, or whose child is a symlink, is refused; remove refuses a symlinked component', async () => {
    const target = { orgId: e.a.orgId, workspaceId: randomUUID(), generation: 1 };
    const req = { kind: 'remote' as const, target, taskId: e.a.taskId, cloneUrl: e.repoA.bare, commit: e.repoA.base, subpath: '' };
    const open = e.fx.dir('open-root');
    chmodSync(open, 0o775);
    expect(await new LocalMaterializer({ root: open, git: fileGit() }).materialize(req)).toMatchObject({ ok: false, code: 'unsafe_root' });
    chmodSync(open, 0o755);
    expect(await new LocalMaterializer({ root: open, git: fileGit() }).materialize(req)).toMatchObject({ ok: true }); // control

    const root = e.fx.dir('link-root');
    const outside = e.fx.dir('outside');
    symlinkSync(outside, join(root, e.a.orgId));
    const m = new LocalMaterializer({ root, git: fileGit() });
    expect(await m.materialize(req)).toMatchObject({ ok: false, code: 'unsafe_root' });
    expect(readdirSync(outside)).toEqual([]);
    expect(await m.remove(target)).toMatchObject({ absent: false });
    rmSync(join(root, e.a.orgId));
  });

  it('a registry URL carrying credentials, `::` helper syntax or an option-like host is refused; a bare ssh username is allowed', () => {
    for (const bad of ['https://user:pw@host/r.git', 'https://token@host/r.git', 'ssh://git:pw@host/r.git', 'ssh://git:@host/r.git', 'ssh://-oProxyCommand=x/r.git', 'git@-oProxyCommand=x:o/r.git', 'git:pw@host:o/r.git', 'ext::sh -c evil', 'a::b', '--upload-pack=x', '', 'https://host/a b']) {
      expect(() => { assertCloneUrl(bad); }, bad).toThrow(expect.objectContaining({ code: 'invalid_clone_url' }) as Error);
    }
    // A bare username on ssh or scp-style carries no secret and is allowed.
    for (const good of ['https://host/r.git', '/srv/git/r.git', 'file:///srv/git/r.git', 'ssh://host/r.git', 'ssh://git@host/org/r.git', 'git@host:org/r.git', 'git@github.com:org/r.git']) expect(() => { assertCloneUrl(good); }).not.toThrow();
  });
});

describe('pathological trees are refused or cheap (every per-entry check is linear in the capped tree)', () => {
  const f = (path: string, content: string | Buffer) => ({ mode: '100644', path: Buffer.from(path, 'utf8'), content: Buffer.isBuffer(content) ? content : Buffer.from(content) });
  const pushTree = (entries: Parameters<typeof e.fx.plumbingCommit>[0], name: string): string => {
    const p = e.fx.plumbingCommit(entries);
    e.fx.git(p.repo, ['push', '--quiet', e.repoA.bare, `main:refs/heads/${name}`]);
    return p.commit;
  };
  const refusedFast = async (commit: string, name: string, code: string, host = e.host): Promise<void> => {
    const id = await allocate(e.a, commit, { branch: `factory/${e.a.taskId}/${name}` });
    const started = Date.now();
    await expect(host.ensureMaterialized(e.runner(e.a), id)).rejects.toMatchObject({ code });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(existsSync(generationDir(e, e.a, id, 1))).toBe(false);
  };

  it('a symlink with a ~1 MB target (it fits in a tiny bundle) is refused well under a second of checking', async () => {
    const target = 'a/'.repeat(500_000);
    await refusedFast(pushTree([{ mode: '120000', path: Buffer.from('long'), content: Buffer.from(target) }], 'longlink'), 'longlink', 'escaping_symlink');
    // The check itself, in isolation.
    const started = Date.now();
    expect(() => { assertSymlinksContained([{ path: 'long', kind: 'symlink', symlinkTarget: target }]); }).toThrow(expect.objectContaining({ code: 'escaping_symlink' }) as Error);
    expect(Date.now() - started).toBeLessThan(500);
    // Too many components, under the byte cap.
    expect(() => { assertSymlinksContained([{ path: 'l', kind: 'symlink', symlinkTarget: Array.from({ length: 129 }, () => 'a').join('/') }]); }).toThrow(expect.objectContaining({ code: 'escaping_symlink' }) as Error);
    expect(() => { assertSymlinksContained([{ path: 'l', kind: 'symlink', symlinkTarget: Array.from({ length: 128 }, () => 'a').join('/') }]); }).not.toThrow(); // control: at the limit is fine
  });

  it('800 nested directories with thousands of empty files is refused by the depth cap, with folding on', async () => {
    const dir = 'a/'.repeat(800);
    const entries = Array.from({ length: 3_000 }, (_, i) => f(`${dir}f${String(i)}`, ''));
    await refusedFast(pushTree(entries, 'deep'), 'deep', 'tree_too_large', e.newManager({ foldPaths: true }).host);
    const long = Array.from({ length: 10 }, (_, i) => f(`${'abcdefghijklmnopqrst/'.repeat(250)}${String(i)}`, ''));
    await refusedFast(pushTree(long, 'longpath'), 'longpath', 'tree_too_large', e.newManager({ foldPaths: true }).host);
  });

  it('the work is linear in the tree: capped-size inputs to every per-entry check finish in a few seconds in total', () => {
    const started = Date.now();
    // 60,000 entries at depth 120 (about 250 bytes each, past the byte cap that readTree enforces, so this is harsher than real): the collision check, the digest entries and the symlink check.
    const dir = Array.from({ length: 120 }, (_, i) => `d${String(i % 7)}`).join('/');
    const names = Array.from({ length: 60_000 }, (_, i) => `${dir}/file${String(i)}`);
    assertNoFoldedCollisions(names);
    const links = names.slice(0, 20_000).map((p) => ({ path: p, kind: 'symlink', symlinkTarget: Array.from({ length: 100 }, (_, i) => `s${String(i)}`).join('/') }));
    assertSymlinksContained(links);
    const blob = Buffer.from('shared');
    const items = names.map((p) => ({ pathBytes: Buffer.from(p), mode: '100644', blob }));
    expect(treeEntries(items)).toHaveLength(60_000);
    expect(Date.now() - started).toBeLessThan(6_000);
    // Unicode: sigma and final sigma, NFC and NFD, and plain case are all the same name.
    expect(() => { assertNoFoldedCollisions(['\u03C3', '\u03C2']); }).toThrow(expect.objectContaining({ code: 'path_collision' }) as Error);
    expect(() => { assertNoFoldedCollisions(['caf\u00e9', 'cafe\u0301']); }).toThrow(expect.objectContaining({ code: 'path_collision' }) as Error);
    expect(() => { assertNoFoldedCollisions(['a/B', 'A/c']); }).toThrow(expect.objectContaining({ code: 'path_collision' }) as Error);
    expect(() => { assertNoFoldedCollisions(['a/B', 'a/b']); }).toThrow(expect.objectContaining({ code: 'path_collision' }) as Error);
    expect(() => { assertNoFoldedCollisions(['a/B', 'a/c', 'b/B']); }).not.toThrow();
  }, 30_000);
});
