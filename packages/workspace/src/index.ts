// @factory/workspace — Git workspaces, fencing and materialization (W-018).
// The Git adapter (git.ts) is deliberately not exported: FactoryOwnedRepo handles are minted only by
// the materializer and the publisher.
export * from './errors.ts';
export * from './branch.ts';
export * from './paths.ts';
export * from './tree-digest.ts';
export * from './setup-profile.ts';
export * from './materializer.ts';
export { createWorkspaceManager, deriveWorkspaceId, MATERIALIZATION_PURPOSE, CANDIDATE_PURPOSE } from './manager.ts';
export type { WorkspaceManagerService, WorkspaceManagerOptions, WorkspaceSpec, CandidateBinding, CandidateSource, MaterializationRequestResult, ReplaceWriterOutcome, ReleaseOutcome } from './manager.ts';
export * from './local-host.ts';
export * from './publish.ts';
export { GitRunner, MIN_GIT_VERSION } from './git.ts';
export type { GitVersion, GitRunnerOptions } from './git.ts';
export { MAX_RECORD_BYTES } from './controller-record.ts';
export type { RecordDeps, RecordHandle, Registered, ReadResult } from './controller-record.ts';
export * from './quiescence-proof.ts';
export * from './quarantine-record.ts';
export * from './volume-disposition.ts';
