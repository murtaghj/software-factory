// Validated runner configuration. Every default chosen by the W-017 brief and not taken from the spec is here.
import { createPrivateKey } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import { isLoopbackOrLinkLocalOrUnspecified } from '@factory/runner-protocol';
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
  review: { perSecond: number; burst: number; failedTokenMemoryMs: number; ceilingPerSecond?: number };
  maxAllocationsPerPass: number; reconcileIntervalMs: number;
  // ---- W-019
  podListener?: PodListenerConfig;        // absent: no listener (what W-017's process test runs)
  sourceRate: { perSecond: number; burst: number };            // requests charged to a source (every request whose token did not verify locally)
  sourceNewConnections: { perSecond: number; burst: number };  // new TCP connections per source, before any TLS work
  sourceConnections: number;                                   // open connections per source
  podRate: { burst: number; intervalMs: number };              // per reviewed pod, after local verification and before the shared review budget
  cancelCheckpointWaitSeconds: number;                         // the hold (06:90)
  quarantinePreserveDays: number; quarantineEscalateDays: number; quarantineOwner: string;
  nodeCheck: 'required' | 'off';
  nodeReadGraceSeconds: number;                                // how long past the stop deadline an unreadable node is retried before the stop is quarantined
  networkGate: { mode: 'required' | 'disabled'; denyTargets: readonly string[] };
  supervisor?: { runnerUrl: string; caConfigMap: string; caSha256: string; localPort: number; harnessProgram?: string };
  test?: TestSwitches;                                         // only `createTestConfig` accepts it
};
export type PodListenerConfig = { host: string; port: number; cert: string; key: string };
// Switches only the fake tier can set. A production configuration cannot carry any of them (createConfig refuses the key).
export type TestSwitches = {
  plaintext?: boolean;               // the fake tier's loopback listener
  relaxSourceLimits?: boolean;       // every pod is one source in both local tiers (A-32)
  sourceOf?: (peer: { remoteAddress: string | undefined; remotePort: number | undefined }) => string; // names a source on a host with one loopback address
  chargeBeforeVerification?: boolean; // controls: the old order
  noNewConnectionBucket?: boolean; noPodBucket?: boolean;
};

const DEFAULT_RESOURCES: ContainerResources = { requests: { cpu: '100m', memory: '128Mi', 'ephemeral-storage': '64Mi' }, limits: { cpu: '1', memory: '512Mi', 'ephemeral-storage': '1Gi' } };

const DIGEST_IMAGE = /^[^\s@]+@sha256:[0-9a-f]{64}$/;

// The TokenReview budget follows the allocations the pools allow: each live writer renews every `beatSeconds`, and
// four times that rate leaves room for acquires and retries. 20 a second is the floor.
export const reviewRateFor = (pools: { authoring: number; verifier: number }, beatSeconds: number): { perSecond: number; burst: number } => {
  const perSecond = Math.max(20, Math.ceil((4 * (pools.authoring + pools.verifier)) / beatSeconds));
  return { perSecond, burst: perSecond * 2 };
};

// The review budget follows the writers that are running (W-019): each at its own pod cap spends podRate of it, and the budget is twice that,
// so every pod at its cap spends at most half. A floor of 20 a second, and the ceiling protects the API server.
export const reviewRateForWriters = (c: Pick<RunnerConfig, 'podRate' | 'review'>, liveWriters: number): { perSecond: number; burst: number; ceilingBound: boolean } => {
  const podPerSecond = 1000 / c.podRate.intervalMs;
  const wanted = Math.max(20, Math.ceil(2 * podPerSecond * liveWriters));
  const ceiling = c.review.ceilingPerSecond ?? Number.POSITIVE_INFINITY; // only the test configuration may leave it unset (buildConfig validates the rest)
  const perSecond = Math.min(ceiling, wanted);
  return { perSecond, burst: perSecond * 2, ceilingBound: wanted > ceiling };
};

export type ConfigInput = Partial<Omit<RunnerConfig, 'review' | 'refusalAudit' | 'sourceRate' | 'sourceNewConnections' | 'podRate'>> & { review?: Partial<RunnerConfig['review']>; refusalAudit?: Partial<RunnerConfig['refusalAudit']>; sourceRate?: Partial<RunnerConfig['sourceRate']>; sourceNewConnections?: Partial<RunnerConfig['sourceNewConnections']>; podRate?: Partial<RunnerConfig['podRate']>; runnerIdentity: string; controlPlaneIdentities: readonly string[] };

// The production factory. It takes no test switch: every image must be pinned by an @sha256 digest, and every
// control-plane identity must be bound to an organization (without that, a configured identity's denied calls could
// write audit rows into any organization it names). The unpinned, unbound variant is `createTestConfig` in
// `@factory/runner/testing`, which the production entry does not import.
export function createConfig(over: ConfigInput): RunnerConfig {
  for (const k of ['allowUnpinnedImages', 'allowUnboundIdentities', 'test', 'plaintext', 'relaxSourceLimits', 'sourceOf']) if (Object.hasOwn(over, k)) throw new RunnerError('invalid_request', 'invalid runner configuration: test switches are not accepted here');
  const c = buildConfig(over, false);
  // A production runner renders the supervisor's whole contract and runs a listener for it: without `supervisor` the Job's arguments are W-017's stubs' (no gate, no permit),
  // and without `podListener` no supervisor could be granted anything. Both are required, together. (The test builder keeps W-017's stubs.)
  if (c.supervisor === undefined || c.podListener === undefined) throw new RunnerError('invalid_request', 'invalid runner configuration: a production configuration needs the supervisor contract and the pod listener together');
  // D24: `disabled` is the fake tier's, and step 0 item 5's fallback; a production gate is `required`.
  if (c.networkGate.mode === 'disabled') throw new RunnerError('invalid_request', 'invalid runner configuration: the network gate is required in production (D24)');
  return c;
}

export function buildConfig(over: ConfigInput, test: boolean): RunnerConfig {
  // Test switches exist only in the test configuration: not here, whoever calls this.
  if (!test && Object.hasOwn(over, 'test')) throw new RunnerError('invalid_request', 'invalid runner configuration: test switches are not accepted here');
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
    cancelCheckpointWaitSeconds: 30, quarantinePreserveDays: 30, quarantineEscalateDays: 1, quarantineOwner: 'platform-operator',
    sourceConnections: 4, nodeCheck: 'required', nodeReadGraceSeconds: 60,
    networkGate: { mode: test ? 'disabled' : 'required', denyTargets: [] },
    ...over,
    sourceRate: { perSecond: 10, burst: 50, ...over.sourceRate },
    sourceNewConnections: { perSecond: 5, burst: 20, ...over.sourceNewConnections },
    podRate: { burst: 5, intervalMs: 2000, ...over.podRate },
    review: { ...rate, failedTokenMemoryMs: 10_000, ...(test ? {} : { ceilingPerSecond: 200 }), ...over.review },
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
  for (const [k, v] of Object.entries({ quarantinePreserveDays: c.quarantinePreserveDays, quarantineEscalateDays: c.quarantineEscalateDays, nodeReadGraceSeconds: c.nodeReadGraceSeconds,
    sourceConnections: c.sourceConnections, 'podRate.burst': c.podRate.burst, 'podRate.intervalMs': c.podRate.intervalMs, 'sourceRate.perSecond': c.sourceRate.perSecond, 'sourceRate.burst': c.sourceRate.burst,
    'sourceNewConnections.perSecond': c.sourceNewConnections.perSecond, 'sourceNewConnections.burst': c.sourceNewConnections.burst })) {
    if (!Number.isSafeInteger(v) || v < 1) bad(k);
  }
  if (c.nodeReadGraceSeconds > c.stopDeadlineSeconds) bad('nodeReadGraceSeconds must not exceed stopDeadlineSeconds');
  if (!Number.isSafeInteger(c.cancelCheckpointWaitSeconds) || c.cancelCheckpointWaitSeconds < 0) bad('cancelCheckpointWaitSeconds'); // 0 turns the hold off, as in W-017
  if (c.quarantineOwner === '') bad('quarantineOwner');
  if (!['required', 'off'].includes(c.nodeCheck)) bad('nodeCheck');
  if (c.leaseSeconds <= 2 * c.beatSeconds) bad('leaseSeconds must be more than twice beatSeconds');
  if (c.suspectSeconds >= c.leaseSeconds) bad('suspectSeconds must be less than leaseSeconds');
  if (c.podRate.intervalMs > (c.beatSeconds * 1000) / 2) bad('the per-pod interval must be at most half a beat');
  if (!['required', 'disabled'].includes(c.networkGate.mode)) bad('networkGate.mode');
  if (c.networkGate.denyTargets.length > 8 || c.networkGate.denyTargets.some((t) => !isLiteralTarget(t))) bad('every deny target must be a literal address and port (at most eight)');
  if (c.supervisor) {
    // The supervisor's own rule, shared: https, and not an address that belongs to the pod itself. A bad URL would otherwise fail every pod (exit 64), not the runner's start.
    let u: URL | undefined;
    try { u = new URL(c.supervisor.runnerUrl); } catch { u = undefined; }
    if (!u || (!test && (u.protocol !== 'https:' || isLoopbackOrLinkLocalOrUnspecified(u.hostname)))) bad('supervisor.runnerUrl must be https and name a routable address, never a loopback, link-local or unspecified one');
  }
  if (c.supervisor && (!/^[0-9a-f]{64}$/.test(c.supervisor.caSha256) || !Number.isSafeInteger(c.supervisor.localPort) || c.supervisor.localPort < 1 || c.supervisor.localPort > 65535)) bad('supervisor');
  if (c.podListener) {
    const l = c.podListener;
    if (typeof l.host !== 'string' || net.isIP(l.host) === 0 || isUnspecified(l.host)) bad('the pod listener binds one named address (a literal IP), never an unspecified one');
    if (!Number.isSafeInteger(l.port) || l.port < 0 || l.port > 65535) bad('podListener.port');
    // TLS always (D23): a certificate and a key whatever the address, loopback included. Plaintext exists only behind the test switch.
    if (!(c.test?.plaintext === true) && (typeof l.cert !== 'string' || l.cert === '' || typeof l.key !== 'string' || l.key === '')) bad('the pod listener needs a certificate and a key on every address');
    // ECDSA P-256 in code, not by convention (an RSA handshake costs the event loop several times as much), and the pair is tried now rather than at listen time.
    if (!(c.test?.plaintext === true)) {
      try {
        const k = createPrivateKey(l.key);
        if (k.asymmetricKeyType !== 'ec' || k.asymmetricKeyDetails?.namedCurve !== 'prime256v1') bad('the pod listener key must be ECDSA P-256');
        tls.createSecureContext({ cert: l.cert, key: l.key });
      } catch (e) { if (e instanceof RunnerError) throw e; bad('the pod listener certificate and key are unusable or do not match'); }
    }
  }
  // The shared review budget has a ceiling that protects the API server, and it is a real number outside the test configuration: an unset, null, NaN,
  // string, zero or negative value would switch the sizing off, remove the ceiling or empty the budget.
  if (!test) {
    const ceil: unknown = c.review.ceilingPerSecond;
    if (typeof ceil !== 'number' || !Number.isSafeInteger(ceil) || ceil < 20) bad('review.ceilingPerSecond must be a safe integer of at least 20');
  }
  if (!test) {
    // The limits are sized so that one organization's full pools cannot fill the listener or the review budget.
    if (c.sourceConnections * (c.pools.authoring + c.pools.verifier) > 512) bad('sourceConnections x (pools.authoring + pools.verifier) is more than the 512 open connections');
    if ((2 * 1000 / c.podRate.intervalMs) * (c.pools.authoring + c.pools.verifier) > (c.review.ceilingPerSecond as number)) bad('the per-pod rate over the pools is more than the review ceiling');
  }
  if (c.graceSeconds !== 15) bad('graceSeconds is pinned at 15 by the brief');
  if (!Number.isSafeInteger(c.review.perSecond) || c.review.perSecond < 1 || !Number.isSafeInteger(c.review.burst) || c.review.burst < 1) bad('review');
  if (!Number.isSafeInteger(c.refusalAudit.perSecond) || c.refusalAudit.perSecond < 1 || !Number.isSafeInteger(c.refusalAudit.burst) || c.refusalAudit.burst < 1) bad('refusalAudit');
  if (!test && c.controlPlaneIdentities.some((i) => c.identityOrgs?.[i] === undefined)) bad('every control-plane identity must be bound to an organization (identityOrgs)');
  if (!test) for (const [k, v] of Object.entries(c.images)) if (!DIGEST_IMAGE.test(v)) bad(`image ${k} must be pinned by an @sha256 digest`);
  // Frozen: nothing can add a `test` key, or change a limit, after validation.
  return Object.freeze(c);
}

// An unspecified address, whatever its spelling (`0.0.0.0`, `0`, `::`, `::0`, `[::]`, `::ffff:0.0.0.0`).
export function isUnspecified(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').split('%')[0] ?? '';
  if (net.isIP(h) === 4) return h.split('.').every((o) => Number(o) === 0);
  try { const n = new URL(`http://[${h}]`).hostname; return n === '[::]' || n === '[::ffff:0:0]'; } catch { return false; }
}

// A deny target is a literal IPv4 or bracketed IPv6 address and a port: a name would be resolved from inside the pod, where DNS is itself something a policy governs.
export function isLiteralTarget(t: string): boolean {
  const m = /^(?:(\d{1,3}(?:\.\d{1,3}){3})|\[([0-9a-fA-F:.]+)\]):(\d{1,5})$/.exec(t);
  if (!m) return false;
  if (m[1] !== undefined && m[1].split('.').some((o) => Number(o) > 255)) return false;
  const port = Number(m[3]);
  return port >= 1 && port <= 65535;
}

// The supervisor identity a token review must show (A-25): the one service account of the execution namespace.
export const supervisorSubject = (c: RunnerConfig): string => `system:serviceaccount:${c.namespace}:${c.supervisorServiceAccount}`;
export const poolOf = (c: RunnerConfig, role: string): { pool: 'verifier' | 'authoring'; limit: number } => (role === 'verifier' ? { pool: 'verifier', limit: c.pools.verifier } : { pool: 'authoring', limit: c.pools.authoring });
export const jobDeadlineSeconds = (c: RunnerConfig, wallSeconds: number): number => wallSeconds + c.jobDeadlineSlackSeconds;
