# 06 — Runner, Git workspaces and durable checkpoints

## Runner control protocol

Runner operations are internal authenticated RPCs exposed through the typed interface: Runner: startOrAttach, getRun, watchEvents, cancel, getResult; WorkspaceManager: allocateOrAttach, checkpoint, restore, materializeCandidate, release. startOrAttach binds organization/task/stageRunId, inputHash and immutable specHash under an authorized workload identity. Reusing a stageRunId with a different specHash or inputHash MUST return 409 conflict. getRun, watchEvents, cancel and getResult address stageRunId under that stored binding and scoped authorization.

The controller reconciles desired state from Postgres against observed Kubernetes Jobs/Pods and artifact records. It does not infer completion from a Job's exit code alone. Terminal result acceptance requires a verified supervisor envelope matching the active allocation epoch and source/input binding.

## Start-or-attach algorithm

1. Begin a transaction; insert or lock the stage_run row by logical identity. Validate task is still eligible, inputHash matches, budget/capacity reservations exist and no terminal result already exists.
2. If a terminal result exists, return it. If a live accepted allocation exists, return its run handle. If it is suspect, enter reconciliation instead of allocating concurrently.
3. Claim a new allocation generation and owner epoch with compare-and-swap under row lock. Record desired Job identity and a controller lease. Commit before contacting Kubernetes.
4. Create a Job with a deterministic DNS-1123 name of at most 63 characters, for example `factory-` + lowercase base32(sha256(org_id + '|' + logical_id))[:20] + `-g` + generation; apply the same bound to PVC names. Put full IDs in annotations and hash any value that is not label-safe before using it in ownership labels, alongside immutable specHash. On AlreadyExists, fetch it and validate UID/specHash/owner; conflict is an error, not an attach.
5. Record observed Job UID and state with the same epoch. If the controller dies between create and record, the next reconcile locates the labeled Job and finishes the binding.
6. Supervisor authenticates with its allocation capability, acquires the run start permit and renews it. Duplicate Pods from the same Job must contend for a pod-specific writer claim; Job uniqueness alone is insufficient.
7. Only the winning supervisor may launch the harness. A duplicate exits without mounting/reusing the active writable workspace. Admission and volume provisioning must support this order.

Job replacement is controlled by the runner. Set `restartPolicy: Never` and `backoffLimit: 0` initially; the controller allocates a new generation after recovery checks. Kubernetes can still produce duplicate execution situations, so the factory enforces ownership independently. [Kubernetes Jobs](https://kubernetes.io/docs/concepts/workloads/controllers/job/)

## Lease and fencing defaults

Supervisor heartbeat every 10 seconds; suspect after 30 seconds; lease expiry after 60 seconds. Controller reconciliation every 15 seconds with jitter. An epoch increase prevents old remote writes, but cannot magically stop a stale process on an already mounted filesystem.

Before reusing a writable volume, confirm old Pod termination and storage detachment/revocation. If that cannot be proved, allocate a new isolated volume and restore the last acknowledged checkpoint. Deny stale-epoch artifact finalization, Git updates, result publication and tool operations. For providers that cannot enforce a supplied epoch, keep their credentials behind the factory adapter and authorize each call against the current operation/epoch. Never put a reusable publishing credential in the coding pod.

Use one writer per workspace. A human takes ownership through an explicit handoff: pause workflow, stop writer, checkpoint, transfer ownership; returning to automation creates a new epoch. Do not attach a human shell and an active autonomous writer to the same directory.

Interactive takeover is a supported journey built on this handoff: take-over and hand-back are explicit dashboard actions, each with checkpoint and epoch transfer, and returned source re-enters evidence evaluation. See [chapter 23](23-readiness-recipes-campaigns.md).

## Greenfield base creation before worktrees

WorkspaceRecord always requires a real repository and full base commit. The bootstrap controller resolves the accepted BootstrapPlan and stores a BootstrapReceipt before allocating an authoring worktree. A new remote repository is created/reconciled and conditionally initialized from an approved minimal template; a new component in a monorepo uses its pinned existing base and path restrictions. Neither path permits a placeholder commit, broad default-branch writes or repository-creation credentials in an execution pod.

Use an approved bootstrap setup profile for initial scaffolding; the absence of an application-specific recipe is not permission to execute arbitrary setup. Foundation verification accepts the resulting versioned application profiles before later child work. Cancellation retains externally created repositories with owners and reconciles uncertain writes. The detailed procedure and exceptional initialization authority are in [chapter 17](17-project-journeys.md).

## Workspace topology

Reference strategy: one private clone per task/repository/trust boundary, with linked worktrees only within that boundary. Implementation and alternative experiments use distinct task branches. Independent verification/review use separate clones/object stores or protected snapshots. Different tenants never share writable Git metadata, dependency installations or credentials.

```text
task T184 / orders-api / authoring allocation
  private repository and common Git metadata
  implementation worktree -> factory/T184/orders
  experiment-a worktree   -> factory/T184/orders-exp-a

verification allocation
  independent source snapshot -> candidate C
  canonical package mount     -> approved digest, read-only
  build/test scratch          -> disposable, writable
```

Linked worktrees provide separate working directories/indexes/HEADs while sharing Git objects and refs. Retain Git's same-branch safeguard. Worktree lock/prune are maintenance features, not a distributed execution lock. [Git worktree](https://git-scm.com/docs/git-worktree)

Do not mount the user's personal checkout. Resolve repository roots/subpaths from approved registry entries. Reject path traversal, symlinks escaping the allowed root, arbitrary clone URLs and branch names outside the task namespace. The Git adapter owns ref naming and expected-head updates. A local Git cache may accelerate clone; make it read-only to jobs and verify resolved source objects. Do not share an author-writable common Git directory with an independent verifier.

## Setup and execution recipes

A setup profile pins base image digest, runtime/package-manager version, architecture, lockfiles, dependency sources and scripts. Clone at the resolved base commit, materialize submodules/LFS if declared, install dependencies with the approved locked command, and record outputs. Application build scripts execute as untrusted candidate code in the execution sandbox. Repository hooks and repository-local Git configuration (fsmonitor, filter/diff/textconv drivers, hooksPath) MUST NOT execute programs in any trusted or credentialed allocation.

Recipes use executable plus argument arrays, explicit cwd, sanitized environment, time/resource limits and allowed output paths. Shell execution is available only through a declared shell recipe with review; do not interpolate ticket text into commands. Secret references are resolved just in time through scoped access and excluded from checkpoints.

## Checkpoint algorithm

Checkpoint only after a proven quiescent writer: finish the stage or use a qualified cooperative stop, stop new tools, wait for or terminate the full command process tree, then snapshot. A request to pause is not evidence of quiescence. Do not archive while files are still changing.

1. Record workspace/generation/epoch, repository identity, full base/head IDs and setupProfileRef; the referenced immutable setup profile records the tool versions, which MUST match the observed versions before checkpoint acceptance.
2. Preferred: create a local task checkpoint commit containing explicitly selected source changes; persist the reachable objects through a private Git ref or self-contained bundle. Do not blindly `git add -A` across secrets or generated directories.
3. If preserving dirty state, export staged and unstaged binary-capable patches separately, selected untracked files, modes and symlink targets; preserve deletion/rename effects. Record original index state and per-file hashes so restoration can be checked.
4. Keep external state separate: dependency caches can be rebuilt; test data snapshots use their own provider; native session state uses an optional sensitive artifact.
5. Upload and verify all constituent artifacts. A manifest becomes finalized only when every required part is durable and its dependencies are retained.
6. Persist workspace.last_checkpoint and a checkpoint event with compare-and-swap on epoch. Acknowledge to the workflow/harness only after commit.

Git bundles transfer objects/refs and can have prerequisites; they do not save dirty working files, dependencies or runtime state. Use self-contained bundles initially. If optimizing to incremental bundles, verify and retain the complete prerequisite chain. [Git bundle](https://git-scm.com/docs/git-bundle)

Checkpoint frequency: every stage boundary, before harness replacement, role change or delivery, and at a qualified deliberate compaction restart. There is no mandatory five-minute mid-stage snapshot. Mid-stage checkpointing is an optional negotiated capability requiring proven quiescence. After pod loss, replay the bounded stage from its last acknowledged boundary; unacknowledged work may be lost. Native session persistence is a separate optional capability.

Per-task local commits recorded in the structured handoff are checkpoint material and follow existing fencing and publication rules. Whether the Job lifecycle and warm pools are provided by the kubernetes-sigs agent-sandbox substrate is decided in M0 against the exit criteria in [chapter 22](22-reference-practice-adoption.md). Allocation generations, epochs, fencing and result acceptance remain runner-controller responsibilities in either case.

## Restore and freeze

Restore into a new empty allocation: verify every artifact hash; reconstruct Git objects; check out the recorded head; apply staged/unstaged changes and selected untracked files; verify source manifest; rerun declared setup; recreate compatible session files only if the adapter supports them. Do not copy a linked worktree directory alone because its common metadata may be elsewhere.

Freeze candidate: quiesce writer, commit selected source, ensure clean declared source tree, create immutable multi-repository CandidateManifest and export source. The trusted runner/checkpoint step MUST write task, stage-run, behavior-release and applicable recipe trailers from server records when creating commits, before their IDs are frozen; agent-supplied identity is not authoritative. A verifier receives the fixed candidate reference, never a branch to resolve later. Any post-freeze source edit creates a new candidate and invalidates dependent gates.

## Result publication and cancellation

Supervisor writes logs in bounded chunks with monotonic sequence and flushes partial chunks at exit. It records exit reason, elapsed time, last checkpoint, native session reference, proposed output and observed usage. Controller authenticates envelope, epoch and input hash, verifies artifact finalization, then stores the one accepted terminal result. Duplicate identical finalization returns existing result; conflicting finalization is rejected/audited.

Cancel: set desired cancellation, revoke further tool actions, allow up to 30 seconds for a safe checkpoint request, then delete the entire authoring pod with gracePeriodSeconds=15 so the kubelet delivers TERM and then KILL to remaining processes. Checkpointing follows the whole-pod-stop protocol below. Use task-specific limits for long-running cleanup. An interrupted deployment is reconciled by its own operation record. Forced process termination is reported honestly even if the last model text said “done”.

## Integration and concurrent work

Each parallel author receives a separate branch/workspace. Their outputs are candidate commits, not shared mutable files. The integration stage records exactly which commits it combined; conflicts return to a controlled implementation/integration workspace. Run combined checks even when Git merges cleanly.

One active publisher per task/repository; compare expected head before updating refs. One integration lease per target branch/release lane, or delegate to a provider merge queue with equivalent tested semantics. A new target base produces a new integration binding. Source patch equivalence after squash/rebase must be established and recorded; otherwise rerun required evidence against the actual release candidate.

## Cleanup

Desired states: allocated, active, quiescing, checkpointed, retained, releasing, released, quarantined. Release only after no active writer, accepted checkpoint/output and retention check. Use Git worktree remove for managed linked worktrees, then reconcile/prune stale metadata. Volume deletion requires ownership labels and the expected allocation UID; never delete by a broad task-name prefix alone.

If release cannot prove ownership or deletion, it MUST leave the record releasing or quarantined and return needsOperator=true with an operator obligation; needs_operator is not a workspace state.

Sweep every 5 minutes for expired workspaces, orphaned Jobs, failed volume deletion and unfinalized checkpoints. Record cleanup attempts and errors. Remote refs/PR branches have independent retention; deleting an execution volume must not remove the only source copy. Quarantine suspected tampering and preserve restricted evidence for the configured incident window.

## Harness/supervisor pod boundary

Use separate harness and supervisor containers with no shared process namespace. The baseline topology uses an allocation-owned retained PVC for source; emptyDir is allowed only for disposable scratch. Only the harness executes repository/candidate code. The supervisor serves the versioned factory MCP tools over an authenticated local endpoint; a dedicated credential-free check-runner may be added if the adapter cannot safely dispatch feedback checks in the harness container. Never execute build/test recipes in the credentialed supervisor. Shared workspace content, symlinks, archives, IPC and output all remain untrusted; use bounded parsing and path-safe operations with no shell interpolation.

Mount the projected short-lived factory identity only in the supervisor, never the harness/check-runner or shared volume; give it allocation-specific permissions and audience. Each container has private tmp/config directories and hardened security context. NetworkPolicy applies to the pod, not individual containers, so network reachability does not distinguish their authority. Control-plane/artifact services must authenticate the supervisor's credential and validate task/epoch/input scope. Local factory-tool access grants only its narrow role actions and never arbitrary control-plane forwarding. Keep the existing stronger runtime/node-isolation requirement for hostile multi-tenant workloads.

At a required checkpoint/finalisation boundary, the supervisor first durably records the request and last log chunks with the control plane. The runner persists expected shutdown/finalisation intent, stops the entire authoring pod, confirms runtime termination and storage detachment, then mounts the retained PVC read-only in a trusted checkpoint allocation. Here, trusted checkpoint allocation means a `checkpoint_job` child of the finalizing authoring allocation, not a new execution_allocation generation. The child MUST use the parent generation and owner_epoch; admission and every result acceptance lock/check the parent and reject a stale or non-finalizing binding. The child snapshots/hashes source without running repository scripts, finalizes artifacts and conditionally accepts the result under the still-owned epoch/input binding. Its snapshot exports selected Git objects and dirty files; it need not commit into the read-only source tree. Only the runner can issue the checkpoint allocation's scoped identity. StageFinalizer.finalize MUST authorize only that checkpoint identity and reject authoring-pod supervisor and harness identities. The allocation remains finalizing with its claim reserved; expected authoring-pod termination is neither stage failure nor completed success. Finalizer retries use the same receipt and immutable input, and expired authority must be revalidated before result acceptance. If old termination cannot be proved, quarantine that volume and recover from the last acknowledged checkpoint on a new one. Cancellation revokes result publication and permits only scoped checkpoint/cleanup recording.

The trusted checkpoint allocation MUST treat candidate `.git` metadata as untrusted data. It MUST read objects, index and refs through a bounded, path-safe library reader with filters and all config-driven program execution disabled; repository-local `.git/config`, hooks, fsmonitor, `.gitattributes`, `info/attributes`, external diff and textconv drivers MUST NOT be honoured. Dirty files are hashed as raw bytes. Any commit or bundle construction uses a separate factory-owned object store/configuration, never candidate-controlled Git configuration. AC-230 qualifies malicious config, filter and hook fixtures; this isolation is not yet proven.

A same-pod checkpoint is an optional optimization requiring an independently enforced and tested whole-writer stop; a sidecar receipt or harness self-report is insufficient. No process namespace sharing, privileged runtime socket or Kubernetes credential is added to candidate containers to make stop convenient. The two-container example is topology only: retained PVC creation/ownership, local control transport, gateway credential issuance and NetworkPolicy are implementation-profile obligations.

The runner controller mints the short-lived model-gateway credential from the ProviderEligibilityBinding recorded at admission and pinned in InputBinding/allocation. Its model scope contains only eligible profiles for that effective data classification; the external gateway enforces the scope and current policy on every request. The harness holds only this credential scoped to its allocation, models and budgets, never a provider master key. Deny direct provider egress. A gateway-compatible base URL, authentication, tool transport, streaming, usage and cancellation must pass the M0 Claude spike; unsupported routing keeps the profile disabled. Interactive prompts are disabled. A harness-internal sandbox may be disabled only in the qualified isolated profile when compatibility requires it; the spec does not assume that every harness supports identical flags or that Restricted Pod Security alone proves isolation.

Factory tool grants and remote side effects are checked per call against the current epoch. Native shell/file activity is bounded by OS/container/filesystem/network policy and process termination; hooks provide extra guardrails and telemetry, not a security boundary. A stale process may continue consuming local resources until killed but cannot finalize results, use revoked factory tools or publish/deploy.
