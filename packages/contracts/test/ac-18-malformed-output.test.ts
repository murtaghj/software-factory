import { describe, expect, it } from 'vitest';
import { decodeStageOutcome, decodeRunnerResult, decodeControllerResult, SubmissionLedger, MAX_FEEDBACK_ERRORS, MAX_FEEDBACK_BYTES, type RunLimits } from '../src/index.ts';
import { readFixture } from './fixture-catalog.ts';

const stageResult = readFixture('stage-result.json') as Record<string, unknown> & { orgId: string; taskId: string; stageRunId: string; inputHash: string; allocationEpoch: number };
const binding = { orgId: stageResult.orgId, taskId: stageResult.taskId, stageRunId: stageResult.stageRunId, inputHash: stageResult.inputHash, allocationEpoch: stageResult.allocationEpoch };
const validSubmission = readFixture('factory-submit-result-v1.2.json') as Record<string, unknown>;
const limits = (maxToolCalls: number, extra: Partial<RunLimits> = {}): RunLimits => ({ wallSeconds: 2700, maxTurns: 40, maxToolCalls, maxOutputBytes: 1_000_000, reservedMicroUsd: 1_000_000, ...extra });
const T0 = Date.parse('2026-11-01T12:00:00Z');
const without = (o: Record<string, unknown>, key: string): Record<string, unknown> => Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));

describe('AC-18 malformed agent output', () => {
  it('decodes the reference StageResult for its issued binding', () => {
    expect(decodeStageOutcome(JSON.stringify(stageResult)).ok).toBe(true);
    expect(decodeRunnerResult(JSON.stringify(stageResult), binding).ok).toBe(true);
  });

  it('never yields a StageOutcome for invalid or unsupported result JSON', () => {
    const cases: Array<[string, unknown, string]> = [
      ['truncated JSON text', JSON.stringify(stageResult).slice(0, 80), 'malformed_json'],
      ['prose instead of JSON', 'Task complete! All tests pass.', 'malformed_json'],
      ['JSON array', '[1,2]', 'not_an_object'],
      ['unknown major version', { ...stageResult, schemaVersion: '3.0' }, 'unsupported_version'],
      ['legacy major version', { ...stageResult, schemaVersion: '1.0' }, 'unsupported_version'],
      ['unknown field', { ...stageResult, verdict: 'pass' }, 'schema_invalid'],
      ['missing input binding hash', without(stageResult, 'inputHash'), 'schema_invalid'],
      ['adapter claims to be a stage result', { ...stageResult, producerKind: 'adapter' }, 'schema_invalid'],
      ['unknown status', { ...stageResult, status: 'success' }, 'schema_invalid'],
      ['noncanonical stage identity', { ...stageResult, stageRunId: 'implement-1' }, 'schema_invalid'],
    ];
    for (const [label, raw, reason] of cases) {
      const r = decodeRunnerResult(raw, binding);
      expect(r.ok, label).toBe(false);
      if (!r.ok) expect(r.reason, label).toBe(reason);
    }
  });

  it('a runner result must be a runner StageResult for exactly the issued stage binding', () => {
    const controllerShaped = { ...without(stageResult, 'allocationEpoch'), producerKind: 'controller' };
    expect(decodeStageOutcome(controllerShaped).ok).toBe(true); // shape alone is not provenance
    const asRunner = decodeRunnerResult(controllerShaped, binding);
    expect(asRunner.ok).toBe(false);
    if (!asRunner.ok) expect(asRunner.reason).toBe('schema_invalid');
    const foreign: Array<[string, Record<string, unknown>]> = [
      ['another task', { ...stageResult, taskId: '00000000-0000-4000-8000-0000000000ff' }],
      ['another organization', { ...stageResult, orgId: '00000000-0000-4000-8000-0000000000fe' }],
      ['another stage', { ...stageResult, stageRunId: `task-${stageResult.taskId}/plan-1/review/attempt-1` }],
      ['another input hash', { ...stageResult, inputHash: 'f'.repeat(64) }],
      ['a stale allocation epoch', { ...stageResult, allocationEpoch: stageResult.allocationEpoch + 1 }],
    ];
    for (const [label, value] of foreign) {
      const r = decodeRunnerResult(value, binding);
      expect(r.ok, label).toBe(false);
      if (!r.ok) expect(r.reason, label).toBe('binding_mismatch');
    }
    const controllerBinding = { orgId: binding.orgId, taskId: binding.taskId, stageRunId: binding.stageRunId, inputHash: binding.inputHash };
    expect(decodeControllerResult(stageResult, controllerBinding).ok).toBe(false);
    expect(decodeControllerResult(controllerShaped, controllerBinding).ok).toBe(true);
  });

  it('rejects output larger than the declared maxOutputBytes before parsing it', () => {
    const big = JSON.stringify({ ...stageResult, producerId: 'x'.repeat(5000) });
    const r = decodeRunnerResult(big, binding, 1024);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('oversize');
  });

  it('every rejected submission consumes the declared tool-call budget and returns bounded feedback', () => {
    const ledger = new SubmissionLedger('implementer', limits(3), { startedAtMs: T0 });
    const hugeKey = 'k'.repeat(500_000);
    const bad = { callId: 'not-a-uuid', output: { role: 'implementer' }, feedbackClaims: 'none', deferredWork: [], [hugeKey]: 1, extra: Array.from({ length: 50 }, (_, i) => i) };
    const first = ledger.submit(bad, T0 + 1000);
    expect(first.state).toBe('rejected');
    if (first.state !== 'rejected') return;
    expect(first.error.code).toBe('invalid_schema');
    expect(first.error.retryable).toBe(true);
    expect(first.feedback.length).toBeGreaterThan(0);
    expect(first.feedback.length).toBeLessThanOrEqual(MAX_FEEDBACK_ERRORS);
    expect(Buffer.byteLength(JSON.stringify(first.feedback))).toBeLessThanOrEqual(MAX_FEEDBACK_BYTES);
    expect(JSON.stringify(first.feedback)).not.toContain('k'.repeat(1000));
    expect(first.toolCallsUsed).toBe(1);
    expect(first.toolCallsRemaining).toBe(2);
    expect(ledger.terminalStatus()).toBe('inconclusive');
    expect(ledger.submit('{"callId":', T0 + 2000).state).toBe('rejected');
    expect(ledger.used).toBe(2);
    expect(ledger.submit(validSubmission, T0 + 3000).state).toBe('accepted');
    expect(ledger.used).toBe(3);
    expect(ledger.terminalStatus()).toBe('proposal_accepted');
  });

  it('exhausting the tool-call budget ends correction: further calls are cap_exhausted and the stage is inconclusive', () => {
    const ledger = new SubmissionLedger('implementer', limits(2), { startedAtMs: T0 });
    expect(ledger.submit({}, T0 + 1).state).toBe('rejected');
    const last = ledger.submit({ callId: 'x' }, T0 + 2);
    expect(last.state).toBe('rejected');
    if (last.state === 'rejected') expect(last.error.retryable).toBe(false);
    const afterCap = ledger.submit(validSubmission, T0 + 3);
    expect(afterCap.state).toBe('rejected');
    if (afterCap.state === 'rejected') { expect(afterCap.error.code).toBe('cap_exhausted'); expect(afterCap.error.retryable).toBe(false); }
    expect(ledger.used).toBe(2);
    expect(ledger.acceptedSubmission).toBeUndefined();
    expect(ledger.terminalStatus()).toBe('inconclusive');
  });

  it('no correction is accepted after the run wall-clock deadline', () => {
    const ledger = new SubmissionLedger('implementer', limits(10, { wallSeconds: 60 }), { startedAtMs: T0 });
    expect(ledger.submit({}, T0 + 1000).state).toBe('rejected');
    const late = ledger.submit(validSubmission, T0 + 60_000);
    expect(late.state).toBe('rejected');
    if (late.state === 'rejected') expect(late.error.code).toBe('cap_exhausted');
    expect(ledger.terminalStatus()).toBe('inconclusive');
  });

  it('fails closed on missing or invalid budgets', () => {
    expect(() => new SubmissionLedger('implementer', { ...limits(3), maxToolCalls: Number.NaN }, { startedAtMs: T0 })).toThrow();
    expect(() => new SubmissionLedger('implementer', without(limits(3) as unknown as Record<string, unknown>, 'maxToolCalls') as unknown as RunLimits, { startedAtMs: T0 })).toThrow();
    expect(() => new SubmissionLedger('implementer', limits(3), { startedAtMs: T0, toolCallsAlreadyUsed: -1 })).toThrow();
    expect(() => new SubmissionLedger('implementer', limits(3), { startedAtMs: Number.NaN })).toThrow();
    expect(() => new SubmissionLedger('wizard' as 'implementer', limits(3), { startedAtMs: T0 })).toThrow();
  });

  it('a schema-valid submission for another role is refused and still consumes budget', () => {
    const ledger = new SubmissionLedger('reviewer', limits(2), { startedAtMs: T0 });
    const r = ledger.submit(validSubmission, T0 + 1);
    expect(r.state).toBe('rejected');
    if (r.state === 'rejected') expect(r.error.code).toBe('forbidden');
    expect(ledger.used).toBe(1);
    expect(ledger.terminalStatus()).toBe('inconclusive');
  });

  it('the first accepted proposal is final: an identical retry links it, a different one conflicts', () => {
    const ledger = new SubmissionLedger('implementer', limits(5), { startedAtMs: T0 });
    expect(ledger.submit(validSubmission, T0 + 1).state).toBe('accepted');
    expect(ledger.submit(JSON.parse(JSON.stringify(validSubmission)), T0 + 2).state).toBe('duplicate');
    const changed = structuredClone(validSubmission);
    (changed.output as Record<string, unknown>).limitations = ['different claim'];
    const conflict = ledger.submit(changed, T0 + 3);
    expect(conflict.state).toBe('rejected');
    if (conflict.state === 'rejected') expect(conflict.error.code).toBe('conflict');
    expect(ledger.acceptedSubmission).toEqual(validSubmission);
  });
});
