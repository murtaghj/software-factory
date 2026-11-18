import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as pkg from '../src/index.ts';
import { runSetup, validateSetupProfile, type SetupExecutionRequest, type SetupExecutionResult, type SetupExecutor, type SetupProfile } from '../src/index.ts';

// A local setup executor for this test only. It is not exported from the package: setup scripts are
// candidate code and belong in the sandbox. It runs the recipe's argument array with exactly the
// environment it was given, in the requested cwd, under the time limit, and reports what it wrote.
class TestExecutor implements SetupExecutor {
  readonly seen: SetupExecutionRequest[] = [];
  readonly #workdir: string;
  constructor(workdir: string) { this.#workdir = workdir; }
  async run(request: SetupExecutionRequest): Promise<SetupExecutionResult> {
    this.seen.push(request);
    const before = this.#listing();
    const cwd = join(this.#workdir, request.cwd);
    const outcome = await new Promise<{ exitCode: number; timedOut: boolean }>((resolve) => {
      execFile(request.executable, [...request.args], { cwd, env: { ...request.environment }, timeout: request.timeoutMs, killSignal: 'SIGKILL' }, (err) => {
        const code = (err as { code?: unknown } | null)?.code;
        resolve({ exitCode: err === null ? 0 : typeof code === 'number' ? code : 1, timedOut: err !== null && (err as { killed?: boolean }).killed === true });
      });
    });
    const after = this.#listing();
    const writtenPaths = [...after].filter(([p, m]) => before.get(p) !== m).map(([p]) => p).sort();
    return { ...outcome, writtenPaths };
  }
  #listing(): Map<string, number> {
    const out = new Map<string, number>();
    const walk = (d: string): void => { for (const n of readdirSync(d)) { const p = join(d, n); const s = statSync(p); if (s.isDirectory()) walk(p); else out.set(relative(this.#workdir, p), s.mtimeMs + s.size); } };
    walk(this.#workdir);
    return out;
  }
}

const IMAGE = `sha256:${'a'.repeat(64)}`;
// Recipes run script files, never inline code (-e is refused by the profile validator).
let scripts = '';
const script = (name: string, body: string): string => { const p = join(scripts, name); writeFileSync(p, body); return p; };
const recipe = (over: Record<string, unknown> = {}) => ({
  id: 'install', imageDigest: IMAGE, executable: process.execPath, args: [join(scripts, 'report.cjs'), 'a b; touch /tmp/should-not-exist'],
  cwd: 'sub', environment: { FOO: 'bar' }, secretRefs: [], timeoutSeconds: 30, outputPaths: ['out'], networkProfile: 'none', ...over,
});
const profile = (over: Record<string, unknown> = {}, recipes: unknown[] = [recipe()]) => ({
  schema: 'factory-setup-profile/1', baseImageDigest: IMAGE, runtime: { name: 'node', version: '24.22.2' }, packageManager: { name: 'pnpm', version: '12.16.1' },
  architecture: 'arm64', lockfiles: ['pnpm-lock.yaml'], dependencySources: ['https://registry.example/mirror'], recipes, ...over,
});

let work = '';
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'w018-setup-'));
  mkdirSync(join(work, 'sub'));
  scripts = mkdtempSync(join(tmpdir(), 'w018-scripts-'));
  script('report.cjs', 'const fs=require("fs");fs.mkdirSync("../out",{recursive:true});fs.writeFileSync("../out/result.json", JSON.stringify({ env: process.env, cwd: process.cwd(), argv: process.argv.slice(2) }))');
  script('slow.cjs', 'setTimeout(() => {}, 60000)');
  script('stray.cjs', 'const fs=require("fs");fs.mkdirSync("../elsewhere",{recursive:true});fs.writeFileSync("../elsewhere/x.txt","x")');
  script('fail.cjs', 'process.exit(3)');
});
afterAll(() => { rmSync(work, { recursive: true, force: true }); rmSync(scripts, { recursive: true, force: true }); });

describe('setup profile', () => {
  it('a recipe runs through the test executor with an argument array, its cwd, a clean environment and a time limit', async () => {
    process.env['LEAK_ME'] = 'parent-secret';
    const ex = new TestExecutor(work);
    const result = await runSetup(validateSetupProfile(profile()), ex);
    delete process.env['LEAK_ME'];
    expect(result).toEqual([{ recipeId: 'install', exitCode: 0, writtenPaths: ['out/result.json'] }]);
    expect(ex.seen[0]).toMatchObject({ executable: process.execPath, cwd: 'sub', environment: { FOO: 'bar' }, timeoutMs: 30_000, outputPaths: ['out'] });
    const out = JSON.parse(readFileSync(join(work, 'out/result.json'), 'utf8')) as { env: Record<string, string>; cwd: string; argv: string[] };
    expect(Object.keys(out.env).filter((k) => k !== '__CF_USER_TEXT_ENCODING')).toEqual(['FOO']);
    expect(out.cwd.endsWith('/sub')).toBe(true);
    expect(out.argv).toEqual(['a b; touch /tmp/should-not-exist']); // one argument, never interpreted by a shell
  });

  it('the time limit is enforced and an output outside the allowed paths fails', async () => {
    const slow = recipe({ id: 'slow', args: [join(scripts, 'slow.cjs')], timeoutSeconds: 1 });
    await expect(runSetup(validateSetupProfile(profile({}, [slow])), new TestExecutor(work))).rejects.toMatchObject({ code: 'setup_timeout' });
    const stray = recipe({ id: 'stray', args: [join(scripts, 'stray.cjs')] });
    await expect(runSetup(validateSetupProfile(profile({}, [stray])), new TestExecutor(work))).rejects.toMatchObject({ code: 'output_outside_allowed_paths', details: { stray: ['elsewhere/x.txt'] } });
    const failing = recipe({ id: 'bad', args: [join(scripts, 'fail.cjs')] });
    await expect(runSetup(validateSetupProfile(profile({}, [failing])), new TestExecutor(work))).rejects.toMatchObject({ code: 'setup_failed' });
  });

  const verdict = (p: unknown): string => { try { validateSetupProfile(p); return 'accepted'; } catch (err) { return (err as { code: string }).code; } };

  it('submodules, LFS and secret references fail closed with unsupported_setup_feature', () => {
    expect(verdict(profile({ submodules: true }))).toBe('unsupported_setup_feature');
    expect(verdict(profile({ lfs: true }))).toBe('unsupported_setup_feature');
    expect(verdict(profile({}, [recipe({ secretRefs: ['npm-token'] })]))).toBe('unsupported_setup_feature');
    expect(verdict(profile())).toBe('accepted'); // control
  });

  // One case per executable, each against a control that differs only in that executable, so a case
  // cannot pass for another reason.
  it.each(['/bin/sh', 'bash', '/usr/bin/zsh', 'dash', 'ksh', 'fish', 'busybox'])('the shell %s is refused', (executable) => {
    expect(verdict(profile({}, [recipe({ executable })]))).toBe('unsupported_setup_feature');
  });
  it.each(['/usr/bin/env', 'xargs', 'nice', 'nohup', 'timeout', 'command', 'exec', 'sudo', 'stdbuf', 'setsid'])('the wrapper %s is refused', (executable) => {
    expect(verdict(profile({}, [recipe({ executable })]))).toBe('unsupported_setup_feature');
  });
  it.each([
    ['node', ['-e', 'x']], ['node', ['--eval=x'.replace('=x', '')]], ['node', ['-p', '1']], ['python3', ['-c', 'x']], ['/usr/bin/python3.12', ['-c', 'x']],
    ['node', ['--eval=1']], ['node', ['--import=data:text/javascript,1']], ['deno', ['eval', 'x']], ['pwsh', ['-Command', 'x']], ['ruby3.3', ['-e', 'x']], ['python3.12', ['-c', 'x']], ['node22', ['-e', 'x']],
    ['perl', ['-e', 'x']], ['perl', ['-E', 'x']], ['ruby', ['-e', 'x']], ['php', ['-r', 'x']], ['deno', ['--eval']], ['node', ['-pe', 'x']],
  ])('the interpreter %s is refused when given inline code (%j)', (executable, args) => {
    expect(verdict(profile({}, [recipe({ executable, args })]))).toBe('unsupported_setup_feature');
  });
  it.each(['node', 'python3', 'perl', 'ruby', 'npm', 'pnpm', '/usr/bin/make'])('control: %s running a script or tool is accepted', (executable) => {
    expect(verdict(profile({}, [recipe({ executable, args: ['script.js', '--flag'] })]))).toBe('accepted');
  });

  it('malformed profiles are invalid_setup_profile', () => {
    const invalid = (p: unknown): unknown => { try { validateSetupProfile(p); return 'accepted'; } catch (e) { return (e as { code: string }).code; } };
    for (const bad of [
      null, 'x', profile({ schema: 'other' }), profile({ baseImageDigest: 'latest' }), profile({ runtime: 'node' }), profile({ lockfiles: 'a' }),
      profile({}, [recipe({ cwd: '../up' })]), profile({}, [recipe({ cwd: '/abs' })]), profile({}, [recipe({ outputPaths: ['../out'] })]),
      profile({}, [recipe({ environment: { GIT_DIR: '/x' } })]), profile({}, [recipe({ environment: { 'BAD NAME': 'x' } })]),
      profile({}, [recipe({ timeoutSeconds: 0 })]), profile({}, [recipe({ timeoutSeconds: 99999 })]), profile({}, [recipe({ args: 'a b' })]),
    ]) expect(invalid(bad)).toBe('invalid_setup_profile');
  });

  it('runSetup without an executor does not compile, and fails at run time if forced', async () => {
    const valid: SetupProfile = validateSetupProfile(profile());
    // @ts-expect-error the executor is a required argument
    const call = (): Promise<unknown> => runSetup(valid);
    await expect(call()).rejects.toMatchObject({ code: 'executor_required' });
    // @ts-expect-error a value with no run() is not an executor either
    await expect(runSetup(valid, {})).rejects.toMatchObject({ code: 'executor_required' });
  });

  it('the package exports no local executor', () => {
    const names = Object.keys(pkg);
    expect(names.filter((n) => /executor/i.test(n))).toEqual([]);
    expect(names).toContain('runSetup');
  });
});
