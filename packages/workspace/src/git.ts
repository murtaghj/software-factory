// The only place Git is run (W-018). Trusted code runs Git only on a repository that the factory
// created and that no candidate process has ever been able to write; this module enforces the shape
// of that rule: every call needs a FactoryOwnedRepo handle, and the environment is built from
// nothing. No variable of the parent process reaches Git, so GIT_DIR, GIT_CONFIG_*, GIT_EXEC_PATH,
// GIT_ALTERNATE_OBJECT_DIRECTORIES, XDG_CONFIG_HOME and HOME of the parent have no effect.
//
// FactoryOwnedRepo handles are minted by claimFactoryOwned, which only the materializer and the
// publisher import. It is not re-exported from the package index.
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceError } from './errors.ts';

export const MIN_GIT_VERSION = { major: 2, minor: 48 } as const;
const MINT = Symbol('factory-owned-repo');

export class FactoryOwnedRepo {
  readonly path: string;
  constructor(token: symbol, path: string) {
    if (token !== MINT) throw new Error('FactoryOwnedRepo can only be created by the materializer or the publisher');
    this.path = path;
  }
}

// Internal: materializer.ts and publish.ts only. The caller vouches that the directory was created
// by the factory and has never been writable by a candidate process.
export const claimFactoryOwned = (path: string): FactoryOwnedRepo => new FactoryOwnedRepo(MINT, path);

// HOME for every Git child: one empty directory per user, never written to. With GIT_CONFIG_GLOBAL
// and GIT_CONFIG_SYSTEM pointed at /dev/null nothing is read from it either; it exists so that Git
// never falls back to a HOME the parent chose.
// Waits until no process of the group exists, up to 10 s. Only ESRCH means the group is gone. On macOS a group whose
// only members are exited children that nobody has reaped yet answers kill(-pgid, 0) with EPERM, not ESRCH, so EPERM
// keeps polling until the deadline (the members are reaped as soon as their parent exits or waits). Any other error
// fails closed: the group is not shown gone.
export async function groupGone(pid: number | undefined, timeoutMs = 10_000): Promise<boolean> {
  if (pid === undefined) return true;
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    try { process.kill(-pid, 0); } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return true;
      if (code !== 'EPERM') return false;
    }
    if (performance.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
}

let emptyHome: string | undefined;
function homeDirectory(): string {
  if (emptyHome !== undefined) return emptyHome;
  const uid = process.getuid?.();
  const dir = join(tmpdir(), `factory-git-home-${String(uid ?? 'x')}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let s = lstatSync(dir);
  if (s.isDirectory() && !s.isSymbolicLink() && (uid === undefined || s.uid === uid)) { chmodSync(dir, 0o700); s = lstatSync(dir); }
  // Private, ours, mode 0700 and empty; anything else and Git does not run.
  if (!s.isDirectory() || s.isSymbolicLink() || (uid !== undefined && s.uid !== uid) || (s.mode & 0o077) !== 0 || readdirSync(dir).length > 0) {
    throw new WorkspaceError('git_failed', `${dir} is not an empty private directory owned by this user`);
  }
  emptyHome = dir;
  return dir;
}

const GIT_CANDIDATES = ['/usr/bin/git', '/opt/homebrew/bin/git'];
export const FIXED_PATH = '/usr/bin:/bin';

// Configuration given on every call, ahead of the subcommand. Nothing here comes from a repository.
const HARDENING = [
  '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
  '-c', 'core.attributesFile=/dev/null', '-c', 'core.askPass=', '-c', 'credential.helper=',
  // Transports are an allowlist: everything is off except https and ssh. `file` is on only through
  // the explicit, test-only allowFileTransport option of GitRunner.
  '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'protocol.ssh.allow=always',
  '-c', 'protocol.ext.allow=never', '-c', 'transfer.fsckObjects=true', '-c', 'fetch.fsckObjects=true', '-c', 'receive.fsckObjects=true',
  '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'advice.detachedHead=false', '-c', 'core.symlinks=true',
];

export type GitResult = { code: number; stdout: Buffer; stderr: string };
export type GitRunOptions = { cwd: FactoryOwnedRepo; timeoutMs?: number; maxBuffer?: number; input?: Buffer | string; signal?: AbortSignal; allowFailure?: boolean };
export type GitVersion = { raw: string; major: number; minor: number; patch: number };

export function gitEnvironment(): Record<string, string> {
  return {
    PATH: FIXED_PATH,
    HOME: homeDirectory(),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    LC_ALL: 'C',
  };
}

export type GitRunnerOptions = { binary?: string; defaultTimeoutMs?: number; onRun?: (args: readonly string[]) => void; allowFileTransport?: boolean;
  // TEST ONLY: lets a positive control run the very same GitRunner with a deliberately leaky
  // environment, to show that the hostile fixtures fire. Never set outside tests.
  unsafeEnvironment?: (base: Record<string, string>) => Record<string, string>;
};

export class GitRunner {
  readonly #binary: string;
  readonly #timeout: number;
  readonly #onRun: ((args: readonly string[]) => void) | undefined;
  readonly #fileTransport: boolean;
  readonly #unsafeEnv: ((base: Record<string, string>) => Record<string, string>) | undefined;
  #version: GitVersion | undefined;

  constructor(options: GitRunnerOptions = {}) {
    const binary = options.binary ?? GIT_CANDIDATES.find((c) => existsSync(c));
    if (!binary) throw new WorkspaceError('git_failed', 'no git binary found in the fixed locations');
    this.#binary = binary;
    this.#timeout = options.defaultTimeoutMs ?? 120_000;
    this.#onRun = options.onRun;
    this.#fileTransport = options.allowFileTransport === true;
    this.#unsafeEnv = options.unsafeEnvironment;
  }

  async run(args: readonly string[], o: GitRunOptions): Promise<GitResult> {
    this.#onRun?.(args);
    return this.#exec([...HARDENING, ...(this.#fileTransport ? ['-c', 'protocol.file.allow=always'] : []), ...args], o.cwd.path, o);
  }

  // Every Git child runs in its own process group (detached). On a timeout, an abort or an output
  // overflow the whole group is killed, and the promise does not settle until the group has fully
  // exited: a child of git (ssh, pack-objects, git-remote-https, receive-pack) must not outlive the
  // call and finish a transfer after the caller has let go of its lock. An interrupted call rejects
  // with `details.interrupted` set; its effect on the remote is unknown.
  #exec(args: string[], cwd: string, o: { timeoutMs?: number; maxBuffer?: number; input?: Buffer | string; signal?: AbortSignal; allowFailure?: boolean }): Promise<GitResult> {
    return new Promise((resolve, reject) => {
      const maxBuffer = o.maxBuffer ?? 512 * 1024 * 1024;
      const child = spawn(this.#binary, args, { cwd, env: this.#unsafeEnv ? this.#unsafeEnv(gitEnvironment()) : gitEnvironment(), detached: true, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      const pid = child.pid;
      const out: Buffer[] = [];
      const errChunks: Buffer[] = [];
      let outBytes = 0;
      let errBytes = 0;
      let interrupted: 'timeout' | 'aborted' | 'output_limit' | undefined;
      const killGroup = (): void => { if (pid !== undefined) { try { process.kill(-pid, 'SIGKILL'); } catch { /* the group is already gone */ } } };
      const interrupt = (why: 'timeout' | 'aborted' | 'output_limit'): void => { interrupted ??= why; killGroup(); };
      const timer = setTimeout(() => { interrupt('timeout'); }, o.timeoutMs ?? this.#timeout);
      const onAbort = (): void => { interrupt('aborted'); };
      if (o.signal?.aborted) onAbort(); else o.signal?.addEventListener('abort', onAbort, { once: true });
      child.stdout.on('data', (c: Buffer) => { outBytes += c.length; if (outBytes > maxBuffer) interrupt('output_limit'); else out.push(c); });
      child.stderr.on('data', (c: Buffer) => { errBytes += c.length; if (errBytes <= 1024 * 1024) errChunks.push(c); });
      child.stdin.on('error', () => undefined);
      let settled = false;
      const finish = (fn: () => void): void => { if (settled) return; settled = true; clearTimeout(timer); o.signal?.removeEventListener('abort', onAbort); fn(); };
      child.on('error', (e) => { finish(() => { reject(new WorkspaceError('git_failed', `git could not start: ${e.message}`)); }); });
      child.on('close', (code) => {
        killGroup(); // stragglers of a call that returned are not left behind either
        void groupGone(pid).then((gone) => {
          finish(() => {
            const stderr = Buffer.concat(errChunks).toString('utf8');
            if (interrupted !== undefined || !gone) {
              reject(new WorkspaceError('git_failed', `git was interrupted (${interrupted ?? 'group did not exit'}); its effect on a remote is unknown`, { interrupted: interrupted ?? 'group_not_gone', groupGone: gone }));
              return;
            }
            if (code === 0) { resolve({ code: 0, stdout: Buffer.concat(out), stderr }); return; }
            const exit = code ?? 128;
            if (o.allowFailure) { resolve({ code: exit, stdout: Buffer.concat(out), stderr }); return; }
            reject(new WorkspaceError('git_failed', `git ${args.filter((a) => !a.startsWith('-c') && !a.includes('=')).slice(0, 2).join(' ')} exited ${String(exit)}: ${stderr.trim().slice(0, 500)}`, { exitCode: exit, stderr: stderr.slice(0, 2000) }));
          });
        });
      });
      if (o.input !== undefined) child.stdin.end(o.input); else child.stdin.end();
    });
  }

  // The observed version, checked against the floor (relative worktree paths need 2.48).
  async version(): Promise<GitVersion> {
    if (this.#version) return this.#version;
    const r = await this.#exec(['--version'], homeDirectory(), {});
    const raw = r.stdout.toString('utf8').trim();
    const m = /git version (\d+)\.(\d+)\.(\d+)/.exec(raw);
    if (!m) throw new WorkspaceError('git_failed', `unrecognised git version output: ${raw}`);
    const v = { raw, major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
    if (v.major < MIN_GIT_VERSION.major || (v.major === MIN_GIT_VERSION.major && v.minor < MIN_GIT_VERSION.minor)) {
      throw new WorkspaceError('git_too_old', `git ${String(MIN_GIT_VERSION.major)}.${String(MIN_GIT_VERSION.minor)} or later is required; found ${raw}`);
    }
    this.#version = v;
    return v;
  }
}
