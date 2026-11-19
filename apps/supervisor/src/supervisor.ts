// The supervisor's life (section 6, "The supervisor"). Order: gate, then permit, then workspace. A gate that never passes costs nothing: the workspace is still
// `allocated`, and release works without a checkpoint. A duplicate probes the network and never reads a file of the workspace.
//   boot -> gating -> acquiring -> preparing -> running -> ending | fenced        TERM, in any state: the stop flag, and exit within a second.
import { SUPERVISOR_EXIT } from '@factory/runner-protocol';
import net from 'node:net';
import { ArgsRefused, parseServeArgs, type ServeArgs } from './args.ts';
import { Beater, type Clock } from './heartbeat.ts';
import { startLocalEndpoint, type LocalEndpoint } from './local-endpoint.ts';
import { gateRound, reportText, runGate, type GateReport } from './network-gate.ts';
import { RunnerClient } from './runner-client.ts';
import { State } from './state.ts';
import { readCa, readToken } from './token-file.ts';
import { WorkspaceView } from './workspace-view.ts';

export type SupervisorOptions = {
  argv: readonly string[];
  // The production entry's fixed paths; the test entry passes its own (and only the test entry may allow a plain loopback runner URL).
  paths: { token: string; ca: string; workspace: string };
  clock?: Clock;
  term: AbortSignal;                       // aborted by SIGTERM
  log?: (event: string, detail?: Record<string, unknown>) => void;
  connect?: (host: string, port: number) => Promise<boolean>;
  beatSeconds?: number; leaseSeconds?: number; // the runner's numbers: beat 10 s, lease 60 s
  acquireCapMs?: number;
};
// The test seams: NOT part of `SupervisorOptions` and not reachable from the package index (only `@factory/supervisor/testing`, which a boundary rule limits to tests).
export type Seams = {
  allowPlainLoopbackRunner?: boolean;      // the fake tier's loopback listener (the production argument parser refuses a loopback runner URL)
  coalesceHints?: boolean;                 // false: the hint-flood test's control
};

const realClock: Clock = {
  now: () => performance.now(),
  sleep: (ms, wake) => new Promise<void>((resolve) => {
    if (wake?.aborted === true) { resolve(); return; }
    const t = setTimeout(done, ms);
    function done(): void { clearTimeout(t); wake?.removeEventListener('abort', done); resolve(); }
    wake?.addEventListener('abort', done, { once: true });
  }),
};
const tcpConnect = (host: string, port: number): Promise<boolean> => new Promise((resolve) => {
  const s = net.connect({ host, port });
  const end = (ok: boolean): void => { s.destroy(); resolve(ok); };
  s.setTimeout(1000, () => { end(false); });
  s.once('connect', () => { end(true); });
  s.once('error', () => { end(false); });
});

const isAborted = (s: AbortSignal): boolean => s.aborted;

export function runSupervisor(o: SupervisorOptions): Promise<number> { return run(o, {}); }
export function runSupervisorWith(o: SupervisorOptions, seams: Seams): Promise<number> { return run(o, seams); }

async function run(o: SupervisorOptions, seams: Seams): Promise<number> {
  const log = o.log ?? ((): void => undefined);
  const clock = o.clock ?? realClock;
  const state = new State();
  let args: ServeArgs;
  let ca: Buffer;
  try {
    args = parseServeArgs(o.argv, { ...(seams.allowPlainLoopbackRunner === true ? { allowPlainLoopbackRunner: true } : {}) });
    // The CA is read once, at boot, and must be the file the arguments name.
    ca = args.runnerUrl.protocol === 'https:' ? readCa(o.paths.ca, args.caSha256) : Buffer.alloc(0); // a plain URL exists only behind the test seam
  } catch (e) {
    log('boot_refused', { reason: e instanceof ArgsRefused || e instanceof Error ? e.message : 'unknown' });
    return SUPERVISOR_EXIT.bad_arguments;
  }
  const ids = { orgId: args.org, allocationId: args.allocation, epoch: args.epoch };
  const client = new RunnerClient({ url: args.runnerUrl, ca: args.runnerUrl.protocol === 'https:' ? ca : undefined, readToken: () => readToken(o.paths.token), now: clock.now });
  let beater: Beater | undefined;
  let endpoint: LocalEndpoint | undefined;
  const term = new Promise<'term'>((resolve) => { if (o.term.aborted) resolve('term'); else o.term.addEventListener('abort', () => { resolve('term'); }, { once: true }); });
  void term.then(() => { state.setStop(); });
  const finish = async (code: number): Promise<number> => {
    await beater?.stop();
    await new Promise<void>((r) => setTimeout(r, 50)); // let a launcher that is polling read the answer
    await endpoint?.close();
    client.close();
    return code;
  };
  try {
    endpoint = await startLocalEndpoint({ state, port: args.listen.port, onHint: () => { beater?.hint(); } });
    // ---- gating
    state.set('gating');
    const connect = o.connect ?? tcpConnect;
    const listener = { host: args.runnerUrl.hostname.replace(/^\[|\]$/g, ''), port: Number(args.runnerUrl.port || (args.runnerUrl.protocol === 'https:' ? 443 : 80)) };
    const gateOpts = { mode: args.gate, targets: args.denyTargets, listener, connect, handshake: () => client.probe(), sleep: (ms: number) => clock.sleep(ms), now: clock.now };
    const gate: GateReport = await Promise.race([runGate(gateOpts), term.then((): GateReport => ({ mode: args.gate, passed: false, rounds: 0, waitMs: 0, listener: 'silent', targets: [] }))]);
    if (isAborted(o.term)) return await finish(SUPERVISOR_EXIT.terminated);
    log('gate', { passed: gate.passed, rounds: gate.rounds, waitMs: Math.round(gate.waitMs) });
    if (!gate.passed) { state.fence('gate_failed'); return await finish(SUPERVISOR_EXIT.gate_failed); }
    // ---- acquiring
    state.set('acquiring');
    const report = reportText(gate);
    const capAt = clock.now() + (o.acquireCapMs ?? 12 * 60_000);
    let retryMs = 2000;
    let granted: Awaited<ReturnType<RunnerClient['acquire']>> & { kind: 'granted' };
    for (;;) {
      if (isAborted(o.term)) return await finish(SUPERVISOR_EXIT.terminated);
      const r = await client.acquire(ids, report);
      if (r.kind === 'granted') { granted = r; break; }
      if (r.kind === 'denied') {
        log('acquire_denied', { code: r.denial.code, reason: r.denial.reason ?? null });
        if (r.denial.code === 'duplicate_writer') return await finish(SUPERVISOR_EXIT.duplicate_writer);
        if (!r.denial.retryable) return await finish(SUPERVISOR_EXIT.denied);
      }
      if (clock.now() > capAt) return await finish(SUPERVISOR_EXIT.denied);
      await clock.sleep(retryMs);
      retryMs = Math.min(5000, retryMs + 1000);
    }
    // ---- preparing: the beat starts, the workspace is looked at, and the gate gets one more round
    state.set('preparing');
    const beatMs = (o.beatSeconds ?? granted.grant.beatSeconds) * 1000;
    const leaseMs = (o.leaseSeconds ?? granted.grant.leaseSeconds) * 1000;
    beater = new Beater({ client, clock, state, ids, beatMs, leaseMs, log, ...(seams.coalesceHints === false ? { coalesce: false } : {}) });
    beater.start(granted.sentAtMs);
    if (args.workspace !== undefined) {
      try { new WorkspaceView({ grant: granted.grant, state, workspaceRoot: o.paths.workspace, org: args.org, workspace: args.workspace, generation: args.generation, log }).checkout(); } catch (e) {
        log('workspace_refused', { reason: e instanceof Error ? e.message : 'unknown' });
        state.fence('workspace'); // fenced first: no further call
        return await finish(SUPERVISOR_EXIT.workspace_unreadable);
      }
    }
    if (args.gate === 'required') {
      const round = await gateRound({ targets: args.denyTargets, listener, connect });
      if (!round.allDenied) { log('gate_reopened', {}); state.fence('gate_reopened'); return await finish(SUPERVISOR_EXIT.gate_failed); }
    }
    if (state.state === 'fenced') return await finish(SUPERVISOR_EXIT.fenced);
    // ---- running: the start gate opens, and only while the local fence time has not passed
    if (!beater.fenceOpen) { state.fence('fence_time'); return await finish(SUPERVISOR_EXIT.fenced); }
    state.set('running');
    log('running', {});
    const settled = await Promise.race([term, new Promise<'state'>((resolve) => { const off = state.onChange(() => { if (state.state === 'ending' || state.state === 'fenced') { off(); resolve('state'); } }); if (state.state === 'ending' || state.state === 'fenced') resolve('state'); })]);
    if (settled === 'term') return await finish(SUPERVISOR_EXIT.terminated);
    if ((state.state as string) === 'fenced') return await finish(SUPERVISOR_EXIT.fenced);
    // ---- ending: the acknowledgement was sent by the beat; wait for TERM, which is what the pod delete brings
    await term;
    return await finish(SUPERVISOR_EXIT.ok);
  } catch (e) {
    log('crashed', { message: e instanceof Error ? e.message : 'error' });
    return await finish(SUPERVISOR_EXIT.denied);
  }
}
