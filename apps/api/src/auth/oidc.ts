// OIDC bearer-token verification (W-008). Only configured issuers are trusted; each issuer is bound
// to exactly one organization, so the organization comes from the authenticated identity and never
// from a request payload (chapter 03). Identity is issuer + subject, never email.
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export type TrustedIssuer = { issuer: string; audience: string; jwksUrl: string; orgId: string };
export type VerifiedIdentity = { orgId: string; issuer: string; subject: string; groups: string[] };

export class AuthenticationError extends Error {
  constructor(message: string) { super(message); this.name = 'AuthenticationError'; }
}

export class OidcVerifier {
  private readonly issuers: Map<string, { config: TrustedIssuer; keys: JWTVerifyGetKey }>;
  constructor(trusted: TrustedIssuer[]) {
    this.issuers = new Map(trusted.map((t) => [t.issuer, { config: t, keys: createRemoteJWKSet(new URL(t.jwksUrl)) }]));
  }

  async verify(authorization: string | undefined): Promise<VerifiedIdentity> {
    const m = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(authorization ?? '');
    if (!m?.[1]) throw new AuthenticationError('missing bearer token');
    const token = m[1];
    let claimedIssuer: unknown;
    try {
      claimedIssuer = (JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { iss?: unknown }).iss;
    } catch {
      throw new AuthenticationError('malformed token');
    }
    const entry = typeof claimedIssuer === 'string' ? this.issuers.get(claimedIssuer) : undefined;
    if (!entry) throw new AuthenticationError('untrusted issuer');
    try {
      const { payload } = await jwtVerify(token, entry.keys, { issuer: entry.config.issuer, audience: entry.config.audience, algorithms: ['ES256', 'RS256'], clockTolerance: 5 });
      if (typeof payload.sub !== 'string' || payload.sub.length === 0) throw new AuthenticationError('token has no subject');
      const groups = Array.isArray(payload.groups) ? payload.groups.filter((g): g is string => typeof g === 'string') : [];
      return { orgId: entry.config.orgId, issuer: entry.config.issuer, subject: payload.sub, groups };
    } catch (e) {
      if (e instanceof AuthenticationError) throw e;
      throw new AuthenticationError(`token rejected: ${e instanceof Error ? e.message : 'invalid'}`);
    }
  }
}
