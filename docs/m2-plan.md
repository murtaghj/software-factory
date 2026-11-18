# M2 plan: isolated execution

Revision 5, 2026-11-18. Written against spec rev 1.13. Planning only; no source changed.
Revision 2 answered the adversarial review of revision 1; revision 3 reworks the W-018 brief after its own second review. Section 7 lists what changed and what was not taken as written.
Revision 4 adds the W-017 brief as section 5, with decisions D12 to D16 and spec issues SI-19 to SI-25. The old sections 5 and 6 are now 6 and 7.
Revision 5 reworks the W-017 brief after its first review (no-go: four blockers, thirteen should-fix items, all taken), records the owner's decision D17, adds D18 and SI-26, and adds the results of a third k3s session that probed the two behaviours the brief rests on. A second review passed it for 17a subject to edits N1 to N7 and five small ones, which are made in section 5 (section 7, round 4).

Code references are to the working tree after the worker split (P-18, P-19, P-20: done, about to be
committed on top of `b63a1a6`). The newest patch marker is `authority-v1`
(`apps/worker/src/workflows/config.ts:22`); M2's first marker, `runner-v1`, follows it.

M2 in the backlog (`docs/spec/14-build-backlog.md:15`): "Runner, workspaces, boundary checkpoints,
verifier, factory tools and minimum admission. Exit: lost-pod, stale-writer and canonical-test
integrity acceptance."

## Summary

- M2 is **18 packages**, 61–95 backlog engineering-days (`backlog.json`, milestone M2): W-017 to W-025, W-075, W-088, W-089, W-090, W-098, W-115, W-116, W-119, W-134.
- **Start with W-018.** It is the only M2 package whose dependencies are all built. Its brief (section 4) needs no owner answer, no migration and no new dependency. It is built and committed (`57b16e9`).
- **W-017 is next; its brief is section 5.** No migration and no new dependency; two guarded transitions are added to `packages/workspace` by owner decision (D17). It is larger than its estimate (8 to 10 days against 4–6), so it is built as two reviewed commits. The two Kubernetes behaviours its design rests on were probed on k3s and hold, with one correction; nine lesser ones are marked to confirm in the k3s tier.
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
| 2 | **W-017** Kubernetes controller and Job protocol | New `apps/runner`: `Runner.startOrAttach/getRun/cancel/getResult`, desired/observed reconcile, deterministic Job names, versioned allocations, and the **runner side of the start permit and pod-specific writer claim** (as the backlog deliverable says). The `KubeApi` port, its fake and the k3s tier (section 2). The pod executor for `GitMaterializer`. A capacity stand-in until W-088 (A-30). First named fault points. Brief in section 5. | W-006 ✓, W-011 ✓; W-005, W-077, W-097 by assumption (D2) | AC-10 (one allocation, one permit winner at the runner API), AC-11: F and K | 4–6 · L, likely at the top |
| 3 | **W-019** Lease fencing and process supervision | New `apps/supervisor`: the supervisor that takes and renews the permit, heartbeat 10 s / suspect 30 s / expiry 60 s judged on the **Postgres clock**, stale-epoch rejection, process-tree stop, the `QuiescenceProof` record (runner-issued: pod UID, terminal state of every container, detachment observation; accepted only from the runner identity), volume reuse on that proof, the quarantine record for a replaced generation (all three left out of W-018), the network start gate (D11). | W-017, W-018 | AC-10 (a real duplicate supervisor exits without touching the workspace), AC-12 (quarantine half): F. AC-15: F for the protocol only; **tree stop is claimed at K only** | 4–6 · L |
| 4 | **W-020** Durable checkpoints and restore | In `packages/workspace`: committed and dirty-state manifests, self-contained bundles, finalization, restore into a clean allocation; `checkpoint_job` child rows and their fencing (SI-12). **Starts with the untrusted-Git reader** (below). | W-007 ✓, W-018, W-019 | AC-13, AC-14, AC-16: F, real Git | 4–6, plus 3–5 for the reader · L |
| 5 | **W-023** Runner Activity attachment and cancellation | In `apps/worker`: `startOrAttachExecution`, `awaitExecution`, `cancelExecution` Activities; typed infrastructure versus semantic outcomes; cleanup on every non-semantic path; the new cleanup rule for `outcome_recorded`. Behind `patched('runner-v1')`. Design constraints in section 6. | W-019, W-020, W-011 ✓ | AC-10, AC-14, AC-15: F with Temporal | 3–5 · L |
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

### What I tested on this machine (2026-11-18, three sessions)

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
| **Init container's termination message** (third session; `terminationMessagePolicy: File`, non-root user, read-only root filesystem) | Exit code 0 and the exact JSON line were in `status.initContainerStatuses[0].state.terminated` while the main container was `Running`. The main container wrote its own message file; the init container's was unchanged |
| **A 5,000-byte termination message** | Cut to 4,096 bytes |
| **A failed init step that wrote only to stderr** | Policy `File`: exit code 1, empty message. **Control**, policy `FallbackToLogsOnError`: the stderr line came back as the message |
| **Token for a pod with a custom audience** (TokenRequest API, bound to the pod; 1,154 bytes), reviewed naming that audience | `authenticated: true`; the audience in `status.audiences`; user `system:serviceaccount:<ns>:<sa>`; `extra` carried the pod's name and UID (and the node's) |
| **The same token reviewed naming another audience, or none** | Not authenticated; the error names the mismatch. With none named, the API server's own audiences are used |
| **Review after the bound pod was deleted** | A token never reviewed before: refused at once ("service account token has been invalidated"). **A token reviewed just before the delete: still `authenticated: true` at 0 s and 5 s, refused at 15 s.** The API server keeps a successful review for a short time |
| **A service account with no Role** | RBAC answers no to `patch pods/status` and to `get pods` (checked with `kubectl auth can-i --as`) |

Not tested: kind, k3d, an envtest-style API server, a Node-sized image, a token read from a projected volume (the third session minted its token through the TokenRequest API, which is what the kubelet uses), more than one node, the timing between Job `Failed` and container exit, a PVC with an owner reference.

The third session's script and output are `w017-step0-probe.sh`, `w017-step0-probe3.sh` and their `.out` files in the session scratchpad. The container and its volumes were removed after each run.

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
- Pods removed by the control plane when their node is deleted, while the node's processes still run. W-017's proof of quiescence treats "no pod" as stopped (section 5); a multi-node cluster needs the node's state as well.
- Sandboxed runtimes, node isolation, the agent-sandbox option (ADR-21); workload identity against the organization's issuer; amd64 images; capacity at the chapter 11 limits.
- Process-tree stop on Linux is shown at K. The fake kubelet on macOS proves the protocol only; a child that starts its own session escapes a process group.
- Anything about the Claude harness in a restricted pod (W-077).

## 3. Owner decisions

The crew proceeds on the default unless told otherwise. None of these blocks W-018. D12 to D18
belong to the W-017 brief (section 5). D17 is decided; none of the others blocks its start.

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
| D12 | Where the runner's network listener is built. Pods may reach only "the factory control-plane runner API" (`09-verification-security.md:77`), and apps cannot import each other (`tools/boundaries.json`), so the supervisor and the worker both need one eventually. | Not in W-017, which has nothing that could call it. W-019 adds the pod-facing listener with the supervisor; W-023 adds the worker-facing route and its client. W-017's service validates every input as wire input, so both are thin. Building it in W-017 costs one to two days more. |
| D13 | Bundle sources (verifier copies, restores) for the pod materializer. | Not in W-017: `remote` sources only. A bundle needs a scoped artifact read from inside a pod, which arrives with W-021 and is first used by W-022. W-020's restore tests use the local materializer. |
| D14 | How many generations one stage run may consume. The spec sets no bound, and warns against multiplied retry loops (`04-temporal.md:100`). | Three, then a typed `generation_limit`. Configurable. |
| D15 | One PVC per workspace generation. Old generations' PVCs stay in place until W-019 (reuse on proof) and W-024 (sweep). Consequence: a workspace that had a replacement cannot reach `released` until the older PVC is gone; it stays `releasing` with `needsOperator`, because no row may be `released` while a PVC with its label exists. | Accept. On this machine they are small and `scripts/k3s.sh down` removes them. The storage class must have reclaim policy `Delete`; the runner refuses to start otherwise. The alternative is for W-017 to delete an older generation's PVC itself once that generation is `terminated` and replaced; it is a few lines, but it takes reclaiming a fenced generation away from W-019 and W-024, where W-018 put it. |
| D16 | W-017 is larger than its estimate: 8 to 10 days against 4–6. | Two commits (17a, 17b), each with an independent review, and one build-log line after the second. |
| D17 | **Decided** (owner's call, relayed by the coordinator on 2026-11-18 after the W-017 review). W-018 as shipped cannot release a workspace whose writer was stopped. | Follow `06-runner-workspaces.md:100`. W-017 may amend `packages/workspace` with one minimal change: `active → quiescing` when a stop begins, and `quiescing → retained` only on W-017's quiescence proof, both with the runner identity and an epoch check. `release` then works from `retained` as it does today and deletes the PVC of the generation that holds the work. Section 5 names the functions, the row states and the tests. |
| D18 | Where the cancel record lives. It must exist per stage run, even with no allocation, and the allocate step reads it. No table has a column for it (SI-20). | An `audit_event` row with a deterministic id (a version-8 UUID from organization and stage run) and pinned `actor_id`, `action`, `resource_kind` and `outcome`, written with `ON CONFLICT DO NOTHING` under the stage run's lock. No migration; the lookup is a primary-key read; the runtime role can only insert, so it cannot be undone. Section 5 has the exact fields. |

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
the guarded transition in `packages/database/src/workspace.ts`. Since D17, W-017 enters `quiescing`
and `retained` through two new manager methods; their rows are in section 5.

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
- **Built differently (W-018 as shipped):** the lock is held for the push only. Steps (2) and the bundle read run first with no transaction open, in a staging path unique to the call (not a fixed one); then the row is locked `FOR SHARE`, epoch, state, branch and commit are re-checked, and the push and `ls-remote` run under one 45-second deadline (not 60) inside the 90-second idle timeout. Git runs in its own process group, which is killed and waited for on a deadline or a lost session; an interrupted push is reported as `needs_reconciliation` with `outcomeUnknown`. See `packages/workspace/README.md`.
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

## 5. Second package brief: W-017 Kubernetes controller and Job protocol

Written 2026-11-18 against W-018 as committed (`57b16e9`), and revised the same day after its first
review: four blockers and thirteen should-fix items, all taken (section 7, round 3). Every
Kubernetes behaviour below is either a row of the section 2 table (verified) or is marked **to
confirm in the k3s tier**. The two that carry the design were probed on k3s during the revision
(step 0, below); the rest wait for 17b.

**Goal.** Turn one stage run into at most one live allocation, one Job and one writer, and keep
that true when two controllers race, when a controller dies between any two steps, and when
Kubernetes shows a duplicate pod. Give W-018's `GitMaterializer` its pod executor. No Temporal, no
workflow change, no supervisor (W-019), no migration, no new npm dependency. `packages/workspace`
gains two guarded transitions and nothing else (D17).

**Size.** More than the backlog's 4–6 days; I expect 8 to 10. Build it as two commits, each with its
own review (D16). **Step 0**, the probe, is done. **17a**: the port, the fake
and its kubelet, the controller, the permits, the two workspace transitions and the fake tier, with
receipts injected through the fake. **17b**: the pod executor, PVC removal and release, the
manifests, the images and the k3s tier. The acceptance lines are logged after 17b.

**Words.** "PVC" is always the Kubernetes object. "Writer claim" is always the `pod_uid` column.
The start-or-attach step that inserts the row is called "allocate". The "governing pod" is the pod
that holds the writer claim. Before the claim there is none, only candidates.

**Spec to read.** `06-runner-workspaces.md:5-7` (protocol; completion is never inferred from an
exit code), `:11-19` (start-or-attach), `:23-25` (leases), `:76` (unacknowledged work may be lost),
`:88-90` (result acceptance, cancel), `:100-104` (cleanup), `:108-112` (pod boundary);
`04-temporal.md:83-87` (Activity limits), `:98` (Job deadline is the wall cap plus 300 s, grace
15 s); `09-verification-security.md:71`, `:75`, `:77`; `11-platform-operations.md:43`;
`13-testing-release.md:5`; `contracts/interfaces.ts:78-97`; `StageInput`, `RunLimits` and
`LogicalStageRunId` in `domain.schema.json`; `examples/kubernetes-job.json`; `execution_allocation`
in `0003_tasks_execution.sql:173-190`, its indexes in `0007_indexes.sql:21` and `:30`, its grants
in `0010_roles_ownership_grants.sql:84-86`; `capacity_reservation` in
`0005_operations_delivery_ledgers.sql:115-126` and `0010_roles_ownership_grants.sql:135-137`;
`packages/workspace/README.md` (hand-off notes), `src/manager.ts:64-65`, `:259-286`, `:323-353`,
`src/materializer.ts:17-32`; `packages/database/src/budget.ts:119-152`;
`packages/database/src/db.ts:10-15` (`sessionLostSignal`).

### Three rules

1. **No Kubernetes call inside a database transaction.** Every operation is unlocked preparation
   (reads, token review, building manifests), then a short locked phase that touches only Postgres,
   then commit, then Kubernetes (`06-runner-workspaces.md:13`). A database session lost during the
   locked phase therefore means nothing outside the database has happened. The call fails with the
   session's own error and is safe to retry.
2. **Two controllers are never kept apart by a lease.** They are kept apart by deterministic ids
   and names, three uniqueness rules in the schema, compare-and-swap on epoch and state, and the
   409 from Kubernetes. Either controller can finish what the other started, and neither undoes
   what the other bound.
3. **`terminated` is a proof, not an event.** An allocation becomes `terminated` only through one
   function that reads pod and container status. Until then the stage run cannot get a new
   generation and its workspace cannot be released. This is the W-018 rule (kill the process
   group, wait for it, then release the lock) applied to pods. What it proves is that no pod of
   the allocation was running when it was read. It cannot stop a controller that was paused in the
   middle of a create; a Job that appears afterwards can never get a permit and is deleted on
   sight.

### Step 0: the probe of the two behaviours the design rests on

Run on 2026-11-18 on AC power, during this revision: three short k3s starts with the pinned image
(digest `sha256:6d654de9…46b85`), `kubectl` inside the container only, and no factory code. The
rows are in the section 2 table.

- **The receipt holds.** With `terminationMessagePolicy: File`, a non-root user and a read-only root filesystem, the init container's exit code and exact message were in the pod status while the main container ran. A 5,000-byte message came back as 4,096. A failed step that wrote only to stderr left an empty message. **Control:** under `FallbackToLogsOnError` the stderr line came back as the message, which is the forgery the pinned policy prevents.
- **The identity holds.** A token bound to a pod with the audience `factory-allocation:<org id>:<allocation id>` reviewed as authenticated only when the review named that audience, listed it in `status.audiences`, and carried the pod's name and UID. Naming another audience, or none, was refused.
- **One correction.** I had assumed a review fails as soon as the bound pod is deleted. It does for a token that was not reviewed before. **A token reviewed a few seconds earlier stayed valid for between 5 and 15 s after its pod was gone**, because the API server keeps a successful review. With a 10-second heartbeat that would be every writer's token. So a review alone never shows the pod still exists: both permit calls also read the pod (below).
- Nothing was left behind: no probe container, and the podman volume list was the same before and after.
- The fallbacks named in the first version of this brief (D12's listener for the receipt, another answer to SI-24 for the identity) are not needed.

### The parts, and where each runs

| Part | Runs in | Touches |
| --- | --- | --- |
| `Runner` service: `startOrAttach`, `getRun`, `describeRun`, `cancel`, `getResult` | The runner process | Postgres. After its commit it runs one reconcile pass for that allocation. |
| Workspace facade: `allocateOrAttach`, `release` | The runner process, for control-plane callers | W-018's manager, called with the runner's identity and the caller's task scope. |
| Reconciler: `reconcileOnce`, `reconcileOne`, and a loop every 15 s with 20% jitter | The runner process | Postgres and the `KubeApi` port. |
| Permit service: `acquireStartPermit`, `renewPermit` | The runner process. Its caller is the supervisor (W-019); in W-017 the callers are tests. | Postgres, plus a token review and one pod read through the port, on every call. |
| `KubeApi` port and `HttpsKube`, the thin client | The runner process | The cluster API only. |
| `FakeKube` and the fake kubelet | The test process | Memory, and local child processes in their own process groups. |
| Pod materializer entry (the pod executor of `GitMaterializer.materialize`) | A trusted init container of the allocation Job, alone on the empty volume | The volume only. No database, no identity token, no factory credential. |
| `PodVolumeMaterializer` (the `GitMaterializer` handed to `createWorkspaceManager`) | The runner process | The port, and one read-only lookup supplied by the runner ("does this workspace have a live allocation"). It removes a generation's PVC. |
| Stub containers | The supervisor and harness slots of the Job, until W-019 and W-077 | Nothing. They run until TERM, ignore TERM, or exit, as a test asks. |
| `scripts/k3s.sh`, `deploy/k8s`, `deploy/images` | The developer's machine and the podman machine | The opt-in cluster. |

`apps/runner` is an app, and apps are not importable (`tools/boundaries.json`). W-017 ships the
service as an object, with every input validated as if it had come off the wire, and **no network
listener** (D12). Other packages' tests reach the fake through `@factory/runner/testing` from a
`tests/*` package with an `importableApps` entry, as `@factory/system-tests` does today.

**Who creates the workspace row.** `StageInput` carries only a `workspaceId`. W-018's
`allocateOrAttach` accepts only the runner identity (`manager.ts:91-98`, `:205`), and the worker
cannot import the package. So the runner exposes the facade above, as chapter 06 lists
`WorkspaceManager` among the runner's operations (`06-runner-workspaces.md:5`). The caller is
checked like any `Runner` caller; the manager is then called with the runner's identity. W-018 does
not compare the requested role with the stage run's (`manager.ts:205`, `:216-217`), so the facade
does: a role that differs from `stage_run.role` is refused as `conflict`. W-023's
Activity calls it before `startOrAttach`, with the repository, base commit, branch and setup
profile from its own inputs (SI-26).

### The allocation row, and whether a migration is needed

**No migration.** I checked every column, index and grant against what the
controller has to store.

| Column | Written | Notes |
| --- | --- | --- |
| `id`, `stage_run_id`, `workspace_id`, `generation`, `owner_epoch`, `spec_hash`, `job_name`, `namespace`, `supervisor_identity` | Once, at insert | The runtime role has no `UPDATE` grant on any of them, so an allocation's identity cannot change. That is what "versioned allocations" means here. |
| `state` | Guarded transition | Compare-and-swap on `id`, `owner_epoch` and the expected state. |
| `job_uid` | Once, null to value, with `desired → starting` | The observed Job UID (`06-runner-workspaces.md:15`). |
| `pod_uid` | Once, null to value | **The pod-specific writer claim.** Whoever sets it holds the permit. |
| `controller_lease_until` | With every transition and every heartbeat | **The deadline of the current phase** (SI-19): the start deadline in `desired` and `starting`, the lease in `running` and `suspect`, the stop deadline in `stopping`. Postgres `clock_timestamp()`, read after the row lock is held. |
| `last_heartbeat_at` | Permit, each heartbeat | The same clock. |
| `updated_at` | With every write, as `clock_timestamp()` | W-018's workspace helper writes `now()` (`packages/database/src/workspace.ts:84`), which is the transaction's start. The allocation helper must not: a transition that waited for a lock would be stamped early. In `stopping` nothing but the transition writes the row, so the column is the time the stop began. |
| `terminated_at` | With `→ terminated` | Null on `quarantined`: nothing was proved. |
| `data_classification`, `provider_eligibility_ref` | Left null | W-115. |

The three uniqueness rules behind rule 2: the index `one_active_allocation` (one live allocation
per stage run, `0007_indexes.sql:30`), `UNIQUE(org_id, stage_run_id, generation)` and
`UNIQUE(org_id, namespace, job_name)`.

What the row cannot hold, and where it goes instead:

- **Cancel intent.** No column, and it must exist even when there is no allocation. It is one `audit_event` row per **stage run** (SI-20, D18), pinned exactly:
  - `id`: a version-8 UUID from SHA-256 of `factory-run-cancel/1`, organization and stage run id. The deterministic id follows `apps/worker/src/activities/command-authority.ts:55`.
  - `actor_id`: the runner identity. `action`: `runner.cancel`. `resource_kind`: `stage_run`. `resource_id`: the stage run id. `outcome`: `accepted`. `correlation_id`: the command id. `request_digest`: SHA-256 of the canonical command id and reason.
  - Written with `ON CONFLICT (org_id, id) DO NOTHING` under the stage run's lock, then read back. **The lookup is a primary-key read**, and it counts only if all five fixed fields match; a row at that id with other fields is a hard error, never "not cancelled".
  - A refused cancel is audited with a random id and `outcome: denied`, so it can never be read as a cancel.
- **Stop reason.** An `audit_event` row in the same transaction as `→ stopping`. Diagnostic only; nothing decides on it.
- **Who holds the controller lease.** No column, and none is needed under rule 2 (SI-19).
- **The PVC's name and UID.** The name is derived; the UID is read, and checked against ownership labels, every time it is used.
- **The materialization receipt.** W-018 stores it as a linked artifact; W-017 adds nothing.

**Identity.**

- Allocation id: a version-8 UUID from SHA-256 of `factory-allocation/1`, organization, stage run id and generation, in the manner of `deriveWorkspaceId`. Two controllers that race insert the same row.
- Job name: `factory-` + lowercase base32(sha256(org id + `|` + logical id))[:20] + `-g` + generation (`06-runner-workspaces.md:14`). PVC name: `factory-ws-` + the same hash over org id and workspace id + `-g` + generation. Checkpoint Job name (SI-13; W-017 ships the function and its vectors, W-020 the Job): `factory-` + the same hash over org id and `receipt_id` + `-c`.
- Labels under a configured prefix (default `factory.local/`): `org`, `task`, `allocation`, `workspace`, `generation`, and the first 32 hex characters of the hashed logical id and of the specHash. Annotations carry the full logical id, the full specHash, the owner epoch and the runner's own digest of the manifest it rendered.
- Token audience: `factory-allocation:<org id>:<allocation id>`, set on the Job's projected token.
- **Generation and epoch.** With a workspace, the allocation takes the workspace row's `generation` and `owner_epoch` at the moment it is allocated; `allocation_workspace_epoch_idx` is built for that lookup. Without a workspace, generation is the last one plus one and the epoch equals it. One allocation binds at most one workspace, as `StageInput.workspaceId` and the column both say (SI-23).

**States.** The check constraint has nine. W-017 drives seven of them.

| State | Means | `RunHandle.state` (SI-14) |
| --- | --- | --- |
| `desired` | The row is committed and the Job's identity is recorded. Nothing is confirmed in Kubernetes. | `accepted` |
| `starting` | The Job exists and its UID is recorded. No permit yet. | `accepted` |
| `running` | One pod holds the writer claim and its permit; heartbeats are expected. | `running` |
| `suspect` | The last heartbeat is older than 30 s, or the pod that holds the writer claim is not `Running`. No new allocation may be made (`06-runner-workspaces.md:12`). | `reconciling` |
| `stopping` | Cancel, lease expiry or a failed start. The controller is deleting and waiting for the proof. | `reconciling` |
| `finalizing` | Expected shutdown for a checkpoint, writer claim reserved. **Entered by W-019 and W-020, not here.** The reconciler leaves these rows alone. | `finalizing` |
| `terminated` | Quiescence proved, no accepted result. | `cancelled` if the stage run has a cancel record; otherwise `reconciling`, and the next `startOrAttach` allocates a new generation |
| `completed` | An accepted terminal result. **Entered by later packages.** | `completed` |
| `quarantined` | Termination could not be proved in time, or an object with our name is not ours. The PVC is left alone, an audit row records the obligation, and `describeRun` shows `needsOperator`. | `reconciling` |

Legal edges, enforced in one table (`src/states.ts`); every other pair is refused:

| From | To | Trigger |
| --- | --- | --- |
| none | `desired` | The allocate step of `startOrAttach`. |
| `desired` | `starting` | Job created, or `AlreadyExists` and validated; `job_uid` recorded. |
| `desired`, `starting` | `quarantined` | `AlreadyExists` with a different UID, specHash, epoch or owner (`06-runner-workspaces.md:14`: an error, not an attach). The same for the PVC. |
| `starting` | `running` | Permit granted. |
| `running` | `suspect` | Heartbeat age over 30 s, or the writer's pod is not `Running`. |
| `suspect` | `running` | A heartbeat from the writer's pod, current epoch, lease not expired. |
| `desired`, `starting`, `running`, `suspect` | `stopping` | Cancel. Start deadline passed. No materialization request. Every pod of the allocation bad, with no candidate and none pending or running. The pod that holds the writer claim failed or gone. Lease expired. Writer's pod gone or finished. Before a permit, the workspace at this epoch is neither `allocated` nor `active` and owned by this allocation's `pod_uid` (the second is a permit between its steps, which the same pod's retry completes). |
| `stopping` | `terminated` | The quiescence proof. The transaction takes the workspace `FOR SHARE` before the allocation and refuses while the workspace is `active` or `quiescing` at this epoch for this `pod_uid`; the pass settles it and tries again. Capacity is released in the same transaction. |
| `stopping` | `quarantined` | No proof by the stop deadline. |
| `running` | `finalizing` | Declared here so later packages cannot invent edges; driven by W-019 and W-020. |
| `finalizing` | `completed`, `stopping`, `quarantined` | The same. |

Nothing goes straight to `terminated`. A cancel that arrives in `desired` still passes through
`stopping`, because another controller's create may be in flight.

**A new generation after `quarantined` is intended.** `one_active_allocation` leaves `quarantined`
out, so the next `startOrAttach` allocates again. That is the spec's path: "allocate a new isolated
volume" when the stop cannot be proved (`06-runner-workspaces.md:25`, `:112`). It is not silent.
The old epoch is fenced by `replaceWriter` first, the new generation gets a new PVC, the
quarantined one keeps its capacity slot until it expires, an audit row records the re-allocation,
and D14's limit counts it.

### Workspace states: the one change to W-018 (D17)

W-018 as shipped has no way out of `active` except `replaceWriter`, and `release` refuses `active`
(`manager.ts:329`). A workspace whose writer was stopped could never be released, and going
through `replaceWriter` would remove the wrong generation's PVC. The owner's call is to follow
`06-runner-workspaces.md:100`.

**What changes in `packages/workspace`:** `WorkspaceManagerService` in `src/manager.ts` gains two
methods, and the README's state and "not built" paragraphs are updated. Nothing else.

- `markWriterQuiescing(ctx, id, expectedEpoch, podUid)`: `active → quiescing`.
- `markWriterStopped(ctx, id, expectedEpoch, podUid)`: `quiescing → retained`.
- Both follow `markWriterStarted` line for line: runner identity only, with an audited refusal; the row lock; the caller's task scope; the epoch check; `owner_pod_uid` must equal `podUid`; a guarded `transitionWorkspace` from exactly one state at the expected generation. A repeat in the target state by the same pod returns the record, and `markWriterQuiescing` also treats `retained` by the same pod as done. `owner_pod_uid` is kept as the name of the last writer; `replaceWriter` clears it as today.

**What does not change:** `release` (`retained` is already in `RELEASABLE`, `manager.ts:65`, and it
still refuses `active` and `quiescing` as `writer_active`); its checkpoint rule (`:334`);
`replaceWriter` (`quiescing` and `retained` are already in `REPLACEABLE`, `:64`);
`markWriterStarted`; the publisher; `packages/database/src/workspace.ts`, whose
`transitionWorkspace` already takes any source state and patch.

Row states added to the table in section 4:

| Operation | From | To | PVC |
| --- | --- | --- | --- |
| `markWriterQuiescing` (W-017) | `active`, same pod | `quiescing` | Untouched. The writer is being stopped. |
| `markWriterStopped` (W-017) | `quiescing`, same pod | `retained` | Untouched. It holds the writer's work, and no process can write it any more. |
| `release` (unchanged) | `retained` with an accepted, retained checkpoint | `releasing`, then `released` | **This generation's** PVC is deleted: the one that holds the work. |
| `release` (unchanged) | `retained` with no accepted checkpoint | refused, `checkpoint_not_accepted` | Kept. |
| `release` (unchanged) | `allocated` (no writer ever started) | `releasing`, then `released` | This generation's PVC is deleted. |
| `replaceWriter` (unchanged) | `quiescing` or `retained` | `allocated`, generation n+1 | Generation n's PVC is left, labelled (D15). |

**Who calls them.** One helper in the runner, `settleWorkspace(allocation)`, and nothing else:

- On every `stopping` pass: if the workspace is `active` at this allocation's epoch with this allocation's `pod_uid` as owner, `markWriterQuiescing`.
- On the proof: `markWriterQuiescing` if it is still needed, then `markWriterStopped`, then the allocation's `→ terminated`. **The order is enforced, not assumed:** that transaction locks the workspace `FOR SHARE` first (the lock order of the allocate step) and refuses while the workspace is `active` or `quiescing` at this epoch for this `pod_uid`. A permit that slipped `markWriterStarted` in after the proof was read therefore cannot leave a `quiescing` workspace under a `terminated` allocation.
- For an allocation that is already `terminated`: the same two calls. One case is left: a permit whose `markWriterStarted` lands after `terminated` has committed; the permit then settles the workspace itself, and the `release` facade does so again before it delegates. This is sound because `terminated` proved every pod of the allocation gone, and a pod UID is never reused.
- No proof, so `quarantined`: the workspace stays `quiescing`. `release` refuses it, which is right: nothing showed the writer stopped.
- A workspace that has moved to a later epoch is left alone.

**What this means until W-020.** No production code can make the accepted checkpoint yet. A
workspace that had a writer therefore stays `retained` with its PVC, because its work is
unacknowledged (`06-runner-workspaces.md:100`). Discarding it when its retention expires is
W-024's. Tests release it the way W-018's tests do, by seeding the `checkpoint_ref`.

**No PVC under a released row, at the time of release.** `PodVolumeMaterializer.remove` answers
`absent: true` only when the workspace has no live allocation and no PVC carrying its label is
left, of any generation. A workspace that had a replacement therefore stays `releasing`, with
`needsOperator`, until the older generation's PVC is gone (D15). The rule holds when `released` is
written. It cannot bind a controller that was paused before a PVC create and wakes afterwards; see
the residual risks.

### Interfaces

`Runner` (the reference interface at `contracts/interfaces.ts:80-86`, plus `describeRun`):

- **Caller and scope, on every method.** The caller must be one of the configured control-plane service identities, with `ctx.taskId` set and equal to the stage run's task, and `ctx.orgId` equal to the input's. A refusal is audited in its own transaction. The runner then calls `WorkspaceManager` with its own identity and the caller's task scope; it never widens the scope.
- **Input caps before any other work.** `StageInput` is validated against the contract schema and refused over 256 KiB serialized. `specHash` and `inputHash` must be 64 hex. `inputHash` must equal `canonicalHash(input.inputBinding)`; the worker computes it as `canonicalHash(binding)` (`apps/worker/src/workflows/stage-execution.ts:49`). `reason` is capped at 1,024 bytes. The checks are length tests and anchored fixed-length patterns; nothing backtracks.
- **Only the binding is hashed, so nothing else in the request is used.** `role`, `nodeId`, `semanticAttempt` and `limits` must equal the `stage_run` row's, else `conflict`; `limits` is compared as canonical JSON, not as stored text. Every value the controller acts on (the role that picks the pool, the wall cap that sets the Job's deadline) is read from the row. `limits.wallSeconds` above `maxWallSeconds` (7,200) is refused as `limits_exceed_cap`.
- `startOrAttach(ctx, input, specHash)`:
  1. **Prepare, unlocked.** Read the stage run by logical id. The worker inserted it (`apps/worker/src/activities/persistence.ts:21-30`); an unknown one is `unknown_stage_run` (SI-22). Read the workspace named by `input.workspaceId`, if any; it must belong to the same task and stage run. Nothing is rendered and W-018 is not asked for anything here.
  2. **Allocate, locked.** One transaction, Postgres only. Lock order: the stage run `FOR UPDATE` (5 s lock wait, then a retryable `stage_run_busy`), then the workspace `FOR SHARE` (5 s, `workspace_busy`), then allocations, then the capacity advisory lock. No transaction that holds an allocation lock takes one of the earlier locks. In order:
     - The task must be `running`; the stage run current, not superseded, in `pending`, `ready` or `running`; its `input_hash` and the four fields above equal to the request's, else **`conflict`** and nothing changes.
     - A terminal result exists: return the handle of the allocation that produced it.
     - The stage run has a cancel record: `run_cancelled`. This comes after the result check, so a finished run never answers `run_cancelled` while `getRun` says `completed`.
     - Any allocation of this stage run, live or not, has a different `spec_hash`: **`conflict`** and nothing changes (SI-11's run-level comparison).
     - A live allocation exists: return its handle. `suspect` returns `reconciling` and allocates nothing.
     - The budget reservation for this logical id must exist (`budget_ledger`, kind `reservation`), else `budget_not_reserved`. It must not be settled: a row of any other kind for the same key means the stage was charged or released (`budget.ts:143` adds `observed_usage` and keeps the reservation), and the answer is `budget_settled`.
     - Otherwise allocate. A workspace that is `releasing`, `released` or `quarantined` is refused as `workspace_unavailable`. If the next generation would exceed `maxGenerations` (3, D14), answer `generation_limit` before anything is fenced. If the workspace's generation is not above the last allocation's, leave the transaction, call `replaceWriter` (W-018, its own transaction; the fence commits first) and restart. A `restore_required` answer is `restore_unavailable` until W-020.
     - The workspace must now be `allocated`. Take the capacity stand-in (below), insert the row as `desired` at the workspace's generation and epoch with the start deadline in `controller_lease_until`, commit.
  3. **Restarts.** A fence that was needed, a `stale_epoch` or `publish_in_progress` from a racing `replaceWriter`, and a unique violation on the insert all restart from step 1 with every check repeated, the specHash comparison included. After three restarts the answer is a retryable `allocation_contended`.
  4. **After the commit**, run `reconcileOne` for the allocation with a 20 s budget and return the handle whatever it achieved. The loop finishes the rest.
- `cancel(ctx, stageRunId, commandId, reason)`:
  1. Locked: the stage run `FOR UPDATE`, then its live allocation if there is one. If the run already has a terminal result, write nothing and return its `completed` handle. Otherwise write the stage run's cancel record unless it has one. Move a live allocation to `stopping` and set the stop deadline. Commit.
  2. After the commit, one reconcile pass.
  - **A cancel with no allocation still writes the record.** `startOrAttach` and `cancel` both take the stage run's lock, so one of them is first: either the allocation exists and is stopped, or the record exists and nothing is ever allocated. A start that arrives after its own cancel cannot leave a Job behind.
  - It returns the handle. With no allocation ever made, that is generation 0, epoch 0, `cancelled`. A second cancel, with the same or another command id, changes nothing.
  - The 30-second checkpoint request before the stop (`06-runner-workspaces.md:90`) needs a supervisor and is W-019's.
- `getRun`, `describeRun`: the latest generation's handle; `describeRun` adds the allocation id, raw state, `needsOperator` and the recorded stop reason, for W-023.
- `getResult`: the verified `StageResult` named by `stage_run.result_ref`, read under the caller's own scope, or null. The runner never builds one.
- `watchEvents`: a typed `not_supported` until W-019.

**The manifests are a pure function of stored rows and configuration.** `renderJob` and `renderPvc`
take the allocation row, the stage run row, the workspace row, the materialization request and the
config, and nothing from the caller. Any controller can render them after another one has died.
The deadline comes from `stage_run.limits`, the images and resources from the config by
`stage_run.role`, the names, labels and audience from the rows. The full `StageInput` is stored
nowhere: `stage_run.input_ref` holds the logical id, the input hash and the binding only
(`persistence.ts:22`). The Job does not need it; the supervisor will, which is a hand-off.

Reconciler. A pass takes at most 200 allocations per organization, and one allocation's failure
does not stop the pass.

`desired`:

1. Re-read the workspace: `allocated` at this generation and epoch, or `→ stopping`.
2. Call W-018's `materializationRequest`. **This is its only call site.** It answers while the row is `allocated` with no receipt, which is exactly this state; any refusal is `→ stopping`. Render the manifests.
3. Re-read the allocation; if it is no longer `desired` at this epoch, stop. Create the PVC.
4. Re-read it again; create the Job. **Never wait for `Bound`.**
5. On 201 or a validated `AlreadyExists`, record the Job's UID with a compare-and-swap on `job_uid IS NULL` and move to `starting`.
6. **If that compare-and-swap fails, re-read the row before doing anything.** If it records the UID we hold, the other controller bound the same Job, and there is nothing to do. Only if it records a different UID, or the row is `stopping` or terminal, delete the Job we hold (UID precondition, Background).

`starting`:

- List the allocation's pods by label. For each whose `materialize` init container has terminated, read its status by the receipt rules below. A receipt goes to `acceptMaterialization`; the same receipt again is a no-op there.
- **A receipt does not say which pod wrote it.** It carries no pod identity (`packages/workspace/src/materializer.ts:21`), the stored digest leaves the pod out (`manager.ts:156-158`), and two pods that clone the same commit produce the same receipt. So nothing here depends on the order in which pods are read:
  - A **candidate** is a pod whose init step exited 0 with a receipt equal to the accepted one. There can be more than one.
  - A **bad pod** is one that failed, answered a refusal (`target_exists` included), or produced a receipt that `acceptMaterialization` refuses.
  - **Before the writer claim, no candidate is ever deleted.** The permit's compare-and-swap on `pod_uid` picks the winner.
  - **After the writer claim, `pod_uid` governs.** Every other pod of the allocation is a duplicate and is deleted (grace 15 s, UID precondition).
  - A bad pod is deleted. It is a reason to stop only when the allocation has no candidate, no pod still pending or running, and no writer claim. A lone pod that answers `target_exists` is that case.
  - The pod that holds the writer claim failed or is gone before the permit completed: `→ stopping`.
- On a cluster `ReadWriteOncePod` lets only one pod mount the PVC, so two candidates are a fake-tier case. The rule is the same in both tiers.
- A missing Job, or the start deadline (600 s) with no permit: `→ stopping`.

`running`, `suspect`: the lease judgements in the edge table, all in SQL on `clock_timestamp()`.

`stopping`:

- Settle the workspace's first edge (above).
- With `job_uid` recorded: delete the Job with `propagationPolicy: Background` and that UID as precondition. With none recorded: read the Job by name; if it is there, validate its annotations as an attach would, then delete it with the UID just read. One that fails validation is not ours: `→ quarantined`.
- Delete every pod that carries the allocation's label and has this Job, or nothing, as its owner (grace 15 s, UID precondition). A labelled pod with another owner is not deleted.
- A 404 means gone. A 409 with reason `Conflict` means the name now belongs to something else, which is left alone.
- Then evaluate the proof.

`finalizing` and terminal states: nothing more for the allocation itself.

**Jobs that should not exist are deleted on sight.** Each pass lists the namespace's Jobs by the
factory label (paged). A Job whose annotations validate as allocation X's, as an attach would check
them, is deleted (UID precondition, Background) in two cases: X is in any state but `desired` and
the Job's UID is not X's recorded `job_uid`; or X is `terminated`, whatever the UID. That covers
`stopping` and `quarantined` as well as `terminated`. In `desired` an unrecorded Job is the normal
crash between create and record, and it is bound, not deleted. This is the answer to a controller
paused between its re-read and its create.

**The quiescence proof** (`src/quiescence.ts`, a pure function over what was observed):

- It counts **every pod that carries the allocation's label**, whoever owns it. A pod orphaned by someone's raw Job delete (section 2) is counted like any other.
- Proved when the Job is absent and every such pod is either gone or in phase `Succeeded` or `Failed` with **no container, init or app, in state `running`**. The Job must be absent because a Job that still exists can still be given a pod.
- A labelled pod with a foreign owner that is not finished keeps the proof open; at the stop deadline the allocation is `quarantined`.
- A pod list that reaches its page cap (10 pages of 50) is **not proved**.
- When `job_uid` was never recorded, the proof also needs the row to have been `stopping` for at least one request deadline (10 s), measured in SQL from `updated_at`, which the transition wrote as `clock_timestamp()`. A create that was in flight when the stop began has then landed or timed out. Tests backdate the column; nothing sleeps and nothing is remembered between passes.
- It never reads Job conditions, a Job's exit status, or a phase of `Unknown`.
- "No pod" counts only because **no code path force-deletes**. The port has no grace parameter at all; the client sends 15; a lint rule forbids the field elsewhere in `apps/runner`. Only the test driver can force-delete, to show the hazard.
- It returns a `PodObservation`: pod UID, and for each container its name, state, exit code and finish time. **No message or reason text**: the harness container writes its own. W-019 turns it into the durable `QuiescenceProof` and adds storage detachment.
- Not proved by the stop deadline (180 s, held in `controller_lease_until`): `quarantined`, `needsOperator`, PVC untouched.

Permits, runner side. The supervisor side, the 10-second heartbeat sender and the process stop are
W-019.

- **Identity is never what the pod says, on either call.** `acquireStartPermit` and `renewPermit` both take `{ token, orgId, allocationId, epoch }` and both review the token every time. The pod UID is taken only from the review. The harness can reach the same route (`09-verification-security.md:77`) and can learn its pod's UID, so a UID in a request proves nothing.
- **The review.** The token is capped at 8 KiB and never parsed locally. `reviewToken` names the audience `factory-allocation:<org id>:<allocation id>`. All of these must hold: `authenticated` is true; there is no error; **`status.audiences` contains that exact audience** (an authenticator that ignores audiences can answer true with none); the user is the configured supervisor service account; `extra` carries a pod name and UID. Only then is the database touched, in the organization the audience named.
- **Refusals before that point write nothing.** An unauthenticated caller could otherwise make the runner write one audit row, in an organization of its choosing, per attempt. They are counted in process, by reason. Reviews are rate-capped (20 a second, burst 40; over that is `throttled`, with no review), and a token that failed is remembered by its SHA-256 for 10 s. The runner never caches a success.
- **A good review does not show the pod still exists.** The cluster keeps a successful review for several seconds after the pod is deleted (step 0). So both calls then read the pod by the reviewed name and require the reviewed UID and no deletion timestamp. A deleted pod loses its permit at the next beat.
- `acquireStartPermit`:
  1. Unlocked: the review. Read the pod by the reviewed name: same UID, no deletion timestamp, carrying this allocation's label, owned by its `job_uid`.
  2. With a workspace, the pod must be a candidate: its own `materialize` status shows exit 0 and a receipt equal to the accepted one (accepted now, if this call is the first to see it). An init step still running is `not_ready`, retryable. A bad pod is `no_receipt`.
  3. Locked, allocation row only: epoch equal; state `starting`, or `running` for a retry by the pod that already holds the writer claim. `pod_uid` null: set it. Equal to this pod: continue. Another pod's: **`duplicate_writer`**. This is the only place a winner is chosen.
  4. With a workspace: re-read the allocation, and if it is no longer `starting` answer `not_startable`. Otherwise `markWriterStarted` with this epoch and pod UID. W-018 refuses any second pod here too. Until step 5 commits, the workspace is `active` under a `starting` allocation; the reconciler accepts that when the owner is this allocation's `pod_uid`.
  5. Locked: `starting → running`, heartbeat and lease set, capacity row to `active`. If the allocation was stopped in the meantime this fails: the answer is `not_startable`, and the workspace is settled as described above.
  6. Only now answer `granted`, with generation, epoch, the 60-second lease and the 10-second beat. The workspace is `active` before any harness can be told to start.
- A crash between steps is repaired by the same pod calling again. If that pod dies instead, the start deadline stops the allocation.
- Denials after a good review are typed and audited: `not_this_job`, `duplicate_writer`, `no_receipt`, `stale_epoch`, `not_ready`, `not_startable`.
- `renewPermit`, after its own review and pod read: one `UPDATE` where id and epoch match, `pod_uid` equals the reviewed UID, state is `running` or `suspect`, and the lease has not passed on `clock_timestamp()`. It sets the heartbeat, puts the lease 60 s ahead and turns `suspect` back to `running`. No row updated is a typed denial; `stopping` is how a supervisor learns of a cancel.
- **The clock.** Every age and expiry is computed in SQL with `clock_timestamp()` after the lock is held. `now()` is the transaction's start and is stale after a lock wait. `Date.now()` is forbidden by lint in controller code.

Capacity stand-in (A-30), inside the allocate transaction:

- Pool `verifier` for the verifier role, `authoring` for the rest, by `stage_run.role`; limits 10 and 10 per organization (`11-platform-operations.md:43`), from config.
- **One row per allocation.** The table allows one row per stage run and pool key (`0005_operations_delivery_ledgers.sql:124`), and the runtime role cannot update `slots`. So the key is `<pool>/g<generation>`, and a pool's count is the rows whose key starts with `<pool>/`. A second generation does not overwrite the first one's row.
- Take `pg_advisory_xact_lock` on a hash of organization and pool, count that pool's unexpired `reserved` and `active` rows, and refuse with `capacity_unavailable` at the limit. Nothing is written and nothing queues.
- Otherwise insert the row as `reserved`, expiring at the wall cap plus 300 s plus the start deadline; the wall cap is bounded above. It becomes `active` with the permit and `released` with `terminated`. On `quarantined` it is left to expire, and it still counts until then, because nothing proved the pod stopped. W-088 replaces all of it.

`KubeApi` port (`src/kube/api.ts`): only what the controller uses.

- `createJob`, `getJob`, `listJobs`, `deleteJob`; `listPods`, `getPod`, `deletePod`; `createPvc`, `getPvc`, `listPvcs`, `deletePvc`; `reviewToken`; `getStorageClass`. Every list takes a label selector and is paged at 50, at most 10 pages, and says when it stopped at the cap.
- A delete takes a name and a UID precondition and nothing else. Propagation is always Background and grace is always 15.
- No watch, no namespace or service-account call, no delete-collection, no exec, no patch. Namespaces and service accounts are static manifests.
- One error type with the HTTP status and the Kubernetes `reason`. **409 is branched on `reason`:** `AlreadyExists` leads to fetch and validate; `Conflict` on a precondition means not ours. A 404 on a precondition delete means already gone. A timeout on a create is an unknown outcome: read by name before trying again.
- `HttpsKube`: `node:https`, client certificate or bearer token, a pinned CA, a 10-second deadline per request, a 4 MiB response cap, no redirects. The Job and the PVC are built by typed code (D8) from `examples/kubernetes-job.json`, with an init container added and `terminationMessagePolicy: File` on every container. At start it reads the storage class and refuses one whose reclaim policy is not `Delete`.

`FakeKube` (`src/kube/fake.ts`) implements the port in memory and must pass the conformance suite.

- It models: the two 409s, 63-byte names, label selection, UID preconditions, a Job delete that orphans pods unless Background is sent, `ReadWriteOncePod` and `ReadWriteOnce`, `WaitForFirstConsumer`, PVC protection while a pod uses the PVC, token review bound to a pod and an audience with a short memory of successes, per-container termination messages cut at 4,096 bytes, `activeDeadlineSeconds`.
- Fault controls: die after a create and before the answer, `AlreadyExists` with a foreign UID or foreign annotations, a duplicate pod for one Job, a lost pod, a delayed delete, a Job marked `Failed` while a container still runs, an injected error or timeout on any call.
- Its test driver, not the port, offers a raw Job delete with no propagation policy and a force delete of a pod. Both behave as on a cluster: the first leaves the pod running with no owner, the second removes the pod object while its process is still alive.
- **Fake kubelet** (optional): runs each container as a local child in its own process group, init containers first and in order. On pod delete it sends TERM to every container at once, keeps the pod visible with a deletion timestamp until all have exited, and sends KILL at the grace period. `close()` kills every group and waits for it before a test may drop its database or its directories. Images map to programs: W-017 registers the real materializer entry and the stubs, W-019 the real supervisor.

Pod executor for `GitMaterializer`, in two phases:

- **Phase one, in the `desired` pass.** The controller calls `materializationRequest` and puts the answer in the init container's arguments. It holds no secret: W-018 refuses clone URLs that carry credentials.
- **In the pod.** `src/pod/materialize-entry.ts` runs W-018's `LocalMaterializer`, unchanged, as the harness user. Init containers finish before any other container starts, so it is alone on the volume.
  - Its root is a subdirectory it creates itself, `/workspace/factory`, mode 0700. The mount point of a provisioned volume is usually group- or world-writable, and W-018's `assertSafeRoot` would refuse it.
  - On TERM it aborts; W-018's Git runner kills the process group and waits; the staging path is removed; it exits non-zero inside the 15-second grace.
  - It writes one JSON line to its termination message: `factory-pod-materialization/1`, then either the receipt, and exits 0, or a refusal code with a message of at most 512 bytes, and exits non-zero.
  - The `file` transport is a property of the test image, which has its own entry file (A-31). No argument or environment variable of the Job can switch it on.
- **Phase two, in the runner: the receipt rules** (`src/pod/receipt.ts`).
  - Only the `materialize` init container's status is read. A termination message is per container, so the harness cannot write this one; the harness container's own message is never parsed.
  - The policy is `File`, pinned. With the fallback policy, a failed step's log tail, which carries Git and remote output, would arrive as the message.
  - **A receipt counts only with exit code 0, and a refusal only with a non-zero one.** Either mismatch is `receipt_inconsistent`.
  - The message is capped at 4,096 bytes before parsing and must have exactly the expected keys, with fixed-length hex values. It then goes to `acceptMaterialization`, which checks generation, epoch and commit under the row lock.
- **No repair in place.** A generation whose pods are lost before a receipt is accepted is abandoned: the next `startOrAttach` goes through `replaceWriter` to a new generation and a new PVC. The runner cannot see the old volume, so it does not guess.
- **Sources in W-017:** `remote` requests only. A `bundle` request (verifier copies, restores) is refused as `not_supported` until there is a scoped way to read an artifact from a pod (D13).
- `PodVolumeMaterializer.remove(target)` is what W-018's `release` calls, and it is the **PVC delete the README hand-off asks for**:
  1. If the workspace has a live allocation, answer `absent: false`. The runner supplies this one read-only lookup; the class has no other database access. W-018 lets an `allocated` workspace go to `releasing` whatever its allocations are (`manager.ts:329-341`), so the check has to be here. It is sound because once `releasing` is committed the allocate step refuses the workspace, and its live allocations can only stop.
  2. If a pod carrying the workspace and generation labels still exists, answer `absent: false`.
  3. Read the PVC by its derived name. Ownership labels that do not match: `absent: false`, and nothing is deleted. Otherwise delete it with the observed UID as precondition, and read until 404 or 30 s. A PVC still present with a deletion timestamp is `absent: false`.
  4. List PVCs by the workspace label. Any left, of any generation: `absent: false`. None: `absent: true`.
  - `materialize` on this class is a typed `not_supported`: in pod mode the clone is a step of the Job, not a call.
- **The order for callers** is cancel, wait for `terminated`, then release through the facade. The facade refuses with a retryable `allocation_live` while the workspace has any live allocation; this is what stops a release that races a start, and it is checked again inside `remove`. After `terminated`, a workspace that never had a writer is released. One that had a writer is `retained`, and its release answers `checkpoint_not_accepted`, which is **not** retryable until W-020.
- **One PVC per workspace generation**, `ReadWriteOncePod`, no owner reference, created before the Job. Older generations' PVCs are not deleted here (D15).

Defaults chosen here and not taken from the spec, all in `src/config.ts`: start deadline 600 s, stop
deadline 180 s, request deadline 10 s, inline reconcile budget 20 s, three generations, three
allocate restarts, a wall cap of 7,200 s, a 2 Gi PVC, the review rate cap, namespace
`factory-exec-local`.

### Files

| File | Content |
| --- | --- |
| `apps/runner/package.json`, `README.md` | Package `@factory/runner`, exports `.` and `./testing`. |
| Entry in `tools/boundaries.json` | `allowWorkspace`: contracts, domain, database, artifacts, workspace, test-support. `denyExternal`: `["@temporalio/", "fastify"]`. |
| `src/config.ts`, `src/index.ts`, `src/main.ts` | Validated configuration; exports; the process entry that runs the loop. Not added to `pnpm dev` (D9). |
| `src/runner.ts`, `src/start.ts`, `src/workspaces.ts` | The `Runner` service; start-or-attach; the workspace facade and `settleWorkspace`. |
| `src/reconcile.ts`, `src/states.ts`, `src/quiescence.ts` | Passes and loop; the edge table and the `RunHandle` mapping; the proof. |
| `src/permit.ts`, `src/capacity-standin.ts` | Permits and the review rules; A-30. |
| `src/names.ts`, `src/job-manifest.ts` | Names, labels, annotations and their committed vectors; the pure builders for the Job and the PVC. |
| `src/kube/api.ts`, `src/kube/https-client.ts` | The port and its error type; the client. |
| `src/kube/fake.ts`, `src/kube/fake-kubelet.ts`, `src/testing.ts` | The fake tier, exported as `@factory/runner/testing`. |
| `src/pod/receipt.ts` | The termination-message format and the receipt rules, shared by both ends (17a). |
| `src/pod/materialize-entry.ts`, `src/pod-volume-materializer.ts` | The pod executor; PVC removal (17b). |
| `packages/workspace/src/manager.ts`, `README.md` | **D17:** `markWriterQuiescing`, `markWriterStopped`; the README's state text (17a). |
| `packages/database/src/allocation.ts` | Row operations: insert, lock, guarded transition, heartbeat and deadlines on `clock_timestamp()`, capacity rows, the cancel record, runner audit rows. Existing runtime grants only. |
| `packages/test-support/src/faults.ts` | Named fault points (stand-in for W-079): `runner.in_allocate_tx`, `after_allocate_commit`, `after_pvc_create`, `after_job_create`, `after_job_bind`, `after_permit_claim`, `after_writer_started`, `before_permit_commit`, `after_job_delete`, `after_pvc_delete`. |
| `deploy/k8s/` | Plain manifests (D8): the namespace with Restricted pod security, two service accounts, the runner's Role and binding, and a ClusterRole for token review and storage-class read. The supervisor's account gets no Role at all. NetworkPolicy, admission policy and LimitRange stay with W-021. |
| `deploy/images/` | Containerfiles: `materializer` (Node, Git 2.48 or later, the entry), `materializer-test` (its own entry and a fixture bare repository reached by `file://`, A-31), `stub`. |
| `scripts/k3s.sh` | `up`, `down`, `status`. |
| `vitest.config.ts`, `vitest.k8s.config.ts`, root `package.json`, `eslint.config.js`, `.gitignore` | The exclusion, the opt-in config, `test:k8s`, the two lint rules, `.k3s/`. |

Not changed: anything under `apps/worker`, and any migration. In `packages/workspace` the only
edits allowed are the two methods of D17 with their README text, and, if the image needs one, a
narrower export line.

### Tests

Fake tier: `apps/runner/test`, real Postgres, `FakeKube`, real Git only where the pod executor
runs. No Temporal, no cluster. Time is moved by backdating the row's timestamps and running one
pass, never by sleeping. **Every refusal below has a control in the same setup that shows the
accepted case.** "Controller A dies" always means this: the fault makes A's pass throw, the test
stops A's loop and closes A's pool, and it asserts what A left behind before B does anything.

| Test file | Shows |
| --- | --- |
| `ac-10-duplicate-run-start.test.ts` | Two runner instances with separate pools, one database, one `FakeKube`. Twelve concurrent `startOrAttach` calls with the same run and hashes give one allocation row, one Job, one PVC and twelve equal handles. **A dies at `after_job_create`:** the row is still `desired` with no `job_uid`; B's pass gets `AlreadyExists`, validates, and the row is `starting` with the fake's UID. **Forced interleaving:** A is held between its create and its compare-and-swap while B binds the same Job; A resumes, re-reads, deletes nothing, and the Job and the `starting` row are still there. **Control:** the same hold, but the allocation is cancelled to `terminated` first; A then does delete the Job it holds. `AlreadyExists` with a foreign UID or foreign annotations is `quarantined` and nothing attaches. **Permit, two candidates:** the fake injects a second pod for the Job with an identical receipt. The two controllers run passes that read the pods in opposite orders, and neither pod is deleted. Both pods ask for the permit at once: exactly one is granted, the other is `duplicate_writer`, the workspace is `active` with the winner's UID, and the next pass of either controller deletes the loser and only the loser. **Permit, a bad duplicate:** the second pod answers `target_exists` instead; in either read order it is deleted, the allocation stays `starting`, and the first pod is granted. **Controls:** in a fresh setup the second pod alone, with its own receipt, is granted; and a lone pod that answers `target_exists` stops the allocation. |
| `ac-11-run-identity-conflict.test.ts` | A run exists with input hash A. A request with hash B is `conflict`. So is a different specHash, against a live allocation and against a terminated one, and a request whose role, node, attempt or limits differ from the row. Rows in `stage_run`, `execution_allocation`, `workspace` and `capacity_reservation`, and the fake's whole object set, are compared before and after and are identical. **Control:** the request with hash A attaches and returns the existing handle. |
| `w017-start-or-attach.test.ts` | Paused task, superseded stage run, missing budget reservation, settled budget, full pool, wall cap exceeded: each a typed refusal with nothing written, and each has its accepted twin. **A fault at `after_allocate_commit` kills A; B, which never saw the request, renders the same manifest from the rows and creates the Job.** A second `startOrAttach` after the permit attaches without error. The PVC is created first and the Job while the PVC is still `Pending`. `suspect` returns `reconciling` and no second row. After `terminated`, the next call fences through `replaceWriter` exactly once and lands on generation 2 with new names; a crash between the fence and the insert is finished by the next call without a second fence. After `quarantined` the same, with the audit row. A unique violation restarts and still answers `conflict` for a different specHash. Four forced restarts give `allocation_contended`. Generation 4 is `generation_limit`, and the workspace's epoch is unchanged by the refusal. Limits that differ only in key order are equal. A `checkpoint_ref` gives `restore_unavailable`. |
| `w017-states.test.ts` | Table-driven: every legal edge succeeds, every other pair is refused, and a stale epoch is refused on each. Heartbeat ages of 29, 31 and 61 s give `running`, `suspect` and `stopping`. With the process clock set an hour ahead the same three results hold; the test first shows that the two clocks really differ. A `finalizing` row is unchanged after a pass. The `RunHandle` mapping, including both meanings of `terminated`. |
| `w017-cancel-quiescence.test.ts` | Cancel sends the Job delete with Background and the pod delete with 15 s. With the fake kubelet and a container that ignores TERM, the allocation stays `stopping` and the workspace `quiescing` while the pod is terminating; after KILL the workspace is `retained` and then the allocation `terminated`. A Job marked `Failed` while a container still runs stays `stopping`. A labelled pod with no owner is counted and deleted; one with a foreign owner keeps the proof open, then `quarantined`. A pod list at its cap is not proved. With no `job_uid`, a Job found by name is validated and deleted by its UID, and `terminated` waits until `updated_at` is 10 s old. No proof by the deadline is `quarantined` with `needsOperator`, and the workspace stays `quiescing`. **Cancel before start:** a cancel with no allocation returns generation 0, and a later `startOrAttach` is `run_cancelled` with no row and no request at the fake. With the two held at the stage run's lock in either order, the result is a stopped allocation or no allocation, never a running one. A Job created late is deleted by the next pass when its allocation is `terminated`, `stopping` or `quarantined`; an unrecorded Job of a `desired` allocation is bound instead. The cancel record has the pinned id and fields; a denied cancel leaves a row that the lookup does not count; a foreign row at the pinned id is a hard error. A cancel after a terminal result writes no record, and both `getRun` and `startOrAttach` answer `completed`. A transition that waited five seconds for the row lock stamps `updated_at` after the wait, not before. **Controls:** the driver's raw delete leaves the pod running, and its force delete leaves the process alive. |
| `w017-permit.test.ts` | Before the database: a token for another audience, a review that is true with empty audiences, a wrong subject, an oversized token. Each is refused with **no row written anywhere**, and the counter moves. The 41st review in a burst is `throttled`; a failed token is not reviewed again within 10 s. After a good review: a pod of another Job, a pod with a deletion timestamp, stale epoch, an init step still running, a terminated allocation; each its own audited denial. **Renewal with another pod's UID in the request body and a valid token for this pod renews this pod only**; with a harness-forged request and no valid token it is refused. **Renewal with a token the fake still reviews as valid, for a pod that has been deleted, is refused** (the fake keeps a successful review for a while, as the cluster does). Renewal after expiry and after a cancel is refused. A crash at `after_permit_claim` is completed by the same pod's retry. **Crash and retry at `after_writer_started`:** the permit dies with the workspace `active` and the allocation `starting`; a reconcile pass leaves the allocation `starting` (control: with another pod's UID as owner it stops), and the same pod's retry is granted. **A stop at the same point:** the proof is read while the workspace is still `allocated`, `markWriterStarted` then lands, and `→ terminated` is refused until the pass has settled the workspace; the end state is `retained` under `terminated`, never `quiescing` or `active`. A `markWriterStarted` that lands after `terminated` is settled by the permit, and, with the permit killed, by the `release` facade. |
| `w017-receipt.test.ts` | The parser and the rules, on statuses injected through the fake. Too long, not JSON, extra keys, wrong generation, wrong commit: refused. A receipt with exit code 1 and a refusal with exit code 0 are `receipt_inconsistent`. Log-like text in the message is refused. A message on the harness container that is a perfect receipt is ignored. **Control:** the well-formed receipt with exit 0 is accepted and linked. |
| `packages/workspace/test/w017-writer-stop.test.ts` | The two new transitions: the right source state, runner identity, task scope, epoch and pod UID are each required, with an audit row on an identity refusal. `allocated → quiescing` and `active → retained` are refused. A repeat is a no-op, and so is `markWriterQuiescing` on a workspace already `retained` by the same pod. `release` of `quiescing` is `writer_active`; of `retained` without a checkpoint, `checkpoint_not_accepted`. `replaceWriter` from both still fences. |
| `w017-authz.test.ts` | Every `Runner` and facade method refuses an identity that is not configured, a caller with no task scope, another task's scope and another organization, with an audit row each. The facade's `allocateOrAttach` creates the row for a configured caller, and refuses a role that is not the stage run's. |
| `w017-session-lost.test.ts` | The allocate transaction's backend is terminated while a fault point holds it open: the call fails with the session's error, no row exists, the fake saw no request, and the retry succeeds. The same in the permit: `pod_uid` stays null. A pass that loses its session does not stop the loop. |
| `w017-capacity-stand-in.test.ts` | Twelve concurrent calls on a pool of ten: exactly ten succeed. An eleventh is `capacity_unavailable` with nothing written; it succeeds after one allocation is `terminated`. After a `quarantined` generation, the stage run's next generation has its own row and the pool counts both. |
| `w017-names-manifest.test.ts` | Committed vectors for the three names; 63 bytes at the largest generation; an over-long input is refused by its cap before hashing. **The builder's signature takes no `StageInput`**, and its output for fixed rows equals a committed document. Every container has limits, a read-only root, dropped capabilities, no automounted token and `terminationMessagePolicy: File`; grace 15; `backoffLimit: 0`; a deadline of the wall cap plus 300. The PVC is `ReadWriteOncePod` with no owner reference. |
| `w017-kube-client.test.ts` | `HttpsKube` against a local `node:https` server with a throwaway CA: both kinds of authentication, a wrong CA refused, the deadline, the body cap, no redirect followed, 409 branched on `reason`, the page cap reported, and every delete carrying Background or grace 15. |
| `kube-conformance.fake.test.ts` | The shared suite below, on `FakeKube`. |
| `w017-pod-materializer.test.ts` (17b) | Fake kubelet, the real entry, real Git, a temporary directory as the volume. The init step clones, the receipt is accepted, the permit follows, the workspace is `active`. A missing commit gives a refusal with a non-zero exit, `stopping` then `terminated`, the workspace still `allocated`, no permit. A lone pod that answers `target_exists` stops the allocation. A pod deleted mid-clone leaves no Git process (the process was seen alive first). The production entry refuses a `file://` remote whatever its arguments say; the test entry accepts it. A `bundle` request is `not_supported`. |
| `w017-release.test.ts` (17b) | **(a)** A writer on generation 1 is cancelled. While `quiescing`, release is `writer_active`. Once `retained`, release without a checkpoint is refused and the PVC is still there. With the checkpoint seeded, release deletes the PVC named for generation 1, by its UID; the row is `released` and the fake holds no PVC with the workspace's label. **(b)** Generation 1 is lost and replaced; generation 2's writer is cancelled, `retained` and released. The first PVC deleted is generation 2's, the one with the work. The row stays `releasing` with `needsOperator` while generation 1's PVC exists, and becomes `released` once it is removed; then no PVC is left. **(c)** No proof: `quarantined`, the workspace `quiescing`, release refused, both objects untouched. **(d)** Cancelled before any permit: release from `allocated` deletes generation 1's PVC. **(e)** A release that races a start: with a live allocation the facade answers `allocation_live`; with W-018's `release` called directly at that moment, the row goes to `releasing`, `remove` answers `absent: false`, the allocation stops, and only then does a retry reach `released` with no PVC left. A foreign PVC under our name is never deleted. |

**Conformance suite.** `apps/runner/test/conformance/suite.ts` exports one function that registers
the assertions against a `KubeApi` and a small driver (raw requests, waits and a process check that
the port does not offer). Two files call it: the fake one above and `kube-conformance.k8s.test.ts`.
Fake-only faults (a duplicate pod, a lost node) are not in it and are never reported as cluster
evidence.

| # | Behaviour asserted on both tiers | k3s status |
| --- | --- | --- |
| 1 | A second create of a Job name is 409 `AlreadyExists`, and the first UID is still there. | Verified, section 2 |
| 2 | A 63-byte name is accepted and a 64-byte one refused. | Verified |
| 3 | A Job delete with Background ends its pods. **Control:** a raw delete with no policy leaves the pod running with no owner. | Verified |
| 4 | A pod with two containers, one that exits on TERM and one that ignores it: the first shows `terminated` while the pod is still listed with a deletion timestamp, and the pod is gone at about 15 s. | Verified with one container; two to confirm |
| 5 | A second pod on a `ReadWriteOncePod` PVC stays `Pending`. **Control:** on `ReadWriteOnce` both run. | Verified |
| 6 | A PVC with no pod stays `Pending`; it binds once a pod is scheduled. | Verified |
| 7 | A PVC with no owner reference survives its Job's delete. Deleted while in use, it stays with a deletion timestamp until the pod is gone. | Second half verified; first half to confirm |
| 8 | A delete with a wrong UID is 409 `Conflict`; with a precondition on an absent object, 404. | Verified |
| 9 | After its pod is deleted, a `backoffLimit: 0` Job gets no replacement pod. The proof reads the same from pod status whichever of Job `Failed` and container exit is seen first; the order is recorded. | First half verified; order to confirm |
| 10 | With `terminationMessagePolicy: File`: an init container's message and exit code are in the pod status while the app containers run; a longer message is cut at 4,096 bytes; a failed step that wrote only to its log has an empty message. | Verified, step 0 |
| 11 | A token bound to a pod with audience A reviews as authenticated for A, lists A in `status.audiences`, and carries the pod's name and UID. It fails for audience B and for no audience. After the pod is deleted, a token not reviewed before fails at once, and one reviewed just before fails within 30 s. | Verified, step 0 |
| 12 | `activeDeadlineSeconds` ends the pod and the Job reports `DeadlineExceeded`. | To confirm |
| 13 | Every call the suite makes succeeds under the runner's Role. The k3s run uses the runner's service-account token; the admin certificate is for the driver only. **The supervisor's service account is refused a patch of `pods/status`**, and a read of any pod. | Runner's Role to confirm; the supervisor half verified by an RBAC check, step 0 |
| 14 | Driver only: a force delete removes the pod object at once while its process is still alive. This is why the port has no grace parameter. | Verified |

**k3s tier, opt-in.**

- `scripts/k3s.sh up` starts the pinned image from section 2 with the same flags and limits (privileged, 2 CPUs, 1,800 MB; traefik, servicelb and metrics-server off). It publishes the API on `127.0.0.1`, applies `deploy/k8s`, waits for the service accounts to exist, builds the three images, loads them with `ctr images import`, and writes `.k3s/env`: server, CA, the runner's token, the admin certificate.
- `pnpm test:k8s` is `vitest run --config vitest.k8s.config.ts`: `include` is `**/*.k8s.test.ts`, one worker, no file parallelism. Its global setup fails with one line if the cluster or the compose Postgres does not answer. **A missing cluster is a failure, never a skip.**
- `vitest.config.ts` gains `exclude: ['**/*.k8s.test.ts']`, so `pnpm test`, and therefore `pnpm check`, never runs them. `tools/test/k8s-exclusion.test.ts` asserts that the default configuration selects no such file while at least two exist on disk.
- `w017-run.k8s.test.ts` runs the real controller on the cluster. Two runner instances and one run give one Job and one PVC. The init container clones the fixture and its receipt is accepted. A token minted for the running pod through the TokenRequest API is granted the permit; the same call with a token for another pod is refused. A hand-made second pod on the PVC stays `Pending`. Cancel ends the pod inside the grace period, the workspace is `retained` and the PVC survives. Release is refused without a checkpoint; with one seeded it removes that generation's PVC, no PVC with the workspace's label is left, and the backing directory is gone.
- It is run once at the end of 17b and at each review, never beside the full suite and not on battery. The build-log line gives the date, the image digest and the result.

### What W-017 claims, and what it does not

- **AC-10.** One accepted allocation and one Job when two controllers receive the same run, with the second attaching: fake tier and k3s. One permit winner between duplicate pods at the runner's interface: fake tier. A duplicate pod cannot mount the PVC: k3s.
- Not claimed for AC-10: a real duplicate supervisor that exits without touching the workspace (W-019), and the same run through the Activity (W-023). On a real cluster duplicate pods come from node loss or partition, which neither tier can produce.
- **AC-11.** Conflict on a different input hash or specHash at the runner's interface, with nothing altered or attached: fake tier. The Job-level half (`AlreadyExists`, then validate the binding): fake tier and k3s. Through the Activity: W-023.
- Built here but claimed elsewhere: the ownership labels, annotations and attach checks that **AC-233** inspects (W-134); the observation that **AC-12** and **AC-15** need for volume reuse and tree stop (W-019); the PVC removal that **AC-43** sweeps with (W-024).
- Not built: the supervisor and any real harness; a network listener; result acceptance and `completed`; `finalizing` and checkpoint Jobs; the checkpoint request on cancel; `watchEvents`; bundle sources in pods; a Git credential in a pod (the remote is a fixture, A-31); any way to make the accepted checkpoint that lets a `retained` workspace go (W-020); deletion of older generations' PVCs and the general orphan sweep (W-024); queued admission (W-088); NetworkPolicy and admission policy (W-021); anything on a real cluster (D4).
- Residual risks, stated in the README:
  - Someone with cluster rights who force-deletes a pod can make "no pod" untrue. The runner's Role is the only delete right in the namespace; an admission rule against grace 0 is a question for W-021.
  - Kubernetes itself removes the pods of a node that has been deleted (pod garbage collection), while that node's processes may still run. This is from the Kubernetes documentation and was not tested; a single-node cluster cannot show it. On a real cluster the proof must also read the node, which belongs to the D4 qualification and to W-019's detachment check.
  - **A paused controller.** The re-read before each create narrows the window between "the row is `desired`" and the create; it cannot close it, because Kubernetes checks no fencing value of ours. A controller that sleeps there can create a PVC and a Job for an allocation that has since been stopped. The Job can never get a permit and is deleted by the next pass of any controller. **The PVC is not covered.** If the workspace was released in the meantime, the late create leaves a labelled PVC under a `released` row, and nothing in W-017 removes it. It holds at most a fresh clone. W-024 finds it by label.
  - "Released" means the PVC object is gone. Removal of the bytes is the storage class's reclaim, checked on k3s only.

Hand-offs:

- **W-019:** the listener the supervisor calls; the supervisor side of both permit calls; the durable proof built from `PodObservation`. Volume reuse is the PVC-name function called with the older generation. **The full `StageInput` is not stored anywhere**; the supervisor needs it, so W-019 or W-023 must persist it as an artifact the runner can serve.
- **W-020:** the accepted checkpoint is what lets a `retained` workspace be released. W-018's TODO still stands: bind the checkpoint to the workspace, generation and epoch.
- **W-021:** `apps/api/src/auth/capability-proxy.ts:59` treats `starting` as live. After W-017 `starting` means "Job bound, no permit", so it should narrow to `running`.
- **W-023:** the runner client. Call the facade's `allocateOrAttach` before `startOrAttach` (SI-26). `terminated` without a cancel reports `reconciling`, and the answer is another `startOrAttach`. A cancel always succeeds and always blocks later starts, unless the run already has a result; send it on every non-semantic path, before the budget is charged. Release through the facade after `terminated`: `allocation_live` and `writer_active` are retryable, `checkpoint_not_accepted` is not until W-020. Until W-020 or W-024, every workspace whose writer was stopped keeps its 2 Gi PVC, so the cleanup rule must record it as an obligation and not wait for it. The new cleanup rule: `apps/worker/src/activities/outcome.ts:53` and `shared.ts:80` still count allocation rows, and until W-023 only tests create them.
- **W-024:** find by label. Older generations' PVCs, PVCs and Jobs of allocations with no live row, `retained` workspaces past their retention and `quarantined` rows are its work.

### To confirm in the k3s tier

The two items the design rests on are no longer here: step 0 settled them. None of the nine below
was run. Each has a test above that settles it, and a different answer changes the named design
point and nothing else.

1. The owner and mode of a `local-path` volume's mount point under `fsGroup`, and that the 0700 subdirectory satisfies `assertSafeRoot`.
2. A Node-sized image: import time, and memory inside the 1,800 MB node. Section 2 tested only a trivial image.
3. Git 2.48 or later in the materializer's base image.
4. `local-path` removes the backing directory after the PVC is deleted.
5. A PVC with no owner reference survives a Background Job delete (conformance 7).
6. `activeDeadlineSeconds` behaves as the builder assumes (conformance 12).
7. The runner's Role is enough for every port call (conformance 13).
8. TERM reaches both containers of a pod at once (conformance 4).
9. The order of Job `Failed` and container exit. Recorded only; the design does not depend on it.

Also still open from step 0: the token there was minted through the TokenRequest API. A token read
from the projected volume of a real allocation pod is first reviewed in `w017-run.k8s.test.ts`.

### Owner decisions, assumptions and spec issues

Decisions D12 to D18 are in section 3. D17 is decided. The others have defaults, and none blocks
the start.

Assumptions W-017 writes to `docs/assumptions.md`:

- **A-25** to **A-28**, as reserved in D2 and D3. In W-017, A-25 is one execution namespace (`factory-exec-local`), one supervisor service account, and pod identity by token review; A-27 is the stub containers.
- **A-30**: the capacity stand-in above, with its per-generation pool key.
- **A-31** (new; stands in for INT-02 and W-021): the pod materializer clones a fixture repository inside a test image over `file://`; no Git credential exists in any pod; `bundle` sources are not served to pods.

Spec issues W-017 records in `docs/spec-issues.md`: SI-13 and SI-14 from the earlier list, and
SI-19 to SI-26, all in the table in section 6.

### Definition of done

- **Step 0:** done (section 2, third session).
- **17a:** the fourteen fake-tier files that need no pod executor pass (thirteen in `apps/runner/test`, one in `packages/workspace/test`), W-018's own nine still pass, and `pnpm check` is green. Independent review.
- **17b:** `w017-pod-materializer.test.ts`, `w017-release.test.ts` and the exclusion test pass, and `pnpm check` is green. `pnpm test:k8s` passes once on this machine on AC power, with the nine items above each marked confirmed or answered. Independent review.
- AC-10 and AC-11 are logged with the exact halves above and the tier of each, naming W-019 and W-023 for the rest. The k3s run's date and image digest are in the same line.
- No file under `apps/worker` changes; no migration is added; no dependency is added. The diff in `packages/workspace` is the two methods, their test and the README.
- `docs/assumptions.md` has A-25, A-26, A-27, A-28, A-30 and A-31. `docs/spec-issues.md` has SI-13, SI-14 and SI-19 to SI-26.
- The READMEs state the three rules, which part runs where, the allocation and workspace state tables, the permit steps, the receipt rules, the two phases, the residual risks, the release order (cancel, wait, release) and what is not built.
- Nothing is left behind by either tier: each test file checks its namespace and its process groups at teardown.

## 6. Risks

### Temporal replay, and the W-023 design constraints

- Every committed history records the Activity type `executeFakeStage` (`apps/worker/src/workflows/stage-execution.ts:110` and `:135`). W-023 adds `startOrAttachExecution`, `awaitExecution` and `cancelExecution` behind `patched('runner-v1')`, after `authority-v1`. `executeFakeStage` stays registered so open histories finish on the new worker (AC-09).
- **Executor selection is a local field on `PlanSnapshot`**, `executor: 'fake' | 'runner'`, set by `resolvePlan` from a code table keyed by template id and version; absent means fake. It cannot go in the template: `PlanNode` is `additionalProperties: false` and `resolvePlan` validates every template against `WorkflowTemplateDefinition` (`apps/worker/src/activities/plan-resolution.ts:31`). I did not use `requiredCapabilities`: no chapter defines what that field means, so using it would invent contract semantics.
- **Amendments stay on the task's template version.** Today an amendment re-resolves through the per-work-type default (`plan-resolution.ts:16`, `:28`; `workflows/amendment.ts:29`), so moving the default would switch an in-flight task's runner. `resolvePlan` for plan version 2 and later must read the template id and version from the task's previous `execution_plan` row. This is an Activity change with no new workflow command. Test: change the default, amend an older task, and it keeps its template and its executor.
- **Cleanup on every non-semantic path.** Today, when the stage Activity fails outright the workflow records `infrastructure_error`, settles the budget and moves on (`stage-execution.ts:112-121`); with a real Job the writer would keep running. Under `runner-v1`, for runner nodes: on Activity failure, on cancellation, and before the workflow itself fails, run a non-cancellable `cancelExecution` with the Cleanup limits (120 s, 20 min, 8 attempts; `04-temporal.md:87`) **before** the stage is finished and charged. A workflow that is terminated gets no such chance; W-024 is the backstop, which is why it now precedes the checkpoint.
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
| SI-19 | `06-runner-workspaces.md:13`, `:23`; `schema.sql` `execution_allocation.controller_lease_until` | Step 3 records "a controller lease" and the supervisor has a 60-second lease, but there is one timestamp column, no column naming a holder, and nothing says which lease the column is. | One deadline, that of the current phase: the start deadline in `desired` and `starting`, the writer's lease in `running` and `suspect` (each accepted heartbeat puts it 60 s ahead), the stop deadline in `stopping`. Controllers do not exclude each other by it (section 5, rule 2). |
| SI-20 | `contracts/interfaces.ts:84`; `06-runner-workspaces.md:90`; `schema.sql` `execution_allocation` | `cancel` carries a command id and a reason and "sets desired cancellation", but the row has no column for either, `stopping` does not say why, and a cancel can arrive before any allocation exists. | One cancel record per stage run, as an `audit_event` row written under the stage run's lock, with or without an allocation (D18). The allocate step refuses after it, and SI-14's `cancelled` reads it. The stop reason is a second, diagnostic audit row. |
| SI-21 | `06-runner-workspaces.md:5`, `:14`; `contracts/interfaces.ts:81` | `specHash` is "immutable" and compared, but nothing defines what it is a hash of or who computes it. | Opaque to the runner: 64 hex from the caller, bound by the first allocation, compared on every later call. W-023 defines its contents. The runner separately annotates a digest of the manifest it rendered, for diagnosis only. |
| SI-22 | `06-runner-workspaces.md:11`; `04-temporal.md:57`; `schema.sql` `stage_run` | Step 1 says "insert or lock the stage_run row", but the workflow persists run intent first, and the row needs an `input_ref` that `StageInput` does not carry. | The runner locks only. An unknown logical id is refused. |
| SI-23 | `StageInput.workspaceId`; `execution_allocation.workspace_id`; `contracts/interfaces.ts:95-96` | An allocation and a stage input each name one workspace, while `materializeCandidate` returns one per repository. Nothing says the allocation's generation and epoch are the workspace's. | One workspace per allocation, which takes the workspace's generation and epoch when it is allocated. A multi-repository verifier run needs an answer in W-022. |
| SI-24 | `06-runner-workspaces.md:16`, `:110`; `examples/kubernetes-job.json`; `execution_allocation.supervisor_identity` | The writer claim must be "pod-specific" and the identity "allocation-specific", but the example uses one fixed audience, and no chapter says how the runner learns which pod is calling or what `supervisor_identity` holds. | A projected token with the audience `factory-allocation:<org id>:<allocation id>`, checked by token review on every call; the review must list that audience; pod name and UID come from the token's binding and from nowhere else; the pod is then read, and must exist and be owned by the allocation's Job. The column holds the expected service-account subject. Probed on k3s (section 2, third session): it holds, except that a review stays valid for some seconds after the pod is deleted, hence the pod read. |
| SI-25 | `06-runner-workspaces.md:13-14`, `:59`; SI-17 | SI-17's trusted first step has no stated way to return its result: pods cannot reach the database, and the step holds no identity. | The init container's termination message under `terminationMessagePolicy: File`, read by the runner from pod status and accepted in a second phase: a receipt only with exit code 0. Probed on k3s (section 2, third session): it holds. |
| SI-26 | `StageInput.workspaceId`; `06-runner-workspaces.md:5`; `contracts/interfaces.ts:88-91` | A stage input names a workspace, but no chapter says who allocates the row or where its repository, base commit, branch and setup profile come from. W-018's `allocateOrAttach` accepts only the runner identity. The full `StageInput` is also stored nowhere, though a supervisor will need it. | The runner exposes `allocateOrAttach` and `release` to control-plane callers and calls the manager with its own identity. W-023's Activity allocates the workspace before it starts the run. Persisting the stage input is W-019's or W-023's. |

## 7. Response to the adversarial review

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

Round 3 (the W-017 brief only; verdict no-go). Each item was checked against the code and the spec before it was taken. All four blockers and all thirteen should-fix items are taken in section 5:

| Review item | Disposition |
| --- | --- |
| Blocker 1: the bind deletes the Job it just bound | Taken. After a failed compare-and-swap the row is re-read, and the Job is deleted only if the row records another UID or is no longer live. Forced-interleaving test and its control are in `ac-10`. |
| Blocker 2: release is impossible after a writer started | Confirmed at `manager.ts:64-65`, `:329`, `:345`. Taken as the owner decided (D17): two transitions in `packages/workspace`, called from one helper on the quiescence proof. One thing follows that the review did not ask for: `release` of `retained` still needs an accepted checkpoint (`manager.ts:334`), so until W-020 such a workspace stays `retained`, and tests seed the checkpoint. I also made "no PVC under a released row" a rule of the PVC removal, which changes D15's consequence. |
| Blocker 3: the manifest cannot be rebuilt, and attach throws | Confirmed at `persistence.ts:22` and `manager.ts:137`, `:140`. Taken. The builders take rows and config only, and `materializationRequest` has one call site, in the `desired` pass. |
| Blocker 4: a start after a cancel orphans a Job | Confirmed at `budget.ts:143`. Taken: a cancel record per stage run, written and read under the stage run's lock, and a settled budget also refuses. Stored in `audit_event`, not a new table (D18). |
| Should-fix 1: a duplicate pod stops the allocation | Taken: the governing pod, and "best pod, not worst" before the writer claim. |
| 2: renewal must review the token | Taken. Both calls review every time, and the pod UID comes only from the review. |
| 3: audiences, and audit rows from unauthenticated calls | Taken. The review must list the audience; nothing is written before a good review; reviews are rate-capped. The organization now comes from the audience, so it is known only after the review. |
| 4: holes in the proof | Taken: every labelled pod counts, a list at its cap is not proved, and with no `job_uid` the Job is read, validated and deleted by its UID. |
| 5: termination message | Taken: policy `File` pinned, a receipt only with exit 0, no message text in `PodObservation`, the supervisor's account checked. The probe's control showed the fallback policy does return a log line as the message. |
| 6: capacity | Taken with a different mechanism: a pool key per generation, because the runtime role cannot update `slots`. A new generation after `quarantined` is stated as intended, with the spec lines. |
| 7: only the binding is bound | Taken: the other fields must equal the row and are read from it; the wall cap is bounded; the lock is `FOR UPDATE`; a unique violation restarts with every check. |
| 8: a paused controller | Taken as far as it can be: re-read before each create, delete a `terminated` allocation's Job on sight, and measure the wait from `updated_at`. The window cannot be closed, and the residual risk now says so and names the PVC. |
| 9: the split, and the probe first | Taken. The parser's hostile-input tests are in 17a. The probe was run during the revision, once the machine was on AC power. It found one thing neither of us expected: a successful review outlives its pod by several seconds. |
| 10: conformance | Taken: the force-delete row, and two containers in the TERM row. |
| 11: the vacuous crash test | Taken, as a rule for every "controller A dies" case. |
| 12: nobody creates the workspace row | Taken: a facade on the runner, SI-26, and a hand-off to W-023. |
| 13: small items | All taken: the restart cap, `stale_epoch` restarts, the stop deadline's column, the lock timeout, and the `file` transport fixed by the test image. |

Round 4 (the revised W-017 brief; verdict go for 17a after edits). All are made in section 5, and none changed the design:

| Review item | Disposition |
| --- | --- |
| N1: the governing pod cannot be identified | Confirmed at `materializer.ts:21` and `manager.ts:156-158`. Taken: candidates are never deleted before the writer claim, the claim's compare-and-swap picks the winner, and a bad pod is a duplicate unless it is the only pod. `ac-10` rewritten. |
| N2: the reconciler kills a permit between its steps | Taken: the trigger accepts `active` owned by this allocation's `pod_uid`. Crash-and-retry test added. |
| N2b: `quiescing` under `terminated` | Taken, first option: `→ terminated` locks the workspace `FOR SHARE` and refuses until it is settled. The release facade still settles the one case that lock cannot see. |
| N3: pin the cancel record | Taken: deterministic id, pinned fields, primary-key lookup. The index residual and the migration alternative are gone. |
| N4: the paused-controller residual | Taken: Jobs are deleted on sight in every state but `desired`, and the residual now says a late PVC create can outlive a release. |
| N5: a concurrent release | Confirmed at `manager.ts:329-341`. Taken: `remove` answers `absent: false` while a live allocation exists, and the facade refuses with `allocation_live`. |
| N6: `updated_at` | Confirmed at `packages/database/src/workspace.ts:84`. Taken: the allocation helper writes `clock_timestamp()`. |
| N7: the facade's role | Confirmed at `manager.ts:205`, `:216-217`. Taken: a mismatch with `stage_run.role` is refused. |
| Small items | All taken: `retained` counts as done for `markWriterQuiescing`; `generation_limit` before the fence; a cancel after a result writes nothing; the W-023 hand-off; canonical comparison of limits. |

## Confidence

- **Verified by running or reading today:** the package list, order, dependencies and acceptance IDs; every row of the section 2 table; the hard-link and relative-worktree behaviour of Git 2.50.1; the code and schema facts cited in sections 4 and 5.
- **Inferred, not tested:** that kind and k3d offer nothing extra here; the size column; the reader's 3–5 days; that durable capability counters fit without a new table (a W-021 design question); the SI-13 and SI-14 choices.
- **Measured on one cluster only:** the network-policy start-up window. It says nothing yet about any other CNI.
- **Section 5 (W-017), verified by reading today:** the `execution_allocation` columns, indexes and grants and the conclusion that no migration is needed; W-018's interfaces as committed; the boundary rule that apps are not importable; the worker's stage-run insert, input hash and budget key; the spec lines cited.
- **Section 5, run on k3s in the third session:** the termination-message receipt and the pod-bound token review, which the design rests on. One assumption of mine was wrong and is corrected: a review does not fail the moment its pod is deleted.
- **Section 5, inferred and not run:** the nine items listed as "to confirm in the k3s tier". The 8-to-10-day estimate is a judgement. That `settleWorkspace` covers every interleaving of a permit and a stop is argued in the brief and tested at two fault points; it is the part I would ask the next review to attack first.
