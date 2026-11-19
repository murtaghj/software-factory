// GitMaterializer: phase two of materialization (W-018). Runs wherever the storage is and touches
// no database. LocalMaterializer works on a host directory; the pod executor is W-017's.
//
// Layout: <root>/<orgId>/<workspaceId>/g<generation>/{git,work/main}. Work happens in the one fixed
// staging path <root>/<orgId>/<workspaceId>/.staging-g<generation> and is renamed into place only
// when complete. Git runs only inside that staging directory, which the factory created and which
// no candidate process has ever been able to write.
import { createHash } from 'node:crypto';
import { POD_MODE_KEY, ensurePodChild, isPodMode, type PodMode } from './internal/pod-mode.ts';
import { lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ArtifactRef, FileSnapshot } from '@factory/contracts';
import { WorkspaceError, type WorkspaceErrorCode } from './errors.ts';
import { claimFactoryOwned, GitRunner, type FactoryOwnedRepo } from './git.ts';
import { assertNoFoldedCollisions, assertRootOutsideCheckouts, assertSafeRoot, assertSymlinksContained, ensureSafeChild, isUuid, validateSubpath } from './paths.ts';
import { computeTreeDigest, treeEntries, type TreeBlob } from './tree-digest.ts';

export type MaterializeTarget = { orgId: string; workspaceId: string; generation: number };
export type MaterializeRequest =
  | { kind: 'remote'; target: MaterializeTarget; taskId: string; cloneUrl: string; commit: string; branch?: string; subpath: string }
  | { kind: 'bundle'; target: MaterializeTarget; bundle: ArtifactRef; commit: string; expectedTreeDigest: string };
export type MaterializeReceipt = { generation: number; headCommit: string; treeDigest: string; gitVersion: string };
export type MaterializeResult = { ok: true; receipt: MaterializeReceipt } | { ok: false; code: WorkspaceErrorCode; message: string };
export type RemoveResult = { absent: boolean; error?: string };
// Bytes the caller already fetched, for executors that cannot (or should not) fetch for themselves.
export type MaterializeSupplies = { bundle?: Uint8Array; signal?: AbortSignal }; // `signal`: the caller's session was lost; stop and write nothing

export interface GitMaterializer {
  // Refuses with target_exists, running no Git, if the generation directory is already there.
  materialize(request: MaterializeRequest, supplies?: MaterializeSupplies): Promise<MaterializeResult>;
  // Whole-directory delete of one generation and its staging path, by exact path, without Git.
  remove(target: MaterializeTarget): Promise<RemoveResult>;
}

// Limits on what a candidate may make this host do while the row lock is held. They are checked
// from object headers (`cat-file --batch-check`) before any content is read or any file written, and
// the expanded total counts a blob once for every path that names it.
export const MATERIALIZE_LIMITS = {
  maxEntries: 50_000,                 // blobs in one tree
  maxPathBytes: 4096,                 // one path
  maxDepth: 256,                      // components in one path
  maxTotalPathBytes: 8 * 1024 * 1024, // all paths together: bounds every per-component walk
  maxBlobBytes: 32 * 1024 * 1024,     // one blob
  maxTotalBytes: 512 * 1024 * 1024,   // all paths, repeats counted: what a checkout would write
  maxUniqueBytes: 256 * 1024 * 1024,  // distinct blobs: what is read into memory
  maxBundleBytes: 512 * 1024 * 1024,
  stepTimeoutMs: 60_000,              // one Git call (ls-tree, cat-file, checkout)
  deadlineMs: 5 * 60_000,             // the whole materialization, every call included
};
export type MaterializeLimits = typeof MATERIALIZE_LIMITS;

export type LocalMaterializerOptions = {
  root: string; git?: GitRunner; readBundle?: (ref: ArtifactRef) => Promise<Uint8Array>; limits?: Partial<MaterializeLimits>;
  // Refuse trees whose paths collide after NFC normalization and case folding. Default: on macOS.
  foldPaths?: boolean;
};

// Attributes the factory writes into the clone's own info/attributes, which outrank any in-tree
// .gitattributes: nothing may rewrite a file at checkout. The re-hash of the checked-out files is the
// real guarantee; this keeps an honest tree from failing it.
const FACTORY_ATTRIBUTES = '* -text -eol -crlf -ident -filter -working-tree-encoding\n';

const exists = (p: string): boolean => {
  try { lstatSync(p); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
};

export class LocalMaterializer implements GitMaterializer {
  readonly root: string;
  readonly git: GitRunner;
  readonly #readBundle: ((ref: ArtifactRef) => Promise<Uint8Array>) | undefined;
  readonly #limits: MaterializeLimits;
  readonly #foldPaths: boolean;
  readonly #pod: PodMode | undefined;

  constructor(o: LocalMaterializerOptions) {
    // The pod mode comes in under a private key (internal/pod-mode.ts), never as a field of the options type. A value that this package did not mint is refused.
    const m = (o as Record<symbol, unknown>)[POD_MODE_KEY];
    if (m !== undefined && !isPodMode(m)) throw new WorkspaceError('invalid_request', 'not a pod mode');
    this.#pod = m;
    this.root = o.root;
    this.git = o.git ?? new GitRunner();
    this.#readBundle = o.readBundle;
    this.#limits = { ...MATERIALIZE_LIMITS, ...o.limits };
    this.#foldPaths = o.foldPaths ?? process.platform === 'darwin';
  }

  #dirMode(): number { return this.#pod?.dirMode ?? 0o700; }

  paths(t: MaterializeTarget): { workspaceDir: string; generationDir: string; staging: string } {
    if (!isUuid(t.orgId) || !isUuid(t.workspaceId) || !Number.isSafeInteger(t.generation) || t.generation < 1) throw new WorkspaceError('invalid_request', 'invalid materialization target');
    const workspaceDir = join(this.root, t.orgId, t.workspaceId);
    return { workspaceDir, generationDir: join(workspaceDir, `g${String(t.generation)}`), staging: join(workspaceDir, `.staging-g${String(t.generation)}`) };
  }

  async materialize(request: MaterializeRequest, supplies: MaterializeSupplies = {}): Promise<MaterializeResult> {
    const { generationDir, staging, workspaceDir } = this.paths(request.target);
    try {
      assertRootOutsideCheckouts(this.root);
      assertSafeRoot(this.root);
      if (this.#pod) ensurePodChild(ensurePodChild(this.root, request.target.orgId, this.#pod), request.target.workspaceId, this.#pod);
      else ensureSafeChild(ensureSafeChild(this.root, request.target.orgId, true), request.target.workspaceId, true);
      // The target check comes first and runs no Git: this side cannot see row state, so it never
      // trusts what it finds.
      if (exists(generationDir)) throw new WorkspaceError('target_exists', 'the generation directory already exists', { generationDir });
      const version = await this.git.version();
      rmSync(staging, { recursive: true, force: true }); // a staging path left by a crash
      mkdirSync(workspaceDir, { recursive: true, mode: this.#dirMode() });
      mkdirSync(staging, { mode: this.#dirMode() });
      const owned = claimFactoryOwned(staging);
      const signal = AbortSignal.any([AbortSignal.timeout(this.#limits.deadlineMs), ...(supplies.signal ? [supplies.signal] : [])]);
      const treeDigest = request.kind === 'remote' ? await this.#fromRemote(owned, staging, request, signal) : await this.#fromBundle(owned, staging, request, supplies, signal);
      if (exists(generationDir)) throw new WorkspaceError('target_exists', 'the generation directory appeared during materialization', { generationDir });
      if (signal.aborted) throw new WorkspaceError('git_failed', 'materialization was cancelled before the directory was moved into place');
      renameSync(staging, generationDir);
      return { ok: true, receipt: { generation: request.target.generation, headCommit: request.commit, treeDigest, gitVersion: version.raw } };
    } catch (e) {
      if (!(e instanceof WorkspaceError)) { rmSync(staging, { recursive: true, force: true }); throw e; }
      if (e.code !== 'target_exists') rmSync(staging, { recursive: true, force: true });
      return { ok: false, code: e.code, message: e.message };
    }
  }

  async #fromRemote(owned: FactoryOwnedRepo, staging: string, r: Extract<MaterializeRequest, { kind: 'remote' }>, signal: AbortSignal): Promise<string> {
    validateSubpath(r.subpath);
    // --no-local: a plain local clone hard-links the source's object files, which would share
    // inodes with a repository other parties can write.
    await this.git.run(['clone', '--no-local', '--no-checkout', '--', r.cloneUrl, 'git'], { cwd: owned, signal, timeoutMs: this.#limits.deadlineMs });
    const repo = claimFactoryOwned(join(staging, 'git'));
    await this.#requireCommit(repo, r.commit, signal);
    // Judge the tree from its objects before any file is written: a path or mode that cannot be
    // represented, a symlink that is not contained, or a tree too large, is refused without a checkout.
    const { digest, entries } = await this.#digest(repo, r.commit, signal);
    await this.#checkout(repo, staging, r.commit, entries, signal, r.branch);
    this.#requireSubpath(join(staging, 'work', 'main'), r.subpath);
    return digest;
  }

  async #fromBundle(owned: FactoryOwnedRepo, staging: string, r: Extract<MaterializeRequest, { kind: 'bundle' }>, supplies: MaterializeSupplies, signal: AbortSignal): Promise<string> {
    const bytes = supplies.bundle ?? (this.#readBundle ? await this.#readBundle(r.bundle) : undefined);
    if (!bytes) throw new WorkspaceError('bundle_invalid', 'no bundle bytes were supplied and no reader is configured');
    if (bytes.length > this.#limits.maxBundleBytes) throw new WorkspaceError('tree_too_large', `the bundle is ${String(bytes.length)} bytes; the limit is ${String(this.#limits.maxBundleBytes)}`);
    assertFullBundle(bytes);
    writeFileSync(join(staging, 'in.bundle'), bytes, { mode: 0o600 });
    const t = this.#limits.stepTimeoutMs;
    await this.git.run(['init', '--quiet', '--initial-branch=main', 'git'], { cwd: owned, signal, timeoutMs: t });
    const repo = claimFactoryOwned(join(staging, 'git'));
    // Full bundles only: it must verify in an empty repository with no prerequisites.
    const verify = await this.git.run(['bundle', 'verify', '../in.bundle'], { cwd: repo, allowFailure: true, signal, timeoutMs: t });
    if (verify.code !== 0) throw new WorkspaceError('bundle_invalid', `bundle verification failed: ${verify.stderr.trim().slice(0, 300)}`);
    const fetch = await this.git.run(['fetch', '--no-tags', '--quiet', '../in.bundle', '+refs/*:refs/factory/bundle/*'], { cwd: repo, allowFailure: true, signal, timeoutMs: this.#limits.deadlineMs });
    if (fetch.code !== 0) throw new WorkspaceError('bundle_invalid', `bundle fetch failed: ${fetch.stderr.trim().slice(0, 300)}`);
    await this.#requireCommit(repo, r.commit, signal);
    const { digest, entries } = await this.#digest(repo, r.commit, signal);
    if (digest !== r.expectedTreeDigest) throw new WorkspaceError('tree_digest_mismatch', 'the candidate tree does not match its recorded treeDigest', { expected: r.expectedTreeDigest, actual: digest });
    await this.#checkout(repo, staging, r.commit, entries, signal, undefined);
    rmSync(join(staging, 'in.bundle'), { force: true });
    return digest;
  }

  // worktree add with the factory's own attributes in force, then proof that the files on disk are
  // exactly the digested bytes.
  async #checkout(repo: FactoryOwnedRepo, staging: string, commit: string, entries: FileSnapshot[], signal: AbortSignal, branch: string | undefined): Promise<void> {
    mkdirSync(join(staging, 'git', '.git', 'info'), { recursive: true });
    writeFileSync(join(staging, 'git', '.git', 'info', 'attributes'), FACTORY_ATTRIBUTES);
    mkdirSync(join(staging, 'work'), { mode: this.#dirMode() });
    const add = ['worktree', 'add', '--relative-paths', ...(branch === undefined ? ['--detach'] : ['-b', branch]), '../work/main', commit];
    await this.git.run(add, { cwd: repo, signal, timeoutMs: this.#limits.stepTimeoutMs });
    await this.#requireHead(claimFactoryOwned(join(staging, 'work', 'main')), commit, signal);
    verifyCheckout(join(staging, 'work', 'main'), entries);
  }

  async #requireCommit(repo: FactoryOwnedRepo, commit: string, signal: AbortSignal): Promise<void> {
    const r = await this.git.run(['cat-file', '-e', `${commit}^{commit}`], { cwd: repo, allowFailure: true, signal, timeoutMs: this.#limits.stepTimeoutMs });
    if (r.code !== 0) throw new WorkspaceError('commit_not_found', `commit ${commit} is not in the source`, { commit });
  }

  async #requireHead(worktree: FactoryOwnedRepo, commit: string, signal: AbortSignal): Promise<void> {
    const head = (await this.git.run(['rev-parse', 'HEAD'], { cwd: worktree, signal, timeoutMs: this.#limits.stepTimeoutMs })).stdout.toString('utf8').trim();
    if (head !== commit) throw new WorkspaceError('commit_not_found', 'the worktree is not at the requested commit', { commit, head });
  }

  #requireSubpath(worktreeDir: string, subpath: string): void {
    if (subpath === '') return;
    const isDir = ((): boolean => { try { return lstatSync(join(worktreeDir, subpath)).isDirectory(); } catch { return false; } })();
    if (!isDir) throw new WorkspaceError('invalid_subpath', `subpath ${subpath} is not a directory of the checkout`, { subpath });
  }

  // treeDigest of a commit (see tree-digest.ts), after the size limits, the strict symlink rule and
  // the case-folding collision check.
  async #digest(repo: FactoryOwnedRepo, commit: string, signal: AbortSignal): Promise<{ digest: string; entries: FileSnapshot[] }> {
    const items = await readTree(this.git, repo, commit, this.#limits, signal);
    const entries = treeEntries(items);
    assertSymlinksContained(entries);
    if (this.#foldPaths) assertNoFoldedCollisions(entries.map((e) => e.path));
    return { digest: computeTreeDigest(items), entries };
  }

  remove(target: MaterializeTarget): Promise<RemoveResult> {
    const { generationDir, staging } = this.paths(target);
    let error: string | undefined;
    try {
      assertSafeRoot(this.root);
      ensureSafeChild(ensureSafeChild(this.root, target.orgId, false), target.workspaceId, false); // lstat each component; a symlink is refused
    } catch (e) { return Promise.resolve({ absent: false, error: (e as Error).message }); }
    for (const p of [generationDir, staging]) {
      try { rmSync(p, { recursive: true, force: true }); } catch (e) { error = (e as Error).message; }
    }
    // Absence is proved by looking, not by the delete having returned.
    const absent = !exists(generationDir) && !exists(staging);
    return Promise.resolve(absent ? { absent } : { absent, error: error ?? 'path still present' });
  }
}

// The files on disk must be the digested bytes: re-hash every checked-out file (and symlink target)
// against its entry. Anything that rewrote a file at checkout shows up here.
export function verifyCheckout(worktreeDir: string, entries: readonly FileSnapshot[]): void {
  for (const e of entries) {
    const p = join(worktreeDir, e.path);
    let actual: string;
    try {
      const st = lstatSync(p);
      if (e.kind === 'symlink') {
        if (!st.isSymbolicLink()) throw new Error('not a symlink');
        actual = createHash('sha256').update(Buffer.from(readlinkSync(p, { encoding: 'buffer' }))).digest('hex');
      } else {
        if (!st.isFile()) throw new Error('not a regular file');
        if (((st.mode & 0o100) !== 0) !== (e.mode === '100755')) throw new Error('executable bit differs');
        actual = createHash('sha256').update(readFileSync(p)).digest('hex');
      }
    } catch (err) {
      throw new WorkspaceError('tree_digest_mismatch', `checked-out ${e.path} is not the digested object: ${(err as Error).message}`, { path: e.path });
    }
    if (actual !== e.sha256) throw new WorkspaceError('tree_digest_mismatch', `checked-out ${e.path} differs from the digested bytes`, { path: e.path });
  }
}

// A thin bundle lists prerequisites ("-<oid>") in its header; W-018 accepts full bundles only.
export function assertFullBundle(bytes: Uint8Array): void {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength); // a view, not a copy
  const end = view.indexOf('\n\n');
  const header = view.subarray(0, end === -1 ? Math.min(view.length, 65536) : end).toString('latin1');
  const lines = header.split('\n');
  if (!/^# v[23] git bundle$/.test(lines[0] ?? '')) throw new WorkspaceError('bundle_invalid', 'not a git bundle');
  if (lines.slice(1).some((l) => l.startsWith('-'))) throw new WorkspaceError('thin_bundle', 'the bundle has prerequisites; only full bundles are accepted');
}

const countSlashes = (b: Buffer): number => { let n = 0; for (const c of b) if (c === 0x2f) n += 1; return n; };
const tooLarge = (message: string, details: Record<string, unknown>): never => { throw new WorkspaceError('tree_too_large', message, details); };

// Every blob of a commit as raw bytes (the digest sorts them itself). The tree is judged from object
// headers first: entry count, each blob's size, and the expanded total counting every path that names
// a blob. Only then are distinct blobs read, once each; paths that share a blob share its Buffer.
export async function readTree(git: GitRunner, repo: FactoryOwnedRepo, commit: string, limits: MaterializeLimits = MATERIALIZE_LIMITS, signal?: AbortSignal): Promise<TreeBlob[]> {
  const common = { cwd: repo, timeoutMs: limits.stepTimeoutMs, ...(signal ? { signal } : {}) };
  const listing = (await git.run(['ls-tree', '-r', '-z', '--full-tree', commit], { ...common, maxBuffer: 64 * 1024 * 1024 })).stdout;
  const rows: Array<{ mode: string; type: string; oid: string; pathBytes: Buffer }> = [];
  let pos = 0;
  let pathTotal = 0;
  while (pos < listing.length) {
    const nul = listing.indexOf(0, pos);
    const entry = listing.subarray(pos, nul === -1 ? listing.length : nul);
    pos = nul === -1 ? listing.length : nul + 1;
    const tab = entry.indexOf(0x09);
    const [mode = '', type = '', oid = ''] = entry.subarray(0, tab).toString('latin1').split(' ');
    const pathBytes = Buffer.from(entry.subarray(tab + 1));
    // Before any per-path work: a long or deep path is refused outright (and bounds every later walk).
    if (pathBytes.length > limits.maxPathBytes) tooLarge(`a path is longer than ${String(limits.maxPathBytes)} bytes`, { limit: limits.maxPathBytes });
    if (countSlashes(pathBytes) >= limits.maxDepth) tooLarge(`a path is deeper than ${String(limits.maxDepth)} components`, { limit: limits.maxDepth });
    pathTotal += pathBytes.length;
    if (pathTotal > limits.maxTotalPathBytes) tooLarge(`the paths together exceed ${String(limits.maxTotalPathBytes)} bytes`, { limit: limits.maxTotalPathBytes });
    rows.push({ mode, type, oid, pathBytes });
    if (rows.length > limits.maxEntries) tooLarge(`the tree has more than ${String(limits.maxEntries)} entries`, { limit: limits.maxEntries });
  }
  const unique = [...new Set(rows.filter((r) => r.type === 'blob').map((r) => r.oid))];
  const sizes = new Map<string, number>();
  if (unique.length > 0) {
    const check = (await git.run(['cat-file', '--batch-check'], { ...common, input: `${unique.join('\n')}\n`, maxBuffer: 64 * 1024 * 1024 })).stdout.toString('latin1');
    for (const line of check.split('\n')) {
      const [oid = '', , size = ''] = line.split(' ');
      if (oid !== '' && size !== '') sizes.set(oid, Number(size));
    }
  }
  let expanded = 0;
  for (const r of rows) {
    if (r.type !== 'blob') continue;
    const size = sizes.get(r.oid);
    if (size === undefined) throw new WorkspaceError('commit_not_found', `object ${r.oid} is missing`);
    if (size > limits.maxBlobBytes) tooLarge(`a blob is ${String(size)} bytes; the limit is ${String(limits.maxBlobBytes)}`, { oid: r.oid, size });
    expanded += size;
    if (expanded > limits.maxTotalBytes) tooLarge(`the expanded tree exceeds ${String(limits.maxTotalBytes)} bytes`, { limit: limits.maxTotalBytes });
  }
  let uniqueBytes = 0;
  for (const oid of unique) uniqueBytes += sizes.get(oid) ?? 0;
  if (uniqueBytes > limits.maxUniqueBytes) tooLarge(`distinct blobs exceed ${String(limits.maxUniqueBytes)} bytes`, { limit: limits.maxUniqueBytes });

  const contents = new Map<string, Buffer>();
  if (unique.length > 0) {
    const out = (await git.run(['cat-file', '--batch'], { ...common, input: `${unique.join('\n')}\n`, maxBuffer: uniqueBytes + 64 * 1024 * 1024 })).stdout;
    let p = 0;
    while (p < out.length) {
      const nl = out.indexOf(0x0a, p);
      const [oid = '', , size = '0'] = out.subarray(p, nl).toString('latin1').split(' ');
      const n = Number(size);
      contents.set(oid, out.subarray(nl + 1, nl + 1 + n));
      p = nl + 1 + n + 1;
    }
  }
  return rows.map((r) => ({ pathBytes: r.pathBytes, mode: r.mode, blob: r.type === 'blob' ? (contents.get(r.oid) ?? Buffer.alloc(0)) : Buffer.alloc(0) }));
}
