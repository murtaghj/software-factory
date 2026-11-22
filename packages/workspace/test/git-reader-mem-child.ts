// Runs one reader scenario in its own process and reports the peak of `heapUsed + arrayBuffers` that it sampled (W-020a, the memory tests). Memory is
// sampled before every object, on every file-system call and at the end: resident-set size is not used, because macOS compresses idle pages and hides
// exactly the buffers this test is about. The result is printed as one line of JSON.
import { ReaderError } from '../src/git-reader/errors.ts';
import { openCandidateWithHooks } from '../src/git-reader/testing.ts';
import { Budget, resolveLimits } from '../src/git-reader/limits.ts';
import { SafeFs } from '../src/git-reader/fs-safe.ts';
import { ObjectStore } from '../src/git-reader/objects.ts';

type Args =
  | { kind: 'candidate'; mount: string; orgId: string; workspaceId: string; generation: number; limits?: Record<string, number>; out?: string }
  | { kind: 'store'; objects: string; packDir: string; oid: string; limits?: Record<string, number> };

const args = JSON.parse(process.argv[2] ?? '{}') as Args;
const used = (): number => { const m = process.memoryUsage(); return m.heapUsed + m.arrayBuffers; };
const baseline = used();
let peak = baseline;
const sample = (): void => { const u = used(); if (u > peak) peak = u; };
// The live figure: the collector runs before the sample (the child is started with --expose-gc), so what is counted is what the reader still holds and not the garbage it has not
// yet been relieved of. It is taken at every object, where the reader is between two steps; it cannot see inside one inflate (its chunks and their concatenation), so it is a lower bound.
const collect = (globalThis as { gc?: () => void }).gc;
let live = baseline;
const sampleLive = (): void => { collect?.(); const u = used(); if (u > live) live = u; };
const hooks = { beforeObject: () => { sample(); sampleLive(); }, onFs: sample };
const started = performance.now();
let result: Record<string, unknown>;
try {
  if (args.kind === 'candidate') {
    const reader = openCandidateWithHooks(Buffer.from(args.mount), { orgId: args.orgId, workspaceId: args.workspaceId, generation: args.generation }, args.limits, hooks);
    try {
      const s = await reader.snapshot();
      sample();
      const e = args.out === undefined ? undefined : await reader.exportPack(args.out);
      result = { ok: true, files: s.counts.committedFiles, deleted: s.counts.worktreeDeleted, objectsRead: s.counts.objectsRead, workBytes: s.counts.workBytes, objects: e?.objects };
    } finally { reader.close(); }
  } else {
    const budget = new Budget(resolveLimits(args.limits), hooks);
    const store = new ObjectStore(new SafeFs(hooks), Buffer.from(args.objects), Buffer.from(args.packDir), budget);
    try { const o = store.read(args.oid); sample(); result = { ok: true, found: o !== undefined, size: o?.body.length, work: budget.work }; } finally { store.close(); }
  }
} catch (e) {
  result = e instanceof ReaderError ? { ok: false, code: e.code, limit: e.limit, reason: e.reason } : { ok: false, bug: String(e) };
}
sample();
sampleLive();
process.stdout.write(JSON.stringify({ ...result, baselineMiB: baseline / 1048576, peakMiB: peak / 1048576, liveMiB: live / 1048576, ms: Math.round(performance.now() - started) }));
