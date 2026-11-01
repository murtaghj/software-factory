import { describe, expect, it } from 'vitest';
import { decodeStageOutcome, SubmissionLedger, MAX_FEEDBACK_ERRORS, type RunLimits } from '../src/index.ts';
import { readFixture } from './fixture-catalog.ts';

const stageResult = readFixture('stage-result.json') as Record<string, unknown>;
const validSubmission = readFixture('factory-submit-result-v1.2.json') as Record<string, unknown>;
const limits = (maxToolCalls: number): RunLimits => ({ wallSeconds: 2700, maxTurns: 40, maxToolCalls, maxOutputBytes: 1_000_000, reservedMicroUsd: 1_000_000 });

describe('AC-18 malformed agent output', () => {
  it('decodes the reference StageResult', () => {
    const r = decodeStageOutcome(JSON.stringify(stageResult));
    expect(r.ok).toBe(true);
  });

  it('never yields a StageOutcome for invalid or unsupported result JSON', () => {
    const cases: Array<[string, unknown, string]> = [
      ['truncated JSON text', JSON.stringify(stageResult).slice(0, 80), 'malformed_json'],
      ['prose instead of JSON', 'Task complete! All tests pass.', 'malformed_json'],
      ['JSON array', '[1,2]', 'not_an_object'],
      ['unknown major version', { ...stageResult, schemaVersion: '3.0' }, 'unsupported_version'],
      ['legacy major version', { ...stageResult, schemaVersion: '1.0' }, 'unsupported_version'],
      ['unknown field', { ...stageResult, verdict: 'pass' }, 'schema_invalid'],
      ['missing input binding hash', Object.fromEntries(Object.entries(stageResult).filter(([k]) => k !== 'inputHash')), 'schema_invalid'],
      ['adapter claims to be a stage result', { ...stageResult, producerKind: 'adapter' }, 'schema_invalid'],
      ['unknown status', { ...stageResult, status: 'success' }, 'schema_invalid'],
      ['noncanonical stage identity', { ...stageResult, stageRunId: 'implement-1' }, 'schema_invalid'],
    ];
    for (const [label, raw, reason] of cases) {
      const r = decodeStageOutcome(raw);
      expect(r.ok, label).toBe(false);
      if (!r.ok) expect(r.reason, label).toBe(reason);
    }
  });

  it('every rejected submission consumes the declared tool-call budget and returns bounded feedback', () => {
    const ledger = new SubmissionLedger('implementer', limits(3));
    const bad = { callId: 'not-a-uuid', output: { role: 'implementer' }, feedbackClaims: 'none', deferredWork: [], extra: Array.from({ length: 50 }, (_, i) => i) };
    const first = ledger.submit(bad);
    expect(first.state).toBe('rejected');
    if (first.state !== 'rejected') return;
    expect(first.error.code).toBe('invalid_schema');
    expect(first.error.retryable).toBe(true);
    expect(first.feedback.length).toBeGreaterThan(0);
    expect(first.feedback.length).toBeLessThanOrEqual(MAX_FEEDBACK_ERRORS);
    expect(first.toolCallsUsed).toBe(1);
    expect(first.toolCallsRemaining).toBe(2);
    expect(ledger.terminalStatus()).toBe('inconclusive');
    const second = ledger.submit('{"callId":');
    expect(second.state).toBe('rejected');
    expect(ledger.used).toBe(2);
    const corrected = ledger.submit(validSubmission);
    expect(corrected.state).toBe('accepted');
    expect(ledger.used).toBe(3);
    expect(ledger.terminalStatus()).toBe('proposal_accepted');
  });

  it('exhausting the budget ends correction: further calls are cap_exhausted and the stage is inconclusive', () => {
    const ledger = new SubmissionLedger('implementer', limits(2));
    expect(ledger.submit({}).state).toBe('rejected');
    const last = ledger.submit({ callId: 'x' });
    expect(last.state).toBe('rejected');
    if (last.state === 'rejected') expect(last.error.retryable).toBe(false);
    const afterCap = ledger.submit(validSubmission);
    expect(afterCap.state).toBe('rejected');
    if (afterCap.state === 'rejected') {
      expect(afterCap.error.code).toBe('cap_exhausted');
      expect(afterCap.error.retryable).toBe(false);
    }
    expect(ledger.used).toBe(2);
    expect(ledger.acceptedSubmission).toBeUndefined();
    expect(ledger.terminalStatus()).toBe('inconclusive');
  });

  it('a schema-valid submission for another role is refused and still consumes budget', () => {
    const ledger = new SubmissionLedger('reviewer', limits(2));
    const r = ledger.submit(validSubmission);
    expect(r.state).toBe('rejected');
    if (r.state === 'rejected') expect(r.error.code).toBe('forbidden');
    expect(ledger.used).toBe(1);
    expect(ledger.terminalStatus()).toBe('inconclusive');
  });

  it('the first accepted proposal is final: an identical retry links it, a different one conflicts', () => {
    const ledger = new SubmissionLedger('implementer', limits(5));
    expect(ledger.submit(validSubmission).state).toBe('accepted');
    expect(ledger.submit(JSON.parse(JSON.stringify(validSubmission))).state).toBe('duplicate');
    const changed = structuredClone(validSubmission);
    (changed.output as Record<string, unknown>).limitations = ['different claim'];
    const conflict = ledger.submit(changed);
    expect(conflict.state).toBe('rejected');
    if (conflict.state === 'rejected') expect(conflict.error.code).toBe('conflict');
    expect(ledger.acceptedSubmission).toEqual(validSubmission);
  });
});
