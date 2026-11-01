// Ground-truth boundary analysis for fixture traces (AC-32 answer key). Compares each recorded
// service-boundary request with the callee's pinned contract, in causal order:
//   - request violates the callee contract → the caller produced invalid input;
//   - valid request but the callee answered 5xx → the callee is at fault.
// The last API that returned an error is reported separately and never assumed to be the cause.
// This is the fixture's answer key used to qualify the real diagnosis (W-038, chapter 08).
import { Ajv2020 } from 'ajv/dist/2020.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Span } from '../system/tracing.ts';
import { fixtureSrcDir } from '../releases/releases.ts';

const CONTRACT_FILES: Record<string, string> = { 'inventory-http-v1': 'contracts/inventory-http-v1.schema.json', 'orders-http-v1': 'contracts/orders-http-v1.schema.json' };

export type BoundaryFinding = { caller: string; callee: string; interfaceId: string; operation: string; violations: string[]; responseStatus?: number };
export type BoundaryAttribution = {
  affectedComponents: string[];
  lastErroringService: string | undefined;
  causalClaim: string;
  evidence: BoundaryFinding[];
  gaps: string[];
};

function loadAjv(): Ajv2020 {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  for (const file of Object.values(CONTRACT_FILES)) ajv.addSchema(JSON.parse(readFileSync(join(fixtureSrcDir, file), 'utf8')) as object);
  return ajv;
}

function depth(span: Span, byId: Map<string, Span>): number {
  let d = 0;
  for (let p = span.parentSpanId; p !== undefined; p = byId.get(p)?.parentSpanId) d += 1;
  return d;
}

export function attributeBoundaryFault(spans: Span[]): BoundaryAttribution {
  const ajv = loadAjv();
  const byId = new Map(spans.map((s) => [s.spanId, s]));
  const gaps = spans.filter((s) => s.parentSpanId !== undefined && !byId.has(s.parentSpanId)).map((s) => `span ${s.spanId} (${s.service}) has no recorded parent`);
  const ordered = [...spans].sort((a, b) => depth(a, byId) - depth(b, byId) || a.startedAt.localeCompare(b.startedAt));
  const erroring = spans.filter((s) => s.status === 'error' && s.kind === 'server').sort((a, b) => depth(b, byId) - depth(a, byId) || b.startedAt.localeCompare(a.startedAt));
  const evidence: BoundaryFinding[] = [];
  for (const span of ordered) {
    const b = span.boundary;
    if (!b) continue;
    const file = CONTRACT_FILES[b.interfaceId];
    const validate = file ? ajv.getSchema(`https://fixtures.factory.example/${b.interfaceId}#/$defs/${b.operation}`) : undefined;
    const violations = validate
      ? (validate(b.request) ? [] : (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? e.keyword}`))
      : [];
    if (!validate && b.request !== null) gaps.push(`no pinned contract for ${b.interfaceId} ${b.operation}`);
    evidence.push({ caller: span.service, callee: b.callee, interfaceId: b.interfaceId, operation: b.operation, violations, ...(b.responseStatus === undefined ? {} : { responseStatus: b.responseStatus }) });
  }
  const lastErroringService = erroring[0]?.service;
  const invalidInput = evidence.find((e) => e.violations.length > 0);
  if (invalidInput) {
    return { affectedComponents: [invalidInput.caller], lastErroringService, causalClaim: `${invalidInput.caller} sent a request that violates ${invalidInput.interfaceId} ${invalidInput.operation}; ${invalidInput.callee} failed on that invalid input`, evidence, gaps };
  }
  const deepestFailure = [...evidence].reverse().find((e) => (e.responseStatus ?? 0) >= 500 && !evidence.some((x) => x.caller === e.callee && (x.responseStatus ?? 0) >= 500));
  if (deepestFailure) {
    return { affectedComponents: [deepestFailure.callee], lastErroringService, causalClaim: `${deepestFailure.callee} returned ${String(deepestFailure.responseStatus)} for a contract-valid ${deepestFailure.operation}`, evidence, gaps };
  }
  return { affectedComponents: [], lastErroringService, causalClaim: 'no boundary fault established from the recorded evidence', evidence, gaps };
}
