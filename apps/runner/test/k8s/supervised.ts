// The k3s tier's rig for W-019: the real controller (through its own Role), the real pod listener on the host, bound to 127.0.0.1 and reached by the pods at the podman
// host-gateway address (gvproxy maps it to the Mac's loopback; step 0), the real images, and the standing egress policy `scripts/k3s.sh up` applied. ONE gating supervisor at a
// time: every pod is one source through the gateway.
import { readFileSync } from 'node:fs';
import { createEnv, type ClusterInstance, type Env } from '../harness.ts';
import { startPodListener, type PodListener } from '../../src/testing.ts';
import { pvcName } from '../../src/index.ts';
import { AdminClient, loadK3sEnv, runnerKube, type K3sEnv } from './cluster.ts';

export type Supervised = { env: K3sEnv; admin: AdminClient; e: Env; inst: ClusterInstance; listener: PodListener; denyTargets: string[]; close: () => Promise<void> };

// The four rules this machine's policy shows active: the API service, the metadata address, and the Mac's Postgres and Temporal ports at the gateway (step 0, items 1 and 5).
export async function standingDenyTargets(env: K3sEnv, admin: AdminClient): Promise<string[]> {
  const svc = (await admin.ok('GET', '/api/v1/namespaces/default/services/kubernetes')) as { spec: { clusterIP: string; ports: Array<{ port: number }> } };
  return [`${svc.spec.clusterIP}:${String(svc.spec.ports[0]?.port ?? 443)}`, '169.254.169.254:80', `${env.listenerAddress}:55432`, `${env.listenerAddress}:57233`];
}

export async function supervisedRig(prefix: string, o: { script: string; denyTargets?: string[]; config?: Record<string, unknown> }): Promise<Supervised> {
  const env = loadK3sEnv();
  const admin = new AdminClient(env);
  const denyTargets = o.denyTargets ?? await standingDenyTargets(env, admin);
  const e = await createEnv(prefix, { cloneUrl: 'file:///fixture/repo.git', config: {
    namespace: env.namespace,
    images: { supervisor: 'factory-supervisor:local', harness: `factory-harness-scripted-${o.script}:local`, materializer: 'factory-materializer-test:local' },
    // production timings: beat 10 s, suspect 30 s, lease 60 s
    podListener: { host: '127.0.0.1', port: env.listenerPort, cert: readFileSync(env.listenerCertFile, 'utf8'), key: readFileSync(env.listenerKeyFile, 'utf8') },
    test: { sourceOf: () => 'pods', relaxSourceLimits: true }, // every pod is one source through the gateway: the per-source numbers mean nothing here (A-32)
    supervisor: { runnerUrl: `https://${env.listenerAddress}:${String(env.listenerPort)}`, caConfigMap: env.runnerCaConfigMap, caSha256: env.runnerCaSha256, localPort: 8765 },
    networkGate: { mode: 'required', denyTargets }, cancelCheckpointWaitSeconds: 30, nodeCheck: 'required', ...o.config,
  } as never });
  const inst = e.newClusterRunner({ kube: runnerKube(env), ownPool: true });
  const listener = await startPodListener({ runner: inst.runner, config: inst.config });
  return { env, admin, e, inst, listener, denyTargets, close: async () => { await listener.close(); await e.close(); } };
}

export const claimOf = (x: Supervised, workspaceId: string, generation = 1): string => pvcName(x.e.a.orgId, workspaceId, generation);
// The directory a claim is backed by on the node (local-path).
export async function backingDir(x: Supervised, workspaceId: string): Promise<string> {
  const claim = (await x.admin.items(x.admin.ns('persistentvolumeclaims'), `factory.local/workspace=${workspaceId}`))[0] as { metadata: { name: string }; spec: { volumeName: string } };
  return `/var/lib/rancher/k3s/storage/${claim.spec.volumeName}_${x.env.namespace}_${claim.metadata.name}`;
}
