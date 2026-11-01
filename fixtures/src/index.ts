// @factory/fixtures — representative fixture system (W-004): orders/inventory/web/event-worker on
// PostgreSQL with trace propagation, pinned known-good/faulty releases, canonical test packages
// and the fixture-test-runner.
export { startEnvironment, faultsDigest, FIXTURE_RUNNER, type FixtureEnvironment, type EnvironmentFingerprint } from './environment.ts';
export { RELEASES, release, computePins, type ReleaseDefinition, type ReleasePins } from './releases/releases.ts';
export { runPackage, packageDigest, packagesDir, readManifest } from './runner/runner.ts';
export { attributeBoundaryFault, type BoundaryAttribution } from './oracle/boundary.ts';
export type { Span } from './system/tracing.ts';
