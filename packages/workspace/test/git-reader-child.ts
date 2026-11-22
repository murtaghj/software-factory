// Runs the reader in its own process (W-020a tests): a test that plants a FIFO must be able to give the reader a time limit,
// and a synchronous read that blocked could not be interrupted from inside the test's own process.
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { openCandidateWithHooks } from '../src/git-reader/testing.ts';
import { ReaderError } from '../src/git-reader/errors.ts';

const args = JSON.parse(process.argv[2] ?? '{}') as { mount: string; orgId: string; workspaceId: string; generation: number; limits?: Record<string, number>; swapForFifo?: string };
const reader = openCandidateWithHooks(Buffer.from(args.mount), { orgId: args.orgId, workspaceId: args.workspaceId, generation: args.generation }, args.limits, args.swapForFifo === undefined ? undefined : {
  // Between the lstat and the open of this one file, replace it with a FIFO: without O_NONBLOCK the open would block for good.
  afterLstat: (path) => { if (path.toString() === args.swapForFifo) { rmSync(path.toString()); execFileSync('mkfifo', [path.toString()]); } },
});
try {
  const s = await reader.snapshot();
  process.stdout.write(JSON.stringify({ ok: true, commit: s.head.commit, files: s.worktree.files.map((f) => f.path), excluded: s.worktree.excluded }));
} catch (e) {
  if (e instanceof ReaderError) process.stdout.write(JSON.stringify({ ok: false, code: e.code, limit: e.limit, reason: e.reason }));
  else process.stdout.write(JSON.stringify({ ok: false, bug: String(e) }));
} finally { reader.close(); }
