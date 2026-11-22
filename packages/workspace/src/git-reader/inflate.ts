// zlib for the reader (W-020a, 7.3). `inflateSync` always has `maxOutputLength` and never a `dictionary`
// (Z2, Z3). Node does not refuse data after the stream (Z1), so the bytes consumed are compared with
// the bytes expected by the caller. A cap of 0 is not allowed by Node (Z4): an object that declares
// size 0 is inflated with a cap of 1 and must give 0 bytes.
import { inflateSync } from 'node:zlib';
import { ReaderError, limitError, refuse } from './errors.ts';
import type { ReaderHooks } from './limits.ts';

export type Inflated = { out: Buffer; consumed: number };

export type InflateOptions = {
  // The most the stream may inflate to; exceeding it is `onTooLarge`.
  maxOutput: number;
  file: string;
  // What a stream that inflates past `maxOutput` is: a limit (a loose object, whose size is inside the stream) or a corrupt entry (a pack entry that lies about its size).
  onTooLarge: 'limit' | 'size_mismatch';
  limitName?: string;
};

export function inflateBounded(input: Buffer, o: InflateOptions): Inflated {
  try {
    const r = inflateSync(input, { maxOutputLength: Math.max(1, o.maxOutput), info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    return { out: r.buffer, consumed: r.engine.bytesWritten };
  } catch (e) {
    if (e instanceof ReaderError) throw e;
    const code = (e as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ERR_BUFFER_TOO_LARGE') {
      if (o.onTooLarge === 'limit') throw limitError(o.limitName ?? 'maxObjectBytes', 'an object inflates past its cap', o.file);
      throw refuse('object_corrupt', 'an entry inflates past the size its header declares', o.file);
    }
    if (code === 'Z_NEED_DICT') throw refuse('preset_dictionary', 'the stream needs a preset dictionary', o.file);
    if (code === 'Z_BUF_ERROR') throw refuse('truncated', 'the stream ends early', o.file);
    if (code === 'Z_DATA_ERROR') throw refuse('zlib_error', 'the stream is not valid zlib data', o.file);
    throw refuse('zlib_error', `inflate failed (${code ?? 'unknown'})`, o.file);
  }
}

// The stream must have consumed exactly the bytes the caller expected: the whole file for a loose object, the gap to the next object for a pack entry.
export function requireConsumed(r: Inflated, expected: number, file: string, hooks: ReaderHooks): void {
  if (hooks.skipTrailingDataCheck === true) return;
  if (r.consumed !== expected) throw refuse('trailing_data', 'bytes follow the end of the zlib stream', file);
}

// Compressed size can exceed the raw size a little: zlib's own bound for stored blocks.
export const deflateBound = (n: number): number => n + (n >> 9) + 128;
