// The network start gate (D11, SI-15). NetworkPolicy is not in force when a pod starts (measured on k3s), so the supervisor withholds everything until the rules are
// shown to be active: one round a second, each trying a TCP connect to every deny target and to the listener. A round passes when EVERY deny target fails and the
// listener accepts; only then does the supervisor spend ONE TLS handshake with the listener, and that makes the gate pass. A waiting gate costs the listener a plain
// connect a second, not a handshake. Bounded at 120 s. It shows that the listed rules are active, and nothing about any other.
export type GateOptions = {
  mode: 'required' | 'disabled';
  targets: readonly string[];                      // literal `address:port`, one to eight
  listener: { host: string; port: number };
  connect: (host: string, port: number) => Promise<boolean>; // true: the connection was accepted
  handshake: () => Promise<boolean>;               // one TLS handshake with the listener
  sleep: (ms: number) => Promise<void>;
  now: () => number;                               // monotonic ms
  boundMs?: number; intervalMs?: number;
};
export type TargetResult = { target: string; result: 'denied' | 'open' };
export type RoundResult = { allDenied: boolean; listenerAccepts: boolean; targets: TargetResult[] };
export type GateReport = { mode: 'required' | 'disabled'; passed: boolean; rounds: number; waitMs: number; listener: 'accepts' | 'silent'; targets: TargetResult[] };

const split = (t: string): { host: string; port: number } => { const i = t.lastIndexOf(':'); return { host: t.slice(0, i).replace(/^\[|\]$/g, ''), port: Number(t.slice(i + 1)) }; };

export async function gateRound(o: Pick<GateOptions, 'targets' | 'listener' | 'connect'>): Promise<RoundResult> {
  const targets: TargetResult[] = [];
  for (const t of o.targets) { const { host, port } = split(t); targets.push({ target: t, result: (await o.connect(host, port)) ? 'open' : 'denied' }); }
  const listenerAccepts = await o.connect(o.listener.host, o.listener.port);
  return { allDenied: targets.every((x) => x.result === 'denied'), listenerAccepts, targets };
}

export async function runGate(o: GateOptions): Promise<GateReport> {
  if (o.mode === 'disabled') return { mode: 'disabled', passed: true, rounds: 0, waitMs: 0, listener: 'silent', targets: [] };
  const bound = o.boundMs ?? 120_000;
  const interval = o.intervalMs ?? 1000;
  const t0 = o.now();
  let rounds = 0;
  for (;;) {
    rounds += 1;
    const last: RoundResult = await gateRound(o);
    // One handshake, and only once a round has passed: never one per round.
    if (last.allDenied && last.listenerAccepts && (await o.handshake())) return { mode: 'required', passed: true, rounds, waitMs: o.now() - t0, listener: 'accepts', targets: last.targets };
    if (o.now() - t0 + interval > bound) return { mode: 'required', passed: false, rounds, waitMs: o.now() - t0, listener: last.listenerAccepts ? 'accepts' : 'silent', targets: last.targets };
    await o.sleep(interval);
  }
}

// The report goes to the runner in the acquire call, which caps it at 1 KiB: the rounds and the wait first, then as many targets as fit.
export function reportText(r: GateReport, cap = 1024): string {
  let text = JSON.stringify(r);
  const copy: GateReport = { ...r, targets: [...r.targets] };
  while (Buffer.byteLength(text) > cap && copy.targets.length > 0) { copy.targets.pop(); text = JSON.stringify(copy); }
  return Buffer.byteLength(text) > cap ? JSON.stringify({ mode: r.mode, passed: r.passed, rounds: r.rounds }) : text;
}
