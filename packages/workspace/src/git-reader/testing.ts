// The reader's test seams (W-020a): a file-system spy, a swap between `lstat` and `open`, an extra directory entry, a delay before each object and the
// switch that turns the trailing-data check off for the fuzz control. Never exported from `index.ts` or the package, and restricted in
// `tools/boundaries.json` to the package's own tests.
export { openCandidateWithHooks } from './reader.ts';
export type { ReaderHooks } from './limits.ts';
