// Named fault points (stand-in for the crash-injection framework, W-079). Production code calls
// `faults.hit(name)` at a named place; the default hook does nothing. A test arms a point to throw
// (the pass that reaches it dies) or to hold (the pass waits there until the test releases it), so a
// crash or a forced interleaving happens exactly between two named steps.
export const RUNNER_FAULT_POINTS = [
  'runner.in_allocate_tx', 'runner.after_allocate_commit', 'runner.after_pvc_create', 'runner.after_job_create', 'runner.after_job_bind',
  'runner.after_permit_claim', 'runner.before_writer_started', 'runner.after_writer_started', 'runner.before_permit_commit', 'runner.after_job_delete', 'runner.after_pvc_delete',
] as const;
export type RunnerFaultPoint = (typeof RUNNER_FAULT_POINTS)[number];

export interface FaultHook {
  hit(name: string): Promise<void>;
}
export const NO_FAULTS: FaultHook = { hit: () => Promise.resolve() };

export class InjectedFault extends Error {
  readonly point: string;
  constructor(point: string) {
    super(`injected fault at ${point}`);
    this.name = 'InjectedFault';
    this.point = point;
  }
}

export type Hold = { reached: Promise<void>; release: () => void };

type Armed = { kind: 'throw'; error: Error; times: number } | { kind: 'hold'; reachedResolve: () => void; gate: Promise<void>; thenThrow?: Error };

export class Faults implements FaultHook {
  readonly #armed = new Map<string, Armed[]>();
  readonly #hits = new Map<string, number>();

  // The next `times` visits throw `error` (default: an InjectedFault).
  throwAt(name: string, opts: { times?: number; error?: Error } = {}): void {
    this.#push(name, { kind: 'throw', error: opts.error ?? new InjectedFault(name), times: opts.times ?? 1 });
  }
  // The next visit waits until `release()`; `reached` resolves when a pass is waiting there. With `thenThrow`, the
  // released visit fails with that error instead of continuing.
  holdAt(name: string, opts: { thenThrow?: Error } = {}): Hold {
    let release!: () => void;
    let reachedResolve!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const reached = new Promise<void>((r) => { reachedResolve = r; });
    this.#push(name, { kind: 'hold', reachedResolve, gate, ...(opts.thenThrow ? { thenThrow: opts.thenThrow } : {}) });
    return { reached, release };
  }
  hits(name: string): number { return this.#hits.get(name) ?? 0; }
  clear(): void { this.#armed.clear(); }

  #push(name: string, a: Armed): void {
    const list = this.#armed.get(name) ?? [];
    list.push(a);
    this.#armed.set(name, list);
  }

  async hit(name: string): Promise<void> {
    this.#hits.set(name, this.hits(name) + 1);
    const list = this.#armed.get(name);
    const next = list?.[0];
    if (!list || !next) return;
    if (next.kind === 'throw') {
      next.times -= 1;
      if (next.times <= 0) list.shift();
      throw next.error;
    }
    list.shift();
    next.reachedResolve();
    await next.gate;
    if (next.thenThrow) throw next.thenThrow;
  }
}
