// ReaderLimits (W-020a, 7.3): every number here is a refusal when it binds, never a truncation. A caller
// may lower any of them and may not raise one. Budget carries the running totals of one reader: the work
// budget (every byte inflated and every byte a delta writes), the object count and the deadline.
import { ReaderError, limitError } from './errors.ts';

const MiB = 1024 * 1024;

export type ReaderLimits = {
  maxObjectBytes: number;
  maxObjects: number;
  maxCommits: number;
  maxPackFiles: number;
  maxPackBytes: number;
  maxWorkBytes: number;
  maxDeltaDepth: number;
  maxEntries: number;
  maxTreeDirectories: number;
  maxTreeDirectoryPathBytes: number;
  maxPathBytes: number;
  maxDepth: number;
  maxTotalPathBytes: number;
  maxTotalBytes: number;
  maxUniqueBytes: number;
  maxIndexBytes: number;
  maxPackedRefsBytes: number;
  maxPackedRefsLines: number;
  maxRefFileBytes: number;
  deltaCacheBytes: number;
  deadlineMs: number;
};

export const DEFAULT_LIMITS: Readonly<ReaderLimits> = Object.freeze({
  maxObjectBytes: 32 * MiB,
  maxObjects: 500_000,
  maxCommits: 100_000,
  maxPackFiles: 64,
  maxPackBytes: 1024 * MiB,
  maxWorkBytes: 4096 * MiB,
  maxDeltaDepth: 512,
  maxEntries: 50_000,
  // Derived from W-018's limits, so that no tree W-018 accepts is refused for its directories (dir-table.ts, README "Directories"): at most half of 8 MiB, and 8 MiB.
  maxTreeDirectories: 4 * MiB,
  maxTreeDirectoryPathBytes: 8 * MiB,
  maxPathBytes: 4096,
  maxDepth: 256,
  maxTotalPathBytes: 8 * MiB,
  maxTotalBytes: 512 * MiB,
  maxUniqueBytes: 256 * MiB,
  maxIndexBytes: 64 * MiB,
  maxPackedRefsBytes: 16 * MiB,
  maxPackedRefsLines: 100_000,
  maxRefFileBytes: 4096,
  deltaCacheBytes: 96 * MiB,
  deadlineMs: 10 * 60_000,
});

// Overrides may only lower a limit. An unknown key, a value that is not a positive safe integer, and a value above the default are all refused.
export function resolveLimits(overrides: Partial<ReaderLimits> = {}): ReaderLimits {
  const out: ReaderLimits = { ...DEFAULT_LIMITS };
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, key)) throw new ReaderError('invalid_limits', { reason: 'unknown limit', limit: key });
    const max = DEFAULT_LIMITS[key as keyof ReaderLimits];
    if (!Number.isSafeInteger(value) || value < 1) throw new ReaderError('invalid_limits', { reason: 'not a positive integer', limit: key });
    if (value > max) throw new ReaderError('invalid_limits', { reason: 'a limit may be lowered, never raised', limit: key });
    out[key as keyof ReaderLimits] = value;
  }
  return out;
}

export type ReaderHooks = {
  // Every file-system access of the reader, in order: the operation and the path it was given.
  onFs?: (op: string, path: Buffer) => void;
  // Runs between the `lstat` and the `open` of a file, so a test can swap the inode.
  afterLstat?: (path: Buffer) => void;
  // Added to every directory listing, so a test can present a name that this file system could not store.
  extraDirEntries?: (dir: Buffer) => Buffer[];
  // Runs before every object and every file (a test delay).
  beforeObject?: () => void;
  // The test switch of the fuzz control: with it set the reader no longer compares the bytes an inflate consumed with the bytes it expected.
  skipTrailingDataCheck?: boolean;
};

export class Budget {
  readonly limits: ReaderLimits;
  readonly hooks: ReaderHooks;
  readonly #start = performance.now();
  work = 0;
  objects = 0;

  constructor(limits: ReaderLimits, hooks: ReaderHooks = {}) {
    this.limits = limits;
    this.hooks = hooks;
  }

  // Checked before every object and every file, and between hash chunks.
  tick(): void {
    this.hooks.beforeObject?.();
    if (performance.now() - this.#start > this.limits.deadlineMs) throw limitError('deadlineMs', 'the deadline passed');
  }

  // Bytes inflated, or bytes a delta writes.
  charge(bytes: number): void {
    if (this.work + bytes > this.limits.maxWorkBytes) throw limitError('maxWorkBytes', 'the work budget is spent');
    this.work += bytes;
  }
}
