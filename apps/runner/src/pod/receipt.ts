// The init container's termination message and the rules the runner reads it by (SI-25). Shared by both
// ends: the pod executor (17b) writes with encodeReceipt/encodeRefusal, the controller reads with
// parseMaterializeStatus.
//
// The message is per container, so the harness cannot write the materializer's. The policy is File,
// pinned in the manifest: under the fallback policy a failed step's log tail (Git and remote output)
// would arrive as the message. Everything here is linear and capped.
import type { MaterializeReceipt, WorkspaceErrorCode } from '@factory/workspace';
import type { ContainerStatus, KubePod } from '../kube/api.ts';

export const RECEIPT_SCHEMA = 'factory-pod-materialization/1';
export const MATERIALIZE_CONTAINER = 'materialize';
export const MAX_MESSAGE_BYTES = 4096;
export const MAX_REFUSAL_MESSAGE_BYTES = 512;
const MAX_STATUSES_SCANNED = 64;

const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const HEX64 = /^[0-9a-f]{64}$/;
const GIT_VERSION = /^git version [\x20-\x7e]{1,100}$/;
const CODE = /^[a-z_]{1,48}$/;
// eslint-disable-next-line no-control-regex -- the point is to strip control characters
const CONTROL = /[\u0000-\u001f\u007f]/g;

// Fixed key order: the encoder writes this and the parser requires exactly this text back.
const receiptBody = (r: MaterializeReceipt): string => `{"schema":"${RECEIPT_SCHEMA}","ok":true,"receipt":{"generation":${String(r.generation)},"gitVersion":${JSON.stringify(r.gitVersion)},"headCommit":${JSON.stringify(r.headCommit)},"treeDigest":${JSON.stringify(r.treeDigest)}}}`;
const refusalBody = (code: string, message: string): string => `{"schema":"${RECEIPT_SCHEMA}","ok":false,"code":${JSON.stringify(code)},"message":${JSON.stringify(message)}}`;

export const encodeReceiptMessage = (r: MaterializeReceipt): string => receiptBody(r);
// The refusal's message is cut to 512 bytes on a character boundary; control characters become spaces.
export function encodeRefusalMessage(code: WorkspaceErrorCode, message: string): string {
  let m = message.replace(CONTROL, ' ');
  while (Buffer.byteLength(m) > MAX_REFUSAL_MESSAGE_BYTES) m = m.slice(0, Math.max(0, m.length - Math.ceil((Buffer.byteLength(m) - MAX_REFUSAL_MESSAGE_BYTES) / 3)));
  return refusalBody(code, m);
}

export type MaterializeStatus =
  | { kind: 'not_finished' }                                   // no status yet, waiting, or still running
  | { kind: 'receipt'; receipt: MaterializeReceipt }           // exit 0 and a well-formed receipt
  | { kind: 'refusal'; code: string; message: string }         // non-zero exit and a well-formed refusal
  | { kind: 'failed'; exitCode: number }                       // non-zero exit and an empty message (stderr only)
  | { kind: 'invalid'; reason: 'too_long' | 'not_json' | 'not_canonical' | 'wrong_shape' | 'ambiguous_status' | 'bad_message_type' }
  | { kind: 'receipt_inconsistent'; exitCode: number };        // a receipt with a non-zero exit, or a refusal with exit 0

function parseBody(message: string): { ok: true; receipt: MaterializeReceipt } | { ok: false; code: string; message: string } | undefined {
  let v: unknown;
  try { v = JSON.parse(message); } catch { return undefined; }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort().join(',');
  if (o['schema'] !== RECEIPT_SCHEMA) return undefined;
  if (o['ok'] === true) {
    const r = o['receipt'];
    if (keys !== 'ok,receipt,schema' || typeof r !== 'object' || r === null || Array.isArray(r)) return undefined;
    const x = r as Record<string, unknown>;
    if (Object.keys(x).sort().join(',') !== 'generation,gitVersion,headCommit,treeDigest') return undefined;
    const { generation, gitVersion, headCommit, treeDigest } = x;
    if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 1) return undefined;
    if (typeof gitVersion !== 'string' || !GIT_VERSION.test(gitVersion)) return undefined;
    if (typeof headCommit !== 'string' || !COMMIT.test(headCommit)) return undefined;
    if (typeof treeDigest !== 'string' || !HEX64.test(treeDigest)) return undefined;
    return { ok: true, receipt: { generation, gitVersion, headCommit, treeDigest } };
  }
  if (o['ok'] === false) {
    if (keys !== 'code,message,ok,schema') return undefined;
    const { code, message: m } = o;
    if (typeof code !== 'string' || !CODE.test(code) || typeof m !== 'string' || Buffer.byteLength(m) > MAX_REFUSAL_MESSAGE_BYTES) return undefined;
    return { ok: false, code, message: m };
  }
  return undefined;
}

// Reads only the `materialize` init container of the pod. The app containers' statuses are never looked at.
export function parseMaterializeStatus(pod: Pick<KubePod, 'status'>): MaterializeStatus {
  const list = pod.status.initContainerStatuses;
  if (!Array.isArray(list)) return { kind: 'not_finished' };
  let found: ContainerStatus | undefined;
  let seen = 0;
  for (const s of list.slice(0, MAX_STATUSES_SCANNED)) {
    if (s.name === MATERIALIZE_CONTAINER) { seen += 1; found ??= s; }
  }
  if (seen > 1) return { kind: 'invalid', reason: 'ambiguous_status' };
  const t = found?.state.terminated;
  if (found === undefined || t === undefined) return { kind: 'not_finished' };
  const exitCode = t.exitCode;
  if (!Number.isSafeInteger(exitCode)) return { kind: 'invalid', reason: 'wrong_shape' };
  const raw = t.message ?? '';
  if (typeof raw !== 'string') return { kind: 'invalid', reason: 'bad_message_type' };
  if (Buffer.byteLength(raw) > MAX_MESSAGE_BYTES) return { kind: 'invalid', reason: 'too_long' };
  if (raw === '') return exitCode === 0 ? { kind: 'invalid', reason: 'not_json' } : { kind: 'failed', exitCode };
  const text = raw.endsWith('\n') ? raw.slice(0, -1) : raw; // the one line the entry writes may carry its newline
  const parsed = parseBody(text);
  if (parsed === undefined) {
    try { JSON.parse(text); } catch { return { kind: 'invalid', reason: 'not_json' }; }
    return { kind: 'invalid', reason: 'wrong_shape' };
  }
  // Strict canonical text: no duplicate keys, reordering or whitespace that the entry would not have written.
  const canonical = parsed.ok ? receiptBody(parsed.receipt) : refusalBody(parsed.code, parsed.message);
  if (canonical !== text) return { kind: 'invalid', reason: 'not_canonical' };
  // A receipt counts only with exit code 0, and a refusal only with a non-zero one.
  if (parsed.ok) return exitCode === 0 ? { kind: 'receipt', receipt: parsed.receipt } : { kind: 'receipt_inconsistent', exitCode };
  return exitCode !== 0 ? { kind: 'refusal', code: parsed.code, message: parsed.message } : { kind: 'receipt_inconsistent', exitCode };
}
