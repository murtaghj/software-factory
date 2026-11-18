// @factory/runner — the Kubernetes controller and Job protocol (W-017, 17a: the port, the fake, the
// controller, the permits). No network listener (D12) and no pod executor yet (17b).
// The builder behind the test configuration is deliberately not exported here.
export { createConfig, supervisorSubject, poolOf, jobDeadlineSeconds, reviewRateFor } from './config.ts';
export type { ConfigInput, RunnerConfig, ContainerResources } from './config.ts';
export * from './errors.ts';
export * from './names.ts';
export * from './states.ts';
export * from './quiescence.ts';
export * from './job-manifest.ts';
export * from './pod/receipt.ts';
export * from './kube/api.ts';
export { HttpsKube } from './kube/https-client.ts';
export type { HttpsKubeOptions } from './kube/https-client.ts';
export { createRunner } from './runner.ts';
export type { RunnerService } from './runner.ts';
export type { RunnerDeps } from './core.ts';
export type { DescribedRun } from './start.ts';
export type { PermitRequest, PermitResult, PermitGrant, PermitDenial, PermitDenialCode } from './permit.ts';
export type { PassSummary, LoopHandle } from './reconcile.ts';
