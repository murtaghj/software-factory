// Resumable task event stream client (AC-52). Connects with Last-Event-ID = the last applied
// sequence; on 410 EventCursorExpired it refreshes the snapshot and resumes after the snapshot's
// lastEventSequence (never earlier than resumeAfterSequence); on disconnect it reconnects.
import type { EventCursorExpired, TaskEvent, TaskView } from '@factory/contracts';
import { parseSse } from './sse.ts';
import type { TaskStore } from './store.ts';

export type StreamOptions = {
  apiBase: string;
  taskId: string;
  token: () => Promise<string>;
  store: TaskStore;
  fetchImpl?: typeof fetch;
  reconnectDelayMs?: number;
};

export class TaskEventStream {
  private readonly o: StreamOptions;
  private abort = new AbortController();
  private stopped = false;
  refreshes = 0;
  constructor(o: StreamOptions) { this.o = o; }

  private async headers(): Promise<Record<string, string>> {
    return { authorization: `Bearer ${await this.o.token()}` };
  }

  async refreshSnapshot(minimum = 0): Promise<void> {
    this.o.store.setConnection('refreshing');
    const res = await (this.o.fetchImpl ?? fetch)(`${this.o.apiBase}/v2/tasks/${this.o.taskId}`, { headers: await this.headers(), signal: this.abort.signal });
    if (!res.ok) throw new Error(`snapshot refresh failed: ${String(res.status)}`);
    const view = await res.json() as TaskView;
    if (view.lastEventSequence < minimum) throw new Error('snapshot is older than the expired cursor');
    this.o.store.applySnapshot(view);
    this.refreshes += 1;
  }

  // Runs until stop(); each connection resumes after the last applied sequence.
  async run(): Promise<void> {
    while (!this.isStopped()) {
      try {
        await this.connectOnce();
      } catch {
        // dropped connection or transient failure: fall through to reconnect
      }
      if (this.isStopped()) return;
      this.o.store.setConnection('disconnected');
      await new Promise((r) => setTimeout(r, this.o.reconnectDelayMs ?? 500));
    }
  }

  private async connectOnce(): Promise<void> {
    this.o.store.setConnection('connecting');
    const res = await (this.o.fetchImpl ?? fetch)(`${this.o.apiBase}/v2/tasks/${this.o.taskId}/events`, {
      headers: { ...(await this.headers()), 'last-event-id': String(this.o.store.state.lastEventSequence), accept: 'text/event-stream' },
      signal: this.abort.signal,
    });
    if (res.status === 410) {
      const expired = await res.json() as EventCursorExpired;
      await this.refreshSnapshot(expired.resumeAfterSequence);
      return;
    }
    if (!res.ok || !res.body) throw new Error(`event stream failed: ${String(res.status)}`);
    this.o.store.setConnection('live');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      const { messages, rest } = parseSse(buffer);
      buffer = rest;
      for (const m of messages) {
        if (m.event === 'reauthenticate') { this.o.store.setConnection('disconnected'); this.stop(); return; }
        const outcome = this.o.store.applyEvent(JSON.parse(m.data) as TaskEvent);
        if (outcome === 'gap') { await this.refreshSnapshot(); return; }
      }
    }
  }

  private isStopped(): boolean { return this.stopped; }

  stop(): void {
    this.stopped = true;
    this.abort.abort();
  }

  // Simulates a dropped connection without stopping the client (used by tests and the UI retry).
  dropConnection(): void {
    this.abort.abort();
    this.abort = new AbortController();
  }
}
