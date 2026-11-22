// Checkpoint documents (W-020, 7.7): the index manifest (`factory-checkpoint-index/1`, SI-34), the
// working-tree manifest (`factory-checkpoint-worktree/1`), the portable handoff (`factory-portable-handoff/1`,
// SI-36), the names and size caps of the six parts, the purposes they are linked under, and a strict
// validator for each document. The reader (src/git-reader) produces the first two; the builder of 20b
// adds the ids it creates and writes the handoff. A validator accepts exactly the shape described here:
// an unknown key (and `__proto__`), a wrong type, a bad id or a path the path rules refuse is an
// `invalid_request` refusal.
import type { FileSnapshot } from '@factory/contracts';
import { canonicalHash } from '@factory/domain';
import { ReaderError, refuse } from './git-reader/errors.ts';
import { DEFAULT_LIMITS } from './git-reader/limits.ts';
import { checkPath } from './git-reader/path-rules.ts';

export const INDEX_MANIFEST_SCHEMA = 'factory-checkpoint-index/1';
export const WORKTREE_MANIFEST_SCHEMA = 'factory-checkpoint-worktree/1';
export const HANDOFF_SCHEMA = 'factory-portable-handoff/1';
export const INDEX_DIGEST_ALGORITHM = 'factory-index-digest/1';

// ---- the six parts, their caps and the purposes they are linked under
export const CHECKPOINT_PARTS = ['index', 'handoff', 'bundle', 'staged', 'unstaged', 'manifest'] as const;
export type CheckpointPart = (typeof CHECKPOINT_PARTS)[number];
const MiB = 1024 * 1024;
export const CHECKPOINT_PART_CAPS: Readonly<Record<CheckpointPart, number>> = Object.freeze({
  index: 64 * MiB, handoff: 64 * 1024, bundle: 256 * MiB, staged: 128 * MiB, unstaged: 128 * MiB, manifest: 32 * MiB,
});
export const isCheckpointPart = (name: string): name is CheckpointPart => (CHECKPOINT_PARTS as readonly string[]).includes(name);

// The purpose of a part while its child is running, and of the same part once the checkpoint is accepted (C21).
export const checkpointPartPurpose = (childId: string, part: CheckpointPart): string => `checkpoint_part/${childId}/${part}`;
export const acceptedCheckpointPurpose = (workspaceId: string, generation: number, part: CheckpointPart): string => `checkpoint/${workspaceId}/g${String(generation)}/${part}`;

// ---- types
export type IndexManifestEntry = { path: string; mode: '100644' | '100755' | '120000'; oid: string; assumeValid: boolean; skipWorktree: boolean; intentToAdd: boolean };
// Ids that the builder adds after it has written the objects.
export type BuilderIds = { indexTree: string; worktreeTree: string; indexCommit: string; worktreeCommit: string };
export type IndexManifest = {
  schema: typeof INDEX_MANIFEST_SCHEMA;
  indexVersion: 2 | 3 | 4;
  // `absent`: the worktree has no index file at all, which Git reads as an empty index.
  checksum: 'verified' | 'skipped' | 'absent';
  headCommit: string;
  headTreeDigest: string;
  indexDigest: string;
  entries: IndexManifestEntry[];
  builder?: BuilderIds;
};

export type ExcludedPath = { path: string; reason: 'special_file' | 'nested_git' | 'rebuildable_directory' | 'deny_list' };
// Names that differ only by case, or only by Unicode normalisation, from an earlier name of the same directory: legal on Linux, kept, and counted so
// that a restore on a host that folds can decide (`assertNoFoldedCollisions` refuses there).
export type CollisionCounts = { caseOnly: number; normalization: number };
export type WorktreeBlob = { path: string; blobId: string };
export type WorktreeManifest = {
  schema: typeof WORKTREE_MANIFEST_SCHEMA;
  // One per file and symlink that is present, and `kind: 'deleted'` for every index path that is not (its sha256 is that of the blob the index records).
  files: FileSnapshot[];
  // The Git blob id of every present file and symlink, as the export pack holds it.
  blobIds: WorktreeBlob[];
  excluded: ExcludedPath[];
  collisions: CollisionCounts;
  sourceDigest: string;
};

export type PortableHandoff = {
  schema: typeof HANDOFF_SCHEMA;
  taskId: string;
  stageRunId: string;
  allocationId: string;
  generation: number;
  epoch: number;
  reason: 'harness_exited';
  harnessExitCode: number | null; // a diagnostic only (D30)
  headCommit: string;
  indexCommit: string;
  worktreeCommit: string;
  gitVersion: string;
  readerVersion: string;
  nativeState: 'absent';
  narrative: null;
};

// ---- the index digest
export const computeIndexDigest = (entries: readonly IndexManifestEntry[]): string => canonicalHash({ algorithm: INDEX_DIGEST_ALGORITHM, entries });

// ---- validators
const bad = (reason: string): never => { throw refuse('invalid_request', reason); };
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
function record(v: unknown, what: string, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!isRecord(v)) return bad(`${what} is not an object`);
  for (const k of Object.keys(v)) if (!keys.includes(k) && !optional.includes(k)) bad(`${what} has an unknown key`);
  for (const k of keys) if (!Object.hasOwn(v, k)) bad(`${what} lacks a required key`);
  return v;
}
const str = (v: unknown, what: string, max = 4096): string => (typeof v === 'string' && v.length <= max ? v : bad(`${what} is not a string of at most ${String(max)} characters`));
const int = (v: unknown, what: string, min: number, max = Number.MAX_SAFE_INTEGER): number => (typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max ? v : bad(`${what} is not an integer in range`));
const bool = (v: unknown, what: string): boolean => (typeof v === 'boolean' ? v : bad(`${what} is not a boolean`));
const oid = (v: unknown, what: string): string => (typeof v === 'string' && /^[0-9a-f]{40}$/.test(v) ? v : bad(`${what} is not a 40-digit object id`));
const sha256 = (v: unknown, what: string): string => (typeof v === 'string' && /^[0-9a-f]{64}$/.test(v) ? v : bad(`${what} is not a SHA-256`));
const array = (v: unknown, what: string, max: number): unknown[] => (Array.isArray(v) && v.length <= max ? v : bad(`${what} is not an array of at most ${String(max)} items`));
const literal = <T extends string>(v: unknown, want: T, what: string): T => (v === want ? want : bad(`${what} is not ${want}`));
const oneOf = <T extends string>(v: unknown, set: readonly T[], what: string): T => ((set as readonly unknown[]).includes(v) ? (v as T) : bad(`${what} is not one of ${set.join(', ')}`));
const path = (v: unknown, what: string, symlink: boolean): string => {
  const text = str(v, what);
  try { checkPath(Buffer.from(text, 'utf8'), DEFAULT_LIMITS, undefined, symlink); } catch (e) { if (e instanceof ReaderError) bad(`${what} is refused by the path rules (${e.code})`); throw e; }
  return text;
};

const indexVersion = (v: unknown): 2 | 3 | 4 => (v === 2 || v === 3 || v === 4 ? v : bad('indexVersion is not 2, 3 or 4'));

export function parseIndexManifest(value: unknown): IndexManifest {
  const o = record(value, 'the index manifest', ['schema', 'indexVersion', 'checksum', 'headCommit', 'headTreeDigest', 'indexDigest', 'entries'], ['builder']);
  const entries = array(o['entries'], 'entries', DEFAULT_LIMITS.maxEntries).map((e): IndexManifestEntry => {
    const r = record(e, 'an index entry', ['path', 'mode', 'oid', 'assumeValid', 'skipWorktree', 'intentToAdd']);
    const mode = oneOf(r['mode'], ['100644', '100755', '120000'] as const, 'an entry mode');
    return { path: path(r['path'], 'an entry path', mode === '120000'), mode, oid: oid(r['oid'], 'an entry oid'), assumeValid: bool(r['assumeValid'], 'assumeValid'), skipWorktree: bool(r['skipWorktree'], 'skipWorktree'), intentToAdd: bool(r['intentToAdd'], 'intentToAdd') };
  });
  for (let i = 1; i < entries.length; i += 1) {
    if (Buffer.compare(Buffer.from(entries[i - 1]?.path ?? '', 'utf8'), Buffer.from(entries[i]?.path ?? '', 'utf8')) >= 0) bad('the entries are not strictly ascending');
  }
  const indexDigest = sha256(o['indexDigest'], 'indexDigest');
  if (indexDigest !== computeIndexDigest(entries)) bad('indexDigest does not match the entries');
  const out: IndexManifest = {
    schema: literal(o['schema'], INDEX_MANIFEST_SCHEMA, 'schema'),
    indexVersion: indexVersion(o['indexVersion']),
    checksum: oneOf(o['checksum'], ['verified', 'skipped', 'absent'] as const, 'checksum'),
    headCommit: oid(o['headCommit'], 'headCommit'),
    headTreeDigest: sha256(o['headTreeDigest'], 'headTreeDigest'),
    indexDigest,
    entries,
  };
  if (Object.hasOwn(o, 'builder')) {
    const b = record(o['builder'], 'builder', ['indexTree', 'worktreeTree', 'indexCommit', 'worktreeCommit']);
    out.builder = { indexTree: oid(b['indexTree'], 'indexTree'), worktreeTree: oid(b['worktreeTree'], 'worktreeTree'), indexCommit: oid(b['indexCommit'], 'indexCommit'), worktreeCommit: oid(b['worktreeCommit'], 'worktreeCommit') };
  }
  return out;
}

export function parseWorktreeManifest(value: unknown): WorktreeManifest {
  const o = record(value, 'the working-tree manifest', ['schema', 'files', 'blobIds', 'excluded', 'collisions', 'sourceDigest']);
  const files = array(o['files'], 'files', DEFAULT_LIMITS.maxEntries * 2).map((f): FileSnapshot => {
    const r = record(f, 'a file snapshot', ['path', 'sha256', 'mode', 'kind'], ['symlinkTarget']);
    const kind = oneOf(r['kind'], ['file', 'symlink', 'deleted'] as const, 'kind');
    const mode = oneOf(r['mode'], ['100644', '100755', '120000'] as const, 'mode');
    if (kind === 'symlink' && mode !== '120000') bad('a symlink with another mode');
    if (kind === 'file' && mode === '120000') bad('a file with the symlink mode');
    const snap: FileSnapshot = { path: path(r['path'], 'a file path', kind === 'symlink'), sha256: sha256(r['sha256'], 'a file sha256'), mode, kind };
    if (Object.hasOwn(r, 'symlinkTarget')) {
      if (kind !== 'symlink') bad('a symlink target on something that is not a symlink');
      snap.symlinkTarget = str(r['symlinkTarget'], 'a symlink target', 1023);
    } else if (kind === 'symlink') bad('a symlink without its target');
    return snap;
  });
  const seen = new Set<string>();
  for (const f of files) { if (seen.has(f.path)) bad('a path appears twice'); seen.add(f.path); }
  const blobIds = array(o['blobIds'], 'blobIds', DEFAULT_LIMITS.maxEntries).map((b): WorktreeBlob => {
    const r = record(b, 'a blob id row', ['path', 'blobId']);
    return { path: path(r['path'], 'a blob row path', false), blobId: oid(r['blobId'], 'a blob id') };
  });
  const present = new Set(files.filter((f) => f.kind !== 'deleted').map((f) => f.path));
  if (blobIds.length !== present.size || blobIds.some((b) => !present.has(b.path))) bad('blobIds must name exactly the present files');
  const excluded = array(o['excluded'], 'excluded', DEFAULT_LIMITS.maxEntries).map((x): ExcludedPath => {
    const r = record(x, 'an excluded row', ['path', 'reason']);
    // An excluded name may fold to `.git` (that is why it is excluded), so only its length is checked here.
    const p = str(r['path'], 'an excluded path');
    if (p === '') bad('an excluded path is empty');
    return { path: p, reason: oneOf(r['reason'], ['special_file', 'nested_git', 'rebuildable_directory', 'deny_list'] as const, 'an excluded reason') };
  });
  const c = record(o['collisions'], 'collisions', ['caseOnly', 'normalization']);
  return { schema: literal(o['schema'], WORKTREE_MANIFEST_SCHEMA, 'schema'), files, blobIds, excluded, collisions: { caseOnly: int(c['caseOnly'], 'caseOnly', 0, DEFAULT_LIMITS.maxEntries * 2), normalization: int(c['normalization'], 'normalization', 0, DEFAULT_LIMITS.maxEntries * 2) }, sourceDigest: sha256(o['sourceDigest'], 'sourceDigest') };
}

export function parseHandoff(value: unknown): PortableHandoff {
  const o = record(value, 'the handoff', ['schema', 'taskId', 'stageRunId', 'allocationId', 'generation', 'epoch', 'reason', 'harnessExitCode', 'headCommit', 'indexCommit', 'worktreeCommit', 'gitVersion', 'readerVersion', 'nativeState', 'narrative']);
  const code = o['harnessExitCode'];
  return {
    schema: literal(o['schema'], HANDOFF_SCHEMA, 'schema'),
    taskId: str(o['taskId'], 'taskId', 128), stageRunId: str(o['stageRunId'], 'stageRunId', 128), allocationId: str(o['allocationId'], 'allocationId', 128),
    generation: int(o['generation'], 'generation', 1), epoch: int(o['epoch'], 'epoch', 1),
    reason: literal(o['reason'], 'harness_exited', 'reason'),
    harnessExitCode: code === null ? null : int(code, 'harnessExitCode', -255, 255),
    headCommit: oid(o['headCommit'], 'headCommit'), indexCommit: oid(o['indexCommit'], 'indexCommit'), worktreeCommit: oid(o['worktreeCommit'], 'worktreeCommit'),
    gitVersion: str(o['gitVersion'], 'gitVersion', 64), readerVersion: str(o['readerVersion'], 'readerVersion', 64),
    nativeState: literal(o['nativeState'], 'absent', 'nativeState'),
    narrative: o['narrative'] === null ? null : bad('narrative must be null'),
  };
}
