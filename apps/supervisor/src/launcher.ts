// The launcher (section 6, 19b): the trusted first process of the harness container, `harness --supervisor <url> -- <program> [args]`. It starts NOTHING until the
// supervisor's local endpoint answers `start: true`; on `start: false` it exits non-zero; if the supervisor never answers it waits for TERM (the runner stops the pod when
// it sees the supervisor's container exit, or at the start deadline). Before the program starts nothing hostile is in the pod, so nothing can have taken port 8765 and
// `start: true` can be believed. It sets umask 027, starts the program in a new process group, and exits with the program's code after the hint. On TERM, or when
// `/v1/stop` answers, it sends TERM to the group and KILL 10 s later. It never signals pid -1 (see group.ts). Once the program has started, the launcher is as
// untrusted as the program: same uid, same container.
import { spawn } from 'node:child_process';
import http from 'node:http';
import { killGroup } from './group.ts';

export type LauncherOptions = { argv: readonly string[]; term: AbortSignal; killAfterMs?: number; log?: (event: string, detail?: Record<string, unknown>) => void; env?: NodeJS.ProcessEnv };
type Poll = { start: true } | { start: false; reason?: string } | { stop: true } | { pending: true } | undefined;

function get(base: URL, path: string, signal: AbortSignal): Promise<Poll> {
  return new Promise((resolve) => {
    const req = http.get({ hostname: base.hostname, port: base.port, path, signal, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Poll); } catch { resolve(undefined); } });
      res.on('error', () => { resolve(undefined); });
    });
    req.on('error', () => { resolve(undefined); });
  });
}
function post(base: URL, path: string): Promise<void> {
  return new Promise((resolve) => {
    const req = http.request({ hostname: base.hostname, port: base.port, path, method: 'POST', agent: false, timeout: 2000 }, (res) => { res.resume(); res.on('end', resolve); });
    req.on('error', () => { resolve(); });
    req.on('timeout', () => { req.destroy(); resolve(); });
    req.end('{}');
  });
}
const aborted = (s: AbortSignal): boolean => s.aborted;
const sleep = (ms: number, signal: AbortSignal): Promise<void> => new Promise((r) => { const t = setTimeout(r, ms); signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true }); });

export async function runLauncher(o: LauncherOptions): Promise<number> {
  const log = o.log ?? ((): void => undefined);
  const a = o.argv;
  const dash = a.indexOf('--');
  if (a[0] !== 'harness' || a[1] !== '--supervisor' || a[2] === undefined || dash !== 3 || a[dash + 1] === undefined) { log('usage'); return 64; }
  let base: URL;
  try { base = new URL(a[2]); } catch { return 64; }
  if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1') return 64; // the local endpoint, nothing else
  const program = a[dash + 1] as string;
  const args = a.slice(dash + 2);
  // ---- wait for the start signal, and nothing starts before it
  for (;;) {
    if (o.term.aborted) return 143;
    const ac = new AbortController();
    const off = (): void => { ac.abort(); };
    o.term.addEventListener('abort', off, { once: true });
    const r = await get(base, '/v1/start', ac.signal);
    o.term.removeEventListener('abort', off);
    if (aborted(o.term)) return 143;
    if (r !== undefined && 'start' in r) {
      if (r.start) break;
      log('start_refused', { reason: r.reason ?? null });
      return 1;
    }
    await sleep(r === undefined ? 500 : 0, o.term); // no answer yet: the supervisor may not be listening; a long poll that timed out asks again at once
  }
  // ---- start the program: umask 027, a new process group
  process.umask(0o027);
  const child = spawn(program, args, { detached: true, stdio: 'inherit', env: { ...(o.env ?? process.env), FACTORY_SUPERVISOR_URL: base.href.replace(/\/$/, '') } });
  const pid = child.pid;
  if (pid === undefined) { log('spawn_failed'); return 127; }
  log('started', { pid });
  const stopAc = new AbortController();
  let killTimer: NodeJS.Timeout | undefined;
  const stopGroup = (why: string): void => {
    if (killTimer !== undefined) return;
    log('stopping', { why });
    killGroup(pid, 'SIGTERM');
    killTimer = setTimeout(() => { killGroup(pid, 'SIGKILL'); }, o.killAfterMs ?? 10_000);
  };
  o.term.addEventListener('abort', () => { stopGroup('term'); }, { once: true });
  if (aborted(o.term)) stopGroup('term');
  // the stop long poll: the supervisor sets its stop flag for a cancel, a fence or its own TERM
  void (async (): Promise<void> => {
    while (!stopAc.signal.aborted) {
      const r = await get(base, '/v1/stop', stopAc.signal);
      if (r !== undefined && 'stop' in r) { stopGroup('stop'); return; }
      if (r === undefined) await sleep(500, stopAc.signal);
    }
  })();
  const code = await new Promise<number>((resolve) => { child.once('exit', (c, s) => { resolve(c ?? (s === 'SIGKILL' ? 137 : s === 'SIGTERM' ? 143 : 128)); }); child.once('error', () => { resolve(127); }); });
  stopAc.abort();
  if (killTimer !== undefined) clearTimeout(killTimer);
  await post(base, '/v1/exit'); // the hint: it makes a renewal come sooner and decides nothing
  log('exited', { code });
  return code;
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  const stop = new AbortController();
  process.on('SIGTERM', () => { stop.abort(); });
  process.on('SIGINT', () => { stop.abort(); });
  runLauncher({ argv: process.argv.slice(2), term: stop.signal }).then((c) => { process.exit(c); }, () => { process.exit(70); });
}
