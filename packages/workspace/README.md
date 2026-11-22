# @factory/workspace (W-018)

Private, reproducible Git workspaces, database fencing of stale writers, and an independent copy of
a fixed candidate for verifiers (chapter 06). No Kubernetes, no Temporal, no migration.

## The Git rule

Trusted code runs Git only on a repository that the factory created and that no candidate process
has ever been able to write. That means two places: a generation directory whose row is
`allocated`, and a staging repository built from an artifact. `allocated` always means "no writer
has ever started on the current generation". Once a writer has started, trusted code may do exactly
one thing to that directory: delete it whole, by its exact path, without Git and without following
symlinks. Reading candidate state after that point is the job of W-020's reader. A denylist of `-c`
options cannot do this job, because filter and diff driver names are chosen by the repository.

`src/git.ts` is the only file that runs a program. Every call takes a `FactoryOwnedRepo` handle that
only the materializer and the publisher can mint (it is not exported from the package). The
environment is built from nothing: a fixed `PATH`, an empty `HOME`, `/dev/null` as global and system
config, no prompt, and no variable of the parent process (`PATH` is `/usr/bin:/bin`). Hooks path and
fsmonitor are off, object checks are on, and every call has a time limit. Transports are an
allowlist: `protocol.allow=never`, with only https and ssh switched on. `file` is on only through
`GitRunner`'s explicit `allowFileTransport` option, which the tests (local bare remotes) set. The
shared `HOME` is one empty, 0700 directory per user; Git refuses to run if it is anything else. Git 2.48 or later is
required (relative worktree paths); the observed version goes into every receipt. Every clone uses
`--no-local`, because a plain local clone hard-links the source's object files.

## Symlinks (the strict rule)

A tracked symlink is accepted only if its target is relative, contains **no `..` component**, and
does not resolve through another symlink of the tree (nor is itself another symlink). Absolute and
empty targets are refused, and so is a target over 1023 bytes or 128 components (checked before it is
split). The walk is linear: symlink paths go into a trie keyed by (parent, name) and a target is
followed through it. The check is on the tree's objects, before any file is written, and
a lexical "does it normalize outside the root" test is not used: chains such as `a/b/up -> ../..`
with `escape -> a/b/up/../../..` pass it and climb out on disk. After checkout the files on disk
are re-hashed against the digested entries, so anything that rewrites a file at checkout (in-tree
`.gitattributes` eol, ident, working-tree-encoding) fails with `tree_digest_mismatch`; the clone's own
`info/attributes` switches those off first. On macOS, trees whose paths collide after NFC
normalization and case folding are refused (`path_collision`); the collision map is keyed by
(parent node, folded name), so it is linear in the number of path components. The folding is NFC,
Unicode lowercase and final-sigma-to-sigma, which is not exact Unicode case folding; the re-hash of
the checked-out files is the backstop for any alias it misses.

## Limits on a candidate tree

Checked from object headers (`ls-tree`, `cat-file --batch-check`) before any content is read or
file written, in `MATERIALIZE_LIMITS`: 50,000 entries; paths of at most 4096 bytes and 256
components, 8 MiB of path bytes in all (these bound every later per-path walk); 32 MiB per blob; 512 MiB expanded total
(a blob counts once per path that names it); 256 MiB of distinct blobs; 512 MiB bundle; 60 s per Git
call; 5 minutes for the whole materialization. Distinct blobs are read once and hashed once.
Exceeding any is `tree_too_large` (or a refused `git_failed` on the deadline). The workspace root
must be a real directory owned by this user and not group- or world-writable; each component below
it is lstat'ed and a symlink is refused.

## Who may call what

Every manager call (`allocateOrAttach`, `materializationRequest`, `acceptMaterialization`,
`markWriterStarted`, `markWriterQuiescing`, `markWriterStopped`, `replaceWriter`, `release`, `materializeCandidate`) and
`LocalWorkspaceHost.ensureMaterialized` requires the runner service identity; a refusal is audited.
The publisher likewise needs a context scoped to the workspace's task, and never rewrites it.
The caller's task scope is never rewritten: `allocateOrAttach` and `materializeCandidate` need a
task-scoped caller, and any caller whose `taskId` differs from the workspace's is refused, so
artifact reads use the caller's own scope. The host-only operations (`requestInTx`, `acceptInTx`, the
pre-lock source fetch) are not on the public interface; `hostInternals()` is not exported.
`release` of a `checkpointed` or `retained` copy is refused (`checkpoint_not_accepted`) unless its
`checkpoint_ref` names a registered artifact still inside its retention window; the fuller
"accepted output" check arrives with W-020. TODO (W-020): that check is not yet bound to this
workspace (any registered, retained artifact satisfies it); W-020 must bind the checkpoint to the
workspace, generation and epoch. Registry clone URLs with credentials, `::` helper syntax, option-like
values or option-like hosts are refused. The one userinfo allowed is a bare username (no password) on
an `ssh://` URL or an scp-style address (`git@host:org/repo`): it carries no secret. A username in an
https URL is usually a token and is refused.

A writer's end (W-017, D17): `markWriterQuiescing` moves `active` to `quiescing` and `markWriterStopped` moves
`quiescing` to `retained`, each for the pod that owns the workspace at the expected epoch, with the runner
identity, the caller's task scope and the row lock, like `markWriterStarted`. A repeat by the same pod is a
no-op, and `markWriterQuiescing` also accepts a workspace already `retained` by that pod. A different pod is
`conflict`; any other source state is `invalid_state`. Neither touches the volume: a `retained` workspace keeps
its work until an accepted checkpoint lets `release` remove it (W-020), and `release` still refuses `active` and
`quiescing` as `writer_active`.

A database session that is lost (killed, reset) raises `sessionLostSignal` in `@factory/database`,
and `withTenant` throws the session's own error (for example 57P01) with the failure it caused as
`cause`. The host aborts a clone on it, and on any failure after the directory is moved into place
removes the directory before the error leaves, so a released row never has a live generation under it.

## Which part runs where

| Part | Runs in | Touches |
| --- | --- | --- |
| `WorkspaceManager` (`createWorkspaceManager`) | The runner process | Postgres only: rows, generations, epochs, state, fencing, accepted receipts. Never a filesystem. |
| `GitMaterializer` (port), `LocalMaterializer` | Wherever the storage is | One generation directory that does not exist yet. No database. The pod executor is W-017. |
| `LocalWorkspaceHost` | Tests, local runs, the fake tier | Takes the row lock, runs the materializer, hands the receipt to the manager. |
| `createPublisher` (`compareAndUpdateRef`) | The control plane, where the Git credential lives | A row lock and a staging repository built from an artifact. Never a workspace. |

## Two-phase materialization

1. `allocateOrAttach` inserts or attaches the row (`allocated`, generation 1, epoch 1) and does no
   filesystem work.
2. `materializationRequest(ctx, id, epoch)` builds what a materializer needs from the row and the
   registry (clone URL and subpath from the `repository` and `application_repository` rows, never
   from the caller; or, for a candidate copy, the source bundle, commit and expected `treeDigest`).
   It answers only while the row is `allocated` with no accepted receipt, and answers
   `restore_unavailable` when a `checkpoint_ref` exists.
3. The materializer works in `<root>/<orgId>/<workspaceId>/.staging-g<generation>` and renames it to
   `g<generation>/{git,work/main}` when complete. If the target exists it refuses with
   `target_exists` and runs no Git.
4. `acceptMaterialization` (runner identity only) records the receipt as a controller artifact linked
   to the task with purpose `workspace_materialization/<workspaceId>/g<generation>`.
5. `markWriterStarted` (runner identity only, needs an accepted receipt) is the one transition that
   ends `allocated`.

`replaceWriter` is the fence: under a `FOR UPDATE` lock (75 s wait, then a retryable
`publish_in_progress`) it moves the row to `allocated` at generation n+1 and epoch n+1. It never
reads, renames, reuses or deletes `g<n>`. There is no `reuse` outcome in W-018.

## treeDigest

`treeDigest` is `canonicalHash({ algorithm: 'factory-tree-digest/1', entries })` over one
`FileSnapshot` per blob, sorted by the path's UTF-8 bytes, with modes limited to `100644`, `100755`
and `120000`. The committed vector is in `src/tree-digest.ts`; W-020's reader must reproduce it
byte for byte (SI-16).

## Publisher, and its residual risk

`compareAndUpdateRef` may be called only by the configured Git publisher service identity. The
request names no repository, branch or commit: all three come from the workspace row. The row is
held `FOR SHARE` across the push, with `idle_in_transaction_session_timeout` at 90 s against a 45 s
push deadline, so a concurrent `replaceWriter` waits for the push and a push after a replacement sees
the new epoch and is refused. The push uses an explicit expected-head lease (or "must not exist"),
never a plain force. Results: `updated`, `needs_reconciliation` (both heads), `stale_epoch`. A push
interrupted by the deadline or a lost session is `needs_reconciliation` with `outcomeUnknown: true`:
the remote may or may not have applied it before the kill.

The publisher works in three phases so the lock is held only for the push: (1) with no transaction
open it reads the row, reads and verifies the bundle, and builds a staging repository at a path
unique to the call; (2) it locks the row `FOR SHARE`, re-checks epoch, state, branch and
candidate commit, and pings the session; (3) it runs the push and `ls-remote` under one 45 s
deadline, well inside the 90 s idle-in-transaction timeout. No second pooled connection is needed
while the lock is held.

Every Git call runs in its own process group. On a timeout, an abort or a lost database session the
whole group is killed (`kill(-pgid)`) and the call waits until the group has exited before it settles,
so no child of Git (ssh, pack-objects, git-remote-https, receive-pack) started by that call can finish
a transfer after the lock is released and a `replaceWriter` has fenced. Only the push's outcome at the
instant of the kill is unknown, which is why it is reported as such.

Residual risk: if the publisher loses its database connection mid-push the lock is gone at that
moment, and a remote that had already accepted the data cannot be taken back. Nothing stronger is
possible without fencing on the provider's side. A database session that is lost also stops a held
materialization: the clone is aborted and a directory already moved into place is removed before the
error leaves (`sessionLostSignal` in `@factory/database`).

## Hand-off notes for W-017 and W-019

- In pod mode the materializer's `remove` runs where the volume is, and a pod-side rename or
  delete can race a release. W-017's release must delete the PVC (by ownership label and UID), not
  rely on the local `remove`. (Done in W-017 17b: `PodVolumeMaterializer.remove` in `apps/runner`.)
- `@factory/workspace/pod` (`src/pod-exports.ts`) is the narrow surface the pod executor's image loads: `LocalMaterializer`, `GitRunner`,
  `WorkspaceError` and the request and receipt types, and nothing that reaches the manager. The image has no database.
- `release` and `replaceWriter` need the row exclusively; the 75 s lock wait fails as
  `publish_in_progress`, whoever holds the lock (a publish or another transition).
- The host checks that a row is materializable before fetching a candidate bundle (up to 512 MiB).
- The setup profile refuses shells, wrappers (`env`, `xargs`, ...) and interpreters given inline
  code (`-c`, `-e`, `--eval=...`, `deno eval`, `pwsh -Command`, versioned names such as `ruby3.3`).
  **That list is advisory only** and is easy to get around (`find -exec`, `awk system()`, `script -c`,
  `flock`, unlisted shells and interpreters). The executor's sandbox is the control.

## Records and the disposition of an old volume (W-019)

`quiescence-proof.ts` and `quarantine-record.ts` define the two controller artifacts (`factory-quiescence-proof/1`, and the restricted
`factory-quarantine-record/1`), each with `prepare` (outside any transaction: the runner identity is required, a refusal is audited in its own transaction,
the body is validated and put), `register` (on the caller's transaction, under the allocation's row lock) and `read` (counts only links the runner identity
produced; two are a hard error, because `artifact_link` has no unique key and the row lock is the only thing making it "one"). `volume-disposition.ts` is pure.
The pod export (`@factory/workspace/pod`, `createPodMaterializer`) makes every level 0750 (the supervisor lists the checkout through its group); everything reachable from the package index keeps 0700, and no exported signature carries a mode.
The publisher's scratch root and any materializer's root must be disjoint (both use `<org>/<workspaceId>`); W-030 owns the check.

## The untrusted-Git reader (W-020a)

`src/git-reader/`, exported as `@factory/workspace/git-reader` (a subpath; the package index does not re-export it, and `tools/boundaries.json` lets only this package's own tests
import it until 20b). It reads one generation directory that a candidate has written, and returns verified objects and three manifests. In 20a it is a library with no caller.

**Rule 8: candidate Git metadata is data.** The reader never runs Git or any other program, never writes inside the directory it reads, and honours nothing the repository says about
itself. It opens only the paths below, built from the mount root and fixed names, never from a file's contents. It does not open `config`, `info/attributes`, `info/grafts`,
`info/exclude`, `hooks/`, `shallow`, `.git` files, `worktrees/main/commondir`, `gitdir` or `config.worktree`, `objects/info/alternates`, `http-alternates`, `commit-graph`,
`multi-pack-index`, `refs/replace/`, `.keep`, `.rev`, `.mtimes` or `.promisor`. ESLint (`eslint.config.js`) and a structural test (`w020-reader-structure.test.ts`) enforce that
`node:fs` is imported only by `fs-safe.ts` and that nothing in the reader imports `node:child_process`, `node:worker_threads` or `../git.ts`.

| Path under `g<n>/git/.git/` | Read for |
| --- | --- |
| `worktrees/main/HEAD`, `worktrees/main/index` | The checked-out ref or commit; the index |
| `refs/heads/...` (one loose ref, up to four more symref hops) and `packed-refs` | Resolving `HEAD` |
| `objects/xx/<38 hex>` | Loose objects |
| `objects/pack/pack-<40 hex>.idx` with its `.pack` | Packed objects (index version 2, pack version 2 or 3) |
| `reftable` (by `lstat` only) | Refusal: `unsupported_ref_storage` |

The working tree is `g<n>/work/main`; its root `.git` entry is never opened.

### File access

Every path is a `Buffer` of raw bytes and is walked from the claim's mount root with `lstat`: `factory`, the organization, the workspace, `g<n>`, `git`, `.git`, `objects`,
`objects/pack`, `worktrees`, `worktrees/main`, `work` and `main` must each be a real directory (else `path_unsafe`), because `O_NOFOLLOW` covers only the last component of a path.
Every file is opened `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`, so a FIFO cannot block the reader, and checked with `fstat`: a regular file, the same device and inode as the `lstat`,
no larger than the cap for its kind. Small files are read whole and their size must be unchanged afterwards. Packs and their indexes are never read whole: entries are read
with positioned reads, one entry at a time, and the trailers are checked by streaming the file through SHA-1 in 1 MiB chunks. Directory names are bytes; a working-tree name is
checked as UTF-8 and against the path rules before it is `lstat`ed. `node --permission` (planned for the child's `read` container) is a second line against writes and process
spawns only: probe P1 showed that it follows symlinks out of the allowed tree.

### Objects, packs and deltas

Packs are searched first, then loose objects; there is no other source. Every returned object has been checked against its SHA-1 name. `zlib.inflateSync` is always called with
`maxOutputLength` and never with a `dictionary`; Node does not refuse bytes after the end of a stream (probe Z1), so the bytes an inflate consumed are compared with the bytes
expected (the whole file for a loose object, the gap to the next entry for a pack entry): any difference is `trailing_data`. An object that declares size 0 is inflated with a cap
of 1 and must give 0 bytes (probe Z4). A pack entry is inflated with the size its own header declares, its CRC-32 must match the index, and its type is 1 to 4, 6 or 7. Deltas are
resolved iteratively with a visited set (a cycle is `object_corrupt`) and a depth limit; a copy must lie inside the base, an insert is 1 to 127 bytes, opcode 0 is refused, and the
output must have exactly the result size. A delta-base cache of at most 96 MiB holds recent bases; a base that was evicted is inflated again and paid for again.

### Limits

Every limit is a typed refusal naming itself (`limit_exceeded`, `limit`), never a truncation. A caller may lower a limit and may not raise it (`invalid_limits`). Each binds at its
value and refuses one past it, and each has a test that shows both.

| Limit | Default | Notes |
| --- | --- | --- |
| `maxObjectBytes` | 32 MiB | One object, inflated. A loose file may be as long as deflate's own bound for that size: incompressible data compresses to slightly more than itself. A delta stream may be up to twice that (a copy instruction can say one output byte in two bytes of stream), so a delta read holds one base, one stream of up to 64 MiB and one result: 128 MiB. |
| `maxObjects` / `maxCommits` | 500,000 / 100,000 | Objects the export writes and names, and the objects listed by all pack indexes together (stricter than 7.3: a clone holds every branch and tag, so a repository with more than 500,000 packed objects is refused even if `HEAD`'s closure is small); directories visited in the tree walk; commits reachable from `HEAD`. |
| `maxPackFiles` / `maxPackBytes` | 64 / 1 GiB | All packs together; the bytes counted are those of every `.pack` and `.idx`. A single file over the limit is refused too. |
| `maxWorkBytes` | 4 GiB | Every byte inflated plus every byte a delta writes, re-inflation after eviction included. |
| `maxDeltaDepth` | 512 | Deltas in one chain. |
| `maxEntries` | 50,000 | Each for the tree (files and symlinks), the index, and the working tree (files, symlinks and exclusions). |
| `maxTreeDirectories` / `maxTreeDirectoryPathBytes` | 4 Mi / 8 MiB | Directories of `HEAD`'s tree and of the working tree, and their names (a slash each), counted when each is first seen, with budgets of their own so that directories never spend the budget of file paths. Derived from W-018's limits below, so that no tree W-018 accepts is refused for them. |
| `maxPathBytes`, `maxDepth`, `maxTotalPathBytes` | 4,096, 256, 8 MiB | As in `MATERIALIZE_LIMITS`. |
| `maxTotalBytes` / `maxUniqueBytes` | 512 MiB / 256 MiB | Expanded (a blob counts once per path) and distinct content. |
| `maxIndexBytes`, `maxPackedRefsBytes`, `maxPackedRefsLines`, `maxRefFileBytes` | 64 MiB, 16 MiB, 100,000, 4 KiB | The index; `packed-refs`; a ref or `HEAD` file. |
| `deltaCacheBytes` | 96 MiB | The delta-base cache. |
| `deadlineMs` | 10 minutes | Checked before every object and every file, and between hash chunks. |

**Memory, as a sum of its parts.** All of it is `Buffer` and typed-array memory that a limit bounds; what is measured and what is inferred is said for each. In bytes:

| Part | Bound | Basis |
| --- | --- | --- |
| One delta read in flight: a base, a stream, a result | 32 + 64 + 32 = 128 MiB | measured (a 20-link chain of 32 MiB: 198 to 202 MiB live, the rest of it the cache) |
| The delta-base cache | 96 MiB, less whatever the walk holds | measured; `ObjectStore.reserve` takes the held blobs out of its share |
| `HEAD`'s unique blobs, held while its manifest is built | 256 MiB (`maxUniqueBytes`) | measured |
| The tree body being scanned, and its offsets | 32 MiB, and 12 bytes an entry (about 12 MiB for a million entries); entries are not objects | measured (a 32 MiB tree of a million directories) |
| The directory table | 34 bytes a directory (14 of rows, 20 of id) and 4 of stack: 4 Mi rows is 160 MiB at the cap, and the 8 MiB of names stops it at about 2.8 million rows (95 MiB) for names of two bytes | measured at 1.2 million rows; the rest inferred |
| The working tree's unique files, held while its manifest is built | 256 MiB, after `HEAD`'s blobs have been let go | measured; the two phases do not overlap in the code, and a collector that runs late can make them |
| The index file | 64 MiB, then 50,000 entries | inferred |
| The export: the names of up to 500,000 objects, and one object and its compressed form | about 125 MiB, and 64 MiB | inferred, not measured |
| The temporaries of one `inflateSync` (its chunks, then their concatenation) | one more output, 64 MiB for a delta stream | inferred; no sample can see inside the call |

The worst case that this tree can build is the one `w020-reader-limits.test.ts` builds as its combined fixture: 256 MiB of `HEAD` blobs, each a chain of four insert-only deltas, in a
root tree of 32 MB with a million directories that name the empty tree, and under it a comb of three levels of 1- and 2-byte names that runs until the 8 MiB of directory names is spent.
**Measured: 325 MiB of heap plus buffers live (the collector is run at every object), 422 MiB peak without a collection.** Adding the 64 MiB that one inflate can hide gives about
**486 MiB: under 512 MiB, with 26 MiB to spare**, and half of the `read` container's 1 GiB. The sum of the parts above is higher than that figure, because no input makes all of them
meet: the blobs are read while the comb is still empty, and the comb grows after the chains have finished; the export phase (inferred above) comes after `HEAD`'s blobs are gone. So the
claim is this: the worst fixture found fits under 512 MiB by 26 MiB, and an upper bound that adds every part is not 512 MiB, it is about 700 MiB, which the 1 GiB limit holds.
The rest of the evidence is in the same test file, sampled as `heapUsed + arrayBuffers` in child processes (not resident-set size: macOS compresses idle pages and showed 324 MiB where
these buffers held 901 MiB): a chain of 20 deltas that each inflate to 32 MiB, 202 MiB live (901 before the walk applied one link at a time); the fan-out of 20,000 entries, six deep,
184 MiB; a 128 MiB padded index, 12 MiB; the largest legal clean checkout with a different 256 MiB working tree, 391 MiB, uncollected. A test that holds four extra 32 MiB streams
makes the chain test fail (353 MiB against a bound of 300): the live figure is a figure that catches a leak.

### Directories

W-018's `readTree` counts files only: at most `maxEntries` (50,000), with paths of at most `maxPathBytes` (4,096) and `maxDepth` (256) components, and `maxTotalPathBytes` (8 MiB)
of file paths in all. A tree that it can check out has a file below every directory (an empty directory cannot be checked out), so every directory is a component of some file's
path. A directory is first seen by one such file, and each component of a path takes at least two bytes of it (a name and a slash). So the directories of any such tree number at most
`maxTotalPathBytes / 2` = **4 Mi** (`maxTreeDirectories`), and their names, a slash each, are at most `maxTotalPathBytes` = **8 MiB** (`maxTreeDirectoryPathBytes`), because each name is
part of the file path that first reached it. Neither is a number picked for the reader: a tree whose every directory holds a file can never be refused by either. The densest case that
W-018 accepts (about 16,500 files, each in its own chain of 255 one-byte directories) has 4.2 million directories, and the table below holds them.

The walk keeps directories as rows of a table (parent, name in one arena, path length, depth, and for a tree of objects the 20-byte id), 14 bytes and an id each, and builds a path only
when a file needs it; a directory that names the empty tree is counted and not visited. That makes 4 Mi directories a bounded amount of memory: the memory test below holds 1.2 million
of them (the fan-out of 20,000 entries a tree, six deep, which exhausts the 8 MiB of names) at 184 MiB of heap plus buffers.

Where the reader refuses what W-018 accepts, in all: a backslash in a name (D28); a path component over 255 bytes; a tree whose directories hold no file past the directory budget (below); and deep delta chains for `HEAD`'s blobs once the cache share is used up, because the reader pays for every re-inflation in `maxWorkBytes` and a repository whose blobs are all deep chains, with the held blobs having taken the whole 96 MiB, could reach 4 GiB of work (Git keeps its own cache and has no such budget). Each is named in the differential list of `w020-reader-tree-digest.test.ts`.

The one shape among them that comes from directories is a tree whose directories hold **no file**: subtrees that contain only empty trees, which a checkout cannot
represent and which is the shape of Furio's fan-out attack. It is refused only past the budget above (a million of them are read), and it is named in the differential list of
`w020-reader-tree-digest.test.ts` beside the backslash and the over-long component.

### Interface

```ts
openCandidate(mountRoot: Buffer, target: { orgId; workspaceId; generation }, limits?: Partial<ReaderLimits>): CandidateReader
reader.snapshot(): Promise<CandidateSnapshot>   // head, committed manifest and treeDigest, index manifest, working-tree manifest, counts
reader.exportPack(out: string): Promise<ExportSummary>
reader.close(): void                            // releases the pack files
```

The test seams (a file-system spy, a swap between `lstat` and `open`, an extra directory entry, a delay between objects, and the switch that turns the trailing-data check off for
the fuzz control) are `openCandidateWithHooks` in `git-reader/testing.ts`. They are not on `openCandidate` and not exported from `git-reader/index.ts`, and `tools/boundaries.json`
lets only this package's own tests import `@factory/workspace/git-reader/testing`. `exportPack` writes `HEAD`'s closure (every reachable commit, tree and blob), the index's blobs and
the working tree's blobs, each verified once, as one pack with no deltas (version 2, its own trailer) to a file that must not exist (`O_EXCL`, `O_NOFOLLOW`, 0644), outside the
directory it reads; a failed export removes its file. The trees of old commits are judged by their structure only (mode, zero padding, layout, duplicates; a submodule entry is
skipped), as W-018 reads none of them and its clone accepts any name Git stores; `HEAD`'s tree, the index and the working tree get the full path rules. The working-tree blobs are
read again at export, one at a time, and a file whose SHA-256 is no longer the one in the manifest is `file_changed`. The pack is not bounded by a limit of its own: it is at most
the objects it names, so `/export` must be sized for the undeltified closure (up to `maxWorkBytes`), against a bundle part of 256 MiB.

A refusal is a `ReaderError { code, file?, limit?, reason?, contentHex? }`. The code list is closed (`READER_ERROR_CODES`). `file` is relative to the generation directory and
printable ASCII; `contentHex` is at most 64 bytes, as hex. Any exception that is not a `ReaderError` is a bug.

### What the manifests hold

- **Committed manifest and `treeDigest`.** `TreeBlob`s for `HEAD`'s tree go to W-018's own `treeEntries` and `computeTreeDigest`, unchanged, and `assertSymlinksContained` is applied
  to the result. Modes are canonicalised as Git does when it reads a tree (a regular file is `100755` when the owner's execute bit is set and `100644` otherwise); a zero-padded mode
  is `object_corrupt` with reason `zero_padded_mode`; a submodule or another type is `unsupported_tree_entry`. `w020-reader-tree-digest.test.ts` shows the digest equal to W-018's
  on a corpus, and no case in it is accepted by W-018 and refused by the reader.
- **Index manifest** (`factory-checkpoint-index/1`): versions 2 to 4, entries strictly ascending with a stage of 0 and modes `100644`, `100755` or `120000`, the three flags that change
  what restore must do, the checksum (`verified`; `skipped` for Git's all-zero `index.skipHash` trailer; `absent` when the worktree has no index file, which Git reads as an empty index), an intent-to-add entry only with the empty blob, the targets of the index's own symlinks held to the same containment rule as a tree's, `headTreeDigest` and `indexDigest`. Split and sparse indexes, merge
  conflicts and submodules are refused. A refusal about an entry is reported after the extensions have been read, so that a split or sparse index is named as such.
- **Working-tree manifest** (`factory-checkpoint-worktree/1`): a `FileSnapshot` per file and symlink, `kind: 'deleted'` for every index path that is absent (its `sha256` is that of the
  blob the index records), the Git blob id of every present file (`blobIds`, which the builder of 20b needs to build the working-tree tree from the export), the exclusions with their
  reasons (`special_file`, `nested_git`, `rebuildable_directory`, `deny_list`; D34, applied to untracked paths only), and `sourceDigest`, the tree digest of what is captured.
  Symlinks are never followed; FIFOs, sockets and devices are never opened.
- **Path rules** (`path-rules.ts`): well-formed UTF-8, at most 4,096 bytes and 256 components, no empty, `.` or `..` component, no NUL, slash or backslash inside a name (D28), no
  component that Git treats as `.git`, by Git's own two independent checks (HFS+: ignorable code points removed and the name is exactly `.git`; NTFS: the name, ASCII case-insensitive, is `.git` or
  `git~1` followed by dots and spaces only, optionally ending at a `:` for an alternate stream), a component longer than 255 bytes (`NAME_MAX`), and no symlink named `.gitmodules`,
  `.gitattributes`, `.gitignore` or `.mailmap` under the same two checks, with Git's `is_ntfs_dot_generic` for the NTFS short names (`~1` to `~4` on the first six characters, and the fall-back form with the fixed prefixes `gi7eba`, `gi7d29`, `gi250a` and `maba30`). Tests compare both with `git update-index --cacheinfo`, which runs `verify_path` (for `.git` and `.gitmodules`), and with `git fsck`, which judges the other three. Leading `-` or `:` and LF or CR in a name are kept: where such a path meets Git it must go through stdin, NUL-separated, with literal pathspecs
  (rule 8; 20b). Ref names are byte strings, and a name with bytes of 0x80 and above must be well-formed UTF-8. `packed-refs` is read as Git reads it: it must end in a newline, a header starts `# pack-refs with:`, every line is `<oid> <name>` or a peel line (anything else is refused), a name that fails the ref-name rules is skipped as Git marks it broken and is never what `HEAD` names, and order is required only when the header says `sorted`.

`src/checkpoint-manifest.ts` holds the types and strict validators of the two manifests and of the portable handoff, the six part names, their caps and the purposes they are linked under.

### Residual risks

- **SHA-1 without collision detection (review, Furio L3).** Node's SHA-1 does not detect the collision attacks that Git's does. The reader's check proves that an object's bytes
  hash to its name, not that no second object with that name was crafted. The second check is Git's own: the builder of 20b loads the export through `git index-pack --strict`, which
  computes every id itself with collision detection, and that step may never be skipped. The pack and index trailers use SHA-1 as well.
- **TOCTOU and a live writer.** The reader walks each directory with `lstat` and opens each file `O_NOFOLLOW` with a device and inode check, which catches a file that is swapped between
  its `lstat` and its `open`. It does not catch a directory component that is swapped after the walk has passed it: Node has no `openat`. The reader is safe only because the `read`
  container runs after the pod has been stopped and proved gone (W-019's proof, which nothing in 20a checks), with the claim mounted read-only, so that nothing writes while it reads.
  Take either away and a candidate could race it.
- **Hard links.** The reader does not check `nlink`: `lstat` and `fstat` see the same inode, so the device check cannot catch a hard link. It cannot be used, as it is: the reader's uid
  (10001) is the harness's, and `link(2)` cannot cross mounts. If the reader's uid ever differs from the harness's, require `nlink === 1` for working-tree files.
- **Case and normalisation collisions** are legal on Linux and are kept; `snapshot().committed.collisions` and the working-tree manifest's `collisions` count the names that differ from
  an earlier name of the same directory only by case (`caseOnly`) or only by normalisation form (`normalization`), and a restore on a host that folds refuses them (`assertNoFoldedCollisions`).
- **Deadlines are checked between objects, files, entries and hash chunks,** not inside a single inflate or a single 32 MiB read. A call holds the process for at most that long. A tree
  and an index tick every few thousand entries; a name is capped at 255 bytes, so no per-name scan is long.
- **Isolation of the reader.** It imports `containment.ts` (UUIDs, the strict symlink rule, the fold), which imports only `errors.ts`; `paths.ts` re-exports them. The reader's closure holds
  no `@factory/database`, no `pg` and no `node:fs` outside `fs-safe.ts`: a test loads the whole import graph and asserts it, and an ESLint allowlist keeps it so. The same block bans `process`, `global`, `globalThis`, `Reflect`, `eval` (also aliased), `Function`, `.constructor`, `['constructor']` and a destructured `constructor`, property descriptors, prototype walks, and template text naming `process` or `constructor`: the doors to `process.getBuiltinModule` and `process.binding` that an import rule cannot see. Furio's four bypass files are lint tests. This is a review aid, not the boundary (see the hand-off to 20b).
- **Not a defence on its own:** `node --permission` follows symlinks out of the allowed tree (probe P1); it is a second line against writes and spawns only.

### Hand-off to 20b

- **Size the `read` container from the memory figure above.** The worst case found is about 486 MiB with the inflate temporaries allowed for, and the node process has its own resident
  size beyond heap and buffers. The 1 GiB limit of 7.4 holds with margin; the 768 MiB request should not go lower, and neither should the limit.
- **The boundary is at runtime, not in the lint.** The reader's lint (an import allowlist, no `process`, `global`, `globalThis`, `Reflect`, `eval`, `Function`, `.constructor`, no property
  descriptors or prototype walks, no template text naming `process` or `constructor`) is a review aid: a determined author can still find a door that a syntactic rule misses, and Furio
  found three rounds of them. What holds is that 20b's `read` entry runs under `node --permission` (read access to the mount and to the code, write access to `/export` only; no child
  process, no worker, no native addon) **and** `--disallow-code-generation-from-strings`, so that `Function`, `eval` and `new Function` fail at runtime whatever the source says.
  Together with the read-only mount and the proved-gone pod, that is the boundary; nothing in 20a starts it.
- The pod must be proved gone and the claim mounted read-only before `read` starts (TOCTOU, above).
- `/export` must be sized for the undeltified closure, up to `maxWorkBytes`, against a bundle part of 256 MiB.

### Not built in 20a

No caller (the child's `read` container and its entry are 20b), no builder (`checkpoint-build.ts`), no `GIT_LITERAL_PATHSPECS=1` in `gitEnvironment()` (7.7 assigns that to 20b), no
finalize route, no restore. SHA-256 repositories, reftable, split and sparse indexes, alternates, grafts, shallow repositories, submodules and version 1 indexes are refusals,
never a fallback to Git (D28).

Tests: `pnpm vitest run packages/workspace/test/w020-` (real Git builds every fixture; Git reads each fixture again as the oracle; every hostile case has its positive control).

## Not built

Git cache, submodules, LFS, shell recipes, experiment worktrees (and any `git worktree remove`),
checkpoint and restore (`not_supported` until W-020's 20b and 20c; the reader of 20a is built, with no caller), and reclaiming a fenced generation directory
(W-024). There is no writer reuse of a volume at all (D19): `volumeDisposition` says what may be done with an old
generation's volume, and a replacement always gets a new claim. The setup profile validates and drives an executor you must supply; no local
executor is exported because setup scripts are candidate code that run only in the sandbox.

## Tests

`pnpm vitest run packages/workspace`. Real PostgreSQL and real Git repositories in temporary
directories. Every "nothing happened" assertion has a positive control in the same setup.
