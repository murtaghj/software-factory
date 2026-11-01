import { describe, expect, it } from 'vitest';
import { effectiveAssurance, requiredGatesFor } from '@factory/domain';
import { assessRisk, globMatch, resolveAxes, riskPolicyFrom, type ChangeSummary } from '../src/index.ts';

const profile = { riskTriggers: ['public_api', 'authentication_authorization', 'payment', 'sensitive_data', 'persistent_migration', 'several_services', 'unknown_blast_radius', 'critical_application', 'privileged_infrastructure', 'performance_resource_risk'] };
const policy = riskPolicyFrom(profile, ['app-critical']);
const tiny = (paths: string[], over: Partial<ChangeSummary> = {}): ChangeSummary => ({ changedPaths: paths, linesChanged: 2, publicContractChanged: false, servicesTouched: ['orders'], migrationsAdded: 0, coverageKnown: true, blastRadiusKnown: true, ...over });

describe('AC-33 risk escalation', () => {
  it('a narrow ticket whose actual two-line diff touches authorization escalates to enhanced and adds the relevant gates', () => {
    const risk = assessRisk(tiny(['services/orders/src/auth/permissions.ts']), 'app-1', policy);
    expect(risk.triggers).toEqual(['authentication_authorization']);
    const assurance = effectiveAssurance('fast', 'standard', risk.triggers);
    expect(assurance).toBe('enhanced');
    expect(requiredGatesFor({ stageKind: 'verify', requiredGateIds: ['outcome_verified'] }, assurance)).toEqual(['outcome_verified', 'oracle_accepted', 'adversarial_passed']);
  });

  it.each([
    ['public API contract change', tiny(['src/handlers.ts'], { publicContractChanged: true }), 'public_api'],
    ['data migration', tiny(['db/migrations/0042_add_column.sql']), 'persistent_migration'],
    ['several services', tiny(['a.ts'], { servicesTouched: ['orders', 'inventory'] }), 'several_services'],
    ['unknown coverage', tiny(['a.ts'], { coverageKnown: false }), 'unknown_blast_radius'],
    ['payments path', tiny(['services/billing/payments/charge.ts']), 'payment'],
    ['deploy path', tiny(['deploy/helm/values.yaml']), 'privileged_infrastructure'],
  ])('%s is a risk trigger regardless of diff size', (_label, change, trigger) => {
    const risk = assessRisk(change, 'app-1', policy);
    expect(risk.triggers).toContain(trigger);
    expect(effectiveAssurance('fast', 'fast', risk.triggers)).toBe('enhanced');
  });

  it('a critical application is always enhanced; an ordinary low-risk change keeps the requested tier', () => {
    expect(assessRisk(tiny(['README.md']), 'app-critical', policy).triggers).toEqual(['critical_application']);
    const plain = assessRisk(tiny(['src/format.ts']), 'app-1', policy);
    expect(plain.triggers).toEqual([]);
    expect(effectiveAssurance('standard', 'standard', plain.triggers)).toBe('standard');
  });

  it('a path rule naming a trigger the pinned policy does not know fails closed to unknown_blast_radius', () => {
    const custom = { ...policy, pathRules: [{ pattern: 'secret/**', trigger: 'not_in_policy' }] };
    expect(assessRisk(tiny(['secret/x.ts']), 'app-1', custom).triggers).toEqual(['unknown_blast_radius']);
  });

  it('fast requires the application allowlist and no trigger; escalation never lowers the tier', () => {
    const base = { workType: 'feature' as const, targetKind: 'existing_application' as const, requestedAssurance: 'fast' as const, invocationMode: 'bounded' as const, deliveryScope: 'pr' as const, applicationId: 'app-1' };
    expect(resolveAxes(base, { applicationMinimumAssurance: 'fast', fastAllowedApplicationIds: [], discoveredRiskTriggers: [] }).axes.assurance).toBe('standard');
    expect(resolveAxes(base, { applicationMinimumAssurance: 'fast', fastAllowedApplicationIds: ['app-1'], discoveredRiskTriggers: [] }).axes.assurance).toBe('fast');
    expect(resolveAxes(base, { applicationMinimumAssurance: 'fast', fastAllowedApplicationIds: ['app-1'], discoveredRiskTriggers: ['payment'] }).axes.assurance).toBe('enhanced');
  });

  it('glob rules match as documented', () => {
    expect(globMatch('**/auth/**', 'auth/x.ts')).toBe(true);
    expect(globMatch('**/auth/**', 'a/b/auth/c/d.ts')).toBe(true);
    expect(globMatch('**/auth/**', 'a/author.ts')).toBe(false);
    expect(globMatch('contracts/**', 'contracts/orders.json')).toBe(true);
    expect(globMatch('**/*.openapi.json', 'x/y/orders.openapi.json')).toBe(true);
    expect(globMatch('**/*permission*', 'src/rolePermissions.ts')).toBe(false);
    expect(globMatch('**/*permission*', 'src/permissions.ts')).toBe(true);
  });
});
