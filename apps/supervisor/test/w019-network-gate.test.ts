// The network start gate (D11): withhold everything until the listed rules are shown active. Three local ports stand in for deny targets and one for the listener.
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { gateRound, reportText, runGate, type GateOptions } from '../src/network-gate.ts';
import { isLiteralTarget, parseServeArgs, ArgsRefused } from '../src/args.ts';
import { VirtualClock } from './kit.ts';

const servers: net.Server[] = [];
afterEach(async () => { for (const s of servers.splice(0)) await new Promise<void>((r) => { s.close(() => { r(); }); }); });
const listen = async (): Promise<net.Server> => { const s = net.createServer((c) => { c.end(); }); await new Promise<void>((r) => { s.listen(0, '127.0.0.1', r); }); servers.push(s); return s; };
const portOf = (s: net.Server): number => (s.address() as net.AddressInfo).port;
const realConnect = (host: string, port: number): Promise<boolean> => new Promise((resolve) => { const c = net.connect({ host, port }); c.setTimeout(500, () => { c.destroy(); resolve(false); }); c.once('connect', () => { c.destroy(); resolve(true); }); c.once('error', () => { resolve(false); }); });

function opts(clock: VirtualClock, targets: string[], listenerPort: number, extra: Partial<GateOptions> = {}): { o: GateOptions; handshakes: () => number } {
  let hs = 0;
  return { handshakes: () => hs, o: { mode: 'required', targets, listener: { host: '127.0.0.1', port: listenerPort }, connect: realConnect, handshake: () => { hs += 1; return Promise.resolve(true); }, sleep: (ms) => clock.sleep(ms), now: clock.now, ...extra } };
}

describe('W-019 the network gate', () => {
  it('holds while any deny target accepts, and while the listener does not answer; passes within one round of the last one closing; one handshake only', async () => {
    const clock = new VirtualClock();
    const [t1, t2, t3, l] = [await listen(), await listen(), await listen(), await listen()] as [net.Server, net.Server, net.Server, net.Server];
    const targets = [t1, t2, t3].map((s) => `127.0.0.1:${String(portOf(s))}`);
    const p = [portOf(t1), portOf(t2), portOf(t3)];
    const { o, handshakes } = opts(clock, targets, portOf(l));
    let outcome: Awaited<ReturnType<typeof runGate>> | undefined;
    const run = runGate(o).then((r) => { outcome = r; });
    await clock.advance(3500);
    expect(outcome).toBeUndefined(); // every target open
    await new Promise<void>((r) => { t1.close(() => { r(); }); });
    await new Promise<void>((r) => { t2.close(() => { r(); }); });
    await clock.advance(3500);
    expect(outcome).toBeUndefined(); // one still open: held
    await new Promise<void>((r) => { t3.close(() => { r(); }); });
    await clock.advance(1000);
    await run;
    expect(outcome).toMatchObject({ passed: true, mode: 'required', listener: 'accepts' });
    expect(outcome?.rounds).toBeGreaterThanOrEqual(8);
    expect(outcome?.waitMs).toBeGreaterThanOrEqual(7000);
    expect(outcome?.targets).toEqual(targets.map((t) => ({ target: t, result: 'denied' })));
    expect(handshakes()).toBe(1); // a waiting gate cost the listener a plain connect a second, and one handshake at the end
    expect(p.length).toBe(3);
    // control: a silent listener holds it even with every target closed
    const silent = opts(new VirtualClock(), targets, 1);
    let held = true;
    void runGate(silent.o).then(() => { held = false; });
    await new Promise((r) => setTimeout(r, 50));
    expect(held).toBe(true);
    expect(silent.handshakes()).toBe(0);
  });

  it('never closing: it fails at the bound (exit 68 upstream) after about 120 s of rounds, and no handshake was spent', async () => {
    const clock = new VirtualClock();
    const open = await listen();
    const l = await listen();
    const { o, handshakes } = opts(clock, [`127.0.0.1:${String(portOf(open))}`], portOf(l));
    let r: Awaited<ReturnType<typeof runGate>> | undefined;
    const run = runGate(o).then((x) => { r = x; });
    await clock.advance(125_000);
    await run;
    expect(r).toMatchObject({ passed: false });
    expect(r?.waitMs).toBeGreaterThanOrEqual(119_000);
    expect(r?.waitMs).toBeLessThanOrEqual(120_000);
    expect(r?.targets[0]?.result).toBe('open');
    expect(handshakes()).toBe(0);
  });

  it('a target given as a name is refused at argument parsing (exit 64); disabled sends nothing and reports disabled', async () => {
    const base = ['serve', '--org', '11111111-1111-4111-8111-111111111111', '--allocation', '22222222-2222-4222-8222-222222222222', '--epoch', '1', '--generation', '1', '--runner', 'https://192.168.127.254:18443',
      '--runner-ca-sha256', 'a'.repeat(64), '--listen', '127.0.0.1:8765', '--network-gate', 'required'];
    expect(() => parseServeArgs([...base, '--deny-target', 'kubernetes.default.svc:443'])).toThrow(ArgsRefused);
    expect(() => parseServeArgs([...base, '--deny-target', '10.43.0.1'])).toThrow(ArgsRefused);
    expect(() => parseServeArgs([...base])).toThrow(ArgsRefused); // required with none
    expect(() => parseServeArgs([...base, ...Array.from({ length: 9 }, (_, i) => ['--deny-target', `10.0.0.${String(i + 1)}:80`]).flat()])).toThrow(ArgsRefused); // more than eight
    expect(parseServeArgs([...base, '--deny-target', '10.43.0.1:443', '--deny-target', '[fd00::1]:443']).denyTargets).toHaveLength(2); // control
    expect([isLiteralTarget('169.254.169.254:80'), isLiteralTarget('10.0.0.1:0'), isLiteralTarget('10.0.0.1:65536'), isLiteralTarget('999.0.0.1:80')]).toEqual([true, false, false, false]);
    const disabled = await runGate({ ...opts(new VirtualClock(), [], 1).o, mode: 'disabled' });
    expect(disabled).toMatchObject({ mode: 'disabled', passed: true, rounds: 0 });
  });

  it('one round on its own (the round after the grant) reports a target that is open again; the report stays inside 1 KiB', async () => {
    const reopened = await listen();
    const l = await listen();
    const round = await gateRound({ targets: [`127.0.0.1:${String(portOf(reopened))}`], listener: { host: '127.0.0.1', port: portOf(l) }, connect: realConnect });
    expect(round).toMatchObject({ allDenied: false, listenerAccepts: true });
    const many = Array.from({ length: 8 }, (_, i) => ({ target: `10.255.255.${String(i)}:443`, result: 'denied' as const }));
    const big = reportText({ mode: 'required', passed: true, rounds: 3, waitMs: 3000, listener: 'accepts', targets: many }, 200);
    expect(Buffer.byteLength(big)).toBeLessThanOrEqual(200);
    expect(JSON.parse(big)).toMatchObject({ mode: 'required' });
  });
});
