// The pinned M1 policy profile: the specification's organization-default PolicyProfile example
// plus local path rules (docs/assumptions.md A-11). Policy evaluation is this bundled pure code; its
// results are recorded as Activity outputs so replay never re-evaluates live policy.
import type { PathRule, RiskPolicy } from './risk.ts';

export const M1_PATH_RULES: PathRule[] = [
  { pattern: '**/auth/**', trigger: 'authentication_authorization' },
  { pattern: '**/*permission*', trigger: 'authentication_authorization' },
  { pattern: '**/payments/**', trigger: 'payment' },
  { pattern: '**/migrations/**', trigger: 'persistent_migration' },
  { pattern: 'contracts/**', trigger: 'public_api' },
  { pattern: '**/*.openapi.json', trigger: 'public_api' },
  { pattern: 'deploy/**', trigger: 'privileged_infrastructure' },
  { pattern: '**/pii/**', trigger: 'sensitive_data' },
];

export function riskPolicyFrom(profile: { riskTriggers: string[] }, criticalApplicationIds: string[] = []): RiskPolicy {
  return { riskTriggers: profile.riskTriggers, pathRules: M1_PATH_RULES, criticalApplicationIds };
}
