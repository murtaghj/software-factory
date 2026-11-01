import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { SignJWT, generateKeyPair } from 'jose';
import { AUDIENCE, DASHBOARD_ORIGIN, createApiHarness, type ApiHarness, type User } from './harness.ts';

describe('AC-05 cross-organization access (API and artifact access)', () => {
  let h: ApiHarness;
  let alice: User; // org A contributor on orders
  let bob: User;   // org B contributor on orders
  let aArtifact: string;
  let bArtifact: string;
  beforeAll(async () => {
    h = await createApiHarness('ac05api');
    alice = await h.user(h.a, [{ role: 'contributor', scope: [h.a.applicationId] }]);
    bob = await h.user(h.b, [{ role: 'contributor', scope: [h.b.applicationId] }]);
    aArtifact = await h.artifactFor(h.a, await h.task(h.a, alice), Buffer.from('org A report'));
    bArtifact = await h.artifactFor(h.b, await h.task(h.b, bob), Buffer.from('org B report'));
  });
  afterAll(async () => { await h.close(); });

  const get = async (user: User | string, path: string) => h.app.inject({ method: 'GET', url: path, headers: { authorization: `Bearer ${typeof user === 'string' ? user : await user.token()}` } });

  it('each caller reads its own organization\'s artifact', async () => {
    const r = await get(alice, `/v2/artifacts/${aArtifact}`);
    expect(r.statusCode).toBe(200);
    expect(r.json<{ ref: { artifactId: string } }>().ref.artifactId).toBe(aArtifact);
    expect((await get(bob, `/v2/artifacts/${bArtifact}`)).statusCode).toBe(200);
  });

  it('another organization\'s artifact ID is indistinguishable from an unknown one, for view and access', async () => {
    const view = await get(alice, `/v2/artifacts/${bArtifact}`);
    expect(view.statusCode).toBe(404);
    expect(view.headers['content-type']).toContain('application/problem+json');
    expect(view.json()).toMatchObject({ code: 'not_found', detail: 'unknown or inaccessible resource', retryable: false });
    const unknown = await get(alice, '/v2/artifacts/00000000-0000-4000-8000-00000000beef');
    expect({ status: unknown.statusCode, body: { ...unknown.json<object>(), requestId: 'x' } }).toEqual({ status: view.statusCode, body: { ...view.json<object>(), requestId: 'x' } });
    const access = await h.app.inject({ method: 'POST', url: `/v2/artifacts/${bArtifact}/access`, headers: { authorization: `Bearer ${await alice.token()}`, 'idempotency-key': 'k1', 'content-type': 'application/json' }, payload: { purpose: 'peek' } });
    expect(access.statusCode).toBe(404);
  });

  it('the organization comes from the trusted issuer, not from any token or request field', async () => {
    const forged = await h.a.issuer.mint({ sub: alice.subject, aud: AUDIENCE, extra: { org_id: h.b.orgId, orgId: h.b.orgId } });
    expect((await get(forged, `/v2/artifacts/${bArtifact}`)).statusCode).toBe(404);
    // Org B's issuer does not know Alice's subject: authenticated, but no principal there.
    const otherIssuer = await h.b.issuer.mint({ sub: alice.subject, aud: AUDIENCE });
    expect((await get(otherIssuer, `/v2/artifacts/${aArtifact}`)).statusCode).toBe(403);
  });

  it('untrusted, tampered, expired or wrong-audience tokens are unauthenticated', async () => {
    const { privateKey } = await generateKeyPair('ES256');
    const selfSigned = await new SignJWT({}).setProtectedHeader({ alg: 'ES256' }).setIssuer(h.a.issuer.issuer).setAudience(AUDIENCE).setSubject(alice.subject).setExpirationTime('5m').sign(privateKey);
    const good = await alice.token();
    const [hdr, payload, sig] = good.split('.');
    const tampered = `${hdr ?? ''}.${Buffer.from(JSON.stringify({ ...(JSON.parse(Buffer.from(payload ?? '', 'base64url').toString()) as object), sub: bob.subject })).toString('base64url')}.${sig ?? ''}`;
    const expired = await h.a.issuer.mint({ sub: alice.subject, aud: AUDIENCE, expiresInSeconds: -60 });
    const wrongAudience = await h.a.issuer.mint({ sub: alice.subject, aud: 'another-service' });
    for (const token of [selfSigned, tampered, expired, wrongAudience, 'not-a-jwt']) {
      const r = await get(token, `/v2/artifacts/${aArtifact}`);
      expect(r.statusCode).toBe(401);
      expect(r.json()).toMatchObject({ code: 'unauthenticated' });
    }
    expect((await h.app.inject({ method: 'GET', url: `/v2/artifacts/${aArtifact}` })).statusCode).toBe(401);
  });

  it('within an organization, application scope and classification still apply', async () => {
    const outsider = await h.user(h.a, [{ role: 'contributor', scope: [h.a.otherApplicationId] }]);
    expect((await get(outsider, `/v2/artifacts/${aArtifact}`)).statusCode).toBe(404);
    const viewer = await h.user(h.a, [{ role: 'viewer', scope: [h.a.applicationId] }]);
    expect((await get(viewer, `/v2/artifacts/${aArtifact}`)).statusCode).toBe(200);
    const restricted = await h.artifactFor(h.a, await h.task(h.a, alice), Buffer.from('restricted transcript'), 'text/plain', 'restricted');
    expect((await get(viewer, `/v2/artifacts/${restricted}`)).statusCode).toBe(404);
    expect((await get(alice, `/v2/artifacts/${restricted}`)).statusCode).toBe(200);
    const owner = await h.user(h.a, [], { groups: ['team:commerce'] }); // application owner through OIDC group
    expect((await get(owner, `/v2/artifacts/${aArtifact}`)).statusCode).toBe(200);
  });

  it('a disabled principal or revoked membership loses access immediately', async () => {
    const carol = await h.user(h.a, [{ role: 'viewer', scope: [h.a.applicationId] }]);
    expect((await get(carol, `/v2/artifacts/${aArtifact}`)).statusCode).toBe(200);
    await h.tx(h.a, (t) => t.query('UPDATE factory.membership SET revoked_at = now() WHERE principal_id = $1', [carol.principalId]));
    expect((await get(carol, `/v2/artifacts/${aArtifact}`)).statusCode).toBe(404);
    await h.tx(h.a, (t) => t.query('UPDATE factory.principal SET disabled_at = now() WHERE id = $1', [carol.principalId]));
    expect((await get(carol, `/v2/artifacts/${aArtifact}`)).statusCode).toBe(403);
  });

  it('cross-origin bearer requests are allowed only from the dashboard origin', async () => {
    const ok = await h.app.inject({ method: 'OPTIONS', url: `/v2/artifacts/${aArtifact}`, headers: { origin: DASHBOARD_ORIGIN } });
    expect(ok.statusCode).toBe(204);
    expect(ok.headers['access-control-allow-origin']).toBe(DASHBOARD_ORIGIN);
    const evil = await h.app.inject({ method: 'OPTIONS', url: `/v2/artifacts/${aArtifact}`, headers: { origin: 'https://evil.example' } });
    expect(evil.statusCode).toBe(403);
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });
});
