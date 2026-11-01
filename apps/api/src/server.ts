// Fastify API (chapter 01: "Fastify API ... Business logic remains outside route handlers").
// W-008 scope: OIDC authentication, application RBAC and the artifact read/access routes.
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { validateContract } from '@factory/contracts';
import type { Database } from '@factory/database';
import { ArtifactError, type ArtifactService, type AuthContext } from '@factory/artifacts';
import { AuthenticationError, type OidcVerifier, type VerifiedIdentity } from './auth/oidc.ts';
import { AuthorizationError, resolvePrincipal } from './auth/principal.ts';
import type { Principal } from './auth/rbac.ts';
import { problem, sendProblem } from './http/problem.ts';
import { ApiError, type TaskService } from './tasks/service.ts';
import { listGates, listRuns } from './tasks/views.ts';
import { streamTaskEvents, type StreamOptions } from './events/sse.ts';

declare module 'fastify' {
  interface FastifyRequest { principal?: Principal; identity?: VerifiedIdentity; requestId: string }
}

export type ApiDeps = { db: Database; verifier: OidcVerifier; artifacts: ArtifactService; tasks: TaskService; dashboardOrigin: string; events?: StreamOptions };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function authContext(req: FastifyRequest, taskId?: string): AuthContext {
  const p = req.principal;
  if (!p) throw new AuthorizationError('unauthenticated');
  return { orgId: p.orgId, actorId: p.principalId, principalId: p.principalId, actorKind: 'human', groups: p.groups, grantIds: p.grants.map((g) => g.membershipId), correlationId: req.requestId, ...(taskId ? { taskId } : {}) };
}

export function buildApi(deps: ApiDeps): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024, genReqId: () => randomUUID() });
  app.decorateRequest('requestId', '');

  // Bearer requests are allowed cross-origin only from the dashboard origin (chapter 12).
  app.addHook('onRequest', async (req, reply) => {
    req.requestId = req.id;
    void reply.header('x-request-id', req.id);
    const origin = req.headers.origin;
    if (origin === deps.dashboardOrigin) {
      void reply.header('access-control-allow-origin', origin).header('vary', 'Origin');
      if (req.method === 'OPTIONS') {
        return reply.code(204).header('access-control-allow-methods', 'GET,POST').header('access-control-allow-headers', 'authorization,content-type,idempotency-key,if-match,last-event-id').send();
      }
    } else if (req.method === 'OPTIONS') {
      return reply.code(403).send();
    }
    if (req.url.startsWith('/v2/health/')) return;
    try {
      req.identity = await deps.verifier.verify(req.headers.authorization);
      req.principal = await resolvePrincipal(deps.db, req.identity);
    } catch (e) {
      if (e instanceof AuthenticationError) return sendProblem(reply, problem(401, 'unauthenticated', 'a valid bearer token from a trusted issuer is required', req.id));
      if (e instanceof AuthorizationError) return sendProblem(reply, problem(403, 'no_principal', 'the authenticated identity has no active principal', req.id));
      throw e;
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) return sendProblem(reply, problem(err.status, err.code, err.message, req.id, err.fieldErrors.length ? { fieldErrors: err.fieldErrors } : {}));
    if (err instanceof ArtifactError) {
      const status = err.code === 'not_found' ? 404 : err.code === 'forbidden' ? 403 : err.code === 'invalid_request' ? 422 : err.code === 'artifact_unavailable' ? 503 : 409;
      return sendProblem(reply, problem(status, err.code, status === 404 ? 'unknown or inaccessible resource' : err.message, req.id));
    }
    const status = typeof (err as { statusCode?: unknown }).statusCode === 'number' ? (err as { statusCode: number }).statusCode : 500;
    if (status === 413) return sendProblem(reply, problem(413, 'payload_too_large', 'request exceeds 256 KiB', req.id));
    if (status >= 400 && status < 500) return sendProblem(reply, problem(400, 'malformed_request', 'malformed request', req.id));
    return sendProblem(reply, problem(500, 'internal_error', 'internal error', req.id));
  });

  app.get('/v2/health/live', () => Promise.resolve({ status: 'ok' }));

  app.get<{ Params: { artifactId: string } }>('/v2/artifacts/:artifactId', async (req, reply) => {
    if (!UUID.test(req.params.artifactId)) return sendProblem(reply, problem(404, 'not_found', 'unknown or inaccessible resource', req.id));
    return deps.artifacts.view(authContext(req), req.params.artifactId);
  });

  app.post<{ Params: { artifactId: string }; Body: unknown }>('/v2/artifacts/:artifactId/access', async (req, reply) => {
    if (!req.headers['idempotency-key']) return sendProblem(reply, problem(400, 'idempotency_key_required', 'Idempotency-Key header is required', req.id));
    const body = validateContract('ArtifactAccessRequest', req.body);
    if (!body.ok) return sendProblem(reply, problem(422, 'invalid_request', 'invalid ArtifactAccessRequest', req.id, { fieldErrors: body.errors.map((e) => `${e.path || '/'} ${e.message}`).slice(0, 10) }));
    if (!UUID.test(req.params.artifactId)) return sendProblem(reply, problem(404, 'not_found', 'unknown or inaccessible resource', req.id));
    return deps.artifacts.access(authContext(req), req.params.artifactId, body.value.purpose);
  });

  app.post('/v2/tasks', async (req, reply) => {
    const principal = req.principal;
    if (!principal) throw new AuthorizationError('unauthenticated');
    const key = req.headers['idempotency-key'];
    const outcome = await deps.tasks.create(principal, typeof key === 'string' ? key : undefined, req.body, req.id);
    return reply.code(outcome.status).header('location', outcome.body.statusUrl).send(outcome.body);
  });

  app.get<{ Params: { taskId: string } }>('/v2/tasks/:taskId', async (req, reply) => {
    const principal = req.principal;
    if (!principal) throw new AuthorizationError('unauthenticated');
    const view = UUID.test(req.params.taskId) ? await deps.tasks.get(principal, req.params.taskId) : undefined;
    if (!view) return sendProblem(reply, problem(404, 'not_found', 'unknown or inaccessible resource', req.id));
    return view;
  });

  const readableTask = async (req: FastifyRequest<{ Params: { taskId: string } }>): Promise<{ principal: Principal } | undefined> => {
    const principal = req.principal;
    if (!principal) throw new AuthorizationError('unauthenticated');
    if (!UUID.test(req.params.taskId)) return undefined;
    return (await deps.tasks.get(principal, req.params.taskId)) ? { principal } : undefined;
  };
  const limitOf = (raw: string | undefined): number => {
    const n = raw === undefined ? 100 : Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 100) throw new ApiError(422, 'invalid_limit', 'limit must be 1-100');
    return n;
  };

  app.get<{ Params: { taskId: string }; Querystring: { nodeId?: string; status?: string; limit?: string } }>('/v2/tasks/:taskId/runs', async (req, reply) => {
    const ok = await readableTask(req);
    if (!ok) return sendProblem(reply, problem(404, 'not_found', 'unknown or inaccessible resource', req.id));
    const limit = limitOf(req.query.limit);
    return deps.db.withTenant({ orgId: ok.principal.orgId, principalId: ok.principal.principalId }, (tx) => listRuns(tx, req.params.taskId, { limit, ...(req.query.nodeId ? { nodeId: req.query.nodeId } : {}), ...(req.query.status ? { status: req.query.status } : {}) }));
  });

  app.get<{ Params: { taskId: string }; Querystring: { includeHistorical?: string; inputHash?: string; limit?: string } }>('/v2/tasks/:taskId/gates', async (req, reply) => {
    const ok = await readableTask(req);
    if (!ok) return sendProblem(reply, problem(404, 'not_found', 'unknown or inaccessible resource', req.id));
    const limit = limitOf(req.query.limit);
    return deps.db.withTenant({ orgId: ok.principal.orgId, principalId: ok.principal.principalId }, (tx) => listGates(tx, req.params.taskId, { limit, includeHistorical: req.query.includeHistorical === 'true', ...(req.query.inputHash ? { inputHash: req.query.inputHash } : {}) }));
  });

  app.get<{ Params: { taskId: string }; Querystring: { after?: string } }>('/v2/tasks/:taskId/events', async (req, reply) => {
    const ok = await readableTask(req);
    if (!ok) return sendProblem(reply, problem(404, 'not_found', 'unknown or inaccessible resource', req.id));
    const identity = req.identity;
    // Re-resolve the principal and its current grants on every check: revocation ends the stream.
    const canRead = async (): Promise<boolean> => {
      if (!identity) return false;
      try { return (await deps.tasks.get(await resolvePrincipal(deps.db, identity), req.params.taskId)) !== undefined; } catch { return false; }
    };
    return streamTaskEvents(req, reply, { db: deps.db, principal: ok.principal, canRead, options: deps.events ?? { retentionMs: 30 * 24 * 60 * 60 * 1000 } });
  });

  app.get<{ Querystring: Record<string, string | undefined> }>('/v2/tasks', async (req) => {
    const principal = req.principal;
    if (!principal) throw new AuthorizationError('unauthenticated');
    const q = req.query;
    for (const key of ['applicationId', 'creatorId', 'ownerPrincipalId'] as const) {
      const v = q[key];
      if (v !== undefined && !UUID.test(v)) throw new ApiError(422, 'invalid_filter', `${key} must be a UUID`);
    }
    return deps.tasks.list(principal, {
      ...(q.cursor ? { cursor: q.cursor } : {}), ...(q.limit ? { limit: Number(q.limit) } : {}),
      ...Object.fromEntries((['applicationId', 'workType', 'deliveryScope', 'targetKind', 'status', 'creatorId', 'ownerPrincipalId', 'createdAfter', 'createdBefore', 'reviewMode'] as const).flatMap((k) => (q[k] ? [[k, q[k]]] : []))),
    });
  });

  return app;
}
