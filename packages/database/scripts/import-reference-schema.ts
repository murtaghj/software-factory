// Derives the initial ordered migrations (0001–0010) from the read-only reference DDL
// docs/spec/contracts/schema.sql. Statements are copied verbatim and in order; the file is split at
// named anchors. Later migrations (0011+) are hand-written forward migrations and are never
// regenerated. Usage: node packages/database/scripts/import-reference-schema.ts [--out dir]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const repoRoot = join(import.meta.dirname, '..', '..', '..');
const referencePath = join(repoRoot, 'docs', 'spec', 'contracts', 'schema.sql');

const SECTIONS: Array<{ file: string; title: string; from: string }> = [
  { file: '0001_schema_identity.sql', title: 'factory schema, git_object_id domain, organization and identity tables', from: 'CREATE SCHEMA factory;' },
  { file: '0002_registry_artifacts.sql', title: 'repositories, applications, artifacts, definitions, observations and relationships', from: 'CREATE TABLE repository (' },
  { file: '0003_tasks_execution.sql', title: 'tasks, drafts, specs, plans, stage runs, workspaces, allocations, sessions, candidates, artifact links', from: 'CREATE TABLE task (' },
  { file: '0004_gates_decisions_events.sql', title: 'gate evaluations, findings, decisions, commands, plan review comments, task events', from: 'CREATE TABLE gate_evaluation (' },
  { file: '0005_operations_delivery_ledgers.sql', title: 'external operations, environments, git changes, knowledge, budgets, outbox/inbox, idempotency, audit, tool calls, PR review', from: 'CREATE TABLE external_operation (' },
  { file: '0006_health_review_mode_design.sql', title: 'application health, autonomy policy, review mode (D5) and design delivery tables', from: 'CREATE TABLE application_health_sample (' },
  { file: '0007_indexes.sql', title: 'partial unique and query indexes', from: 'CREATE UNIQUE INDEX one_active_application_bootstrap' },
  { file: '0008_row_level_security.sql', title: 'forced row-level security and tenant/visibility policies', from: '-- Runtime roles MUST NOT own' },
  { file: '0009_guards.sql', title: 'integrity guard functions and triggers', from: 'CREATE FUNCTION guard_artifact_link_embargo()' },
  { file: '0010_roles_ownership_grants.sql', title: 'reference roles, ownership and column-limited runtime grants', from: '-- Reference roles.' },
];

export function importReferenceSchema(): Map<string, string> {
  const text = readFileSync(referencePath, 'utf8');
  const digest = createHash('sha256').update(text).digest('hex');
  const end = text.lastIndexOf('\nCOMMIT;');
  if (end < 0) throw new Error('reference schema has no COMMIT');
  const starts = SECTIONS.map((s) => {
    const i = text.indexOf(s.from);
    if (i < 0) throw new Error(`anchor not found: ${s.from}`);
    return i;
  });
  for (let i = 1; i < starts.length; i += 1) if ((starts[i] ?? 0) <= (starts[i - 1] ?? 0)) throw new Error('anchors out of order');
  const out = new Map<string, string>();
  SECTIONS.forEach((s, i) => {
    let body = text.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : end + 1);
    body = body.replace('SET LOCAL search_path = factory, public;\n', '');
    const header = [
      `-- ${s.file}: ${s.title}.`,
      `-- Imported verbatim from docs/spec/contracts/schema.sql (sha256 ${digest}) by`,
      '-- packages/database/scripts/import-reference-schema.ts. Do not edit; add a forward migration.',
      '-- phase: expand',
      'SET LOCAL search_path = factory, public;',
      '',
    ].join('\n');
    out.set(s.file, `${header}${body.trimEnd()}\n`);
  });
  return out;
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  const flag = process.argv.indexOf('--out');
  const dir = flag >= 0 ? process.argv[flag + 1] ?? '' : join(import.meta.dirname, '..', 'migrations');
  mkdirSync(dir, { recursive: true });
  for (const [file, body] of importReferenceSchema()) writeFileSync(join(dir, file), body);
  console.log(`imported ${String(SECTIONS.length)} reference migrations into ${dir}`);
}
