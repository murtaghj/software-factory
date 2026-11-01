import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { generate } from '../scripts/generate.ts';
import { compileAll, validateContract, contractAjv, breakingSchemaChanges, breakingApiChanges, domainDefinitionNames, factoryToolSets, apiOperations, type DomainDefinitionName } from '../src/index.ts';
import { allFixtureFiles, classify, readFixture, RETAINED_TOOL_FIXTURES, type Classified, type ExpectedError } from './fixture-catalog.ts';

const pkgRoot = join(import.meta.dirname, '..');
const specContracts = join(pkgRoot, '..', '..', 'docs', 'spec', 'contracts');
const generatedDir = join(pkgRoot, 'src', 'generated');
const readJson = (p: string): unknown => JSON.parse(readFileSync(p, 'utf8'));
const listFiles = (dir: string): string[] => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => relative(dir, join(e.parentPath, e.name)).split(sep).join('/')).sort();

type Ajvish = { ok: boolean; errors?: Array<{ path: string; keyword: string; params: Record<string, unknown> }> };
function matches(result: Ajvish, expected: ExpectedError): boolean {
  return (result.errors ?? []).some((e) => e.path === expected.path && e.keyword === expected.keyword
    && (expected.missingProperty === undefined || e.params.missingProperty === expected.missingProperty));
}

const catalogue: Classified[] = allFixtureFiles().map(classify);
const byKind = <K extends Classified['kind']>(k: K): Array<Extract<Classified, { kind: K }>> => catalogue.filter((c): c is Extract<Classified, { kind: K }> => c.kind === k);

describe('AC-260 toolchain and contract generation', () => {
  it('generation is reproducible: a re-run produces the committed files byte for byte and nothing else', () => {
    const fresh = generate();
    const onDisk = listFiles(generatedDir);
    expect(onDisk).toEqual([...fresh.keys()].map((k) => k.split(sep).join('/')).sort());
    for (const [rel, text] of fresh) expect(readFileSync(join(generatedDir, rel), 'utf8'), rel).toBe(text);
    const again = generate();
    for (const [rel, text] of fresh) expect(again.get(rel)).toBe(text);
  });

  it('generated schema copies are byte-identical to the read-only specification and record their digests', () => {
    const sources = (readJson(join(generatedDir, 'sources.json')) as { specRevision: string; sources: Record<string, string> });
    expect(sources.specRevision).toBe('1.13');
    for (const [name, digest] of Object.entries(sources.sources)) {
      const bytes = readFileSync(join(specContracts, name));
      expect(createHash('sha256').update(bytes).digest('hex'), name).toBe(digest);
      if (name.endsWith('.json')) expect(readFileSync(join(generatedDir, 'schemas', name)).equals(bytes), name).toBe(true);
    }
  });

  it('every domain definition is valid draft 2020-12 and compiles under Ajv strict mode', () => {
    expect(compileAll()).toBe(312);
    const meta = contractAjv().validateSchema(readJson(join(generatedDir, 'schemas', 'domain.schema.json')) as object);
    expect(meta).toBe(true);
  });

  it('every OpenAPI and tool-manifest reference resolves to a domain definition', () => {
    const names = new Set<string>(domainDefinitionNames);
    const ops = Object.values(apiOperations);
    expect(ops.length).toBe(49);
    for (const op of ops) {
      if (op.requestSchema !== null) expect(names.has(op.requestSchema), `${op.method} ${op.path}`).toBe(true);
      for (const r of Object.values(op.responses as Record<string, { schema: string | null }>)) if (r.schema !== null) expect(names.has(r.schema)).toBe(true);
    }
    const apiText = readFileSync(join(specContracts, 'api.openapi.json'), 'utf8');
    const refs = [...apiText.matchAll(/"\$ref": "\.\/domain\.schema\.json#\/\$defs\/([A-Za-z0-9_]+)"/g)].map((m) => m[1] ?? '');
    expect(refs.length).toBeGreaterThan(100);
    for (const ref of refs) expect(names.has(ref), ref).toBe(true);
    for (const [version, tools] of Object.entries(factoryToolSets)) {
      for (const [tool, io] of Object.entries(tools as Record<string, { input: string; output: string }>)) {
        expect(names.has(io.input), `${version} ${tool} input`).toBe(true);
        expect(names.has(io.output), `${version} ${tool} output`).toBe(true);
      }
    }
  });

  it('generated types carry a mutual-assignability assertion against the reference types for every definition', () => {
    const compat = readFileSync(join(generatedDir, 'reference-compat.ts'), 'utf8');
    for (const name of domainDefinitionNames) expect(compat).toContain(`export type Compat_${name} = Assert<Mutual<G.${name}, R.${name}>>;`);
  });

  it('the fixture catalogue classifies every example file into a declared bucket', () => {
    // Exact counts make any reclassification a visible, reviewed change.
    expect(allFixtureFiles().length).toBe(403);
    const semantic = byKind('semantic');
    expect({
      schemaPositive: byKind('schema-positive').length,
      schemaNegative: byKind('schema-negative').length,
      semanticPositive: semantic.filter((c) => c.polarity === 'positive').length,
      semanticNegative: semantic.filter((c) => c.polarity === 'negative').length,
      external: byKind('external').length,
    }).toEqual({ schemaPositive: 94, schemaNegative: 45, semanticPositive: 46, semanticNegative: 217, external: 1 });
    // Every semantic fixture carries at least one wire document that is checked below.
    expect(semantic.filter((c) => c.parts.length === 0).map((c) => c.file)).toEqual([]);
  });

  it('positive fixtures validate against their contract', () => {
    const failures: string[] = [];
    for (const c of byKind('schema-positive')) {
      for (const part of c.parts) {
        const r = validateContract(part.definition, part.value);
        if (!r.ok) failures.push(`${c.file} as ${part.definition}: ${JSON.stringify(r.errors.slice(0, 3))}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('retained tool fixtures validate under their frozen readers; current tools reject the legacy stage identity', () => {
    for (const [file, uses] of Object.entries(RETAINED_TOOL_FIXTURES)) {
      for (const use of uses) {
        const def = factoryToolSets[use.toolSet][use.tool][use.field] as DomainDefinitionName;
        expect(validateContract(def, readFixture(file)).ok, `${file} ${use.toolSet} ${def}`).toBe(true);
      }
    }
    const canonicalId = (readFixture('stage-result.json') as { stageRunId: string }).stageRunId;
    for (const [file, tool] of [['factory-submit-receipt.json', 'submit_result'], ['factory-verify-feedback-v1.1.json', 'verify']] as const) {
      const def = factoryToolSets['1.2.0'][tool].output as DomainDefinitionName;
      const legacy = readFixture(file) as Record<string, unknown>;
      const r = validateContract(def, legacy);
      expect(r.ok, `${file} legacy identity`).toBe(false);
      expect(matches(r as Ajvish, { path: '/stageRunId', keyword: 'pattern' })).toBe(true);
      expect(validateContract(def, { ...legacy, stageRunId: canonicalId }).ok, `${file} canonical identity`).toBe(true);
    }
  });

  it('negative fixtures are rejected by the schema for their stated reason', () => {
    const problems: string[] = [];
    for (const c of byKind('schema-negative')) {
      const r = validateContract(c.part.definition, c.part.value);
      if (r.ok) { problems.push(`${c.file}: accepted`); continue; }
      if (!matches(r, c.expected)) problems.push(`${c.file}: rejected, but not for "${c.statedReason}" (${JSON.stringify(c.expected)}); errors ${JSON.stringify(r.errors.map((e) => `${e.path} ${e.keyword}`))}`);
    }
    expect(problems).toEqual([]);
  });

  it('semantic fixtures are wire-valid, so their rejection is owned by a named service predicate', () => {
    const problems: string[] = [];
    const owners = new Set<string>();
    for (const c of byKind('semantic')) {
      owners.add(c.owner);
      for (const part of c.parts) {
        const r = validateContract(part.definition, part.value);
        if (!r.ok) problems.push(`${c.file} ${part.label} as ${part.definition}: ${JSON.stringify(r.errors.slice(0, 2).map((e) => `${e.path} ${e.keyword}`))}`);
      }
    }
    expect(problems).toEqual([]);
    expect([...owners].sort()).toEqual(['W-141–W-143 (ai_only review mode; out of scope for M1)', 'W-144 (design-only delivery; out of scope for M1)']);
  });

  it('specification-validator negatives (tools/validate_spec.py) are rejected for their stated reason', () => {
    const task = readFixture('feature-task.json') as Record<string, unknown>;
    const greenfield = readFixture('greenfield-task.json') as Record<string, unknown>;
    const clone = <T>(v: T): T => structuredClone(v);
    const with_ = (base: Record<string, unknown>, edit: (d: Record<string, unknown>) => void): Record<string, unknown> => { const d = clone(base); edit(d); return d; };
    const stageResult = readFixture('stage-result.json') as Record<string, unknown>;
    const queued = readFixture('queued-environment.json') as Record<string, unknown>;
    const pr = readFixture('draft-preview-pr.json') as Record<string, unknown>;
    const cases: Array<[string, DomainDefinitionName, unknown, ExpectedError]> = [
      ['unknown work type', 'TaskRequest', with_(task, (d) => { d.workType = 'unknown'; }), { path: '/workType', keyword: 'enum' }],
      ['unknown task field', 'TaskRequest', with_(task, (d) => { d.unexpected = true; }), { path: '', keyword: 'additionalProperties' }],
      ['investigation deployment', 'TaskRequest', with_(task, (d) => { d.workType = 'investigation'; d.deliveryScope = 'production'; }), { path: '/deliveryScope', keyword: 'const' }],
      ['docs preview', 'TaskRequest', with_(task, (d) => { d.workType = 'documentation'; d.deliveryScope = 'preview'; }), { path: '/deliveryScope', keyword: 'enum' }],
      ['negative budget', 'TaskRequest', with_(task, (d) => { (d.budget as Record<string, unknown>).maxMicroUsd = -1; }), { path: '/budget/maxMicroUsd', keyword: 'minimum' }],
      ['missing target context', 'TaskRequest', with_(task, (d) => { delete d.targetContext; }), { path: '', keyword: 'required', missingProperty: 'targetContext' }],
      ['legacy task format', 'TaskRequest', with_(task, (d) => { d.schemaVersion = '1.0'; }), { path: '/schemaVersion', keyword: 'const' }],
      ['new-target bug', 'TaskRequest', with_(greenfield, (d) => { d.workType = 'bug'; }), { path: '/workType', keyword: 'const' }],
      ['unknown repository kind', 'TaskRequest', with_(greenfield, (d) => { ((d.targetContext as Record<string, unknown>).repositoryIntent as Record<string, unknown>).kind = 'unknown'; }), { path: '/targetContext/repositoryIntent/kind', keyword: 'const' }],
      ['draft fields on existing target', 'TaskRequest', with_(task, (d) => { (d.targetContext as Record<string, unknown>).draftRevision = 1; }), { path: '/targetContext', keyword: 'additionalProperties' }],
      ['ownerless draft', 'ApplicationDraftRequest', with_(readFixture('application-draft.json') as Record<string, unknown>, (d) => { d.ownerIds = []; }), { path: '/ownerIds', keyword: 'minItems' }],
      ['zero base commit', 'BootstrapReceipt', with_(readFixture('bootstrap-receipt.json') as Record<string, unknown>, (d) => { d.baseCommit = '0'.repeat(40); }), { path: '/baseCommit', keyword: 'pattern' }],
      ['empty base commit', 'BootstrapReceipt', with_(readFixture('bootstrap-receipt.json') as Record<string, unknown>, (d) => { d.baseCommit = ''; }), { path: '/baseCommit', keyword: 'pattern' }],
      ['bootstrap without repository choice', 'BootstrapPlan', with_(readFixture('bootstrap-plan.json') as Record<string, unknown>, (d) => { delete (d.target as Record<string, unknown>).repositoryIntent; }), { path: '/target', keyword: 'required', missingProperty: 'repositoryIntent' }],
      ['oversized question batch', 'IntentAnswerRequest', with_(readFixture('intent-answer.json') as Record<string, unknown>, (d) => { const a = d.answers as unknown[]; d.answers = [...a, ...a, ...a, ...a]; }), { path: '/answers', keyword: 'maxItems' }],
      ['unversioned answer', 'IntentAnswerRequest', with_(readFixture('intent-answer.json') as Record<string, unknown>, (d) => { delete d.interviewRevision; }), { path: '', keyword: 'required', missingProperty: 'interviewRevision' }],
      ['missing interview command payload', 'CommandEnvelope', { commandId: '00000000-0000-4000-8000-000000000001', expectedRevision: 1, kind: 'answer_intent', reason: 'human response' }, { path: '', keyword: 'required', missingProperty: 'answers' }],
      ['missing command payload', 'CommandEnvelope', { commandId: '00000000-0000-4000-8000-000000000001', expectedRevision: 1, kind: 'amend_spec', reason: 'changed intent' }, { path: '', keyword: 'required', missingProperty: 'specRef' }],
      ['owner reassignment without principal', 'CommandEnvelope', { commandId: '00000000-0000-4000-8000-000000000001', expectedRevision: 1, kind: 'reassign_owner', reason: 'handoff' }, { path: '', keyword: 'required', missingProperty: 'ownerPrincipalId' }],
      ...(['status', 'statusObservedAt', 'generation', 'currentOperationId'] as const).map((f): [string, DomainDefinitionName, unknown, ExpectedError] => [`environment observation without ${f}`, 'EnvironmentView', with_(queued, (d) => { Reflect.deleteProperty(d, f); }), { path: '', keyword: 'required', missingProperty: f }]),
      ...(['draft', 'labels', 'baseRepository', 'headRepository'] as const).map((f): [string, DomainDefinitionName, unknown, ExpectedError] => [`PR observation without ${f}`, 'PullRequest', with_(pr, (d) => { Reflect.deleteProperty(d, f); }), { path: '', keyword: 'required', missingProperty: f }]),
      ...['00000000-0000-4000-8000-000000000002', 'task-2/plan-1/implement/attempt-1', 'task-00000000-0000-4000-8000-000000000002/plan-0/implement/attempt-1'].map((id): [string, DomainDefinitionName, unknown, ExpectedError] => [`noncanonical stage identity ${id}`, 'StageResult', with_(stageResult, (d) => { d.stageRunId = id; }), { path: '/stageRunId', keyword: 'pattern' }]),
      ['not-ready success body', 'Health', { status: 'not_ready', requestId: 'probe' }, { path: '/status', keyword: 'const' }],
      ['supersession overwrites stage outcome', 'StageStatus', 'superseded', { path: '', keyword: 'enum' }],
      ['undefined decision action', 'DecisionAction', 'invented_approval', { path: '', keyword: 'enum' }],
      ...(['take_over', 'hand_back'] as const).map((kind): [string, DomainDefinitionName, unknown, ExpectedError] => [`${kind} without epoch transfer`, 'CommandEnvelope', { commandId: (task.applicationIds as string[])[0], expectedRevision: 1, kind, reason: 'Transfer ownership' }, { path: '', keyword: 'required', missingProperty: 'epochTransfer' }]),
    ];
    const problems: string[] = [];
    for (const [label, def, value, expected] of cases) {
      const r = validateContract(def, value);
      if (r.ok) problems.push(`${label}: accepted`);
      else if (!matches(r, expected)) problems.push(`${label}: wrong reason ${JSON.stringify(r.errors.map((e) => `${e.path} ${e.keyword} ${JSON.stringify(e.params)}`))}`);
    }
    expect(problems).toEqual([]);
    const checkpointRef = stageResult.checkpointRef;
    for (const kind of ['take_over', 'hand_back']) {
      const ok = validateContract('CommandEnvelope', { commandId: '00000000-0000-4000-8000-000000000001', expectedRevision: 1, kind, reason: 'Transfer ownership', epochTransfer: { workspaceId: '00000000-0000-4000-8000-000000000001', expectedEpoch: 1, checkpointRef, targetRef: 'workspace:authorized' } });
      expect(ok.ok, kind).toBe(true);
    }
  });

  it('compatibility gate: the 1.13 baseline has no breaking change and representative breaks are detected', () => {
    type Defs = Record<string, Record<string, unknown>>;
    const baseline = readJson(join(pkgRoot, 'baseline', '1.13', 'domain.schema.json')) as { $defs: Defs };
    const current = readJson(join(specContracts, 'domain.schema.json')) as { $defs: Defs };
    expect(breakingSchemaChanges(baseline.$defs, current.$defs)).toEqual([]); // neither breaking nor reader_first
    const baseApi = readJson(join(pkgRoot, 'baseline', '1.13', 'api.openapi.json')) as { paths: Parameters<typeof breakingApiChanges>[0] };
    const curApi = readJson(join(specContracts, 'api.openapi.json')) as { paths: Parameters<typeof breakingApiChanges>[0] };
    expect(breakingApiChanges(baseApi.paths, curApi.paths)).toEqual([]);

    const mutate = (edit: (d: Defs) => void): Defs => { const d = structuredClone(current.$defs); edit(d); return d; };
    const prop = (d: Defs, def: string): Record<string, Record<string, unknown>> => d[def]?.properties as Record<string, Record<string, unknown>>;
    const breaking = (d: Defs): string[] => breakingSchemaChanges(current.$defs, d).filter((c) => c.severity === 'breaking').map((c) => `${c.location}: ${c.change}`);
    const expectBreak = (d: Defs, fragment: string): void => { expect(breaking(d).some((c) => c.includes(fragment)), `${fragment} in ${breaking(d).join(' | ')}`).toBe(true); };
    expectBreak(mutate((d) => { Reflect.deleteProperty(d, 'TaskEvent'); }), 'TaskEvent: definition removed');
    expectBreak(mutate((d) => { (d.TaskRequest?.required as string[]).push('extraField'); }), 'property extraField became required');
    expectBreak(mutate((d) => { d.Assurance = { type: 'string', enum: ['fast', 'standard'] }; }), 'enum value "enhanced" removed');
    expectBreak(mutate((d) => { Reflect.deleteProperty(prop(d, 'ArtifactRef'), 'sizeBytes'); }), 'ArtifactRef.sizeBytes: property removed from a closed object');
    expectBreak(mutate((d) => { prop(d, 'ArtifactRef').sizeBytes = { type: 'string' }; }), 'ArtifactRef.sizeBytes: type changed');
    expectBreak(mutate((d) => { prop(d, 'ArtifactRef').artifactId = { type: 'string', format: 'date-time' }; }), 'ArtifactRef.artifactId: format changed');
    expectBreak(mutate((d) => { prop(d, 'ArtifactRef').mediaType = { type: 'string', minLength: 1, const: 'application/json' }; }), 'ArtifactRef.mediaType: const changed');
    expectBreak(mutate((d) => { prop(d, 'ArtifactRef').mediaType = { type: 'string', minLength: 1, not: { const: 'text/html' } }; }), 'ArtifactRef.mediaType: not changed');
    expectBreak(mutate((d) => { prop(d, 'TaskRequest').applicationIds = { ...prop(d, 'TaskRequest').applicationIds, uniqueItems: true }; }), 'TaskRequest.applicationIds: uniqueItems changed');
    expectBreak(mutate((d) => { prop(d, 'TaskRequest').applicationIds = { ...prop(d, 'TaskRequest').applicationIds, contains: { const: 'x' } }; }), 'TaskRequest.applicationIds: contains changed');
    expectBreak(mutate((d) => { prop(d, 'ArtifactRef').sizeBytes = { type: 'integer', exclusiveMinimum: 10 }; }), 'exclusiveMinimum tightened');
    expectBreak(mutate((d) => { (prop(d, 'ArtifactRef').sizeBytes as Record<string, unknown>)['x-unknown-but-ignored'] = 1; (prop(d, 'ArtifactRef').sizeBytes as Record<string, unknown>).someNewKeyword = true; }), 'someNewKeyword changed');
    const additive = breakingSchemaChanges(current.$defs, mutate((d) => { prop(d, 'TaskView').extraOptional = { type: 'string' }; }));
    expect(additive).toEqual([{ location: 'TaskView.extraOptional', change: 'optional property added', severity: 'reader_first' }]);

    type Paths = Parameters<typeof breakingApiChanges>[0];
    const apiMutate = (edit: (p: Paths) => void): string[] => { const p = structuredClone(curApi.paths); edit(p); return breakingApiChanges(curApi.paths, p).filter((c) => c.severity === 'breaking').map((c) => `${c.location}: ${c.change}`); };
    expect(apiMutate((p) => { Reflect.deleteProperty(p, '/tasks'); })).toContain('POST /tasks: operation removed');
    expect(apiMutate((p) => { const op = p['/tasks']?.post; if (op?.requestBody) op.requestBody.content = { 'application/json': { schema: { $ref: './domain.schema.json#/$defs/TaskView' } } }; })).toContain('POST /tasks: request body schema changed');
    expect(apiMutate((p) => { const op = p['/tasks/{taskId}']?.get; const r = op?.responses['200']; if (r) r.content = { 'application/json': { schema: { $ref: './domain.schema.json#/$defs/TaskPage' } } }; })).toContain('GET /tasks/{taskId}: response 200 content changed');
    expect(apiMutate((p) => { const op = p['/tasks/{taskId}/commands']?.post; if (op) op.parameters = [...(op.parameters ?? []), { name: 'X-New', in: 'header', required: true }]; })).toContain('POST /tasks/{taskId}/commands: new required header parameter X-New');
    expect(apiMutate((p) => { const op = p['/tasks/{taskId}/commands']?.post; if (op?.requestBody) op.requestBody = { ...op.requestBody, required: false }; })).toEqual([]);
  });
});
