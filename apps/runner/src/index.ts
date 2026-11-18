// @factory/runner — the Kubernetes controller and Job protocol (W-017, 17a: the port, the fake, the
// controller, the permits) and its pod side (17b: the init container's logic, PVC removal, the process entry). No network listener (D12).
// The builder behind the test configuration is deliberately not exported here.
export { createConfig, supervisorSubject, poolOf, jobDeadlineSeconds, reviewRateFor } from './config.ts';
export type { ConfigInput, RunnerConfig, ContainerResources } from './config.ts';
export * from './errors.ts';
export * from './names.ts';
export * from './states.ts';
export * from './quiescence.ts';
export * from './job-manifest.ts';
export * from './pod/receipt.ts';
export { parseRequest, assertRemoteAllowed, runMaterialize, EntryRefusal, MAX_REQUEST_BYTES } from './pod/materialize-run.ts';
export type { RunOptions } from './pod/materialize-run.ts';
export { PodVolumeMaterializer, createPodVolumeMaterializer, workspaceLookup } from './pod-volume-materializer.ts';
export type { PodVolumeMaterializerOptions } from './pod-volume-materializer.ts';
export { startRunnerProcess, runnerProcessFromEnv } from './main.ts';
export type { RunnerProcess, RunnerProcessOptions } from './main.ts';
export * from './kube/api.ts';
export { HttpsKube } from './kube/https-client.ts';
export type { HttpsKubeOptions } from './kube/https-client.ts';
export { createRunner } from './runner.ts';
export type { RunnerService } from './runner.ts';
export type { RunnerDeps } from './core.ts';
export type { DescribedRun } from './start.ts';
export type { PermitRequest, PermitResult, PermitGrant, PermitDenial, PermitDenialCode } from './permit.ts';
export type { PassSummary, LoopHandle } from './reconcile.ts';
