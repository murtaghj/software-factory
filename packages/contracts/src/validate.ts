// Runtime contract validation (W-003). Every wire envelope is validated against the reference
// JSON Schema (draft 2020-12) before use. Unknown fields are rejected wherever the contract closes
// an object (additionalProperties:false), and unknown major versions fail their const checks.
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import domainSchema from './generated/schemas/domain.schema.json' with { type: 'json' };
import type { DomainDefinitionName, DomainTypes } from './generated/domain.ts';
import { domainDefinitionNames } from './generated/domain.ts';

export const DOMAIN_SCHEMA_ID = 'https://factory.example/spec/domain/2.0';

// Annotation keywords used by the reference contracts. They carry review metadata and tool
// manifests, never validation semantics; declaring them keeps Ajv's strict mode on for everything else.
export const ANNOTATION_KEYWORDS = ['x-review-field-role', 'x-review-bundle-key', 'x-tools', 'x-errorSchema'] as const;

export type ContractError = { path: string; keyword: string; message: string; params: Record<string, unknown> };
export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: ContractError[] };

const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => Ajv2020;

function createAjv(): Ajv2020 {
  const ajv = new Ajv2020({ strict: true, strictRequired: false, strictTypes: false, allErrors: true, allowUnionTypes: true });
  addFormats(ajv);
  for (const keyword of ANNOTATION_KEYWORDS) ajv.addKeyword({ keyword, schemaType: ['string', 'object', 'boolean'] });
  ajv.addSchema(domainSchema);
  return ajv;
}

let shared: Ajv2020 | undefined;
const compiled = new Map<string, ValidateFunction>();

export function contractAjv(): Ajv2020 {
  shared ??= createAjv();
  return shared;
}

export function isDomainDefinition(name: string): name is DomainDefinitionName {
  return (domainDefinitionNames as readonly string[]).includes(name);
}

export function validatorFor(name: DomainDefinitionName): ValidateFunction {
  let fn = compiled.get(name);
  if (!fn) {
    const found = contractAjv().getSchema(`${DOMAIN_SCHEMA_ID}#/$defs/${name}`);
    if (!found) throw new Error(`No compiled schema for ${name}`);
    fn = found;
    compiled.set(name, fn);
  }
  return fn;
}

function toErrors(errors: ErrorObject[] | null | undefined): ContractError[] {
  return (errors ?? []).map((e) => ({ path: e.instancePath, keyword: e.keyword, message: e.message ?? e.keyword, params: e.params as Record<string, unknown> }));
}

export function validateContract<N extends DomainDefinitionName>(name: N, value: unknown): ValidationResult<DomainTypes[N]> {
  const fn = validatorFor(name);
  if (fn(value)) return { ok: true, value: value as DomainTypes[N] };
  return { ok: false, errors: toErrors(fn.errors) };
}

export function assertContract<N extends DomainDefinitionName>(name: N, value: unknown): DomainTypes[N] {
  const r = validateContract(name, value);
  if (!r.ok) throw new ContractViolation(name, r.errors);
  return r.value;
}

export class ContractViolation extends Error {
  readonly definition: string;
  readonly errors: ContractError[];
  constructor(definition: string, errors: ContractError[]) {
    super(`${definition} contract violation: ${errors.slice(0, 5).map((e) => `${e.path || '/'} ${e.message}`).join('; ')}`);
    this.name = 'ContractViolation';
    this.definition = definition;
    this.errors = errors;
  }
}

// Compiles every definition. Used by the contract suite to prove the whole reference schema is
// valid draft 2020-12 under Ajv strict mode.
export function compileAll(): number {
  for (const name of domainDefinitionNames) validatorFor(name);
  return domainDefinitionNames.length;
}
