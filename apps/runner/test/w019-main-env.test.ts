// The production entry wires the network gate and the pod listener (19b hand-off): `runnerProcessFromEnv` itself is started, against the fake cluster and a real
// database, and the checks have run and the listener answers. With none of these variables set it fails closed.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMigratedDatabase, provisionOrganization, type MigratedDatabase } from '@factory/database';
import { randomUUID } from 'node:crypto';
import { FakeKube, composeFromEnv } from '../src/testing.ts';
import { makePki, type Pki } from './listener-kit.ts';

let m: MigratedDatabase; let pki: Pki; let dir: string; let org: string;
beforeAll(async () => {
  m = await createMigratedDatabase('w019_env'); org = randomUUID(); await provisionOrganization(m.migratorUrl, { id: org, name: 'E' });
  pki = makePki(); dir = mkdtempSync(join(tmpdir(), 'w019-env-'));
  writeFileSync(join(dir, 'cert.pem'), pki.cert); writeFileSync(join(dir, 'key.pem'), pki.key);
});
afterAll(async () => { pki.cleanup(); rmSync(dir, { recursive: true, force: true }); await m.drop(); });

const digest = `a@sha256:${'a'.repeat(64)}`;
const base = (): NodeJS.ProcessEnv => ({
  FACTORY_RUNNER_IDENTITY: 'runner:factory', FACTORY_CONTROL_PLANE_IDENTITIES: '["service:worker"]', FACTORY_IDENTITY_ORGS: JSON.stringify({ 'service:worker': org }),
  FACTORY_IMAGES: JSON.stringify({ supervisor: digest, harness: digest, materializer: digest }),
  FACTORY_KUBE_SERVER: 'https://unused.invalid', FACTORY_KUBE_CA_FILE: join(dir, 'cert.pem'), FACTORY_KUBE_TOKEN_FILE: join(dir, 'cert.pem'),
  FACTORY_ARTIFACT_SIGNING_KEY: 'ab'.repeat(32), FACTORY_OBJECT_STORE_DIR: join(dir, 'store'), FACTORY_DOWNLOAD_ORIGIN: 'http://127.0.0.1:1', FACTORY_DATABASE_URL: m.runtimeUrl,
});
const withKube = (): { kube: FakeKube & { assertStorageClass: () => Promise<void> } } => ({ kube: Object.assign(new FakeKube(), { assertStorageClass: () => Promise.resolve() }) });

describe('W-019 the production entry', () => {
  it('with the gate, the deny list and the listener in the environment it starts: the checks ran against the cluster, and the listener answers over TLS with the pinned certificate', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined); // the deny target accepts nothing here: a warning, never a refusal
    const o = withKube();
    const p = await composeFromEnv({
      ...base(),
      FACTORY_NETWORK_GATE: JSON.stringify({ mode: 'required', denyTargets: ['10.96.0.1:443', '169.254.169.254:80'] }),
      FACTORY_POD_LISTENER: JSON.stringify({ host: '127.0.0.1', port: 0, certFile: join(dir, 'cert.pem'), keyFile: join(dir, 'key.pem') }),
      FACTORY_SUPERVISOR: JSON.stringify({ runnerUrl: 'https://192.168.127.254:18443', caConfigMap: 'factory-runner-ca', caSha256: 'b'.repeat(64), localPort: 8765 }),
    }, o.kube);
    try {
      expect(o.kube.calls).toContain('getApiService kubernetes'); // the gate's check
      expect(o.kube.calls.some((c) => c.startsWith('getNode '))).toBe(true); // the node check
      expect(p.listener).toBeDefined();
      const status = await new Promise<string>((resolve) => {
        const s = tls.connect({ host: '127.0.0.1', port: p.listener?.port ?? 0, ca: pki.ca }, () => { s.write('GET /nothing HTTP/1.1\r\nHost: x\r\n\r\n'); });
        s.once('data', (d: Buffer) => { resolve(d.toString().split('\r\n')[0] ?? ''); s.destroy(); });
        s.once('error', () => { resolve('error'); });
      });
      expect(status).toMatch(/^HTTP\/1\.1 40[45]/);
      expect(p.runner.deps.config.supervisor?.localPort).toBe(8765);
      expect(Object.isFrozen(p.runner.deps.config)).toBe(true);
    } finally { await p.stop(); vi.restoreAllMocks(); }
  });

  const wired = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    ...base(),
    FACTORY_NETWORK_GATE: JSON.stringify({ mode: 'required', denyTargets: ['10.96.0.1:443'] }),
    FACTORY_POD_LISTENER: JSON.stringify({ host: '127.0.0.1', port: 0, certFile: join(dir, 'cert.pem'), keyFile: join(dir, 'key.pem') }),
    FACTORY_SUPERVISOR: JSON.stringify({ runnerUrl: 'https://192.168.127.254:18443', caConfigMap: 'factory-runner-ca', caSha256: 'b'.repeat(64), localPort: 8765 }),
    ...over,
  });
  const without = (name: string): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(wired()).filter(([k]) => k !== name));

  it('with none of them set it fails closed; a production configuration needs the supervisor contract AND the listener (a Job must never render W-017\'s ungated arguments); a disabled gate is refused; control: the full wiring starts', async () => {
    await expect(composeFromEnv(base(), withKube().kube)).rejects.toThrow(/supervisor contract and the pod listener/);
    await expect(composeFromEnv(without('FACTORY_SUPERVISOR'), withKube().kube)).rejects.toThrow(/supervisor contract and the pod listener/);
    await expect(composeFromEnv(without('FACTORY_POD_LISTENER'), withKube().kube)).rejects.toThrow(/supervisor contract and the pod listener/);
    await expect(composeFromEnv(wired({ FACTORY_NETWORK_GATE: JSON.stringify({ mode: 'disabled', denyTargets: [] }) }), withKube().kube)).rejects.toThrow(/required in production/);
    await expect(composeFromEnv(without('FACTORY_NETWORK_GATE'), withKube().kube)).rejects.toThrow(/deny list/); // the default gate is required with no deny target
    await expect(composeFromEnv(wired({ FACTORY_NETWORK_GATE: JSON.stringify({ mode: 'required', denyTargets: ['10.96.0.9:443'] }) }), withKube().kube)).rejects.toThrow(/deny list/);
    await expect(composeFromEnv(wired({ FACTORY_POD_LISTENER: JSON.stringify({ host: '0.0.0.0', port: 1, certFile: join(dir, 'cert.pem'), keyFile: join(dir, 'key.pem') }) }), withKube().kube)).rejects.toThrow(/named address/);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const p = await composeFromEnv(wired(), withKube().kube);
    try { expect(p.listener).toBeDefined(); } finally { await p.stop(); vi.restoreAllMocks(); }
  });

  it('the supervisor\'s runner URL is judged at the runner\'s start: http, a loopback, a link-local and an unspecified address are refused; control: a routable https URL', async () => {
    for (const bad of ['http://192.168.127.254:18443', 'https://127.0.0.1:18443', 'https://[::1]:18443', 'https://169.254.1.1:18443', 'https://0.0.0.0:18443', 'not a url']) {
      await expect(composeFromEnv(wired({ FACTORY_SUPERVISOR: JSON.stringify({ runnerUrl: bad, caConfigMap: 'x', caSha256: 'b'.repeat(64), localPort: 8765 }) }), withKube().kube), bad).rejects.toThrow(/runnerUrl/);
    }
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const p = await composeFromEnv(wired(), withKube().kube);
    await p.stop(); vi.restoreAllMocks();
  });
});
