# M2 plan: isolated execution

Revision 6, 2026-11-18. Written against spec rev 1.13. Planning only; no source changed.
Revision 2 answered the adversarial review of revision 1; revision 3 reworks the W-018 brief after its own second review. Section 8 lists what changed and what was not taken as written.
Revision 4 adds the W-017 brief as section 5, with decisions D12 to D16 and spec issues SI-19 to SI-25. The old sections 5 and 6 are now 6 and 7.
Revision 5 reworks the W-017 brief after its first review (no-go: four blockers, thirteen should-fix items, all taken), records the owner's decision D17, adds D18 and SI-26, and adds the results of a third k3s session that probed the two behaviours the brief rests on. A second review passed it for 17a subject to edits N1 to N7 and five small ones, which are made in section 5 (section 8, round 4).
Revision 6 adds the W-019 brief as section 6, with decisions D19 to D27 and spec issues SI-27 to SI-33, revised twice after two rounds of an adversarial review and a security review.

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
| 2 | **W-017** Kubernetes controller and Job protocol | New `apps/runner`: `Runner.startOrAttach/getRun/cancel/getResult`, desired/observed reconcile, deterministic Job names, versioned allocations, and the **runner side of the start permit and pod-specific writer claim** (as the backlog deliverable says). The `KubeApi` port, its fake and the k3s tier (section 2). The pod executor for `GitMaterializer`. A capacity stand-in until W-088 (A-30). First named fault points. Brief in section 5. **Built and committed in two commits: 17a (`2d363a4`: the port, `HttpsKube`, `FakeKube` and its kubelet, the controller and reconciler, permits, capacity stand-in, receipt rules and D17's two transitions) and 17b (`1f2096d`: pod executor entry, `PodVolumeMaterializer` and release, manifests, images and the k3s tier).** | W-006 ✓, W-011 ✓; W-005, W-077, W-097 by assumption (D2) | AC-10 (one allocation, one permit winner at the runner API), AC-11: F and K | 4–6 · L, likely at the top |
| 3 | **W-019** Lease fencing and process supervision | New `apps/supervisor`: the supervisor that takes and renews the permit, heartbeat 10 s / suspect 30 s / expiry 60 s judged on the **Postgres clock**, stale-epoch rejection, process-tree stop, the `QuiescenceProof` record (runner-issued: pod UID, the terminal state of every container still listed, and `gone` for a pod the kubelet removed, detachment observation; accepted only from the runner identity), the rule for a replaced generation's volume (D19), the quarantine record for a replaced generation (all three left out of W-018), the network start gate (D11). | W-017, W-018 | AC-10 (a real duplicate supervisor exits without touching the workspace), AC-12 (quarantine half): F. AC-15: F for the protocol only; **tree stop is claimed at K only** | 10 to 12 against 4–6, step 0 then two commits · L |
| 4 | **W-020** Durable checkpoints and restore | In `packages/workspace`: committed and dirty-state manifests, self-contained bundles, finalization, restore into a clean allocation; `checkpoint_job` child rows and their fencing (SI-12); `finalizing` and its pass (D22). **Starts with the untrusted-Git reader** (below). | W-007 ✓, W-018, W-019 | AC-13, AC-14, AC-16: F, real Git | 4–6, plus 3–5 for the reader · L |
| 5 | **W-023** Runner Activity attachment and cancellation | In `apps/worker`: `startOrAttachExecution`, `awaitExecution`, `cancelExecution` Activities; typed infrastructure versus semantic outcomes; cleanup on every non-semantic path; the new cleanup rule for `outcome_recorded`. Behind `patched('runner-v1')`. Design constraints in section 7. | W-019, W-020, W-011 ✓ | AC-10, AC-14, AC-15: F with Temporal | 3–5 · L |
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
| Force delete removes the pod object while processes still run (verified; on k3s the object keeps a deletion timestamp until the Job controller drops its tracking finalizer, within seconds, and the process outlives the object) | No code path uses grace 0: not the controller, not the sweeper, not test helpers. A lint rule on the client forbids it. "Pod not found" counts as quiescence only on that condition. |
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
belong to the W-017 brief (section 5). D17 is decided; none of the others blocks its start. D19 to D27 belong to the W-019 brief (section 6) and are decided provisionally.

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
| D15 | One PVC per workspace generation. Old generations' PVCs stay in place until W-024 (sweep). Consequence: a workspace that had a replacement cannot reach `released` until the older PVC is gone; it stays `releasing` with `needsOperator`, because no row may be `released` while a PVC with its label exists. | Accept. On this machine they are small and `scripts/k3s.sh down` removes them. The storage class must have reclaim policy `Delete`; the runner refuses to start otherwise. The alternative is for W-017 to delete an older generation's PVC itself once that generation is `terminated` and replaced; it is a few lines, but it takes reclaiming a fenced generation away from W-019 and W-024, where W-018 put it. |
| D16 | W-017 is larger than its estimate: 8 to 10 days against 4–6. | Two commits (17a, 17b), each with an independent review, and one build-log line after the second. |
| D17 | **Decided** (owner's call, relayed by the coordinator on 2026-11-18 after the W-017 review). W-018 as shipped cannot release a workspace whose writer was stopped. | Follow `06-runner-workspaces.md:100`. W-017 may amend `packages/workspace` with one minimal change: `active → quiescing` when a stop begins, and `quiescing → retained` only on W-017's quiescence proof, both with the runner identity and an epoch check. `release` then works from `retained` as it does today and deletes the PVC of the generation that holds the work. Section 5 names the functions, the row states and the tests. |
| D18 | Where the cancel record lives. It must exist per stage run, even with no allocation, and the allocate step reads it. No table has a column for it (SI-20). | An `audit_event` row with a deterministic id (a version-8 UUID from organization and stage run) and pinned `actor_id`, `action`, `resource_kind` and `outcome`, written with `ON CONFLICT DO NOTHING` under the stage run's lock. No migration; the lookup is a primary-key read; the runtime role can only insert, so it cannot be undone. Section 5 has the exact fields. |
| D19 | What "volume reuse" means in M2 (C2). | **Decided (provisional): no writer reuse.** A replacement always gets a new claim. The proof decides only what may happen to the old one: a read-only checkpoint mount (W-020) or reclaim (W-024). Not taken: reusing the storage with a trusted wipe (2 to 3 days, and unclaimable before D4); reuse with contents (the spec has no flow that reads them). |
| D20 | W-019 is larger than its estimate: 10 to 12 days against 4–6. | **Decided (provisional): step 0, then 19a, then 19b**, each commit with an independent review; one build-log line after the second. |
| D21 | A package outside the spec's module list for the wire contract (C13, P-27). | **Decided (provisional): accept `packages/runner-protocol`.** |
| D22 | Whether W-019 enters `finalizing`. | **Decided (provisional): it does not.** A harness exit goes `running → stopping` (`harness_exited`) and ends `terminated`. W-020 adds `finalizing` where the checkpoint child uses it. |
| D23 | TLS on the listener, and the CA. A security call. | **Decided (provisional): accept, with the security review's changes.** TLS on every address; plaintext only behind a flag the test configuration alone can set; one pinned CA, no system roots; the CA's digest in the supervisor's arguments and an immutable ConfigMap; the supervisor refuses a runner URL that is not `https:` or is loopback; an ECDSA P-256 listener certificate. Certificate issue and rotation on a real cluster belong to INT-05 and INT-06. |
| D24 | The network gate before W-021 ships a policy (C8). | **Decided (provisional): `required` in production**, so a cluster without the policy starts no harness. **Every local k3s run applies the listener-only egress policy** and runs with the gate `required`. `disabled` remains only in the fake tier, which has no network to gate, and as step 0 item 5's fallback; in that fallback it must be gone before W-077. |
| D25 | How long a quarantined volume is kept, and who owns the obligation. A security call. | **Decided (provisional): 30 days, owner `platform-operator`**, the record `restricted`; an open-quarantine count on every pass for alerting; deletion before `preserveUntil` only by an audited operator action. The action is built in W-024 (A-34). |
| D26 | Who stores the `StageInput`, and who builds `watchEvents` and log chunks (C5, C6). | **Decided (provisional), the brief's default:** W-023 stores the input. Events and log chunks wait for a harness adapter and for storage the schema does not have: W-023 with W-077. W-019 builds neither. |
| D27 | A runner API outage longer than 50 s stops every running writer, and each loses its unacknowledged work. | **Decided (provisional), the brief's default:** accept; it is the spec's lease. On a real cluster run two runner replicas (rule 2 of section 5 already allows it). P-28 records a possible grace rule; it is not built. The rate limits of this brief are what keep a harness from causing the same thing. |

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
review: four blockers and thirteen should-fix items, all taken (section 8, round 3). Every
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
| `finalizing` | Expected shutdown for a checkpoint, writer claim reserved. **Entered by W-020, not here (D22).** The reconciler leaves these rows alone. | `finalizing` |
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
| `running` | `finalizing` | Declared here so later packages cannot invent edges; driven by W-020 (D22: W-019 does not enter `finalizing`). |
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
- **Fake kubelet** (optional): runs each container as a local child in its own process group, init containers first and in order. On pod delete it sends TERM to every container at once, keeps the pod visible with a deletion timestamp until all have exited, and sends KILL at the grace period. `close()` kills every group and waits for it before a test may drop its database or its directories. Images map to programs: W-017 registers the real materializer entry and the stubs, W-019 the real supervisor. **Where it differs from k3s 1.36.6:** it publishes a container's exit in the pod status while the pod is Terminating; the cluster keeps every container `running` there until the pod is gone. The proof is safe either way.

Pod executor for `GitMaterializer`, in two phases:

- **Phase one, in the `desired` pass.** The controller calls `materializationRequest` and puts the answer in the init container's arguments. It holds no secret: W-018 refuses clone URLs that carry credentials.
- **In the pod.** `src/pod/materialize-entry.ts` runs W-018's `LocalMaterializer`, unchanged, as the harness user. Init containers finish before any other container starts, so it is alone on the volume.
  - Its root is a subdirectory it creates itself, `/workspace/factory`, mode 0700. The mount point of a provisioned volume is usually group- or world-writable, and W-018's `assertSafeRoot` would refuse it. **W-019 hand-off:** every directory level W-018 makes is 0700 (`ensureSafeChild`, `paths.ts`; `materializer.ts` for the workspace directory and the staging path), owned by the harness user, so the supervisor (uid 10002, `fsGroup` 10001) can read none of it; W-019 must change W-018's modes in those three places (the root checks only test `& 0o022`, so 0750 passes) and this entry's root with them.
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
| `deploy/k8s/` | Plain manifests (D8): the namespace with Restricted pod security, two service accounts, the runner's Role and binding, and a ClusterRole for token review, storage-class read and `get` on the non-resource URL `/openid/v1/jwks` (the cluster's service-account key set, which the permit calls verify tokens against before they are reviewed). The supervisor's account gets no Role at all. NetworkPolicy, admission policy and LimitRange stay with W-021. |
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
| 4 | A pod with two containers, one that exits on TERM and one that ignores it: the runtime shows the first container exited at once (within about 3 s) and the second still running while the pod is Terminating and still listed with a deletion timestamp, and the pod is gone at about 15 s. **The API status on k3s 1.36.6 keeps both containers `running` until the pod is gone** (the fake publishes the exit); the proof never relies on the per-container status of a Terminating pod. | Verified on k3s 1.36.6 (runtime view through `crictl`; API view recorded) |
| 5 | A second pod on a `ReadWriteOncePod` PVC stays `Pending`. **Control:** on `ReadWriteOnce` both run. | Verified |
| 6 | A PVC with no pod stays `Pending`; it binds once a pod is scheduled. | Verified |
| 7 | A PVC with no owner reference survives its Job's delete. Deleted while in use, it stays with a deletion timestamp until the pod is gone. | Second half verified; first half to confirm |
| 8 | A delete with a wrong UID is 409 `Conflict`; with a precondition on an absent object, 404. | Verified |
| 9 | After its pod is deleted, a `backoffLimit: 0` Job gets no replacement pod. The container ignores TERM, so its process lives through the grace period; at every poll while it lives, the quiescence proof read from the pod list (as if the Job were absent) stays unproved, and it is proved once the pod is gone. The order of Job `Failed` and container exit is recorded, not asserted. | Verified on k3s 1.36.6 (order seen: container exit first) |
| 10 | With `terminationMessagePolicy: File`: an init container's message and exit code are in the pod status while the app containers run; a longer message is cut at 4,096 bytes; a failed step that wrote only to its log has an empty message. | Verified, step 0 |
| 11 | A token bound to a pod with audience A reviews as authenticated for A, lists A in `status.audiences`, and carries the pod's name and UID. It fails for audience B and for no audience. After the pod is deleted, a token not reviewed before fails at once, and one reviewed just before fails within 30 s. | Verified, step 0 |
| 12 | `activeDeadlineSeconds` ends the pod and the Job reports `DeadlineExceeded`. | To confirm |
| 13 | Every call the suite makes succeeds under the runner's Role: Jobs create, get, list, delete; pods get, list, delete; claims create, get, list, delete; token review; `get` on the storage class `local-path` only (a read of another class is refused) and on `/openid/v1/jwks`. The k3s run uses the runner's service-account token (the process start reads the storage class under it); the admin certificate is for the driver only. **The supervisor's service account is refused a patch of `pods/status`**, and a read of any pod. | Verified on k3s 1.36.6 |
| 14 | Driver only: a force delete gives the pod object a deletion timestamp at once, and the object is removed within seconds once the Job controller drops its tracking finalizer; the process outlives the object (asked of the runtime, exactly true). Whether a replacement pod appears is recorded (none on k3s 1.36.6). This is why the port has no grace parameter. | Verified on k3s 1.36.6 |
| 15 | Cluster only, RBAC: only the runner's service account and the Job controller create Jobs, pods and claims in the execution namespace (the supervisor's account and `default` cannot; the runner cannot create pods or mint tokens), and no one but the cluster's admin may mint a token for the supervisor's account. | Verified on k3s 1.36.6 |

**k3s tier, opt-in.**

- `scripts/k3s.sh up` starts the pinned image from section 2 with the same flags and limits (privileged, 2 CPUs, 1,800 MB; traefik, servicelb and metrics-server off). It publishes the API on `127.0.0.1`, applies `deploy/k8s`, waits for the service accounts to exist, builds the eight image tags (the materializer, its test variant and six stub behaviours), loads them with `ctr images import`, and writes `.k3s/env`: server, CA, the runner's token, the admin certificate.
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

- **W-019:** the listener the supervisor calls; the supervisor side of both permit calls; the durable proof built from `PodObservation`. Volume reuse is the PVC-name function called with the older generation. **The full `StageInput` is not stored anywhere**; the supervisor needs it, so W-019 or W-023 must persist it as an artifact the runner can serve. **The 0700 modes:** every directory level W-018 makes is 0700 and owned by uid 10001, so the supervisor (10002) can read none of it; W-019 changes W-018's directory modes in `ensureSafeChild`, and the `materializer.ts` workspace and staging `mkdirSync` calls (0750 passes the `& 0o022` root checks), together with the pod entry's `/workspace/factory`.
- **W-020:** the accepted checkpoint is what lets a `retained` workspace be released. W-018's TODO still stands: bind the checkpoint to the workspace, generation and epoch.
- **W-021:** `apps/api/src/auth/capability-proxy.ts:59` treats `starting` as live. After W-017 `starting` means "Job bound, no permit", so it should narrow to `running`. Also: an egress NetworkPolicy that blocks internal and cluster addresses (the API server, the metadata endpoint, other pods) for allocation pods, and a ValidatingAdmissionPolicy that backs A-25 (only the runner's account and the Job controller create Jobs, pods and claims in the execution namespace; nothing else uses the supervisor's account).
- **W-023:** the runner client. Call the facade's `allocateOrAttach` before `startOrAttach` (SI-26). `terminated` without a cancel reports `reconciling`, and the answer is another `startOrAttach`. A cancel always succeeds and always blocks later starts, unless the run already has a result; send it on every non-semantic path, before the budget is charged. Release through the facade after `terminated`: `allocation_live` and `writer_active` are retryable, `checkpoint_not_accepted` is not until W-020. Until W-020 or W-024, every workspace whose writer was stopped keeps its 2 Gi PVC, so the cleanup rule must record it as an obligation and not wait for it. **Unbudgeted tasks:** the worker reserves a stage's budget only when the plan carries a ceiling (`apps/worker/src/workflows/stage-execution.ts:16`), and the runner answers `budget_not_reserved` every time without one; the Activity must reserve for every runner stage or define the alternative. The new cleanup rule: `apps/worker/src/activities/outcome.ts:53` and `shared.ts:80` still count allocation rows, and until W-023 only tests create them.
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
8. TERM reaches both containers of a pod at once (conformance 4). Confirmed in the runtime; the API status keeps both `running` until the pod is gone, so the proof never relies on a Terminating pod's per-container status.
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
SI-19 to SI-26, all in the table in section 7.

### Definition of done

- **Step 0:** done (section 2, third session).
- **17a:** the fourteen fake-tier files that need no pod executor pass (thirteen in `apps/runner/test`, one in `packages/workspace/test`), W-018's own nine still pass, and `pnpm check` is green. Independent review.
- **17b:** `w017-pod-materializer.test.ts`, `w017-release.test.ts` and the exclusion test pass, and `pnpm check` is green. `pnpm test:k8s` passes once on this machine on AC power, with the nine items above each marked confirmed or answered. Independent review.
- AC-10 and AC-11 are logged with the exact halves above and the tier of each, naming W-019 and W-023 for the rest. The k3s run's date and image digest are in the same line.
- No file under `apps/worker` changes; no migration is added; no dependency is added. The diff in `packages/workspace` is the two methods, their test and the README.
- `docs/assumptions.md` has A-25, A-26, A-27, A-28, A-30 and A-31. `docs/spec-issues.md` has SI-13, SI-14 and SI-19 to SI-26.
- The READMEs state the three rules, which part runs where, the allocation and workspace state tables, the permit steps, the receipt rules, the two phases, the residual risks, the release order (cancel, wait, release) and what is not built.
- Nothing is left behind by either tier: each test file checks its namespace and its process groups at teardown.

## 6. Third package brief: W-019 Lease fencing and process supervision

Written 2026-11-18 against `1f2096d` (W-017b committed, tree clean), and revised twice the same day,
after each round of its two reviews (section 8, round 5). No test and no cluster was run for this brief: every code fact below
was read today, and every Kubernetes behaviour is either a row of section 2 or of W-017's build-log
line (verified), or is marked **to confirm in the k3s tier**. Seven of those carry design weight
and are probed first (step 0).

**Goal.** Put a real supervisor in the supervisor slot of the allocation Job, and give the runner
the endpoint it calls. When W-019 is done:

- exactly one pod's supervisor holds the permit, renews it every 10 s and lets its harness start; a duplicate exits without touching the workspace;
- a writer that has lost its lease, or whose workspace was fenced, is refused on every pod-facing call and stops itself;
- a cancel, a harness exit and a supervisor exit all stop the whole pod, and the stop leaves a durable proof;
- a stop that cannot be proved leaves a quarantine record, and the replacement runs on a new volume.

No Temporal, no workflow change, no migration, no new npm dependency, no Claude, no checkpoint and
no `finalizing` (W-020, D22), no factory tools (W-075), no production NetworkPolicy (W-021).

**Size.** More than the backlog's 4–6 days; I expect 10 to 12. D22's shrink took about a day out,
and the two reviews put about two back (three rate limits, the lease clause, the CA digest, the
deny-target list, the egress policy on every k3s run, and their tests). Round 2 added the
connection limits and a few hours; the estimate stands, nearer its top. **Step 0**: the probe, half
a day, first. **19a**: the runner side, in the fake tier, with tests as the callers. **19b**: the
supervisor, the launcher, the manifests, the images and the k3s tier. Each commit has its own
review (D20). The acceptance lines are logged after 19b.

**Words.** "The listener" is the runner's pod-facing HTTPS endpoint. "The local endpoint" is the
supervisor's own endpoint on `127.0.0.1` inside the pod. "The launcher" is the trusted first
process of the harness container. "Fenced" means the supervisor has learned, or must assume, that
it no longer holds the lease. "The proof" is the stored `QuiescenceProof`. "The hold" is the cancel
window of `06-runner-workspaces.md:90`. "PVC", "writer claim" and "governing pod" are as in section 5.

**Spec to read.** `06-runner-workspaces.md:7` (no completion from an exit code), `:16-17` (permit,
duplicate, launch), `:23-27` (leases, reuse, epoch checks), `:65` (a request to pause is not
quiescence), `:76` and `:82` (replay from the last acknowledged boundary, into a new empty
allocation), `:88-90` (envelope, cancel), `:100-104` (cleanup, quarantine), `:108-116` (pod
boundary, whole-pod stop, no self-report, path-safe reads), `:120`;
`09-verification-security.md:71-77`; `11-platform-operations.md:27`, `:43`;
`13-testing-release.md:5`, `:19`, `:64`; `04-temporal.md:83-87`, `:98`;
`examples/kubernetes-job.json`; `contracts/interfaces.ts:62-97`; `domain.schema.json`
`cleanupObligationRefs` (`:6108`). Code: `apps/runner/src/permit.ts`, `reconcile.ts`,
`quiescence.ts`, `states.ts`, `job-manifest.ts:56-71`, `:120-124`, `workspaces.ts`,
`pod-volume-materializer.ts`, `kube/api.ts`, `kube/fake-kubelet.ts`, `config.ts:28-33`;
`apps/runner/README.md` (hand-offs, residual risks, what k3s showed);
`packages/workspace/src/paths.ts:152-171`, `materializer.ts:87-112`, `:153-161`, `manager.ts:68-69`,
`:263-325`, `:359-388`, `publish.ts:112-121`; `packages/database/src/allocation.ts:115-119`,
`:144-175`, `:200-226`; `packages/artifacts/src/service.ts:284-317`; `compose.yaml:8-22`.

### What is already built, and is not rebuilt here

- The heartbeat rule on the runner side: 10 s beat, 30 s suspect, 60 s expiry, all judged in SQL on `clock_timestamp()` (`config.ts:56`, `reconcile.ts:256-267`, `allocation.ts:167-175`). W-019 adds the sender.
- Both permit calls, the local signature check, the token review, the pod read and the writer claim (`permit.ts`). `PermitRequest.source` and `deps.admitSource` were left for this listener (`permit.ts:27`, `:88`; `core.ts:35`).
- `PodObservation` and the pure proof (`quiescence.ts`), `settleWorkspace` (`workspaces.ts:15-28`), and the two workspace transitions of D17.
- Every edge W-019 drives is already in `states.ts:8-18`. No edge is added, and `finalizing` is not entered (D22).
- Release already refuses a workspace with a quarantined allocation (`workspaces.ts:52`).

### Conflicts and corrections

Each row was checked against the code or the spec today. "Brief" says what this section does about it.

| # | Where | What it says | What is actually there | Brief |
| --- | --- | --- | --- | --- |
| C1 | Section 5 hand-off (`m2-plan.md:725`, `:851`); `apps/runner/README.md:150-154` | W-018's 0700 modes are in "three places": `ensureSafeChild`, and the workspace and staging `mkdirSync` in `materializer.ts`. Change them to 0750. | There is a **fourth**: `materializer.ts:156` makes `g<n>/work` at 0700, and it sits between the generation directory and the checkout, so the three changes alone still lock the supervisor out of `work/main`. `git/` and `work/main` are made by Git under the process umask, and nothing sets one. `ensureSafeChild` is shared with the publisher's scratch path (`publish.ts:113`); a blanket change there would expose only the organization and workspace directory names, because the staging directory and the bundle have their own 0700 and 0600 (`publish.ts:114`, `:121`). On a host (`LocalMaterializer` on this Mac) 0750 opens every checkout to the user's group, which is the real reason not to change the default. | 0750 is reachable only through the pod export, with umask 027 ("Modes", in 19b). Every host path keeps 0700. |
| C2 | Section 1 row 3; section 4 `replaceWriter`; section 5 hand-off ("volume reuse is the PVC-name function called with the older generation"); D15 | W-019 builds volume reuse on proof. | Three things stand against a second writer on a used volume. (a) The spec replays a lost stage from its last acknowledged boundary into "a new empty allocation" (`06:76`, `:82`); nothing consumes a predecessor's dirty tree. (b) W-018's Git rule: `allocated` means no writer has ever started on the generation, and the trusted clone, `ensureMaterialized`'s repair and `release` all rest on it. (c) Detachment is listed in section 2 as unproven until a real cluster. The directory, the PVC name and `pvcIsOurs` are all keyed by generation as well. The backlog deliverable says "isolated replacement rules", not reuse. | D19 (decided): no writer ever mounts another generation's claim in M2. W-019 builds the proof, the quarantine record and the one function that says what may be done with an old volume. Its consumers are W-020 and W-024. SI-28. |
| C3 | Section 1 row 3 | The proof holds "the terminal state of every container". | On k3s 1.36.6 a Terminating pod keeps every container `running` in the API until the object is gone (conformance row 4). After a cancel there is no terminal status to store, only the absence of the pod. | The record says `finished` with container states for a pod still listed, and `gone` for the writer's pod when it is absent. For `gone` it also needs the node (below). |
| C4 | Section 1 row 3 | W-019 builds "heartbeat 10 s / suspect 30 s / expiry 60 s judged on the Postgres clock". | Built in W-017. | W-019 builds the sender and the supervisor's own stop rule. |
| C5 | Section 5 (`m2-plan.md:613`); `runner.ts:43` | `watchEvents` is `not_supported` "until W-019". | There is no harness adapter before W-077, and the schema has no table for harness events or log chunks (only `task_event` and `audit_event`). | Not built here. D26 moves it, with the log chunks of `06:88`, to W-023 and W-077. SI-32. |
| C6 | Section 5 hand-off; SI-26 | Persisting the full `StageInput` is "W-019's or W-023's". | No code path in W-019 reads it: the supervisor needs the organization, allocation, epoch, generation and workspace, and all five are in the rows. What a stored input must be bound to is SI-21, which is W-023's. | W-023 (D26). The supervisor gets its five values as arguments rendered from the rows. |
| C7 | Section 5 state table and edge table | `finalizing` is "entered by W-019 and W-020". | With no checkpoint child, `finalizing` here would be a capacity hold with no consumer. | D22 (decided): W-019 does not enter it. A harness exit goes `running → stopping`. The reconciler still leaves `finalizing` rows alone, and W-017's assertion (`w017-states.test.ts:55-59`) stands. |
| C8 | Section 1 row 3; D11 | W-019 builds the network start gate. | The gate needs a policy to observe, and production NetworkPolicy is W-021's, four packages later. | The mechanism is built. The k3s tier carries one local policy on every run, which is also what keeps pods off the Mac's own services (D24). |
| C9 | `06:17` against `06:108`, `:116` | "Only the winning supervisor may launch the harness", with the two in separate containers and no shared process namespace. | Kubernetes starts both containers. The supervisor can neither start nor signal a process in the other one. | SI-27: a launcher in the harness image waits for the supervisor's start signal. The only stop that counts is the pod delete. |
| C10 | `06:90` against `states.ts` | Cancel allows "up to 30 seconds for a safe checkpoint request" before the delete. | W-017 deletes at once (`start.ts:175-177`, `reconcile.ts:269-283`). | The hold and a stop acknowledgement are built here. What a checkpoint at cancel is, is W-020's. SI-29. |
| C11 | Today's code | Stale-writer rejection. | `renewAllocationLease` and `passRunning` never read the workspace. If anything fences a workspace while its allocation is `running` (a hand-back after human takeover, `06:27`; W-020's restore), the old writer keeps renewing. No caller does that today (`start.ts:76`, `:90-93`). | Closed in 19a: the renewal and the `running` pass both require the workspace to be at the allocation's epoch. |
| C12 | Today's code | Leases. | The claimant's acquire retry on a `running` row is granted with no lease condition and no refresh (`permit.ts:145`, `:165`, `:188`). A supervisor that retries late would take a fence time the server never granted. Only tests call it today. | Closed in 19a (rule 4). |
| C13 | `tools/boundaries.json` | Apps are never importable. | The supervisor and the runner must agree on a wire format, and W-023's worker client will need the same. | A new package, `packages/runner-protocol`, which is outside the module list of `01-scope-architecture.md:84-99` (P-27, D21, decided). |
| C14 | `core.ts:20` | `artifacts` is optional in `RunnerDeps` ("getResult only"). | The proof and the quarantine record are controller artifacts. | It becomes required. W-017's harness already passes it. |

### Seven rules

W-017's three rules stand (no Kubernetes call in a transaction; controllers are kept apart by names
and compare-and-swap, not a lease; `terminated` is a proof). The first gains one clause: **no
object-store call inside a transaction either**. Four more:

4. **Authority is the runner's answer to this call, and it is checked against the lease.** Every
   pod-facing call is reviewed, read against the pod and checked against the rows, as the permits
   are today. **Every route that grants, or that changes an allocation's state, carries the lease
   condition in its own locked statement** (`controller_lease_until > clock_timestamp()`), and
   every grant refreshes the lease in that statement. Nothing the supervisor remembers is
   authority, and its own clock can only make it stop **earlier** than the server would.
5. **Only the pod delete stops a writer.** The supervisor cannot signal the harness. A cooperative
   stop is a courtesy; no proof, state change or record depends on anything reported from inside
   the pod (`06:65`, `:116`). What the runner knows about a container, it reads from the cluster.
6. **A stored proof is a one-way door.** Once an allocation has a proof it can only become
   `terminated`. **Every move to `quarantined` reads the proof link under the row lock and refuses
   when one exists.**
7. **One generation, one claim, one writer** (D19). The renderer has no input through which an
   allocation could name another generation's PVC.

### Step 0: the probe

Half a day on AC power, before 19a is written, with the pinned k3s image and no factory code
beyond W-017's images. Items 1, 4 and 7 shape 19a; the rest shape 19b. Each has a named fallback.

| # | To show | If it does not hold |
| --- | --- | --- |
| 1 | A pod in `factory-exec-local` completes a TLS request to a listener on the Mac at the podman host-gateway address. Record the source address the listener sees and the address it had to bind. **Also from that pod, with no policy:** whether `<gateway>:55432` (the compose Postgres, `compose.yaml:11`) and `:57233` (Temporal, `:22`) accept a connection. | Run the listener as a container on the podman network (one more image, about a day). |
| 2 | In a container with `runAsUser: 10002` and `fsGroup: 10001`, `id` lists group 10001; it can list a 0750 directory owned `10001:10001` on the claim. **Control:** it cannot list a 0700 one. | Give the supervisor `runAsGroup: 10001`. |
| 3 | A projected volume with a `serviceAccountToken` source and a source for an **immutable** ConfigMap mounts, and uid 10002 reads both files. | A second, ConfigMap volume for the CA. |
| 4 | When one container of a running pod exits, the pod status shows it `terminated` with its exit code within a few seconds, while its sibling runs (the pod is not Terminating). | The supervisor reports the harness's exit on a new route, from the launcher's hint. That lets a candidate end its own stage and nothing more; the stop record says the exit was reported, not observed. The route changes state, so by rule 4 its locked statement carries the lease clause, as renew's does. |
| 5 | Under a default-deny egress policy with one allow rule for the listener's address **and port**: after the start-up window of SI-15, connects to the API service address, to `169.254.169.254:80`, and to the gateway's `:55432` and `:57233` all fail, and the listener stays reachable. Record whether a denied connect is refused or times out. | The gate is `disabled` at K, pods can then reach the Mac's services, and **W-077 does not start on this tier** until that is solved (D24). Either way the result goes into W-019's build-log line, so W-077's brief can cite it. |
| 6 | A process that called `setsid` and ignores TERM in the harness container is gone when the pod object is gone (runtime view), about 15 s after the delete. | AC-15's K claim narrows to the process group. |
| 7 | The runner's service account can `get` a node by name once the ClusterRole allows it, and a scheduled pod carries `spec.nodeName`. It can `get` the `kubernetes` Service in `default` under a Role that names only that Service. | The node check is fake-only and off by default; the gate's start-up check is skipped and the residual grows. |

Recorded, not relied on: what the kubelet does to modes and group ownership when a second pod
mounts the claim under `fsGroup` (it matters to W-020's read-only mount).

### The parts, and where each runs

| Part | Runs in | Touches |
| --- | --- | --- |
| `@factory/runner-protocol`: wire shapes, parsers, caps, denial codes, supervisor exit codes | Imported by the runner, the supervisor and, later, the worker | Nothing. Pure, no dependency. |
| The listener | The runner process | The permit service and the stop-acknowledgement service. Never the database directly. |
| Pod call guard (`authorizePodCall`) | The runner process | A token review, a pod read, the allocation and workspace rows. |
| Proof, quarantine and disposition records | Written by the runner; types, `prepare`, `register` and readers in `packages/workspace`, so W-020 can read them without importing an app | Controller artifacts and `artifact_link`. |
| Reconciler: the container-exit stops, the hold, the fenced-workspace stop, the proof-first order | The runner process | Postgres and the `KubeApi` port. |
| Start-up checks | The runner process, before the first pass | One Service read, one node read. |
| Supervisor (`apps/supervisor`, entry `main.ts`) | The supervisor container, uid 10002 | The listener, its token file, the local endpoint, one read-only look at the workspace before the harness starts. No database, no Kubernetes API. |
| Launcher (`apps/supervisor`, entry `launcher.ts`) | The harness container, uid 10001, before any candidate code | The local endpoint, and the one child it starts. |
| Scripted harness (A-33) | The harness container, as the launcher's child | The workspace, as a test asks. |
| `FakeKube` nodes and Service, and the fake kubelet's token files, volumes and ports | The test process | Memory and local child processes. |

### 19a: the runner side

**Protocol package.** `packages/runner-protocol` holds, for the pod-facing API only: the three
route names, request and answer types, `PermitDenialCode` (moved from `permit.ts`, which re-exports
it), hand-written parsers, the caps (body 16 KiB, token 8 KiB, report 1 KiB), the status mapping
and the supervisor's exit codes. The parsers accept a plain object's own keys only and refuse any
key not listed, `__proto__` and `constructor` included. Committed vectors pin every shape.
Boundaries: `allowWorkspace: []`, and the `denyExternal` list of `@factory/contracts`.

**The listener** (`src/listener/pod-listener.ts`, `node:https`). `podListener` is optional in the
configuration; absent means no listener, which is what W-017's process test runs.

- Routes: `POST /pod/v1/permit/acquire`, `/pod/v1/permit/renew`, `/pod/v1/stop-ack`. The token travels in `Authorization: Bearer`; the body is JSON. Anything else is 404, 405, 413 or 415 with no detail.
- Status: 200 granted; 400 `invalid_request`; 401 `unauthenticated`; 429 `throttled`; 503 `review_unavailable`; 409 every other typed denial. The body is the answer; the status is a hint.
- **TLS, always** (D23). `createConfig` requires a certificate and key whatever the bind address, and refuses an unspecified address (`0.0.0.0`, `::`): the listener binds one named address. Plaintext exists only behind a flag that `createTestConfig` alone can set, for the fake tier's loopback. The k3s tier uses TLS.
- **Admission, in this order.** Each step is there so that the one after it cannot be starved by someone who failed the one before. Steps 1 and 2 act on the plain socket, before any TLS work.
  1. **New connections, per source.** A bucket checked on the server's `connection` event, before the handshake: 5 a second, burst 20. Over it the socket is destroyed, which costs nothing, and counted. A handshake is the dearest thing a peer with no token can ask for, and Node runs it on the event loop that also answers every renewal and runs the reconciler. A harness that replays a ClientHello and hangs up, or that reconnects each time it is refused, would otherwise be charged by nothing below. A supervisor keeps one connection alive and its gate opens about one a second while it waits.
  2. **Open connections.** 512 in all and **4 per source**: a supervisor's one kept-alive connection and its gate probes. 5 s for the TLS handshake; 5 s for headers and body; 10 s per request; 16 KiB of headers. Configuration refuses `sourceConnections × (pools.authoring + pools.verifier) > 512`, so one organization's full pools cannot fill the listener.
  3. **Source charge. Every request is charged to its source's bucket (10 a second, burst 50) unless its token verified locally.** That covers a malformed request; a wrong path, method or content type; a token that fails local verification; a token met again inside the failed-token memory, which is answered before any verification (`permit.ts:79-81`); and an unknown key id, which is answered `review_unavailable` and never remembered (`permit.ts:96`). A source with an empty bucket is answered 429 and its connection is closed; step 1 then bounds how fast it can come back. A request whose token verifies is never charged to, or refused by, the source bucket.
  4. **Local verification** (`verifyTokenLocally`, W-017) runs on every request that parsed and was not answered from the failed-token memory. Its cost per request is bounded (4 KiB a part, `token.ts:7`; one algorithm per key; a single-flight key fetch at most once in 30 s, `token.ts:11`, `:43-50`), and steps 1 to 3 bound the requests.
  5. **Per-pod bucket**, keyed by the pod UID in the token that has just verified: burst 5, then one every 2 s. Normal traffic is one every 10 s, and a transport retry is one every 2 s. Over it: `throttled`, with no review, no row and no audit. **This is what stops one pod's valid token from spending everyone's review budget.**
  6. The shared TokenReview budget (`permit.ts:61-69`), sized as below.
  7. The guard.
- **The review budget is sized from what is running.** Today it is one bucket per runner, shared by every organization, and sized from one organization's pools (`config.ts:30-33`). From W-019 each pass hands the permit service the number of `running` and `suspect` allocations across all organizations, and the refill rate is `max(20, 2 × podRate × that number)`, up to `review.ceilingPerSecond` (default 200, to protect the API server). The burst is twice the refill, as `config.ts:32` sets it today. Every pod at its own cap then spends at most half the budget. When the ceiling binds it is counted and warned once a pass. Configuration refuses `2 × podRate × (pools.authoring + pools.verifier) > review.ceilingPerSecond`. The ceiling goes to P-14's load test with the other rates.
- `admitSource` (`permit.ts:88`) therefore changes its meaning from "admit" to "charge", and the listener charges the same bucket for what never reaches the permit service.
- **The failed-token memory becomes an insertion-ordered LRU** of 4,096 entries: a new entry evicts the oldest. Today a table full of unexpired entries is scanned on every failure and nothing is deleted (`permit.ts:84`).
- Tables are bounded and evict the least recently used entry when full; they never refuse a new source or pod. Counters have fixed names: never a path, a source or a token. A token is never logged.
- A source is `remoteAddress`. Loopback on macOS has one address, so the fake tier names its sources through an injectable `sourceOf` that only the test configuration can set.
- **A route answers first and reconciles after.** The pass that `stop-ack` or a renewal sets off runs after the response is written, and is single-flight per allocation: a repeat while one is running starts nothing.
- It is a separate port from anything W-023 adds: that route authenticates control-plane identities, this one authenticates pods.
- `startRunnerProcess` starts it after the start-up checks and closes it before the loop stops.
- **Deployment requirement** (README, "Deployment invariants"): the listener must see real pod addresses, so the runner runs in the cluster with no source NAT in front of it. Behind NAT the per-source limits mean nothing. This machine's k3s tier is behind NAT; A-32 records it as a development-only arrangement.

**The pod call guard** (`src/pod-guard.ts`). `permit.ts`'s `#review` and `#pod` move here
unchanged, and one function, `authorizePodCall(req, need)`, is the only way a pod-facing route
reaches a row. In order: the review; the allocation by id; `owner_epoch` equal to the request's;
the pod read (same UID, no deletion timestamp, our label, owned by `job_uid`); `pod_uid` equal to
the reviewed UID, unless `need.writer` is `claimable` (acquire only); the state in `need.states`;
the workspace clause of the route; and, for a route that grants or changes state, the lease, inside
the statement that does it.

| Route | States | Workspace clause | Lease clause | Changes |
| --- | --- | --- | --- | --- |
| acquire, first commit | `starting` | At this epoch; `allocated`, or `active` owned by this pod (a permit between its steps) | `starting → running` only while the start deadline in `controller_lease_until` has not passed | As W-017, plus the start record and the node read. |
| acquire, wherever it finds the row already `running` for this pod: in the guard, or under the lock of its last transaction because a concurrent call of the same pod committed first (`permit.ts:188`) | `running`, `suspect` | As renew | **It is the renewal statement**: unexpired, and refreshed. No branch of acquire returns a grant it did not just write. | The grant it returns is a renewal's. |
| renew | `running`, `suspect` | At this epoch, owned by this pod, `active`; in the same `UPDATE` | Unexpired, and refreshed | As W-017, plus the harness container's state in the answer. |
| stop-ack | `stopping` only | At this epoch, owned by this pod, `active` or `quiescing` (the first pass has usually settled it) | None: it grants nothing and changes no state (`06:112`: cancellation "permits only scoped checkpoint/cleanup recording") | The acknowledgement record. |

- **Renewal.** `renewAllocationLease` gains: `workspace_id IS NULL`, or a `workspace` row with this id, `owner_epoch`, `owner_pod_uid` and state `active`. It stays one statement on `clock_timestamp()`. A grant carries `harness: { state, exitCode? }`, taken from the `harness` container's status in the pod the call already read. That is the cluster's statement, not the pod's.
- **Why a renewal was denied, in this order** (replacing `permit.ts:224`): the row is gone; another pod is the writer; the state is not `running` or `suspect`, which answers `not_renewable` with the state (**`stopping` is still how a supervisor learns of a stop**, whatever the workspace says); the workspace is not at this epoch, which answers `stale_epoch`; otherwise `lease_expired`.
- **Denied calls are audited under a cap** (M1). After a good review a denial writes its audit row through a bucket keyed by the **reviewed pod UID**, with `refusalAudit`'s numbers (`core.ts:49-64`). Not the username: every supervisor has the same one (`config.ts:79`). Over the cap it is counted in memory.
- **The `running` pass** stops an allocation whose workspace is no longer at its epoch (`workspace_fenced`). With the renewal change this closes C11.
- `stop-ack` is reachable only during the hold: once the pod has a deletion timestamp the pod read refuses the call. A repeat inside the hold finds the record and starts no second pass.

**Container exits** (D22, and the review's S9). The `running` pass already lists the allocation's
pods. For the governing pod, while it is not Terminating:

- the `harness` container is `terminated`: `→ stopping`, reason `harness_exited`;
- the `supervisor` container is `terminated`: `→ stopping`, reason `supervisor_exited`, at once and without waiting for the lease.

Neither waits for the hold, because the stage run has no cancel record. A renewal that sees either
one in the pod it read sets off a pass after it has answered. The `starting` pass treats a pod
whose supervisor has exited as a bad pod, so a duplicate that lost, or a gate that never passed,
does not sit until the start deadline. The allocation ends `terminated` with a proof and the
workspace `retained`; `getRun` answers `reconciling`. **That is the end of every successful stage
until W-020 adds `finalizing`.**

**Records, and where each lives.** No migration. Two kinds, by one rule: evidence that another
package cites by `ArtifactRef` and that must be retained is a controller artifact, registered as
W-018's receipt is (`service.ts:286-299`); a flag the reconciler reads by primary key on every pass
is an `audit_event` row with a deterministic id, as D18's cancel record is.

| Record | Kind | Key | Written | Read by |
| --- | --- | --- | --- | --- |
| Writer start | `audit_event`, id from `factory-writer-start/1`, organization, allocation | one per allocation | In the permit's last transaction (`starting → running`) | The proof (the writer's node), `describeRun` |
| Stop acknowledgement | `audit_event`, `factory-stop-ack/1` | one per allocation | By `stop-ack` | The hold |
| Cancel stop | `audit_event`, `factory-cancel-stop/1`, organization, allocation | one per allocation | By `cancel`, in the transaction in which **it** moves the allocation to `stopping`, and only then | The hold |
| Urgent stop | `audit_event`, `factory-run-urgent-stop/1` | one per stage run | By `cancel` with `urgent`, under the stage run's lock | The hold |
| `QuiescenceProof` | Controller artifact, purpose `quiescence_proof/<allocationId>` | one per allocation | On the caller's transaction, under the allocation's row lock, in `stopping` only | The `stopping` pass, the quarantine move, W-020, W-024, W-023 |
| `QuarantineRecord` | Controller artifact, classification `restricted`, purpose `quarantine_record/<allocationId>` | one per allocation | In the same transaction as `→ quarantined` | `describeRun`, release, W-024, W-023's `cleanupObligationRefs` |

- Every `audit_event` record follows D18 exactly: pinned `action`, `resource_kind`, `resource_id` and `outcome`; `ON CONFLICT DO NOTHING`, then read back; a row at that id with other fields is a hard error. `getAuditEvent` gains a variant that returns `details_ref`.
- **Writer start** holds the pod's name and UID, its node's name and UID, and the supervisor's start report, marked as reported. **The node is read after the review and the pod read**, from the `spec.nodeName` of that pod, so a caller who is not authenticated never costs a Kubernetes call. With `nodeCheck: 'required'` (the default) a pod whose node cannot be read is `not_ready`.
- **The two artifact records have the same three functions**, in `packages/workspace/src/quiescence-proof.ts` and `quarantine-record.ts`:
  - `prepare(ctx, input)`: outside any transaction. It requires the runner identity, and a refusal is audited here, in its own transaction, so a later rollback cannot erase it. It validates the input, builds the canonical body, puts the object and returns a handle that only this module can mint.
  - `register(tx, handle)`: **on the caller's transaction**, as `registerControllerArtifact` is (`service.ts:299`). The caller holds the allocation's row lock. It first reads for an existing link and answers `exists` if there is one.
  - `read(tx, ...)`: counts only links whose artifact's `producer_id` is the configured runner identity and whose body names the allocation asked for. None: absent. One: the ref. **More than one is a hard error**: `artifact_link` has no unique key (`0003_tasks_execution.sql:232-244`), so "one per allocation" is the row lock and nothing else, and a second link means the lock was bypassed.
  - This is "accepted only from the runner identity".

**The proof** (`factory-quiescence-proof/1`, canonical JSON, capped at 64 KiB). It carries the
organization, task, allocation, logical stage run, generation, epoch and workspace; the Job's name,
recorded UID and `absent: true`; the writer (pod name, UID, node) or null; one entry per pod still
listed, with phase and `ContainerObservation`s and no message or reason text;
`writerPod: 'finished' | 'gone'`; the node check; the detachment observation; and the
**observation time**, read from the Postgres clock in the unlocked phase, before the put.

`evaluateQuiescence` keeps every W-017 condition and gains three:

- **Node.** If the allocation has a **start record** and the writer's pod is absent from the list, the node recorded at start must still exist with the same UID (`getNode`). Otherwise `writer_node_missing`: not proved. This is the pod-garbage-collection hazard of section 5's residual risks. A pod under graceful deletion on an unreachable node stays listed, so it is already unproved today.
  - **A claimed writer with no start record needs no node check** (`not_needed`, recorded as such). The start record is written in the transaction that makes the allocation `running`, and every grant is returned after that commit (`permit.ts:185-199`). No start record therefore means no supervisor was ever granted, no start gate opened and no candidate process ran. W-017's own test of a cancel between the claim and `markWriterStarted` (`w017-permit.test.ts:240-253`) is this case, and it still ends `terminated`.
- **Claim.** With a workspace, the namespace's pods are listed **without a selector** (same page cap; a capped list is not proved), and none that is unfinished may name this generation's claim in its volumes. An unlabelled pod on the claim is exactly what the labelled lists miss.
- **Detachment** is recorded as `{ method: 'no_consumer_pod', claim: { name, uid } }`, or `no_claim`. `VolumeAttachment` for a CSI volume is not read: that is D4, and the disposition function below says so (SI-30).

**Order, and the one-way door.** The `stopping` pass becomes:

1. Read the proof link. If one exists, go to step 5. The deletes still run for hygiene. **The hold is never consulted once a proof exists.**
2. The hold (below). If it applies, the pass ends here and waits.
3. As today: settle the first edge, delete, list, evaluate.
4. Proved: `prepare` (the put, no transaction), then lock the allocation `FOR UPDATE`, re-check state and epoch, and `register`. A second controller gets `exists` under the lock and uses the first one's link. **Not proved by the stop deadline:** `prepare` the quarantine record, then `move(..., 'quarantined')`, which **under the same row lock reads the proof link first and refuses when one exists**; the pass then continues at step 5 with that proof. A put that fails ends the pass with the row unchanged: no proof, no quarantine, no transition.
5. `settleWorkspace(a, 'proof')`, which refuses to call `markWriterStopped` unless the proof link exists.
6. `terminateTx`, which answers `needs_proof` without the link.

D17's two manager methods are not changed.

**The quarantine record** (`factory-quarantine-record/1`). Written for all three sources that
remain (`desired`, `starting`, `stopping`). It carries the identity fields, the reason code, the
last observation in the proof's shape (**no container message or reason text**: the harness writes
its own) and why it was not a proof, the claim's name and UID when one was read, the writer,
`preserveUntil` and `escalateAfter`, and the obligation: kind `quarantined_allocation`, owner
`quarantineOwner`, `needsOperator: true`. D25, decided:

- `preserveUntil` is 30 days ahead (`quarantinePreserveDays`), the owner is `platform-operator`, and the artifact is `restricted` (`06:104`: "preserve restricted evidence").
- **Alerting.** Every pass counts the quarantined allocations whose record is past `escalateAfter` (one day) and reports the count in `PassSummary` and a warning line. `describeRun` returns the record's ref. Routing that count to a person is INT-09's; the number exists from W-019 on.
- **Early delete.** A quarantined volume may be deleted before `preserveUntil` only by a named operator action that writes its own audit row and a resolution record (erasure, tenant offboarding). The rule is fixed here. **The action is built in W-024**, with the only code that deletes a PVC.
- Nothing in W-019 mounts or deletes a quarantined generation's PVC, and nothing here stops its pod again: the reconciler does not list `quarantined` rows, and `sweepJobs` deletes only unrecorded Jobs and those of `terminated` allocations (`reconcile.ts:334`). The Job's own deadline bounds the process; stopping it earlier is W-024's.
- The allocate step's `runner.reallocate_after_quarantine` row (`start.ts:103`) gains the record's ref: that is "the quarantine record for a replaced generation".

**What may be done with an old volume** (`volumeDisposition`, pure, in `packages/workspace`):

| Allocation of that generation | Records | Answer | Who may act |
| --- | --- | --- | --- |
| Live | No proof | `in_use` | Nobody. |
| `stopping` or `terminated` | A proof with `no_consumer_pod`, and the node check passed or not needed | `quiescent` | W-020's checkpoint child may mount it read-only, after listing the claim's consumers again. W-024 may delete it once the generation is replaced or the workspace released. |
| `terminated` | No proof (a row from before W-019) | `unknown` | Treated as quarantined. |
| `quarantined` | The quarantine record | `quarantined` | An operator, then W-024 after `preserveUntil`. |

No answer permits a second writer (rule 7). The function takes a `storage` argument and answers
`unknown` for anything but `pod_scoped_local`, so a CSI class cannot be called `quiescent` before
D4 defines its observation. **`quiescent` is a statement about the moment of the observation.** A
paused controller's late Job can still create a pod on the claim afterwards (section 5's residual).
That pod is harmless only because its launcher never gets a start signal, its materializer answers
`target_exists` (`materializer.ts:95`), and on a cluster the claim is `ReadWriteOncePod`.

**The hold** (`06:90`). Step 2 of the pass. The pass waits, and deletes nothing, while all of these
are true, each read in SQL:

- **this stop was caused by the cancel**: the allocation has a cancel-stop record, which `cancel` writes only in the transaction where it makes the transition itself (`start.ts:174-177`);
- the stage run has **no urgent stop record**;
- the allocation has a start record (a supervisor was granted);
- the last heartbeat fell within `suspectSeconds` of the moment the stop began (`last_heartbeat_at` against `updated_at`, which only the transition writes in this state);
- no stop acknowledgement exists;
- the row has been `stopping` for less than `cancelCheckpointWaitSeconds` (30).

The supervisor learns of the stop from its next renewal (`not_renewable`, `stopping`) and sends
`stop-ack`; the route answers and then runs the pass, which deletes. A supervisor that never
answers costs 30 s inside the 180 s stop deadline. A stop for a lost lease, a lost pod, or a
container exit never waits, and neither does a cancel that arrives after one of those has begun,
even in the gap between that stop's transition and its first delete: such a cancel finds the row
already `stopping`, makes no transition, and so writes no cancel-stop record.

- **Why a record and not a comparison of times.** The cancel record's `created_at` against the row's `updated_at` gives the wrong answer in one interleaving: a cancel takes the stage run's lock and writes its record (`start.ts:168`), then waits for the allocation's row lock behind the pass that is moving the row to `stopping` for a dead supervisor (`start.ts:174`). The record is then older than the transition it did not cause, and the pass would wait 30 s for an acknowledgement that cannot come.
- The round-1 condition "nothing has been deleted yet", which cost two cluster reads a pass, is gone: the cancel-stop record covers every case it was for.

- **Urgent stop** (L3). `cancel` takes an optional fifth argument, `{ urgent: true }`, and stays assignable to the reference interface, as W-018's `materializeCandidate` did. It writes the urgent record under the stage run's lock, even when a cancel record already exists, so a second, urgent cancel shortens a hold in progress. W-119's emergency stop is its first real caller.

**Start-up checks** (`startRunnerProcess`, after the storage class, before the listener and the first pass):

- With `networkGate.mode: 'required'`: read the `kubernetes` Service in `default` and refuse to start unless the gate's deny list contains its cluster address and port. A mistyped address would otherwise pass every gate in the cluster.
- With `nodeCheck: 'required'`: `getNode` on a name that cannot exist must answer 404. A 403 refuses to start; without this every permit would be `not_ready` until its start deadline.
- A warning, never a refusal: the runner tries one connect to each deny target and logs any that does not accept as "probably mistyped". It proves nothing where the runner is itself under a policy, and the metadata address answers only on a cloud node; it is there to catch the typo the start-up check cannot.

**Port and fake.**

- `KubeApi` gains `getNode(name)`, returning name and UID, and `getApiService()`, returning the cluster address and port. `KubePod.spec` gains `nodeName`. `listPods('')` is documented as the whole namespace.
- RBAC: the ClusterRole gains `get` on `nodes`; a Role in `default` grants `get` on the Service named `kubernetes` and nothing else. **The runner gains no right on ConfigMaps.**
- `FakeKube` gains nodes (one by default), `nodeName` at scheduling, the Service, and `driver.loseNode`, which removes the node and its pod objects while the fake kubelet's processes run on, as pod garbage collection does. It is a fake-only fault and is never reported as cluster evidence.

**Config added** (`src/config.ts`): `podListener` (optional), `sourceRate`, `sourceConnections` 4,
`sourceNewConnections`, `podRate`, `review.ceilingPerSecond`, `cancelCheckpointWaitSeconds` 30,
`quarantinePreserveDays` 30, `quarantineEscalateDays` 1, `quarantineOwner`, `nodeCheck`,
`networkGate: { mode, denyTargets }`, `supervisor: { runnerUrl, caConfigMap, caSha256, localPort }`.
Validation gains: `leaseSeconds > 2 * beatSeconds`; `suspectSeconds < leaseSeconds`; the per-pod
interval at most half a beat; the two products above (connections against 512, the per-pod rate
against the review ceiling); and every deny target a literal address and port. `createConfig` refuses, by key, the plaintext flag and the per-source relaxation, as it already refuses W-017's test switches (`config.ts:42`); a production JSON config cannot carry either. `sourceOf` is a function that only `createTestConfig` (in `@factory/runner/testing`) accepts; it is not a field of the exported `RunnerProcessOptions`. A structural test (`w019-testing-boundary`) fails if any file under `apps/*/src` other than `testing.ts` imports `@factory/runner/testing`, with a planted import as its control. The test
configuration may exceed the per-source numbers, because in both local tiers every pod is one
source (A-32).

### 19b: the pod side

**The supervisor** (`apps/supervisor/src`). One process, no dependency beyond the protocol package
and `node:` modules. Its states:

| State | Does | Leaves to |
| --- | --- | --- |
| `boot` | Parses its arguments. Paths are fixed in the production entry: `/var/run/factory-identity/token`, `runner-ca.crt` beside it, `/workspace`. It checks the runner URL and the CA (below). | `gating`; exit 64 |
| `gating` (D11) | With the gate `required`: one round a second. In a round it tries a TCP connect to every deny target and to the listener. A round passes when **every** deny target fails **and** the listener accepts; the supervisor then completes **one** TLS handshake with the listener, and only that makes the gate pass. A waiting gate therefore costs the listener a plain connect a second, not a handshake. Bounded at 120 s. Nothing of the workspace is touched. | `acquiring`; exit 68 |
| `acquiring` | `acquire`, with the gate's report. Retries the retryable denials (`not_ready`, `throttled`, `review_unavailable`, a transport error) from 2 s up to 5 s. The runner's start deadline is the bound. | `preparing`; exit 65 on `duplicate_writer`; 66 on any other final denial |
| `preparing` | Starts the beat. Looks at the workspace through the view (below). Runs one more gate round. | `running`; exit 69 (workspace) or 68 (gate), fenced first |
| `running` | Opens the start gate. Beats. Once a grant reports the harness `terminated` it closes the start gate and drops every hint; the runner is already stopping the pod. | `ending`, `fenced` |
| `ending` | A renewal is denied with `stopping`: sets the stop flag, sends `stop-ack` once, waits for TERM. | exit 0 |
| `fenced` | Any other final denial, or no renewal confirmed by the fence time: sets the stop flag, makes no further call. | exit 70 |
| TERM, in any state | Sets the stop flag and exits within a second. | 0 from `ending`, else 143 |

- **Order: gate, then permit, then workspace.** A gate that never passes then costs nothing: the workspace is still `allocated`, and release works without a checkpoint. A duplicate probes the network and never reads a file of the workspace.
- **The runner URL and the CA** (M2, L1). The production entry refuses a runner URL that is not `https:`, or whose host is a loopback, link-local or unspecified address: inside a pod, loopback belongs to the harness as much as to the supervisor, and a port there can be taken after start. It takes `--runner-ca-sha256` and refuses a CA file with any other digest; the file is read once, at `boot`. It trusts that one CA and no system root, and checks the certificate's name.
- **One connection.** The client keeps a single connection to the listener alive and reuses it for every call; it opens a new one only when that one is lost. The listener's per-source numbers are sized on this.
- **The token** is read from its file on every call and never kept: the kubelet rotates it (`expirationSeconds: 600`, `job-manifest.ts:71`). One `unauthenticated` is retried once after a fresh read.
- **The beat.** Every `beatSeconds` from the grant, with a 5 s request limit. The fence time is the **send** time of the last granted call plus `leaseSeconds - beatSeconds` (50 s), on the monotonic clock. Every grant refreshed the server's lease after that send (rule 4, the acquire retry included), so the supervisor always gives up first. Transport errors, `throttled` and `review_unavailable` are retried every 2 s until the fence time. `Date.now` is forbidden by lint here as in the runner.
- **Hints are coalesced** (B1, H1). `POST /v1/exit` can cause at most **one** early renewal per beat interval, never while a renewal is in flight, and only in `running` before the harness has been reported `terminated`. In every other state it is dropped. A harness that loops on the hint therefore doubles its own pod's renewals at most, and the runner's per-pod bucket bounds even that.
- **The gate's targets.** `--deny-target <address>:<port>`, one to eight, literal addresses only; a name is exit 64. The report lists each target's result. On this machine the list is the API service, `169.254.169.254:80`, and the gateway's Postgres and Temporal ports; W-021 sets the real one, and adds W-023's port when it exists. It shows those rules are active, and nothing about any other. Step 0 found `169.254.169.254:80` refused here even with no policy, so on this machine only three targets (the API service, `:55432`, `:57233`) show a difference; the metadata target is kept for real clusters, and no test claims it as evidence here.
- **The workspace view** (`workspace-view.ts`).
  - It can be built only from a grant, by the pattern of W-018's `FactoryOwnedRepo` (a private symbol only the permit client holds), and it is the only file allowed to import `node:fs` for a workspace path (lint rule and a structural test).
  - **It works only in `preparing`.** Every method asserts the supervisor's state and throws in any other. Its walk is `lstat` by path and then a listing by path, which is safe only while no candidate code is running: after start, a component can be swapped for a symlink between the two calls, and the supervisor would follow it inside its own mount namespace, where the token is.
  - In W-019 it does one thing: `lstat` each component from `/workspace/factory` down to `g<generation>/work/main`, require a real directory at each, and list `work/main`. Every call is logged. With no workspace it does nothing.
  - The README states the rule for everyone after: any read of the workspace once the harness has started uses descriptor-relative, no-follow traversal, or a helper process with no credential (`06:108`).
- **The local endpoint** (`--listen 127.0.0.1:8765`, as `examples/kubernetes-job.json`). Loopback peers only, eight connections, three routes and 404 for the rest:
  - `GET /v1/start` (long poll): `{ start: true }` once the state is `running`; `{ start: false, reason }` once the supervisor is fenced or ending.
  - `GET /v1/stop` (long poll): answers when the stop flag is set.
  - `POST /v1/exit` (256 bytes): the hint. Nothing decides on it (rule 5).
  - None of the three grants anything. The authenticated tool routes are W-075's.

**The launcher** (`launcher.ts`, the harness container's entry): `harness --supervisor <url> -- <program> [args]`.

- It polls `/v1/start` and starts nothing until the answer is `start: true`. On `start: false` it exits non-zero. If the supervisor never answers it waits for TERM; the runner stops the pod when it sees the supervisor's container exit, or at the start deadline.
- Before the program starts nothing hostile is in the pod, so nothing can have taken port 8765 and `start: true` can be believed.
- It sets umask 027, starts the program in a new process group, and exits with the program's code after the hint.
- On TERM, or when `/v1/stop` answers, it sends TERM to the group and KILL to the group 10 s later.
- **It never signals pid -1.** Under the fake kubelet that would reach every process of the developer's session. A lint rule forbids a negative literal pid outside the one group-kill helper, and a test checks it.
- Once it has started the program, the launcher is as untrusted as the program (same uid, same container).

**Scripted harness** (A-33; extends A-27, stands in for W-077). The image `factory-harness-scripted`
is the launcher plus one script chosen at build time, as the stub's modes are: `idle`, `exit0`,
`write-file` (writes into `work/main`, then exits 0), `spawn-tree` (a child in the group, and a
grandchild that calls `setsid` and ignores TERM; pids go to `/tmp`), `ignore-term`, `hint-flood`
(posts the exit hint in a tight loop). `spawn-tree` is for the k3s tier. No fake-tier file runs it;
if one ever does, its teardown kills the recorded pids, because the fake kubelet's group kill does
not reach a process that left the group (`fake-kubelet.ts:5`).

**Manifest** (`job-manifest.ts`; still a pure function of rows and config, no `StageInput`):

- Supervisor arguments: `serve --org --allocation --epoch --generation [--workspace] --runner <url> --runner-ca-sha256 <hex> --listen 127.0.0.1:<port> --network-gate <mode> [--deny-target ...]`.
- Harness arguments: `harness --supervisor http://127.0.0.1:<port> -- <program>`.
- The `factory-identity` projected volume gains a `configMap` source for the listener's CA (`runner-ca.crt`). The CA is public; the token stays the only secret in the volume (`06:110`). The digest in the arguments is what makes it tamper-evident: an attach compares the whole Job spec (`job-manifest.ts:120-124`), and the supervisor compares the file.
- The committed `job.expected.json` changes with them. A Job rendered by W-017's code no longer equals the re-rendered one and would quarantine on attach; none exists outside tests.

**Modes** (C1). In `packages/workspace`:

- **No exported signature carries a mode.** `index.ts` re-exports everything in `paths.ts` and `materializer.ts` (`export *`), so a fourth argument on `ensureSafeChild`, or a mode option on `LocalMaterializer`'s constructor, would be public. Instead a new module, `src/internal/pod-mode.ts`, which the index does not re-export, holds a `PodMode` token that only it can mint (a private symbol, as `FactoryOwnedRepo` in `git.ts:16-28`), the child-directory helper that takes a mode, and `createPodMaterializer`. `@factory/workspace/pod` (`pod-exports.ts`) exports `createPodMaterializer` and nothing else of it.
- `ensureSafeChild` keeps its three arguments and its 0700. `LocalMaterializer` accepts an optional `PodMode`; without one, which is every host caller, its three `mkdirSync` calls at `materializer.ts:98`, `:99` and `:156` stay 0700, and with one they and the two child levels are 0750. A caller outside the package cannot build the token. `assertSafeRoot` and the publisher are untouched.
- The pod entry (`materialize-run.ts:91`) makes `/workspace/factory` at 0750, calls `createPodMaterializer`, and sets `process.umask(0o027)` before any Git runs, so `git/` and `work/main` come out 0750 with files 0640. `verifyCheckout` compares only the executable bit, so the umask cannot fail it.
- Under `fsGroup` every level is group 10001 with the setgid bit (seen in 17b as `2700`), and the supervisor holds 10001 as a supplementary group (step 0 item 2). In the pod the change exposes nothing new: the harness owns the tree either way, and only the supervisor gains a read.
- W-018's eleven test files pass unchanged, because the default is unchanged.

**Images and script.**

- `deploy/images/supervisor` and `deploy/images/harness-scripted`, built as the materializer image is: from a **staged context of named files**, Node, tini, a numeric user, apk removed, pinned by digest in production configuration. **No test entry is in any image.** A test asserts the staged contexts contain no path under `test/`.
- `scripts/k3s.sh up` builds them and makes a throwaway CA and an **ECDSA P-256** listener certificate whose name is the address step 0 found (a handshake with it costs the listener a fraction of an RSA one; the choice is recorded for INT-05 in A-32). The keys are written outside `.k3s/ctx` (the build contexts), mode 0600, and the CA's key is deleted once the certificate is signed.
- It creates the CA ConfigMap with `immutable: true`, writes its digest and the listener's address and port to `.k3s/env`, and **applies the local egress policy** (below). The script holds the admin certificate; the runner's account never writes a ConfigMap.
- The stub images stay for W-017's tests.

**The local egress policy** (`deploy/k8s/local/egress-listener-only.yaml`, a template the script
fills). Default-deny egress for every pod of `factory-exec-local`, with one allow rule: the
listener's address **and port**. It is applied on **every** `k3s.sh up`, so every k3s run, W-017's
included, has it; their pods need no network. It is a local-tier file, marked as such, and W-021
replaces it. Two reasons: the gate has something real to observe, and a pod cannot reach the
Mac's Postgres, whose admin password is in `compose.yaml:8`, or Temporal (`09:77` forbids both).

**Fake kubelet.**

- `ProgramFactory`'s context (`fake-kubelet.ts:17`) gains the pod, a token file per pod that mounts the projected volume (written with `FakeKube.mintToken`, rewritten by `rotateToken`), and one loopback port per pod.
- **Volumes are keyed by what they are.** A `persistentVolumeClaim` volume maps to one host directory per **claim name**, shared by every pod that names that claim. An `emptyDir` maps to a fresh directory per pod. Every generation's volume is called `workspace` (`job-manifest.ts:47`), so keying by volume name would put two generations in one directory, and keying by pod would hand a duplicate its own empty one.
- The driver gains `pause` and `resume` for a container's process group (STOP and CONT).
- The supervisor and the launcher run through **test entries** in `tests/recovery/test/entry`, which take their paths, port and a plaintext loopback runner URL from the environment. The production entries read no environment variable, as with A-31, and would refuse that URL.

### Race and crash rules

1. **Two supervisors, one permit.** Unchanged from W-017: the compare-and-swap on `pod_uid` picks the winner. The loser reads `duplicate_writer` and exits 65. It has probed the network and opened its token and CA files, and nothing else. The `starting` pass deletes it as a bad pod.
2. **A supervisor dies.** `restartPolicy: Never`: nothing restarts it. The next `running` pass sees the container `terminated` and stops the pod, within one reconcile interval. If the status is late, the lease is the backstop: `suspect` at 30 s, `stopping` at 60 s. The harness holds no credential, and every remote write needs an epoch the runner checks.
3. **A supervisor is paused and resumes after its lease has passed.** If its local fence time has passed it exits 70 and makes no call. If it has not (a short pause), its next renewal is judged by the server. Before either, it does nothing that carries authority: the start gate opens only while the local fence time has not passed. Node suspend can stop the monotonic clock; then the server's denial is the only fence, which the fourth rule already assumes.
4. **The runner is unreachable.** Renewals are retried until the fence time. An outage shorter than 50 s costs nothing. A longer one fences every writer, and the returning runner finds every lease expired. That is the spec's 60 s, not a defect, but it is a product consequence: D27, P-28. The admission limits above exist so that a harness cannot cause this for others.
5. **A late acquire retry, and a concurrent one.** The first acquire commits, its answer is lost, and the supervisor retries 58 s later. The retry is the renewal statement: it is granted only if the lease is unexpired, and it refreshes it, so the fence time the supervisor takes from that grant is one the server gave. After expiry it is denied and the supervisor exits 66 having started nothing. The same holds for two calls of one pod in flight together: the second reads `starting` in its guard and finds `running` under the lock of its last transaction (`permit.ts:188`). Returning the row there with no refresh would in fact be safe, because that call was sent before the first one's commit set the lease; but it is routed through the renewal statement as well, so that no reader has to make that argument again.
6. **Proof against quarantine.** B judges "not proved" at the deadline while A, a moment later, sees the pod gone and registers a proof. B's quarantine move takes the row lock, finds the link and refuses; B's pass goes on to settle and terminate with A's proof. If B's move commits first, A's `register` finds the row `quarantined` under the lock and does not register; A's object is an orphan for the artifact sweep. The end state is never both.
7. **A crash between storing a proof and `terminated`.** The next pass, of any controller, reads the link first and goes straight to settle and terminate. A proof without `terminated` is repaired; `terminated` without a proof cannot be written.
8. **A crash between putting a quarantine object and the transition.** No link, no state change: the next pass does both again.
9. **The object store is down.** No put, so no proof and no quarantine record, so no terminal transition: the allocation stays `stopping`, live, with its capacity row, and its stage run cannot be allocated again. That is the safe direction and it is an operational dependency the runner did not have before.
10. **A permit races a cancel.** The hold needs a start record and a recent heartbeat, so an allocation whose permit has not committed is deleted at once, as today.
11. **A late `stop-ack`.** After the delete has begun the pod read refuses it; after `terminated` or `quarantined` the state check does. Either way it writes nothing but its capped, audited denial.
12. **A cancel after another stop has begun.** It finds the row `stopping`, makes no transition and writes no cancel-stop record, so nothing waits. That is true in the gap before the first delete, across a runner restart, and when the cancel was waiting on the row lock while the stop was being written.
13. **The harness forges or floods.** It can reach the listener (`09:77`) and the local endpoint. It has no token: the listener charges its source, answers 401, and never reaches the per-pod bucket, the review budget or the database. Junk from one source does not slow a valid token from the same source. On the local endpoint it can ask for start (no effect) or send the hint, which is coalesced to one renewal a beat and capped again at the runner.
14. **Token rotation mid-call.** The file is read per call. A token that expired between read and review is one retry.
15. **A harness that exits when nobody is told.** The launcher's hint is not needed: the `running` pass and the next renewal both read the container's state from the cluster.

### Files

| File | Content |
| --- | --- |
| `packages/runner-protocol/{package.json,README.md,src/pod-api.ts,src/exit-codes.ts,test/vectors.json}` | The wire contract (19a). |
| Entries in `tools/boundaries.json` | `@factory/runner-protocol`; `@factory/supervisor` (`allowWorkspace`: runner-protocol only; `denyExternal`: `pg`, `@temporalio/`, `fastify`); `importableApps` for `@factory/recovery-tests`: runner and supervisor. |
| `apps/runner/src/listener/pod-listener.ts`, `src/listener/buckets.ts`, `src/pod-guard.ts`, `src/stop-ack.ts`, `src/startup-checks.ts` | The listener and its four limits (new connections, open connections, source charge, per pod), the guard, the acknowledgement, the two checks (19a). |
| `apps/runner/src/records.ts`, `src/quiescence.ts`, `src/reconcile.ts`, `src/permit.ts`, `src/start.ts`, `src/core.ts`, `src/config.ts`, `src/main.ts`, `src/runner.ts` | Record ids and bodies; the three new proof conditions; the container-exit stops, the hold, the fenced-workspace stop, the proof-first order, the proof read in the quarantine move, the open-quarantine count; the start record, the lease clause, the retry through the renewal, the denial order, the harness state; `urgent` in cancel; `artifacts` required; the new settings and their validation; the checks and the listener; `watchEvents`' message names W-023 (19a). |
| `apps/runner/src/kube/api.ts`, `https-client.ts`, `fake.ts`, `fake-kubelet.ts` | `getNode`, `getApiService`, `nodeName`; nodes, the Service and `loseNode` (19a); token files, claim-keyed volumes, ports, pause (19b). |
| `packages/workspace/src/quiescence-proof.ts`, `src/quarantine-record.ts`, `src/volume-disposition.ts`, `src/index.ts`, `README.md` | Record types, `prepare`, `register`, readers; the disposition function (19a). |
| `packages/workspace/src/internal/pod-mode.ts`, `src/materializer.ts`, `src/pod-exports.ts` | `src/internal/pod-mode.ts` (new): the token, the helper and `createPodMaterializer`; the materializer's optional token; the pod export (19b). |
| `packages/database/src/allocation.ts` | The workspace condition in the renewal; the lease guard on `starting → running`; the audit read with details; the open-quarantine count (19a). |
| `packages/test-support/src/faults.ts` | `runner.after_proof_put`, `after_proof_registered`, `before_quarantine_move`, `before_terminate_tx`, `after_quarantine_put`, `after_stop_ack`, `before_cancel_allocation_lock`, `before_permit_last_tx`. |
| `apps/supervisor/{package.json,README.md}`, `src/main.ts`, `src/args.ts`, `src/runner-client.ts`, `src/token-file.ts`, `src/network-gate.ts`, `src/heartbeat.ts`, `src/state.ts`, `src/local-endpoint.ts`, `src/workspace-view.ts`, `src/launcher.ts`, `src/scripts/*.ts` | The supervisor, the launcher, the scripted harness (19b). |
| `apps/runner/src/job-manifest.ts`, `src/pod/materialize-run.ts`, `test/fixtures/job.expected.json` | Arguments, the CA source and digest; 0750 and the umask (19b). |
| `tests/recovery/{package.json,test/*,test/entry/*}` | The cross-app fake-tier tests and the two test entries (19b). The directory is W-079's module; its framework is still not built, and AC-103 is not claimed. |
| `deploy/images/supervisor`, `deploy/images/harness-scripted`, `deploy/k8s/runner-rbac.yaml`, `deploy/k8s/local/egress-listener-only.yaml`, `scripts/k3s.sh` | Images; `get nodes` and the one Service; the local policy; the CA, its ConfigMap and the listener address (19b). |
| `eslint.config.js` | `Date.now` and negative pids in `apps/supervisor/src`; outside `src/scripts`, `node:fs` only in `workspace-view.ts` and `token-file.ts`. |

Not changed: anything under `apps/worker`; any migration; D17's two manager methods; the
publisher; `w017-states.test.ts`; `w017-main.test.ts` (the listener is optional).

**Every edit to a W-017 file**, so that none is a surprise:

| File | Edit | Commit |
| --- | --- | --- |
| `apps/runner/test/harness.ts` | One line pinning `cancelCheckpointWaitSeconds` to 0 for W-017's files, and `nodeCheck` to `off`. No W-017 assertion changes because of either. | 19a |
| `apps/runner/test/w017-permit.test.ts:270-281` | It calls `terminateTx` directly; it now stores a proof before its last call and gains the `needs_proof` case as its control. | 19a |
| `apps/runner/test/conformance/suite.ts`, `kube-conformance.fake.test.ts`, `kube-conformance.k8s.test.ts`, `test/k8s/cluster.ts` | Rows 16 to 21 and the driver calls they need. | 19a, 19b |
| `apps/runner/test/w017-names-manifest.test.ts`, `test/fixtures/job.expected.json` | The new committed document. | 19b |
| `apps/runner/test/w017-pod-materializer.test.ts` | Two added cases (the root's mode, the umask). | 19b |
| `apps/runner/test/w017-run.k8s.test.ts` | No edit expected. It now runs under the local egress policy; its pods use no network. | 19b |

No W-017 test asserts a stop reason for a pod whose container exited (checked: the only
`stopReason` assertion is `every_pod_bad`, `ac-10-duplicate-run-start.test.ts:199`). If the first
run of 19a shows another edit is needed, it is added to this table before the review, not after.

### Tests

Real Postgres everywhere a row is involved. Time is moved by backdating row timestamps and running
one pass; the only real waits are single beats, with `beatSeconds: 1`, `suspectSeconds: 5`,
`leaseSeconds: 10` and a per-pod interval of 250 ms in the cross-app files. **Every refusal has, in
the same setup, the accepted case.** A cross-app file keeps at most two pods alive at once and
closes its kubelet in `afterEach`; each pod is three Node processes.

**19a: fake tier, callers are tests.**

| Test file | Shows |
| --- | --- |
| `packages/runner-protocol/test/w019-pod-api.test.ts` | Every request and answer round-trips through the committed vectors. Unknown key, `__proto__`, `constructor`, oversized body, oversized token, non-integer epoch: each refused. **Control:** the vector itself parses. The exit-code table has no duplicate. |
| `apps/runner/test/w019-listener.test.ts` | With a throwaway CA: the three routes reach their service; wrong method, path, content type and a 17 KiB body are 405, 404, 415 and 413 with nothing written. `createConfig` refuses a listener with no certificate on **any** address, loopback included, and refuses `0.0.0.0`. **Control:** `createTestConfig` with its flag accepts plaintext on `127.0.0.1`. A handshake that stalls is cut at 5 s; a slow body at 5 s. **Connections:** the fifth open connection from one source is refused while a second source connects; configuration refuses a per-source cap whose product with the pools exceeds 512, and a per-pod rate above the review ceiling's share. **Charging:** junk tokens from one source empty its bucket (the burst is 50) and the next one is 429 with the connection closed; a request with a **valid** token from that same source, sent next, is granted. The same emptying happens with **one failed token repeated** (the failed-token memory's fast path), with **tokens carrying random key ids**, and with requests to a wrong path, each on one kept-alive connection. The failed-token memory holds 4,096 entries after 5,000 distinct failures, the oldest gone, and no failure scans it (a counter on the test double). **Control:** with the old order (charge before verification, a test switch) the same valid request is 429. A full table evicts its oldest entry and still admits a new source. No counter name and no log line contains a path, a source or a token. The response is written before the pass starts (a fault holds the pass; the client already has its answer). |
| `apps/runner/test/w019-listener-churn.test.ts` | **The churn flood.** Source A opens connections as fast as it can for three seconds, in two shapes: a ClientHello and a hang-up, and a full handshake with a junk request. The server begins at most the burst plus the refill (20 + 5 a second) handshakes for A; the rest are destroyed before any TLS work and counted. Source B's renewals, one a beat throughout, are all granted inside the 5 s request limit. **Control:** with the new-connection bucket off (a test switch) every one of A's connections reaches the handshake (the server's handshake counter equals A's attempts). The control asserts the count and not a delay, which this machine's load would make a coin toss; B's latency is recorded in both runs. The listener's certificate in this file is ECDSA P-256, and a test asserts `k3s.sh` asks for the same curve. **Review budget:** with 100 live writers reported by a pass the refill is 100 a second, with 2 it is the floor of 20, and with 1,000 it is the ceiling and the counter moves. |
| `apps/runner/test/w019-pod-rate.test.ts` | **The flood.** 200 renewals with pod A's valid token in one burst: five reach the review, the rest are `throttled`, and the fake's call log shows no `reviewToken` and no `getPod` for them, no row and no audit row. Pod B's renewal, sent in the middle, is granted. **Control:** with the per-pod bucket off (a test switch) the same burst empties the shared budget and B is `throttled`. **Audit cap:** 100 denied renewals for a `stopping` allocation, spaced to pass the bucket, write at most the cap's rows; the rest are counted. **Control:** the first denial is audited. |
| `apps/runner/test/w019-pod-guard.test.ts` | For each route: a token for another allocation, another pod's token, a pod with a deletion timestamp, a wrong epoch, each state outside the route's. Each is its own denial. **Fenced writer:** `replaceWriter` is called directly while the allocation is `running`; the next renewal is `stale_epoch` (not `lease_expired`), the lease is not extended, and the next pass stops the allocation with `workspace_fenced`. **Control:** the same renewal a moment before the fence is granted. **Lease, retry:** the first acquire is granted; the lease is backdated past expiry; the same pod's acquire retry is denied and nothing is extended. **Control:** the retry with a fresh lease is granted and `controller_lease_until` moved forward. **Two acquires of one pod at once:** the second is held after its guard read until the first commits; its grant comes from the renewal statement and the lease moved again. **Lease, first commit:** with the start deadline backdated the acquire is `not_startable` and the row stays `starting`. **Stopping:** a renewal for a `stopping` allocation whose workspace is already `quiescing` answers `not_renewable`, `stopping`. `stop-ack` is accepted there, with the workspace `active` and with it `quiescing`, and refused in `running`. A request with no token writes nothing. |
| `apps/runner/test/w019-start-record.test.ts` | A grant writes the start record with the reviewed pod and the node read from the port; a pod-supplied report is stored as reported, capped at 1 KiB. A retry by the same pod writes no second row. A foreign row at the pinned id is a hard error. **A request that fails the review causes no `getNode`** (the call log). With `nodeCheck: 'required'` and an unreadable node the permit is `not_ready`. **Control:** with the node readable it is granted. A renewal request that carries a `harness` field is refused as an unknown key. **Control:** the same request without it is granted, and its answer's `harness` field follows the fake's container status. |
| `apps/runner/test/w019-quiescence-proof.test.ts` | After a cancel with the fake kubelet: one artifact with the pinned purpose and schema, the allocation `terminated`, the workspace `retained`; the body's observation time is earlier than the link's creation. **Order:** with a fault at `after_proof_put` and at `after_proof_registered`, A dies; B's pass ends at `terminated` using the link, and exactly one link exists. `terminateTx` answers `needs_proof` and `settleWorkspace('proof')` refuses without the link. **One-way door:** proof stored, then a foreign labelled pod appears; the allocation still terminates. **Control:** the same pod before the proof keeps it open and it is quarantined at the deadline. **Node:** `loseNode` while the writer's processes live: not proved (`writer_node_missing`), then quarantined; the process is shown alive first. **Control:** the same stop with the node present is proved. **No start record:** a cancel between the writer claim and the last commit is proved with the node check `not_needed`, though the node is gone. **Claim:** an unlabelled, unfinished pod naming the claim keeps the proof open. **Control:** the same pod naming another claim does not. A capped namespace list is not proved. A pod that finished on its own is recorded `finished` with exit codes; a deleted one `gone`; no message text is in the body. **Store down:** with a store that fails every put, a proved stop stays `stopping` past the stop deadline, is never quarantined and never terminated, and keeps its capacity row; when the store returns the next pass terminates it. |
| `packages/workspace/test/w019-proof-records.test.ts` | `prepare` refuses any identity but the runner's, and the audit row is there although the caller then rolled back its own transaction. `register` on a transaction that rolls back leaves no link. A second `register` under the lock answers `exists`. The reader ignores a link whose artifact has another producer and one whose body names another allocation; **two runner-produced links are a hard error**. A body over 64 KiB is refused. A handle cannot be built outside the module. **Control:** the runner's record is read back equal. The same cases for the quarantine record. |
| `apps/runner/test/w019-quarantine-record.test.ts` | Each of the three sources writes the record in the transition's transaction: a fault at `after_quarantine_put` leaves neither, and the retry leaves both. The body has no message or reason text, and the artifact is `restricted`. `describeRun` returns the ref and `needsOperator`; a pass reports the open quarantine in its summary once its `escalateAfter` is backdated. Release is refused, and the PVC's UID is the same before and after. The next `startOrAttach` lands on generation 2 with a new claim name; the audit row cites the record; generation 1's claim is in no manifest and no delete request (the fake's call log). **Forced interleaving (B3):** B evaluates "not proved" past the deadline and is held at `before_quarantine_move`; A sees the pod gone and registers a proof; B is released: the allocation is **not** quarantined, no quarantine link exists, and B's pass ends `terminated` with the workspace `retained`. **Control:** the same hold with no proof registered ends `quarantined` with the workspace `quiescing`. The mirror: B's move commits first and A's `register` writes no link. |
| `apps/runner/test/w019-volume-disposition.test.ts` | The table above, row by row, plus `unknown` for any storage kind but `pod_scoped_local`. Property: for every allocation the suite's helpers can build, `renderJob` names exactly `pvcName(org, workspace, allocation.generation)` or no claim. |
| `apps/runner/test/w019-container-exit.test.ts` | With the fake kubelet: the harness container exits 0 while the supervisor stub runs; the next pass moves `running → stopping` with `harness_exited`, deletes without a hold, stores the proof, and ends `terminated` with the workspace `retained`; `getRun` answers `reconciling`. The supervisor container exits while the harness runs: `supervisor_exited` on the next pass, with the lease still fresh. **Control:** with both running, ten passes change nothing. In `starting`, a pod whose supervisor has exited is deleted as a bad pod, and a lone one stops the allocation. A renewal that sees the exited container answers and then sets off one pass; a second renewal while that pass runs sets off none. **A `finalizing` row is unchanged by a pass** (W-017's assertion, kept). |
| `apps/runner/test/w019-cancel-window.test.ts` | With the window at 30: after a cancel, a pass sends **no** delete while every condition holds; the renewal answers `not_renewable`, `stopping`; `stop-ack` is recorded and its pass deletes; a repeat of `stop-ack` writes nothing and starts no pass. Backdated 31 s with no acknowledgement: deleted. Each condition removed in turn deletes on the first pass: no start record, a stale heartbeat, a stop for a lost lease, **an urgent cancel**. **A pod already Terminating from outside the runner** (active deadline, eviction, manual delete) during a hold: `stop-ack` is refused, the pass sends no delete, and the hold ends at 30 s, well inside the 180 s stop deadline; the proof decides the outcome. A second, urgent cancel during a hold ends it. **A cancel after a container-exit stop:** a `supervisor_exited` stop is written and the test cancels before any pass deletes; the next pass deletes at once and there is no cancel-stop record. The same with the cancel **held on the row lock** while the stop is written, which is the case a comparison of timestamps gets wrong. **Control:** a cancel that itself moves a `running` allocation writes the record and the pass holds. **Control:** with the window at 0 the first pass deletes, as in W-017. |
| `apps/runner/test/w019-startup-checks.test.ts` | With the gate `required` and a deny list that lacks the fake's API-service address, the process refuses to start; with a node read answering 403 and `nodeCheck: 'required'`, the same. **Controls:** the correct list starts; a 404 on the probe name starts. A deny target that nothing listens on is logged as probably mistyped and does not stop the start. With no `podListener` no port is opened. Config: `leaseSeconds` equal to twice the beat, `suspectSeconds` equal to the lease, and a deny target given as a name are each refused. |
| `apps/runner/test/kube-conformance.fake.test.ts` (rows 16 to 18, 21) | See the conformance additions below. |

**19b: units.**

| Test file | Shows |
| --- | --- |
| `apps/supervisor/test/w019-runner-client.test.ts` | Against a local `node:https` server: the CA is pinned and system roots are not used; **a certificate from the right CA with the wrong name is refused**; **a CA file whose digest is not the argument's is refused at boot** (exit 64). The production argument parser refuses `http:`, `https://127.0.0.1`, `https://[::1]`, `https://169.254.1.1` and `https://0.0.0.0`. **Control:** an `https:` URL with a routable host and the right digest connects. The token file is read once per call (the server sees the rotated token on the next call); one `unauthenticated` is retried once and a second is final; the request limit is 5 s. Each final denial maps to its exit code. |
| `apps/supervisor/test/w019-heartbeat.test.ts` | Injected clock and transport. Beats at 10 s. With every renewal failing in transport, the fence fires at send time plus 50 s, never later; with one success at 40 s it moves. `not_renewable`/`stopping` takes the `ending` path and sends one `stop-ack`; any other final denial is fenced at once. **Hints:** 1,000 hints inside one beat cause exactly one extra renewal; a hint while a renewal is in flight causes none; a hint in `preparing`, `ending`, `fenced`, or after a grant reported the harness `terminated`, causes none. **Control:** a single hint in `running` causes one, and a run of grants never fences. |
| `apps/supervisor/test/w019-network-gate.test.ts` | Three local ports stand in for the deny targets and one for the listener. The gate holds while **any** deny target accepts, and while the listener does not answer; it passes within one round of the last one closing; each target's result, the wait and the rounds are in the report. Never closing: exit 68 at the bound, and no acquire was sent. A target given as a name is exit 64. `disabled` sends the acquire at once and reports `disabled`. The round after the grant, finding a target open again, fences and exits 68. |
| `apps/supervisor/test/w019-local-endpoint.test.ts` | `/v1/start` holds until `running`, then answers; after a fence it answers `start: false`. A non-loopback peer, a ninth connection, an unknown route and a 1 KiB exit hint are refused. A hint changes no state. |
| `apps/supervisor/test/w019-launcher.test.ts` | No program starts before `start: true` (a marker file is absent while the poll is held; **control:** it appears after). `start: false` exits non-zero with no program. TERM reaches the program's group, and KILL follows for a program that ignores it. The program's umask is 027. Structural: no negative pid but the group helper. |
| `apps/supervisor/test/w019-workspace-view.test.ts` | The view cannot be built without a grant (it does not compile, and the runtime guard throws). **Every method throws in any state but `preparing`**, `running` included. A symlink at any component, a file where a directory should be, and an unreadable `work` each fail the check with their own reason. **Control:** in `preparing`, a materialized tree passes. Structural: only the two allowed files import `node:fs`. |
| `packages/workspace/test/w019-modes.test.ts` | Through the package index and through `LocalWorkspaceHost` every level is 0700, as today, and neither offers a way to ask for another mode. Structural, over the package index's own export list: no `createPodMaterializer`, no `PodMode`, nothing from `internal/`; `ensureSafeChild` still takes three arguments; a `PodMode` built by hand outside the module throws, and `LocalMaterializer` given one refuses it. Through `createPodMaterializer`: the organization, workspace, generation and `work` levels are 0750, and nothing is group- or world-writable. The publisher's scratch levels, its staging directory and its bundle are 0700, 0700 and 0600 in both cases. A 0770 root is still `unsafe_root`. |
| `apps/runner/test/w019-fake-kubelet.test.ts` | Two pods that name the same claim see one directory: a file written by the first is read by the second. **Control:** two pods naming different claims do not, and two pods with an `emptyDir` do not. A rotated token file has new contents and both tokens review as the fake says. `pause` stops a container's beats and `resume` restarts them. |
| `apps/runner/test/w019-images.test.ts` | The staged build contexts for the two new images list only named source files, none under a `test/` directory, and neither test entry. |
| `apps/runner/test/w017-pod-materializer.test.ts` (extended), `w017-names-manifest.test.ts` (fixture) | The entry's root is 0750, and files written under the entry's umask are 0640. The rendered Job equals the new committed document, with the CA digest in the supervisor's arguments; the builder still takes no `StageInput`. |

**19b: cross-app, fake tier** (`tests/recovery/test`; the real runner, listener, `FakeKube` and
fake kubelet; the real supervisor and launcher as processes).

| Test file | Shows |
| --- | --- |
| `ac-10-duplicate-supervisor.test.ts` | The fake injects a second pod for the Job with an identical receipt; both name the same claim, so both see the same directory, and both run the real supervisor. Exactly one is granted. The other exits 65; its log has no workspace-view event; a snapshot of the shared tree (paths, modes, sizes, hashes, as W-018's tests take one) is equal before and after its run; its launcher started no program. The winner's launcher started one, once. **Control:** the winner's log has the view event, and in a fresh setup the second pod alone is granted. The next pass deletes the loser and only the loser. **What this does not show:** that the loser made no read at all at the system-call level. That rests on the view's construction rule and its structural test, and on `ReadWriteOncePod` at K. |
| `ac-12-stale-live-writer.test.ts` | A writer runs. Its supervisor's group is **paused**, and the lease is backdated past expiry. The pass moves it to `stopping`; the fake holds the pod's delete (the process is shown alive); the stop deadline is backdated: `quarantined`, with the record, the workspace `quiescing`, the claim untouched. A replacement is requested: generation 2, epoch 2, a new claim and so a new directory, a new supervisor granted. Then two assertions, kept apart. **The server half:** the test itself calls the renewal route with the old pod's token and epoch; it is denied, no lease moves, and nothing is written but the denial's audit row. **The supervisor half:** the old supervisor is resumed after its local fence time; it exits 70, and the listener's log shows no request from that pod after the resume. Its launcher is told to stop, and generation 2's tree snapshot is unchanged throughout. A publish with epoch 1 is `stale_epoch` (W-018's publisher, called here). **Control:** the same sequence with the delete not held ends `terminated` with a proof and no quarantine record. In both, no manifest names generation 1's claim. |
| `ac-15-process-cancellation.test.ts` | The harness script starts a long-lived child. Cancel: the hold; the supervisor's next beat is denied; it sets the stop flag and sends `stop-ack`; the launcher's TERM reaches the group; the pod delete follows; the child's pid is gone; the allocation is `terminated`, with the proof stored, the workspace `retained`, the capacity row `released` and the stop reason recorded. `getRun` answers `cancelled`. With a child that ignores TERM the same ends after KILL. With an urgent cancel the delete does not wait for the beat. **Control:** before the cancel the child is alive, and a renewal is granted. **Protocol only:** a child that leaves the process group is not claimed here. |
| `w019-hint-flood.test.ts` | Pod A runs `hint-flood`; pod B runs `idle`. Over ten beats the listener's log shows at most two renewals a beat from A, every one of B's renewals granted, and both allocations `running` at the end. **Control:** the same two pods with A's supervisor started by a test entry that does not coalesce: most of A's renewals are answered `throttled` by the per-pod bucket, the fake's count of token reviews stays under the shared budget, and B is still granted every time. |
| `w019-lifecycle.test.ts` | Start to end with `exit0`: gate (ports the test closes), permit, view, start, the harness exits, the pass sees it, `stopping` with `harness_exited`, pod stopped, proof, `terminated`, `retained`. With `write-file`: the file is in the tree and the view listed the directory. A supervisor killed mid-run is stopped by the next pass as `supervisor_exited`, before its lease expires. **Runner outage:** the listener is closed for less than the fence time and reopened; the writer survives. **Control:** closed past it, the supervisor exits 70 and the pass stops the allocation. A rotated token file is used by the next beat. **A late acquire retry:** the first grant's answer is dropped by a proxy and the lease backdated; the retry is denied and no program started. |

**Conformance additions** (`apps/runner/test/conformance/suite.ts`, both tiers unless marked):

| # | Behaviour asserted | k3s status |
| --- | --- | --- |
| 16 | `getNode` returns the name and UID of the node a scheduled pod names; a missing node is 404. | To confirm (step 0, item 7) |
| 17 | A list with no selector returns an unlabelled pod that mounts a claim, with the claim's name in its volumes. | To confirm |
| 18 | In a pod of two containers, when one exits the status shows it `terminated` with its code while the other runs. | To confirm (step 0, item 4) |
| 19 | Cluster only, RBAC: the runner's account can `get` a node and cannot list, patch or delete one. | To confirm |
| 20 | Cluster only, RBAC: neither the runner's nor the supervisor's account can create, update, patch or delete a ConfigMap in the execution namespace, and the CA ConfigMap refuses an update because it is immutable. | To confirm |
| 21 | `getApiService` returns the `kubernetes` Service's cluster address and port. Cluster only: the runner's account cannot read another Service in `default`. | To confirm (step 0, item 7) |

**k3s tier, opt-in.** Run once at the end of 19b and at its review, on AC power, never beside the
full suite. **Every run is under the local egress policy and TLS**, and the gate is `required` in
every W-019 file. The build-log line gives the date, the image digest and the result.

| Test file | Shows |
| --- | --- |
| `apps/runner/test/w019-supervised-run.k8s.test.ts` | The real controller, the listener on the host, the real images. The supervisor verifies the CA's digest, passes the gate, reads its own projected token, is granted, and beats; the allocation is `running` with a fresh heartbeat. **uid 10002 lists `work/main`** (the view's log line), and the backing directory's levels are `2750 10001:10001` by `stat` in the node. The `write-file` harness writes through its read-write mount. The harness exits; the pass stops the pod; the proof names the node and the claim; the PVC survives; the allocation is `terminated`. A hand-made second pod on the claim stays `Pending` (W-017's case, now with the supervisor image). |
| `apps/runner/test/ac-15-tree-stop.k8s.test.ts` | `spawn-tree` at production timings. Cancel. The supervisor acknowledges within one beat. **Every process of the tree, including the one that called `setsid` and ignores TERM, is gone when the pod object is gone**, by the runtime view of conformance row 4. The times from cancel to delete and from delete to gone are recorded and asserted under 30 s and 20 s. **Control:** before the cancel all three pids are alive. Then `terminated`, the proof, `retained`. |
| `apps/runner/test/w019-network-gate.k8s.test.ts` | Under the standing policy, with this machine's four deny targets: the start record lists every target as failed, and the harness's start is later than the gate's last round. **A probe pod in the namespace cannot connect to the gateway's `:55432` or `:57233`**, and can complete a handshake with the listener. **Control:** a run whose deny list also names the listener's own address and port never passes: the supervisor exits 68, no permit was requested, and the workspace is still `allocated`. This shows those rules active on this CNI, as D11 says, and nothing about any other rule. |

### Which tier proves what

| Claim | F | K | Needs R |
| --- | --- | --- | --- |
| One permit winner between two real supervisors; the loser exits | Yes | A second pod cannot mount the claim (W-017) | Duplicate pods from node loss |
| The loser does not touch the workspace | By construction, log and snapshot of the shared directory | By `ReadWriteOncePod` | |
| A fenced or expired writer is refused and stops itself | Yes, the two halves separately | The beat and the grant only | Partition |
| One pod cannot starve another's renewals | Yes (the four limits, the request flood and the connection churn) | Not shown: behind NAT here | Real pod addresses |
| Quarantine record, isolated replacement, no claim of another generation ever mounted | Yes | Proof and PVC survival on the happy path | |
| The node check | Yes (fake fault) | The positive read only | Node loss |
| Detachment | `no_consumer_pod` | The same; `local-path` is a host directory | CSI `VolumeAttachment` |
| Cancel protocol, records, cleanup recorded | Yes | Yes | |
| **Tree stop, including a process that left its group** | No (protocol only) | **Yes** | A sandboxed runtime |
| uid 10002 reads the checkout | No (one uid on the Mac) | Yes | |
| Network gate | Mechanism, several targets | Four rules, one CNI | The real CNI and W-021's policy (D11, AC-56) |
| TLS, the pinned CA and its digest | Client and listener units | End to end | Issue and rotation (INT-05, INT-06) |

### What W-019 claims, and what it does not

- **AC-10.** A real duplicate supervisor exits and launches nothing; one writer launches: fake tier. With W-017's lines this completes AC-10 at the runner. Not claimed: the same through the Activity (W-023); duplicate pods on a real cluster.
- **AC-12, the quarantine half.** A lease expires while the old process still runs; the old writer's pod-facing calls are refused and it stops itself; without a proof the generation is quarantined on record and the replacement is isolated; no volume is reused without a proof, because none is reused by a writer at all (D19): fake tier. Not claimed: stale-epoch denial of artifact finalization and result publication (W-020, W-023) and of tool operations (W-075); isolated restore (W-020); detachment on attachable storage (R).
- **AC-15.** The protocol, the reconciled side effects and the recorded cleanup: fake tier. **The child tree stops within the bound: k3s only.** The bound is the hold (at most 30 s, in practice one beat, none for an urgent stop) plus the 15 s grace. Not claimed: through the Activity (W-023); a real harness's tree (W-077).
- Built here, claimed elsewhere: scoped runner-API authorization and the harness's forged calls, for **AC-236** (W-134); TERM with 15 s grace under a real supervisor, for **AC-233** (W-134); the obligation refs **AC-43** and W-023's cleanup rule need (W-024, W-023); token placement for **AC-100** (W-075).
- Not built: checkpoints, `finalizing`, the checkpoint child and `→ completed` (W-020); result envelopes and their acceptance; log chunks and `watchEvents` (D26); factory tools and the authenticated local endpoint (W-075); a stored `StageInput` (W-023); production NetworkPolicy and admission manifests (W-021); deletion of any old or quarantined PVC, and the operator's early delete (W-024); writer reuse of a volume (D19); any real harness (W-077); anything on a real cluster (D4).
- Residual risks, for the READMEs:
  - A runner outage longer than the fence time stops every writer (race rule 4, D27).
  - **Behind NAT the per-source limits protect nothing**, and one source address is everyone. That is this machine's k3s tier, and it is not a deployment.
  - **The object store is now needed to finish any stop** (race rule 9).
  - **Every proof lists the whole namespace**, under the port's cap of 500 pods (`api.ts:60-62`). A namespace above that, or a pass deadline that cuts the paging, proves no stop, and every stop then ends in quarantine. The capacity defaults (20 allocations) are far below it; it is a cliff to know about before they are raised.
  - The gate fails closed on a wrong API-service entry only. Any other deny target that is mistyped fails to connect and so passes; and a gate shows that its listed rules are active, not that the policy is complete.
  - Node suspend stops the supervisor's clock; only the server's denial fences it then.
  - The node check excludes a deleted node. It does not cover an operator's out-of-service taint or a force delete, which stay with D4 and with W-021's admission rule.
  - A quarantined allocation's process is not stopped again by anything in W-019; the Job's deadline bounds it.
  - **Until W-024 ships, a quarantined volume can be removed early only by hand, with `kubectl delete`, and nothing audits that.** There is no real tenant in M2; an erasure request before W-024 would be met that way and recorded by the operator.
  - The new-connection and source limits protect the event loop from one source. They do nothing against many sources, and nothing behind NAT. Moving the listener to a worker thread, so that the reconciler's timing is not shared with it at all, is not built (P-29).
  - The start gate is enforced by the launcher, which is trusted because it comes from the harness image. A harness image that does not start through it is not gated; image admission is W-021's and W-090's.
  - `local-path` does not enforce a claim's size, so a harness can fill the node's disk. That predates W-019 (W-021, W-024).
  - The scripted harness shows nothing about Claude in a restricted pod (W-077).

### Hand-offs

- **W-020:**
  - **`finalizing` is yours** (D22): the supervisor's finalisation request, `running → finalizing`, the intent record, and the pass. The request is a route that changes state, so by rule 4 its locked statement carries `controller_lease_until > clock_timestamp()`; a finalize on an expired lease would be result acceptance on expired authority (`06:112`). The proof steps and the quarantine move are reusable as they stand; `register` must then also accept `finalizing`.
  - Require `volumeDisposition` to be `quiescent`, and **list the claim's consumers again when the child is admitted**: the proof is a past observation.
  - Decide what the stop acknowledgement means for a checkpoint at cancel (SI-29).
  - **Inferred, not tested:** under `fsGroup` the kubelet may rewrite group and mode on every file when a second pod mounts the claim; a trusted read-only mount should not change the tree it is about to hash (step 0 records what this cluster does).
  - Any read of a workspace a harness has run in uses descriptor-relative, no-follow traversal (the view's rule).
- **W-021:** the production policy, with an allow rule for the listener's **port**, not the runner's host (W-023's control-plane port lives there too); the real deny-target list; an admission rule against grace 0; `get nodes` and the one Service read are new rights. The local policy file is replaced. `capability-proxy.ts:59` still treats `starting` as live (section 5's hand-off stands).
- **W-023:** persist the stage input, bound as SI-21 decides (D26). After a harness exit the run reports `reconciling` until W-020. Carry the quarantine record's ref in `cleanupObligationRefs`. The worker-facing route is a second listener and its wire types go in `@factory/runner-protocol`. `watchEvents`. `cancel` has an `urgent` option.
- **W-024:** delete a replaced generation's claim only when `volumeDisposition` is `quiescent`; a `quarantined` one only after `preserveUntil`, or earlier through the audited operator action D25 defines, **which W-024 builds**, with its resolution record; `unknown` never. Stop the pod of a quarantined allocation. Route the open-quarantine count to its owner (INT-09).
- **W-030:** when the publisher gets a credential it must not sit under `scratchRoot`, and the publisher's scratch root and any materializer root must be disjoint; both use `<org>/<workspaceId>` (`publish.ts:113`, `materializer.ts:92`). Both READMEs say so from W-019 on. **W-030 owns the check and its test**, not only the sentence: the publisher refuses to start on a scratch root that equals, contains or lies inside a materializer root it is told about. **Control:** two disjoint roots start.
- **W-075:** the tool routes join the local endpoint with their own authentication; every one checks the fence flag first, goes through the listener's guard for anything remote, and reads the workspace only by the view's rule.
- **W-077:** replace the scripted program behind the same launcher; the harness's umask; whether a real harness's tree needs more than the pod delete. **It does not start on the k3s tier unless step 0 item 5 held** (D24).
- **W-119:** the urgent stop is the per-run half of an emergency stop.
- **W-134:** the guard's denials, the lease tests and the forged-call tests are the material for AC-236's runner-API half.

### To confirm in the k3s tier

The seven step 0 items, each confirmed or answered by its fallback, and five more that nothing
rests on: the source address the listener sees for pod traffic; whether a denied connect is refused
or times out on this CNI; the time between a container's exit and its status; whether the kubelet
rewrites modes on a second mount (measured in step 0, item 2: under fsGroup a second mount turned 0750 and 0700 directories into 2770 and a 0640 file into 660, so the 0700 control holds only on the first mount; W-020 must not rely on modes across mounts); the size and import time of the two new images inside the
1,800 MB node.

### Owner decisions, assumptions, spec issues and plan additions

All nine were **decided provisionally by the coordinator on 2026-11-18, after the two reviews; the
owner can override any of them.** D26 and D27 were decided as this brief's defaults. None blocks
the start.

| # | Decision | Status and answer |
| --- | --- | --- |
| D19 | What "volume reuse" means in M2 (C2). | **Decided (provisional): no writer reuse.** A replacement always gets a new claim. The proof decides only what may happen to the old one: a read-only checkpoint mount (W-020) or reclaim (W-024). Not taken: reusing the storage with a trusted wipe (2 to 3 days, and unclaimable before D4); reuse with contents (the spec has no flow that reads them). |
| D20 | W-019 is larger than its estimate: 10 to 12 days against 4–6. | **Decided (provisional): step 0, then 19a, then 19b**, each commit with an independent review; one build-log line after the second. |
| D21 | A package outside the spec's module list for the wire contract (C13, P-27). | **Decided (provisional): accept `packages/runner-protocol`.** |
| D22 | Whether W-019 enters `finalizing`. | **Decided (provisional): it does not.** A harness exit goes `running → stopping` (`harness_exited`) and ends `terminated`. W-020 adds `finalizing` where the checkpoint child uses it. |
| D23 | TLS on the listener, and the CA. A security call. | **Decided (provisional): accept, with the security review's changes.** TLS on every address; plaintext only behind a flag the test configuration alone can set; one pinned CA, no system roots; the CA's digest in the supervisor's arguments and an immutable ConfigMap; the supervisor refuses a runner URL that is not `https:` or is loopback; an ECDSA P-256 listener certificate. Certificate issue and rotation on a real cluster belong to INT-05 and INT-06. |
| D24 | The network gate before W-021 ships a policy (C8). | **Decided (provisional): `required` in production**, so a cluster without the policy starts no harness. **Every local k3s run applies the listener-only egress policy** and runs with the gate `required`. `disabled` remains only in the fake tier, which has no network to gate, and as step 0 item 5's fallback; in that fallback it must be gone before W-077. |
| D25 | How long a quarantined volume is kept, and who owns the obligation. A security call. | **Decided (provisional): 30 days, owner `platform-operator`**, the record `restricted`; an open-quarantine count on every pass for alerting; deletion before `preserveUntil` only by an audited operator action. The action is built in W-024 (A-34). |
| D26 | Who stores the `StageInput`, and who builds `watchEvents` and log chunks (C5, C6). | **Decided (provisional), the brief's default:** W-023 stores the input. Events and log chunks wait for a harness adapter and for storage the schema does not have: W-023 with W-077. W-019 builds neither. |
| D27 | A runner API outage longer than 50 s stops every running writer, and each loses its unacknowledged work. | **Decided (provisional), the brief's default:** accept; it is the spec's lease. On a real cluster run two runner replicas (rule 2 of section 5 already allows it). P-28 records a possible grace rule; it is not built. The rate limits of this brief are what keep a harness from causing the same thing. |

Assumptions W-019 writes to `docs/assumptions.md`:

- **A-32** (INT-05): in the k3s tier the listener runs in the test process on the Mac with TLS from a throwaway CA, and pods reach it at the podman host-gateway address `192.168.127.254` (`host.containers.internal`); gvproxy delivers that traffic to the Mac's loopback, so the listener binds `127.0.0.1`, sees every pod as source `127.0.0.1`, and its certificate names the gateway address (measured in step 0, item 1). That arrangement is for development only: every pod shares one source address there, so the per-source limits mean nothing, and a deployment must show the listener real pod addresses. The local tiers' configuration raises the per-source numbers for the same reason. The listener's certificate is ECDSA P-256, here and as the recommendation to INT-05. In the fake tier the listener is plaintext on loopback behind a test-only flag.
- **A-33** (W-077, INT-08; extends A-27): the harness container is the launcher plus a scripted program. No Claude, no gateway, no model call.
- **A-34** (INT-07 retention obligations; `06-runner-workspaces.md:104`): a quarantined volume is preserved for 30 days under the obligation owner `platform-operator`, as restricted evidence, and is escalated after one day.
- **A-35** (INT-05, W-021): the local tier's egress policy allows only the listener's address and port, and the gate's deny targets there are the API service, the metadata address and the Mac's Postgres and Temporal ports. A target counts as denied when a connect is refused or times out.

Spec issues W-019 records in `docs/spec-issues.md`:

| ID | Location | Problem | Proposed choice |
| --- | --- | --- | --- |
| SI-27 | `06-runner-workspaces.md:17`, `:108`, `:116`; `examples/kubernetes-job.json` | The winning supervisor "may launch the harness", but the two are separate containers with no shared process namespace, and nothing says how the start is withheld or how the supervisor stops anything. | A launcher in the harness image waits for a start signal on the supervisor's loopback endpoint. Stopping is the pod delete; a cooperative stop is best effort. |
| SI-28 | `06-runner-workspaces.md:25` against `:76`, `:82` | A writable volume may be reused once termination and detachment are confirmed, but recovery replays from the last acknowledged boundary into a new empty allocation, so no flow uses a reused volume's contents. | No writer reuse in M2 (D19). The proof gates the checkpoint mount and reclaim only. |
| SI-29 | `06-runner-workspaces.md:90`, `:112`; `contracts/interfaces.ts:84` | Cancel allows 30 s for "a safe checkpoint request", with no statement of who waits, how the supervisor learns of the cancel, or what is recorded; and `cancel` has no way to say that a stop must not wait. | The runner holds the delete for up to 30 s while a recently live writer has not acknowledged. The acknowledgement is a record. An optional `urgent` argument skips the hold. A checkpoint at cancel is W-020's to define. |
| SI-30 | `06-runner-workspaces.md:25`, `:112`; `11-platform-operations.md:27` | "Storage detachment/revocation" must be confirmed, with no definition of the observation for storage that has no attachment object, and nothing about pods removed with their node. | No unfinished pod names the claim (an unfiltered list), and the writer's node still exists. `VolumeAttachment` waits for D4. |
| SI-31 | `06-runner-workspaces.md:23` | Heartbeat, suspect and expiry are given; what the supervisor does when it cannot renew, and on whose clock, is not. | The Postgres clock decides, in the statement of every route that grants. The supervisor stops itself at lease minus one beat on its own monotonic clock, measured from the send. |
| SI-32 | `contracts/interfaces.ts:83`; `06-runner-workspaces.md:88`; `schema.sql` | `watchEvents` and sequenced log chunks are required, and no table stores a harness event or a log chunk. | Not built in W-019 (D26). |
| SI-33 | `06-runner-workspaces.md:25`, `:102`, `:104`; `domain.schema.json` `cleanupObligationRefs` | A quiescence proof, a quarantine record and an operator obligation are required or referenced, and none has a schema or a table. | Two local artifact schemas, `factory-quiescence-proof/1` and `factory-quarantine-record/1`, linked by purpose. |

Plan additions for `docs/plan-additions.md`:

- **P-27**: `packages/runner-protocol`, the wire contract between the runner and its callers, outside the module list of `01-scope-architecture.md:84-99`. Built in W-019; W-023 adds the worker-facing half.
- **P-28**: a grace rule for leases after a runner API outage, so that a restart of the only runner does not stop every stage. Open; needs a design that survives two controllers.
- **P-29**: run the pod-facing listener in a worker thread, so that TLS work and the reconciler do not share an event loop. Open; the admission limits are what W-019 builds.

### Definition of done

- **Step 0:** the seven items run, each confirmed or answered by its fallback, with the script and output kept as W-017's were. If item 5 fails, the owner is told before 19b starts.
- **19a:** the thirteen new 19a files and conformance rows 16 to 18 and 21 pass on the fake; W-017's nineteen files pass with the 19a edits of the table under "Files" and no other; W-018's eleven pass unchanged; `pnpm check` is green. Independent review.
- **19b:** the nine new unit files, the two extended W-017 files and the five cross-app files pass, and `pnpm check` is green. `pnpm test:k8s` passes once on this machine on AC power, under the local egress policy: W-017's files, conformance rows 16 to 21 and the three new files. Independent review.
- AC-10, AC-12 and AC-15 are logged with the exact halves above and the tier of each, naming W-020, W-023, W-075 and W-134 for the rest. The k3s run's date and image digest are in the same line, **and so is the result of step 0 item 5**.
- No file under `apps/worker` changes; no migration; no dependency. The diff in `packages/workspace` is the three record files, the internal mode argument and its pod export, the index exports and the README.
- `docs/assumptions.md` has A-32 to A-35; `docs/spec-issues.md` has SI-27 to SI-33; `docs/plan-additions.md` has P-27, P-28 and P-29.
- The READMEs state the seven rules, the admission order and its four limits, the route table with its lease clauses, the supervisor's states and exit codes, the record table, the proof's conditions, the disposition table, the hold, the view's before-start rule, the deployment invariants, the residual risks and what is not built. `packages/workspace/README.md` drops "volume reuse on proof of quiescence" from "Not built", states D19, and states that the publisher's and the materializer's roots must be disjoint.
- Nothing is left behind by either tier: each test file checks its process groups, its listener port and its namespace at teardown, and no key of the throwaway CA is left on disk.

### Confidence

- **Verified by reading today:** every file and line cited; that `materializer.ts:156` is a fourth 0700 level; that no code sets a umask; that the renewal and the `running` pass do not read the workspace; that the acquire retry on a `running` row has no lease condition; that the review budget is one bucket per permit service; that `move` checks state and `pod_uid` and no link; that `artifact_link` has no unique key and that `registerControllerArtifact` takes the caller's transaction; that every edge used here is already in `states.ts`; that `audit_event` and `artifact_link` can hold the six records under the runtime grants; that `restricted` is an artifact classification; that `cleanupObligationRefs` are `ArtifactRef`s; that no table stores harness events; that W-017's harness already passes `artifacts` and that its only stop-reason assertion is `every_pod_bad`; the backlog entry and the three acceptance criteria.
- **Taken from the reviews and checked:** both blockers on the lease and the quarantine path reproduce from the code as cited; the flood follows from `config.ts:30-33` and `permit.ts:98`.
- **Inferred, not run:** all seven step 0 items. The one I trust least is item 1 (a pod reaching the Mac through two layers of NAT); the ones with the widest effect if wrong are item 4 (container status, which the harness-exit stop and the supervisor-exit stop both read) and item 5 (which decides whether this tier is fit for W-077).
- **Inferred from Kubernetes documentation:** supplementary groups under `fsGroup`; the kubelet's ownership pass on a later mount; that a pod under graceful deletion on an unreachable node stays listed; that a projected ConfigMap source may be immutable.
- **Judgement:** the 10-to-12-day estimate; the 30-day window; the rates (5 new connections a second and 4 open per source, 10 a second per source for requests that did not verify, one every 2 s per pod, a review ceiling of 200 a second). They are sized against one renewal every 10 s, the handshake costs behind them are the security review's estimates and were not measured, and all of them go to P-14's load test before they are trusted.
- **Where I would point the next review:** the admission order (whether anything a harness can cause still reaches a shared budget), and the interleavings of race rules 5 and 6.

## 7. Risks

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
| SI-26 | `StageInput.workspaceId`; `06-runner-workspaces.md:5`; `contracts/interfaces.ts:88-91` | A stage input names a workspace, but no chapter says who allocates the row or where its repository, base commit, branch and setup profile come from. W-018's `allocateOrAttach` accepts only the runner identity. The full `StageInput` is also stored nowhere, though a supervisor will need it. | The runner exposes `allocateOrAttach` and `release` to control-plane callers and calls the manager with its own identity. W-023's Activity allocates the workspace before it starts the run. Persisting the stage input is W-023's (D26). |
| SI-27 | `06-runner-workspaces.md:17`, `:108`, `:116`; `examples/kubernetes-job.json` | The winning supervisor "may launch the harness", but the two are separate containers with no shared process namespace, and nothing says how the start is withheld or how the supervisor stops anything. | A launcher in the harness image waits for a start signal on the supervisor's loopback endpoint. Stopping is the pod delete; a cooperative stop is best effort. |
| SI-28 | `06-runner-workspaces.md:25` against `:76`, `:82` | A writable volume may be reused once termination and detachment are confirmed, but recovery replays from the last acknowledged boundary into a new empty allocation, so no flow uses a reused volume's contents. | No writer reuse in M2 (D19). The proof gates the checkpoint mount and reclaim only. |
| SI-29 | `06-runner-workspaces.md:90`, `:112`; `contracts/interfaces.ts:84` | Cancel allows 30 s for "a safe checkpoint request", with no statement of who waits, how the supervisor learns of the cancel, or what is recorded; and `cancel` has no way to say that a stop must not wait. | The runner holds the delete for up to 30 s while a recently live writer has not acknowledged. The acknowledgement is a record. An optional `urgent` argument skips the hold. A checkpoint at cancel is W-020's to define. |
| SI-30 | `06-runner-workspaces.md:25`, `:112`; `11-platform-operations.md:27` | "Storage detachment/revocation" must be confirmed, with no definition of the observation for storage that has no attachment object, and nothing about pods removed with their node. | No unfinished pod names the claim (an unfiltered list), and the writer's node still exists. `VolumeAttachment` waits for D4. |
| SI-31 | `06-runner-workspaces.md:23` | Heartbeat, suspect and expiry are given; what the supervisor does when it cannot renew, and on whose clock, is not. | The Postgres clock decides, in the statement of every route that grants. The supervisor stops itself at lease minus one beat on its own monotonic clock, measured from the send. |
| SI-32 | `contracts/interfaces.ts:83`; `06-runner-workspaces.md:88`; `schema.sql` | `watchEvents` and sequenced log chunks are required, and no table stores a harness event or a log chunk. | Not built in W-019 (D26). |
| SI-33 | `06-runner-workspaces.md:25`, `:102`, `:104`; `domain.schema.json` `cleanupObligationRefs` | A quiescence proof, a quarantine record and an operator obligation are required or referenced, and none has a schema or a table. | Two local artifact schemas, `factory-quiescence-proof/1` and `factory-quarantine-record/1`, linked by purpose. |

## 8. Response to the adversarial review

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
Round 5 (the W-019 brief, section 6). Three rounds of an adversarial review and a security review. Round 3 of both gave GO. The tables below are the responses, in the order they were applied.

**After the first review (adversarial: no-go, blockers B1 to B3; security: H1, H2, M1 to M5, L1 to L4).**

Two reviews of the first draft: the adversarial review (no-go; blockers B1 to B3, should-fix S1 to
S10, small items) and the security review (H1, H2, M1 to M5, L1 to L4). Every item was checked
against the code before it was taken. "Where" names the part of the brief in section 6.

| Finding | Disposition | Where |
| --- | --- | --- |
| B1 and H1: the exit hint drains the shared review budget | Taken, both halves: the supervisor coalesces hints, and the runner has a per-pod bucket after local verification and before the shared budget. | "The listener", admission order; "The supervisor", hints; `w019-pod-rate`, `w019-heartbeat`, `w019-hint-flood` |
| H2: pre-auth caps are shared | Taken: the source bucket is charged only by requests that fail; per-source connection cap; handshake timeout; real pod addresses are a deployment requirement. | "The listener"; A-32; residual risks |
| B2: the guard never checks the lease | Taken as one clause for every route that grants or changes state. The acquire retry goes through the renewal statement, and the first commit checks the start deadline. `finalize` no longer exists in W-019 (D22); its lease clause goes to W-020 in the hand-off. | Rule 4; "The pod call guard"; `w019-pod-guard` |
| B3: the one-way door is open on the quarantine path | Taken: the quarantine move reads the proof link under the row lock and refuses. Forced-interleaving test. | "Order, and the one-way door"; race rule 6; `w019-quarantine-record` |
| S1: a claimed writer with no start record | Taken, with the argument. W-017's test is the control. | "The proof", node condition |
| S2: the proof writer must use the caller's transaction | Taken: `prepare` outside, `register` on the caller's transaction; two links are a hard error; the refusal is audited before any lock. | "Records" |
| S3: fake-kubelet volume keying | Taken: by claim name; `emptyDir` per pod; a control test. | "Fake kubelet"; `w019-fake-kubelet` |
| S4: `ac-12` does not pin which fence fires | Taken: the server half and the supervisor half are asserted separately. | `ac-12-stale-live-writer` |
| S5 and M4: the gate fails open on a wrong target, and proves one rule | Taken as far as it can be: a list of literal addresses, all must fail and the listener must answer; the runner verifies the API-service entry against the cluster at start. A wrong extra target still passes vacuously, and the residual says so. | "The supervisor", gating; "Start-up checks"; residual risks |
| S6: the object store is on the path of every terminal transition | Taken: stated, and tested. | Residual risks; `w019-quiescence-proof` |
| S7: `finalizing` has no consumer here | Taken (D22, decided). A harness exit goes `running → stopping`. | "Container exits"; D22; hand-off to W-020 |
| S8: ordering in the pass and the guard | Taken: the workspace clause per route, the order of renewal denials, and the hold after the proof check and only before any delete (that last condition was replaced by the cancel-stop record in round 2). | "The pod call guard"; "The hold" |
| S9: a supervisor that exits leaves the harness running for a minute | Taken: the `running` pass stops at once on either container's exit. | "Container exits" |
| S10: the proof is a past observation | Taken in the hand-off: W-020 lists the claim's consumers again at admission. | Hand-offs |
| Small (adversarial): observation time; config validation; answer before the pass; step 0 item 4's fallback; the full list of W-017 edits and an optional listener; the 500-pod cliff; the node permission at start; `spawn-tree` strays; who stops a quarantined pod; two vacuous asserts | All taken. The "idempotent repeat of `finalize`" item falls away with D22; the same point is stated for `stop_ack`. | Throughout; "Files"; residual risks |
| M1: denials after a good review are audited without a cap | Taken: a bucket keyed by the reviewed pod UID. | "The pod call guard" |
| M2: plaintext by bind address; a loopback runner URL | Taken, all four parts. | "The listener"; "The supervisor"; "Images" |
| M3: pods may reach the Mac's Postgres | Taken: step 0 probes it, every k3s run applies the listener-only egress policy, and the local `disabled` is gone from the k3s tier (D24). | Step 0 item 1; "k3s tier"; D24 |
| M5: the view is safe only before start | Taken: a runtime assertion, and the rule for later reads. | "The workspace view" |
| L1: the CA's integrity | Taken: digest in the arguments, immutable ConfigMap, RBAC row, key handling, wrong-SAN test. | "Manifest"; "Images and script"; conformance row 20 |
| L2: `dirMode` is a general option; the publisher reason was overstated | Taken in part. The reason in C1 is corrected, and 0750 is reachable only through the pod export. **Not taken in code:** a runtime check that the publisher's scratch root and a materializer root are disjoint. W-019 constructs no publisher, and in pod mode the two never share a process; it is written into both READMEs and handed to W-030 with the credential rule. | C1; "Modes"; hand-offs |
| L3: the hold applies to emergency stops | Taken: an urgent stop record that skips the hold. | "The hold" |
| L4: hygiene | All five taken. | "The listener"; "Records"; "The quarantine record" |
| D25 additions (alerting, audited early delete) | Decided. The record carries what both need and the runner reports open quarantines on every pass. **The early delete itself is built in W-024**, with the only code that deletes a PVC; W-019 deletes none. | "The quarantine record"; D25; hand-offs |

**After the second review.**

Round 2 closed every round-1 item and accepted the five deviations. Both reviewers found one new
blocker, in the listener's admission; the security review added two findings for the same edit.

| Finding | Disposition | Where |
| --- | --- | --- |
| Adversarial R2-1 and security R2-1: handshake churn; nothing limits new connections | Taken: a per-source new-connection bucket on the plain socket, before the handshake; an ECDSA P-256 listener certificate; the gate waits on a plain connect and makes one handshake; a churn-flood test with a second source still renewing. **One change to the control:** it asserts how many handshakes the server began, not a delay. A delay on this machine depends on what else is running, and a control that sometimes passes for the wrong reason is worse than none. | "The listener", admission steps 1 and 2; "The supervisor", gating; `w019-listener-churn` |
| Security R2-3: some requests are neither charged nor verified | Taken: the rule is inverted. Every request is charged to its source unless its token verified locally, which covers the failed-token fast path, an unknown key id and wrong routes. The failed-token memory becomes an LRU with no scan. | Admission step 3; `w019-listener` |
| Security R2-2: 32 connections per source | Taken: 4, and a configuration check against the global 512. | Admission step 2; "Config added" |
| Adversarial should-fix 1: the hold catches a cancel that lands after a container-exit stop | Taken, **with a different mechanism from the one proposed.** Comparing the cancel record's `created_at` with the row's `updated_at` is wrong when the cancel waits on the row lock behind the pass that writes the stop: its record is then older than a transition it did not cause. The hold instead requires a cancel-stop record, which `cancel` writes only in the transaction where it makes the transition itself. The "nothing deleted yet" condition and its two cluster reads are dropped; the record covers what they were for. | "The hold"; "Records"; race rule 12; `w019-cancel-window` |
| Adversarial should-fix 2: the concurrent claimant under the lock (`permit.ts:188`) | Taken both ways: that branch goes through the renewal statement, and race rule 5 says why the old behaviour would have been safe. | Route table; race rule 5; `w019-pod-guard` |
| Adversarial should-fix 3: the step 0 item 4 fallback route | Taken: it carries the lease clause. | Step 0, item 4 |
| Adversarial should-fix 4: the mode leaks through `export *` | Taken: no exported signature carries a mode; a token minted in a module the index does not re-export. The structural test reads the index's own export list. | "Modes"; `w019-modes` |
| Adversarial should-fix 5 and security R2-4: the review budget's size | Taken: sized each pass from live writers across organizations, with a floor, a ceiling and a configuration check that the per-pod rate fits. The numbers go to P-14. | "The listener"; "Config added"; `w019-listener-churn` |
| Deviation (d): disjoint roots need an owner with a test | Taken: the W-030 hand-off owns the check and its test. | Hand-offs |
| Security: D25 wording; the manual delete; item 5 in the build log | Taken, all three. | Hand-off to W-024; residual risks; step 0 item 5; definition of done |
| Security, optional: a start-up probe of each deny target | Taken as a warning only. | "Start-up checks" |
| Security, optional: the listener in a worker thread | Not taken in W-019. The bucket is the necessary part; the thread is recorded as P-29. | Residual risks; plan additions |

**After the third review (applied by Tony).**

Both reviewers gave GO. Applied from round 3: the `w019-cancel-window` row now treats a pod already Terminating from outside the runner as a hold of at most 30 s with `stop-ack` refused (adversarial review); the review burst is twice the refill; `createConfig` refuses the test-only keys; `sourceOf` lives only in the test configuration; and the `w019-testing-boundary` structural test (security review).

## Confidence

- **Verified by running or reading today:** the package list, order, dependencies and acceptance IDs; every row of the section 2 table; the hard-link and relative-worktree behaviour of Git 2.50.1; the code and schema facts cited in sections 4 and 5.
- **Inferred, not tested:** that kind and k3d offer nothing extra here; the size column; the reader's 3–5 days; that durable capability counters fit without a new table (a W-021 design question); the SI-13 and SI-14 choices.
- **Measured on one cluster only:** the network-policy start-up window. It says nothing yet about any other CNI.
- **Section 5 (W-017), verified by reading today:** the `execution_allocation` columns, indexes and grants and the conclusion that no migration is needed; W-018's interfaces as committed; the boundary rule that apps are not importable; the worker's stage-run insert, input hash and budget key; the spec lines cited.
- **Section 5, run on k3s in the third session:** the termination-message receipt and the pod-bound token review, which the design rests on. One assumption of mine was wrong and is corrected: a review does not fail the moment its pod is deleted.
- **Section 5, inferred and not run:** the nine items listed as "to confirm in the k3s tier". The 8-to-10-day estimate is a judgement. That `settleWorkspace` covers every interleaving of a permit and a stop is argued in the brief and tested at two fault points; it is the part I would ask the next review to attack first.
