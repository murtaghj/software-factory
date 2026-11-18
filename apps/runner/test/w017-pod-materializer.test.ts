// The pod executor (17b): the real entry under the fake kubelet, real Git against a fixture repository, a temporary
// directory as the volume. The init step clones, the receipt is accepted, the permit follows, the workspace is active.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalJson } from '@factory/domain';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { assertRemoteAllowed, MAX_REQUEST_BYTES, parseMaterializeStatus, parseRequest, PodVolumeMaterializer, runMaterialize, tokenAudience, type KubePod } from '../src/index.ts';
import { FakeKube, FakeKubelet } from '../src/testing.ts';
import { createEnv, hex, until, type Env, type Instance, type Stage } from './harness.ts';

const SRC = join(import.meta.dirname, '..', 'src', 'pod');
const PROD_ENTRY = join(SRC, 'materialize-entry.ts');
const TEST_ENTRY = join(import.meta.dirname, 'pod', 'materialize-test-entry.ts');
const IMAGE = 'factory-materializer-test:local';

let e: Env;
let base: string;
let repo: string;       // the fixture's bare repository
let commit: string;     // its one commit
const kubelets: FakeKubelet[] = [];
const gated: number[] = []; // Git stand-ins that a failed test could leave sleeping

// A deterministic fixture on the host's own Git; the pod's Git reads it over file://.
function makeFixture(dir: string): string {
  const work = join(dir, 'work');
  const env = { PATH: process.env['PATH'] ?? '', HOME: dir, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'f', GIT_AUTHOR_EMAIL: 'f@example.test', GIT_COMMITTER_NAME: 'f', GIT_COMMITTER_EMAIL: 'f@example.test', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };
  const git = (...a: string[]): string => execFileSync('git', a, { cwd: dir, env, encoding: 'utf8' }).trim();
  mkdirSync(work);
  git('init', '-q', '--initial-branch=main', work);
  writeFileSync(join(work, 'README.md'), 'fixture\n');
  mkdirSync(join(work, 'src'));
  writeFileSync(join(work, 'src', 'a.ts'), 'export const a = 1;\n');
  git('-C', work, 'add', '-A');
  git('-C', work, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fixture');
  const head = git('-C', work, 'rev-parse', 'HEAD');
  git('clone', '-q', '--bare', work, join(dir, 'repo.git'));
  return head;
}

beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), 'w017-pod-'));
  commit = makeFixture(base);
  repo = join(base, 'repo.git');
  e = await createEnv('w017_pod', { cloneUrl: `file://${repo}` });
});
afterEach(async () => {
  for (const k of kubelets.splice(0)) await k.close();
  for (const pid of gated.splice(0)) { try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ } } // process groups are checked at teardown
});
afterAll(async () => { await e.close(); rmSync(base, { recursive: true, force: true }); });

// An instance whose cluster runs the real test entry as the `materialize` init container; the volume is a fresh temporary directory.
function podRunner(o: { gitBinary?: string } = {}): { inst: Instance; kubelet: FakeKubelet; volume: string } {
  const volume = mkdtempSync(join(base, 'vol-'));
  const inst = e.newRunner({ config: { images: { supervisor: 'factory-stub:local', harness: 'factory-stub:local', materializer: IMAGE } } });
  const kubelet = new FakeKubelet(inst.kube, { graceMs: 600 });
  kubelet.register(IMAGE, (c) => ({ command: process.execPath, args: [TEST_ENTRY, ...(c.args ?? [])], env: { FACTORY_TEST_VOLUME: volume, ...(o.gitBinary ? { FACTORY_TEST_GIT_BINARY: o.gitBinary } : {}) }, waitForReady: false }));
  kubelets.push(kubelet);
  return { inst, kubelet, volume };
}
const start = (inst: Instance, s: Stage, workspaceId: string) => inst.runner.startOrAttach(e.ctx(e.a), e.input(e.a, s, { workspaceId }), hex('e'));
const podOf = (inst: Instance, jobName: string): KubePod | undefined => inst.kube.driver.podsOf(jobName)[0];
const initDone = (p: KubePod | undefined): boolean => p?.status.initContainerStatuses?.[0]?.state.terminated !== undefined;
const settle = async (inst: Instance, id: string): Promise<void> => {
  await until(`allocation ${id} terminated`, async () => { await inst.runner.reconcileOne(e.a.orgId, id, 2000); return (await e.allocation(e.a, id)).state === 'terminated'; }, 20_000);
};
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; } };

describe('W-017 pod materializer: the real entry under the fake kubelet', () => {
  it('the init step clones, the receipt is accepted, the permit follows, and the workspace is active', async () => {
    const { inst, volume } = podRunner();
    const s = await e.newStage(e.a);
    const ws = await e.newWorkspace(e.a, s, inst, { baseCommit: commit });
    await start(inst, s, ws);
    const a = (await e.allocations(e.a, s))[0] as NonNullable<Awaited<ReturnType<typeof e.allocations>>[number]>;
    await until('the init step finished', () => initDone(podOf(inst, a.jobName)));
    const pod = podOf(inst, a.jobName) as KubePod;
    const status = parseMaterializeStatus(pod);
    expect(status).toMatchObject({ kind: 'receipt', receipt: { generation: 1, headCommit: commit } });
    // The files are where the entry puts them: <volume>/factory/<org>/<workspace>/g1/work/main, root mode 0700.
    const checkout = join(volume, 'factory', e.a.orgId, ws, 'g1', 'work', 'main');
    expect(readFileSync(join(checkout, 'README.md'), 'utf8')).toBe('fixture\n');
    await until('the pod runs', () => podOf(inst, a.jobName)?.status.phase === 'Running');
    await inst.runner.reconcileOne(e.a.orgId, a.id, 2000); // the receipt goes to acceptMaterialization
    expect((await e.allocation(e.a, a.id)).state).toBe('starting');
    const token = inst.kube.mintToken(pod, tokenAudience(e.a.orgId, a.id));
    expect(await inst.runner.acquireStartPermit({ token, orgId: e.a.orgId, allocationId: a.id, epoch: a.ownerEpoch })).toMatchObject({ granted: true });
    expect(await e.workspace(e.a, ws)).toMatchObject({ state: 'active', ownerPodUid: pod.metadata.uid });
    expect((await e.allocation(e.a, a.id)).state).toBe('running');
  });

  it('a missing commit gives a refusal with a non-zero exit, then stopping and terminated; the workspace is still allocated and no permit is granted', async () => {
    const { inst } = podRunner();
    const s = await e.newStage(e.a);
    const ws = await e.newWorkspace(e.a, s, inst, { baseCommit: 'd'.repeat(40) });
    await start(inst, s, ws);
    const a = (await e.allocations(e.a, s))[0] as NonNullable<Awaited<ReturnType<typeof e.allocations>>[number]>;
    await until('the init step finished', () => initDone(podOf(inst, a.jobName)));
    const pod = podOf(inst, a.jobName) as KubePod;
    expect(pod.status.initContainerStatuses?.[0]?.state.terminated?.exitCode).not.toBe(0);
    expect(parseMaterializeStatus(pod)).toMatchObject({ kind: 'refusal', code: 'commit_not_found' });
    // No app container ever started (init containers finish first), so there is nothing to ask a permit for; the call is refused anyway.
    const token = inst.kube.mintToken(pod, tokenAudience(e.a.orgId, a.id));
    expect(await inst.runner.acquireStartPermit({ token, orgId: e.a.orgId, allocationId: a.id, epoch: a.ownerEpoch })).toMatchObject({ granted: false, code: 'no_receipt' });
    await settle(inst, a.id);
    expect(await e.allocation(e.a, a.id)).toMatchObject({ state: 'terminated', podUid: null });
    expect((await e.workspace(e.a, ws)).state).toBe('allocated');
  });

  it('a lone pod that answers target_exists stops the allocation; control: the same setup without the directory is granted (first test)', async () => {
    const { inst, volume } = podRunner();
    const s = await e.newStage(e.a);
    const ws = await e.newWorkspace(e.a, s, inst, { baseCommit: commit });
    // The generation directory already sits on the volume, as a crash after the rename would leave it.
    let dir = join(volume, 'factory'); mkdirSync(dir, { mode: 0o700 });
    for (const part of [e.a.orgId, ws, 'g1']) { dir = join(dir, part); mkdirSync(dir, { mode: 0o700 }); }
    await start(inst, s, ws);
    const a = (await e.allocations(e.a, s))[0] as NonNullable<Awaited<ReturnType<typeof e.allocations>>[number]>;
    await until('the init step finished', () => initDone(podOf(inst, a.jobName)));
    expect(parseMaterializeStatus(podOf(inst, a.jobName) as KubePod)).toMatchObject({ kind: 'refusal', code: 'target_exists' });
    await settle(inst, a.id);
    expect(await e.allocation(e.a, a.id)).toMatchObject({ state: 'terminated', podUid: null });
    expect((await e.workspace(e.a, ws)).state).toBe('allocated');
    expect(existsSync(join(dir, 'work'))).toBe(false); // the entry ran no Git against the existing directory
  });

  it('a pod deleted mid-clone leaves no Git process, after the process was seen alive first', async () => {
    const gate = join(base, `gate-${randomUUID()}`);
    const wrapper = join(base, `git-gate-${randomUUID()}.sh`);
    // The wrapper stands in for Git: its clone writes its pid to the gate and then waits; every other call is the host's own Git.
    writeFileSync(wrapper, `#!/bin/sh\ncase " $* " in\n  *" clone "*) echo $$ > ${gate}; exec /bin/sleep 120 ;;\nesac\nexec /usr/bin/git "$@"\n`);
    chmodSync(wrapper, 0o755);
    const { inst, volume } = podRunner({ gitBinary: wrapper });
    const s = await e.newStage(e.a);
    const ws = await e.newWorkspace(e.a, s, inst, { baseCommit: commit });
    await start(inst, s, ws);
    const a = (await e.allocations(e.a, s))[0] as NonNullable<Awaited<ReturnType<typeof e.allocations>>[number]>;
    await until('Git is cloning', () => existsSync(gate) && readFileSync(gate, 'utf8').trim() !== '');
    const gitPid = Number(readFileSync(gate, 'utf8').trim());
    gated.push(gitPid);
    expect(alive(gitPid)).toBe(true); // seen alive first
    expect(initDone(podOf(inst, a.jobName))).toBe(false);
    await inst.runner.cancel(e.ctx(e.a), s.logicalId, randomUUID(), 'mid-clone');
    await until('the pod is gone', () => podOf(inst, a.jobName) === undefined, 20_000);
    await until('no Git process is left', () => !alive(gitPid), 10_000);
    expect(existsSync(join(volume, 'factory', e.a.orgId, ws, '.staging-g1'))).toBe(false); // the staging path is removed
    expect(existsSync(join(volume, 'factory', e.a.orgId, ws, 'g1'))).toBe(false);          // nothing is moved into place
    await settle(inst, a.id);
    expect((await e.workspace(e.a, ws)).state).toBe('allocated');
  });
});

describe('W-017 pod materializer: the entries', () => {
  const orgId = randomUUID(); const workspaceId = randomUUID(); const taskId = randomUUID();
  const req = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ kind: 'remote', target: { orgId, workspaceId, generation: 1 }, taskId, cloneUrl: 'https://git.example.test/org/repo.git', commit: 'c'.repeat(40), branch: `factory/${taskId}/main`, subpath: '', ...over });
  const run = (entry: string, args: string[], extraEnv: Record<string, string> = {}): { code: number | null; message: string; volume: string } => {
    const volume = mkdtempSync(join(base, 'run-'));
    const message = join(volume, 'termination-message');
    const r = spawnSync(process.execPath, [entry, ...args], { env: { PATH: process.env['PATH'] ?? '', TERMINATION_MESSAGE_PATH: message, FACTORY_TEST_VOLUME: volume, ...extraEnv }, encoding: 'utf8', timeout: 60_000 });
    return { code: r.status, message: existsSync(message) ? readFileSync(message, 'utf8') : '', volume };
  };

  it('the production entry refuses a file:// remote whatever its arguments and environment say; the test entry accepts the same request', async () => {
    const request = canonicalJson(req({ cloneUrl: `file://${repo}`, commit }));
    const hostile = { FACTORY_ALLOW_FILE_REMOTE: '1', FACTORY_ALLOW_FILE_TRANSPORT: '1', GIT_ALLOW_PROTOCOL: 'file', ALLOW_FILE: 'true', NODE_OPTIONS: '' };
    // The production entry writes to the kubelet's fixed path (it reads no variable for it), so here only its exit code is seen.
    const prod = run(PROD_ENTRY, ['materialize', '--request', request], hostile);
    expect(prod.code).toBe(2);
    expect(prod.message).toBe(''); // and it did not write where TERMINATION_MESSAGE_PATH pointed
    // What it says, through the same logic with the production setting, on a volume it must not touch.
    const volume = mkdtempSync(join(base, 'prod-'));
    const out: string[] = [];
    expect(await runMaterialize({ argv: ['materialize', '--request', request], volume, allowFileRemote: false, allowFileTransport: false, signal: new AbortController().signal, writeMessage: (t) => out.push(t) })).toBe(2);
    expect(parseMaterializeStatus({ status: { phase: 'Failed', initContainerStatuses: [{ name: 'materialize', state: { terminated: { exitCode: 2, message: out.join('') } } }] } })).toMatchObject({ kind: 'refusal', code: 'invalid_clone_url' });
    expect(existsSync(join(volume, 'factory'))).toBe(false); // the refusal came before the volume was touched (control: the test entry creates it, below)
    // Further arguments do not switch it on either.
    expect(run(PROD_ENTRY, ['materialize', '--request', request, '--allow-file'], hostile).code).toBe(2);
    // Control: the test entry, same request, same hostile environment, clones the fixture.
    const ok = run(TEST_ENTRY, ['materialize', '--request', canonicalJson(req({ cloneUrl: `file://${repo}`, commit, target: { orgId, workspaceId, generation: 1 } }))], hostile);
    expect(ok.code).toBe(0);
    expect(existsSync(join(ok.volume, 'factory'))).toBe(true);
    expect(parseMaterializeStatus({ status: { phase: 'Succeeded', initContainerStatuses: [{ name: 'materialize', state: { terminated: { exitCode: 0, message: ok.message } } }] } })).toMatchObject({ kind: 'receipt', receipt: { headCommit: commit } });
  });

  it('the production logic passes https through its URL policy (control): the clone then fails on the network, not on the policy', async () => {
    const volume = mkdtempSync(join(base, 'https-'));
    const out: string[] = [];
    const code = await runMaterialize({ argv: ['materialize', '--request', canonicalJson(req({ cloneUrl: 'https://127.0.0.1:1/org/repo.git' }))], volume, allowFileRemote: false, signal: new AbortController().signal, writeMessage: (t) => out.push(t) });
    expect(code).toBe(1);
    expect(out.join('')).not.toContain('invalid_clone_url');
    expect(out.join('')).toContain('"code":"git_failed"');
  });

  it('a bundle request is not_supported (D13), and so is the pod-mode materialize call', async () => {
    const volume = mkdtempSync(join(base, 'bundle-'));
    const out: string[] = [];
    const bundle = JSON.stringify({ kind: 'bundle', target: { orgId, workspaceId, generation: 1 }, bundle: { artifactId: randomUUID(), sha256: 'a'.repeat(64), mediaType: 'x', schemaVersion: '1', sizeBytes: 1 }, commit: 'c'.repeat(40), expectedTreeDigest: 'b'.repeat(64) });
    expect(await runMaterialize({ argv: ['materialize', '--request', bundle], volume, allowFileRemote: true, signal: new AbortController().signal, writeMessage: (t) => out.push(t) })).toBe(2);
    expect(out.join('')).toContain('"code":"not_supported"');
    expect(existsSync(join(volume, 'factory'))).toBe(false);
    const m = new PodVolumeMaterializer({ kube: new FakeKube(), config: e.config, lookup: () => Promise.resolve({ taskId: randomUUID(), live: false }) });
    expect(await m.materialize()).toMatchObject({ ok: false, code: 'not_supported' });
  });

  it('the arguments are exactly [materialize, --request, <canonical JSON>]', async () => {
    const volume = mkdtempSync(join(base, 'argv-'));
    const go = async (argv: string[]): Promise<{ code: number; out: string }> => { const out: string[] = []; const code = await runMaterialize({ argv, volume, allowFileRemote: true, allowFileTransport: true, signal: new AbortController().signal, writeMessage: (t) => out.push(t) }); return { code, out: out.join('') }; };
    const good = canonicalJson(req({ cloneUrl: `file://${repo}`, commit }));
    for (const argv of [[], ['materialize'], ['materialize', '--request'], ['clone', '--request', good], ['materialize', '--req', good], ['materialize', '--request', good, 'extra']]) {
      expect(await go(argv)).toMatchObject({ code: 2 });
    }
    expect((await go(['materialize', '--request', good])).code).toBe(0); // control
  });

  it('the request is parsed once, in canonical form, field by field; each refusal has its accepted twin', () => {
    const ok = (over: Record<string, unknown> = {}, file = false): ReturnType<typeof parseRequest> => parseRequest(canonicalJson(req(over)), file);
    expect(ok()).toMatchObject({ kind: 'remote', cloneUrl: 'https://git.example.test/org/repo.git' });
    expect(() => ok({ extra: 1 })).toThrow(/unexpected/);
    expect(() => ok({ commit: 'c'.repeat(39) })).toThrow(/commit/);
    expect(ok({ commit: 'c'.repeat(64) })).toBeDefined();
    expect(() => ok({ target: { orgId: 'nope', workspaceId, generation: 1 } })).toThrow(/UUID/);
    expect(() => ok({ target: { orgId, workspaceId, generation: 0 } })).toThrow(/generation/);
    expect(() => ok({ target: { orgId, workspaceId, generation: 1, extra: true } })).toThrow(/target/);
    expect(() => ok({ branch: '-x' })).toThrow(/branch/);
    expect(() => ok({ taskId: 5 })).toThrow(/task/);
    expect(() => ok({ subpath: 'x'.repeat(1025) })).toThrow(/subpath/);
    expect(ok({ subpath: 'x'.repeat(1024) })).toBeDefined();
    expect(() => parseRequest(`${canonicalJson(req())} `, false)).toThrow(/canonical/); // trailing whitespace
    expect(() => parseRequest(JSON.stringify(req(), null, 1), false)).toThrow(/canonical/);
    expect(() => parseRequest('{', false)).toThrow(/JSON/);
    expect(() => parseRequest('[]', false)).toThrow(/object/);
    expect(() => parseRequest(' '.repeat(MAX_REQUEST_BYTES + 1), false)).toThrow(/8 KiB/);
    expect(ok({ branch: undefined })).not.toHaveProperty('branch'); // the branch is optional
  });

  it('the clone URL policy: https only in production, no credentials, no option-like host; file:// only in the test entry; the cap comes before the pattern', () => {
    for (const url of ['https://git.example.test/org/repo.git', 'https://git.example.test:8443/org/repo.git', 'https://git.example.test']) expect(() => { assertRemoteAllowed(url, false); }).not.toThrow();
    for (const url of ['file:///fixture/repo.git', 'http://git.example.test/x', 'ssh://git@git.example.test/x', 'git@git.example.test:org/repo.git', 'git://git.example.test/x', 'ext::sh -c id', '/srv/repo.git', '-upload-pack=x',
      'https://user:pw@git.example.test/x', 'https://user@git.example.test/x', 'https://-evil.example/x', 'https://git.example.test/a b', 'https://git.example.test/\n', '', 'https://']) {
      expect(() => { assertRemoteAllowed(url, false); }, url).toThrow(/https only|2,048/);
    }
    expect(() => { assertRemoteAllowed('file:///fixture/repo.git', true); }).not.toThrow(); // the test entry's one extra
    expect(() => { assertRemoteAllowed('file:///fixture/../etc/x', true); }).toThrow();
    expect(() => { assertRemoteAllowed('file://host/fixture', true); }).toThrow();
    // Linear and capped: a megabyte of hostile input is refused by length before any pattern runs.
    const t0 = performance.now();
    for (const url of [`https://${'a'.repeat(1_000_000)}`, `https://a/${'%'.repeat(1_000_000)}`, `https://${'a.'.repeat(500_000)}`]) expect(() => { assertRemoteAllowed(url, false); }).toThrow(/2,048/);
    expect(performance.now() - t0).toBeLessThan(500);
    // And just under the cap, the worst shapes still finish at once.
    const t1 = performance.now();
    for (const url of [`https://${'a'.repeat(2000)}`, `https://${'a.'.repeat(1000)}!`, `https://a/${'/'.repeat(2000)}`]) { try { assertRemoteAllowed(url, false); } catch { /* refused or not: only the time matters */ } }
    expect(performance.now() - t1).toBeLessThan(200);
  });
});
