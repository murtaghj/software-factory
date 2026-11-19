// The beat (section 6, "The supervisor"). Every `beatSeconds` from the grant, with a 5 s request limit. The fence time is the SEND time of the last granted call plus
// `leaseSeconds - beatSeconds` (50 s) on the monotonic clock: every grant refreshed the server's lease after that send (rule 4, the acquire retry included), so the
// supervisor always gives up first. Transport errors, `throttled` and `review_unavailable` are retried every 2 s until the fence time. A hint is coalesced: at most
// one early renewal per beat interval, never while a renewal is in flight, and only in `running` before the harness has been reported terminated.
import type { PermitDenialAnswer } from '@factory/runner-protocol';
import type { Ids, PermitOutcome, RunnerClient } from './runner-client.ts';
import type { State } from './state.ts';

export type Clock = { now: () => number; sleep: (ms: number, wake?: AbortSignal) => Promise<void> };
export type BeatOptions = {
  client: { renew: (ids: Ids, o?: { untilMs?: number }) => Promise<PermitOutcome>; stopAck: RunnerClient['stopAck'] }; clock: Clock; state: State; ids: Ids; beatMs: number; leaseMs: number; retryMs?: number;
  log?: (event: string, detail?: Record<string, unknown>) => void;
  // Hints are coalesced unless a TEST entry turns it off (the control of the hint-flood test, which shows what the runner's per-pod bucket does when the supervisor does not).
  coalesce?: boolean;
};

const RETRYABLE = new Set(['throttled', 'review_unavailable', 'not_ready']);

export class Beater {
  readonly #o: BeatOptions;
  #fenceAt = 0;
  #nextAt = 0;          // when the next REGULAR beat is due; an early (hinted) renewal does not move it
  #inFlight = false;
  #hintPending = false;
  #hintedThisInterval = false;
  #wake: AbortController | undefined;
  #fenceTimer: AbortController | undefined;
  #stopped = false;
  #run: Promise<void> = Promise.resolve();
  readonly renewals: number[] = []; // send times, for the tests

  constructor(o: BeatOptions) { this.#o = o; }
  // A method, not a field read: the flag changes while a call is awaited, which the compiler's narrowing cannot see.
  #isStopped(): boolean { return this.#stopped; }
  get fenceAt(): number { return this.#fenceAt; }
  // The start gate opens only while the local fence time has not passed.
  get fenceOpen(): boolean { return this.#o.clock.now() < this.#fenceAt; }

  start(acquiredSentAtMs: number): void {
    this.#fenceAt = acquiredSentAtMs + this.#o.leaseMs - this.#o.beatMs;
    this.#nextAt = acquiredSentAtMs + this.#o.beatMs;
    this.#armFence();
    this.#run = this.#loop();
  }
  async stop(): Promise<void> { this.#stopped = true; this.#wake?.abort(); this.#fenceTimer?.abort(); await this.#run; }

  // The fence is noticed on a TIMER at the fence time, not only before the next send: a request in flight (up to its limit, then a retry's) must not carry the
  // supervisor past the point at which the server's lease may already be gone. The timer is re-armed at every grant, which moves the fence.
  #armFence(): void {
    this.#fenceTimer?.abort();
    const ctl = new AbortController();
    this.#fenceTimer = ctl;
    const wait = Math.max(0, this.#fenceAt - this.#o.clock.now());
    void this.#o.clock.sleep(wait, ctl.signal).then(() => {
      if (ctl.signal.aborted || this.#stopped) return;
      if (this.#o.clock.now() >= this.#fenceAt) { this.#fence('fence_time'); this.#wake?.abort(); } else this.#armFence();
    });
  }

  // A hint from the harness's launcher. Nothing decides on it (rule 5); it can only make a renewal come sooner, and at most once per beat interval, so a harness that
  // loops on the hint doubles its own pod's renewals at most.
  hint(): boolean {
    const s = this.#o.state;
    if (s.state !== 'running' || s.harnessTerminated || this.#inFlight || (this.#hintedThisInterval && this.#o.coalesce !== false) || this.#stopped) return false;
    this.#hintedThisInterval = true;
    this.#hintPending = true;
    this.#wake?.abort();
    return true;
  }

  async #loop(): Promise<void> {
    const o = this.#o;
    const retry = o.retryMs ?? 2000;
    while (!this.#stopped && (o.state.state === 'preparing' || o.state.state === 'running')) {
      this.#wake = new AbortController();
      if (!this.#hintPending) await o.clock.sleep(Math.max(0, this.#nextAt - o.clock.now()), this.#wake.signal);
      if (this.#isStopped()) return;
      if (o.clock.now() >= this.#fenceAt) { this.#fence('fence_time'); return; }
      const early = this.#hintPending;
      if (!early && o.clock.now() < this.#nextAt) continue; // woken for nothing
      this.#hintPending = false;
      this.#inFlight = true;
      const sent = o.clock.now();
      if (!early) { this.#nextAt = sent + o.beatMs; this.#hintedThisInterval = false; }
      this.renewals.push(sent);
      let r: PermitOutcome;
      try { r = await o.client.renew(o.ids, { untilMs: this.#fenceAt }); } finally { this.#inFlight = false; }
      if (this.#isStopped() || (o.state.state as string) === 'fenced') return;
      if (r.kind === 'granted') {
        this.#fenceAt = sent + o.leaseMs - o.beatMs;
        this.#armFence();
        if (r.harness === 'terminated') { o.state.harnessGone(); o.log?.('harness_terminated'); }
        continue;
      }
      if (r.kind === 'denied') {
        const d: PermitDenialAnswer = r.denial;
        if (d.code === 'not_renewable' && d.reason === 'stopping') { await this.#ending(); return; }
        if (!RETRYABLE.has(d.code)) { this.#fence(`denied_${d.code}`); return; }
      }
      // A transport error or a retryable denial: again in 2 s, until the fence time.
      this.#nextAt = o.clock.now() + retry;
    }
  }

  async #ending(): Promise<void> {
    const o = this.#o;
    o.state.set('ending');
    this.#fenceTimer?.abort(); // a supervisor that is ending is not fenced; the timer must not flip its state while it waits for TERM
    o.state.setStop();
    o.log?.('ending');
    // One acknowledgement; the runner answers and then runs the pass that deletes the pod.
    const r = await o.client.stopAck(o.ids);
    o.log?.('stop_ack', { kind: r.kind });
  }

  #fence(reason: string): void { this.#o.state.fence(reason); this.#o.log?.('fenced', { reason }); }
}
