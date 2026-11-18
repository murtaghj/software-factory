// The process entry that runs the reconcile loop (W-017, 17b). Not part of `pnpm dev` (D9). At start it checks the
// workspace claims' storage class and refuses to run against one whose reclaim policy is not Delete (D15): a claim
// that is deleted must take its bytes with it, or "released" would be a lie.
//
// `startRunnerProcess` is the composition and takes its parts as arguments (the tests give it a fake cluster);
// `runnerProcessFromEnv` reads the environment and is the only place that does.
import { readFileSync } from 'node:fs';
import { ArtifactService, FileObjectStore } from '@factory/artifacts';
import { Database } from '@factory/database';
import { createWorkspaceManager } from '@factory/workspace';
import { createConfig, type ConfigInput, type RunnerConfig } from './config.ts';
import { RunnerError } from './errors.ts';
import type { KubeApi } from './kube/api.ts';
import { HttpsKube } from './kube/https-client.ts';
import { createPodVolumeMaterializer } from './pod-volume-materializer.ts';
import { startPodListener, type PodListener } from './listener/pod-listener.ts';
import { runStartupChecks, type ChecksOptions } from './startup-checks.ts';
import { createRunner, type RunnerService } from './runner.ts';
import type { LoopHandle, PassSummary } from './reconcile.ts';

export type RunnerProcessOptions = {
  config: RunnerConfig;
  kube: KubeApi & { assertStorageClass(name: string): Promise<void> };
  db: Database;
  artifacts: ArtifactService;
  onPass?: (s: PassSummary) => void;
  onError?: (e: unknown) => void;
  onWarning?: (message: string) => void;
  probe?: ChecksOptions['probe']; // a test double for the deny-target connects
};
export type RunnerProcess = { runner: RunnerService; loop: LoopHandle; listener?: PodListener; stop: () => Promise<void> };

export async function startRunnerProcess(o: RunnerProcessOptions): Promise<RunnerProcess> {
  // First, before anything is built or any pass runs.
  await o.kube.assertStorageClass(o.config.storageClass);
  await runStartupChecks({ kube: o.kube, config: o.config, ...(o.probe ? { probe: o.probe } : {}), ...(o.onWarning ? { onWarning: o.onWarning } : {}) });
  const materializer = createPodVolumeMaterializer({ kube: o.kube, config: o.config, db: o.db });
  const workspaces = createWorkspaceManager({ db: o.db, artifacts: o.artifacts, runnerIdentity: o.config.runnerIdentity, materializer });
  const runner = createRunner({ db: o.db, kube: o.kube, workspaces, config: o.config, artifacts: o.artifacts, ...(o.onError ? { onError: o.onError } : {}), ...(o.onWarning ? { onWarning: o.onWarning } : {}) });
  // The listener starts after the checks and closes before the loop stops.
  const listener = o.config.podListener ? await startPodListener({ runner, config: o.config, ...(o.onError ? { onError: o.onError } : {}) }) : undefined;
  const loop = runner.startLoop(o.onPass);
  return { runner, loop, ...(listener ? { listener } : {}), stop: async () => { await listener?.close(); await loop.stop(); } };
}

const need = (env: NodeJS.ProcessEnv, name: string): string => {
  const v = env[name];
  if (v === undefined || v === '') throw new RunnerError('invalid_request', `the environment variable ${name} is required`);
  return v;
};
const json = (env: NodeJS.ProcessEnv, name: string): unknown => {
  const text = need(env, name);
  try { return JSON.parse(text); } catch { throw new RunnerError('invalid_request', `${name} is not JSON`); }
};

// The production composition: every image pinned by digest and every identity bound to an organization (createConfig
// accepts no test switch). The cluster token is read once at start.
export async function runnerProcessFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<RunnerProcess> {
  const config = createConfig({
    runnerIdentity: need(env, 'FACTORY_RUNNER_IDENTITY'),
    controlPlaneIdentities: json(env, 'FACTORY_CONTROL_PLANE_IDENTITIES') as string[],
    identityOrgs: json(env, 'FACTORY_IDENTITY_ORGS') as Record<string, string>,
    images: json(env, 'FACTORY_IMAGES') as NonNullable<ConfigInput['images']>,
    ...(env['FACTORY_NAMESPACE'] === undefined ? {} : { namespace: env['FACTORY_NAMESPACE'] }),
    ...(env['FACTORY_STORAGE_CLASS'] === undefined ? {} : { storageClass: env['FACTORY_STORAGE_CLASS'] }),
  });
  const kube = new HttpsKube({
    server: need(env, 'FACTORY_KUBE_SERVER'), ca: readFileSync(need(env, 'FACTORY_KUBE_CA_FILE')), namespace: config.namespace,
    token: readFileSync(need(env, 'FACTORY_KUBE_TOKEN_FILE'), 'utf8').trim(),
  });
  const signingKey = need(env, 'FACTORY_ARTIFACT_SIGNING_KEY');
  if (!/^[0-9a-f]{64,}$/.test(signingKey)) throw new RunnerError('invalid_request', 'FACTORY_ARTIFACT_SIGNING_KEY must be at least 32 bytes as lower-case hex'); // Buffer.from(..., 'hex') would silently cut a bad key short
  const objectStore = need(env, 'FACTORY_OBJECT_STORE_DIR'); const downloadOrigin = need(env, 'FACTORY_DOWNLOAD_ORIGIN'); const databaseUrl = need(env, 'FACTORY_DATABASE_URL');
  const db = Database.connect(databaseUrl, 20);
  try {
    const artifacts = new ArtifactService({ db, store: new FileObjectStore(objectStore), signingKey: Buffer.from(signingKey, 'hex'), downloadOrigin });
    const p = await startRunnerProcess({ config, kube, db, artifacts, onPass: (s) => { for (const e of s.errors) console.warn('[runner] a pass error did not stop the loop:', e); } });
    return { ...p, stop: async () => { try { await p.stop(); } finally { await db.close(); } } };
  } catch (e) {
    await db.close().catch(() => undefined); // whatever failed after the pool was opened, it is closed
    throw e;
  }
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  runnerProcessFromEnv().then((p) => {
    const stop = (): void => { p.stop().then(() => { process.exit(0); }, (e: unknown) => { console.error('the runner did not stop cleanly:', e instanceof Error ? e.message : e); process.exit(1); }); };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  }, (e: unknown) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
