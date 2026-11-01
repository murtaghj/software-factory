// Harness/stage output decoding and bounded format repair (W-003, AC-18).
//
// Malformed, unsupported or schema-invalid agent output is never a StageOutcome, so it can never be
// handed to the gate evaluator. A submit_result call that fails validation returns bounded feedback
// (FactoryToolError invalid_schema) and consumes one tool call from the run's declared RunLimits;
// correction is only possible inside that budget (chapter 07: "schema errors return bounded feedback
// and permit correction within existing turn/tool/time budgets"). When the budget is exhausted the
// stage finishes inconclusive, never completed (INV-11).
import type { FactoryToolError, Role, RunLimits, StageOutcome, SubmitResultToolInputV12 } from './generated/domain.ts';
import { validateContract, type ContractError } from './validate.ts';

export const SUPPORTED_ENVELOPE_MAJOR = 2;
export const MAX_FEEDBACK_ERRORS = 10;
export const MAX_FEEDBACK_MESSAGE_CHARS = 2000;

export type DecodeFailure = {
  ok: false;
  reason: 'malformed_json' | 'not_an_object' | 'unsupported_version' | 'schema_invalid';
  errors: ContractError[];
};
export type Decoded<T> = { ok: true; value: T } | DecodeFailure;

function parse(raw: unknown): Decoded<Record<string, unknown>> {
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

export function decodeStageOutcome(raw: unknown): Decoded<StageOutcome> {
  const parsed = parse(raw);
  if (!parsed.ok) return parsed;
  const versionFailure = checkMajor(parsed.value);
  if (versionFailure) return versionFailure;
  const result = validateContract('StageOutcome', parsed.value);
  return result.ok ? { ok: true, value: result.value } : { ok: false, reason: 'schema_invalid', errors: result.errors };
}

export type SubmissionReceipt =
  | { state: 'accepted'; submission: SubmitResultToolInputV12; toolCallsUsed: number }
  | { state: 'duplicate'; submission: SubmitResultToolInputV12; toolCallsUsed: number }
  | { state: 'rejected'; error: FactoryToolError; feedback: ContractError[]; toolCallsUsed: number; toolCallsRemaining: number };

function boundedFeedback(errors: ContractError[]): ContractError[] {
  return errors.slice(0, MAX_FEEDBACK_ERRORS).map((e) => ({ ...e, message: e.message.slice(0, 200) }));
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
// agent cannot select it. Every submit_result call, valid or not, consumes one tool call.
export class SubmissionLedger {
  readonly expectedRole: Role;
  readonly limits: RunLimits;
  private toolCallsUsed: number;
  private accepted: { submission: SubmitResultToolInputV12; canonical: string } | undefined;

  constructor(expectedRole: Role, limits: RunLimits, toolCallsAlreadyUsed = 0) {
    this.expectedRole = expectedRole;
    this.limits = limits;
    this.toolCallsUsed = toolCallsAlreadyUsed;
  }

  get used(): number { return this.toolCallsUsed; }
  get remaining(): number { return Math.max(0, this.limits.maxToolCalls - this.toolCallsUsed); }
  get acceptedSubmission(): SubmitResultToolInputV12 | undefined { return this.accepted?.submission; }

  submit(raw: unknown): SubmissionReceipt {
    if (this.remaining === 0) {
      return { state: 'rejected', error: toolError('cap_exhausted', 'tool-call budget exhausted; no further corrections are accepted', false), feedback: [], toolCallsUsed: this.toolCallsUsed, toolCallsRemaining: 0 };
    }
    this.toolCallsUsed += 1;
    const reject = (code: FactoryToolError['code'], message: string, feedback: ContractError[]): SubmissionReceipt => ({
      state: 'rejected', error: toolError(code, message, code === 'invalid_schema' && this.remaining > 0), feedback: boundedFeedback(feedback), toolCallsUsed: this.toolCallsUsed, toolCallsRemaining: this.remaining,
    });
    const parsed = parse(raw);
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
