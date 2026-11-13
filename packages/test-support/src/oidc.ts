// Local OIDC test issuer (stands in for INT-06): an ES256 signing key, a JWKS endpoint on a real
// HTTP port and a token minter. Used by local development and tests only.
//
// When `signIn` is configured it also serves the standard browser sign-in flow (discovery,
// authorization code with PKCE S256, token endpoint), so the dashboard can be exercised against a
// provider-neutral OIDC issuer. Instead of passwords it shows an account picker: it is a stand-in
// for a login provider, never one.
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { createHash, randomUUID } from 'node:crypto';

export type TestIssuer = {
  issuer: string;
  jwksUrl: string;
  mint: (claims: { sub: string; aud: string; groups?: string[]; expiresInSeconds?: number; extra?: Record<string, unknown> }) => Promise<string>;
  close: () => Promise<void>;
};
export type SignInOptions = {
  clientId: string;
  redirectUris: string[];
  // Audience of the access tokens issued through sign-in (the API).
  audience: string;
  // Browser origin allowed to call the token endpoint.
  allowedOrigin: string;
  accounts: () => Array<{ sub: string; name: string }>;
  tokenLifetimeSeconds?: number;
};
const esc = (v: string): string => v.replace(/[&<>"']/g, (c) => `&#${String(c.charCodeAt(0))};`);

export async function startTestIssuer(name = 'test', signIn?: SignInOptions): Promise<TestIssuer> {
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const kid = randomUUID();
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid, alg: 'ES256', use: 'sig' };
  const where = { base: '', issuer: '' };
  // One-time authorization codes: bound to the client, redirect URI and PKCE challenge.
  const codes = new Map<string, { sub: string; redirectUri: string; challenge: string; expiresAt: number }>();
  const mintFor = async ({ sub, aud, groups, expiresInSeconds, extra }: Parameters<TestIssuer['mint']>[0]): Promise<string> =>
    new SignJWT({ ...(groups ? { groups } : {}), ...extra })
      .setProtectedHeader({ alg: 'ES256', kid })
      .setIssuer(where.issuer)
      .setAudience(aud)
      .setSubject(sub)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + (expiresInSeconds ?? 300))
      .sign(privateKey);
  const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }); res.end(JSON.stringify(body)); };
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://issuer.local');
    if (url.pathname === '/.well-known/jwks.json') { json(res, 200, { keys: [jwk] }); return; }
    if (!signIn) { res.writeHead(404); res.end(); return; }
    const cors = req.headers.origin === signIn.allowedOrigin ? { 'access-control-allow-origin': signIn.allowedOrigin, vary: 'Origin' } : {};
    if (url.pathname === `/${name}/.well-known/openid-configuration`) {
      json(res, 200, { issuer: where.issuer, authorization_endpoint: `${where.issuer}/authorize`, token_endpoint: `${where.issuer}/token`, jwks_uri: `${where.base}/.well-known/jwks.json`, response_types_supported: ['code'], grant_types_supported: ['authorization_code'], code_challenge_methods_supported: ['S256'] }, cors);
      return;
    }
    if (url.pathname === `/${name}/authorize` && req.method === 'GET') {
      const q = url.searchParams;
      const redirectUri = q.get('redirect_uri') ?? '';
      // An unknown client or redirect URI is never redirected to.
      if (q.get('client_id') !== signIn.clientId || !signIn.redirectUris.includes(redirectUri)) { res.writeHead(400, { 'content-type': 'text/plain' }); res.end('unknown client or redirect URI'); return; }
      const back = (params: Record<string, string>): void => { const to = new URL(redirectUri); for (const [k, v] of Object.entries(params)) to.searchParams.set(k, v); const state = q.get('state'); if (state) to.searchParams.set('state', state); res.writeHead(302, { location: to.toString(), 'cache-control': 'no-store' }); res.end(); };
      const challenge = q.get('code_challenge') ?? '';
      if (q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) { back({ error: 'invalid_request', error_description: 'authorization code with PKCE S256 is required' }); return; }
      const chosen = q.get('login_hint');
      const account = signIn.accounts().find((a) => a.sub === chosen);
      if (!account) {
        const links = signIn.accounts().map((a) => { const next = new URL(url.pathname + url.search, 'http://issuer.local'); next.searchParams.set('login_hint', a.sub); return `<li><a href="${esc(next.pathname + next.search)}">${esc(a.name)}</a></li>`; }).join('');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(`<!doctype html><meta charset="utf-8"><title>Local sign-in</title><body style="font-family:system-ui;max-width:28rem;margin:4rem auto;padding:0 1rem"><h1>Local sign-in</h1><p>This is the local test issuer, not a real login provider. Choose who to sign in as.</p><ul>${links}</ul></body>`);
        return;
      }
      const code = randomUUID();
      codes.set(code, { sub: account.sub, redirectUri, challenge, expiresAt: Date.now() + 60_000 });
      back({ code });
      return;
    }
    if (url.pathname === `/${name}/token`) {
      if (req.method === 'OPTIONS') { res.writeHead(204, { ...cors, 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type' }); res.end(); return; }
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => { if (chunks.reduce((n, x) => n + x.length, 0) < 16_384) chunks.push(c); });
      req.on('end', () => {
        void (async () => {
          const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
          const code = form.get('code') ?? '';
          const grant = codes.get(code);
          codes.delete(code); // single use, whatever happens next
          const verifier = form.get('code_verifier') ?? '';
          const valid = grant !== undefined && grant.expiresAt > Date.now() && form.get('grant_type') === 'authorization_code' && form.get('client_id') === signIn.clientId && form.get('redirect_uri') === grant.redirectUri
            && createHash('sha256').update(verifier).digest('base64url') === grant.challenge;
          if (!valid) { json(res, 400, { error: 'invalid_grant' }, cors); return; }
          const lifetime = signIn.tokenLifetimeSeconds ?? 3600;
          const name_ = signIn.accounts().find((a) => a.sub === grant.sub)?.name ?? grant.sub;
          json(res, 200, { token_type: 'Bearer', expires_in: lifetime, access_token: await mintFor({ sub: grant.sub, aud: signIn.audience, expiresInSeconds: lifetime }), id_token: await mintFor({ sub: grant.sub, aud: signIn.clientId, expiresInSeconds: lifetime, extra: { name: name_ } }) }, cors);
        })();
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  const issuer = `${base}/${name}`;
  where.base = base;
  where.issuer = issuer;
  return {
    issuer,
    jwksUrl: `${base}/.well-known/jwks.json`,
    mint: mintFor,
    close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close((e) => { if (e) reject(e); else resolve(); }); }),
  };
}
