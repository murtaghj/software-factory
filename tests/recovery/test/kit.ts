// The cross-app fake tier (W-079's module; its framework is not built and AC-103 is not claimed). The REAL runner, its listener (TLS, a throwaway CA), FakeKube and the
// fake kubelet, and the REAL supervisor and launcher as separate processes, started from the test entries in `entry/`. Every file keeps at most two live pods at once (a pod
// is three Node processes), closes its kubelet in `afterEach`, and moves time by backdating rows, never by waiting.
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEnv, hex, until, type Env, type Instance, type Stage } from '@factory/runner/test-harness';
import { FakeKube, FakeKubelet, startPodListener, type PodListener, type ProgramContext } from '@factory/runner/testing';
import type { KubePod } from '@factory/runner';
import { execFileSync } from 'node:child_process';

export { hex, until };
const HERE = import.meta.dirname;
const SUPERVISOR_ENTRY = join(HERE, 'entry', 'supervisor.ts');
const LAUNCHER_ENTRY = join(HERE, 'entry', 'launcher.ts');
const SCRIPTS = join(HERE, '..', '..', '..', 'apps', 'supervisor', 'src', 'scripts');

export type Pki = { ca: Buffer; cert: string; key: string; cleanup: () => void };
export function makePki(): Pki {
  const dir = mkdtempSync(join(tmpdir(), 'w019-rec-pki-'));
  const run = (...a: string[]): void => { execFileSync('openssl', a, { cwd: dir, stdio: 'pipe' }); };
  writeFileSync(join(dir, 'ca.cnf'), '[req]\ndistinguished_name=dn\nprompt=no\nx509_extensions=ca\n[dn]\nCN=w019-rec-ca\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n');
  writeFileSync(join(dir, 'leaf.cnf'), '[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=w019-rec-listener\n[san]\nsubjectAltName=IP:127.0.0.1\n');
  run('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'ca.key');
  run('req', '-x509', '-new', '-key', 'ca.key', '-sha256', '-days', '2', '-config', 'ca.cnf', '-out', 'ca.crt');
  run('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'leaf.key');
  run('req', '-new', '-key', 'leaf.key', '-config', 'leaf.cnf', '-out', 'leaf.csr');
  run('x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-sha256', '-days', '2', '-extfile', 'leaf.cnf', '-extensions', 'san', '-out', 'leaf.crt');
  const out = { ca: readFileSync(join(dir, 'ca.crt')), cert: readFileSync(join(dir, 'leaf.crt'), 'utf8'), key: readFileSync(join(dir, 'leaf.key'), 'utf8') };
  rmSync(join(dir, 'ca.key'));
  return { ...out, cleanup: () => { rmSync(dir, { recursive: true, force: true }); } };
}
const freePort = (): Promise<number> => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => { resolve(p); }); }); });

export type Rig = {
  e: Env; inst: Instance; kube: FakeKube; kubelet: FakeKubelet; listener: PodListener; port: number; dir: string; pki: Pki;
  holdNextSupervisor: () => void;             // the next supervisor to start stops itself (STOP) before it does anything, until `driver.resume`
  calls: Call[];
  script: (pod: KubePod) => string;           // which scripted harness a pod runs (default idle)
  setScript: (f: (pod: KubePod) => string) => void;
  events: (podName: string, who: 'supervisor' | 'launcher') => Array<Record<string, unknown>>;
  startRun: (o?: { role?: string }) => Promise<{ s: Stage; ws: string; allocationId: string; jobName: string }>;
  podsOf: (jobName: string) => KubePod[];
  claimDir: (workspaceId: string, generation?: number) => string;
  close: () => Promise<void>;
};
export type RigOptions = {
  config?: Record<string, unknown>; gate?: { mode: 'required' | 'disabled'; denyTargets: string[] };
  graceMs?: number;                       // the fake kubelet's grace period (default 600 ms)
  killAfterMs?: number;                   // the launcher's TERM-to-KILL delay (default 300 ms here, 10 s in the pod)
  noCoalesce?: (pod: KubePod) => boolean; // a supervisor whose hints are not coalesced (a control)
  dropFirstAcquireAnswer?: boolean;       // the first grant commits and its answer is lost on the way back (the listener answers 500)
};
// Every pod-facing call that reached the runner's service, in order, with the token's pod and what the runner answered.
export type Call = { route: 'acquire' | 'renew' | 'stopAck'; token: string; at: number; granted: boolean; code?: string };

export async function rig(prefix: string, o: RigOptions = {}): Promise<Rig> {
  const pki = makePki();
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), 'w019-rec-'));
  mkdirSync(join(dir, 'logs'));
  const caSha = createHash('sha256').update(pki.ca).digest('hex');
  const e = await createEnv(prefix, { config: { podRate: { burst: 1000, intervalMs: 250 } } });
  const kube = new FakeKube();
  const kubelet = new FakeKubelet(kube, { graceMs: o.graceMs ?? 600, configMaps: { 'factory-runner-ca': { 'runner-ca.crt': pki.ca.toString() } } });
  const inst = e.newRunner({ kube, config: {
    // The brief's timings for the cross-app files: a 1 s beat, 5 s to suspect, a 10 s lease, and a per-pod interval of 250 ms.
    beatSeconds: 1, suspectSeconds: 5, leaseSeconds: 10, podRate: { burst: 1000, intervalMs: 250 }, cancelCheckpointWaitSeconds: 30,
    images: { supervisor: 'factory-supervisor:local', harness: 'factory-harness-scripted:local', materializer: 'factory-materializer:local' },
    podListener: { host: '127.0.0.1', port, cert: pki.cert, key: pki.key }, test: { sourceOf: () => 'pods', relaxSourceLimits: true },
    supervisor: { runnerUrl: `https://127.0.0.1:${String(port)}`, caConfigMap: 'factory-runner-ca', caSha256: caSha, localPort: 8765 },
    networkGate: o.gate ?? { mode: 'disabled', denyTargets: [] }, ...o.config,
  } as never });
  // A record of what the listener handed to the runner's service (the route table's callers), by token.
  const calls: Call[] = [];
  const real = { acquire: inst.runner.acquireStartPermit.bind(inst.runner), renew: inst.runner.renewPermit.bind(inst.runner), stopAck: inst.runner.stopAck.bind(inst.runner) };
  let dropped = o.dropFirstAcquireAnswer !== true;
  inst.runner.acquireStartPermit = async (req) => { const a = await real.acquire(req); if (!dropped && a.granted) { dropped = true; calls.push({ route: 'acquire', token: req.token, at: performance.now(), granted: true }); throw new Error('the answer was lost'); } calls.push({ route: 'acquire', token: req.token, at: performance.now(), granted: a.granted, ...(a.granted ? {} : { code: a.code }) }); return a; };
  inst.runner.renewPermit = async (req) => { const a = await real.renew(req); calls.push({ route: 'renew', token: req.token, at: performance.now(), granted: a.granted, ...(a.granted ? {} : { code: a.code }) }); return a; };
  inst.runner.stopAck = async (req) => { const a = await real.stopAck(req); calls.push({ route: 'stopAck', token: req.token, at: performance.now(), granted: 'acknowledged' in a, ...('acknowledged' in a ? {} : { code: a.code }) }); return a; };
  const listener = await startPodListener({ runner: inst.runner, config: inst.config });

  let scriptFor: (pod: KubePod) => string = () => 'idle';
  const logPath = (pod: string, who: string): string => join(dir, 'logs', `${pod}.${who}.log`);
  const withPort = (args: readonly string[], ctx: ProgramContext): string[] => args.map((a) => a.replace(':8765', `:${String(ctx.port)}`));
  const identity = (ctx: ProgramContext): string => ctx.volumeDirs['factory-identity'] as string;

  let holdNext = false;
  kubelet.register('factory-supervisor:local', (c, ctx) => {
    const held = holdNext; holdNext = false;
    const entry = [process.execPath, SUPERVISOR_ENTRY, ...withPort(c.args ?? [], ctx)];
    return {
    command: held ? 'sh' : process.execPath, args: held ? ['-c', 'kill -STOP $$; exec "$@"', 'sh', ...entry] : entry.slice(1),
    env: { FACTORY_TEST_TOKEN: join(identity(ctx), 'token'), FACTORY_TEST_CA: join(identity(ctx), 'runner-ca.crt'), FACTORY_TEST_WORKSPACE: ctx.volumeDirs['workspace'] as string, FACTORY_TEST_LOG: logPath(ctx.pod.metadata.name, 'supervisor'), ...(o.noCoalesce?.(ctx.pod) === true ? { FACTORY_TEST_NO_COALESCE: '1' } : {}) },
    };
  });
  kubelet.register('factory-harness-scripted:local', (c, ctx) => {
    const args = withPort(c.args ?? [], ctx);
    const dash = args.indexOf('--');
    return { command: process.execPath, args: [LAUNCHER_ENTRY, ...args.slice(0, dash + 1), process.execPath, join(SCRIPTS, `${scriptFor(ctx.pod)}.ts`)],
      env: { FACTORY_TEST_KILL_AFTER_MS: String(o.killAfterMs ?? 300), FACTORY_TEST_LOG: logPath(ctx.pod.metadata.name, 'launcher'), FACTORY_WORKSPACE: join(ctx.volumeDirs['workspace'] as string, 'factory') } };
  });
  // The trusted init step, in the fake: the tree it would have cloned (made 0750, as the pod export does), and the receipt it would have written.
  kubelet.register('factory-materializer:local', (c, ctx) => {
    const req = JSON.parse(c.args?.[2] ?? '{}') as { target: { orgId: string; workspaceId: string; generation: number } };
    const main = join(ctx.volumeDirs['workspace'] as string, 'factory', req.target.orgId, req.target.workspaceId, `g${String(req.target.generation)}`, 'work', 'main');
    mkdirSync(main, { recursive: true, mode: 0o750 });
    writeFileSync(join(main, 'README.md'), 'fixture\n', { mode: 0o640 });
    return { command: process.execPath, args: ['-e', "require('fs').writeFileSync(process.env.TERMINATION_MESSAGE_PATH, process.env.RECEIPT + '\\n')"], env: { RECEIPT: e.receiptMessage(req.target.generation) } };
  });

  const r: Rig = {
    e, inst, kube, kubelet, listener, port, dir, pki,
    calls,
    holdNextSupervisor: () => { holdNext = true; },
    script: (pod) => scriptFor(pod), setScript: (f) => { scriptFor = f; },
    events: (podName, who) => { try { return readFileSync(logPath(podName, who), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>); } catch { return []; } },
    podsOf: (jobName) => kube.driver.podsOf(jobName),
    claimDir: (workspaceId, generation = 1) => kubelet.claimDir(claimNameOf(e.a.orgId, workspaceId, generation)),
    startRun: async (so = {}) => {
      const s = await e.newStage(e.a, so.role ?? 'implementer');
      const ws = await e.newWorkspace(e.a, s, inst);
      await inst.runner.startOrAttach(e.ctx(e.a), e.input(e.a, s, { workspaceId: ws }), hex('e'));
      const a = (await e.allocations(e.a, s)).at(-1) as NonNullable<Awaited<ReturnType<typeof e.allocations>>[number]>;
      return { s, ws, allocationId: a.id, jobName: a.jobName };
    },
    close: async () => { await listener.close(); await kubelet.close(); rmSync(dir, { recursive: true, force: true }); pki.cleanup(); await e.close(); },
  };
  return r;
}

import { pvcName as claimNameOf } from '@factory/runner';

// What a tree is, for "equal before and after": paths, modes, sizes and the bytes' hash.
export function snapshotTree(root: string): string {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      const s = statSync(p);
      if (s.isDirectory()) { out.push(`d ${p.slice(root.length)} ${(s.mode & 0o7777).toString(8)}`); walk(p); } else out.push(`f ${p.slice(root.length)} ${(s.mode & 0o7777).toString(8)} ${String(s.size)} ${createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 12)}`);
    }
  };
  walk(root);
  return out.join('\n');
}
export const appendLog = appendFileSync;
export const supervisorExit = (kube: FakeKube, podName: string): number | undefined => kube.pods.get(podName)?.status.containerStatuses?.find((c) => c.name === 'supervisor')?.state.terminated?.exitCode;
export const harnessExit = (kube: FakeKube, podName: string): number | undefined => kube.pods.get(podName)?.status.containerStatuses?.find((c) => c.name === 'harness')?.state.terminated?.exitCode;
export const isAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; } };
