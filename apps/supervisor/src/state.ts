// The supervisor's one piece of shared state, and the signals the local endpoint's long polls wait on.
import { EventEmitter } from 'node:events';

export type SupervisorState = 'boot' | 'gating' | 'acquiring' | 'preparing' | 'running' | 'ending' | 'fenced';
export class State {
  readonly #events = new EventEmitter();
  #state: SupervisorState = 'boot';
  #stop = false;
  #harnessTerminated = false;
  #fenceReason: string | undefined;
  get state(): SupervisorState { return this.#state; }
  get stopFlag(): boolean { return this.#stop; }
  get harnessTerminated(): boolean { return this.#harnessTerminated; }
  get fenceReason(): string | undefined { return this.#fenceReason; }
  set(next: SupervisorState): void { this.#state = next; this.#events.emit('change'); }
  setStop(): void { this.#stop = true; this.#events.emit('change'); }
  fence(reason: string): void { this.#fenceReason ??= reason; this.#stop = true; this.#state = 'fenced'; this.#events.emit('change'); }
  // Once a grant reports the harness terminated, the start gate closes and every hint is dropped (the runner is already stopping the pod).
  harnessGone(): void { this.#harnessTerminated = true; this.#events.emit('change'); }
  onChange(f: () => void): () => void { this.#events.on('change', f); return () => { this.#events.off('change', f); }; }
  // The start decision for GET /v1/start: true once running; false once fenced or ending; undefined while it is not yet decided.
  startDecision(): { start: true } | { start: false; reason: string } | undefined {
    if (this.#state === 'running' && !this.#harnessTerminated && !this.#stop) return { start: true };
    if (this.#state === 'fenced' || this.#state === 'ending' || this.#harnessTerminated) return { start: false, reason: this.#fenceReason ?? this.#state };
    return undefined;
  }
}
