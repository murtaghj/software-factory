// The untrusted-Git reader (W-020a): `@factory/workspace/git-reader`. The package index does not re-export it.
// The seams that tests need are in another file, and are not exported from here.
export { openCandidate, READER_VERSION } from './reader.ts';
export type { CandidateReader, CandidateSnapshot, CandidateTarget, ExportSummary } from './reader.ts';
export { ReaderError, READER_ERROR_CODES } from './errors.ts';
export type { ReaderErrorCode } from './errors.ts';
export { DEFAULT_LIMITS, resolveLimits } from './limits.ts';
export type { ReaderLimits } from './limits.ts';
export * from '../checkpoint-manifest.ts';
