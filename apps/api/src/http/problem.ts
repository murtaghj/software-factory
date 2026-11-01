// RFC 9457 problem responses (chapter 03 standard errors). Never echo credentials or prompts.
import type { FastifyReply } from 'fastify';
import type { Problem } from '@factory/contracts';

const TITLES: Record<number, string> = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict', 410: 'Gone', 412: 'Precondition Failed', 413: 'Payload Too Large', 422: 'Unprocessable Content', 429: 'Too Many Requests', 500: 'Internal Server Error', 503: 'Service Unavailable' };

export function problem(status: number, code: string, detail: string, requestId: string, extra: Partial<Problem> = {}): Problem {
  return { type: `https://factory.example/problems/${code}`, title: TITLES[status] ?? 'Error', status, code, detail, requestId, retryable: status === 503 || status === 429, ...extra };
}

export function sendProblem(reply: FastifyReply, p: Problem): FastifyReply {
  return reply.code(p.status).header('content-type', 'application/problem+json').send(p);
}
