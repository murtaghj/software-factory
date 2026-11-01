import { describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { evaluateBugRedLockGreen, type FailureSignature } from '@factory/domain';
import { validateContract } from '@factory/contracts';
import { packageDigest, packagesDir, runPackage, startEnvironment } from '../src/index.ts';

const pkg = join(packagesDir, 'bug-duplicate-reservation');
const faults = { inventoryDropFirstReserveResponse: true };
const profileFixture = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'docs', 'spec', 'examples', 'failure-signature-profile.json'), 'utf8')) as Record<string, unknown>;

async function runOn(releaseId: string, dir = pkg, options: { faults?: typeof faults; breakDatabase?: boolean } = {}) {
  const env = await startEnvironment(releaseId, { faults: options.faults ?? faults });
  try {
    if (options.breakDatabase === true) await env.makeDatabaseUnavailable();
    return await runPackage(dir, env);
  } finally {
    await env.stop();
  }
}

describe('AC-20 valid bug repair', () => {
  // The specification's own FailureSignatureProfile for this fixture (examples/failure-signature-profile.json).
  const signature = (() => {
    const v = validateContract('FailureSignatureProfile', profileFixture);
    if (!v.ok) throw new Error('reference FailureSignatureProfile is invalid');
    const p = v.value;
    return { framework: p.framework, frameworkVersion: p.frameworkVersion, scenarioIds: p.scenarioIds, intendedAssertionMatchers: p.intendedAssertionMatchers, minimumExecutedTests: p.minimumExecutedTests, rejectedClasses: p.rejectedClasses } satisfies FailureSignature;
  })();
  const locked = packageDigest(pkg);

  it('baseline red for the intended assertion, locked package green on the candidate, comparable environments: verified', async () => {
    const baseline = await runOn('orders-1.1.0');
    const candidate = await runOn('orders-1.1.1');
    const red = baseline.runs.find((r) => r.scenarioId === 'duplicate-reservation');
    expect(red?.outcome).toBe('assertion_failed');
    expect(red?.message).toBe('expected reservation count 1; observed 2');
    expect(candidate.runs.every((r) => r.outcome === 'passed')).toBe(true);
    expect(baseline.packageDigest).toBe(locked);
    expect(candidate.packageDigest).toBe(locked);
    expect(candidate.environment.equivalence).toEqual(baseline.environment.equivalence);
    expect(candidate.environment.sourceDigest).not.toBe(baseline.environment.sourceDigest);
    expect(evaluateBugRedLockGreen({ signature, lockedPackageDigest: locked, baseline, candidate })).toEqual({ verdict: 'verified', reasons: [] });
  });

  it('a baseline that fails only because the database is unavailable is not an intended red', async () => {
    const baseline = await runOn('orders-1.1.0', pkg, { breakDatabase: true });
    expect(baseline.runs.every((r) => r.outcome === 'infrastructure_error')).toBe(true);
    const candidate = await runOn('orders-1.1.1');
    const verdict = evaluateBugRedLockGreen({ signature, lockedPackageDigest: locked, baseline, candidate });
    expect(verdict.verdict).toBe('inconclusive');
    expect(verdict.reasons.join(' ')).toContain('infrastructure_error, not the intended assertion');
  });

  it('a candidate that passes only an edited copy of the tests does not satisfy the locked package', async () => {
    const copy = mkdtempSync(join(tmpdir(), 'edited-package-'));
    try {
      cpSync(pkg, copy, { recursive: true });
      const file = join(copy, 'scenarios.ts');
      writeFileSync(file, readFileSync(file, 'utf8').replace('if (rows.length !== 1)', 'if (rows.length < 1)'));
      const baseline = await runOn('orders-1.1.0');
      const edited = await runOn('orders-1.1.0', copy); // the unrepaired source "passes" its edited tests
      expect(edited.runs.find((r) => r.scenarioId === 'duplicate-reservation')?.outcome).toBe('passed');
      const verdict = evaluateBugRedLockGreen({ signature, lockedPackageDigest: locked, baseline, candidate: edited });
      expect(verdict.verdict).toBe('invalid');
      expect(verdict.reasons).toContain('candidate did not run the locked canonical package');
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  });

  it('green under a different environment (fault injection removed) is not comparable evidence', async () => {
    const baseline = await runOn('orders-1.1.0');
    const unfaulted = await runOn('orders-1.1.0', pkg, { faults: {} as typeof faults });
    expect(unfaulted.runs.every((r) => r.outcome === 'setup_error')).toBe(true);
    const verdict = evaluateBugRedLockGreen({ signature, lockedPackageDigest: locked, baseline, candidate: unfaulted });
    expect(verdict.verdict).toBe('invalid');
    expect(verdict.reasons.join(' ')).toContain('faultsDigest');
  });
});
