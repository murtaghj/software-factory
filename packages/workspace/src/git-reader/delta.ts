// Git delta streams (W-020a, 7.3 "Deltas"): a header of two varints (the base size, the result size)
// and then copy and insert instructions. Everything is bounds-checked; the result size is charged to the
// work budget before the first byte is written, so a chain of tiny deltas that each copy 32 MiB pays for
// every copy (review, Furio M2).
import { limitError, refuse } from './errors.ts';
import type { Budget } from './limits.ts';

function varint(buf: Buffer, pos: number, file: string): { value: number; next: number } {
  let value = 0;
  let scale = 1;
  let p = pos;
  for (let i = 0; i < 10; i += 1) {
    const b = buf[p];
    if (b === undefined) throw refuse('object_corrupt', 'a delta header ends early', file);
    p += 1;
    value += (b & 0x7f) * scale;
    if (value > Number.MAX_SAFE_INTEGER) throw refuse('object_corrupt', 'a delta size is out of range', file);
    if ((b & 0x80) === 0) return { value, next: p };
    scale *= 128;
  }
  throw refuse('object_corrupt', 'a delta size varint is too long', file);
}

export function applyDelta(base: Buffer, delta: Buffer, budget: Budget, file: string): Buffer {
  const h1 = varint(delta, 0, file);
  const h2 = varint(delta, h1.next, file);
  if (h1.value !== base.length) throw refuse('object_corrupt', 'the delta names a base of another size', file);
  const resultSize = h2.value;
  if (resultSize > budget.limits.maxObjectBytes) throw limitError('maxObjectBytes', 'a delta result is larger than the object limit', file);
  budget.charge(resultSize);
  const out = Buffer.allocUnsafe(resultSize);
  let written = 0;
  let p = h2.next;
  while (p < delta.length) {
    const op = delta[p] ?? 0;
    p += 1;
    if (op === 0) throw refuse('object_corrupt', 'delta opcode 0 is reserved', file);
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) {
        if ((op & (1 << i)) === 0) continue;
        const b = delta[p];
        if (b === undefined) throw refuse('object_corrupt', 'a delta copy ends early', file);
        offset += b * 256 ** i;
        p += 1;
      }
      for (let i = 0; i < 3; i += 1) {
        if ((op & (0x10 << i)) === 0) continue;
        const b = delta[p];
        if (b === undefined) throw refuse('object_corrupt', 'a delta copy ends early', file);
        size += b * 256 ** i;
        p += 1;
      }
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) throw refuse('object_corrupt', 'a delta copy lies outside its base', file);
      if (written + size > resultSize) throw refuse('object_corrupt', 'a delta writes past its result size', file);
      base.copy(out, written, offset, offset + size);
      written += size;
    } else {
      if (p + op > delta.length) throw refuse('object_corrupt', 'a delta insert ends early', file);
      if (written + op > resultSize) throw refuse('object_corrupt', 'a delta writes past its result size', file);
      delta.copy(out, written, p, p + op);
      written += op;
      p += op;
    }
  }
  if (written !== resultSize) throw refuse('object_corrupt', 'a delta writes fewer bytes than its result size', file);
  return out;
}
