// Start-up checks and configuration (W-019): a wrong API-service entry or a forbidden node read refuses the start.
import { describe, expect, it } from 'vitest';
import { KubeError } from '../src/index.ts';
import { FakeKube, createTestConfig } from '../src/testing.ts';
import { createConfig } from '../src/config.ts';
import { startRunnerProcess } from '../src/main.ts';
import { PROBE_NODE_NAME, runStartupChecks } from '../src/startup-checks.ts';

const base = { runnerIdentity: 'runner:factory', controlPlaneIdentities: ['service:worker'] };
const API = '10.96.0.1:443';

describe('W-019 start-up checks', () => {
  it('with the gate required and a deny list that lacks the API-service address the process refuses to start; control: the correct list starts', async () => {
    const kube = new FakeKube();
    const bad = createTestConfig({ ...base, nodeCheck: 'off', networkGate: { mode: 'required', denyTargets: ['10.96.0.9:443'] } });
    await expect(runStartupChecks({ kube, config: bad, probe: () => Promise.resolve(true) })).rejects.toMatchObject({ code: 'invalid_request' });
    const good = createTestConfig({ ...base, nodeCheck: 'off', networkGate: { mode: 'required', denyTargets: [API, '169.254.169.254:80'] } });
    await expect(runStartupChecks({ kube, config: good, probe: () => Promise.resolve(true) })).resolves.toBeUndefined();
  });

  it('with the node check required, a node read that answers 403 refuses the start; control: a 404 on the probe name starts', async () => {
    const kube = new FakeKube();
    const config = createTestConfig({ ...base, nodeCheck: 'required' });
    kube.failNext('getNode', new KubeError(403, 'Forbidden', 'nodes is forbidden'));
    await expect(runStartupChecks({ kube, config })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(runStartupChecks({ kube, config })).resolves.toBeUndefined();
    expect(kube.calls).toContain(`getNode ${PROBE_NODE_NAME}`);
    kube.nodes.set(PROBE_NODE_NAME, { name: PROBE_NODE_NAME, uid: 'x' }); // a node that "cannot exist" was found: refused too
    await expect(runStartupChecks({ kube, config })).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('a deny target that nothing listens on is logged as probably mistyped and does not stop the start; control: one that accepts is not logged', async () => {
    const kube = new FakeKube();
    const warnings: string[] = [];
    const config = createTestConfig({ ...base, nodeCheck: 'off', networkGate: { mode: 'required', denyTargets: [API, '192.0.2.1:9'] } });
    await runStartupChecks({ kube, config, probe: (t) => Promise.resolve(t === API), onWarning: (m) => warnings.push(m) });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/192\.0\.2\.1:9.*probably mistyped/);
  });

  it('startRunnerProcess runs the checks before anything is built, and with no podListener no port is opened', async () => {
    const kube = Object.assign(new FakeKube(), { assertStorageClass: () => Promise.resolve() });
    const config = createTestConfig({ ...base, nodeCheck: 'off', networkGate: { mode: 'required', denyTargets: ['10.96.0.9:443'] } });
    await expect(startRunnerProcess({ config, kube, db: undefined as never, artifacts: undefined as never })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(kube.calls.filter((c) => c.startsWith('create'))).toEqual([]);
  });

  it('configuration: lease equal to twice the beat, suspect equal to the lease, and a deny target given as a name are each refused; the valid neighbours are accepted', () => {
    expect(() => createTestConfig({ ...base, leaseSeconds: 20, suspectSeconds: 15 })).toThrow(/leaseSeconds/);
    expect(() => createTestConfig({ ...base, leaseSeconds: 21, suspectSeconds: 15 })).not.toThrow();
    expect(() => createTestConfig({ ...base, suspectSeconds: 60 })).toThrow(/suspectSeconds/);
    expect(() => createTestConfig({ ...base, suspectSeconds: 59 })).not.toThrow();
    expect(() => createTestConfig({ ...base, networkGate: { mode: 'required', denyTargets: ['kubernetes.default.svc:443'] } })).toThrow(/literal/);
    expect(() => createTestConfig({ ...base, networkGate: { mode: 'required', denyTargets: ['10.96.0.1:443', '[::1]:80'] } })).not.toThrow();
    expect(() => createTestConfig({ ...base, networkGate: { mode: 'required', denyTargets: ['10.96.0.1'] } })).toThrow(/literal/);
    expect(() => createTestConfig({ ...base, podRate: { intervalMs: 6000 } })).toThrow(/half a beat/);
    expect(createTestConfig(base).networkGate.mode).toBe('disabled'); // the fake tier has no network to gate
    expect(createConfigNoThrow().networkGate.mode).toBe('required'); // production default: fail closed
  });
});

function createConfigNoThrow() {
  const d = 'sha256:' + 'a'.repeat(64);
  return createConfig({ ...base, identityOrgs: { 'service:worker': '00000000-0000-4000-8000-000000000001' }, images: { supervisor: `s@${d}`, harness: `h@${d}`, materializer: `m@${d}` } });
}
