// Retries a start-up step that can lose a race with a busy machine (for example the Temporal dev
// server missing its 5 s start window). Only for test infrastructure start-up, never for assertions.
export async function retryStart<T>(start: () => Promise<T>, attempts = 4, delayMs = 1500): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try { return await start(); } catch (e) { last = e; await new Promise((r) => setTimeout(r, delayMs * (i + 1))); }
  }
  throw last;
}
