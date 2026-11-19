// The process entry (17b): the storage class is checked first, at start, and a class that does not reclaim with Delete stops
// the process before anything is built or any pass runs; the environment composition is production-strict.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runnerProcessFromEnv, startRunnerProcess } from '../src/index.ts';
import { FakeKube } from '../src/testing.ts';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEnv, type Env } from './harness.ts';
import { makePki } from './listener-kit.ts';

let e: Env;
const pkiDir = mkdtempSync(join(tmpdir(), 'w017-main-pki-'));
beforeAll(async () => { e = await createEnv('w017_main'); });
afterAll(async () => { await e.close(); rmSync(pkiDir, { recursive: true, force: true }); });

// A dependency that fails the test if the process touches it before the storage class has been judged.
const untouched = (name: string): never => new Proxy({}, { get: (_t, p) => { throw new Error(`${name}.${String(p)} was used before the storage class was checked`); } }) as never;

describe('W-017 process start', () => {
  it('a storage class whose reclaim policy is not Delete stops the process before anything is built; control: Delete starts it and the loop can be stopped', async () => {
    const kube = new FakeKube();
    const calls: string[] = [];
    const port = Object.assign(kube, { assertStorageClass: (name: string): Promise<void> => { calls.push(name); return kube.getStorageClass(name).then((sc) => { if (sc.reclaimPolicy !== 'Delete') throw new Error(`storage class ${name} has reclaim policy ${sc.reclaimPolicy}; the runner requires Delete`); }); } });
    kube.storageClasses.set('local-path', { name: 'local-path', reclaimPolicy: 'Retain', volumeBindingMode: 'WaitForFirstConsumer' });
    await expect(startRunnerProcess({ config: e.config, kube: port, db: untouched('db'), artifacts: untouched('artifacts') })).rejects.toThrow(/reclaim policy Retain/);
    expect(calls).toEqual([e.config.storageClass]); // asked once, first
    expect(kube.calls.filter((c) => !c.startsWith('getStorageClass'))).toEqual([]); // and nothing else was asked of the cluster
    kube.storageClasses.set('local-path', { name: 'local-path', reclaimPolicy: 'Delete', volumeBindingMode: 'WaitForFirstConsumer' });
    const passes: number[] = [];
    const p = await startRunnerProcess({ config: e.config, kube: port, db: e.db, artifacts: e.artifacts, onPass: (s) => { passes.push(s.allocations); } });
    expect(typeof p.runner.startOrAttach).toBe('function');
    await p.stop();
    expect(calls).toEqual([e.config.storageClass, e.config.storageClass]);
  });

  it('the environment composition is production-strict: it needs every variable, pinned images and identities bound to organizations', async () => {
    const good = { FACTORY_RUNNER_IDENTITY: 'runner:factory', FACTORY_CONTROL_PLANE_IDENTITIES: '["service:worker"]', FACTORY_IDENTITY_ORGS: '{"service:worker":"00000000-0000-4000-8000-000000000001"}',
      FACTORY_IMAGES: JSON.stringify({ supervisor: `a@sha256:${'a'.repeat(64)}`, harness: `a@sha256:${'a'.repeat(64)}`, materializer: `a@sha256:${'a'.repeat(64)}` }),
      // W-019: a production configuration needs the supervisor contract, the pod listener and a required gate together
      FACTORY_NETWORK_GATE: JSON.stringify({ mode: 'required', denyTargets: ['10.96.0.1:443'] }),
      FACTORY_POD_LISTENER: JSON.stringify({ host: '127.0.0.1', port: 0, certFile: join(pkiDir, 'c.pem'), keyFile: join(pkiDir, 'k.pem') }),
      FACTORY_SUPERVISOR: JSON.stringify({ runnerUrl: 'https://192.168.127.254:18443', caConfigMap: 'factory-runner-ca', caSha256: 'b'.repeat(64), localPort: 8765 }) };
    const pki = makePki();
    writeFileSync(join(pkiDir, 'c.pem'), pki.cert); writeFileSync(join(pkiDir, 'k.pem'), pki.key);
    await expect(runnerProcessFromEnv({})).rejects.toThrow(/FACTORY_RUNNER_IDENTITY/);
    await expect(runnerProcessFromEnv({ ...good, FACTORY_IMAGES: JSON.stringify({ supervisor: 'factory-stub:local', harness: 'factory-stub:local', materializer: 'factory-materializer:local' }) })).rejects.toThrow(/pinned by an @sha256 digest/);
    await expect(runnerProcessFromEnv({ ...good, FACTORY_IDENTITY_ORGS: '{}' })).rejects.toThrow(/bound to an organization/);
    await expect(runnerProcessFromEnv({ ...good, FACTORY_CONTROL_PLANE_IDENTITIES: 'not json' })).rejects.toThrow(/not JSON/);
    // Control: with the configuration valid, the next missing piece is the cluster (the check order is configuration first).
    await expect(runnerProcessFromEnv(good)).rejects.toThrow(/FACTORY_KUBE_SERVER/);
    pki.cleanup();
  });
});
