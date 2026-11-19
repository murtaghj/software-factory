// The fake kubelet's W-019 extensions: token files, claim-keyed volumes, a port per pod, pause and resume.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tokenAudience, type JobManifest, type PvcManifest } from '../src/index.ts';
import { FakeKube, FakeKubelet, STUB_PROGRAMS, type ProgramContext } from '../src/testing.ts';

const kubelets: FakeKubelet[] = [];
afterEach(async () => { for (const k of kubelets.splice(0)) await k.close(); });
const ORG = '11111111-1111-4111-8111-111111111111';
const ALLOC = '22222222-2222-4222-8222-222222222222';
const AUD = tokenAudience(ORG, ALLOC);

function jobWith(kube: FakeKube, name: string, volumes: Array<Record<string, unknown>>, image = 'factory-stub:local'): JobManifest {
  const c = { name: 'c', image, volumeMounts: volumes.map((v) => ({ name: v['name'] as string, mountPath: `/${v['name'] as string}` })) };
  return { apiVersion: 'batch/v1', kind: 'Job', metadata: { name, namespace: kube.namespace, labels: { x: name }, annotations: {} },
    spec: { backoffLimit: 0, activeDeadlineSeconds: 60, template: { metadata: { labels: { x: name }, annotations: {} }, spec: { restartPolicy: 'Never', terminationGracePeriodSeconds: 15, serviceAccountName: 'factory-allocation-supervisor',
      automountServiceAccountToken: false, shareProcessNamespace: false, securityContext: {}, containers: [c], volumes: volumes as never } } } };
}
const claim = (kube: FakeKube, name: string): PvcManifest => ({ apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name, namespace: kube.namespace, labels: {}, annotations: {} }, spec: { accessModes: ['ReadWriteOnce'], storageClassName: 'local-path', resources: { requests: { storage: '1Gi' } } } });
async function until(what: string, cond: () => boolean, ms = 8000): Promise<void> { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`); await new Promise((r) => setTimeout(r, 25)); } }
function rig(configMaps: Record<string, Record<string, string>> = {}) {
  const kube = new FakeKube();
  const kubelet = new FakeKubelet(kube, { graceMs: 300, configMaps });
  kubelets.push(kubelet);
  const seen: Array<{ pod: string; ctx: ProgramContext }> = [];
  kubelet.register('factory-stub:local', (_c, ctx) => { seen.push({ pod: ctx.pod.metadata.name, ctx }); return STUB_PROGRAMS['factory-stub:local']; });
  return { kube, kubelet, seen };
}
const ws = { name: 'workspace', persistentVolumeClaim: { claimName: 'claim-a' } };

describe('W-019 the fake kubelet', () => {
  it('two pods that name the same claim see one directory: a file written by the first is read by the second; control: two claims do not share, and two emptyDirs do not', async () => {
    const { kube, kubelet, seen } = rig();
    await kube.createPvc(claim(kube, 'claim-a')); await kube.createPvc(claim(kube, 'claim-b'));
    await kube.createJob(jobWith(kube, 'one', [ws]));
    const first = kube.driver.podsOf('one')[0] as NonNullable<ReturnType<typeof kube.driver.podsOf>[number]>; // the Job controller's pod
    const second = kube.driver.addDuplicatePod('one'); // the same Job, the same claim name (RWO here, so both are placed)
    await until('both programs started', () => seen.length === 2);
    const dirA = seen.find((s) => s.pod === first.metadata.name)?.ctx.volumeDirs['workspace'] as string;
    const dirB = seen.find((s) => s.pod === second.metadata.name)?.ctx.volumeDirs['workspace'] as string;
    expect(dirA).toBe(dirB);
    expect(dirA).toBe(kubelet.claimDir('claim-a'));
    expect(seen.find((s) => s.pod === first.metadata.name)?.ctx.mounts).toEqual([{ mountPath: '/workspace', hostDir: dirA, readOnly: false }]);
    // different claims
    await kube.createJob(jobWith(kube, 'two', [{ name: 'workspace', persistentVolumeClaim: { claimName: 'claim-b' } }]));
    await until('third', () => seen.length === 3);
    expect(seen[2]?.ctx.volumeDirs['workspace']).not.toBe(dirA);
    // emptyDir per pod
    await kube.createJob(jobWith(kube, 'three', [{ name: 'scratch', emptyDir: {} }]));
    kube.driver.addDuplicatePod('three');
    await until('fourth and fifth', () => seen.length === 5);
    expect(seen[3]?.ctx.volumeDirs['scratch']).not.toBe(seen[4]?.ctx.volumeDirs['scratch']);
    expect(existsSync(seen[3]?.ctx.volumeDirs['scratch'] as string)).toBe(true);
  });

  it('a pod gets its own loopback port, a token file with the pod\'s token, and the ConfigMap files; a rotated token file has new contents and both tokens review as the fake says', async () => {
    const { kube, kubelet, seen } = rig({ 'factory-runner-ca': { 'runner-ca.crt': 'CA-PEM' } });
    const identity = { name: 'factory-identity', projected: { sources: [{ serviceAccountToken: { audience: AUD, expirationSeconds: 600, path: 'token' } }, { configMap: { name: 'factory-runner-ca', items: [{ key: 'runner-ca.crt', path: 'runner-ca.crt' }] } }] } };
    await kube.createJob(jobWith(kube, 'ident', [identity]));
    const pod = kube.driver.podsOf('ident')[0] as NonNullable<ReturnType<typeof kube.driver.podsOf>[number]>;
    await until('started', () => seen.length === 1);
    const ctx = seen[0]?.ctx as ProgramContext;
    expect(ctx.port).toBeGreaterThan(0);
    const file = join(ctx.volumeDirs['factory-identity'] as string, 'token');
    const first = readFileSync(file, 'utf8');
    expect(readdirSync(ctx.volumeDirs['factory-identity'] as string).sort()).toEqual(['runner-ca.crt', 'token']);
    expect(readFileSync(join(ctx.volumeDirs['factory-identity'] as string, 'runner-ca.crt'), 'utf8')).toBe('CA-PEM');
    expect((await kube.reviewToken(first, [AUD])).authenticated).toBe(true);
    const second = kubelet.rotateToken(pod.metadata.uid);
    expect(readFileSync(file, 'utf8')).toBe(second);
    expect(second).not.toBe(first);
    expect((await kube.reviewToken(second, [AUD])).authenticated).toBe(true);
    expect((await kube.reviewToken(first, [AUD])).authenticated).toBe(true); // the old one still reviews: the cluster does not revoke it at rotation
    expect(kubelet.portOf(pod.metadata.uid)).toBe(ctx.port);
  });

  it('pause stops a container\'s beats and resume restarts them', async () => {
    const { kube, kubelet, seen } = rig();
    kubelet.register('factory-stub:local', (_c, ctx) => { seen.push({ pod: ctx.pod.metadata.name, ctx }); return { command: process.execPath, args: ['-e', `const fs=require('fs');const f=${JSON.stringify(join(ctx.volumeDirs['workspace'] as string, 'beat'))};let n=0;setInterval(()=>fs.writeFileSync(f,String(++n)),30);process.on('SIGTERM',()=>process.exit(0));process.stderr.write('R')`], waitForReady: true }; });
    await kube.createPvc(claim(kube, 'claim-a'));
    await kube.createJob(jobWith(kube, 'beat', [ws]));
    const pod = kube.driver.podsOf('beat')[0] as NonNullable<ReturnType<typeof kube.driver.podsOf>[number]>;
    const beat = join(kubelet.claimDir('claim-a'), 'beat');
    const count = (): number => (existsSync(beat) ? Number(readFileSync(beat, 'utf8')) : 0);
    await until('beating', () => count() > 3);
    kube.driver.pause(pod.metadata.uid, 'c');
    await new Promise((r) => setTimeout(r, 100));
    const frozen = count();
    await new Promise((r) => setTimeout(r, 300));
    expect(count()).toBe(frozen); // paused: no beats
    kube.driver.resume(pod.metadata.uid, 'c');
    await until('beating again', () => count() > frozen + 3);
  });
});
