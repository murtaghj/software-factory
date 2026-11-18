# M2 plan: isolated execution

Revision 3, 2026-11-18. Written against spec rev 1.13. Planning only; no source changed.
Revision 2 answered the adversarial review of revision 1; revision 3 reworks the W-018 brief after its own second review. Section 6 lists what changed and what was not taken as written.

Code references are to the working tree after the worker split (P-18, P-19, P-20: done, about to be
committed on top of `b63a1a6`). The newest patch marker is `authority-v1`
(`apps/worker/src/workflows/config.ts:22`); M2's first marker, `runner-v1`, follows it.

M2 in the backlog (`docs/spec/14-build-backlog.md:15`): "Runner, workspaces, boundary checkpoints,
verifier, factory tools and minimum admission. Exit: lost-pod, stale-writer and canonical-test
integrity acceptance."

## Summary

- M2 is **18 packages**, 61–95 backlog engineering-days (`backlog.json`, milestone M2): W-017 to W-025, W-075, W-088, W-089, W-090, W-098, W-115, W-116, W-119, W-134.
- **Start with W-018.** It is the only M2 package whose dependencies are all built. Its brief (section 4) needs no owner answer, no migration and no new dependency.
- **Runtime:** build the controller against a small `KubeApi` port. Test it in two tiers: an in-memory fake with fault injection in the default suite, and a real single-node k3s cluster run as a container in the podman machine, opt-in. A real-cluster run of the same suite comes later.
- **The podman machine on this Mac is rootful, not rootless.** k3s works there (tested twice today). It does not work on the rootless connection.
- The three exit scenarios can be shown after the first eight packages (30–45 backlog days). That point is an **exit-evidence checkpoint**, not the M2 exit: M2 ends after package 18, with the real-cluster qualification (D4) listed as open.

## 1. Packages in build order

Dependencies marked ✓ are built. "Tier" says where each acceptance criterion can be shown on this
machine: **F** = fake tier (default suite), **K** = local k3s tier, **R** = needs the real cluster
before it can be claimed. Estimates are the backlog's engineering-day range; "size" is my judgement
of relative effort for this crew (S, M, L) and is not from the spec. The order was re-checked
against `backlog.json`: every dependency is built, assumed under D2, or earlier in the list.

| # | Package | Delivers here | Depends on | Acceptance (tier) | Days · size |
| --- | --- | --- | --- | --- | --- |
| 1 | **W-018** Workspace manager and Git materialization | New `packages/workspace`: a `WorkspaceManager` for rows, epochs and fencing; a `GitMaterializer` port with a local executor; a publisher that updates task refs from a factory-owned repository; setup profile; independent source for verifiers. Brief in section 4. | W-006 ✓, W-007 ✓ | AC-12 (fencing half), AC-22 (source half), AC-38 (local ref half): F, real Git | 4–6 · L |
| 2 | **W-017** Kubernetes controller and Job protocol | New `apps/runner`: `Runner.startOrAttach/getRun/cancel/getResult`, desired/observed reconcile, deterministic Job names, versioned allocations, and the **runner side of the start permit and pod-specific writer claim** (as the backlog deliverable says). The `KubeApi` port, its fake and the k3s tier (section 2). The pod executor for `GitMaterializer`. A capacity stand-in until W-088 (A-30). First named fault points. | W-006 ✓, W-011 ✓; W-005, W-077, W-097 by assumption (D2) | AC-10 (one allocation, one permit winner at the runner API), AC-11: F and K | 4–6 · L, likely at the top |
| 3 | **W-019** Lease fencing and process supervision | New `apps/supervisor`: the supervisor that takes and renews the permit, heartbeat 10 s / suspect 30 s / expiry 60 s judged on the **Postgres clock**, stale-epoch rejection, process-tree stop, the `QuiescenceProof` record (runner-issued: pod UID, terminal state of every container, detachment observation; accepted only from the runner identity), volume reuse on that proof, the quarantine record for a replaced generation (all three left out of W-018), the network start gate (D11). | W-017, W-018 | AC-10 (a real duplicate supervisor exits without touching the workspace), AC-12 (quarantine half): F. AC-15: F for the protocol only; **tree stop is claimed at K only** | 4–6 · L |
| 4 | **W-020** Durable checkpoints and restore | In `packages/workspace`: committed and dirty-state manifests, self-contained bundles, finalization, restore into a clean allocation; `checkpoint_job` child rows and their fencing (SI-12). **Starts with the untrusted-Git reader** (below). | W-007 ✓, W-018, W-019 | AC-13, AC-14, AC-16: F, real Git | 4–6, plus 3–5 for the reader · L |
| 5 | **W-023** Runner Activity attachment and cancellation | In `apps/worker`: `startOrAttachExecution`, `awaitExecution`, `cancelExecution` Activities; typed infrastructure versus semantic outcomes; cleanup on every non-semantic path; the new cleanup rule for `outcome_recorded`. Behind `patched('runner-v1')`. Design constraints in section 5. | W-019, W-020, W-011 ✓ | AC-10, AC-14, AC-15: F with Temporal | 3–5 · L |
| 6 | **W-024** Workspace and resource sweeper | UID-scoped cleanup, retention, orphan reconcile, failed cleanup left visible as an operator obligation. Moved ahead of the checkpoint: it is the only cleanup that survives a failed or terminated workflow. Never force-deletes. | W-019, W-020 | AC-43: F and K | 3–4 · S |
| 7 | **W-021** Capability proxy and execution profiles | Extend the W-008 proxy into the runner: scoped grants, per-role identities, denied-operation audit, **durable call counters** (today they are an in-memory map, `apps/api/src/auth/capability-proxy.ts:47`, so a restart resets every limit); namespace, NetworkPolicy and admission manifests. | W-008 ✓, W-019 | AC-19: F. AC-56: K gives partial evidence, **R to claim** | 4–6 · M |
| 8 | **W-022** Canonical verifier supervisor | New `apps/verifier`: exact source and package execution, externally collected results, counts and integrity checks, trusted finalization. Uses the W-004 fixture releases. | W-012 ✓, W-018, W-021; W-097 by assumption | AC-21, AC-22, AC-23, AC-24: F | 4–6 · M |
| | **Exit-evidence checkpoint** | Independent review, full check, and the three exit scenarios run end to end and **end cleanly** (no live allocation, outcome recorded): lost pod (AC-10, AC-13, AC-14), stale writer (AC-12), canonical-test integrity (AC-22, AC-23). Not the M2 exit. | | | |
| 9 | **W-088** Minimum execution admission | `CapacityManager` over the existing `capacity_reservation` table; visible waits; replaces the A-30 stand-in. Absorbs plan addition P-11, including its 429 quota response and per-application limits, which AC-128 does not cover. Workflow wait behind `patched('admission-v1')`. | W-013 ✓, W-019 | AC-128: F. Child limits are tested on task trees seeded directly, because intake refuses child tasks (`apps/api/src/tasks/service.ts:55`) | 3–5 · M |
| 10 | **W-116** Candidate secret scanning | Deterministic scan of candidate diffs before checkpoint publication, push and delivery; redacted findings. | W-020, W-022 | AC-184: F | 2–3 · S |
| 11 | **W-025** Context builder and role prompts | New `packages/context`: token allocation, fact selection, role context manifests, fresh/resume policy. | W-007 ✓, W-012 ✓, W-021 | AC-18, AC-57: F | 3–5 · M |
| 12 | **W-089** Standards resolution and scoped exceptions | In `packages/policy` and a new minimal `packages/registry`. Chapter 21 says M2 needs only "the minimal trusted importer/resolver" and no new table (`21-rules-role-content-skills.md:39`). | W-007 ✓, W-012 ✓, W-021 | AC-130, AC-131, AC-132, AC-141: F | 4–6 · M |
| 13 | **W-090** Role compiler and third-party admission | Canonical role artifacts, compiler profiles, pinned content inventory, admission and revocation, synthetic delivery fixtures. No model call. | W-025, W-021, W-089 | AC-133, AC-134, AC-135, AC-139: F | 4–6 · M |
| 14 | **W-075** Factory tool server and durable proposals | In `apps/supervisor`: tools 1.0 and negotiated 1.1, server-derived authority, receipts, quiesced finalization. | W-019, W-020, W-021, W-022, W-025, W-090 | AC-95 to AC-99, AC-136, AC-137, AC-142: F. AC-100: K for token placement, the Claude half waits for W-077 | 5–8 · L |
| 15 | **W-134** Runner trust-boundary conformance | New `tests/isolation`: hostile Git metadata at checkpoint, finalizer authority, input binding, Job ownership metadata, 15-second termination, extra admission. | W-020, W-021, W-024, W-075 | AC-230, AC-231, AC-232: F. AC-233: K. AC-236: K partial, **R to claim** | 2–4 · M |
| 16 | **W-098** Registry sources and Git descriptors | Import-time snapshots with per-field provenance, authority map, conflict findings. | W-006 ✓, W-007 ✓, W-089 | AC-156, AC-157: F | 3–5 · S |
| 17 | **W-115** Data classification and provider eligibility | Classification on descriptors and stage input, eligibility pinned in the allocation, runner-minted scoped credential. The gateway is external (INT-08), so tests use a fake gateway that enforces the scope. | W-098, W-021 | AC-182, AC-183, AC-247: F | 3–5 · M |
| 18 | **W-119** Organization-wide emergency stop | Operator control halting admission, publication and delivery; human clearing; dashboard control. Workflow check behind `patched('emergency-stop-v1')`. | W-088, W-021, W-023 | AC-188, AC-217: F | 2–3 · M |

Notes on the list:

- **Untrusted-Git reader (inside W-020, built first).** `06-runner-workspaces.md:114` and AC-230 require the trusted checkpoint step to read candidate objects, index and refs "through a bounded, path-safe library reader" that honours no repository configuration. Nothing like it exists in the repository. Default: a read-only reader written here on `node:zlib` (loose objects, packfiles with deltas, loose and packed refs, index versions 2 to 4), with byte, object-count and delta-depth limits, and hostile fixtures. It adds 3–5 days that the backlog estimate for W-020 does not include. The alternative needs an owner call (D10).
- **Capacity stand-in (A-30, in W-017).** Start-or-attach must see a capacity reservation (`06-runner-workspaces.md:11`), and W-088 comes later. Until then W-017 inserts a `capacity_reservation` row in the start transaction against one pool per organization with the chapter 11 default limits (10 authoring, 10 verifier; `11-platform-operations.md:43`). Over the limit is a typed `capacity_unavailable` with no queue. W-088 replaces the pool logic and adds waits.
- New modules follow `01-scope-architecture.md:84-99`. Each needs an entry in `tools/boundaries.json`.
- W-079 (crash-injection framework, M1) is not built, and the exit scenarios are fault scenarios. W-017 adds named fault points to `packages/test-support`; later packages extend them. AC-103 is not claimed.
- Plan additions: P-18, P-19 and P-20 are done. **P-17** (wire the release-approval check to a real caller) has no caller in M2; it belongs with W-052 (qualified production delivery, M7, AC-44) and stays open until then.
- M2 does not depend on the Git provider. W-018 and W-020 use local bare repositories, which is INT-02's stated interim position (`15-decisions-sources.md:51`). The provider is still "not decided yet" (`docs/plan-additions.md:97`) and is the platform owner's call; where this repository is hosted does not settle it.

## 2. The runtime question

### What I tested on this machine (2026-11-18, two sessions)

- The podman machine is **rootful**: `podman machine inspect` reports `Rootful=true` and the default connection is `podman-machine-default-root`. The compose Postgres and Temporal already run there. The Mac user has no sudo, and none is needed.
- Host: 6 cores, **8 GB RAM**. The podman machine is configured for 4 vCPU and 8 GiB. No kind, k3d, kubectl, helm, docker or Go is installed.
- **k3s as a plain container works on the rootful connection.** `rancher/k3s:v1.36.6-k3s1` (250 MB, digest `sha256:6d654de9…46b85`), run with `--privileged --cpus 2 --memory 1800m`, traefik, servicelb and metrics-server disabled. Nothing was installed on the Mac; containers and images were removed afterwards.
- **The same container fails on the rootless connection**: `level=fatal msg="Error: failed to find cpuset cgroup (v2)"`. The machine delegates `cpu io memory pids` to the user session and not `cpuset`.

| Check | Result |
| --- | --- |
| Node Ready | 9 s after start; 408 MB with one pod, 545 MB with about 15 |
| Job shaped like `examples/kubernetes-job.json` (two containers, Restricted pod security, read-only root, projected token, retained PVC) | Ran |
| Second create of the same Job name | `AlreadyExists`, HTTP 409 |
| Over-long Job name | Rejected at 63 bytes, as `06-runner-workspaces.md:14` assumes |
| Pod that breaks Restricted pod security | Rejected |
| `ValidatingAdmissionPolicy` requiring limits and read-only root | Rejected the pod that lacked limits |
| Projected identity token | In the supervisor container (1,222 bytes), absent from the harness container |
| Pod delete with 15 s grace against processes that ignore TERM (kubectl) | Pod gone after 15.6 s, no surviving processes |
| Job after its pod was deleted (`backoffLimit: 0`) | `Failed/BackoffLimitExceeded`, no replacement pod |
| PVC delete with a wrong UID precondition (raw API) | HTTP 409, reason `Conflict` |
| **Raw `DELETE` of a Job with no `propagationPolicy`** | HTTP 200, Job gone, **its pod still Running 8 s later with no owner reference** |
| **Force delete of a pod (grace 0)** | Pod object gone at once; **its processes were still on the node**, and gone 6 s later |
| **Storage class `local-path`** | `WaitForFirstConsumer`: a PVC with no pod stayed `Pending` |
| **`ReadWriteOncePod` on `local-path`** | Accepted; a second pod on a claim in use stayed `Pending` ("already in-use by another pod"). With `ReadWriteOnce`, two pods on the node both ran |
| **Delete of a PVC a running pod uses** | Stays, with a deletion timestamp and the `pvc-protection` finalizer |
| **Pod created right after its namespace** | Refused: `serviceaccount "default" not found` |
| **Locally built image** | `podman save` piped to `ctr -n k8s.io images import` took 0.3 s; a pod ran it with `imagePullPolicy: Never` |
| **Default-deny NetworkPolicy at pod start** | Policy in place 20 s before the pods. **10 of 10 pods reached the API server with their first request**; the same 10 were refused 12 s later. A control pod with no policy reached it both times |
| API from the Mac host | Works on `127.0.0.1:<port>` with the node's client certificate |

Not tested: kind, k3d, an envtest-style API server, a Node-sized image, validating the projected token's audience, more than one node, the timing between Job `Failed` and container exit, a PVC with an owner reference.

### Options

| Option | For | Against |
| --- | --- | --- |
| **k3s container in the podman machine** | Tested and working. No host binary. Real scheduler, kubelet, Job controller, PVCs, admission and NetworkPolicy. Small. | Needs `--privileged` inside the VM. Single node. Rootless does not work as the machine stands. |
| kind on podman | Common in CI elsewhere. | Untested here. Needs a binary and a much larger node image. Its rootless mode needs the `cpuset` delegation that is missing. |
| k3d | Wraps the same k3s image. | Untested here. Needs a binary and a Docker-compatible socket. The wrapper is not needed. |
| envtest-style (API server and etcd only) | Native, light, real API validation. | No Job controller and no kubelet, so no pod ever runs. |
| In-memory fake of the API | Deterministic fault timing, zero load, runs in every PR. | Only as honest as its conformance checks. |

### Recommendation

Use **two tiers behind one port**, and keep a third for later. This matches the spec's own test
rule, "deterministic fake providers for fault timing … Kubernetes for allocation/isolation
recovery" (`13-testing-release.md:5`), and INT-05's interim position, "Local cluster and manifests
parameterization" (`15-decisions-sources.md:54`).

1. **`KubeApi` port** in `apps/runner`: only the calls the controller uses. Implemented by a thin HTTPS client written here. It supports client-certificate and bearer-token authentication only; exec credential plugins are not supported, so a run against the organization's cluster uses a service-account token.
2. **Fake tier (default suite).** `FakeKube` implements the port in memory with fault controls: die between create and record (`06-runner-workspaces.md:15`), `AlreadyExists` with a foreign UID, a duplicate pod for one Job, a lost pod, a delayed delete. An optional fake kubelet starts the real supervisor as a local process. It models pod termination as the kubelet does it: TERM to every container at once, the pod visible as Terminating until all have exited. Postgres only; no Temporal server except in W-023.
3. **k3s tier (opt-in, `pnpm test:k8s`).** `scripts/k3s.sh up|down` starts the pinned k3s container and loads the test images. Cluster tests are named `*.k8s.test.ts`. The default `vitest.config.ts` includes `tests/**/*.test.ts`, so it gains an explicit `exclude` for that suffix, and a separate `vitest.k8s.config.ts` includes them with one worker. `tests/isolation` holds both kinds; only its `*.k8s.test.ts` files need the cluster.
4. **Real-cluster qualification (later).** The k3s tier takes its cluster from parameters, so the same suite runs against the organization's cluster when INT-05 is closed.

### Conformance list

One suite runs these against `FakeKube` and against k3s. The fake must model each one.

| Behaviour | What the controller does about it |
| --- | --- |
| Raw Job delete orphans its pods by default (verified) | Every Job delete sends `propagationPolicy: Background` and then confirms pod termination itself. |
| Force delete removes the pod object while processes still run (verified) | No code path uses grace 0: not the controller, not the sweeper, not test helpers. A lint rule on the client forbids it. "Pod not found" counts as quiescence only on that condition. |
| Job `Failed` and container exit are set by different controllers | Quiescence is read from pod and container status, never from Job conditions. |
| Two pods on one node both mount a `ReadWriteOnce` claim (verified) | Workspace claims use `ReadWriteOncePod`, so a duplicate pod cannot mount before any supervisor runs (`06-runner-workspaces.md:17`). The writer claim in Postgres stays the authority. |
| `WaitForFirstConsumer`: the claim stays `Pending` until a pod is scheduled (verified) | Create the claim, then the Job. Never wait for `Bound` first. |
| Retained claim lifetime | The claim has no owner reference to the Job, or garbage collection would remove it before the checkpoint child mounts it. A deleted claim in use stays Terminating (verified). |
| Two kinds of 409 (verified) | Branch on `reason`: `AlreadyExists` leads to fetch and validate UID, specHash and owner; `Conflict` on a UID precondition means the object is not ours. A 404 on a precondition delete means it is already gone. |
| A new namespace has no service account for a moment (verified) | Namespaces and service accounts are static manifests applied ahead of time; the controller never creates them at run time. |
| Name and label limits; label selection; UID preconditions | As in the first probe. |

### What stays unproven until a real cluster

- AC-56 as written ("enforced on the real cluster"): CNI enforcement, metadata-endpoint denial, cross-task reachability. The start-up window above (SI-15) makes this more than a formality.
- AC-236 as a qualification. The mechanism is shown; the installed policy on the target cluster is not.
- Storage detachment or revocation before volume reuse (`06-runner-workspaces.md:25`). `local-path` is a host directory.
- Duplicate pods from node loss or partition. Only the fake injects them.
- Sandboxed runtimes, node isolation, the agent-sandbox option (ADR-21); workload identity against the organization's issuer; amd64 images; capacity at the chapter 11 limits.
- Process-tree stop on Linux is shown at K. The fake kubelet on macOS proves the protocol only; a child that starts its own session escapes a process group.
- Anything about the Claude harness in a restricted pod (W-077).

## 3. Owner decisions

The crew proceeds on the default unless told otherwise. None of these blocks W-018.

| # | Decision | Recommended default |
| --- | --- | --- |
| D1 | First package. | **W-018**, then W-017. |
| D2 | W-017 depends on W-005 (architecture and access review), W-077 (Claude restricted-pod spike) and W-097 (commodity adoption spikes, ADR-21). None is built and all need organization facts. W-022 also depends on W-097. | Local defaults in `docs/assumptions.md`, closing no register entry. A-24 is taken by P-18, so: **A-25** (stands in for W-005 and INT-05: one local execution namespace, the chapter 06 pod topology and the chapter 09 identity split as written). **A-26** (stands in for W-097: no adoption, because "a rejected or undecided candidate leaves the existing specification in force", `22-reference-practice-adoption.md:91`). **A-27** (stands in for W-077 and INT-08: a deterministic scripted harness; no Claude, no gateway, no model call). W-077 must still run before W-035 in M3. |
| D3 | Local cluster for the k3s tier: a privileged container in the rootful podman machine. | Accept; record as **A-28** (INT-05 stand-in). |
| D4 | Which real cluster qualifies M2, and when. INT-05 expects "M2 qualification". | Not blocking the build. Build-log lines for W-021 and W-134 say "local tier only" for AC-56 and AC-236. M2 is not reported as exited while D4 is open. |
| D5 | Withdrawn. Revision 1 proposed recording the Git provider as decided; that is the platform owner's call and M2 does not need it. | None needed. |
| D6 | Scope of M2. Packages 9 to 18 are not part of the exit scenarios. | Keep all 18, in the order above, with the exit-evidence checkpoint after package 8. |
| D7 | P-11 (admission control) overlaps W-088. | Fold P-11 into W-088, keeping its 429 response and per-application limits in the W-088 brief. |
| D8 | Packaging of cluster manifests; helm is not installed. | Plain manifests under `deploy/k8s`. The Job is built by typed code. Package as a chart when a real cluster is chosen. |
| D9 | When the default template for a work type moves from the fake runner to the real one. | Not in M2. The default stays the fake template; a runner template is selected only by explicit override in tests and local runs. The default moves with the first real workflow template in M3 (W-029), by owner decision. |
| D10 | The untrusted-Git reader for W-020. | Write it here (3–5 days, no dependency). The alternative is the `isomorphic-git` package: version 1.44.17 has 10 runtime dependencies including an HTTP client, is 5 MB unpacked, and its latest release is hours old. It is a full client where a bounded reader is wanted. |
| D11 | Network policy is not in force when a pod starts (SI-15). This is a security call. | The supervisor withholds the harness start signal until a request to a denied address fails, and records the wait. Treat that as a mitigation only: it shows one rule is active, not all. Raise it with whoever owns INT-05; the real CNI must be measured the same way. |

## 4. First package brief: W-018 Workspace manager and Git materialization

Revised after a second review of this brief (round 2). Every choice below is made; nothing waits on
the owner.

**Goal.** Give each stage a private, reproducible Git workspace, fence stale writers in the
database, and give verifiers an independent copy of a fixed candidate. No Kubernetes, no Temporal,
no workflow change, no migration, no new dependency.

**Spec to read.** `06-runner-workspaces.md:11-17` (start-or-attach order), `:23-25` (leases, volume
reuse, epoch checks), `:37-55` (topology and path rules), `:57-61` (setup profiles; no
repository-local configuration may run a program in a trusted allocation), `:74` (self-contained
bundles), `:76` (unacknowledged work may be lost), `:84` (freeze), `:98-104` (states and cleanup),
`:114`; `09-verification-security.md:12`, `:71` and `:77`; `contracts/interfaces.ts:88-99`;
`WorkspaceRecord`, `CandidateManifest`, `RepositoryCandidate`, `FileSnapshot`, `Recipe`, `GitOid`
and `Digest` in `domain.schema.json`; the `workspace` table in `0003_tasks_execution.sql:157-171`,
`artifact_link` at `:232-243`, and the grants in `0010_roles_ownership_grants.sql:81-83` and `:96`.

### Four parts, and where each runs

In M2 a workspace is a retained volume in a pod. Pods cannot reach the database
(`09-verification-security.md:77`), and the runner, which owns the workspace manager
(`01-scope-architecture.md:84`), cannot write to a pod's volume. The runner also commits its
allocation before the Job exists (`06-runner-workspaces.md:13-14`), so it cannot wait for a clone
that happens inside that Job. The package is therefore split, and materialization has two phases.

| Part | Runs in | Touches |
| --- | --- | --- |
| `WorkspaceManager` | The runner process | Postgres only: rows, generations, epochs, state, fencing, accepted receipts. Never a filesystem. |
| `GitMaterializer` (a port) | Wherever the storage is. W-018 ships `LocalMaterializer` on a host directory. W-017 adds a pod executor: a trusted first step of the allocation Job, on the empty volume, before any candidate code exists there. | One generation directory that does not exist yet. No database. |
| `LocalWorkspaceHost` | Tests, local runs and the fake tier | Joins the two for the local case: takes the row lock, runs `LocalMaterializer`, hands the receipt to the manager. W-017's controller plays this part for pods. |
| Publisher (`compareAndUpdateRef`) | The control plane, where the Git credential lives | A row lock in Postgres and a factory-owned staging repository. Never a workspace. |
| Sandbox operations | The harness container; **not built in W-018** | Experiment worktrees, `git worktree remove`, setup recipes. Trusted code never performs these. |

**The Git rule.** Trusted code runs Git only on a repository that the factory created and that no
candidate process has ever been able to write. That means two places: a generation directory whose
row is `allocated`, and a staging repository built from an artifact. `allocated` always means "no
writer has ever started on the current generation"; every operation below keeps that true. Once a
writer has started, trusted code may do exactly one thing to that directory: delete it whole, by
its exact path, without Git and without following symlinks. Reading candidate state after that
point is the job of the W-020 reader. A denylist of `-c` options cannot do this job, because filter
and diff drivers have names chosen by the repository.

### Files

| File | Content |
| --- | --- |
| `packages/workspace/package.json`, `README.md` | Package `@factory/workspace`. |
| Entry in `tools/boundaries.json` | `allowWorkspace`: contracts, domain, database, artifacts, test-support. `denyExternal`: `["@temporalio/", "fastify"]`, the same as `@factory/database` and `@factory/artifacts`. |
| `src/git.ts` | The only place Git is run. `execFile` with argument arrays. The environment is **built from nothing**: a fixed `PATH`, an empty `HOME`, no system or global config, no prompt, and no inherited variable of any kind. Hooks path and fsmonitor off, object checks on, the `ext` transport off, a time limit on every call. It takes a `FactoryOwnedRepo` handle that only the materializer and publisher can create. Minimum Git **2.48** (relative worktree paths); the observed version is recorded. |
| `src/materializer.ts` | The `GitMaterializer` port and `LocalMaterializer`. |
| `src/local-host.ts` | `LocalWorkspaceHost`. |
| `src/tree-digest.ts` | The `treeDigest` algorithm (SI-16) and its committed test vector. |
| `src/paths.ts` | Resolve the clone URL and subpath from the `repository` and `application_repository` rows only. Reject caller-supplied URLs, `..` traversal, tracked symlinks that leave the root, and a workspace root inside any existing checkout. |
| `src/branch.ts` | Task branch names `factory/{taskId}/{name}`; anything else is refused. |
| `src/setup-profile.ts` | A local `SetupProfile` document (SI-10): base image digest, runtime and package-manager versions, architecture, lockfiles, dependency sources, and a list of the contract's own `Recipe` objects. Validation, and `runSetup(profile, executor)` where the executor is a required argument. **No local executor is exported**; setup scripts are candidate code and run only in the sandbox (`06-runner-workspaces.md:59`, `:108`). A profile that declares submodules, LFS or a shell recipe fails closed with `unsupported_setup_feature`. |
| `src/manager.ts` | `createWorkspaceManager({ db, artifacts, runnerIdentity })` implementing the reference `WorkspaceManager`, plus the methods below. |
| `src/publish.ts` | `compareAndUpdateRef`. |
| `packages/database/src/workspace.ts` | Row operations: insert, lock, compare-and-swap on `generation` and `owner_epoch`, guarded state transitions. Existing runtime grants only. |

### Row states in W-018

| Operation | From | To | Directory |
| --- | --- | --- | --- |
| `allocateOrAttach` (first call) | no row | `allocated`, generation 1, epoch 1 | None yet. |
| `acceptMaterialization` | `allocated` | `allocated`, receipt recorded | `g<generation>` exists, factory-written. |
| `markWriterStarted` | `allocated` with an accepted receipt | `active`, `owner_pod_uid` set | From here the directory is candidate-writable. |
| `replaceWriter` | `allocated`, `active`, `quiescing`, `checkpointed`, `retained` | `allocated`, generation n+1, epoch n+1, `owner_pod_uid` cleared | `g<n+1>` does not exist yet. `g<n>` is left exactly as it was. |
| `release` | `allocated`, `checkpointed`, `retained`, `releasing` | `releasing`, then `released` or `quarantined` | Current generation and its staging path removed. |

`quiescing`, `checkpointed` and `retained` are entered by W-019 and W-020; tests reach them through
the guarded transition in `packages/database/src/workspace.ts`.

### Interfaces

`WorkspaceManager` (Postgres only):

- `allocateOrAttach(ctx, id, spec)`. One transaction: insert the row if absent, lock it, compare the stored fields with the request. Any difference is a typed `conflict` and changes nothing. Returns the record. It does no filesystem work and does not wait for a clone.
- `materializationRequest(ctx, id, expectedEpoch)`. Returns what a materializer needs, built from the row and the registry: target (`orgId`, `workspaceId`, `generation`), clone URL, commit, branch; or, for a candidate copy, the source bundle, commit and expected `treeDigest`. It answers only while the row is `allocated` with no accepted receipt for the current generation. If the row has a `checkpoint_ref` it returns `restore_unavailable` until W-020, so lost work is never papered over with a fresh clone.
- `acceptMaterialization(ctx, id, expectedEpoch, receipt)`. Caller must be the runner service identity. Under the row lock: state `allocated`, generation and epoch match the receipt, `headCommit` equals the commit that the current materialization request names. Stores the receipt as a controller artifact linked to the task with purpose `workspace_materialization/<workspaceId>/g<generation>` (`artifact_link` is the only place for it; the row has no column). The same receipt again is a no-op; a different receipt for the same generation is a `conflict`.
- `markWriterStarted(ctx, id, expectedEpoch, podUid)`. Runner identity only. The one transition that ends `allocated`. W-017 calls it when it grants a start permit.
- `replaceWriter(ctx, id, expectedEpoch)`. **There is no `reuse` outcome in W-018.** Takes the row `FOR UPDATE` (lock timeout 75 s, then a retryable `publish_in_progress`) and applies the table row above. The fence is committed whatever follows. Returns `next: 'materialize'` when `checkpoint_ref` is null: the new generation is cloned from the base commit, and unacknowledged work is lost, as `06-runner-workspaces.md:76` allows. Returns `next: 'restore_required'` when `checkpoint_ref` is set. It never reads, renames, reuses or deletes `g<n>`. Reusing a volume on proof of quiescence, the `QuiescenceProof` record and the quarantine record all belong to W-019, which issues the first proof.
- `materializeCandidate(ctx, candidateRef, role, binding?)`. See below.
- `release(ctx, id, expectedEpoch)`. Refused with `writer_active` while the row is `active` or `quiescing` (`06-runner-workspaces.md:100`). Otherwise: lock, check epoch, set `releasing`, commit; ask the materializer to remove the current generation directory and its staging path; then `released` only if both are proved absent, else `releasing` or `quarantined` with `needsOperator: true` (`:102`). Idempotent on a `released` row.
- `checkpoint` and `restore` throw a typed `not_supported` until W-020.
- Every mutating call with a stale epoch is rejected as `stale_epoch`.
- **Liveness is not kept on this row.** Heartbeats renew `execution_allocation.last_heartbeat_at` and `controller_lease_until` (W-017, W-019). W-018 never writes `workspace.lease_until`, so the publisher's row lock cannot make a healthy writer look dead inside the 30-second suspect window (`06-runner-workspaces.md:23`). Any time W-018 stores is Postgres `now()`.

`materializeCandidate`: the reference signature gives a candidate and a role, but each row needs a
stage run and a setup profile (`stage_run_id` and `setup_profile_ref` are `NOT NULL`), and
`CandidateManifest.createdByStageRunId` is the author's run, not the verifier's (SI-18). So:

- The implementation takes an optional fourth argument, `binding: { stageRunId, setupProfileRef }`, supplied by the trusted caller from its own stage input. It stays assignable to the reference interface. Without it the call fails with `verifier_binding_required`.
- The stage run must exist, belong to the manifest's task, carry the same role and not be superseded; otherwise `binding_mismatch`.
- One row per repository in the manifest: `base_commit` and `candidate_commit` from the `RepositoryCandidate`, no branch, role as given.
- **Deterministic ids:** the workspace id is a version-8 UUID taken from SHA-256 of `factory-workspace/1`, organization, candidate id, repository id, role and stage run id. A retry finds the same rows and the same directories.
- It returns the records after the rows exist. The copies are then materialized from the manifest's source bundle through the same two phases: own object store, detached at the exact commit, `treeDigest` verified. Never a branch name, never alternates, never the author's directory.

`GitMaterializer` (no database, same contract for the local and pod executors):

- `materialize(request)` returns `{ ok: true, receipt: { generation, headCommit, treeDigest, gitVersion } }` or a typed refusal.
- **If the target exists, it refuses with `target_exists` and runs no Git.** It cannot see row state, so it never trusts what it finds.
- It works in one fixed staging path per generation, `<root>/<orgId>/<workspaceId>/.staging-g<generation>`. A staging path left by a crash is deleted first. There are no random sibling directories.
- From a remote: clone with **`--no-local`** and no checkout, verify the commit, add the task-branch worktree with **relative paths**, compute the digest, rename into place.
- From a bundle: **full bundles only**. `git bundle verify` must pass in an empty repository with no prerequisites (`06-runner-workspaces.md:74`); a thin bundle is refused as `thin_bundle`. Then fetch with object checks, check out detached, verify the digest, reject a tracked symlink that leaves the root.
- Layout: `<root>/<orgId>/<workspaceId>/g<generation>/{git,work/main}`.
- `remove(target)`: whole-directory delete as described under the Git rule; reports whether absence was proved.

`LocalWorkspaceHost.ensureMaterialized(ctx, id)`: opens a transaction, takes the row `FOR UPDATE`
and **holds it across the clone**; if the row is not `allocated`, or a receipt is already accepted,
it does nothing. If the target exists with no accepted receipt (a crash between rename and accept),
it removes the target and starts again; that is safe because the lock is held and `allocated` means
no writer. Then it calls `materialize` and `acceptMaterialization` and commits. A concurrent
`release` therefore either runs first, after which the host sees `releasing` and does nothing, or
waits and then removes a complete directory. A live directory under a released row cannot occur.

`treeDigest` (SI-16). W-020's reader must reproduce this byte for byte, so it is exact:

- Input: one commit. Walk its tree recursively. One entry per blob, shaped as a `FileSnapshot`.
- `path`: from the repository root, `/`-separated. A path that is not well-formed UTF-8 is refused (`non_utf8_path`); it cannot be represented in the contract.
- `mode`: Git's six-digit octal string, exactly `100644`, `100755` or `120000`. A submodule entry (`160000`) or any other mode is refused.
- `kind`: `file` or `symlink`. `sha256`: lowercase hex of the raw blob bytes; for a symlink the blob is its target.
- `symlinkTarget`: present on symlinks only, as UTF-8; a non-UTF-8 target is refused.
- Order: ascending by the path's UTF-8 bytes, compared as unsigned bytes.
- Digest: `canonicalHash({ algorithm: 'factory-tree-digest/1', entries })` from `@factory/domain`.

Publisher, `compareAndUpdateRef(ctx, { workspaceId, expectedEpoch, expectedHead, sourceRef })`:

- **Caller.** Only the configured Git publisher service identity (`09-verification-security.md:71`); anyone else is refused and audited. `expectedEpoch` is taken by that caller from the runner's record of the authenticated allocation. It is never a value a pod supplied, since a stale writer can guess the next integer (`06-runner-workspaces.md:25`, `:110`).
- **Binding.** The request names no repository, branch or commit. All three come from the row: `repository_id` (and its clone URL from the registry), `branch` (must be set and inside the task namespace) and `candidate_commit` (must be set). A workspace cannot be used to push somewhere else or something else.
- **States.** `checkpointed` or `retained` only. Any other state is refused as `not_publishable`.
- **Steps.** (1) Open a transaction with `idle_in_transaction_session_timeout` at 90 s and take the row `FOR SHARE`; check epoch and state. (2) Build a staging repository at a fixed publisher scratch path for this workspace and epoch from the `sourceRef` bundle: full bundle, verified, containing the row's `candidate_commit`. (3) Push with an explicit expected-head lease, or "must not exist" when `expectedHead` is null, under a 60-second limit. Plain force is never used. (4) Commit only after the push returns; remove the staging repository.
- **Results.** `updated`; `needs_reconciliation` with both heads and nothing written; `stale_epoch`.
- `replaceWriter` needs the row exclusively, so it waits for an in-flight push; a push that starts after a replacement sees the new epoch and is refused.
- **Residual risk**, stated in the README: if the publisher loses its database connection mid-push the lock is gone. The publisher kills the Git child at once; nothing stronger is possible without fencing on the provider's side.

### What W-018 claims, and what it does not

- **AC-12, the Git fencing half only:** after a replacement, the old epoch cannot update a task ref or change workspace state, and a new writer never gets the old directory.
- Not claimed for AC-12: stale-epoch denial of artifact finalization, result publication and tool operations (`06-runner-workspaces.md:25`; W-019, W-023, W-075); reuse on proof of quiescence and the quarantine record (W-019, W-024); isolated restore from a checkpoint (W-020).
- Why the quarantine record is not here: the `workspace` row holds one state, so nothing in it can say "generation 1 is quarantined", and deleting by a path prefix is forbidden (`06-runner-workspaces.md:100`). Per-generation state already exists in `execution_allocation`, which W-017 starts writing. That is preferable to a forward migration, because the migrations are checked for equality with the reference DDL.
- **AC-22, the source half:** an independent, fixed, digest-verified copy. The canonical test package mount is W-022.
- **AC-38, the local ref half.** Publishing through a real provider is W-030.

### Tests

`packages/workspace/test`, real Git repositories in temporary directories, real Postgres, no
Temporal. A local setup executor and a bundle-making helper live here and are not exported. Every
"nothing happened" assertion has a positive control in the same setup.

| Test file | Shows |
| --- | --- |
| `ac-12-stale-writer-fencing.test.ts` | After a replacement the row is `allocated` at generation n+1, the old epoch cannot publish, change state or release, the old directory is byte-for-byte untouched, and the new generation materializes at a different path. With a `checkpoint_ref` set, the fence still commits and the request answers `restore_unavailable`. **Race:** with a fault point between the epoch check and the push, a concurrent `replaceWriter` blocks until the push ends; a replacement that commits first makes the push `stale_epoch` and the remote is unchanged. An `UPDATE` of an unrelated allocation heartbeat is not blocked during a push. |
| `ac-22-independent-evaluation-source.test.ts` | The verifier copy has its own common directory and no alternates, shares no object-file inode with the author workspace or the remote, and survives deletion of both. **Control:** in the same directories a plain `git clone <path>` does share an inode, so the check is not vacuous. Editing the author's test copy after freeze does not change the copy. A wrong `treeDigest` and a thin bundle are refused. **Retry:** calling `materializeCandidate` twice gives the same ids, rows and directories. No binding, or a binding to the author's stage run, is refused. |
| `ac-38-human-edit-preserved.test.ts` | A person pushes to the task branch. The publisher's update is refused, the person's commit is still the remote head, and the result names both heads. A first publish to a branch that already exists is refused the same way. A caller that is not the publisher identity, a row in `active`, and a row with no `candidate_commit` are each refused. |
| `w018-allocate.test.ts` | Idempotent attach; conflict on a changed field. **Twelve concurrent `ensureMaterialized` calls with one id produce one row, one directory, one accepted receipt and no staging path left over. The same race with a concurrent `release` ends either `released` with no directory, or materialized and then released; never a directory under a released row.** A crash injected between rename and accept is repaired on the next call. A materializer given an existing target refuses and runs no Git. Two organizations never share a directory or an inode. Worktree links are relative and survive moving the generation directory. `release` of an `active` row is refused. |
| `w018-hostile-environment.test.ts` | The parent process sets `GIT_DIR`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_COUNT` with its key and value, `GIT_CONFIG_PARAMETERS`, `GIT_EXEC_PATH`, `XDG_CONFIG_HOME` and `HOME`, each pointing at something that would write a canary or redirect objects. Materialize and publish are unaffected. **Control:** plain `git` run with the same environment does trip the canary. |
| `w018-no-git-after-writer.test.ts` | The bundle is built first. Then the generation is marked active and its `.git/config`, attributes and hooks are planted with fsmonitor, filter, textconv and hook programs that write a canary file. **Control:** running `git status` and `git diff` directly in the planted repository writes the canary, so the fixtures fire. Attach, `replaceWriter`, `release` and a publish from the bundle all complete and no canary appears. |
| `w018-tree-digest.test.ts` | The committed vector (regular file, executable, symlink, nested directory, empty file) gives the recorded digest. Non-UTF-8 path, non-UTF-8 symlink target and a submodule entry are each refused. Byte order differs from UTF-16 order on a chosen pair of paths and the byte order wins. |
| `w018-paths.test.ts` | Traversal, escaping symlink, caller-supplied clone URL, branch outside the task namespace, workspace root inside a checkout: each refused with its own code. |
| `w018-setup-profile.test.ts` | A fixture recipe runs through the test executor with argument array, cwd, clean environment and time limit; an output outside the allowed paths fails; unsupported features fail closed; `runSetup` without an executor does not compile. |

### Definition of done

- The nine test files pass, and `pnpm check` is green.
- AC-12, AC-22 and AC-38 are logged with the exact halves above, naming the packages that complete each.
- No file under `apps/worker` changes; no migration is added.
- `docs/build-log.md` has the W-018 line. `docs/assumptions.md` has **A-29** (INT-01 and INT-02 stand-in: the Git command line at 2.48 or later, local bare repositories as remotes, the local setup-profile shape, the pod executor deferred to W-017). `docs/spec-issues.md` has SI-10, SI-11, SI-16, SI-17 and SI-18.
- The README states the Git rule, which part runs where, the two phases, the publisher's residual risk, and what is not built: Git cache, submodules, LFS, shell recipes, experiment worktrees, checkpoint and restore, volume reuse, the quarantine record.
- One commit, then independent review before W-017 starts.

## 5. Risks

### Temporal replay, and the W-023 design constraints

- Every committed history records the Activity type `executeFakeStage` (`apps/worker/src/workflows/stage-execution.ts:110` and `:135`). W-023 adds `startOrAttachExecution`, `awaitExecution` and `cancelExecution` behind `patched('runner-v1')`, after `authority-v1`. `executeFakeStage` stays registered so open histories finish on the new worker (AC-09).
- **Executor selection is a local field on `PlanSnapshot`**, `executor: 'fake' | 'runner'`, set by `resolvePlan` from a code table keyed by template id and version; absent means fake. It cannot go in the template: `PlanNode` is `additionalProperties: false` and `resolvePlan` validates every template against `WorkflowTemplateDefinition` (`apps/worker/src/activities/plan-resolution.ts:31`). I did not use `requiredCapabilities`: no chapter defines what that field means, so using it would invent contract semantics.
- **Amendments stay on the task's template version.** Today an amendment re-resolves through the per-work-type default (`plan-resolution.ts:16`, `:28`; `workflows/amendment.ts:29`), so moving the default would switch an in-flight task's runner. `resolvePlan` for plan version 2 and later must read the template id and version from the task's previous `execution_plan` row. This is an Activity change with no new workflow command. Test: change the default, amend an older task, and it keeps its template and its executor.
- **Cleanup on every non-semantic path.** Today, when the stage Activity fails outright the workflow records `infrastructure_error`, settles the budget and moves on (`stage-execution.ts:112-121`); with a real Job the writer would keep running. Under `runner-v1`, for runner nodes: on Activity failure, on cancellation, and before the workflow itself fails, run a non-cancellable `cancelExecution` with the Cleanup limits (120 s, 20 min, 8 attempts; `04-temporal.md:85`) **before** the stage is finished and charged. A workflow that is terminated gets no such chance; W-024 is the backstop, which is why it now precedes the checkpoint.
- **New cleanup rule.** `outcome_recorded` currently requires zero allocation rows (`activities/outcome.ts:68`, `activities/shared.ts:84`), so every task that ever ran a real Job would fail it. W-023 replaces it: no allocation of the task is in a live state, and every quarantined allocation or unreleased workspace has a recorded obligation with an owner and expiry, carried in the manifest's `cleanupObligationRefs`. Tasks with no allocations behave as before.
- **Heartbeat.** `awaitExecution` gets its own `proxyActivities` with a 30-second heartbeat timeout and a beat every 10 seconds (`04-temporal.md:84`). The existing `execute` proxy (10-second timeout, `workflows/config.ts:8`) is left alone; on this machine a 10-second timeout on a 10-second beat would fire falsely.
- W-088, W-119 and W-075 each add workflow commands: one marker each, new histories per marker, no fixture overwritten.
- Continue-As-New state takes optional fields only.
- Gate before W-023 starts: the replay suite passes on the committed tree.

### Load on this Mac

- 8 GB RAM and 6 cores, shared with UTM virtual machines and the podman machine. The load average was 7.8 to 16.5 during the first session while another session ran tests.
- The fake tier adds no server. Keep new Temporal-backed test files to W-023, W-088 and W-119. `maxWorkers` stays 3.
- The k3s tier is opt-in, one worker, capped at 2 CPUs and 1.8 GB, and never run alongside the full suite. It is not part of `pnpm check`; each package that needs it reports the run in its build-log line.
- Test images share one slim base. A trivial image loads in under a second; a Node-sized one is untested.
- Fallback if the tier proves too heavy: run it only at the review checkpoints.

### Spec gaps to record (proposed SI-10 onward)

| ID | Location | Problem | Proposed choice |
| --- | --- | --- | --- |
| SI-10 | `06-runner-workspaces.md:59`, `:67`; `domain.schema.json` | The setup profile's contents are required in prose and `setupProfileRef` is mandatory, but no `SetupProfile` schema exists. | A local document in `packages/workspace` that embeds the contract's `Recipe`. |
| SI-11 | `contracts/interfaces.ts:89-91`; `schema.sql` `workspace`, `stage_run` | `allocateOrAttach` takes a `specHash` and chapter 06 requires 409 on a changed specHash, but only `execution_allocation` stores one. | Workspace conflict is decided by equality of the stored columns. Run-level specHash is compared against the stage run's allocation rows (W-017). |
| SI-12 | `backlog.json` W-129, W-020, W-134; AC-206, AC-231 | Fencing of checkpoint child Jobs (AC-206) belongs to W-129 in M4, but M2's checkpoint-only finalization cannot work without it. | Build the child rows and their fencing in W-020; leave AC-206 listed under W-129. |
| SI-13 | `06-runner-workspaces.md:14`, `:112` | Deterministic names are defined for allocation Jobs and PVCs, not for checkpoint Jobs. | `factory-` + base32(sha256(org id, receipt id))[:20] + `-c`. The name comes from `receipt_id`, so two controllers racing on one receipt collide on the 409 instead of on a counter. |
| SI-14 | `contracts/interfaces.ts:78-79`; `execution_allocation.state` | `RunHandle.state` has six values and the allocation has nine; the mapping is not given. | `suspect`, `stopping` and `quarantined` report `reconciling`; `terminated` reports `cancelled` only when a cancel was requested. |
| SI-15 | `06-runner-workspaces.md:16-17`; `09-verification-security.md:77` | Nothing requires network policy to be in force before the harness starts. Measured on k3s 1.36.6: 10 of 10 pods reached the API server with their first request under a default-deny policy created 20 s earlier. | See D11. |
| SI-16 | `domain.schema.json` `RepositoryCandidate.treeDigest`, `Digest` | `treeDigest` is a 64-hex digest with no defined algorithm; a SHA-1 tree id is 40 hex. | The algorithm in section 4, which matches AC-230's "raw object and file bytes". |
| SI-17 | `06-runner-workspaces.md:59`, `:100`, `:108`; `examples/kubernetes-job.json` | Nothing says which container performs the first clone: the example mounts the workspace read-only in the supervisor and has no other trusted container. Separately, `:100` asks for `git worktree remove` on release, which would run Git on a candidate-writable repository against `:59`. | A trusted first step of the Job clones onto the empty volume. Release deletes the whole generation without Git; `git worktree remove` is a sandbox-side action only. |
| SI-18 | `contracts/interfaces.ts:95-96`; `schema.sql` `workspace`; `CandidateManifest` | `materializeCandidate` receives a candidate and a role, but each workspace row needs a stage run and a setup profile. The manifest's `createdByStageRunId` is the author's run, and no chapter says what `profileRefs` holds. | An optional fourth argument carries the verifier's stage run and setup profile from the trusted caller; without it the call fails. Workspace ids are derived from candidate, repository, role and stage run. |

## 6. Response to the adversarial review

All high and medium items were checked against the spec, the code and, for Kubernetes and Git
behaviour, by running them. All are taken, with these differences:

| Review item | Disposition |
| --- | --- |
| 1 Split manager and materializer | Taken. Section 4 says which part runs where. |
| 2 Git on candidate-writable repositories | Taken as a rule, not a denylist. Worktree creation and removal move to the sandbox; publishing moves to a staging repository. The reader is a named item in W-020 with an estimate and D10. |
| 3 Hard-linked clones | Confirmed on this host: a plain local clone shared an object inode with its source; `--no-local` and `file://` did not. Taken, with the inode and environment tests. |
| 4 Check-then-push race | Taken (`FOR SHARE` across the push). I add one residual risk the review did not mention: a lost database connection mid-push. |
| 5 Quarantine storage | Chose "move to W-019", not a migration. Reason in section 4. |
| 6 W-023 cleanup | Taken, including the new cleanup rule and moving W-024. |
| 7 Executor and amendments | Taken, but with the local `PlanSnapshot` field, not `requiredCapabilities`. D9 added. |
| 8 Conformance list | Taken. Five of the eight behaviours were run on k3s today and are marked verified; I added a ninth (the service-account race) that the probe hit by accident. |
| 14 Permits | Not as written. Rather than narrow W-017's AC-10 claim, the runner side of the permit moves back into W-017, as the backlog deliverable says; W-019 keeps the supervisor side. The capacity stand-in is A-30. |
| 19 Image-load spike | Not scheduled, because it is done: the load works (section 2). What remains untested is a Node-sized image. The test exclusion is taken. |
| Low: SI-15 "one probe is not proof" | Reproduced 10 of 10 with a positive and a negative control. It is now a measured finding and an owner decision (D11). |
| 9, 10, 11, 12, 13, 15, 16, 17, 18, 20, 21 and the other low items | Taken as proposed. |

Nothing in the review was rejected outright.

Round 2 (the W-018 brief only): both blockers and all ten should-fix items are taken in section 4. `reuse` and the proof record leave W-018 for W-019, which changes the round-1 answer to item 10; SI-18 is new.

## Confidence

- **Verified by running or reading today:** the package list, order, dependencies and acceptance IDs; every row of the section 2 table; the hard-link and relative-worktree behaviour of Git 2.50.1; the code and schema facts cited in sections 4 and 5.
- **Inferred, not tested:** that kind and k3d offer nothing extra here; the size column; the reader's 3–5 days; that durable capability counters fit without a new table (a W-021 design question); the SI-13 and SI-14 choices.
- **Measured on one cluster only:** the network-policy start-up window. It says nothing yet about any other CNI.
