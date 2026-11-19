// The beat: an injected clock and an injected transport. The fence time is the SEND time of the last grant plus 50 s, and a hint is coalesced.
import { describe, expect, it } from 'vitest';
import { Beater } from '../src/heartbeat.ts';
import { mintGrant } from '../src/grant.ts';
import type { PermitOutcome } from '../src/runner-client.ts';
import { State } from '../src/state.ts';
import { IDS, VirtualClock, flush } from './kit.ts';

type Reply = (n: number, sentAt: number) => PermitOutcome | Promise<PermitOutcome>;
function rig(reply: Reply, o: { state?: 'running' | 'preparing' } = {}) {
  const clock = new VirtualClock();
  const state = new State();
  state.set(o.state ?? 'running');
  const calls: Array<{ kind: 'renew' | 'stopAck'; at: number }> = [];
  let n = 0;
  const client = {
    renew: async (): Promise<PermitOutcome> => { n += 1; calls.push({ kind: 'renew', at: clock.now() }); return reply(n, clock.now()); },
    stopAck: (): Promise<{ kind: 'acknowledged' }> => { calls.push({ kind: 'stopAck', at: clock.now() }); return Promise.resolve({ kind: 'acknowledged' as const }); },
  };
  const beater = new Beater({ client, clock, state, ids: IDS, beatMs: 10_000, leaseMs: 60_000 });
  return { clock, state, calls, beater, renewals: () => calls.filter((c) => c.kind === 'renew') };
}
const granted = (sentAtMs: number, harness: 'running' | 'terminated' = 'running'): PermitOutcome => ({ kind: 'granted', sentAtMs, harness, grant: mintGrant({ granted: true, allocationId: IDS.allocationId, generation: 1, epoch: 1, podUid: 'p', leaseSeconds: 60, beatSeconds: 10 }) });
const denied = (code: 'not_renewable' | 'stale_epoch' | 'throttled' | 'review_unavailable', reason?: string): PermitOutcome =>
  ({ kind: 'denied', denial: { granted: false, code, retryable: code === 'throttled' || code === 'review_unavailable', ...(reason === undefined ? {} : { reason }) } });
const transport: PermitOutcome = { kind: 'transport', message: 'down' };

describe('W-019 the beat', () => {
  it('beats every 10 s from the grant, and a run of grants never fences', async () => {
    const r = rig((_n, at) => granted(at));
    r.beater.start(0);
    await r.clock.advance(100_000);
    const at = r.renewals().map((c) => c.at);
    expect(at.length).toBeGreaterThanOrEqual(9);
    expect(at.slice(0, 4)).toEqual([10_000, 20_000, 30_000, 40_000]);
    expect(r.state.state).toBe('running');
    await r.beater.stop();
  });

  it('with every renewal failing in transport the fence fires at the send time of the last grant plus 50 s, never later; control: one success at 40 s moves it', async () => {
    const dead = rig(() => transport);
    dead.beater.start(0);
    await dead.clock.advance(49_900);
    expect(dead.state.state).toBe('running'); // still inside
    await dead.clock.advance(300);
    expect(dead.state.state).toBe('fenced');
    expect(dead.state.fenceReason).toBe('fence_time');
    expect(dead.clock.now()).toBeLessThanOrEqual(50_300);
    // retried every 2 s in between, not every 10 s
    expect(dead.renewals().length).toBeGreaterThanOrEqual(15);

    const once = rig((n, at) => (at === 40_000 ? granted(at) : n >= 1 && at < 40_000 ? transport : transport));
    once.beater.start(0);
    await once.clock.advance(60_000);
    const grantTimes = once.renewals().map((c) => c.at).filter((t) => t === 40_000);
    expect(grantTimes).toEqual([40_000]);
    expect(once.beater.fenceAt).toBe(90_000); // the send time of the grant, plus 50 s
    expect(once.state.state).toBe('running');
    await once.clock.advance(31_000);
    expect(once.state.state).toBe('fenced');
  });

  it('not_renewable/stopping takes the ending path and sends one stop-ack; any other final denial is fenced at once; throttled and review_unavailable are retried', async () => {
    const stopping = rig(() => denied('not_renewable', 'stopping'));
    stopping.beater.start(0);
    await stopping.clock.advance(20_000);
    expect(stopping.state.state).toBe('ending');
    expect(stopping.state.stopFlag).toBe(true);
    expect(stopping.calls.filter((c) => c.kind === 'stopAck')).toHaveLength(1);
    await stopping.clock.advance(120_000); // well past the fence time: the disarmed timer leaves an ending supervisor ending
    expect(stopping.state.state).toBe('ending');
    const stale = rig(() => denied('stale_epoch'));
    stale.beater.start(0);
    await stale.clock.advance(11_000);
    expect(stale.state.state).toBe('fenced');
    expect(stale.state.fenceReason).toBe('denied_stale_epoch');
    expect(stale.calls.filter((c) => c.kind === 'stopAck')).toHaveLength(0);
    const flaky = rig((n, at) => (n <= 3 ? denied(n === 1 ? 'throttled' : 'review_unavailable') : granted(at)));
    flaky.beater.start(0);
    await flaky.clock.advance(30_000);
    expect(flaky.state.state).toBe('running'); // control: retryable ones do not fence while there is time
    expect(flaky.renewals().length).toBeGreaterThan(4);
  });

  it('hints: 1,000 inside one beat cause exactly one extra renewal; a hint while a renewal is in flight causes none; control: a single hint in running causes one', async () => {
    const r = rig((_n, at) => granted(at));
    r.beater.start(0);
    await r.clock.advance(10_000);
    const before = r.renewals().length;
    for (let i = 0; i < 1000; i += 1) r.beater.hint();
    await r.clock.advance(1000);
    expect(r.renewals().length).toBe(before + 1); // one early renewal
    for (let i = 0; i < 1000; i += 1) r.beater.hint();
    await r.clock.advance(1000);
    expect(r.renewals().length).toBe(before + 1); // the interval already had its hint
    await r.clock.advance(10_000);
    r.beater.hint();
    await r.clock.advance(100);
    expect(r.renewals().length).toBeGreaterThanOrEqual(before + 3); // control: the next interval takes one hint again
    await r.beater.stop();

    // in flight: a renewal that has not answered
    let release: (() => void) | undefined;
    const slow = rig((_n, at) => new Promise<PermitOutcome>((resolve) => { release = () => { resolve(granted(at)); }; }));
    slow.beater.start(0);
    await slow.clock.advance(10_000);
    const n = slow.renewals().length;
    expect(slow.beater.hint()).toBe(false); // in flight
    release?.();
    await flush();
    await slow.beater.stop();
    expect(slow.renewals().length).toBe(n);
  });

  it('a hint in preparing, ending, fenced, or after a grant reported the harness terminated causes none', async () => {
    const prep = rig((_n, at) => granted(at), { state: 'preparing' });
    prep.beater.start(0);
    expect(prep.beater.hint()).toBe(false);
    await prep.beater.stop();
    const ending = rig(() => denied('not_renewable', 'stopping'));
    ending.beater.start(0);
    await ending.clock.advance(11_000);
    expect(ending.state.state).toBe('ending');
    expect(ending.beater.hint()).toBe(false);
    const fenced = rig(() => denied('stale_epoch'));
    fenced.beater.start(0);
    await fenced.clock.advance(11_000);
    expect(fenced.beater.hint()).toBe(false);
    const gone = rig((_n, at) => granted(at, 'terminated'));
    gone.beater.start(0);
    await gone.clock.advance(11_000);
    expect(gone.state.harnessTerminated).toBe(true);
    expect(gone.beater.hint()).toBe(false);
    await gone.beater.stop();
    const live = rig((_n, at) => granted(at)); // control
    live.beater.start(0);
    await live.clock.advance(1000);
    expect(live.beater.hint()).toBe(true);
    await live.beater.stop();
  });

  it('a transport that hangs for the full 5 s limit on every call: the fence is noticed at the fence time (send time + 50 s), never at about s+62 as it was when it was checked only before each send; control: a client that ignores the deadline is fenced on time too', async () => {
    for (const honors of [true, false]) {
      const clock = new VirtualClock();
      const state = new State();
      state.set('running');
      const asked: Array<number | undefined> = [];
      const client = {
        renew: async (_ids: unknown, o?: { untilMs?: number }): Promise<PermitOutcome> => {
          asked.push(o?.untilMs);
          const left = honors && o?.untilMs !== undefined ? o.untilMs - clock.now() : Number.POSITIVE_INFINITY;
          await clock.sleep(Math.max(0, Math.min(5000, left))); // the request takes its whole limit
          return transport;
        },
        stopAck: (): Promise<{ kind: 'acknowledged' }> => Promise.resolve({ kind: 'acknowledged' as const }),
      };
      let fencedAt: number | undefined;
      state.onChange(() => { if (state.state === 'fenced' && fencedAt === undefined) fencedAt = clock.now(); });
      const beater = new Beater({ client, clock, state, ids: IDS, beatMs: 10_000, leaseMs: 60_000 });
      beater.start(0);
      await clock.advance(65_000);
      expect(state.state, `honors=${String(honors)}`).toBe('fenced');
      expect(fencedAt).toBeGreaterThanOrEqual(50_000);
      expect(fencedAt).toBeLessThanOrEqual(50_300); // fence time plus the clock's step, not later
      expect(asked.every((u) => u === 50_000)).toBe(true); // every request was told the fence time
      await beater.stop();
    }
  });
});
