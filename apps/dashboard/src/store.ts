// Client-side task state (W-014; AC-04 and AC-52 on the client). Events apply strictly in sequence
// order and exactly once; an older snapshot or event can never overwrite newer state, and a second
// event claiming an already-applied sequence with different identity is an integrity error.
import type { TaskEvent, TaskView } from '@factory/contracts';

export type Connection = 'connecting' | 'live' | 'disconnected' | 'refreshing';
export type StoreState = {
  task?: TaskView;
  lastEventSequence: number;
  events: TaskEvent[];
  connection: Connection;
  integrityErrors: string[];
  gapDetected: boolean;
};

export class TaskStore {
  private s: StoreState = { lastEventSequence: 0, events: [], connection: 'connecting', integrityErrors: [], gapDetected: false };
  private readonly seen = new Map<number, string>();
  private readonly listeners = new Set<(s: StoreState) => void>();

  get state(): StoreState { return this.s; }
  subscribe(fn: (s: StoreState) => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private emit(next: Partial<StoreState>): void { this.s = { ...this.s, ...next }; for (const l of this.listeners) l(this.s); }

  setConnection(connection: Connection): void { this.emit({ connection }); }

  // Returns 'applied', 'duplicate', 'stale', 'gap' or 'conflict'.
  applyEvent(e: TaskEvent): 'applied' | 'duplicate' | 'stale' | 'gap' | 'conflict' {
    const known = this.seen.get(e.sequence);
    if (known !== undefined) {
      if (known === e.eventId) return 'duplicate';
      this.emit({ integrityErrors: [...this.s.integrityErrors, `sequence ${String(e.sequence)} delivered twice with different identities`] });
      return 'conflict';
    }
    if (e.sequence <= this.s.lastEventSequence) return 'stale';
    if (e.sequence !== this.s.lastEventSequence + 1) { this.emit({ gapDetected: true }); return 'gap'; }
    this.seen.set(e.sequence, e.eventId);
    this.emit({ lastEventSequence: e.sequence, events: [...this.s.events, e].slice(-500), gapDetected: false });
    return 'applied';
  }

  // A snapshot is accepted only if it is not older than what is already applied.
  applySnapshot(view: TaskView): 'applied' | 'stale' {
    const cur = this.s.task;
    if (view.lastEventSequence < this.s.lastEventSequence || (cur && view.projectionSequence < cur.projectionSequence)) return 'stale';
    this.emit({ task: view, lastEventSequence: view.lastEventSequence, gapDetected: false });
    return 'applied';
  }
}
