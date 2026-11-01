// Work-type evidence predicates (INV-05, INV-06). Deterministic and I/O-free so the same function
// can run inside a Temporal workflow or a trusted evaluator Activity.
//
// Execution reports come from a trusted verifier run of a canonical test package, never from the
// authoring agent: nothing here reads an author's completion claim.

export type ScenarioOutcome = 'passed' | 'assertion_failed' | 'infrastructure_error' | 'timeout' | 'setup_error' | 'error';
export type ScenarioRun = { scenarioId: string; criterionIds: string[]; outcome: ScenarioOutcome; message?: string };
export type EnvironmentEvidence = { releaseId: string; sourceDigest: string; equivalence: Record<string, string> };
export type ExecutionReport = {
  framework: string;
  frameworkVersion: string;
  packageId: string;
  packageDigest: string;
  environment: EnvironmentEvidence;
  discovered: number;
  executed: number;
  runs: ScenarioRun[];
};

// The subset of FailureSignatureProfile (domain 2.0) the red/green comparison needs.
export type FailureSignature = {
  framework: string;
  frameworkVersion: string;
  scenarioIds: string[];
  intendedAssertionMatchers: string[];
  minimumExecutedTests: number;
  rejectedClasses: string[];
};

export type BugEvidenceVerdict = { verdict: 'verified' | 'invalid' | 'inconclusive'; reasons: string[] };

const NON_ASSERTION: ReadonlySet<ScenarioOutcome> = new Set(['infrastructure_error', 'timeout', 'setup_error', 'error']);

function equivalenceDiff(a: Record<string, string>, b: Record<string, string>): string[] {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return keys.filter((k) => a[k] !== b[k]);
}

// INV-05: a bug closes only with intended baseline failure, the reviewed locked package and candidate
// success under comparable conditions. Infrastructure, timeout, setup or unknown failures can never
// stand in for the intended red; anything short of every condition is not 'verified'.
export function evaluateBugRedLockGreen(input: { signature: FailureSignature; lockedPackageDigest: string; baseline: ExecutionReport; candidate: ExecutionReport }): BugEvidenceVerdict {
  const { signature, lockedPackageDigest, baseline, candidate } = input;
  const invalid: string[] = [];
  const inconclusive: string[] = [];
  for (const [label, r] of [['baseline', baseline], ['candidate', candidate]] as const) {
    if (r.framework !== signature.framework || r.frameworkVersion !== signature.frameworkVersion) invalid.push(`${label} ran ${r.framework}@${r.frameworkVersion}, not the profiled ${signature.framework}@${signature.frameworkVersion}`);
    if (r.packageDigest !== lockedPackageDigest) invalid.push(`${label} did not run the locked canonical package`);
    if (r.executed < signature.minimumExecutedTests) inconclusive.push(`${label} executed ${String(r.executed)} tests, below the profiled minimum ${String(signature.minimumExecutedTests)}`);
    if (r.executed !== r.discovered) inconclusive.push(`${label} discovered ${String(r.discovered)} tests but executed ${String(r.executed)}`);
  }
  const drift = equivalenceDiff(baseline.environment.equivalence, candidate.environment.equivalence);
  if (drift.length > 0) invalid.push(`environments are not comparable: ${drift.join(', ')} differ`);
  if (baseline.environment.sourceDigest === candidate.environment.sourceDigest) invalid.push('baseline and candidate are the same source; no change was evaluated');
  for (const scenarioId of signature.scenarioIds) {
    const red = baseline.runs.find((r) => r.scenarioId === scenarioId);
    if (!red) { invalid.push(`baseline has no run of profiled scenario ${scenarioId}`); continue; }
    if (NON_ASSERTION.has(red.outcome) || signature.rejectedClasses.includes(red.outcome)) {
      inconclusive.push(`baseline ${scenarioId} failed with ${red.outcome}, not the intended assertion`);
    } else if (red.outcome === 'passed') {
      invalid.push(`baseline ${scenarioId} passed; the defect was not reproduced`);
    } else if (!signature.intendedAssertionMatchers.some((m) => (red.message ?? '').includes(m))) {
      invalid.push(`baseline ${scenarioId} failed an assertion that does not match the intended signature`);
    }
  }
  for (const run of candidate.runs) {
    if (run.outcome !== 'passed') (NON_ASSERTION.has(run.outcome) ? inconclusive : invalid).push(`candidate ${run.scenarioId} ${run.outcome}`);
  }
  for (const scenarioId of signature.scenarioIds) {
    if (!candidate.runs.some((r) => r.scenarioId === scenarioId)) invalid.push(`candidate has no run of profiled scenario ${scenarioId}`);
  }
  if (invalid.length > 0) return { verdict: 'invalid', reasons: [...invalid, ...inconclusive] };
  if (inconclusive.length > 0) return { verdict: 'inconclusive', reasons: inconclusive };
  return { verdict: 'verified', reasons: [] };
}

export type CriteriaEvaluation = { complete: boolean; unmet: Array<{ criterionId: string; reason: string }> };

// INV-06: work completes against its declared evidence criteria. Every required criterion needs at
// least one executed scenario and all of its scenarios must pass; an unexecuted or failing scenario
// leaves the task incomplete whatever the author reported.
export function evaluateCriteriaEvidence(requiredCriterionIds: readonly string[], report: ExecutionReport): CriteriaEvaluation {
  const unmet: CriteriaEvaluation['unmet'] = [];
  if (report.executed !== report.discovered) unmet.push({ criterionId: '*', reason: `discovered ${String(report.discovered)} tests but executed ${String(report.executed)}` });
  for (const criterionId of [...new Set(requiredCriterionIds)].sort()) {
    const runs = report.runs.filter((r) => r.criterionIds.includes(criterionId));
    if (runs.length === 0) { unmet.push({ criterionId, reason: 'no executed scenario covers this criterion' }); continue; }
    const failing = runs.filter((r) => r.outcome !== 'passed');
    if (failing.length > 0) unmet.push({ criterionId, reason: failing.map((r) => `${r.scenarioId} ${r.outcome}`).join('; ') });
  }
  return { complete: unmet.length === 0, unmet };
}
