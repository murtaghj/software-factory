import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { canonicalHash, canonicalJson } from '../src/index.ts';

describe('canonical JSON (RFC 8785-compatible)', () => {
  it('orders keys, drops undefined, keeps array order and uses ES number formatting', () => {
    expect(canonicalJson({ b: 1, a: [3, { z: true, y: null }], c: undefined, d: 1e21, e: 0.1 })).toBe('{"a":[3,{"y":null,"z":true}],"b":1,"d":1e+21,"e":0.1}');
    expect(canonicalJson({ 'é': 1, e: 2, Z: 3 })).toBe('{"Z":3,"e":2,"é":1}');
  });
  it('hashes the canonical form with SHA-256, so key order never changes the hash', () => {
    expect(canonicalHash({ a: 1, b: 2 })).toBe(canonicalHash({ b: 2, a: 1 }));
    expect(canonicalHash({ a: 1 })).toBe(createHash('sha256').update('{"a":1}').digest('hex'));
    expect(() => canonicalJson({ x: Number.NaN })).toThrow();
  });
});
