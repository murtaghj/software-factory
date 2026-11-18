// @factory/runner/testing — the fake tier, for tests in this package and in `tests/*` packages that are allowed to import the app.
export { FakeKube, FakeDriver, parseSelector, TERMINATION_MESSAGE_CAP, REVIEW_MEMORY_MS } from './kube/fake.ts';
export type { PodRuntime } from './kube/fake.ts';
export { FakeKubelet, STUB_PROGRAMS } from './kube/fake-kubelet.ts';
export type { Program, ProgramFactory } from './kube/fake-kubelet.ts';
export { passOnce, toStopping, toQuarantined, move, terminateTx } from './reconcile.ts';
export { settleWorkspace } from './workspaces.ts';
export { poolKey } from './capacity-standin.ts';
import { buildConfig, type ConfigInput, type RunnerConfig } from './config.ts';
// Test configuration: images need not be pinned and identities need not be bound to an organization. Only the fake tier imports this.
export const createTestConfig = (over: ConfigInput): RunnerConfig => buildConfig(over, true);
