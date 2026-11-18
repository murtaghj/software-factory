// Deterministic names, ids and labels (06-runner-workspaces.md:14). Pure functions of their inputs, so two
// controllers that race compute the same ones.
import { createHash } from 'node:crypto';
import { RunnerError } from './errors.ts';

const MAX_INPUT = 256; // every hashed input is capped before hashing
const capped = (label: string, v: string): string => {
  if (typeof v !== 'string' || v === '' || Buffer.byteLength(v) > MAX_INPUT) throw new RunnerError('invalid_request', `${label} is empty or longer than ${String(MAX_INPUT)} bytes`);
  return v;
};
const sha = (parts: readonly string[]): Buffer => createHash('sha256').update(parts.join('\n')).digest();

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
export function base32(bytes: Uint8Array): string {
  let bits = 0; let value = 0; let out = '';
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31] ?? ''; bits -= 5; }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31] ?? '';
  return out;
}
const h20 = (a: string, b: string): string => base32(createHash('sha256').update(`${a}|${b}`).digest()).slice(0, 20);
const gen = (g: number): string => { if (!Number.isSafeInteger(g) || g < 1) throw new RunnerError('invalid_request', 'generation must be a positive integer'); return String(g); };

export const jobName = (orgId: string, logicalId: string, generation: number): string => `factory-${h20(capped('org id', orgId), capped('logical id', logicalId))}-g${gen(generation)}`;
export const pvcName = (orgId: string, workspaceId: string, generation: number): string => `factory-ws-${h20(capped('org id', orgId), capped('workspace id', workspaceId))}-g${gen(generation)}`;
export const checkpointJobName = (orgId: string, receiptId: string): string => `factory-${h20(capped('org id', orgId), capped('receipt id', receiptId))}-c`;

// Version-8 UUID from SHA-256, in the manner of deriveWorkspaceId.
export function v8Uuid(parts: readonly string[]): string {
  const b = Buffer.from(sha(parts).subarray(0, 16));
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x80;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const x = b.toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}
export const allocationId = (orgId: string, logicalId: string, generation: number): string => v8Uuid(['factory-allocation/1', capped('org id', orgId), capped('logical id', logicalId), gen(generation)]);
export const cancelRecordId = (orgId: string, logicalId: string): string => v8Uuid(['factory-run-cancel/1', capped('org id', orgId), capped('logical id', logicalId)]);
export const writerStartId = (orgId: string, allocationId: string): string => v8Uuid(['factory-writer-start/1', capped('org id', orgId), capped('allocation id', allocationId)]);
export const stopAckId = (orgId: string, allocationId: string): string => v8Uuid(['factory-stop-ack/1', capped('org id', orgId), capped('allocation id', allocationId)]);
export const cancelStopId = (orgId: string, allocationId: string): string => v8Uuid(['factory-cancel-stop/1', capped('org id', orgId), capped('allocation id', allocationId)]);
export const urgentStopId = (orgId: string, logicalId: string): string => v8Uuid(['factory-run-urgent-stop/1', capped('org id', orgId), capped('logical id', logicalId)]);
export const tokenAudience = (orgId: string, allocId: string): string => `factory-allocation:${orgId}:${allocId}`;

// Label values: the first 32 hex characters of a SHA-256 of the full value (the full one is an annotation).
export const hashLabel = (v: string): string => createHash('sha256').update(v).digest('hex').slice(0, 32);

export const labelKeys = (prefix: string) => ({
  org: `${prefix}org`, task: `${prefix}task`, allocation: `${prefix}allocation`, workspace: `${prefix}workspace`, generation: `${prefix}generation`,
  stageRun: `${prefix}stage-run`, specHash: `${prefix}spec-hash`,
});
export const annotationKeys = (prefix: string) => ({
  org: `${prefix}org`, task: `${prefix}task`, allocation: `${prefix}allocation`, stageRunFull: `${prefix}stage-run-full`, specHashFull: `${prefix}spec-hash-full`,
  ownerEpoch: `${prefix}owner-epoch`, manifestDigest: `${prefix}manifest-digest`,
});
