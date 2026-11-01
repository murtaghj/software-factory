// Contract compatibility gate (W-003). Compares a baseline contract revision with a candidate.
//
// - breaking: existing readers or writers stop working (removed/retyped fields, new requirements,
//   tightened bounds, changed composition, any change to a keyword this gate does not model).
// - reader_first: additive changes (new optional field, new enum value, relaxed bound). Strict
//   readers reject unknown values, so readers must be deployed before writers (chapter 03:
//   "Deploy compatible validators/readers before enabling these contract revisions").
//
// Unknown keywords default to breaking: the gate fails closed.
type Schema = { [key: string]: unknown };
type Defs = Record<string, Schema>;
const isSchema = (v: unknown): v is Schema => typeof v === 'object' && v !== null && !Array.isArray(v);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export type ChangeSeverity = 'breaking' | 'reader_first';
export type BreakingChange = { location: string; change: string; severity: ChangeSeverity };

const ANNOTATIONS = new Set(['title', 'description', '$comment', 'examples', 'default', 'deprecated', 'readOnly', 'writeOnly']);
const LOWER_BOUNDS = new Set(['minLength', 'minItems', 'minimum', 'exclusiveMinimum', 'minContains', 'minProperties']);
const UPPER_BOUNDS = new Set(['maxLength', 'maxItems', 'maximum', 'exclusiveMaximum', 'maxContains', 'maxProperties']);

function compareSchema(path: string, before: unknown, after: unknown, out: BreakingChange[]): void {
  if (same(before, after)) return;
  const push = (change: string, severity: ChangeSeverity = 'breaking', location = path): void => { out.push({ location, change, severity }); };
  if (!isSchema(before) || !isSchema(after)) { push('schema replaced'); return; }
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  for (const key of keys) {
    const b = before[key];
    const a = after[key];
    if (same(b, a) || ANNOTATIONS.has(key) || key.startsWith('x-')) continue;
    switch (key) {
      case 'properties': {
        const bp = isSchema(b) ? b : {};
        const ap = isSchema(a) ? a : {};
        const closed = after.additionalProperties === false;
        for (const name of Object.keys(bp)) {
          if (!(name in ap)) push(closed ? 'property removed from a closed object' : 'property removed', closed ? 'breaking' : 'reader_first', `${path}.${name}`);
          else compareSchema(`${path}.${name}`, bp[name], ap[name], out);
        }
        for (const name of Object.keys(ap)) if (!(name in bp)) push('optional property added', 'reader_first', `${path}.${name}`);
        break;
      }
      case 'required': {
        const br = new Set(Array.isArray(b) ? b.map(String) : []);
        const ar = new Set(Array.isArray(a) ? a.map(String) : []);
        for (const r of ar) if (!br.has(r)) push(`property ${r} became required`);
        for (const r of br) if (!ar.has(r)) push(`property ${r} became optional`, 'reader_first');
        break;
      }
      case 'enum': {
        if (!Array.isArray(b) || !Array.isArray(a)) { push(Array.isArray(a) ? 'value narrowed to an enum' : 'enum removed'); break; }
        const bv = (b as unknown[]).map((v) => JSON.stringify(v));
        const av = (a as unknown[]).map((v) => JSON.stringify(v));
        for (const v of bv) if (!av.includes(v)) push(`enum value ${v} removed`);
        for (const v of av) if (!bv.includes(v)) push(`enum value ${v} added`, 'reader_first');
        break;
      }
      case 'items':
        compareSchema(`${path}[]`, b, a, out);
        break;
      default: {
        if (LOWER_BOUNDS.has(key) || UPPER_BOUNDS.has(key)) {
          const tightened = typeof a === 'number' && (typeof b !== 'number' || (LOWER_BOUNDS.has(key) ? a > b : a < b));
          push(`${key} ${tightened ? 'tightened' : 'relaxed'} from ${String(b)} to ${String(a)}`, tightened ? 'breaking' : 'reader_first');
        } else if (key === 'additionalProperties' && b === false && a !== false) {
          push('object opened to additional properties', 'reader_first');
        } else {
          // type, const, $ref, format, pattern, not, contains, uniqueItems, multipleOf, oneOf/anyOf/allOf,
          // if/then/else, dependent*, patternProperties, propertyNames and any unmodelled keyword.
          push(`${key} changed from ${b === undefined ? 'absent' : JSON.stringify(b)} to ${a === undefined ? 'absent' : JSON.stringify(a)}`.slice(0, 300));
        }
      }
    }
  }
}

export function breakingSchemaChanges(before: Defs, after: Defs): BreakingChange[] {
  const out: BreakingChange[] = [];
  for (const [name, schema] of Object.entries(before)) {
    if (!(name in after)) { out.push({ location: name, change: 'definition removed', severity: 'breaking' }); continue; }
    compareSchema(name, schema, after[name], out);
  }
  for (const name of Object.keys(after)) if (!(name in before)) out.push({ location: name, change: 'definition added', severity: 'reader_first' });
  return out;
}

type Media = Record<string, { schema?: unknown }>;
type Operation = {
  operationId: string;
  responses: Record<string, { content?: Media }>;
  parameters?: Array<{ name: string; in: string; required?: boolean; schema?: unknown }>;
  requestBody?: { required?: boolean; content?: Media };
};
type Paths = Record<string, Record<string, Operation>>;

export function breakingApiChanges(before: Paths, after: Paths): BreakingChange[] {
  const out: BreakingChange[] = [];
  for (const [path, methods] of Object.entries(before)) {
    for (const [method, op] of Object.entries(methods)) {
      const loc = `${method.toUpperCase()} ${path}`;
      const push = (change: string, severity: ChangeSeverity = 'breaking'): void => { out.push({ location: loc, change, severity }); };
      const next = after[path]?.[method];
      if (!next) { push('operation removed'); continue; }
      if (op.operationId !== next.operationId) push(`operationId changed to ${next.operationId}`);
      for (const [status, response] of Object.entries(op.responses)) {
        const nr = next.responses[status];
        if (!nr) { push(`response ${status} removed`); continue; }
        if (!same(response.content, nr.content)) push(`response ${status} content changed`);
      }
      for (const status of Object.keys(next.responses)) if (!(status in op.responses)) push(`response ${status} added`, 'reader_first');
      if (next.requestBody?.required === true && op.requestBody?.required !== true) push('request body became required');
      if (!same(op.requestBody?.content, next.requestBody?.content)) push('request body schema changed');
      const params = new Map((op.parameters ?? []).map((p) => [`${p.in}:${p.name}`, p]));
      for (const p of next.parameters ?? []) {
        const prior = params.get(`${p.in}:${p.name}`);
        if (!prior) { if (p.required === true) push(`new required ${p.in} parameter ${p.name}`); else push(`optional ${p.in} parameter ${p.name} added`, 'reader_first'); continue; }
        if (p.required === true && prior.required !== true) push(`${p.in} parameter ${p.name} became required`);
        if (!same(prior.schema, p.schema)) push(`${p.in} parameter ${p.name} schema changed`);
      }
      for (const key of params.keys()) if (!(next.parameters ?? []).some((p) => `${p.in}:${p.name}` === key)) push(`parameter ${key} removed`);
    }
  }
  return out;
}
