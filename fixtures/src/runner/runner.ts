// fixture-test-runner 1.0.0: executes a canonical test package directory against a running
// fixture environment and produces an ExecutionReport. Each scenario is classified as passed,
// assertion_failed (a test assertion), or a non-assertion outcome (infrastructure_error, timeout,
// setup_error, error) that can never count as an intended baseline failure.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ExecutionReport, ScenarioOutcome, ScenarioRun } from '@factory/domain';
import { FIXTURE_RUNNER, faultsDigest, type FixtureEnvironment } from '../environment.ts';
import { AssertionFailure, createKit, type PackageManifest, type PackageModule } from './kit.ts';

export const packagesDir = join(import.meta.dirname, '..', 'packages');

export function packageDigest(dir: string): string {
  const h = createHash('sha256');
  for (const f of readdirSync(dir).sort()) h.update(`${f}\0${createHash('sha256').update(readFileSync(join(dir, f))).digest('hex')}\n`);
  return h.digest('hex');
}

export function readManifest(dir: string): PackageManifest {
  return JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as PackageManifest;
}

const INFRA_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EHOSTUNREACH', 'EPIPE', '57P01', '57P03', '08001', '08006', '55000', '3D000']);

function classify(e: unknown): { outcome: ScenarioOutcome; message: string } {
  if (e instanceof AssertionFailure) return { outcome: 'assertion_failed', message: e.message };
  const err = e as { name?: string; code?: string; message?: string; cause?: { code?: string } };
  const message = err.message ?? String(e);
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return { outcome: 'timeout', message };
  if ((err.code && INFRA_CODES.has(err.code)) || (err.cause?.code && INFRA_CODES.has(err.cause.code))) return { outcome: 'infrastructure_error', message };
  return { outcome: 'error', message };
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => { const e = new Error(`scenario exceeded ${String(ms)} ms`); e.name = 'TimeoutError'; reject(e); }, ms); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Environment health: the database answers and both services respond. A failed check makes the
// scenario an infrastructure_error without running it.
async function healthy(env: FixtureEnvironment): Promise<string | undefined> {
  try {
    await env.pool.query('SELECT 1');
    for (const url of [env.ordersUrl, env.inventoryUrl]) await fetch(`${url}/health-probe`, { signal: AbortSignal.timeout(2000) });
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export async function runPackage(dir: string, env: FixtureEnvironment, options: { scenarioTimeoutMs?: number } = {}): Promise<ExecutionReport> {
  const manifest = readManifest(dir);
  if (manifest.framework !== FIXTURE_RUNNER.framework || manifest.frameworkVersion !== FIXTURE_RUNNER.frameworkVersion) throw new Error(`package ${manifest.id} targets ${manifest.framework}@${manifest.frameworkVersion}`);
  const digest = packageDigest(dir);
  const mod = await import(pathToFileURL(join(dir, 'scenarios.ts')).href) as PackageModule;
  const scenarios = mod.default(createKit(env));
  const runs: ScenarioRun[] = [];
  // The package declares the environment it needs (including fault injection); running it anywhere
  // else is a setup error, never a product result.
  if (faultsDigest(manifest.environment.faults) !== env.fingerprint.equivalence.faultsDigest) {
    for (const s of scenarios) runs.push({ scenarioId: s.id, criterionIds: s.criterionIds, outcome: 'setup_error', message: 'environment faults differ from the package declaration' });
  }
  for (const s of runs.length > 0 ? [] : scenarios) {
    const unhealthy = await healthy(env);
    if (unhealthy !== undefined) { runs.push({ scenarioId: s.id, criterionIds: s.criterionIds, outcome: 'infrastructure_error', message: `environment unhealthy before scenario: ${unhealthy}` }); continue; }
    try {
      await withTimeout(s.run(), options.scenarioTimeoutMs ?? 15_000);
      runs.push({ scenarioId: s.id, criterionIds: s.criterionIds, outcome: 'passed' });
    } catch (e) {
      const c = classify(e);
      const after = c.outcome === 'assertion_failed' ? await healthy(env) : undefined;
      runs.push(after === undefined
        ? { scenarioId: s.id, criterionIds: s.criterionIds, ...c }
        : { scenarioId: s.id, criterionIds: s.criterionIds, outcome: 'infrastructure_error', message: `environment became unhealthy: ${after}; assertion was: ${c.message}` });
    }
  }
  return {
    framework: manifest.framework,
    frameworkVersion: manifest.frameworkVersion,
    packageId: `${manifest.id}@${manifest.version}`,
    packageDigest: digest,
    environment: { releaseId: env.fingerprint.releaseId, sourceDigest: env.fingerprint.sourceDigest, equivalence: { ...env.fingerprint.equivalence } },
    discovered: scenarios.length,
    executed: runs.filter((r) => r.outcome !== 'setup_error').length,
    runs,
  };
}
