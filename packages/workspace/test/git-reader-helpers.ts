// Small assertions shared by the reader's test files (W-020a).
import { expect } from 'vitest';
import { ReaderError, type ReaderErrorCode } from '../src/git-reader/errors.ts';

// Runs `f` and returns the ReaderError it throws; fails the test if it throws anything else or nothing.
export function refusal(f: () => unknown): ReaderError {
  try { f(); } catch (e) {
    if (e instanceof ReaderError) return e;
    throw new Error(`expected a ReaderError, got ${String(e)}`, { cause: e });
  }
  throw new Error('expected a refusal, but the call succeeded');
}

export async function refusalAsync(f: () => Promise<unknown>): Promise<ReaderError> {
  try { await f(); } catch (e) {
    if (e instanceof ReaderError) return e;
    throw new Error(`expected a ReaderError, got ${String(e)}`, { cause: e });
  }
  throw new Error('expected a refusal, but the call succeeded');
}

export function expectCode(e: ReaderError, code: ReaderErrorCode, reasonPart?: string): void {
  expect(e.code).toBe(code);
  if (reasonPart !== undefined) expect(e.reason ?? '').toContain(reasonPart);
}
