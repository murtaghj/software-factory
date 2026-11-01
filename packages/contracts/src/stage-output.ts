// Harness/stage output decoding and bounded format repair (W-003, AC-18).
//
// Malformed, unsupported or schema-invalid agent output is never a StageOutcome, so it can never be
// handed to the gate evaluator. A submit_result call that fails validation returns bounded feedback
// (FactoryToolError invalid_schema) and consumes one tool call from the run's declared RunLimits;
// correction is only possible inside that budget (chapter 07: "schema errors return bounded feedback
// and permit correction within existing turn/tool/time budgets"). When the budget is exhausted the
// stage finishes inconclusive, never completed (INV-11).
import type { ControllerStageResult, FactoryToolError, Role, RunLimits, StageOutcome, StageResult, SubmitResultToolInputV12 } from './generated/domain.ts';
import { assertContract, validateContract, type ContractError } from './validate.ts';

export const SUPPORTED_ENVELOPE_MAJOR = 2;
export const MAX_FEEDBACK_ERRORS = 10;
export const MAX_FEEDBACK_MESSAGE_CHARS = 2000;
// Total serialized size of the feedback returned for one rejected submission.
export const MAX_FEEDBACK_BYTES = 4096;
const MAX_FIELD_CHARS = 200;
// Only these Ajv error params are echoed back, each truncated; everything else is dropped.
const FEEDBACK_PARAMS = ['missingProperty', 'additionalProperty', 'allowedValue', 'allowedValues', 'limit', 'format', 'type', 'pattern'] as const;

export type DecodeFailure = {
  ok: false;
  reason: 'malformed_json' | 'not_an_object' | 'oversize' | 'unsupported_version' | 'schema_invalid' | 'binding_mismatch';
  errors: ContractError[];
};
export type Decoded<T> = { ok: true; value: T } | DecodeFailure;

function byteLength(raw: unknown): number {
  if (typeof raw === 'string') return Buffer.byteLength(raw, 'utf8');
  try {
    const text = JSON.stringify(raw) as string | undefined;
    return text === undefined ? 0 : Buffer.byteLength(text, 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY; // cyclic or unserializable: treat as oversize
  }
}

function parse(raw: unknown, maxBytes?: number): Decoded<Record<string, unknown>> {
  if (maxBytes !== undefined && byteLength(raw) > maxBytes) {
    return { ok: false, reason: 'oversize', errors: [{ path: '', keyword: 'maxBytes', message: `output exceeds ${String(maxBytes)} bytes`, params: { limit: maxBytes } }] };
  }
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch (e) {
      return { ok: false, reason: 'malformed_json', errors: [{ path: '', keyword: 'json', message: e instanceof Error ? e.message : 'invalid JSON', params: {} }] };
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'not_an_object', errors: [{ path: '', keyword: 'type', message: 'must be a JSON object', params: {} }] };
  }
  return { ok: true, value: value as Record<string, unknown> };
}

// Readers reject unknown major versions before schema validation so the error is explicit.
function checkMajor(value: Record<string, unknown>): DecodeFailure | undefined {
  const version = value.schemaVersion;
  if (typeof version !== 'string') return undefined; // the schema reports the missing/invalid field
  const major = Number.parseInt(version.split('.')[0] ?? '', 10);
  if (major !== SUPPORTED_ENVELOPE_MAJOR) {
    return { ok: false, reason: 'unsupported_version', errors: [{ path: '/schemaVersion', keyword: 'version', message: `unsupported major version ${version}`, params: { supported: SUPPORTED_ENVELOPE_MAJOR } }] };
  }
  return undefined;
}

// Shape-only decoding of either producer kind. Use decodeRunnerResult/decodeControllerResult at a
// trust boundary: they also require the exact expected producer kind and stage input binding.
export function decodeStageOutcome(raw: unknown, maxBytes?: number): Decoded<StageOutcome> {
  const parsed = parse(raw, maxBytes);
  if (!parsed.ok) return parsed;
  const versionFailure = checkMajor(parsed.value);
  if (versionFailure) return versionFailure;
  const result = validateContract('StageOutcome', parsed.value);
  return result.ok ? { ok: true, value: result.value } : { ok: false, reason: 'schema_invalid', errors: result.errors };
}

// The binding the factory issued for this stage run. A result naming any other organization, task,
// stage, input hash or allocation epoch is rejected (INV-04, chapter 05 shared stage contract).
export type ExpectedRunnerBinding = { orgId: string; taskId: string; stageRunId: string; inputHash: string; allocationEpoch: number };
export type ExpectedControllerBinding = Omit<ExpectedRunnerBinding, 'allocationEpoch'>;

function bindingErrors(value: Record<string, unknown>, expected: Record<string, unknown>): ContractError[] {
  return Object.entries(expected).filter(([k, v]) => value[k] !== v).map(([k]) => ({ path: `/${k}`, keyword: 'binding', message: `${k} does not match the issued stage binding`, params: {} }));
}

function decodeBound<T>(raw: unknown, definition: 'StageResult' | 'ControllerStageResult', expected: Record<string, unknown>, maxBytes?: number): Decoded<T> {
  const parsed = parse(raw, maxBytes);
  if (!parsed.ok) return parsed;
  const versionFailure = checkMajor(parsed.value);
  if (versionFailure) return versionFailure;
  const result = validateContract(definition, parsed.value);
  if (!result.ok) return { ok: false, reason: 'schema_invalid', errors: result.errors };
  const mismatched = bindingErrors(parsed.value, expected);
  if (mismatched.length > 0) return { ok: false, reason: 'binding_mismatch', errors: mismatched };
  return { ok: true, value: result.value as T };
}

export function decodeRunnerResult(raw: unknown, expected: ExpectedRunnerBinding, maxBytes?: number): Decoded<StageResult> {
  return decodeBound<StageResult>(raw, 'StageResult', expected, maxBytes);
}

export function decodeControllerResult(raw: unknown, expected: ExpectedControllerBinding, maxBytes?: number): Decoded<ControllerStageResult> {
  return decodeBound<ControllerStageResult>(raw, 'ControllerStageResult', expected, maxBytes);
}

export type SubmissionReceipt =
  | { state: 'accepted'; submission: SubmitResultToolInputV12; toolCallsUsed: number }
  | { state: 'duplicate'; submission: SubmitResultToolInputV12; toolCallsUsed: number }
  | { state: 'rejected'; error: FactoryToolError; feedback: ContractError[]; toolCallsUsed: number; toolCallsRemaining: number };

const clip = (v: string): string => (v.length > MAX_FIELD_CHARS ? `${v.slice(0, MAX_FIELD_CHARS)}…` : v);

function sanitizeParams(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of FEEDBACK_PARAMS) {
    const v = params[key];
    if (typeof v === 'string') out[key] = clip(v);
    else if (typeof v === 'number' || typeof v === 'boolean') out[key] = v;
    else if (Array.isArray(v)) out[key] = (v as unknown[]).slice(0, 10).map((x) => clip(String(x)));
  }
  return out;
}

// Feedback is bounded by count, per-field length and total bytes; agent-supplied keys/values are
// truncated so the response can never echo an unbounded payload.
export function boundedFeedback(errors: ContractError[]): ContractError[] {
  const out: ContractError[] = [];
  let bytes = 2;
  for (const e of errors.slice(0, MAX_FEEDBACK_ERRORS)) {
    const item: ContractError = { path: clip(e.path), keyword: clip(e.keyword), message: clip(e.message), params: sanitizeParams(e.params) };
    const size = Buffer.byteLength(JSON.stringify(item), 'utf8') + 1;
    if (bytes + size > MAX_FEEDBACK_BYTES) break;
    bytes += size;
    out.push(item);
  }
  return out;
}

function toolError(code: FactoryToolError['code'], message: string, retryable: boolean): FactoryToolError {
  return { code, retryable, message: message.slice(0, MAX_FEEDBACK_MESSAGE_CHARS) };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// One ledger per semantic stage run. The server derives the expected role from the allocation; the
// agent cannot select it. Every submit_result call, valid or not, consumes one tool call, and no
// call is accepted after the run's wall-clock deadline. The turn budget (RunLimits.maxTurns) is
// enforced by the execution supervisor that drives the harness (W-021/W-035), not by this ledger.
export class SubmissionLedger {
  readonly expectedRole: Role;
  readonly limits: RunLimits;
  readonly deadlineMs: number;
  private toolCallsUsed: number;
  private accepted: { submission: SubmitResultToolInputV12; canonical: string } | undefined;

  constructor(expectedRole: Role, limits: RunLimits, options: { startedAtMs: number; toolCallsAlreadyUsed?: number }) {
    this.limits = assertContract('RunLimits', limits); // fail closed on missing/NaN/negative limits
    this.expectedRole = assertContract('Role', expectedRole);
    const used = options.toolCallsAlreadyUsed ?? 0;
    if (!Number.isSafeInteger(used) || used < 0) throw new RangeError('toolCallsAlreadyUsed must be a non-negative integer');
    if (!Number.isFinite(options.startedAtMs)) throw new RangeError('startedAtMs must be a finite timestamp');
    this.toolCallsUsed = used;
    this.deadlineMs = options.startedAtMs + this.limits.wallSeconds * 1000;
  }

  get used(): number { return this.toolCallsUsed; }
  get remaining(): number { return Math.max(0, this.limits.maxToolCalls - this.toolCallsUsed); }
  get acceptedSubmission(): SubmitResultToolInputV12 | undefined { return this.accepted?.submission; }

  submit(raw: unknown, nowMs: number): SubmissionReceipt {
    if (!(nowMs < this.deadlineMs)) {
      return { state: 'rejected', error: toolError('cap_exhausted', 'run wall-clock budget exhausted; no further corrections are accepted', false), feedback: [], toolCallsUsed: this.toolCallsUsed, toolCallsRemaining: this.remaining };
    }
    if (this.remaining === 0) {
      return { state: 'rejected', error: toolError('cap_exhausted', 'tool-call budget exhausted; no further corrections are accepted', false), feedback: [], toolCallsUsed: this.toolCallsUsed, toolCallsRemaining: 0 };
    }
    this.toolCallsUsed += 1;
    const reject = (code: FactoryToolError['code'], message: string, feedback: ContractError[]): SubmissionReceipt => ({
      state: 'rejected', error: toolError(code, message, code === 'invalid_schema' && this.remaining > 0), feedback: boundedFeedback(feedback), toolCallsUsed: this.toolCallsUsed, toolCallsRemaining: this.remaining,
    });
    const parsed = parse(raw, this.limits.maxOutputBytes);
    if (!parsed.ok) return reject('invalid_schema', `submission rejected: ${parsed.reason}`, parsed.errors);
    const result = validateContract('SubmitResultToolInputV12', parsed.value);
    if (!result.ok) return reject('invalid_schema', `submission does not match SubmitResultToolInput 1.2.0 (${String(result.errors.length)} errors)`, result.errors);
    if (result.value.output.role !== this.expectedRole) {
      return reject('forbidden', `submission role ${result.value.output.role} does not match the allocation role ${this.expectedRole}`, []);
    }
    const text = canonical(result.value);
    if (this.accepted) {
      if (this.accepted.canonical === text) return { state: 'duplicate', submission: this.accepted.submission, toolCallsUsed: this.toolCallsUsed };
      return reject('conflict', 'a different submission was already accepted for this stage run', []);
    }
    this.accepted = { submission: result.value, canonical: text };
    return { state: 'accepted', submission: result.value, toolCallsUsed: this.toolCallsUsed };
  }

  // The status a runner may report for this stage when the harness exits. Without one accepted
  // schema-valid proposal the stage is inconclusive: format repair never manufactures completion.
  terminalStatus(): 'proposal_accepted' | 'inconclusive' {
    return this.accepted ? 'proposal_accepted' : 'inconclusive';
  }
}
