// The optional fake kubelet (section 5). It runs each container of a scheduled pod as a local child in its
// own process group, init containers first and in order. On a pod delete it sends TERM to every container
// at once, keeps the pod visible with a deletion timestamp until all have exited, and sends KILL when the
// grace period ends. `close()` kills every group and waits for it, so a test may drop its database and its
// directories afterwards. It models the protocol, not the isolation: a child that starts its own session
// escapes a process group (tree stop is claimed at the k3s tier only).
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContainerSpec, KubePod } from './api.ts';
import type { FakeKube, PodRuntime } from './fake.ts';

// `waitForReady`: the program writes one byte to stderr once its signal handlers are installed, and the kubelet reports
// the container `running` only then, so a test that deletes the pod right away does not race the program's start-up.
export type Program = { command: string; args: string[]; env?: Record<string, string>; waitForReady?: boolean };
export type ProgramFactory = (c: ContainerSpec, ctx: { podUid: string; messagePath: string }) => Program;

const node = (code: string): Program => ({ command: process.execPath, args: ['-e', code], waitForReady: true });
export const STUB_PROGRAMS = {
  'factory-stub:local': node("process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);process.stderr.write('R')"),               // runs until TERM
  'factory-stub-ignore-term:local': node("process.on('SIGTERM',()=>{});setInterval(()=>{},1000);process.stderr.write('R')"),               // ignores TERM; only KILL ends it
  'factory-stub-exit0:local': node('process.exit(0)'),
  'factory-stub-exit1:local': node('process.exit(1)'),
} as const;

type Proc = { podUid: string; container: string; child: ChildProcess; pid: number; done: boolean; exited: Promise<number>; stderrTail: string; ready: Promise<void> };

const signalCode = (s: NodeJS.Signals | null): number => (s === 'SIGKILL' ? 137 : s === 'SIGTERM' ? 143 : 128);
const groupAlive = (pgid: number): boolean => { try { process.kill(-pgid, 0); return true; } catch { return false; } };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class FakeKubelet implements PodRuntime {
  readonly kube: FakeKube;
  readonly procs: Proc[] = [];
  readonly errors: unknown[] = [];
  readonly #programs = new Map<string, ProgramFactory>();
  readonly #graceMs: number | undefined;
  readonly #dirs: string[] = [];
  readonly #deleting = new Set<string>();
  readonly #timers = new Set<NodeJS.Timeout>();
  #closed = false;

  // `graceMs` shortens the 15 s grace period so a test does not wait it out.
  constructor(kube: FakeKube, opts: { graceMs?: number } = {}) {
    this.kube = kube;
    this.#graceMs = opts.graceMs;
    for (const [image, p] of Object.entries(STUB_PROGRAMS)) this.register(image, () => p);
    // Init-step stubs: the first argument is the message written to the termination message file, or (stderr-fail) the line written to stderr.
    this.register('factory-stub-message:local', (c) => ({ command: process.execPath, args: ['-e', "require('fs').writeFileSync(process.env.TERMINATION_MESSAGE_PATH, process.argv[1] ?? '')", c.args?.[0] ?? ''] }));
    this.register('factory-stub-stderr-fail:local', (c) => ({ command: process.execPath, args: ['-e', "process.stderr.write(process.argv[1] ?? '');process.exit(1)", c.args?.[0] ?? ''] }));
    kube.runtime = this;
  }

  register(image: string, f: ProgramFactory): void { this.#programs.set(image, f); }

  hasLiveProcesses(podUid: string): boolean { return this.procs.some((p) => p.podUid === podUid && !p.done); }

  onPodScheduled(pod: KubePod): void {
    void this.#runPod(pod).catch((e: unknown) => { this.errors.push(e); });
  }

  onPodDeleting(pod: KubePod, graceMs: number): void {
    this.#deleting.add(pod.metadata.uid);
    const live = this.procs.filter((p) => p.podUid === pod.metadata.uid && !p.done);
    for (const p of live) this.#signal(p, 'SIGTERM');
    if (live.length === 0) return;
    const t = setTimeout(() => { this.#timers.delete(t); for (const p of live) if (!p.done) this.#signal(p, 'SIGKILL'); }, this.#graceMs ?? graceMs);
    this.#timers.add(t);
  }

  #signal(p: Proc, sig: NodeJS.Signals): void { try { process.kill(-p.pid, sig); } catch { /* group already gone */ } }

  processOf(podUid: string, container: string): { pid: number; alive: () => boolean } | undefined {
    const p = this.procs.find((x) => x.podUid === podUid && x.container === container);
    return p ? { pid: p.pid, alive: () => groupAlive(p.pid) } : undefined;
  }

  #start(pod: KubePod, c: ContainerSpec, messagePath: string): Proc {
    const factory = this.#programs.get(c.image);
    if (!factory) throw new Error(`the fake kubelet has no program for image ${c.image}`);
    const prog = factory(c, { podUid: pod.metadata.uid, messagePath });
    const child = spawn(prog.command, prog.args, { detached: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, TERMINATION_MESSAGE_PATH: messagePath, ...prog.env } });
    const pid = child.pid;
    if (pid === undefined) throw new Error('could not start a container process');
    const proc: Proc = { podUid: pod.metadata.uid, container: c.name, child, pid, done: false, stderrTail: '', exited: Promise.resolve(0), ready: Promise.resolve() };
    if (prog.waitForReady === true) {
      proc.ready = new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 10_000);
        const go = (): void => { clearTimeout(t); resolve(); };
        child.stderr.once('data', go);
        child.once('exit', go);
      });
    }
    child.stderr.on('data', (d: Buffer) => { proc.stderrTail = (proc.stderrTail + d.toString()).slice(-512); });
    proc.exited = new Promise<number>((resolve) => {
      child.on('exit', (code, signal) => {
        void (async (): Promise<void> => {
          // The leader is gone; the container is finished only when its whole group is.
          for (let i = 0; i < 100 && groupAlive(pid); i += 1) { if (i === 50) this.#signal(proc, 'SIGKILL'); await sleep(50); }
          proc.done = true;
          resolve(code ?? signalCode(signal));
        })();
      });
    });
    this.procs.push(proc);
    return proc;
  }

  async #runPod(pod: KubePod): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'fake-kubelet-'));
    this.#dirs.push(dir);
    const driver = this.kube.driver;
    const uid = pod.metadata.uid;
    let n = 0;
    const msgPath = (): string => join(dir, `msg-${String((n += 1))}`);
    for (const c of pod.spec.initContainers ?? []) {
      if (this.#closed || this.#deleting.has(uid)) return;
      const path = msgPath();
      const proc = this.#start(pod, c, path);
      await proc.ready;
      driver.containerStarted(uid, 'init', c.name);
      const exitCode = await proc.exited;
      let message = '';
      try { message = readFileSync(path, 'utf8'); } catch { /* the container wrote no message file */ }
      driver.containerExited(uid, 'init', c.name, { exitCode, message, stderr: proc.stderrTail });
      if (exitCode !== 0) return;
    }
    if (this.#closed || this.#deleting.has(uid)) { driver.settleIfStopped(uid); return; }
    const started = pod.spec.containers.map((c) => ({ c, path: msgPath() })).map((x) => ({ ...x, proc: this.#start(pod, x.c, x.path) }));
    await Promise.all(started.map((x) => x.proc.ready));
    for (const { c, path, proc } of started) {
      driver.containerStarted(uid, 'app', c.name);
      void proc.exited.then((exitCode) => {
        let message = '';
        try { message = readFileSync(path, 'utf8'); } catch { /* none */ }
        if (!this.#closed) driver.containerExited(uid, 'app', c.name, { exitCode, message, stderr: proc.stderrTail });
      });
    }
  }

  // Kills every process group and waits until each is gone. Run it before a test drops its database or its directories.
  async close(): Promise<void> {
    this.#closed = true;
    for (const t of this.#timers) clearTimeout(t);
    this.#timers.clear();
    for (const p of this.procs) if (!p.done) this.#signal(p, 'SIGKILL');
    await Promise.all(this.procs.map((p) => p.exited));
    for (const d of this.#dirs) rmSync(d, { recursive: true, force: true });
    if (this.kube.runtime === this) this.kube.runtime = undefined;
  }
}
