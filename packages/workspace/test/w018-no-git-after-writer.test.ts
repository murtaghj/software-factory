// The Git rule: trusted code runs Git only on a repository the factory created and no candidate
// process has ever been able to write. Once a writer has started, the only trusted action on that
// directory is deleting it whole. Reading candidate state is the job of W-020's reader.
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, appendFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPublisher } from '../src/index.ts';
import { fileGit, checkpointedWorkspace, createEnv, generationDir, specFor, type Env } from './harness.ts';

let e: Env;
let canary = '';
beforeAll(async () => { e = await createEnv('w018_nogit'); canary = join(e.fx.dir('canary'), 'ran'); });
afterAll(async () => { await e.close(); });

const ran = (): string => (existsSync(canary) ? readFileSync(canary, 'utf8') : '');
const script = (dir: string, name: string, body = 'cat'): string => {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\necho "${name} ran" >> "${canary}"\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
};

// What a hostile candidate leaves behind in its own .git: config, attributes and hooks that run programs.
function plant(generation: string): void {
  const progs = e.fx.dir('programs');
  const gitDir = join(generation, 'git/.git');
  appendFileSync(join(gitDir, 'config'), `\n[core]\n\tfsmonitor = ${script(progs, 'fsmonitor', 'exit 0')}\n`
    + `[filter "canary"]\n\tclean = ${script(progs, 'clean')}\n\tsmudge = ${script(progs, 'smudge')}\n\trequired = false\n`
    + `[diff "canary"]\n\ttextconv = ${script(progs, 'textconv', 'cat "$1"')}\n`
    + `[alias]\n\tstatus = !${script(progs, 'alias', 'true')}\n`);
  mkdirSync(join(gitDir, 'info'), { recursive: true });
  writeFileSync(join(gitDir, 'info/attributes'), '* filter=canary diff=canary\n');
  writeFileSync(join(generation, 'work/main/.gitattributes'), '* filter=canary diff=canary\n');
  for (const hook of ['post-checkout', 'reference-transaction', 'pre-push', 'pre-commit', 'post-merge', 'post-commit']) script(join(gitDir, 'hooks'), hook, 'exit 0');
}

describe('no Git on a candidate-writable directory', () => {
  it('controls: the planted fixtures fire when Git is run directly in the repository', async () => {
    const w = await checkpointedWorkspace(e, e.a, e.repoA, 'control');
    const g = generationDir(e, e.a, w.id, 1);
    plant(g);
    expect(ran()).toBe('');
    e.fx.git(join(g, 'work/main'), ['status', '--porcelain']);
    expect(ran()).toContain('fsmonitor ran');
    writeFileSync(join(g, 'work/main/README.md'), 'modified by the candidate\n');
    e.fx.git(join(g, 'work/main'), ['diff']);
    expect(ran()).toContain('textconv ran');
    e.fx.gitPlain(join(g, 'work/main'), ['commit', '--quiet', '-am', 'hostile']);
    expect(ran()).toMatch(/pre-commit ran|reference-transaction ran/);
    rmSync(canary, { force: true });
  });

  it('attach, replaceWriter, release and a publish from the bundle all complete and no canary appears', async () => {
    // The bundle is built first, then the generation is marked active, then it is planted.
    const w = await checkpointedWorkspace(e, e.a, e.repoA, 'planted', { accepted: true }); // active -> checkpointed with a frozen commit; bundle already an artifact
    const g1 = generationDir(e, e.a, w.id, 1);
    plant(g1);
    rmSync(canary, { force: true });
    const hostileCandidateFile = join(g1, 'work/main/hostile.txt');
    writeFileSync(hostileCandidateFile, 'candidate-written');

    // Attach.
    expect(await e.manager.allocateOrAttach(e.runner(e.a), w.id, w.spec)).toMatchObject({ id: w.id, state: 'checkpointed' });
    expect(await e.manager.materializationRequest(e.runner(e.a), w.id, 1)).toEqual({ ok: false, code: 'not_materializable' });
    expect(await e.host.ensureMaterialized(e.runner(e.a), w.id)).toEqual({ outcome: 'unchanged', reason: 'not_materializable' });

    // Publish from the bundle, not from the directory.
    const pub = createPublisher({ db: e.db, artifacts: e.artifacts, publisherIdentity: 'service:git-publisher', scratchRoot: e.scratch, git: fileGit() });
    expect(await pub.compareAndUpdateRef(e.publisher(e.a), { workspaceId: w.id, expectedEpoch: 1, expectedHead: null, sourceRef: w.sourceRef })).toEqual({ outcome: 'updated', head: w.commit });
    expect(ran()).toBe('');

    // Release: the whole directory is deleted by its exact path, without Git and without following links.
    expect(await e.manager.release(e.runner(e.a), w.id, 1)).toEqual({ state: 'released' });
    expect(existsSync(g1)).toBe(false);
    expect(ran()).toBe('');

    // replaceWriter on a second planted, still-active workspace; its directory is left exactly as it was.
    const live = randomUUID();
    await e.manager.allocateOrAttach(e.runner(e.a), live, specFor(e.a, await e.setupRef(e.a), e.repoA.base, { branch: `factory/${e.a.taskId}/planted2` }));
    await e.host.ensureMaterialized(e.runner(e.a), live);
    await e.manager.markWriterStarted(e.runner(e.a), live, 1, 'pod-live');
    const lg1 = generationDir(e, e.a, live, 1);
    plant(lg1);
    rmSync(canary, { force: true });
    expect(await e.manager.replaceWriter(e.runner(e.a), live, 1)).toMatchObject({ generation: 2, next: 'materialize' });
    expect(await e.host.ensureMaterialized(e.runner(e.a), live)).toMatchObject({ outcome: 'materialized' });
    expect(existsSync(lg1)).toBe(true); // g1 is only fenced, never reclaimed here
    expect(readdirSync(join(lg1, 'git/.git/hooks')).includes('post-checkout')).toBe(true);
    // A planted generation that is later released is deleted whole.
    plant(generationDir(e, e.a, live, 2));
    rmSync(canary, { force: true });
    expect(await e.manager.release(e.runner(e.a), live, 2)).toEqual({ state: 'released' });
    expect(existsSync(generationDir(e, e.a, live, 2))).toBe(false);
    expect(ran()).toBe('');
  });

  it('release deletes by exact path without following symlinks the candidate planted', async () => {
    const w = await checkpointedWorkspace(e, e.a, e.repoA, 'symlinks', { accepted: true });
    const g1 = generationDir(e, e.a, w.id, 1);
    const outside = e.fx.dir('outside');
    writeFileSync(join(outside, 'precious.txt'), 'must survive');
    symlinkSync(outside, join(g1, 'work/main/escape-dir'));
    symlinkSync(join(outside, 'precious.txt'), join(g1, 'escape-file'));
    expect(await e.manager.release(e.runner(e.a), w.id, 1)).toEqual({ state: 'released' });
    expect(existsSync(g1)).toBe(false);
    expect(readFileSync(join(outside, 'precious.txt'), 'utf8')).toBe('must survive');
  });

  it('structurally: only git.ts runs a program, the Git handle is minted only by the materializer and the publisher, and nothing removes a worktree', () => {
    const src = join(import.meta.dirname, '../src');
    const files = readdirSync(src).filter((f) => f.endsWith('.ts'));
    const read = (f: string): string => readFileSync(join(src, f), 'utf8');
    expect(files.filter((f) => /node:child_process/.test(read(f)))).toEqual(['git.ts']);
    expect(files.filter((f) => /claimFactoryOwned/.test(read(f))).sort()).toEqual(['git.ts', 'materializer.ts', 'publish.ts']);
    expect(files.filter((f) => /['"]worktree['"],\s*['"](remove|prune)['"]/.test(read(f)))).toEqual([]);
    expect(files.filter((f) => /from '\.\/git\.ts'/.test(read(f)) && !['materializer.ts', 'publish.ts', 'index.ts'].includes(f))).toEqual([]);
    expect(read('index.ts').split('\n').filter((l) => !l.startsWith('//')).join('\n')).not.toMatch(/claimFactoryOwned|FactoryOwnedRepo/);
  });
});
