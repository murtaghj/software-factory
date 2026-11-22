// The untrusted-Git reader (W-020a, 7.3). It reads one generation directory that a candidate has
// written and returns verified objects and three manifests. It never runs Git or any other program,
// never writes inside the directory it reads, and honours nothing the repository says about itself:
// the paths it opens are the fixed list of 7.3, built from the mount root and fixed names.
import { createHash } from 'node:crypto';
import { resolve as resolvePath } from 'node:path';
import { deflateSync } from 'node:zlib';
import type { FileSnapshot } from '@factory/contracts';
import { WorkspaceError } from '../errors.ts';
import { assertSymlinksContained, countFoldedCollisions, isUuid } from '../containment.ts';
import { computeTreeDigest, treeEntries, type TreeBlob } from '../tree-digest.ts';
import {
  INDEX_MANIFEST_SCHEMA, WORKTREE_MANIFEST_SCHEMA, computeIndexDigest, type CollisionCounts, type IndexManifest, type IndexManifestEntry, type WorktreeManifest,
} from '../checkpoint-manifest.ts';
import { parseCommit } from './commit.ts';
import { ReaderError, limitError, refuse, type ReaderErrorCode } from './errors.ts';
import { DirTable, RowStack } from './dir-table.ts';
import { join, SafeFs } from './fs-safe.ts';
import { parseIndex } from './index-file.ts';
import { Budget, resolveLimits, type ReaderHooks, type ReaderLimits } from './limits.ts';
import { ObjectStore } from './objects.ts';
import { decodeName } from './path-rules.ts';
import { Refs } from './refs.ts';
import { scanTree } from './tree.ts';
import { scanWorktree, type WorktreeFile } from './worktree.ts';

export const READER_VERSION = 'factory-git-reader/1';

export type CandidateTarget = { orgId: string; workspaceId: string; generation: number };

export type CandidateSnapshot = {
  head: { commit: string; ref: string | null; tree: string };
  committed: { files: FileSnapshot[]; treeDigest: string; collisions: CollisionCounts };
  index: IndexManifest;
  worktree: WorktreeManifest;
  counts: { committedFiles: number; indexEntries: number; worktreeFiles: number; worktreeDeleted: number; worktreeExcluded: number; objectsRead: number; workBytes: number };
};

export type ExportSummary = { objects: number; commits: number; bytes: number; packSha1: string };

export interface CandidateReader {
  snapshot(): Promise<CandidateSnapshot>;
  // HEAD's closure, the index's blobs and the working tree's blobs, each verified once, written as one pack with no deltas to a file that must not exist.
  exportPack(out: string): Promise<ExportSummary>;
  close(): void;
}

type Layout = { gen: Buffer; gitDir: Buffer; objects: Buffer; packDir: Buffer; wt: Buffer; work: Buffer };
type State = {
  head: { commit: string; ref: string | null; tree: string };
  indexEntries: ReturnType<typeof parseIndex>['entries'];
  // What the working-tree scan found, without the bytes: the export reads each file again, one at a time, and checks it against these hashes.
  worktreeFiles: Array<{ pathBytes: Buffer; mode: WorktreeFile['mode']; sha256: string; blobId: string }>;
  snapshot: CandidateSnapshot;
};

// W-018's functions throw WorkspaceError; every refusal that leaves the reader is a ReaderError with the same code.
function viaTreeDigest<T>(f: () => T): T {
  try { return f(); } catch (e) {
    if (!(e instanceof WorkspaceError)) throw e;
    const reasons: Partial<Record<string, [ReaderErrorCode, string]>> = {
      non_utf8_path: ['non_utf8_path', 'a path is not well-formed UTF-8'],
      non_utf8_symlink_target: ['non_utf8_symlink_target', 'a symlink target is not well-formed UTF-8'],
      unsupported_tree_entry: ['unsupported_tree_entry', 'an entry mode that cannot be represented'],
      duplicate_path: ['duplicate_path', 'a path appears twice'],
      escaping_symlink: ['escaping_symlink', 'a symlink that is not contained'],
    };
    const known = reasons[e.code];
    if (known === undefined) throw e;
    throw refuse(known[0], known[1]);
  }
}

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const EMPTY_TREE_BYTES = Buffer.from(EMPTY_TREE, 'hex');
const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
function decodeSymlinkTarget(bytes: Buffer): string {
  try { return strictUtf8.decode(bytes); } catch { throw new ReaderError('non_utf8_symlink_target', { reason: 'a symlink target is not well-formed UTF-8', content: bytes }); }
}
const sha256Hex = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const byPath = (a: { path: string }, b: { path: string }): number => Buffer.compare(Buffer.from(a.path, 'utf8'), Buffer.from(b.path, 'utf8'));

class Candidate implements CandidateReader {
  readonly #mountRoot: Buffer;
  readonly #target: CandidateTarget;
  readonly #budget: Budget;
  readonly #fs: SafeFs;
  #layout: Layout | undefined;
  #store: ObjectStore | undefined;
  #state: State | undefined;

  constructor(mountRoot: Buffer, target: CandidateTarget, limits: ReaderLimits, hooks: ReaderHooks) {
    this.#mountRoot = mountRoot;
    this.#target = target;
    this.#budget = new Budget(limits, hooks);
    this.#fs = new SafeFs(hooks);
  }

  // From the mount root, `lstat` on every component: each is a real directory or the walk stops (Furio L2).
  #walkLayout(): Layout {
    if (this.#layout !== undefined) return this.#layout;
    const fs = this.#fs;
    const rootStat = fs.lstat(this.#mountRoot);
    if (rootStat === undefined) throw refuse('path_unsafe', 'the mount root does not exist');
    if (!rootStat.isDirectory()) throw refuse('path_unsafe', 'the mount root is not a directory');
    const t = this.#target;
    const gen = fs.walk(this.#mountRoot, ['factory', t.orgId, t.workspaceId, `g${String(t.generation)}`]);
    fs.showRelativeTo(gen);
    const gitDir = fs.walk(gen, ['git', '.git']);
    const objects = fs.walk(gitDir, ['objects']);
    const packDir = fs.walk(objects, ['pack']);
    const wt = fs.walk(gitDir, ['worktrees', 'main']);
    const work = fs.walk(gen, ['work', 'main']);
    this.#layout = { gen, gitDir, objects, packDir, wt, work };
    return this.#layout;
  }

  #objects(): ObjectStore {
    const l = this.#walkLayout();
    this.#store ??= new ObjectStore(this.#fs, l.objects, l.packDir, this.#budget);
    return this.#store;
  }

  close(): void {
    const store = this.#store;
    this.#store = undefined;
    store?.close();
  }

  snapshot(): Promise<CandidateSnapshot> {
    return new Promise((resolve) => { resolve(this.#collect().snapshot); });
  }

  #collect(): State {
    if (this.#state !== undefined) return this.#state;
    const l = this.#walkLayout();
    const store = this.#objects();
    const limits = this.#budget.limits;

    const head = new Refs(this.#fs, l.gitDir, l.wt, this.#budget).resolveHead();
    const commit = parseCommit(store.mustRead(head.commit, 'commit').body, `HEAD ${head.commit.slice(0, 12)}`);

    // The committed manifest and its digest, by W-018's own functions over the reader's TreeBlobs.
    const committed = this.#committedTree(store, commit.tree);

    // The index.
    const indexPath = join(l.wt, 'index');
    // A worktree with no index file at all has an empty index, as Git reads it.
    const indexBytes = this.#fs.readSmall(indexPath, limits.maxIndexBytes, 'maxIndexBytes', true);
    const parsed = indexBytes === undefined ? { version: 2 as const, checksum: 'absent' as const, entries: [] } : parseIndex(indexBytes, limits, this.#fs.show(indexPath), () => { this.#budget.tick(); });
    const indexEntries: IndexManifestEntry[] = parsed.entries.map((e) => ({
      path: decodeName(e.pathBytes), mode: e.mode, oid: e.oid, assumeValid: e.assumeValid, skipWorktree: e.skipWorktree, intentToAdd: e.intentToAdd,
    }));
    // Every blob the index names is in the store (an intent-to-add entry names the empty blob, which parseIndex requires, and which need not exist);
    // a symlink the index holds must be as contained as one in a tree, since restore applies it.
    const indexLinks: Array<{ path: string; kind: string; symlinkTarget: string }> = [];
    for (const e of parsed.entries) {
      this.#budget.tick();
      if (e.intentToAdd) continue;
      if (e.mode === '120000') {
        const target = store.mustRead(e.oid, 'blob').body;
        indexLinks.push({ path: decodeName(e.pathBytes), kind: 'symlink', symlinkTarget: decodeSymlinkTarget(target) });
      } else if (!store.has(e.oid)) throw refuse('object_missing', 'a blob the index names is not in the repository', 'index', Buffer.from(e.oid, 'hex'));
    }
    viaTreeDigest(() => { assertSymlinksContained(indexLinks); });
    const index: IndexManifest = {
      schema: INDEX_MANIFEST_SCHEMA, indexVersion: parsed.version, checksum: parsed.checksum, headCommit: head.commit,
      headTreeDigest: committed.treeDigest, indexDigest: computeIndexDigest(indexEntries), entries: indexEntries,
    };

    // The working tree.
    const trackedFiles = new Set<string>();
    const trackedDirs = new Set<string>();
    for (const e of parsed.entries) {
      const key = e.pathBytes.toString('latin1');
      trackedFiles.add(key);
      for (let s = key.indexOf('/'); s !== -1; s = key.indexOf('/', s + 1)) trackedDirs.add(key.slice(0, s));
    }
    const scan = scanWorktree(this.#fs, l.work, { files: trackedFiles, dirs: trackedDirs }, this.#budget, (held) => { store.reserve(held); });
    const items: TreeBlob[] = scan.files.map((f) => ({ pathBytes: f.pathBytes, mode: f.mode, blob: f.blob }));
    const present = viaTreeDigest(() => treeEntries(items));
    viaTreeDigest(() => { assertSymlinksContained(present); });
    const sourceDigest = viaTreeDigest(() => computeTreeDigest(items));
    for (const f of scan.files) f.blob = Buffer.alloc(0); // the working tree's bytes are let go: the manifest has their hashes, and the export reads them again
    items.length = 0;
    store.reserve(0);
    const presentKeys = new Set(scan.files.map((f) => f.pathBytes.toString('latin1')));
    const emptySha = sha256Hex(Buffer.alloc(0));
    const deleted: FileSnapshot[] = [];
    const shaOfBlob = new Map<string, string>(); // a blob that many deleted entries name is read and hashed once
    for (const e of parsed.entries) {
      if (presentKeys.has(e.pathBytes.toString('latin1'))) continue;
      this.#budget.tick();
      let sha256 = e.intentToAdd ? emptySha : shaOfBlob.get(e.oid);
      if (sha256 === undefined) { sha256 = sha256Hex(store.mustRead(e.oid, 'blob').body); shaOfBlob.set(e.oid, sha256); }
      deleted.push({ path: decodeName(e.pathBytes), sha256, mode: e.mode, kind: 'deleted' });
    }
    const files = [...present, ...deleted].sort(byPath);
    const worktree: WorktreeManifest = {
      schema: WORKTREE_MANIFEST_SCHEMA,
      files,
      blobIds: scan.files.map((f) => ({ path: decodeName(f.pathBytes), blobId: f.blobId })).sort(byPath),
      excluded: scan.excluded.map((x) => ({ path: decodeName(x.pathBytes), reason: x.reason })),
      collisions: countFoldedCollisions(present.map((f) => f.path)),
      sourceDigest,
    };

    const snapshot: CandidateSnapshot = {
      head: { commit: head.commit, ref: head.ref, tree: commit.tree },
      committed: { files: committed.files, treeDigest: committed.treeDigest, collisions: countFoldedCollisions(committed.files.map((f) => f.path)) },
      index, worktree,
      counts: { committedFiles: committed.files.length, indexEntries: index.entries.length, worktreeFiles: present.length, worktreeDeleted: deleted.length, worktreeExcluded: scan.excluded.length, objectsRead: this.#budget.objects, workBytes: this.#budget.work },
    };
    this.#state = { head: snapshot.head, indexEntries: parsed.entries, worktreeFiles: scan.files.map((f) => ({ pathBytes: f.pathBytes, mode: f.mode, sha256: f.sha256, blobId: f.blobId })), snapshot };
    return this.#state;
  }

  // HEAD's tree, recursively: one TreeBlob per blob and symlink, judged against the limits as it is read. Directories are rows of a table, counted when
  // first seen; the empty tree, which W-018 and Git both write for nothing at all, is counted and not visited.
  #committedTree(store: ObjectStore, rootTree: string): { files: FileSnapshot[]; treeDigest: string } {
    const limits = this.#budget.limits;
    const items: TreeBlob[] = [];
    const blobs = new Map<string, Buffer>();
    let uniqueBytes = 0;
    let expanded = 0;
    let pathTotal = 0;
    const dirs = new DirTable(limits, rootTree);
    const pending = new RowStack(limits);
    pending.push(0);
    while (pending.size > 0) {
      const dir = pending.pop();
      const oid = dirs.oidOf(dir);
      const body = store.mustRead(oid, 'tree').body;
      // The visits of this loop are bounded by the rows of the table, which the directory budgets bound, so no count of visits of its own (review, Livia 1).
      scanTree(body, `tree ${oid.slice(0, 12)}`, { tick: () => { this.#budget.tick(); } }, (e) => {
        if (e.kind === 'gitlink') throw refuse('unsupported_tree_entry', 'a submodule entry'); // scanTree refuses these already; this keeps the type honest
        const name = body.subarray(e.nameStart, e.nameEnd);
        if (e.kind === 'dir') {
          if (body.compare(EMPTY_TREE_BYTES, 0, 20, e.oidStart, e.oidStart + 20) === 0) dirs.charge(dir, name.length);
          else pending.push(dirs.add(dir, name, 0, body.subarray(e.oidStart, e.oidStart + 20)));
          return;
        }
        const length = dirs.fileLength(dir, name.length);
        if (length > limits.maxPathBytes) throw limitError('maxPathBytes', 'a path is longer than the limit');
        if (dirs.depthOf(dir) + 1 > limits.maxDepth) throw limitError('maxDepth', 'a path has more components than the limit');
        if (items.length >= limits.maxEntries) throw limitError('maxEntries', 'the tree has more entries than the limit');
        pathTotal += length; // files only, as W-018's readTree counts them; directories have a budget of their own
        if (pathTotal > limits.maxTotalPathBytes) throw limitError('maxTotalPathBytes', 'the paths together are larger than the limit');
        const blobId = body.toString('hex', e.oidStart, e.oidStart + 20);
        let blob = blobs.get(blobId);
        if (blob === undefined) {
          blob = store.mustRead(blobId, 'blob').body;
          uniqueBytes += blob.length;
          if (uniqueBytes > limits.maxUniqueBytes) throw limitError('maxUniqueBytes', 'the distinct blobs of the tree are larger than the limit');
          blobs.set(blobId, blob);
          store.reserve(uniqueBytes); // the blobs held are taken out of the cache's budget
        }
        expanded += blob.length;
        if (expanded > limits.maxTotalBytes) throw limitError('maxTotalBytes', 'the expanded tree is larger than the limit');
        items.push({ pathBytes: dirs.pathOf(dir, name), mode: e.mode, blob });
      });
    }
    const files = viaTreeDigest(() => treeEntries(items));
    viaTreeDigest(() => { assertSymlinksContained(files); });
    const treeDigest = viaTreeDigest(() => computeTreeDigest(items));
    store.reserve(0); // the digest is made and the blobs are let go
    return { files, treeDigest };
  }

  exportPack(out: string): Promise<ExportSummary> {
    return new Promise((resolve) => { resolve(this.#export(out)); });
  }

  #export(out: string): ExportSummary {
    if (typeof out !== 'string' || out === '' || out.includes('\0')) throw refuse('invalid_request', 'the output path is not a usable path');
    const state = this.#collect();
    const l = this.#walkLayout();
    const store = this.#objects();
    const limits = this.#budget.limits;
    const target = Buffer.from(resolvePath(out));
    const gen = Buffer.concat([l.gen, Buffer.from('/')]);
    if (target.length >= gen.length && target.subarray(0, gen.length).equals(gen)) throw refuse('invalid_request', 'the output path is inside the directory being read');

    const file = this.#fs.createExclusive(out);
    try {
      const header = Buffer.alloc(12);
      header.write('PACK', 0, 'latin1');
      header.writeUInt32BE(2, 4);
      file.append(header);
      let objects = 0;
      let commits = 0;
      const emit = (type: 'commit' | 'tree' | 'blob', body: Buffer): void => {
        if (objects >= limits.maxObjects) throw limitError('maxObjects', 'the export names more objects than the limit');
        objects += 1;
        const code = type === 'commit' ? 1 : type === 'tree' ? 2 : 3;
        const head: number[] = [];
        let size = body.length;
        let byte = (code << 4) | (size & 15);
        size = Math.floor(size / 16);
        while (size > 0) { head.push(byte | 0x80); byte = size & 0x7f; size = Math.floor(size / 128); }
        head.push(byte);
        file.append(Buffer.from(head));
        file.append(deflateSync(body));
      };
      // HEAD's closure: every commit reachable from it, with the trees and blobs of each.
      const queue: Array<{ type: 'commit' | 'tree'; oid: string }> = [{ type: 'commit', oid: state.head.commit }];
      // Every object once, with the one type it was first named as: an id used as both a tree and a blob is refused.
      const named = new Map<string, 'commit' | 'tree' | 'blob'>([[state.head.commit, 'commit']]);
      const claim = (oid: string, type: 'commit' | 'tree' | 'blob'): boolean => {
        const had = named.get(oid);
        if (had === undefined) {
          if (named.size >= limits.maxObjects) throw limitError('maxObjects', 'the history names more objects than the limit');
          named.set(oid, type);
          return true;
        }
        if (had !== type) throw refuse('object_corrupt', `an object id is named as both a ${had} and a ${type}`, undefined, Buffer.from(oid, 'hex'));
        return false;
      };
      while (queue.length > 0) {
        const next = queue.pop();
        if (next === undefined) break;
        const obj = store.mustRead(next.oid, next.type);
        emit(next.type, obj.body);
        if (next.type === 'commit') {
          commits += 1;
          if (commits > limits.maxCommits) throw limitError('maxCommits', 'the history has more commits than the limit');
          const c = parseCommit(obj.body, `commit ${next.oid.slice(0, 12)}`);
          for (const p of c.parents) if (claim(p, 'commit')) queue.push({ type: 'commit', oid: p });
          if (claim(c.tree, 'tree')) queue.push({ type: 'tree', oid: c.tree });
        } else {
          // HEAD's tree was judged by the full path rules when the snapshot was taken; the trees of history only by their structure, as W-018 reads
          // none of them (its clone accepts any name Git stores), and a repository whose old commits had a Latin-1 name must still be checkpointed.
          const options = next.oid === state.head.tree ? { tick: () => { this.#budget.tick(); } } : { structureOnly: true, tick: () => { this.#budget.tick(); } };
          const body = obj.body;
          scanTree(body, `tree ${next.oid.slice(0, 12)}`, options, (e) => {
            if (e.kind === 'gitlink') return; // a submodule's commit is not an object of this repository
            const oid = body.toString('hex', e.oidStart, e.oidStart + 20);
            if (!claim(oid, e.kind === 'dir' ? 'tree' : 'blob')) return;
            if (e.kind === 'dir') queue.push({ type: 'tree', oid });
            else emit('blob', store.mustRead(oid, 'blob').body);
          });
        }
      }
      // The index's blobs (an intent-to-add entry names the empty blob, which need not exist).
      for (const e of state.indexEntries) {
        if (e.intentToAdd || !claim(e.oid, 'blob')) continue;
        emit('blob', store.mustRead(e.oid, 'blob').body);
      }
      // The working tree's blobs, each read again and checked against the SHA-256 that went into the manifest: bytes that are not those are `file_changed`,
      // so what is exported is what was digested. They are read one at a time, so that the working tree is never held in memory beside the export.
      for (const f of state.worktreeFiles) {
        this.#budget.tick();
        if (!claim(f.blobId, 'blob')) continue;
        const abs = join(l.work, f.pathBytes);
        const bytes = f.mode === '120000' ? this.#fs.readlink(abs) : (this.#fs.readSmall(abs, limits.maxObjectBytes, 'maxObjectBytes') ?? Buffer.alloc(0));
        if (sha256Hex(bytes) !== f.sha256) throw refuse('file_changed', 'a working-tree file changed between the snapshot and the export', this.#fs.show(abs));
        emit('blob', bytes);
      }
      const count = objects;
      const patch = Buffer.alloc(4);
      patch.writeUInt32BE(count, 0);
      file.writeAt(patch, 8);
      const sum = file.sha1(0, file.size, () => { this.#budget.tick(); });
      file.append(sum);
      return { objects: count, commits, bytes: file.size, packSha1: sum.toString('hex') };
    } catch (e) { file.discard(); throw e; } finally { file.close(); }
  }
}

// `mountRoot` is the claim's mount point as raw bytes (`/workspace` in the child). Nothing is opened until the first call on the reader.
export function openCandidate(mountRoot: Buffer, target: CandidateTarget, limits?: Partial<ReaderLimits>): CandidateReader {
  return openCandidateWithHooks(mountRoot, target, limits, undefined);
}

// The same with the test seams (a file-system spy, a swap between lstat and open, an extra directory entry, a delay, the trailing-data switch). It is not
// exported from `index.ts`; tests reach it through `testing.ts`, which `tools/boundaries.json` keeps from every other module.
export function openCandidateWithHooks(mountRoot: Buffer, target: CandidateTarget, limits: Partial<ReaderLimits> | undefined, hooks: ReaderHooks | undefined): CandidateReader {
  if (!Buffer.isBuffer(mountRoot) || mountRoot.length === 0 || mountRoot[0] !== 0x2f || mountRoot.includes(0)) throw new ReaderError('invalid_request', { reason: 'the mount root must be an absolute path as a Buffer' });
  if (!isUuid(target.orgId) || !isUuid(target.workspaceId) || !Number.isSafeInteger(target.generation) || target.generation < 1) throw new ReaderError('invalid_request', { reason: 'invalid candidate target' });
  const trimmed = mountRoot.length > 1 && mountRoot[mountRoot.length - 1] === 0x2f ? mountRoot.subarray(0, -1) : mountRoot;
  return new Candidate(Buffer.from(trimmed), { ...target }, resolveLimits(limits), hooks ?? {});
}
