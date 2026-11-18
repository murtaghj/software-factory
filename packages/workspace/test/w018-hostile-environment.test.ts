// The parent process sets GIT_DIR, GIT_ALTERNATE_OBJECT_DIRECTORIES, GIT_CONFIG_GLOBAL, GIT_CONFIG_COUNT
// (with its key and value), GIT_CONFIG_PARAMETERS, GIT_EXEC_PATH, XDG_CONFIG_HOME and HOME, each pointing
// at something that would redirect objects or run a program. Materialize and publish are unaffected.
//
// The canaries are ones the factory's own hardening flags do not override (hooksPath, fsmonitor and
// the like are forced off on every call, which would hide a leak): a `url.<decoy>.insteadOf` rewrite
// that sends the clone to a decoy repository, a fake git-upload-pack on GIT_EXEC_PATH, a commit
// visible only through an alternate object store, and GIT_DIR. The positive control runs the SAME
// materializer with a deliberately leaky environment (GitRunner's test-only unsafeEnvironment).
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalMaterializer, createPublisher, type MaterializeRequest } from '../src/index.ts';
import { gitEnvironment } from '../src/git.ts';
import { checkpointedWorkspace, createEnv, fileGit, registerCandidate, snapshotTree, specFor, treeDigestOf, type Env, type Repo } from './harness.ts';

let e: Env;
let decoy: Repo;
let evil: Repo;
const saved = new Map<string, string | undefined>();
const hostile: Record<string, string> = {};
let execCanary = '';
let decoyGitDir = '';

const insteadOf = (): string => `[url "${decoy.bare}"]\n\tinsteadOf = ${e.repoA.bare}\n`;

// A materialization request for repoA's base commit, from a fresh root so every run starts clean.
async function materializeWith(git: ReturnType<typeof fileGit>): Promise<{ ok: boolean; code?: string; readme?: string }> {
  const root = e.fx.dir('root');
  const m = new LocalMaterializer({ root, git, foldPaths: false });
  const target = { orgId: e.a.orgId, workspaceId: randomUUID(), generation: 1 };
  const req: MaterializeRequest = { kind: 'remote', target, taskId: e.a.taskId, cloneUrl: e.repoA.bare, commit: e.repoA.base, subpath: '' };
  const r = await m.materialize(req);
  if (!r.ok) return { ok: false, code: r.code };
  return { ok: true, readme: e.fx.git(join(root, target.orgId, target.workspaceId, 'g1', 'work/main'), ['show', 'HEAD:README.md']) };
}

beforeAll(async () => {
  e = await createEnv('w018_hostile');
  decoy = e.fx.makeRepo({ 'README.md': 'DECOY CONTENT\n' }); // different commit ids from repoA
  evil = e.fx.makeRepo({ 'evil.txt': 'only the alternate store has this commit\n' });
  const dir = (n: string): string => e.fx.dir(n);

  const globalFile = join(dir('cfg'), 'gitconfig'); writeFileSync(globalFile, insteadOf());
  const xdg = dir('xdg'); mkdirSync(join(xdg, 'git')); writeFileSync(join(xdg, 'git', 'config'), insteadOf());
  const home = dir('hostile-home'); writeFileSync(join(home, '.gitconfig'), insteadOf());
  const execPath = dir('execpath');
  execCanary = join(dir('canary'), 'exec-path');
  for (const helper of ['git-upload-pack', 'git-receive-pack', 'git-remote-file']) {
    writeFileSync(join(execPath, helper), `#!/bin/sh\necho "${helper}" >> "${execCanary}"\nexit 1\n`);
    chmodSync(join(execPath, helper), 0o755);
  }
  decoyGitDir = join(dir('decoy'), 'decoy.git');
  e.fx.git(e.fx.base, ['init', '--quiet', '--bare', decoyGitDir]);

  Object.assign(hostile, {
    GIT_CONFIG_GLOBAL: globalFile,
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${decoy.bare}.insteadOf`, GIT_CONFIG_VALUE_0: e.repoA.bare,
    GIT_CONFIG_PARAMETERS: `'url.${decoy.bare}.insteadof'='${e.repoA.bare}'`,
    XDG_CONFIG_HOME: xdg, HOME: home, GIT_EXEC_PATH: execPath,
    GIT_DIR: decoyGitDir, GIT_ALTERNATE_OBJECT_DIRECTORIES: join(evil.bare, 'objects'),
    GIT_WORK_TREE: dir('decoy-worktree'), GIT_INDEX_FILE: join(dir('decoy-index'), 'index'), GIT_OBJECT_DIRECTORY: join(decoyGitDir, 'objects'),
  });
});
afterAll(async () => {
  for (const [k, v] of saved) { if (v === undefined) Reflect.deleteProperty(process.env, k); else process.env[k] = v; }
  await e.close();
});

describe('hostile parent environment', () => {
  it('positive controls: the same materializer, deliberately leaky, is redirected or broken by each variable', async () => {
    expect(await materializeWith(fileGit())).toMatchObject({ ok: true, readme: 'hello\n' }); // baseline
    const leaky = (change: (env: Record<string, string>) => Record<string, string>) => fileGit({ unsafeEnvironment: (base) => change({ ...base }) });
    const cases: Array<[string, (env: Record<string, string>) => Record<string, string>]> = [
      ['GIT_CONFIG_GLOBAL', (env) => ({ ...env, GIT_CONFIG_GLOBAL: hostile['GIT_CONFIG_GLOBAL'] ?? '' })],
      ['GIT_CONFIG_COUNT', (env) => ({ ...env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: hostile['GIT_CONFIG_KEY_0'] ?? '', GIT_CONFIG_VALUE_0: hostile['GIT_CONFIG_VALUE_0'] ?? '' })],
      ['GIT_CONFIG_PARAMETERS', (env) => ({ ...env, GIT_CONFIG_PARAMETERS: hostile['GIT_CONFIG_PARAMETERS'] ?? '' })],
      ['XDG_CONFIG_HOME', (env) => { const rest = { ...env }; Reflect.deleteProperty(rest, 'GIT_CONFIG_GLOBAL'); return { ...rest, XDG_CONFIG_HOME: hostile['XDG_CONFIG_HOME'] ?? '' }; }],
      ['HOME', (env) => { const rest = { ...env }; Reflect.deleteProperty(rest, 'GIT_CONFIG_GLOBAL'); return { ...rest, HOME: hostile['HOME'] ?? '' }; }],
    ];
    for (const [name, change] of cases) {
      const r = await materializeWith(leaky(change));
      // The rewrite sends the clone to the decoy, which lacks the commit.
      expect(r, `${name} should redirect the clone to the decoy`).toEqual({ ok: false, code: 'commit_not_found' });
    }
    // GIT_EXEC_PATH: a fake git-upload-pack runs.
    await materializeWith(leaky((env) => ({ ...env, GIT_EXEC_PATH: hostile['GIT_EXEC_PATH'] ?? '' })));
    expect(existsSync(execCanary)).toBe(true);
    // GIT_ALTERNATE_OBJECT_DIRECTORIES: a commit that exists only in the alternate store is "found".
    const alt = new LocalMaterializer({ root: e.fx.dir('root'), git: leaky((env) => ({ ...env, GIT_ALTERNATE_OBJECT_DIRECTORIES: hostile['GIT_ALTERNATE_OBJECT_DIRECTORIES'] ?? '' })), foldPaths: false });
    const altReq: MaterializeRequest = { kind: 'remote', target: { orgId: e.a.orgId, workspaceId: randomUUID(), generation: 1 }, taskId: e.a.taskId, cloneUrl: e.repoA.bare, commit: evil.base, subpath: '' };
    expect((await alt.materialize(altReq)).ok).toBe(true);
    // GIT_DIR: Git works on the decoy instead of the clone.
    const before = snapshotTree(decoyGitDir);
    const viaDir = await materializeWith(leaky((env) => ({ ...env, GIT_DIR: decoyGitDir })));
    expect(viaDir).toEqual({ ok: false, code: 'commit_not_found' }); // Git worked on the (empty) decoy GIT_DIR, which lacks the commit
    expect(snapshotTree(decoyGitDir)).toBe(before);
    rmCanary();
  });

  it('the Git environment is built from nothing: fixed keys, no inherited variable', () => {
    for (const [k, v] of Object.entries(hostile)) { saved.set(k, process.env[k]); process.env[k] = v; }
    saved.set('GIT_SSH_COMMAND', process.env['GIT_SSH_COMMAND']); process.env['GIT_SSH_COMMAND'] = 'echo ssh';
    const env = gitEnvironment();
    expect(Object.keys(env).sort()).toEqual(['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_SYSTEM', 'GIT_OPTIONAL_LOCKS', 'GIT_PAGER', 'GIT_TERMINAL_PROMPT', 'HOME', 'LC_ALL', 'PATH']);
    expect(env['GIT_CONFIG_GLOBAL']).toBe('/dev/null');
    expect(env['HOME']).not.toBe(hostile['HOME']);
    expect(env['PATH']).toBe('/usr/bin:/bin');
  });

  it('with every hostile variable set, materialize (remote and bundle) and publish are unaffected and nothing is redirected', async () => {
    for (const [k, v] of Object.entries(hostile)) { if (!saved.has(k)) saved.set(k, process.env[k]); process.env[k] = v; }
    const decoyBefore = snapshotTree(decoyGitDir);
    const decoyRepoBefore = snapshotTree(decoy.bare);

    expect(await materializeWith(fileGit())).toMatchObject({ ok: true, readme: 'hello\n' }); // not the decoy's content
    const w = await checkpointedWorkspace(e, e.a, e.repoA, 'hostile1');
    const digest = treeDigestOf(e.fx, e.repoA.work, w.commit);
    const cand = await registerCandidate(e, e.a, e.repoA, digest, e.a.stages.implementer);
    const [copy] = await e.manager.materializeCandidate(e.runner(e.a), cand.manifestRef, 'verifier', { stageRunId: e.a.stages.verifier, setupProfileRef: await e.setupRef(e.a) });
    expect(await e.host.ensureMaterialized(e.runner(e.a), copy?.id ?? '')).toMatchObject({ outcome: 'materialized', receipt: { headCommit: w.commit, treeDigest: digest } });
    const pub = createPublisher({ db: e.db, artifacts: e.artifacts, publisherIdentity: 'service:git-publisher', scratchRoot: e.scratch, git: fileGit() });
    expect(await pub.compareAndUpdateRef(e.publisher(e.a), { workspaceId: w.id, expectedEpoch: 1, expectedHead: null, sourceRef: w.sourceRef })).toEqual({ outcome: 'updated', head: w.commit });
    expect(e.repoA.remoteRef(`refs/heads/${w.branch}`)).toBe(w.commit); // the push went to the real remote, not the decoy

    expect(existsSync(execCanary)).toBe(false);
    expect(snapshotTree(decoyGitDir)).toBe(decoyBefore);
    expect(snapshotTree(decoy.bare)).toBe(decoyRepoBefore);
  });

  it('a commit that exists only in a hostile alternate object store is not found', async () => {
    for (const [k, v] of Object.entries(hostile)) { if (!saved.has(k)) saved.set(k, process.env[k]); process.env[k] = v; }
    const id = randomUUID();
    await e.manager.allocateOrAttach(e.runner(e.a), id, specFor(e.a, await e.setupRef(e.a), evil.base, { branch: `factory/${e.a.taskId}/alt` }));
    await expect(e.host.ensureMaterialized(e.runner(e.a), id)).rejects.toMatchObject({ code: 'commit_not_found' });
    expect(existsSync(execCanary)).toBe(false);
  });
});

function rmCanary(): void { rmSync(execCanary, { force: true }); }
