// W3C trace-context propagation and a span collector shared by the fixture services.
import { randomBytes } from 'node:crypto';

export type BoundaryRecord = {
  callee: string;
  interfaceId: string;
  operation: string;
  request: unknown;
  responseStatus?: number;
  response?: unknown;
};

export type Span = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  service: string;
  operation: string;
  kind: 'server' | 'client' | 'consumer' | 'internal';
  startedAt: string;
  endedAt?: string;
  status: 'ok' | 'error';
  httpStatus?: number;
  error?: string;
  boundary?: BoundaryRecord;
};

export type TraceContext = { traceId: string; spanId: string };

export const newTraceId = (): string => randomBytes(16).toString('hex');
export const newSpanId = (): string => randomBytes(8).toString('hex');

export function formatTraceparent(ctx: TraceContext): string {
  return `00-${ctx.traceId}-${ctx.spanId}-01`;
}

export function parseTraceparent(header: string | undefined): TraceContext | undefined {
  if (!header) return undefined;
  const m = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/.exec(header.trim());
  if (!m?.[1] || !m[2] || /^0+$/.test(m[1]) || /^0+$/.test(m[2])) return undefined;
  return { traceId: m[1], spanId: m[2] };
}

export class TraceCollector {
  private readonly spans: Span[] = [];

  start(service: string, operation: string, kind: Span['kind'], parent?: TraceContext): Span {
    const span: Span = {
      traceId: parent?.traceId ?? newTraceId(),
      spanId: newSpanId(),
      service,
      operation,
      kind,
      startedAt: new Date().toISOString(),
      status: 'ok',
      ...(parent ? { parentSpanId: parent.spanId } : {}),
    };
    this.spans.push(span);
    return span;
  }

  end(span: Span, outcome: { status?: Span['status']; httpStatus?: number; error?: string } = {}): void {
    span.endedAt = new Date().toISOString();
    if (outcome.status) span.status = outcome.status;
    if (outcome.httpStatus !== undefined) span.httpStatus = outcome.httpStatus;
    if (outcome.error !== undefined) span.error = outcome.error;
  }

  trace(traceId: string): Span[] {
    return this.spans.filter((s) => s.traceId === traceId).map((s) => structuredClone(s));
  }

  all(): Span[] {
    return this.spans.map((s) => structuredClone(s));
  }
}

export const contextOf = (span: Span): TraceContext => ({ traceId: span.traceId, spanId: span.spanId });
