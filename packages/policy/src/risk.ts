// Risk assessment on the actual change (chapter 05 "Risk triggers"; AC-33). Pure function of a
// pinned policy profile and the observed change summary. Size never lowers risk: a two-line change
// to an authentication path is a risk trigger. Unknown coverage or blast radius is itself a trigger.
export type ChangeSummary = {
  changedPaths: string[];
  linesChanged: number;
  publicContractChanged: boolean;
  servicesTouched: string[];
  migrationsAdded: number;
  coverageKnown: boolean;
  blastRadiusKnown: boolean;
};
export type PathRule = { pattern: string; trigger: string };
export type RiskPolicy = { riskTriggers: string[]; pathRules: PathRule[]; criticalApplicationIds: string[] };
export type RiskAssessment = { triggers: string[]; evidence: Array<{ trigger: string; because: string }> };

// Minimal glob: `**/` matches zero or more leading segments, `/**` any trailing segments, `*`
// any characters within one segment.
export function globMatch(pattern: string, path: string): boolean {
  let re = '';
  for (let i = 0; i < pattern.length; i += 1) {
    if (pattern.startsWith('**/', i)) { re += '(?:.*/)?'; i += 2; continue; }
    if (pattern.startsWith('/**', i) && i + 3 === pattern.length) { re += '(?:/.*)?'; i += 2; continue; }
    if (pattern.startsWith('**', i)) { re += '.*'; i += 1; continue; }
    const c = pattern[i] ?? '';
    re += c === '*' ? '[^/]*' : c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`).test(path);
}

export function assessRisk(change: ChangeSummary, applicationId: string, policy: RiskPolicy): RiskAssessment {
  const evidence: RiskAssessment['evidence'] = [];
  const add = (trigger: string, because: string): void => { evidence.push({ trigger, because }); };
  for (const path of change.changedPaths) for (const rule of policy.pathRules) if (globMatch(rule.pattern, path)) add(rule.trigger, `${path} matches ${rule.pattern}`);
  if (change.publicContractChanged) add('public_api', 'a public interface contract changed');
  if (change.migrationsAdded > 0) add('persistent_migration', `${String(change.migrationsAdded)} persistent migration(s)`);
  if (new Set(change.servicesTouched).size > 1) add('several_services', `services ${[...new Set(change.servicesTouched)].sort().join(', ')}`);
  if (!change.coverageKnown || !change.blastRadiusKnown) add('unknown_blast_radius', 'coverage or blast radius is unknown');
  if (policy.criticalApplicationIds.includes(applicationId)) add('critical_application', 'application is designated critical');
  // Only triggers the pinned policy recognises count, but an unrecognised path rule cannot silently
  // drop a match: unknown trigger names fail closed to unknown_blast_radius.
  const known = new Set(policy.riskTriggers);
  const triggers = [...new Set(evidence.map((e) => (known.has(e.trigger) ? e.trigger : 'unknown_blast_radius')))].sort();
  return { triggers, evidence };
}
