// Contract compatibility gate (W-003). Compares a baseline contract revision with a candidate and
// lists changes that would break existing readers or writers. A breaking change requires a new
// major revision (chapter 02: "Never change a field's meaning in place"; "Breaking formats create a
// new major revision").
type Schema = { [key: string]: unknown };
type Defs = Record<string, Schema>;
const isSchema = (v: unknown): v is Schema => typeof v === 'object' && v !== null && !Array.isArray(v);

export type BreakingChange = { location: string; change: string };

function compareSchema(path: string, before: unknown, after: unknown, out: BreakingChange[]): void {
  if (!isSchema(before) || !isSchema(after)) return;
  if (before.$ref !== after.$ref && (typeof before.$ref === 'string' || typeof after.$ref === 'string')) {
    out.push({ location: path, change: `reference changed from ${String(before.$ref)} to ${String(after.$ref)}` });
    return;
  }
  if (JSON.stringify(before.type) !== JSON.stringify(after.type) && before.type !== undefined) {
    out.push({ location: path, change: `type changed from ${JSON.stringify(before.type)} to ${JSON.stringify(after.type)}` });
  }
  if ('const' in before && JSON.stringify(before.const) !== JSON.stringify(after.const)) {
    out.push({ location: path, change: `const changed from ${JSON.stringify(before.const)} to ${JSON.stringify(after.const)}` });
  }
  if (Array.isArray(before.enum)) {
    const previous = (before.enum as unknown[]).map((v) => JSON.stringify(v));
    const next = Array.isArray(after.enum) ? (after.enum as unknown[]).map((v) => JSON.stringify(v)) : undefined;
    for (const value of previous) {
      if (next && !next.includes(value)) out.push({ location: path, change: `enum value ${value} removed` });
    }
    // Adding values to an enum breaks strict readers of a closed set; report it so the reviewer decides.
    if (next && next.length > previous.length) {
      const added = next.filter((v) => !previous.includes(v));
      if (added.length > 0) out.push({ location: path, change: `enum values added ${added.join(', ')} (readers of the closed set must be deployed first)` });
    }
  } else if (Array.isArray(after.enum) && before.type !== undefined && !('const' in before)) {
    out.push({ location: path, change: 'unconstrained value narrowed to an enum' });
  }
  const beforeRequired = new Set(Array.isArray(before.required) ? before.required.map(String) : []);
  for (const r of Array.isArray(after.required) ? after.required.map(String) : []) {
    if (!beforeRequired.has(r)) out.push({ location: path, change: `property ${r} became required` });
  }
  if (before.additionalProperties !== false && after.additionalProperties === false) {
    out.push({ location: path, change: 'object closed to additional properties' });
  }
  for (const key of ['minLength', 'minItems', 'minimum'] as const) {
    const b = before[key]; const a = after[key];
    if (typeof a === 'number' && (typeof b !== 'number' || a > b)) out.push({ location: path, change: `${key} tightened to ${String(a)}` });
  }
  for (const key of ['maxLength', 'maxItems', 'maximum'] as const) {
    const b = before[key]; const a = after[key];
    if (typeof a === 'number' && (typeof b !== 'number' || a < b)) out.push({ location: path, change: `${key} tightened to ${String(a)}` });
  }
  if (typeof after.pattern === 'string' && after.pattern !== before.pattern) out.push({ location: path, change: `pattern changed to ${after.pattern}` });
  const bp = isSchema(before.properties) ? before.properties : {};
  const ap = isSchema(after.properties) ? after.properties : {};
  for (const [name, schema] of Object.entries(bp)) {
    if (!(name in ap)) {
      if (after.additionalProperties === false) out.push({ location: `${path}.${name}`, change: 'property removed from a closed object' });
      continue;
    }
    compareSchema(`${path}.${name}`, schema, ap[name], out);
  }
  compareSchema(`${path}[]`, before.items, after.items, out);
  for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
    const b = before[key]; const a = after[key];
    if (Array.isArray(b) || Array.isArray(a)) {
      if (JSON.stringify(b) !== JSON.stringify(a)) out.push({ location: `${path}.${key}`, change: `${key} composition changed` });
    }
  }
}

export function breakingSchemaChanges(before: Defs, after: Defs): BreakingChange[] {
  const out: BreakingChange[] = [];
  for (const [name, schema] of Object.entries(before)) {
    if (!(name in after)) { out.push({ location: name, change: 'definition removed' }); continue; }
    compareSchema(name, schema, after[name], out);
  }
  return out;
}

type Operation = { operationId: string; responses: Record<string, unknown>; parameters?: Array<{ name: string; in: string; required?: boolean }> };
type Paths = Record<string, Record<string, Operation>>;

export function breakingApiChanges(before: Paths, after: Paths): BreakingChange[] {
  const out: BreakingChange[] = [];
  for (const [path, methods] of Object.entries(before)) {
    for (const [method, op] of Object.entries(methods)) {
      const next = after[path]?.[method];
      if (!next) { out.push({ location: `${method.toUpperCase()} ${path}`, change: 'operation removed' }); continue; }
      for (const status of Object.keys(op.responses)) {
        if (!(status in next.responses)) out.push({ location: `${method.toUpperCase()} ${path}`, change: `response ${status} removed` });
      }
      const known = new Set((op.parameters ?? []).map((p) => `${p.in}:${p.name}`));
      for (const p of next.parameters ?? []) {
        if (p.required === true && !known.has(`${p.in}:${p.name}`)) out.push({ location: `${method.toUpperCase()} ${path}`, change: `new required ${p.in} parameter ${p.name}` });
      }
    }
  }
  return out;
}
