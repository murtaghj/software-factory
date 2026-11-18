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
  rely on the local `remove`.
- `release` and `replaceWriter` need the row exclusively; the 75 s lock wait fails as
  `publish_in_progress`, whoever holds the lock (a publish or another transition).
- The host checks that a row is materializable before fetching a candidate bundle (up to 512 MiB).
- The setup profile refuses shells, wrappers (`env`, `xargs`, ...) and interpreters given inline
  code (`-c`, `-e`, `--eval=...`, `deno eval`, `pwsh -Command`, versioned names such as `ruby3.3`).
  **That list is advisory only** and is easy to get around (`find -exec`, `awk system()`, `script -c`,
  `flock`, unlisted shells and interpreters). The executor's sandbox is the control.

## Not built

Git cache, submodules, LFS, shell recipes, experiment worktrees (and any `git worktree remove`),
checkpoint and restore (`not_supported` until W-020), volume reuse on proof of quiescence, the
`QuiescenceProof` and quarantine records (W-019), and reclaiming a fenced generation directory
(W-019, W-024). The setup profile validates and drives an executor you must supply; no local
executor is exported because setup scripts are candidate code that run only in the sandbox.

## Tests

`pnpm vitest run packages/workspace`. Real PostgreSQL and real Git repositories in temporary
directories. Every "nothing happened" assertion has a positive control in the same setup.
