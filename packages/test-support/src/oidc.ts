// Local OIDC test issuer (stands in for INT-06): an ES256 signing key, a JWKS endpoint on a real
// HTTP port and a token minter. Used by local development and tests only.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { randomUUID } from 'node:crypto';

export type TestIssuer = {
  issuer: string;
  jwksUrl: string;
  mint: (claims: { sub: string; aud: string; groups?: string[]; expiresInSeconds?: number; extra?: Record<string, unknown> }) => Promise<string>;
  close: () => Promise<void>;
};

export async function startTestIssuer(name = 'test'): Promise<TestIssuer> {
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const kid = randomUUID();
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid, alg: 'ES256', use: 'sig' };
  const server: Server = createServer((req, res) => {
    if (req.url === '/.well-known/jwks.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  const issuer = `${base}/${name}`;
  return {
    issuer,
    jwksUrl: `${base}/.well-known/jwks.json`,
    mint: async ({ sub, aud, groups, expiresInSeconds, extra }) =>
      new SignJWT({ ...(groups ? { groups } : {}), ...extra })
        .setProtectedHeader({ alg: 'ES256', kid })
        .setIssuer(issuer)
        .setAudience(aud)
        .setSubject(sub)
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + (expiresInSeconds ?? 300))
        .sign(privateKey),
    close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close((e) => { if (e) reject(e); else resolve(); }); }),
  };
}
