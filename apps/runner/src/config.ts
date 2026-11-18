// Validated runner configuration. Every default chosen by the W-017 brief and not taken from the spec is here.
import { RunnerError } from './errors.ts';

export type ContainerResources = { requests: Record<string, string>; limits: Record<string, string> };
export type RunnerConfig = {
  runnerIdentity: string;                 // the service identity the runner uses toward the workspace manager
  controlPlaneIdentities: readonly string[]; // callers of Runner and the facade
  identityOrgs?: Readonly<Record<string, string>>; // optional: an identity bound to one organization
  refusalAudit: { perSecond: number; burst: number }; // the most denied-call audit rows one identity can cause
  namespace: string;                      // A-25: one execution namespace
  labelPrefix: string;                    // `factory.local/`
  supervisorServiceAccount: string;
  images: { supervisor: string; harness: string; materializer: string };
  resources: { supervisor: ContainerResources; harness: ContainerResources; materializer: ContainerResources };
  storageClass: string; pvcSize: string;
  startDeadlineSeconds: number; stopDeadlineSeconds: number; requestDeadlineSeconds: number; inlineReconcileBudgetMs: number;
  maxGenerations: number; allocateRestarts: number; maxWallSeconds: number; jobDeadlineSlackSeconds: number; graceSeconds: number;
  leaseSeconds: number; beatSeconds: number; suspectSeconds: number;
  pools: { authoring: number; verifier: number };
  review: { perSecond: number; burst: number; failedTokenMemoryMs: number };
  maxAllocationsPerPass: number; reconcileIntervalMs: number;
};

const DEFAULT_RESOURCES: ContainerResources = { requests: { cpu: '100m', memory: '128Mi', 'ephemeral-storage': '64Mi' }, limits: { cpu: '1', memory: '512Mi', 'ephemeral-storage': '1Gi' } };

const DIGEST_IMAGE = /^[^\s@]+@sha256:[0-9a-f]{64}$/;

// The TokenReview budget follows the allocations the pools allow: each live writer renews every `beatSeconds`, and
// four times that rate leaves room for acquires and retries. 20 a second is the floor.
export const reviewRateFor = (pools: { authoring: number; verifier: number }, beatSeconds: number): { perSecond: number; burst: number } => {
  const perSecond = Math.max(20, Math.ceil((4 * (pools.authoring + pools.verifier)) / beatSeconds));
  return { perSecond, burst: perSecond * 2 };
};

export type ConfigInput = Partial<Omit<RunnerConfig, 'review' | 'refusalAudit'>> & { review?: Partial<RunnerConfig['review']>; refusalAudit?: Partial<RunnerConfig['refusalAudit']>; runnerIdentity: string; controlPlaneIdentities: readonly string[] };

// The production factory. It takes no test switch: every image must be pinned by an @sha256 digest, and every
// control-plane identity must be bound to an organization (without that, a configured identity's denied calls could
// write audit rows into any organization it names). The unpinned, unbound variant is `createTestConfig` in
// `@factory/runner/testing`, which the production entry does not import.
export function createConfig(over: ConfigInput): RunnerConfig {
  if (Object.hasOwn(over, 'allowUnpinnedImages') || Object.hasOwn(over, 'allowUnboundIdentities')) throw new RunnerError('invalid_request', 'invalid runner configuration: test switches are not accepted here');
  return buildConfig(over, false);
}

export function buildConfig(over: ConfigInput, test: boolean): RunnerConfig {
  const pools = over.pools ?? { authoring: 10, verifier: 10 };
  const rate = reviewRateFor(pools, over.beatSeconds ?? 10);
  const c: RunnerConfig = {
    namespace: 'factory-exec-local', labelPrefix: 'factory.local/', supervisorServiceAccount: 'factory-allocation-supervisor',
    images: { supervisor: 'factory-stub:local', harness: 'factory-stub:local', materializer: 'factory-materializer:local' },
    resources: { supervisor: DEFAULT_RESOURCES, harness: DEFAULT_RESOURCES, materializer: DEFAULT_RESOURCES },
    storageClass: 'local-path', pvcSize: '2Gi',
    startDeadlineSeconds: 600, stopDeadlineSeconds: 180, requestDeadlineSeconds: 10, inlineReconcileBudgetMs: 20_000,
    maxGenerations: 3, allocateRestarts: 3, maxWallSeconds: 7200, jobDeadlineSlackSeconds: 300, graceSeconds: 15,
    leaseSeconds: 60, beatSeconds: 10, suspectSeconds: 30, pools,
    maxAllocationsPerPass: 200, reconcileIntervalMs: 15_000,
    ...over,
    review: { ...rate, failedTokenMemoryMs: 10_000, ...over.review },
    refusalAudit: { perSecond: 5, burst: 20, ...over.refusalAudit },
  };
  const bad = (m: string): never => { throw new RunnerError('invalid_request', `invalid runner configuration: ${m}`); };
  if (c.runnerIdentity === '' || c.controlPlaneIdentities.length === 0 || c.controlPlaneIdentities.some((i) => i === '')) bad('identities');
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(c.namespace)) bad('namespace');
  if (!/^[a-z0-9.-]+\/$/.test(c.labelPrefix)) bad('labelPrefix');
  for (const [k, v] of Object.entries({ startDeadlineSeconds: c.startDeadlineSeconds, stopDeadlineSeconds: c.stopDeadlineSeconds, requestDeadlineSeconds: c.requestDeadlineSeconds, maxGenerations: c.maxGenerations,
    allocateRestarts: c.allocateRestarts, maxWallSeconds: c.maxWallSeconds, graceSeconds: c.graceSeconds, leaseSeconds: c.leaseSeconds, beatSeconds: c.beatSeconds, suspectSeconds: c.suspectSeconds,
    maxAllocationsPerPass: c.maxAllocationsPerPass, 'pools.authoring': c.pools.authoring, 'pools.verifier': c.pools.verifier })) {
    if (!Number.isSafeInteger(v) || v < 1) bad(k);
  }
  if (c.graceSeconds !== 15) bad('graceSeconds is pinned at 15 by the brief');
  if (!Number.isSafeInteger(c.review.perSecond) || c.review.perSecond < 1 || !Number.isSafeInteger(c.review.burst) || c.review.burst < 1) bad('review');
  if (!Number.isSafeInteger(c.refusalAudit.perSecond) || c.refusalAudit.perSecond < 1 || !Number.isSafeInteger(c.refusalAudit.burst) || c.refusalAudit.burst < 1) bad('refusalAudit');
  if (!test && c.controlPlaneIdentities.some((i) => c.identityOrgs?.[i] === undefined)) bad('every control-plane identity must be bound to an organization (identityOrgs)');
  if (!test) for (const [k, v] of Object.entries(c.images)) if (!DIGEST_IMAGE.test(v)) bad(`image ${k} must be pinned by an @sha256 digest`);
  return c;
}

// The supervisor identity a token review must show (A-25): the one service account of the execution namespace.
export const supervisorSubject = (c: RunnerConfig): string => `system:serviceaccount:${c.namespace}:${c.supervisorServiceAccount}`;
export const poolOf = (c: RunnerConfig, role: string): { pool: 'verifier' | 'authoring'; limit: number } => (role === 'verifier' ? { pool: 'verifier', limit: c.pools.verifier } : { pool: 'authoring', limit: c.pools.authoring });
export const jobDeadlineSeconds = (c: RunnerConfig, wallSeconds: number): number => wallSeconds + c.jobDeadlineSlackSeconds;
