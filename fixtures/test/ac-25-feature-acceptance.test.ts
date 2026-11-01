import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { evaluateCriteriaEvidence } from '@factory/domain';
import { packagesDir, readManifest, runPackage, startEnvironment } from '../src/index.ts';

const pkg = join(packagesDir, 'feature-cancellation');
const required = Object.keys(readManifest(pkg).criteria);

async function acceptance(releaseId: string) {
  const env = await startEnvironment(releaseId);
  try { return await runPackage(pkg, env); } finally { await env.stop(); }
}

describe('AC-25 feature acceptance', () => {
  it('declares user, error and permission criteria', () => {
    expect(required).toEqual(expect.arrayContaining(['CAN-USER', 'CAN-ERROR', 'CAN-PERMISSION']));
  });

  it('the complete candidate satisfies every required criterion', async () => {
    const report = await acceptance('orders-2.0.0');
    expect(report.runs.map((r) => [r.scenarioId, r.outcome])).toEqual(report.runs.map((r) => [r.scenarioId, 'passed']));
    expect(evaluateCriteriaEvidence(required, report)).toEqual({ complete: true, unmet: [] });
  });

  it('a happy-path-only candidate remains incomplete even though its author reported completion', async () => {
    // The authoring stage's own result claims completion; acceptance never consults it.
    const authorClaim = { status: 'completed', summary: 'Cancellation implemented and tested.' };
    const report = await acceptance('orders-2.0.0-happy-path');
    const evaluation = evaluateCriteriaEvidence(required, report);
    expect(authorClaim.status).toBe('completed');
    expect(evaluation.complete).toBe(false);
    expect(evaluation.unmet.map((u) => u.criterionId).sort()).toEqual(['CAN-AUDIT', 'CAN-IDEMPOTENT', 'CAN-PERMISSION']);
    expect(evaluation.unmet.find((u) => u.criterionId === 'CAN-PERMISSION')?.reason).toContain('other-customer-cannot-cancel assertion_failed');
    expect(report.runs.find((r) => r.scenarioId === 'other-customer-cannot-cancel')?.message).toBe('expected foreign cancel status code 403; observed 200');
  });

  it('a release without the feature is incomplete; only the error criterion passes, vacuously, on a missing route', async () => {
    const report = await acceptance('orders-1.0.0');
    const evaluation = evaluateCriteriaEvidence(required, report);
    expect(evaluation.complete).toBe(false);
    expect(evaluation.unmet.map((u) => u.criterionId).sort()).toEqual(['CAN-AUDIT', 'CAN-IDEMPOTENT', 'CAN-PERMISSION', 'CAN-USER']);
  });

  it('a criterion with no executed scenario is unmet', async () => {
    const report = await acceptance('orders-2.0.0');
    const evaluation = evaluateCriteriaEvidence([...required, 'CAN-NOTIFY'], report);
    expect(evaluation.complete).toBe(false);
    expect(evaluation.unmet).toEqual([{ criterionId: 'CAN-NOTIFY', reason: 'no executed scenario covers this criterion' }]);
  });
});
