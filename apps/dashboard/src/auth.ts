// Browser sign-in: OIDC authorization code flow with PKCE (S256), provider-neutral. Nothing here is
// specific to one login provider; it needs only the issuer's discovery document and a public client
// ID. The access token is kept in sessionStorage for this tab's session and is never logged, put in
// a URL or sent anywhere but the API. There is no refresh token: when the token expires the person
// signs in again.
export type AuthConfig = { issuer: string; clientId: string; redirectUri: string; scope?: string };
export type Discovery = { authorization_endpoint: string; token_endpoint: string };
export type Session = { accessToken: string; expiresAt: number; name?: string };
export type PendingSignIn = { state: string; verifier: string; returnTo: string };
export type KeyValue = { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void; removeItem: (k: string) => void };

const PENDING = 'factory.signin';
const SESSION = 'factory.session';
// Treat a token as expired a little early so a request never leaves with one about to lapse.
export const EXPIRY_MARGIN_MS = 30_000;

const b64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export function randomToken(bytes = 32): string { return b64url(globalThis.crypto.getRandomValues(new Uint8Array(bytes))); }
export async function challengeOf(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}

export async function discover(issuer: string, fetchImpl: typeof fetch = fetch): Promise<Discovery> {
  const res = await fetchImpl(`${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`sign-in is unavailable: discovery returned ${String(res.status)}`);
  const d = await res.json() as Partial<Discovery> & { issuer?: string };
  // The document must be the one for the issuer we asked for (OIDC Discovery §4.3).
  if (d.issuer !== issuer || typeof d.authorization_endpoint !== 'string' || typeof d.token_endpoint !== 'string') throw new Error('sign-in is unavailable: the discovery document does not match the issuer');
  return { authorization_endpoint: d.authorization_endpoint, token_endpoint: d.token_endpoint };
}

// Starts sign-in: remembers the verifier, state and where to come back to, and returns the URL to
// send the browser to.
export async function beginSignIn(config: AuthConfig, discovery: Discovery, store: KeyValue, returnTo: string): Promise<string> {
  const pending: PendingSignIn = { state: randomToken(16), verifier: randomToken(32), returnTo };
  store.setItem(PENDING, JSON.stringify(pending));
  const url = new URL(discovery.authorization_endpoint);
  for (const [k, v] of Object.entries({ response_type: 'code', client_id: config.clientId, redirect_uri: config.redirectUri, scope: config.scope ?? 'openid profile', state: pending.state, code_challenge: await challengeOf(pending.verifier), code_challenge_method: 'S256' })) url.searchParams.set(k, v);
  return url.toString();
}

export type CallbackResult = { kind: 'none' } | { kind: 'error'; message: string } | { kind: 'signed_in'; session: Session; returnTo: string };

// Finishes sign-in from the redirect back. The state must be the one this tab created; the code is
// exchanged with the verifier only this tab holds. Anything else is refused and nothing is stored.
export async function completeSignIn(config: AuthConfig, discovery: Discovery, store: KeyValue, callbackUrl: string, now: number, fetchImpl: typeof fetch = fetch): Promise<CallbackResult> {
  const q = new URL(callbackUrl).searchParams;
  if (!q.has('code') && !q.has('error')) return { kind: 'none' };
  const raw = store.getItem(PENDING);
  store.removeItem(PENDING); // one attempt per sign-in
  let pending: PendingSignIn | undefined;
  try { pending = raw ? JSON.parse(raw) as PendingSignIn : undefined; } catch { pending = undefined; }
  if (!pending || q.get('state') !== pending.state) return { kind: 'error', message: 'Sign-in could not be completed: the response does not belong to a sign-in started in this tab.' };
  if (q.has('error')) return { kind: 'error', message: `Sign-in was refused: ${q.get('error_description') ?? q.get('error') ?? 'unknown error'}` };
  const res = await fetchImpl(discovery.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: q.get('code') ?? '', code_verifier: pending.verifier, client_id: config.clientId, redirect_uri: config.redirectUri }).toString() });
  if (!res.ok) return { kind: 'error', message: 'Sign-in could not be completed: the login provider refused the code.' };
  const t = await res.json() as { access_token?: unknown; expires_in?: unknown; id_token?: unknown };
  if (typeof t.access_token !== 'string' || typeof t.expires_in !== 'number') return { kind: 'error', message: 'Sign-in could not be completed: the login provider returned no access token.' };
  const session: Session = { accessToken: t.access_token, expiresAt: now + t.expires_in * 1000 };
  store.setItem(SESSION, JSON.stringify(session));
  return { kind: 'signed_in', session, returnTo: pending.returnTo };
}

export function currentSession(store: KeyValue, now: number): Session | undefined {
  try {
    const s = JSON.parse(store.getItem(SESSION) ?? 'null') as Session | null;
    if (!s || typeof s.accessToken !== 'string' || typeof s.expiresAt !== 'number') return undefined;
    if (s.expiresAt - EXPIRY_MARGIN_MS <= now) { store.removeItem(SESSION); return undefined; }
    return s;
  } catch { return undefined; }
}
export function signOut(store: KeyValue): void { store.removeItem(SESSION); store.removeItem(PENDING); }
