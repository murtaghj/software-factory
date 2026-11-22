# M2 plan: isolated execution

Revision 8, 2026-11-22. Written against spec rev 1.13. Planning only; no source changed.
Revision 2 answered the adversarial review of revision 1; revision 3 reworks the W-018 brief after its own second review. Section 10 lists what changed and what was not taken as written.
Revision 4 adds the W-017 brief as section 5, with decisions D12 to D16 and spec issues SI-19 to SI-25. The old sections 5 and 6 are now 6 and 7.
Revision 5 reworks the W-017 brief after its first review (no-go: four blockers, thirteen should-fix items, all taken), records the owner's decision D17, adds D18 and SI-26, and adds the results of a third k3s session that probed the two behaviours the brief rests on. A second review passed it for 17a subject to edits N1 to N7 and five small ones, which are made in section 5 (section 10, round 4).
Revision 6 adds the W-019 brief as section 6, with decisions D19 to D27 and spec issues SI-27 to SI-33, revised twice after two rounds of an adversarial review and a security review.
Revision 7 adds the W-020 brief as section 7, with decisions D28 to D37, open question O1, assumptions A-36 to A-39, spec issues SI-34 to SI-42 and plan additions P-30 to P-32, revised once after a design and a security review. The old sections 7 and 8 are now 8 and 9.
Revision 8 adds the W-021 brief as section 8, with decisions D38 to D50, assumptions A-40 to A-46, spec issues SI-43 to SI-48 and plan additions P-33 to P-38, revised after a design review and a security review. The old sections 8 and 9 are now 9 and 10. On 2026-11-22 the owner accepted every recommended default of D28 to D50; O1 and the follow-up to D48 stay open, for silvio.

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
| 4 | **W-020** Durable checkpoints and restore | In `packages/workspace`: committed and dirty-state manifests, self-contained bundles, finalization, restore into a clean allocation; `checkpoint_job` child rows and their fencing (SI-12); `finalizing` and its pass (D22). **Starts with the untrusted-Git reader** (below). Brief in section 7. | W-007 ✓, W-018, W-019 | AC-14: F. AC-13, AC-16: restore mechanics only (material), the claim waiting for O1 and D36 | 18 to 21 against 4–6 (reader included), three commits (D35) · L |
| 5 | **W-023** Runner Activity attachment and cancellation | In `apps/worker`: `startOrAttachExecution`, `awaitExecution`, `cancelExecution` Activities; typed infrastructure versus semantic outcomes; cleanup on every non-semantic path; the new cleanup rule for `outcome_recorded`. Behind `patched('runner-v1')`. Design constraints in section 9. | W-019, W-020, W-011 ✓ | AC-10, AC-14, AC-15: F with Temporal | 3–5 · L |
| 6 | **W-024** Workspace and resource sweeper | UID-scoped cleanup, retention, orphan reconcile, failed cleanup left visible as an operator obligation. Moved ahead of the checkpoint: it is the only cleanup that survives a failed or terminated workflow. Never force-deletes. | W-019, W-020 | AC-43: F and K | 3–4 · S |
| 7 | **W-021** Capability proxy and execution profiles | Extend the W-008 proxy into the runner: scoped grants, per-role identities, denied-operation audit, **durable call counters** (today they are an in-memory map, `apps/api/src/auth/capability-proxy.ts:47`, so a restart resets every limit); namespace, NetworkPolicy and admission manifests. Brief in section 8. | W-008 ✓, W-019 | AC-19: F. AC-56: K gives partial evidence, **R to claim** | 10 to 12 against 4–6, step 0 then two commits (D38) · L |
| 8 | **W-022** Canonical verifier supervisor | New `apps/verifier`: exact source and package execution, externally collected results, counts and integrity checks, trusted finalization. Uses the W-004 fixture releases. | W-012 ✓, W-018, W-021; W-097 by assumption | AC-21, AC-22, AC-23, AC-24: F | 4–6 · M |
| | **Exit-evidence checkpoint** | Independent review, full check, and the three exit scenarios run end to end and **end cleanly** (no live allocation, outcome recorded): lost pod (AC-10, AC-13, AC-14), stale writer (AC-12), canonical-test integrity (AC-22, AC-23). Not the M2 exit. The lost-pod scenario is not reachable until O1 is decided (section 7.9). | | | |
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
- W-021's admission rules on the real API server's version and identities, and its NetworkPolicy on the real CNI (D4).

## 3. Owner decisions

The crew proceeds on the default unless told otherwise. None of these blocks W-018. D12 to D18
belong to the W-017 brief (section 5). D17 is decided; none of the others blocks its start. D19 to D27 belong to the W-019 brief (section 6) and are decided provisionally. D28 to D37 belong to the W-020 brief (section 7); none blocks 20a's start; D28, D33 and D34 are security calls. D38 to D50 belong to the W-021 brief (section 8); none blocks 21a's start; D44, D46 and D50 are security calls, and D48 changes D13. On 2026-11-22 the owner accepted the recommended default of every decision from D28 to D50, the security calls and D30 (always `inconclusive` until W-075) among them. Open questions are a new series, O1 onward: they are not decisions with a default. O1 and the follow-up to D48 (the pod artifact-read design, before W-022's brief) are open and assigned to silvio.

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
| D13 | Bundle sources (verifier copies, restores) for the pod materializer. | Not in W-017: `remote` sources only. A bundle needs a scoped artifact read from inside a pod. That read moves from W-021 to W-022, its first user (D48, accepted by the owner, 2026-11-22; the design goes to silvio before W-022's brief). W-020's restore tests use the local materializer. |
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
| D28 | The reader's scope and limits (7.3). (W-020, section 7) | **Accepted by the owner, 2026-11-22.** SHA-1 repositories only; loose objects, pack v2/v3 with idx v2, offset and reference deltas to depth 512; loose and packed refs, no reftable; index v2 to v4 with no split or sparse index and no unmerged entries; the limit table of 7.3; Git's own path rules plus a refusal of backslashes. Everything outside is a typed refusal, never a fallback to Git. Not taken: depth 4,095 (Git's maximum; the work budget would bound it, but nothing needs it); accepting backslashes (legal on Linux, unrepresentable on hosts the factory may restore to). |
| D29 | What a cancel does to a checkpoint (C13, SI-29). (W-020, section 7) | **Accepted by the owner, 2026-11-22.** A cancel never starts one. A cancel that finds the allocation `finalizing` lets the checkpoint finish and be stored, and the stage ends `cancelled` with no result. An urgent cancel gives the checkpoint up at once. The hold of section 6 stays a courtesy for `running` stops. |
| D30 | Who mints the `StageResult`, and with what status (C6). **Set by the coordinator on 2026-11-21 after the security review (Furio M4); accepted by the owner, 2026-11-22.** (W-020, section 7) | W-020 builds `StageFinalizer.finalize` for the child's identity only. **The runner mints `inconclusive` with the checkpoint and no outputs. The harness exit code is a diagnostic only**, kept in the intent record and the handoff, until W-075's `submit_result` gives a source for a semantic status. Not taken: `completed` on exit code 0 (the brief's earlier default), which would let a hostile harness's own exit make a runner-authored `completed` (`06:7`, AC-231). SI-38. |
| D31 | Retries of the checkpoint child (C7). (W-020, section 7) | **Accepted by the owner, 2026-11-22.** One receipt per attempt, at most two attempts, each admitted only after the previous one's pods are shown gone. |
| D32 | How a child streams large parts (C8). (W-020, section 7) | **Accepted by the owner, 2026-11-22.** A second TLS listener on its own port with its own limits and the same admission order; parts streamed into the artifact service; the pod listener unchanged. Not taken: special-casing streamed routes on the pod listener (its limits are server-wide). |
| D33 | The child's topology. A security call. (W-020, section 7) | **Accepted by the owner, 2026-11-22.** Two containers and two exchange volumes (7.4's shape table): `read` mounts the claim read-only, holds no credential and writes only `export`; `build` holds the token, never mounts the claim, mounts `export` read-only, keeps its repository in `work`, which only it mounts, and loads objects from `export` only as data through `index-pack --strict`. Not taken: one container (a reader bug would run beside the token); one shared scratch volume (the brief's earlier form: the process D33 distrusts would write the credential holder's working directory; review, Furio M5, Livia 9). |
| D34 | What is captured (SI-37). (W-020, section 7) | **Accepted by the owner, 2026-11-22.** Every tracked path; untracked files except the root and nested `.git`, special files, five rebuildable directory names and the deny list of 7.4 (case-folded, an interim under A-38); repository ignore files not honoured; over a cap, refuse. Not taken: honouring `.gitignore` (a second parser over candidate data, and ignored files are where a harness may leave work). |
| D35 | W-020 is larger than its estimate: 18 to 21 days against 4–6 (3–5 more for the reader); 7.11 shows the arithmetic. (W-020, section 7) | **Accepted by the owner, 2026-11-22.** Three commits, 20a, 20b and 20c, each with its own review; one build-log line after 20c. 20a lands as a library with no caller. |
| D36 | Restore into a pod (C10, D13). (W-020, section 7) | **Accepted by the owner, 2026-11-22.** Not in W-020: a typed refusal until a pod can read an artifact (D13; W-021's D48, accepted by the owner on 2026-11-22, gives it to W-022, and its design goes to silvio first). AC-13 and AC-16 are logged as restore mechanics only, through `LocalMaterializer`. **Consequence:** the exit-evidence lost-pod scenario needs that read, and O1, before it can run end to end. |
| D37 | How a stage reaches `finalizing` in M2. (W-020, section 7) | **Accepted by the owner, 2026-11-22.** The supervisor asks when the cluster reports the harness exited; the runner offers finalize in the grant only to an allocation with a workspace and a wait above 0, and waits up to 20 s for that request before stopping as W-019 does. Not taken: the runner alone moving `running → finalizing` on a harness exit (no route, no wait; but `06:112` has the supervisor record the request first, and W-019 handed over a route). |
| D38 | W-021 is larger than its estimate: 10 to 12 days against 4–6, after the two reviews. (W-021, section 8) | **Accepted by the owner, 2026-11-22.** Step 0, then 21a, then 21b, each commit with an independent review; one build-log line after 21b. 21b's review includes a security reviewer. |
| D39 | Where grants come from (C5, SI-43). `07:38` puts grants in the run input; `StageInput` carries them, unhashed and unstored. (W-021, section 8) | **Accepted by the owner, 2026-11-22.** The runner derives them from rows, with deterministic ids (rule 11). A `StageInput` that lists anything outside the derived set is refused; one that lists less narrows nothing. Not taken: honouring the input's grants (the runner would trust its caller's authority), or requiring an exact match (W-023 would have to rebuild the runner's derivation). |
| D40 | Where durable counters live (C4). (W-021, section 8) | **Accepted by the owner, 2026-11-22.** **No migration.** One `audit_event` row per allowed call, at a deterministic id, written by the statement that decides it, under a per-grant advisory lock, found by primary-key probes. The runtime role can only insert there, so a spent call cannot be given back. Not taken: a `capability_slot` table with `UNIQUE (org_id, grant_id, n)` (a migration, a grant change and a retention rule, for the same guarantee), or a counter column on the allocation (one counter per allocation, not per grant). |
| D41 | What happens to W-008's proxy in `apps/api`. (W-021, section 8) | **Accepted by the owner, 2026-11-22.** Delete it, with its test, and move the role table to `@factory/domain`; AC-19's cases move to the runner. It has no caller (searched today) and keeps the very counters this package exists to replace; two proxies would be two answers. |
| D42 | Granularity of "per-role identities" (SI-45). (W-021, section 8) | **Accepted by the owner, 2026-11-22.** One service account per **profile**, four profiles (`authoring`, `read_only`, `verifier`, and `checkpoint` for W-020's child), with **one configuration home, `profiles.<name>`** (X2, decided 2026-11-21); the role table maps each of the nine roles to one of the first three. The authoring account keeps its name. Each listener accepts only its own subjects: the pod listener never the checkpoint account. Not taken: nine accounts, one per stage role (the audience already binds a token to one allocation, so nine accounts add names, not authority); one account for everything (the status quo, which the backlog item exists to end). |
| D43 | What a capability check costs, and how it is limited (C13, X4). (W-021, section 8) | **Accepted by the owner, 2026-11-22.** Every check is reviewed and reads the pod, as the permit calls do; its own per-pod bucket (burst 20, one every 400 ms); the shared review budget counts the renewal, capability and checkpoint listeners' buckets together; no review cache. P-33 records that W-075 must measure. Not taken: caching a successful review for a few seconds (cheaper, but section 2 measured that the API server already keeps a review alive after its pod is gone, and a second cache would widen that window); a separate budget for the checkpoint listener (two budgets would let their sum pass the ceiling that protects the API server). |
| D44 | **Security call.** The admission rule set, its exemptions and its failure mode. (W-021, section 8) | **Accepted by the owner, 2026-11-22.** The rules of 21b, four policies, `failurePolicy: Fail`, bound to the exec namespace only. Exemptions: the kubelet's group and the pod garbage collector for the grace rule (deletes and evictions), and the Job controller's identity for pod creation only. No exemption for cluster administrators. Evictions are held to the same grace rule (C15). Not taken: refusing the pod garbage collector (its pods would stay for ever, with no one able to remove them). |
| D45 | Where the k3s tier shows Kubernetes doing what the exec namespace now refuses (C8, C18). (W-021, section 8) | **Accepted by the owner, 2026-11-22.** A local-only control namespace, `factory-exec-control`, with its own copy of the runner's Role, no policy and no admission, used only by the test driver: conformance rows 1 to 21 and the positive controls. `createConfig` refuses it. Not taken: binding admission with an exception for the admin (then the admin could do in the exec namespace what a test needs, and so could anyone with that certificate); making rows 1 to 21 conform to admission (they show Kubernetes behaviour, several by breaking the rules on purpose). |
| D46 | **Security call.** How "refuse the scripted label outside the local tier" is enforced (C2). (W-021, section 8) | **Accepted by the owner, 2026-11-22.** By the tier's image allowlist, **per container name**: a `cluster` rendering admits under each container name only its one configured digest, a CEL rule refuses anything not matching `^[^@]+@sha256:[0-9a-f]{64}$`, and an image cannot be changed on a live pod. The label stays as documentation. Not taken: a mutating or validating webhook that pulls image configuration (a new server, registry credentials in the admission path, and a new dependency). |
| D47 | How the profiles are packaged, and how the runner knows they are installed. D8 chose plain manifests and typed code for the Job. (W-021, section 8) | **Accepted by the owner, 2026-11-22.** The profile objects are rendered by typed code from `RunnerConfig`, as the Job is, with a committed fixture, and applied through a print entry; the namespace, the accounts that never vary and RBAC stay plain YAML. The runner checks at start and every 5 minutes that the policies, the three network policies, the LimitRange, the namespace's Pod Security labels and the params equal what it renders. **Only a 404 or a difference stops anything**, and only for a network policy; any other error warns and retries (design finding 5). Not taken: plain YAML for everything (the namespace, account names, label prefix, listener ports, images and sizes would be written twice, with nothing to catch drift). |
| D48 | **Changes D13.** Who builds the scoped artifact read from inside a pod (C9). (W-021, section 8) | Not W-021. W-022 is its first user and should own it; the design (how a pod gets a bundle when only the supervisor holds an identity, `06:110`) needs its own brief. **Accepted by the owner, 2026-11-22.** **Follow-up, open:** the design goes to silvio before W-022's brief. Until then W-020's restores run through `LocalMaterializer`, as its draft already says. |
| D49 | Order. W-019's k3s tier has not run (C10), and W-020 and W-021 share files (overlap table). (W-021, section 8) | **Accepted by the owner, 2026-11-22.** W-019's k3s tier passes once, unchanged, before W-021's step 0. Then plan order: W-020, then W-021 on top of it, with 21b filling in the `checkpoint` profile. If the owner wants them in parallel, only 21a's new files are built ahead. |
| D50 | **Security call.** Which of `09:77`'s explicit routes the M2 profiles allow (SI-44). (W-021, section 8) | **Accepted by the owner, 2026-11-22.** Two, each to one port of the runner only: allocation pods may reach the pod listener's port, and the checkpoint child the checkpoint listener's port (`factory-exec-egress-checkpoint`, X3); neither reaches the other's. Nothing in M2 resolves a name (every target is a literal address, `config.ts:184-191`) or needs a mirror or the model gateway (A-27, A-33). Each later route (DNS, mirrors, the gateway) is a profile field with its own allow rule and its own test, added by the package that needs it. |

**Open question O1 (W-020, section 7), open and assigned to silvio.** How does a later stage run start from an earlier
stage run's accepted checkpoint? A workspace row is bound to one stage run by W-018's identity rule
(`manager.ts:228`, `start.ts:87`), while `06:39` speaks of one clone per task and repository and
`06:76` of replaying from the last acknowledged boundary; the reference `restore` takes a checkpoint
and no target. The candidates are (a) a new row seeded with a source `checkpoint_ref`, which needs a
field the row does not have, or (b) one row per task and repository across stage runs, which
reverses W-018's identity rule and touches W-017's allocate step. Either changes W-018 and W-023
together and is expensive to undo, so it is not decided here. W-020's mechanics serve both.
**Until it is decided, the exit-evidence lost-pod scenario is not reachable**, and AC-13 and AC-16
stay material (7.9).

**Open follow-up to D48, assigned to silvio.** The decision itself (the pod artifact read moves from W-021 to W-022) is accepted. The design of that read, how a pod gets a bundle when only the supervisor holds an identity (`06:110`), goes to silvio before W-022's brief.

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
review: four blockers and thirteen should-fix items, all taken (section 10, round 3). Every
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
- **W-021:** `apps/api/src/auth/capability-proxy.ts:59` treats `starting` as live. After W-017 `starting` means "Job bound, no permit", so it should narrow to `running`. Answered in section 8 (C3): live means `running` or `suspect`, at the epoch, with the lease unexpired in the statement that takes the slot. Also: an egress NetworkPolicy that blocks internal and cluster addresses (the API server, the metadata endpoint, other pods) for allocation pods, and a ValidatingAdmissionPolicy that backs A-25 (only the runner's account and the Job controller create Jobs, pods and claims in the execution namespace; nothing else uses the supervisor's account).
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
- **A-31** (new; stands in for INT-02 and W-022, which now owns scoped artifact reads from pods, D48): the pod materializer clones a fixture repository inside a test image over `file://`; no Git credential exists in any pod; `bundle` sources are not served to pods.

Spec issues W-017 records in `docs/spec-issues.md`: SI-13 and SI-14 from the earlier list, and
SI-19 to SI-26, all in the table in section 9.

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
after each round of its two reviews (section 10, round 5). No test and no cluster was run for this brief: every code fact below
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
- **The beat.** Every `beatSeconds` from the grant, with a 5 s request limit. The fence time is the **send** time of the last granted call plus `leaseSeconds - beatSeconds` (50 s), on the monotonic clock. Every grant refreshed the server's lease after that send (rule 4, the acquire retry included), so the supervisor always gives up first. Transport errors, `throttled` and `review_unavailable` are retried every 2 s until the fence time. `Date.now` is forbidden by lint here as in the runner. **Amended after review:** the fence is also noticed on a TIMER at the fence time, re-armed at every grant; each request's limit is the lesser of 5 s and what is left until the fence, and a 401 is not retried (nor any call begun) once the fence has passed. Checked only before each send, a hung request and its retry could carry the supervisor to about s + 62, after the server's lease. With the 2 s retry cadence, a short lease (4 s here) can fence on one failed beat: the production numbers (beat 10 s, fence 50 s) leave many retries.
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
| `apps/runner/test/w017-permit.test.ts:90-97`, `:104` | Added in 19a, found by its first run: the per-source hook now **charges** a source for a request whose token did not verify locally, so the test sends a junk token for the noisy source and adds the valid-token control; the 41st-review test lifts the per-pod bucket (`podRate`) out of the way, because it is the shared budget's test. | 19a |
| `apps/runner/test/fixed-rows.ts` | One field on the allocation row (`heartbeatBeforeUpdateMs`). | 19a |
| `apps/runner/test/w017-pod-materializer.test.ts` | Two added cases (the root's mode, the umask). | 19b |
| `apps/runner/test/w017-run.k8s.test.ts` | One assertion: the `factory` directory on the node is `750` (the pod export's mode), not `700`. It now runs under the local egress policy; its pods use no network. | 19b |

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
| `ac-10-duplicate-supervisor.test.ts` | The fake injects a second pod for the Job with an identical receipt; both name the same claim, so both see the same directory, and both run the real supervisor. Exactly one is granted. The other exits 65; its log has no workspace-view event; a snapshot of the shared tree (paths, modes, sizes, hashes, as W-018's tests take one) is equal before and after its run; its launcher started no program. The winner's launcher started one, once. **Control:** the winner's log has the view event, and in a fresh setup the second pod alone is granted. The next pass deletes the loser and only the loser. **What this does not show:** that the loser made no read at all at the system-call level. That rests on the view's construction rule and its structural test, and on `ReadWriteOncePod` at K. **Amended:** the fake relaxes the claim's access mode to `ReadWriteOnce` so that the duplicate is scheduled beside the first (on a cluster `ReadWriteOncePod` keeps it Pending); the control holds the first supervisor with a STOP of its own before it asks for anything. |
| `ac-12-stale-live-writer.test.ts` | A writer runs. Its supervisor's group is **paused**, and the lease is backdated past expiry. The pass moves it to `stopping`; the fake holds the pod's delete (the process is shown alive); the stop deadline is backdated: `quarantined`, with the record, the workspace `quiescing`, the claim untouched. A replacement is requested: generation 2, epoch 2, a new claim and so a new directory, a new supervisor granted. Then two assertions, kept apart. **The server half:** the test itself calls the renewal route with the old pod's token and epoch; it is denied, no lease moves, and nothing is written but the denial's audit row. **The supervisor half:** the old supervisor is resumed after its local fence time; it exits 70, and the listener's log shows no request from that pod after the resume. Its launcher is told to stop, and generation 2's tree snapshot is unchanged throughout. A publish with epoch 1 is `stale_epoch` (W-018's publisher, called here). **Control:** the same sequence with the delete not held ends `terminated` with a proof and no quarantine record. In both, no manifest names generation 1's claim. **Amended:** the delete is held by `FakeKube.delayDeletes` (the pod is Terminating and the kubelet is told nothing, so no TERM is pending when the supervisor resumes); the server half asserts `not_this_job`/`pod`; the epoch-1 check is W-018's `markWriterStopped`, not the publisher; the supervisor's lease here is 4 s so that its fence is 3 s. |
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

- **AC-10.** A real duplicate supervisor exits and launches nothing; one writer launches: fake tier. With W-017's lines this completes AC-10 at the runner. Not claimed: the same through the Activity (W-023); duplicate pods on a real cluster. **Amended after the 19b build:** under `ReadWriteOncePod` a second pod on the claim stays Pending on a cluster (W-017's finding), so the duplicate this test shows exists only because the fake relaxes the claim to `ReadWriteOnce`; what it shows is the permit race and the loser's silence, and the cluster's own protection is `ReadWriteOncePod` (K, W-017's second-pod case).
- **AC-12, the quarantine half.** A lease expires while the old process still runs; the old writer's pod-facing calls are refused and it stops itself; without a proof the generation is quarantined on record and the replacement is isolated; no volume is reused without a proof, because none is reused by a writer at all (D19): fake tier. Not claimed: stale-epoch denial of artifact finalization and result publication (W-020, W-023) and of tool operations (W-075); isolated restore (W-020); detachment on attachable storage (R). **Amended after the 19b build:** at the cross-app tier the old writer is refused at the guard's POD READ (`not_this_job`, `pod`), because the held delete leaves its pod with a deletion timestamp; the state and epoch refusals are 19a's `w019-pod-guard`, and W-018's publisher is not called here (an epoch-1 `markWriterStopped` is `stale_epoch` instead). The supervisor half exits 70 only because the pod delete was HELD: had TERM been delivered to the stopped process, it would exit 143 on resume (still fenced, still silent).
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
  - `local-path` does not enforce a claim's size, so a harness can fill the node's disk. That predates W-019. W-021 does not close it (section 8, C11); it stays with W-024 and D4.
  - The scripted harness shows nothing about Claude in a restricted pod (W-077).

### Hand-offs

- **W-020:**
  - **`finalizing` is yours** (D22): the supervisor's finalisation request, `running → finalizing`, the intent record, and the pass. The request is a route that changes state, so by rule 4 its locked statement carries `controller_lease_until > clock_timestamp()`; a finalize on an expired lease would be result acceptance on expired authority (`06:112`). The proof steps and the quarantine move are reusable as they stand; `register` must then also accept `finalizing`.
  - Require `volumeDisposition` to be `quiescent`, and **list the claim's consumers again when the child is admitted**: the proof is a past observation.
  - Decide what the stop acknowledgement means for a checkpoint at cancel (SI-29).
  - **Inferred, not tested:** under `fsGroup` the kubelet may rewrite group and mode on every file when a second pod mounts the claim; a trusted read-only mount should not change the tree it is about to hash (step 0 records what this cluster does).
  - Any read of a workspace a harness has run in uses descriptor-relative, no-follow traversal (the view's rule).
- **W-021:** the production policy, with an allow rule for the listener's **port**, not the runner's host (W-023's control-plane port lives there too); the real deny-target list; an admission rule against grace 0; `get nodes` and the one Service read are new rights. The local policy file is replaced. `capability-proxy.ts:59` still treats `starting` as live (section 5's hand-off, answered by C3 of section 8).
- **W-023:** persist the stage input, bound as SI-21 decides (D26). After a harness exit the run reports `reconciling` until W-020. Carry the quarantine record's ref in `cleanupObligationRefs`. The worker-facing route is a second listener and its wire types go in `@factory/runner-protocol`. `watchEvents`. `cancel` has an `urgent` option.
- **W-024:** delete a replaced generation's claim only when `volumeDisposition` is `quiescent`; a `quarantined` one only after `preserveUntil`, or earlier through the audited operator action D25 defines, **which W-024 builds**, with its resolution record; `unknown` never. Stop the pod of a quarantined allocation. Route the open-quarantine count to its owner (INT-09).
- **W-030:** when the publisher gets a credential it must not sit under `scratchRoot`, and the publisher's scratch root and any materializer root must be disjoint; both use `<org>/<workspaceId>` (`publish.ts:113`, `materializer.ts:92`). Both READMEs say so from W-019 on. **W-030 owns the check and its test**, not only the sentence: the publisher refuses to start on a scratch root that equals, contains or lies inside a materializer root it is told about. **Control:** two disjoint roots start.
- **W-075:** the tool routes join the local endpoint with their own authentication; every one checks the fence flag first, goes through the listener's guard for anything remote, and reads the workspace only by the view's rule.
- **19b (the production entry):** `runnerProcessFromEnv` sets no `networkGate` and no `podListener`, so today it fails closed: the gate defaults to `required` with no deny target, and start-up refuses; and no listener starts. 19b must read both from the environment (the deny list, the listener's address, port, certificate and key) and add a test that starts **the env entry** against the fake and shows the listener answering and the checks having run.
- **W-021 and W-090 (admission):** keep a scripted harness image out of every tier but the local one (A-33). Admission cannot read an image label, so W-021 enforces this through the tier's image allowlist, not by reading the label (section 8, C2 and D46). The production harness image is not built by `scripts/k3s.sh`.
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
- **A-33** (W-077, INT-08; extends A-27): the harness container is the launcher plus a scripted program. No Claude, no gateway, no model call. Each scripted-harness image carries ONE script, baked in at build time, no environment override, and the label `factory.harness=scripted`. **W-021's image allowlist keeps a scripted image out of every tier but the local one** (admission cannot read the label; section 8, C2 and D46) (a run could otherwise "end" on `harness_exited` having done no work).
- **A-34** (INT-07 retention obligations; `06-runner-workspaces.md:104`): a quarantined volume is preserved for 30 days under the obligation owner `platform-operator`, as restricted evidence, and is escalated after one day.
- **A-35** (INT-05, W-021): the local tier's egress policy allows only the listener's address and port, and the gate's deny targets there are the API service, the metadata address and the Mac's Postgres and Temporal ports. A target counts as denied when a connect is refused or times out. **Amended after the 19b build:** `169.254.169.254:80` is refused on this machine with NO policy at all, so that target shows no rule active here; the three that show it are the API service and the gateway's Postgres and Temporal ports, and the `w019-network-gate.k8s` file first shows from the host that those two accept a connection. The pod-side with/without comparison is step 0 item 5's, not that file's.

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

## 7. Fourth package brief: W-020 Durable checkpoints and restore

Written 2026-11-19 and 2026-11-20 against `a119964` (W-019b committed; W-019's k3s tier written, not
yet run), and revised on 2026-11-21 after a design review and a security review (7.12). No test
suite and no cluster was run for this brief. Every code fact below was read against `a119964`.
The probes (Node 24.22.2, the version pinned in `.node-version` and `package.json` `engines`, and
Git 2.50.1) and their results are in 7.2. Every Kubernetes behaviour is
a row of section 2, a W-019 step 0 finding, or is marked **to confirm in the k3s tier**.

**Goal.** Make a stage's work survive the loss of its pod once the work is acknowledged (INV-09),
and nothing earlier. When W-020 is done:

- a supervisor can ask to finish; the runner records the intent, moves `running → finalizing` on an unexpired lease, stops the whole authoring pod and proves it stopped, as W-019 does for a stop;
- a trusted checkpoint child (`checkpoint_job`) of that allocation mounts the retained volume read-only and reads the candidate's `.git` and working tree **without running Git on them and without honouring anything in them**, through a bounded reader written here (D10);
- the child reads the committed, index and dirty-state manifests in one container that holds no credential, and in another, which never mounts the claim, builds a self-contained bundle and patches in a factory-owned scratch repository, streams the parts to the runner, and submits;
- the runner accepts one checkpoint per finalizing allocation, under the parent's lock, at the parent's generation and epoch, on an unexpired finalize deadline; compare-and-swaps `workspace.checkpoint_ref`; and moves the allocation to `completed` with a runner-minted `StageResult`, `inconclusive` until W-075 (D30);
- a new generation of a checkpointed row can be restored from its accepted checkpoint into a fresh directory, and the restore proves it reproduced the recorded head, index and source digests. No runner path reaches this in M2 until O1 is decided (7.5);
- a checkpoint that was uploaded but not accepted is never offered as a recovery point.

No migration (`checkpoint_job`, its unique index, its grants and the `workspace.checkpoint_ref`
grant all exist). No new npm dependency. No Temporal and no workflow change (W-023). No factory
tools and no proposals (W-075). No secret scanning (W-116). No real harness (W-077). Restore into a
**pod** waits for a scoped artifact read from inside a pod (D13, D36; W-021's D48 gives it to
W-022); W-020's restores run through `LocalMaterializer`. How a later stage run starts from an
earlier one's checkpoint is open (O1, 7.10).

**Size.** The backlog says 4–6 days; section 1 added 3–5 for the reader. I expect **18 to 21**
(7.11 counts it item by item): the reader is 5 to 6.5 days with its fuzz, layout, limit and hostile
fixtures; the checkpoint child, its two containers and two volumes, its listener, the finalize
route, the `finalizing` pass and acceptance are 10 to 12; restore is 2.5 to 3.5. Three commits,
each with its own review (D35): **20a** the reader, a library with no caller; **20b** checkpoints;
**20c** restore and the acceptance lines. There is no step 0 cluster probe; the five k3s questions
this design rests on are in 7.9 and each has a fallback.

**Words.** "The reader" is the untrusted-Git reader of 20a. "The child" is a `checkpoint_job` row
and its Job; `read` and `build` are its two containers, and `export` and `work` its two exchange
volumes. "The parent" is the `finalizing` authoring allocation. "The intent" is the stored
finalize request. "The parts" are the bundle, the two patches, the index manifest, the handoff and the `CheckpointManifest`. "Acceptance" is the
one transaction that moves the parent to `completed`. "Proof", "hold", "listener", "guard", "view",
"launcher" and "PVC" are as in section 6.

**Spec to read.** `06-runner-workspaces.md:25` (restore the last acknowledged checkpoint on a new
volume), `:59` (no repository-local program), `:61` (secrets excluded from checkpoints), `:63-76`
(the checkpoint algorithm, bundles, frequency), `:82-84` (restore, freeze, trailers), `:88` (one
accepted terminal result; duplicate identical finalization returns it), `:90` (cancel),
`:100-104` (release after an accepted checkpoint; sweep of unfinalized checkpoints), `:108`
(bounded, path-safe parsing), `:112` (finalisation boundary, the child, its fencing, its identity),
`:114` (the reader), `:116`; `09-verification-security.md:5`, `:71`, `:77`, `:95`;
`07-harness-context.md:24`, `:128`, `:132`; `01-scope-architecture.md:39-40` (INV-09, INV-10);
`contracts/interfaces.ts:78-97`, `:238-263` (`WorkspaceManager.checkpoint/restore`,
`StageFinalizer`); `domain.schema.json` `CheckpointManifest`, `FileSnapshot`, `StageResult`,
`HarnessRunResult`; `schema.sql` `checkpoint_job` (`:382-394`), `one_live_checkpoint_job`
(`:983`), the grants (`:1460-1466`) and the note at `:1560`; acceptance AC-13, AC-14, AC-16,
AC-206, AC-230, AC-231.

Code: `packages/workspace/src/manager.ts:140-153` (`requestInTx`, `restore_unavailable`),
`:310-322` (`replaceWriter`'s `next`), `:359-389` (release and its checkpoint rule), `:391-392`
(the two stubs); `materializer.ts:35-49` (limits), `:138-175` (bundle path, worktree add),
`:216-235` (`verifyCheckout`); `tree-digest.ts`; `paths.ts:55-150` (symlink and folding rules);
`controller-record.ts`; `volume-disposition.ts`; `packages/database/src/workspace.ts:152-156`
(`checkpointRetained`); `packages/workspace/src/git.ts:47-59`, `:71-97`; `apps/runner/src/states.ts:16-17`, `reconcile.ts:38-136`, `:359-449`,
`:451-460`, `pod-guard.ts`, `names.ts:29`, `records.ts`, `workspaces.ts`, `start.ts:238-246`
(`getResult`), `job-manifest.ts`; `packages/runner-protocol/src/pod-api.ts`;
`apps/supervisor/src/supervisor.ts`, `heartbeat.ts`, `local-endpoint.ts`;
`packages/artifacts/src/service.ts:110-139` (`reserve`), `:164-178` (`upload`, which takes an
`AsyncIterable`), `:214-256` (`finalize`, which verifies digest and size), `:286-317`.

### 7.1 What is already built, and the conflicts

**Built, and not rebuilt here.** The `finalizing` edges (`states.ts:16-17`) and its `RunHandle`
mapping (`states.ts:36`). `finalizing` already counts as live (`states.ts:27`), so
`one_active_allocation` refuses a second generation while a checkpoint is in progress (AC-206's
"without allocating a second authoring generation"). The `checkpoint_job` table with
`one_live_checkpoint_job` (`0007_indexes.sql:31`, live = `desired`, `starting`, `running`,
`quarantined`) and its column-limited grants (`0010_roles_ownership_grants.sql:88-89`: `job_uid`,
`pod_uid`, `state`, `updated_at`). `checkpointJobName(org, receiptId)` and its vectors
(`names.ts:29`, SI-13). The proof, the quarantine record, the one-way door and `volumeDisposition`
(W-019). The streaming upload path of `ArtifactService` (`reserve`, `upload` over an
`AsyncIterable`, `finalize` with a digest and size check). Release already accepts `checkpointed`
and requires `checkpointRetained` on the stored ref (`manager.ts:69`, `:370`). `replaceWriter`
already answers `restore_required` when `checkpoint_ref` is set (`manager.ts:320`).

Each row below was checked against the code or the spec today.

| # | Where | What it says | What is actually there | Brief |
| --- | --- | --- | --- | --- |
| C1 | Section 6, disposition table; hand-off | The child may mount a `quiescent` volume. | `volumeDisposition` answers `unknown` for a `finalizing` row even with a proof (`volume-disposition.ts:16-17`), and `quiescent` only for `stopping` and `terminated` (`:20`). The child is admitted while the parent is `finalizing`, so as written it can never be admitted. | 20b changes one row and adds one input: `finalizing` with a proof that meets the `quiescent` conditions answers `quiescent`, `mayAct` naming the child only; and a live or quarantined checkpoint child makes any state `in_use` (race rule 16). `w019-volume-disposition.test.ts` changes with it (7.7, edits table). |
| C2 | Section 6 hand-off ("`register` must then also accept `finalizing`") | | `registerProof` refuses anything but `stopping` (`reconcile.ts:364`); `toQuarantined` refuses `finalizing` as a source (`:101-102`); `QuarantineRecordBody.source` has no `finalizing` (`quarantine-record.ts:12`). | All three gain `finalizing`. The record's schema stays `factory-quarantine-record/1`: the enum gains a value, and every reader already treats `source` as a code. |
| C3 | W-017 assertion; `allocation.ts:118-120`; `reconcile.ts:459` | A pass leaves a `finalizing` row alone. | Kept by `w017-states.test.ts:55-59` and by the last line of `w019-container-exit.test.ts`. | 20b adds `finalizing` to the work list and a `passFinalizing`. Both assertions change: a pass on a `finalizing` row with no work to do (proof stored, child running, deadline ahead) changes nothing. Listed in the edits table. |
| C4 | `backlog.json` W-020 `modules` | `packages/workspace` only. | The design needs `apps/runner` (routes, pass, child Job, acceptance), `apps/supervisor` (the finalize request), `packages/runner-protocol` and `packages/database`. | As W-019 did with `packages/workspace`: every file is listed in 7.7. The reader and the manifests live in `packages/workspace`, as the backlog says. |
| C5 | SI-12; `backlog.json` W-129 | Child fencing (AC-206) is W-129's, in M4. | Nothing in M2 can finalize without it. | Built and tested here; **AC-206 is not claimed** and stays listed under W-129, which adds the operational projections. The build-log line says so. |
| C6 | `start.ts:241` ("the runner never builds a result"); `backlog.json` W-075 ("quiesced finalization"); `apps/worker/src/activities/persistence.ts:41` | The result is someone else's. | `getResult` reads `stage_run.result_ref`, which today only the worker writes, from the fake executor. Without a runner-minted result no runner stage can end `completed`, and W-023 (package 5) and the exit-evidence checkpoint need one long before W-075 (package 14). | D30: W-020 builds `StageFinalizer.finalize`, callable only by the child's identity, minting `inconclusive` with the checkpoint and no outputs; the harness exit code is a diagnostic only until W-075's `submit_result` (accepted by the owner, 2026-11-22). W-075 adds the proposal binding. The runner writes `result_ref` once, compare-and-swap from null. Hand-off to W-023: the worker's persistence must not write a different `result_ref` for a runner stage. |
| C7 | SI-13; `UNIQUE(org_id,namespace,job_name)` (`schema.sql:393`) | The child's name comes from `receipt_id` alone. | One receipt then allows exactly one child row and one Job name, ever. A child whose pod is lost could never be retried. | The name function is unchanged. The receipt is derived per **attempt** (D31: at most two), so each attempt is its own row and Job. "Finalizer retries use the same receipt" (`06:112`) still holds: retries of the finalize call within one attempt reuse its receipt. The token audience is `factory-checkpoint:<childId>`; the child id is itself derived from the organization. |
| C8 | `pod-api.ts:8` | Pod-facing bodies are capped at 16 KiB. | A bundle can be hundreds of MiB. The listener's limits are server-wide: headers and body within 5 s, a request within 10 s (`pod-listener.ts:21-23`, `:176`), so no route on that server can carry one. Pods reach only the listener (`09:77`); a scoped artifact write from a pod does not exist (D13). | A separate route family for the child's identity, with its own admission and a streamed body (7.4, D32). The 16 KiB cap and the admission order of section 6 stay as they are for every other route. |
| C9 | Section 6 hand-off ("inferred, not tested") and step 0 item 2 | Under `fsGroup` a second mount may rewrite modes. | Measured: a second mount turned 0750 and 0700 directories into 2770 and a 0640 file into 0660. Every pod the runner renders sets `fsGroup: 10001` (`job-manifest.ts:75`). | The child sets **no `fsGroup`**, and its `read` container runs as `10001:10001`, the tree's owner; the claim is mounted `readOnly` in both the volume source and the mount. The reader takes a file's mode from one bit only, the owner's execute bit, and never trusts group or other bits. To confirm at K (7.9, item 2). |
| C10 | `manager.ts:143`, `:202`; `start.ts:89` | A row with a `checkpoint_ref` answers `restore_unavailable`. | Three places, not two: the allocate step refuses such a workspace before any allocation exists (`start.ts:89`), so even a correct manager would never be asked. | All three are replaced in 20c by a `restore` request kind (7.5). In a pod the request is still refused, now as `not_supported_restore_source`, until a pod can read an artifact (D13, D36). |
| C11 | `CheckpointManifest.handoffRef` (required) | The manifest needs a handoff. | No handoff schema exists in `domain.schema.json`, and in M2 there is no adapter to write one (A-27). | A minimal factory-written handoff, `factory-portable-handoff/1` (SI-36, 7.4). |
| C12 | AC-13 ("without secrets"); W-116 | The restored state holds no secret. | Secret scanning of checkpoints is W-116's (package 10). | Claimed **by construction only**: no factory credential is ever on the volume (the token is in the supervisor's projected volume, `06:110`; no Git credential, A-31), plus a factory deny list of names that are never captured (7.4). The scan is W-116's. |
| C13 | `06:90`, `:112`; SI-29; `start.ts:186` | Cancel allows 30 s for "a safe checkpoint request"; cancellation "permits only scoped checkpoint/cleanup recording". | Cancel moves only `desired`, `starting`, `running` and `suspect` to `stopping`, and leaves a `finalizing` row alone after writing its record. There is no `stopping → finalizing` edge, and the DDL note says admission verifies `finalizing` (`schema.sql:1560`). | D29: a cancel never **starts** a checkpoint. A cancel that finds the row already `finalizing` lets the checkpoint finish and be recorded, and suppresses the result; an urgent one ends the checkpoint at once. The hold stays a courtesy. SI-29 is answered. |
| C14 | `reconcile.ts:475-490` | The sweep deletes Jobs that should not exist. | It lists Jobs by the allocation label and skips any whose name is not the allocation's (`job-manifest.ts:110`), so it would neither delete nor clean up a child Job. | Child Jobs carry the `<prefix>profile: checkpoint` label (W-021's profile label) and their own annotations, and the sweep gains a rule of its own for them (7.4). |
| C16 | `manager.ts:179`; section 6 rule 1 | No object-store call inside a transaction (W-019's clause). | W-018's `acceptInTx` puts the receipt object inside the caller's transaction, under the row lock. W-019 did not touch it. | 20c moves the put before the lock for every receipt (remote, bundle and restore): the body is built from the request, put, then registered under the lock after the comparisons. A receipt that loses the comparison leaves an orphan for the artifact sweep, as a proof does. `w018-allocate.test.ts` keeps passing unchanged. |
| C17 | `heartbeat.ts:97` | A supervisor learns of a stop from `not_renewable` with reason `stopping`. | Any other final denial fences it (exit 70). A renewal of a `finalizing` row is answered `not_renewable` with reason `finalizing`, so as written a supervisor whose stage is being checkpointed would report itself fenced. | 20b: `finalizing` takes the `ending` path, without a stop acknowledgement (the finalize intent already is one). And once a supervisor has sent finalize, **any** final denial takes the `ending` path: the pass that the finalize sets off deletes the pod, so a retry after a lost answer is refused at the pod read (`pod-guard.ts:156`) as `not_this_job`, which must not read as fenced (review, Livia 10). |
| C18 | `service.ts:336-353`, `manager.ts:136` | `readVerified` returns a verified `Buffer`. | It reads the whole object into memory, default cap 16 MiB. W-018's candidate path already reads bundles of up to 512 MiB this way. | Restore reads its bundle the same way, capped at the part limit (bundle 256 MiB, the artifact service's default upload cap; patches 128 MiB). A streaming read is P-31. |
| C19 | `service.ts:57`, `:226-228` | Artifact finalization needs the reserved stage run to be active. | The check reads `stage_run.status`, which the worker writes. A stage the worker has already marked finished or cancelled refuses every part. | Kept: it is one more fence. A part refused this way fails the attempt as `stage_not_active`, and the parent goes to `stopping` (7.4). |
| C20 | `states.ts:16`; `reconcile.ts:39` | `finalizing` is entered from `running`. | There is no `suspect → finalizing` edge, and `move` asserts every edge. | Finalize moves from `running` only. In `suspect` it answers `not_finalizable`, reason `suspect`, **retryable**: the supervisor's next renewal returns the row to `running` (`allocation.ts:176`) and its retry then succeeds. The edge table is unchanged (review, Livia 3). |
| C21 | `workspace.ts:151-155` (database); `manager.ts:370` | Release requires the checkpoint to be retained. | `checkpointRetained` checks the one artifact `checkpoint_ref` names, the manifest. A checkpoint is six artifacts. | Acceptance links **every** part the manifest names, and the index manifest, under `checkpoint/<workspaceId>/g<generation>/<part>`, and `checkpointRetained` gains a second check that each linked part is still retained. W-024's unfinalized-part rule then cannot match an accepted part (review, Livia 1). |
| C22 | `pod-guard.ts:191` | A workspace denial is `stale_epoch` on renew and stop-ack, `not_startable` otherwise. | A new route falls into `not_startable`. | `finalize` joins renew and stop-ack in the `stale_epoch` branch (review, Livia 14). |
| C23 | `job-manifest.ts:47`; `pod-guard.ts:182` | An allocation may have no workspace; the guard then skips the workspace clause. | Finalize would move such a row to `finalizing`, where no child can ever be admitted, and it would hold capacity until the finalize deadline. | The runner offers finalize only to an allocation with a workspace (the grant's `finalizeOffered`, 7.4); a finalize without one answers `not_finalizable`, reason `no_workspace`, and the pass stops it as W-019 does (review, Livia 5). |
| C24 | `tests/recovery/test/kit.ts:68-73`; `w019-lifecycle.test.ts:22-39`; `pod-listener.ts:70` | W-019's cross-app and k3s files expect a harness exit to end `stopping`, `harness_exited`. | `kit.ts` does not pin the new wait, so its 20 s default lets finalize win; and with the wait at 0 the pass a renewal sets off races the supervisor's request. | The supervisor sends finalize **only when the grant says `finalizeOffered: true`**, which the runner sets only when its wait is above 0 and the allocation has a workspace. W-019's files pin the wait to 0 and are then deterministic; the edits table lists every one (review, Livia 4). |
| C15 | Section 1 row 4 | AC-13, AC-14 and AC-16 at F, "real Git". | The design runs Git only in factory-owned repositories. The candidate's repository is read by the reader. | Unchanged in substance: real Git builds and verifies every bundle and restore, and the candidate's `.git` is never given to it. |

### 7.2 Rules, and the probes

W-017's three rules and W-019's four stand. Rule 1's clause (no Kubernetes or object-store call
inside a transaction) covers every new path; parts are streamed and objects put before the
transaction that links them. Three more:

8. **Candidate Git metadata is data.** Nothing trusted runs Git, or any program, on a directory a
   candidate could write. Trusted code reads it only through the reader, which opens a fixed list
   of paths from the layout the factory created, never a path the repository names (not `.git`
   files, `commondir`, `gitdir`, alternates, `info/grafts`, `refs/replace`, `shallow`,
   `commit-graph`, `multi-pack-index`, or any configuration). Every object is checked against its
   SHA-1. Git runs only in a scratch repository the child created, on objects the reader verified,
   and Git itself verifies them again on the way in (`index-pack --strict`, 7.4). Node's SHA-1 has
   no collision detection and Git's does, so that second check is the collision check and may never
   be skipped (review, Furio L3). Every path a candidate chose reaches Git through stdin,
   NUL-separated, with literal pathspecs (review, Furio M1).
9. **One accepted checkpoint per finalizing allocation, and only under the parent's lock.**
   Admission and acceptance both lock the parent and check `finalizing`, generation and epoch, and
   acceptance also checks the finalize deadline in the same statement (rule 4 applied to the
   child). Acceptance alone takes the full lock order, stage run, then workspace, then allocation,
   then child; every guard check before it is unlocked and advisory (review, Livia 13). A child's identity can do nothing else. The authoring supervisor and the harness cannot
   finalize (AC-231).
10. **A checkpoint is acknowledged only by the commit that stores it.** Until acceptance commits,
    `workspace.checkpoint_ref` and every reader of it still name the previous accepted checkpoint,
    or none. An uploaded part, a stored manifest object and a child that reported success are not
    checkpoints (AC-14).

**Probes run for this brief** (Node 24.22.2 and Git 2.50.1, throwaway scripts, no factory code; kept at
merge under `docs/design/w020-probes/`):

| # | What was run | Result | What it means here |
| --- | --- | --- | --- |
| Z1 | `zlib.inflateSync` of a stream followed by 12 bytes of junk, with `{ info: true }` | Accepted. `engine.bytesWritten` is 17, the stream's own length, against 29 bytes of input. | Node does not refuse trailing data. The reader must compare bytes consumed with what it expected: the whole file for a loose object, the gap to the next object for a pack entry. |
| Z2 | `inflateSync` of 50 MB of zeros with `maxOutputLength: 1_000_000`; a 200 MB stream (194,409 bytes, ratio 1,029) with `maxOutputLength: 4096` | Both refused with `ERR_BUFFER_TOO_LARGE`; the bomb in 0.06 ms. | `maxOutputLength` is the decompression cap. A pack entry is inflated with the size its own header declares and nothing more; a loose object, whose size is inside the stream, with the per-object cap, after which the header is checked against what came out. A bomb costs nothing. |
| Z3 | A stream cut by 3 bytes; non-zlib bytes; a stream made with a preset dictionary | `Z_BUF_ERROR`; `Z_DATA_ERROR`; `Z_NEED_DICT`. | Truncation, garbage and dictionaries are refused by Node itself; the reader maps each to one code and never passes a `dictionary` option. |
| P1 | `node --permission --allow-fs-read=<tree> --allow-fs-write=<out>`, then reads of an absolute symlink to `/etc/hosts`, a relative symlink out of the tree and a path through a directory symlink to `/etc` | **All three read the outside file.** Writes into the tree, `child_process` and `worker_threads` were refused (`ERR_ACCESS_DENIED`). | The permission model is not a path boundary: it follows symlinks out of the allowed tree. It is kept as a second line against writes and process spawns only (7.3). |
| P2 | `open(path, O_RDONLY \| O_NOFOLLOW)` on a symlink, and on `dirlink/hosts` where `dirlink` is a directory symlink | The symlink: `ELOOP`. Through the directory symlink: **opened**. | `O_NOFOLLOW` covers the last component only. The reader `lstat`s every component itself (7.3). |
| P3 | `open` of a FIFO with `O_NONBLOCK \| O_NOFOLLOW` | Opens at once; `fstat` reports a FIFO. (Without `O_NONBLOCK` a FIFO open blocks until a writer appears: POSIX behaviour, not run, since it would hang the probe.) | A planted FIFO (as `.git/index`, a pack or a worktree file) would hang a reader that opens it plainly. Every open uses `O_NONBLOCK`, and anything that is not a regular file after `fstat` is refused. |
| Z4 | `inflateSync` of the deflated empty buffer with `maxOutputLength: 0`, then with 1 (Furio's `docs/design/w020-probes/furio/z.cjs`, run again here) | `ERR_OUT_OF_RANGE` (it must be at least 1); with 1, 0 bytes out and the whole stream consumed. | The empty blob and the empty tree declare size 0. The reader inflates them with a cap of 1 and requires 0 bytes out, or every repository after `git gc` would crash it (review, Furio L1). |
| G1 | Git 2.50.1: trees written with `hash-object -t tree --literally` holding entries of mode `100664` and `100775`, and a tree with a zero-padded `040000` entry; then `ls-tree -r`, `cat-file -p` and `fsck --strict` | `ls-tree` and `cat-file -p` print `100644` and `100755`. `fsck --strict` reports `badFilemode` as a warning and `zeroPaddedFilemode` as an error. | Git canonicalises a regular file's mode to `100644` or `100755` by the owner's execute bit when it reads a tree, so W-018's `treeDigest`, which reads `ls-tree`, records `100644` for a stored `100664`. The reader must canonicalise the same way to reproduce the digest byte for byte (7.3). |
| G3 | Git 2.50.1: the same two trees, cloned with `transfer.fsckObjects=true` (W-018's setting) and loaded with `index-pack --strict` and `--fsck-objects` | `100664`: a `badFilemode` warning, accepted by all three. Zero-padded `040000`: `zeroPaddedFilemode` **refused** by all three. | W-018 never materializes a zero-padded tree, so the reader refuses one too (`object_corrupt`, reason `zero_padded_mode`); the revision before this one said it accepted it, which was wrong. `index-pack --strict` refuses nothing that W-018's clone accepts in these cases. |
| G4 | Git 2.50.1 (Furio's `docs/design/w020-probes/furio/g1`, run again here): `git add -N '--pathspec-from-file=/etc/hosts'`; `git add -N -- ':(glob)*'` with and without `GIT_LITERAL_PATHSPECS=1` | The first prints `fatal: pathspec '##' ...`, the first line of `/etc/hosts`. The glob stages every file without literal pathspecs and matches only its own name with them. | A candidate path can read a host file or act as pathspec magic when passed to Git as an argument. Rule 8's stdin and literal-pathspec clause (7.4, 7.5). |
| G2 | Git 2.50.1, a bare repository whose `HEAD` tree holds `.gitattributes` with `* -diff`; `git diff` of two commits, with no option, with `--attr-source=<empty tree>`, and with `--attr-source=HEAD` | A text diff, a text diff, and **`Binary files ... differ`** (the control: the attribute is live when a tree is named). | A bare repository does not read in-tree attributes unless told to. The builder still passes `--attr-source=4b825dc642cb6eb9a060e54bf8d69288fbee4904` (the empty tree) on every diff, so that no default, present or future, lets a candidate's attributes shape a patch (7.4). |

The scripts are `docs/design/w020-probes/w020-probe/z.cjs`, `docs/design/w020-probes/w020-probe/p.cjs` (its "symlink out" line is not evidence:
the symlink it names was never created; P1 replaces it), `docs/design/w020-probes/w020-probe2-p.cjs`, the shell lines of G1
and G2 (`docs/design/w020-probes/w020-probe4/`), of G3 and G4 (`docs/design/w020-probes/w020-probe5/`), and Furio's
`docs/design/w020-probes/furio/z.cjs`, `docs/design/w020-probes/furio/g1/` and `docs/design/w020-probes/furio/g2/`.
They are kept in `docs/design/w020-probes/`. P1 to P3 were run a second time, with the same results.

### 7.3 Step one (20a): the untrusted-Git reader

A library in `packages/workspace/src/git-reader/`, with no caller in 20a. It reads one generation
directory that a candidate has written, and returns verified objects and three manifests. It never
runs Git or any other program, never writes inside the directory it reads, and honours nothing the
repository says about itself. It is reviewed on its own before 20b starts (D35).

**What it may open.** The layout is the one W-018 creates (`materializer.ts:4`, `:127`, `:145`, `:166`):
`g<n>/git/.git` is the common directory and `g<n>/git/.git/worktrees/main` the worktree's
administrative directory, both made by `git clone --no-local --no-checkout` or `git init` and
`worktree add --relative-paths`; `g<n>/work/main` is the checkout. The reader opens only these
paths, built from the generation directory and fixed names, never from a file's contents:

| Path under `g<n>/git/.git/` | Read for | Never read |
| --- | --- | --- |
| `worktrees/main/HEAD` | The checked-out ref or commit | `worktrees/main/commondir`, `gitdir`, `config.worktree` |
| `worktrees/main/index` | The index | |
| `refs/heads/...` (one loose ref, and up to four symref hops) and `packed-refs` | Resolving `HEAD` | `refs/replace/`, `refs/remotes/`, every other ref |
| `objects/xx/<38 hex>` | Loose objects | `objects/info/alternates`, `objects/info/http-alternates`, `objects/info/packs`, `objects/info/commit-graph(s)`, `objects/pack/multi-pack-index` |
| `objects/pack/pack-<40 hex>.idx` and `.pack`, paired | Packed objects | `.keep`, `.rev`, `.mtimes`, `.promisor` and any other name |
| (existence only, by `lstat`) `reftable` | Refusal: `unsupported_ref_storage` | |

`config`, `info/attributes`, `info/grafts`, `info/exclude`, `hooks/`, `shallow`, `.git` files and
everything else are never opened. In `work/main` the root `.git` entry is never opened; every other
entry is data (below).

**File access** (`fs-safe.ts`, the only module of the reader that imports `node:fs`):

- Every path is walked component by component **from the claim's mount root** (`/workspace` in the child), with `lstat`: `factory`, the organization, the workspace, `g<n>`, `git`, `.git`, `objects`, `objects/pack`, `worktrees/main`, `work` and `main` are each a real directory or the walk stops with `path_unsafe`. The harness had all of them mounted read-write and could have replaced any one with a symlink (`job-manifest.ts:65`); P2 shows `O_NOFOLLOW` covers only the last component (review, Furio L2).
- Paths are built as `Buffer`s from raw names and never decoded first. A name is checked as well-formed UTF-8 on its raw bytes before anything uses it.
- Every open is `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` (P3), followed by `fstat`: it must be a regular file with the same device and inode as the `lstat`, and no larger than the cap for its kind. **Small files** (`HEAD`, a ref, `packed-refs`, the index, a loose object, a working-tree file) are read whole, exactly `st.size` bytes, and a second `fstat` must show the same size. **Packs and their indexes are never read whole:** entries are read with positioned reads (`readSync` at an offset, at most one entry's compressed length at a time), and the trailer's SHA-1 is computed by streaming the file through the hash in 1 MiB chunks (review, Livia 8, Furio M2).
- Directory listings use `readdirSync(path, { encoding: 'buffer' })`, so names are bytes; each name is then `lstat`ed, never followed.
- The `read` entry runs the reader under `node --permission` with read access to `/app` and `/workspace` and write access to `/export` only (7.4). P1 shows that is not a read boundary, so it is a second line against writes, spawns and workers, and nothing more.

**Objects.** Every object the reader returns has been verified, and is returned as its type and
body. Lookup is packs first, then loose; there is no other source.

- **Loose:** the file is at most `maxObjectBytes` compressed. It is inflated with `maxOutputLength = maxObjectBytes + 64` (Z2). The header must be `<type> <decimal size>\0`, the type one of `commit`, `tree`, `blob`, `tag`, the size without leading zeros and equal to the body's length; the bytes consumed (`engine.bytesWritten`) must equal the file's size (Z1); the SHA-1 of the inflated bytes must equal the name.
- **Packs:** `.idx` version 2 only (magic `\377tOc`; a version 1 index is `unsupported_pack`). The fan-out must be monotone and end at the object count, names strictly ascending, large offsets only through the 64-bit table; the trailing SHA-1 of the index must verify, and so must the pack's own trailer, which must also equal the checksum the index records. The `.pack` must start `PACK`, version 2 or 3, with the index's object count.
- **Pack entries:** the type and size varint is bounded to 10 bytes. Types 1 to 4, 6 (offset delta) and 7 (reference delta); anything else is `object_corrupt`. An entry's compressed length is the distance to the next entry's offset (or to the trailer), taken from the sorted index offsets. It is inflated with `maxOutputLength` equal to the size its header declares, **or 1 when it declares 0** (Z4: the empty blob and the empty tree); the output must be exactly that size and the bytes consumed exactly the compressed length (Z1). The CRC-32 of the raw entry (`zlib.crc32`, Node 22 or later) must equal the index's.
- **Deltas:** an offset delta must point at an earlier entry that the index lists; a reference delta's base is looked up like any object. The delta header's base size must equal the base's length, its result size must be at most `maxObjectBytes`; a copy must lie inside the base (a size of 0 means 0x10000), an insert is 1 to 127 bytes, opcode 0 is refused, and the output must be exactly the result size. Resolution is iterative, depth at most `maxDeltaDepth` (512, against Git's own maximum of 4,095 and default of 50), with a visited set for cycles and a delta-base cache of 96 MiB.
- **SHA-1 for every object:** of `<type> <size>\0<body>`, compared with the index name or the file name. A mismatch is `object_corrupt`. Nothing is trusted because it came from a pack.
- **zlib:** `inflateSync` with `maxOutputLength` always and `dictionary` never; `Z_NEED_DICT`, `Z_BUF_ERROR` and `Z_DATA_ERROR` (Z3) map to `preset_dictionary`, `truncated` and `zlib_error`; consumed bytes short of the expected length are `trailing_data`.
- **Work budget:** `maxWorkBytes` caps the sum of every byte inflated **and every byte a delta writes**, delta bases re-inflated after eviction included, so a chain of tiny deltas that each copy 32 MiB is charged for its copies (review, Furio M2). The deadline is checked before every object, not every 4,096.
- **Memory:** the reader holds at most the delta-base cache (96 MiB), one object's base, delta and result (3 × `maxObjectBytes`), the index file (64 MiB) and the manifests it is building. Its peak is under 512 MiB by construction; the `read` container's limit (7.4) is 1 GiB.

**Refs and `HEAD`.** `worktrees/main/HEAD` is at most 4 KiB: `ref: refs/heads/<name>` or 40
lowercase hex digits. A ref name must pass Git's `check-ref-format` rules and lie under
`refs/heads/`. It is resolved from its loose file, else from `packed-refs` (header line, `<oid>
<name>` lines, `^<oid>` peel lines; at most 16 MiB and 100,000 lines); a loose symref is followed at
most four more hops (Git's limit is five in all). The result must be a commit object; a tag, a
64-digit id (`extensions.objectFormat=sha256`) or a missing object is refused. Only `HEAD`'s ref is
read: other branches are not captured.

**Commits and trees.** A commit's first line must be `tree <oid>`, followed only by `parent <oid>`
lines before any other header; at most 64 parents. Other headers are not parsed. The export walks
every commit reachable from `HEAD`, with the trees and blobs of each (a self-contained bundle needs
them all, `06:74`), up to `maxCommits` and `maxObjects`. A tree entry is `<octal mode> <name>\0<20
bytes>`. **The mode is canonicalised as Git does when it reads a tree** (G1): a regular file becomes
`100755` if the owner's execute bit is set and `100644` otherwise; `120000` is a symlink; `40000`
a directory. A zero-padded mode (`040000`, `0100644`) is refused as `object_corrupt`, reason
`zero_padded_mode`, because W-018's clone refuses it too (G3). `160000` (a submodule) and every
other type is `unsupported_tree_entry`, as in W-018. Names follow the path rules below. Depth is at most
`maxDepth`.

**The committed manifest and `treeDigest`.** The reader produces `TreeBlob`s (`pathBytes`, the
canonical mode, the blob bytes) for `HEAD`'s tree and passes them to W-018's own `treeEntries` and
`computeTreeDigest` (`tree-digest.ts:25-44`), unchanged. The digest is therefore computed by the
same code over the same inputs; what has to be shown is that the inputs are the same, which is the
differential test below. W-018's `assertSymlinksContained` (`paths.ts:76`) is applied to the result,
so a checkpoint never holds a symlink that restore would refuse.

**The index manifest** (`factory-checkpoint-index/1`; SI-34). `DIRC`, versions 2, 3 and 4, at most
64 MiB. Each entry's name length, NUL padding (versions 2 and 3) or prefix compression (version 4:
the strip count may not exceed the previous name's length) is checked; the extended flags only from
version 3. Entries must be strictly ascending by name bytes and stage. Modes must be exactly
`100644`, `100755` or `120000`; `160000` is `submodule`; a stage other than 0 is `unmerged_index`.
Extensions: `TREE`, `REUC`, `UNTR`, `FSMN`, `EOIE` and `IEOT` are skipped by their length and never
honoured; `link` (split index) is `split_index` and `sdir` (sparse index) is `sparse_index`; any
other extension whose name starts with an upper-case letter is optional and skipped, and one that
does not is refused, as Git does. The trailing SHA-1 must verify; an all-zero trailer is Git's
`index.skipHash` and is accepted, recorded as `checksum: 'skipped'`. Stat fields are read and
dropped. The manifest lists each entry's path, mode, blob id and the three flags that change what
restore must do (`assumeValid`, `skipWorktree`, `intentToAdd`). Every blob it names, except the
empty blob of an intent-to-add entry, must be in the object store.

**The working-tree manifest.** `work/main` is walked as described under file access. Regular files
become `100755` or `100644` by the owner's execute bit alone (C9); symlinks become `120000` with the
link's bytes as the blob and are never followed; FIFOs, sockets and devices are never opened and
are listed as `excluded: special_file`. A directory whose name folds to `.git` below the root is not
entered and is listed as `excluded: nested_git`. The fixed exclusions of D34 apply. Each file is
hashed as raw bytes (`06:114`). The manifest's `files` are `FileSnapshot`s: one per file and
symlink, and `kind: 'deleted'` for every index path that is absent from the tree, whose `sha256` is
the SHA-256 of the blob the index records for that path (the bytes that were deleted). The source
digest is `computeTreeDigest` over the present files **after** D34's exclusions, that is over what
is captured, so that a candidate frozen from the captured tree has `treeDigest` equal to it.

**Where each recorded digest lives** (review, Livia 14). `CheckpointManifest` carries `headCommit`
and `sourceDigest`. Everything else that restore checks is in the index manifest: `headTreeDigest`
(the committed manifest's `treeDigest`), `indexDigest` (`canonicalHash` of the entries and their
flags), and three ids the builder adds after it has written them (the index tree, the working-tree
tree and the two synthetic commits).

**Path rules** (`path-rules.ts`), the same for tree entries, index entries and directory names:

- a path is well-formed UTF-8 (W-018's decoder: fatal, BOM kept), at most 4,096 bytes and 256 components; all paths of one manifest at most 8 MiB together;
- no component is empty, `.` or `..`, and none contains NUL, `/` (inside a tree name) or a backslash (D28);
- no component is `.git` after removing the code points HFS+ ignores, ASCII case folding, and stripping trailing dots and spaces, and none is `git~1` (Git's own `verify_path` with `core.protectHFS` and `core.protectNTFS`);
- `.gitmodules`, `.gitattributes`, `.gitignore` and `.mailmap` may not be symlinks, under the same folding;
- a leading `-` or `:`, and LF or CR inside a name, are legal in Git and are kept. They are made harmless where a path meets Git: on stdin, NUL-separated, with literal pathspecs (rule 8; review, Furio M1);
- paths that differ only by case or Unicode normalisation are legal on Linux and are kept; the manifest counts them, and a restore on a host that folds refuses them through W-018's `assertNoFoldedCollisions` (`paths.ts:130`).

**Limits** (`ReaderLimits`, every one configurable downwards only by the child's arguments):

| Limit | Default | Why that number |
| --- | --- | --- |
| `maxObjectBytes` | 32 MiB | W-018's `maxBlobBytes` |
| `maxObjects` / `maxCommits` | 500,000 / 100,000 | A self-contained bundle carries the whole history |
| `maxPackFiles` / `maxPackBytes` | 64 / 1 GiB on disk, **all packs together** | Bounds the trailer hashing |
| `maxWorkBytes` | 4 GiB | Bytes inflated plus bytes written by deltas, re-inflation included |
| `maxDeltaDepth` | 512 | Ten times Git's default; Git's own maximum is 4,095 |
| `maxEntries` | 50,000 each for tree, index and working tree | W-018's `maxEntries` |
| `maxPathBytes`, `maxDepth`, `maxTotalPathBytes` | 4,096, 256, 8 MiB | W-018's |
| `maxTotalBytes` / `maxUniqueBytes` | 512 MiB / 256 MiB | W-018's |
| Index, `packed-refs`, a ref file | 64 MiB, 16 MiB, 4 KiB | |
| `deadlineMs` | 10 minutes | Checked before every object and every file |

A limit that binds is a typed refusal naming the limit. Nothing is truncated, sampled or skipped to
fit.

**Interface** (exported from `@factory/workspace/git-reader`, a new subpath; the package index does
not re-export it):

```ts
openCandidate(mountRoot: Buffer, target: { orgId: string; workspaceId: string; generation: number }, limits?: Partial<ReaderLimits>): CandidateReader
                                                // the walk starts at mountRoot and lstats every component to g<n> (Furio L2)
reader.snapshot(): Promise<CandidateSnapshot>   // head, committed manifest and treeDigest, index manifest, working-tree manifest, counts
reader.exportPack(out: string): Promise<ExportSummary>
                                                // HEAD's closure, the index's blobs, the working tree's blobs, each verified once,
                                                // written as one pack with no deltas (version 2, its own trailer) to a file that must not exist
class ReaderError extends Error { code: ReaderErrorCode; file?: string; limit?: string }
```

`ReaderErrorCode` is a closed list. A refusal names the file relative to the generation directory
and the rule; it never carries more than 64 bytes of content, as hex. Any exception that is not a
`ReaderError` is a bug, and the fuzz tests treat it as a failure.

**Tests (20a, `packages/workspace/test`).** Real Git builds every fixture in a temporary directory;
the reader reads it; Git reads it again as the oracle. Git is run on the fixtures by the tests only,
never by the reader. **Every hostile case has its positive control: the same fixture, unmodified,
reads and matches Git.**

| Test file | Shows |
| --- | --- |
| `w020-reader-objects.test.ts` | Loose objects, and packs after `git gc`, `git repack -a -d --depth=50` and `--depth=400`, both offset and reference deltas: every object equals `git cat-file --batch`. Refused, each with its own code: a body byte changed and recompressed (SHA-1), 12 bytes after the zlib stream (Z1), a stream cut short, a preset dictionary, a header size one too large, a 1 KiB file that inflates past the cap, a wrong idx trailer, a wrong pack trailer, a wrong CRC-32, an offset delta pointing forward and one outside the pack, a reference-delta cycle, a copy outside the base, opcode 0, depth 513, entry type 5, an idx of version 1, a zero-padded tree mode. **Control:** depth 512 reads, and a packed empty blob and empty tree read (Z4). |
| `w020-reader-tree-digest.test.ts` | **The differential test.** For a corpus (W-018's committed vector; G1's `100664` and `100775` trees; an unsorted tree written with `--literally`; 256-deep paths; names with a BOM, combining marks and case-only differences; an empty file; a symlink), the reader's `treeDigest` equals W-018's `readTree` plus `computeTreeDigest` on the same commit, byte for byte. A submodule entry, a non-UTF-8 name and a non-UTF-8 symlink target are refused by both with the same code, and a zero-padded tree by both (G3). Any case W-018 accepts and the reader refuses is listed in the file by name; the target is none. |
| `w020-reader-index.test.ts` | Indexes written by real Git: versions 2, 3 and 4 (`update-index --index-version`), `add -N`, `--skip-worktree`, `--assume-unchanged`, a 5,000-byte path, `index.skipHash`. Entries and flags equal `git ls-files -s` and `ls-files -t -v`. Refused: a merge conflict (stage 1 to 3), `--split-index`, a sparse index, unsorted entries, a duplicate, a bad checksum, an unknown lower-case extension, a version 4 strip count past the previous name. **Control:** an unknown upper-case extension is skipped. |
| `w020-reader-refs.test.ts` | Loose ref, packed refs after `pack-refs --all`, detached `HEAD`, a symref chain of five reading and six refused, `HEAD` naming a tag refused, a `reftable` repository (`init --ref-format=reftable`) refused, a ref name with `..` refused, a malformed and an oversized `packed-refs` refused. **A FIFO planted as `worktrees/main/HEAD`, `index`, `packed-refs`, a `.idx` and a `.pack`** is refused without blocking (each under a 5 s limit). |
| `w020-reader-worktree.test.ts` | Binary files, the execute bit taken from the owner bit only (a 0710 file is `100755`, a 0670 one `100644`), a contained symlink kept as data, an escaping one refused, a directory symlink listed and not entered (**control:** the real directory is entered), a FIFO listed as excluded and never opened (the test would hang otherwise, so it runs under a 5 s limit), a socket excluded, a nested `.git` directory excluded, a 0000 file refused as `unreadable`, an inode swapped between `lstat` and `open` (a test hook) refused, each cap at its limit and one past it, **a working-tree name that is not UTF-8** refused before any `lstat` of it. Deleted index paths appear as `kind: 'deleted'` with the index blob's SHA-256. The source digest of a clean checkout equals its commit's `treeDigest`. |
| `w020-reader-hostile-metadata.test.ts` | AC-230's material at the library level. The repository is planted with `core.fsmonitor`, `core.hooksPath`, filter, textconv and diff drivers, `.gitattributes` and `info/attributes` naming them, every hook, an alternate holding objects that were then pruned locally, `info/grafts`, a replace ref swapping a blob, `commondir` and `gitdir` files pointing elsewhere, and a `shallow` file. **Control:** `git status`, `git diff` and `git log` run directly in the planted repository write the canary and show the replaced blob, so the fixtures are live. The reader writes no canary, its digests equal those of the unplanted repository, and the alternate's objects are `object_missing`. |
| `w020-reader-layout.test.ts` | **A symlink at each fixed component** (`factory`, the organization, the workspace, `g<n>`, `git`, `.git`, `objects`, `objects/pack`, `worktrees/main`, `work`, `main`), each pointing at a complete repository elsewhere: each is `path_unsafe` and nothing outside the claim's root is opened (an `fs` spy). **Control:** the real layout reads. |
| `w020-reader-limits.test.ts` | Each limit binds, at its value and one past it: `maxWorkBytes` with a pack whose 512-deep chain of 20-byte deltas each copies 32 MiB (review, Furio M2); `maxPackBytes` with three packs that together pass it though each is under it; `maxObjects`; `maxCommits`; `deadlineMs` with a delay hook between objects. The resident memory of the run on the largest legal fixture stays under 512 MiB. **Control:** one under each limit reads. |
| `w020-reader-paths.test.ts` | Each path rule, through a tree entry, an index entry and a directory name: `.GIT`, `.git ` and `.git.`, `git~1`, `.g` followed by U+200C and `it`, `..`, an empty component, a backslash, a symlinked `.gitmodules`. **Control:** `.github`, `git`, `.gitx` and `a.git` are accepted. |
| `w020-reader-fuzz.test.ts` | Fixed-seed mutation fuzzing with a small generator in the test (no dependency): 2,000 mutations each of a loose object, an idx, a pack, an index, `packed-refs`, a tree and a commit (bit flips, truncation, insertion, length fields set to extremes). Every case ends in a `ReaderError` or in output equal to Git's reading of the same bytes; none throws anything else, none takes more than 2 s, and the process's resident memory grows by less than 256 MiB over the run. **Control:** with the trailing-data check switched off (a test switch) the run finds a case that is accepted wrongly, so the fuzzing can find a bug of that kind. |
| `w020-reader-structure.test.ts` | No file under `src/git-reader/` imports `node:child_process`, `node:worker_threads`, `../git.ts` or `node:fs` except `fs-safe.ts`. **Control:** a planted import in a temporary copy is reported. |

### 7.4 Checkpoints (20b)

**The parts, and where each runs.**

| Part | Runs in | Touches |
| --- | --- | --- |
| Finalize request | The supervisor (sender), the pod listener (route) | One new route on the existing listener; the allocation row and the intent record. |
| Harness-exit wait (D37) | The reconciler's `running` pass | One record per allocation. |
| `passFinalizing` | The runner process | Postgres, the `KubeApi` port, the proof and quarantine records of W-019, the child rows. |
| Child admission and rows | The runner process, under the parent's lock | `checkpoint_job`, existing columns and grants only. |
| `read` (the child's init container) | `factory-checkpoint` image, uid 10001, the claim read-only, no credential | The reader (20a), and `/export`, which only it writes. |
| `build` (the child's main container) | Same image, uid 10003, the identity token, **no workspace mount** | `/export` read-only, `/work` (its own), real Git through W-018's `GitRunner`, the checkpoint listener. |
| Checkpoint listener and child guard | The runner process, a second port | Token review on its own budget, the child and parent rows, `ArtifactService`. |
| Acceptance (`StageFinalizer.finalize`) | The runner process | One transaction over stage run, workspace, allocation and child; objects put before it. |

**The finalize request.**

- **Offered, not assumed** (C23, C24). A grant (acquire or renewal) carries `finalizeOffered: true` only when the allocation has a workspace and the runner's `finalizeRequestWaitSeconds` is above 0. The supervisor cannot read the runner's configuration, so the runner tells it.
- **Sender.** When a grant reports the harness `terminated` (`heartbeat.ts:92`) **and** offered finalize, the supervisor sends one `POST /pod/v1/finalize` with `{ orgId, allocationId, epoch }`, retrying transport errors, `throttled` and the retryable `not_finalizable` (`suspect`) until its fence time. From the moment it has sent it, **any final answer takes the `ending` path** without a stop acknowledgement: the grant, `not_renewable` with `finalizing`, and also `not_this_job`, which is what a retry gets once the pass has begun deleting the pod (C17; review, Livia 10). Without the offer it sends nothing and the stop is W-019's. In M2 this is the only trigger; W-075's `submit_result` is the next one.
- **Route** (pod listener, the 16 KiB body, the admission order of section 6 unchanged). `review(req, { audience, subjects, bucket })` with the authoring profiles' accounts as `subjects`, **never the checkpoint account** (X2). Guard need `NEED_FINALIZE`: states `running` and `finalizing` (the repeat); not claimable; workspace clause `writer_active`, its denial mapped to `stale_epoch` (C22). The pod read must show the `harness` container `terminated`, the cluster's statement and not the pod's (rule 5). Denials: `not_finalizable` with reason `harness_running`, `suspect` (retryable, C20) or `no_workspace` (C23).
- **Locked statement.** In one transaction under the allocation's row lock: `transitionAllocation` from `running` to `finalizing` with `leaseUnexpired: true` (the lease clause W-019 handed over: `allocation.ts:145`, `:159`) and `leaseSeconds: finalizeDeadlineSeconds`, so `controller_lease_until` becomes the finalize deadline; and the **intent record**, an `audit_event` at a deterministic id from `factory-finalize-intent/1`, organization and allocation, written by D18's rule, holding the pod UID, the harness exit code read from the pod (a diagnostic, D30), and nothing from the request. An expired lease answers `lease_expired` and writes nothing but the capped denial.
- A repeat while the pod still exists finds the row `finalizing` with this pod's intent and answers `{ finalizing: true }`, writing nothing.
- `PermitDenialCode` gains `not_finalizable`, and `PermitGrantAnswer` the optional `finalizeOffered`; the vectors and the status mapping (409) change with them.

**The harness-exit wait (D37).** Today the `running` pass stops a pod at once when its harness has
exited (`reconcile.ts:322`). From 20b, when the pass sees the harness `terminated`, finalize was
offered (a workspace, the wait above 0), the allocation has a start record and the supervisor
container is still running, it writes a `factory-harness-exit-seen/1` record the first time, and
moves to `stopping` with `harness_exited` only once that record is older than
`finalizeRequestWaitSeconds` (default 20, two beats; age judged in SQL on `clock_timestamp()`). A
supervisor exit still stops at once. With the wait at 0 nothing is offered and the pass behaves as
in W-019, which is how W-019's own files run (edits table).

**The `finalizing` pass** (`passFinalizing`; `finalizing` joins the work list, `allocation.ts:119-121`).
Each pass, in order:

1. **Stop and prove.** As steps 1 and 3 to 4 of the `stopping` pass, with no hold: the intent is the acknowledgement. Settle the workspace's first edge, delete the Job and every pod, list, evaluate. Proved: `prepare`, then `registerProof`, which now accepts `finalizing` (C2). Not proved while the row has been `finalizing` for less than `stopDeadlineSeconds` (`sinceUpdateMs`; nothing else writes the row in this state): wait. Past it: `quarantine` with source `finalizing`, which refuses when a proof exists (rule 6).
2. **Settle on the proof.** `settleWorkspace(a, 'proof')`: the workspace goes `quiescing → retained`.
3. **Give up**, when any of these holds: the finalize deadline has passed (`leaseExpired`); `maxAttempts` attempts have ended without acceptance (D31); the latest child is `quarantined` (it holds the one live slot for good, SI-40); the stage run has an urgent stop record (D29). **First the live child, if any, is ended** (review, Livia 6): its Job and pods are deleted and proved gone as in step 5, and the row moves to `failed`, or to `quarantined` if its pods cannot be shown gone by `stopDeadlineSeconds` after the delete. Only then `finalizing → stopping` with the reason, and the `stopping` pass, which finds the proof, ends `terminated`. The workspace keeps the `checkpoint_ref` it had, or none: the work since the last accepted checkpoint is lost, as `06:76` allows. A child that ends `quarantined` here leaves the claim `in_use` for `volumeDisposition` (race rule 16) and is W-024's obligation, with its record.
4. **Admit a child**, if no child is live:
   - `volumeDisposition` must answer `quiescent` (C1), and a fresh list of the namespace **without a selector** must show no unfinished pod naming the claim (W-019's hand-off: the proof is a past observation).
   - Under the parent's row lock (`FOR UPDATE`): `finalizing`, generation and epoch as read, deadline ahead; insert the child row in `desired` with `id = v8(factory-checkpoint-job/1, org, allocation, attempt)`, `receipt_id = v8(factory-checkpoint-receipt/1, org, allocation, attempt)`, `job_name = checkpointJobName(org, receipt_id)`, the parent's generation and epoch, the namespace and `identity_audience = factory-checkpoint:<childId>`. `one_live_checkpoint_job` makes a second insert fail; the loser re-reads.
   - Commit; then create or fetch the Job (rule 1), validated as W-017 validates an allocation Job (identity annotations and the whole template); `desired → starting` with `job_uid`. A foreign Job under the name quarantines the child.
5. **Watch the child.** Its pods are listed by the `checkpoint-job` label. When the Job has failed, the child's deadline has passed, or either container of its pod has exited without the child being accepted: delete its Job and pods, prove them gone as an allocation's are (Job absent, no pod listed), and move it to `failed` with the exit codes and the termination messages' codes, which are recorded and never decide anything. A child whose pods cannot be shown gone by `stopDeadlineSeconds` after its delete is `quarantined`. A `completed` child's Job is left to the sweep (below), so that a retried finalize can still be answered (race rule 11).

**The child's identity** (X2). The account is `profiles.checkpoint.serviceAccount` (default
`factory-checkpoint`), W-021's reserved profile key; there is no other key for it. It has no Role.
Its token is projected into the `build` container only, audience `factory-checkpoint:<childId>`,
600 s, and `build` reads the file on every call, as the supervisor does, so the kubelet's rotation
is picked up. The checkpoint listener calls the generalised `review(req, { audience, subjects,
bucket })` (`pod-guard.ts:96-140`) with `subjects` = `{ system:serviceaccount:<namespace>:<profiles.checkpoint.serviceAccount> }`
and its **own** review bucket (`checkpoint.review`: 5 a second, burst 10), so children never spend
the authoring pods' budget and W-021's ceiling product can count it (X4). Inside the control plane
the child acts as `config.checkpoint.identity`, a service identity distinct from the runner's and
the supervisor's, and only through a `ChildBinding` that the child guard alone can mint (a
`WeakSet`, as `controller-record.ts:22`). An authoring supervisor's token fails the checkpoint
review (subject and audience); a child's token fails the pod listener's review (subject); the
harness has no token at all (AC-231).

**The child Job** (`renderCheckpointJob`, pure, from the parent row, the child row, the workspace
row and config). **This is the shape W-021's admission is written to accept**, and nothing else:

| Item | Exactly |
| --- | --- |
| Job | name `checkpointJobName(org, receipt_id)`; `backoffLimit: 0`; `activeDeadlineSeconds: checkpoint.childDeadlineSeconds`; no `manualSelector` |
| Labels (Job and template) | organization, task, the parent allocation, workspace, generation, `<prefix>profile: checkpoint`, `<prefix>checkpoint-job: <childId>` |
| Annotations | the full ids, the parent's epoch, the receipt, the manifest digest |
| Pod spec | `restartPolicy: Never`; `serviceAccountName: profiles.checkpoint.serviceAccount`; `automountServiceAccountToken: false`; `shareProcessNamespace: false`; `enableServiceLinks: false`; grace 15 s; `securityContext`: `runAsNonRoot`, `seccompProfile: RuntimeDefault`, **no `fsGroup`** (C9) |
| Init container `read` | image `images.checkpoint` (`factory-checkpoint`, by digest outside the local tier); args `read ...`; uid and gid 10001; read-only root, no privilege escalation, all capabilities dropped; `terminationMessagePolicy: File`; resources `profiles.checkpoint.resources.read`; mounts `workspace` at `/workspace` **read-only**, `export` at `/export`, `read-tmp` at `/tmp`. No identity. |
| Container `build` | the same image; args `build ...`; uid and gid 10003; the same security context; resources `profiles.checkpoint.resources.build`; mounts `export` at `/export` **read-only**, `work` at `/work`, `build-tmp` at `/tmp`, `factory-identity` at `/var/run/factory-identity` read-only. **No workspace volume.** |
| Volumes | `workspace`: the generation's claim, `persistentVolumeClaim.readOnly: true`; `export`: `emptyDir`, `sizeLimit` 4 GiB; `work`: `emptyDir`, 6 GiB; `read-tmp`, `build-tmp`: `emptyDir`, 256 MiB; `factory-identity`: projected, a `serviceAccountToken` (audience `factory-checkpoint:<childId>`, 600 s, path `token`) and the listener's CA ConfigMap, as section 6 |
| Resources (defaults, sized from 7.3) | `read`: requests 500m CPU and 768 MiB, limits 2 CPU and 1 GiB (the reader's peak is under 512 MiB); `build`: requests 500m and 1 GiB, limits 2 CPU and 2 GiB (`index-pack` over up to 500,000 objects); ephemeral storage as the volumes |

So the one process that reads the candidate's tree holds no credential, and the one that holds the
credential never has the tree, nor anything `read` wrote except through a read-only mount (D33;
review, Furio M5, Livia 9).

**`read`** runs the reader under `node --permission` (7.3) from the claim's mount root, writes the
export pack to `/export/objects.pack` and the snapshot to `/export/snapshot.json` (both created
exclusively, mode 0644, under `maxExportBytes` 3 GiB), and ends with a termination message (policy
`File`, under 4 KiB, W-017's measured mechanism) holding the counts, the digests or the
`ReaderErrorCode`.

**The builder** (`build`; Git only through W-018's `GitRunner`, whose environment is built from
nothing, `git.ts:1-7`; `claimFactoryOwned` gains this one caller and its structural test lists it).
**`/export` is untrusted input to the builder**, not factory-owned storage:

1. Create `/work/repo` with exclusive `mkdir` (it must not exist), owner 10003, mode 0700, checked as `homeDirectory()` checks its directory (`git.ts:47-59`); `git init --bare` there. Nothing in `/export` is moved, linked or used as a repository.
2. Open `/export/snapshot.json` and `/export/objects.pack` with the reader's `fs-safe` rules (from the mount root, `O_NOFOLLOW`, regular files only, size caps), parse the snapshot with caps, and stream the pack into `git index-pack --strict --stdin`: Git computes every object id itself, so no planted name survives, and its checks (with collision detection) run on every object (rule 8, G3).
3. Build the index tree: a fresh `GIT_INDEX_FILE` in `/work`, `update-index -z --index-info` from the index manifest (NUL-separated, intent-to-add entries left out), `write-tree`. Build the working-tree tree the same way from the working-tree manifest's present files.
4. Two commits on top of `HEAD`, both written by the factory from server records (`06:84`): the index commit (parent `HEAD`) and the working-tree commit (parent the index commit). Author and committer `Factory Checkpoint <checkpoint@factory.invalid>`, date the intent's time, message a fixed line plus `Factory-Task`, `Factory-Stage-Run` and `Factory-Checkpoint` trailers. The same inputs always give the same commit ids.
5. `refs/factory/checkpoint/{head,index,worktree}`; `git -c pack.threads=1 bundle create` with those three refs and no basis, so a second attempt produces a byte-identical bundle; `assertFullBundle` (`materializer.ts:238`); `git bundle verify` in an empty repository, as W-018 does; `git fsck --no-dangling`.
6. Patches, with `git --attr-source=<empty tree> diff --binary --full-index --no-renames --no-ext-diff --no-textconv` (G2): `HEAD → index` is the staged patch; `index → working tree` is the unstaged patch, and it carries untracked files as additions (SI-37).
7. The handoff, `factory-portable-handoff/1` (SI-36): task, stage run, allocation, generation, epoch, reason `harness_exited`, the harness exit code (a diagnostic), the three commit ids, the Git and reader versions (SI-41), `nativeState: 'absent'` and `narrative: null`. Everything in it is a factory record; nothing is agent text.
8. The `CheckpointManifest` (`schemaVersion` `2.0`): `workspaceId`, `generation`, `ownerEpoch`, `repositoryId`, `baseCommit`, `setupProfileRef` from the arguments; `headCommit` the candidate's `HEAD`; `sourceRef` the bundle; `prerequisiteRefs: []`; the two patch refs; `files` the working-tree `FileSnapshot`s, deletions included; `handoffRef`; `createdAt` the intent's time; `sourceDigest`. `untrackedArchiveRef`, `nativeStateRef` and `sessionBindingRef` are absent. It is validated against the contract before upload.
9. Upload the parts in order (index manifest, handoff, bundle, patches, then the manifest, whose refs are the earlier answers), then call finalize. Exit 0 after the answer; any failure exits non-zero with a code in its termination message.

`gitEnvironment()` gains `GIT_LITERAL_PATHSPECS=1` (`git.ts:85-97`), for every caller of
`GitRunner`, W-018's included: none of them uses pathspec magic, and it closes G4 everywhere.

**Captured and not captured** (D34). Every tracked path is captured as it stands: it is in the
repository's history already, and leaving it out would make restore disagree with the index.
Untracked files are captured except: the root `.git`; nested `.git` directories; special files; a
fixed list of rebuildable directories, matched by exact component name at any depth
(`node_modules`, `.venv`, `__pycache__`, `.pytest_cache`, `.gradle`; `06:70`: dependency caches can
be rebuilt); and a deny list, matched after ASCII case folding, of names never captured (review,
Furio L4): `.env` and `.env.*`; `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`;
`id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519`; `.npmrc`, `.netrc`, `.pypirc`, `.git-credentials`;
`.aws/credentials`, `.docker/config.json`, `.kube/config`. It is an interim measure under A-38 and is
replaced by W-116's scan. Build outputs such as `dist/` or `target/` are captured: telling them from
source needs a rule the factory does not have. Repository ignore files are **not** honoured:
`.gitignore` would need a second pattern parser over candidate data, and `info/exclude` and
`core.excludesFile` are configuration, which rule 8 never reads. The caps of 7.3 bound what a
candidate can add. Each exclusion is listed in the working-tree manifest by path and reason.

**The checkpoint listener** (`src/listener/checkpoint-listener.ts`; D32). Its own port, the same
certificate and CA, and its own server, so its limits never loosen the pod listener's:

- Admission steps 1 to 6 of section 6, with their own buckets: new connections per source as there, **2 open connections per source**, the source charge, local verification, the per-pod bucket and the checkpoint review bucket. In the local tier every pod is one source (A-32), so the per-source numbers there protect nothing and are relaxed by the test configuration; what keeps authoring harnesses off this port is the egress policy (below), not the source cap (review, Furio M3).
- Then the child guard, **unlocked and advisory** (rule 9): the child row by id; `epoch` equal to the parent's; the pod read (same UID, no deletion timestamp, `checkpoint-job` label, owned by the child's Job UID); the child's `pod_uid` equal to the reviewed pod (claimed by `begin`); the parent `finalizing` at the child's generation and epoch. Each writing route then repeats what it needs inside its own statement, in the lock order of rule 9.
- `POST /checkpoint/v1/begin` (JSON, 16 KiB): `starting → running` with `pod_uid`, compare-and-swap from null, under the parent's lock and then the child's. Answers the part caps.
- `PUT /checkpoint/v1/part/{index|handoff|bundle|staged|unstaged|manifest}`: `content-length` required and at most the part's cap (bundle 256 MiB, the artifact service's default upload cap; each patch 128 MiB; index manifest 64 MiB; manifest 32 MiB; handoff 64 KiB), `x-factory-sha256` required. Headers within 5 s; then the body is streamed straight into `ArtifactService.upload` (an `AsyncIterable` of the request) with no transaction open; at least `checkpoint.partMinBytesPerSecond` (1 MiB/s) over any 30 s window, and at most the part's cap divided by that rate plus 30 s in all; one part in flight per child. The runner reserves (`reserve`, actor `config.checkpoint.identity`, the stage run's logical id, the part's cap and media type), uploads, and finalizes with the header's digest and length (`service.ts:214-284`). Then, under the parent's lock and then the child's, it checks the parent is still `finalizing` with an unexpired deadline, and links the artifact with purpose `checkpoint_part/<childId>/<name>`. The same name again with the same digest answers the same ref; with another digest, `conflict`.
- `POST /checkpoint/v1/finalize` (JSON, 16 KiB): `{ orgId, childId, receiptId, epoch, inputHash, checkpointRef, sourceDigest }`, the reference input of `StageFinalizer.finalize` plus the child. **Before any state check**, the route reads `stage_run.result_ref`: if it names a result minted from this child's checkpoint, it returns that result, still requiring this child's reviewed token and its pod (review, Livia 11). Otherwise, acceptance below.
- A route answers first and reconciles after, as on the pod listener: a pass runs after the answer is written, single-flight per allocation.

**Egress to the second port** (X3; review, Furio M3). The local egress file
(`deploy/k8s/local/egress-listener-only.yaml`) keeps its select-all rule exactly as it is, the pod
listener's address and port. W-020 adds a **separate** NetworkPolicy beside it,
`factory-exec-egress-checkpoint-local`, whose `podSelector` is `<prefix>profile: checkpoint` and
whose one allow rule is the checkpoint listener's address and port. W-021 renders the production
twin, `factory-exec-egress-checkpoint`, and its admission ties the profile label to the checkpoint
account, so an authoring pod cannot wear the label.

**Acceptance** (`src/finalizer.ts`, `StageFinalizer.finalize`; D30). Only with a `ChildBinding`
and `ctx.actorId` equal to `config.checkpoint.identity`; anything else is refused and audited (the
authoring supervisor and the harness never hold either).

*Unlocked:*

- `receiptId` must be the child's; `allocationEpoch` the parent's; `inputHash` the stage run's.
- Read the manifest part (`readVerified`, 32 MiB) and validate it as a `CheckpointManifest`. Every ref in it, and the index manifest, must be a part linked to this child (the purpose above, producer `config.checkpoint.identity`). Its row fields must equal the rows: workspace, generation, epoch, repository, base commit, setup profile ref. `createdAt` must equal the intent's time; `prerequisiteRefs` must be empty; `sourceDigest` must equal the input's.
- Mint the `StageResult`: `schemaVersion` `2.0`, organization, task, logical stage run, `inputHash`, `allocationEpoch`, **`status: 'inconclusive'`** (D30: the harness exit code is a diagnostic only, in the handoff and the intent record, until W-075's `submit_result`; accepted by the owner, 2026-11-22), `outputRefs: []`, `checkpointRef`, `usage: []`, `producerId` the runner's identity, `producerKind: 'runner'`, `completedAt` from the Postgres clock. Validate it; put it as a controller object.

*Locked* (one transaction, the lock order of rule 9: stage run, then workspace, then allocation,
then the child; nothing before it held a lock):

- Stage run: if `result_ref` is set and names a result with this checkpoint and this child, return it (a duplicate identical finalization, `06:88`); if it names anything else, `conflict`, audited.
- Workspace: `retained`, at the parent's generation and epoch.
- Allocation: `finalizing`, generation and epoch as the child's, a proof stored; the move to `completed` is a `transitionAllocation` with `leaseUnexpired: true`, so an expired finalize deadline fails **inside the statement** (`06:112`: expired authority is revalidated before acceptance).
- Child: `running`, this pod, this receipt.
- Then: workspace `retained → checkpointed` with `checkpoint_ref` set (rule 10); links of the manifest **and of every part it names, and of the index manifest**, with purposes `checkpoint/<workspaceId>/g<generation>/<part>` (C21); the result registered with purpose `stage_result/<logicalId>`; `stage_run.result_ref` set **only where it is null**; allocation `finalizing → completed` with `terminated_at` and the deadline cleared; child `running → completed`; capacity released; an audit row naming the previous `checkpoint_ref`.
- **With a cancel record for the stage run** (D29), the same transaction stores the checkpoint (workspace, links, child) but writes no result: the allocation goes `finalizing → stopping` with reason `cancelled_after_checkpoint`, then `terminated` with its proof, and `getRun` answers `cancelled` (`states.ts:38`). Acknowledged work survives a cancel; a result does not.

**Release** then works as before, with one more check (C21): `checkpointed` is releasable once its
`checkpoint_ref` is retained (`manager.ts:69`, `:370`) **and** every part linked under
`checkpoint/<workspaceId>/g<generation>/` is retained too.

**`WorkspaceManager.checkpoint(ctx, id, expectedEpoch)`** (SI-35) becomes a read: with the runner
identity, the accepted `checkpoint_ref` of the row at that epoch, or `no_checkpoint`. The manager
still never touches a filesystem; the snapshot is the child's.

**The sweep** (C14). `sweepJobs` gains a second list, by the `<prefix>profile: checkpoint` label. A
child Job is deleted (UID precondition, `Background`) when its child row is `failed`, when no row
records its UID, when its parent is not `finalizing` and the child is not `completed`, or when the
child is `completed` and the acceptance is older than one reconcile interval (so that a retried
finalize can be answered, race rule 11); a `quarantined` child's Job is left for W-024.

**Config added** (`src/config.ts`): `finalizeDeadlineSeconds` 4,200; `finalizeRequestWaitSeconds`
20; `profiles.checkpoint: { serviceAccount: 'factory-checkpoint', resources: { read, build } }`
(W-021's reserved key; no other key names the account); `images.checkpoint`; `checkpoint: {
identity, listener: { host, port, cert, key }, review: { perSecond: 5, burst: 10 },
childDeadlineSeconds: 1,800, partMinBytesPerSecond: 1 MiB, partCaps, maxAttempts: 2, readerLimits
}`. Validation (review, Livia 7):

- `readerLimits.deadlineMs / 1000 + Σ partCaps / partMinBytesPerSecond + 240 (build) + 60 (start) ≤ childDeadlineSeconds`. With the defaults: 600 + 608 + 240 + 60 = 1,508 ≤ 1,800.
- `finalizeDeadlineSeconds ≥ stopDeadlineSeconds + maxAttempts × (childDeadlineSeconds + stopDeadlineSeconds) + 60`. With the defaults: 180 + 2 × (1,800 + 180) + 60 = 4,200.
- The checkpoint identity differs from the runner's, from every control-plane identity and from every profile's account; `profiles.checkpoint.serviceAccount` is in no other listener's subject set; `maxAttempts` at most 2; the listener on a named address, TLS, as the pod listener's.

### 7.5 Restore (20c)

**What restore means here, and what it does not.** A workspace row belongs to one stage run: W-018
compares `stageRunId` on attach (`manager.ts:228`) and the allocate step refuses a workspace of
another stage run (`start.ts:87`). So the only restore the code can express today is **the same
row, at a new generation**: `replaceWriter` on a row with a `checkpoint_ref` answers
`restore_required` (`manager.ts:320`), and the new generation must be rebuilt from that checkpoint.
That is what 20c builds. **No runner path reaches it in M2** (review, Livia 2): acceptance completes
the stage, after which `startOrAttach` returns the handle (`start.ts:69`) or, after a cancel,
`run_cancelled` (`:70`), and there are no mid-stage checkpoints (P-30), so nothing calls
`replaceWriter` on a checkpointed row except a test. 20c is therefore **restore mechanics**, logged
as material for AC-13 and AC-16, not as their claim. How a *later* stage run starts from an
earlier one's checkpoint (`06:76`: replay from the last acknowledged boundary; `06:39`: one clone
per task and repository) is a binding between two workspace rows that neither the spec's interface
nor this plan defines. It is **open question O1** (7.10), and it is W-023's caller that needs it.
The mechanics below do not depend on the answer; the claims do.

**The request.** `requestInTx` answers `{ kind: 'restore', target, checkpoint, branch? }` for an
`allocated` row with a `checkpoint_ref` and no accepted receipt, in place of `restore_unavailable`
(C10); `probe` answers `ready`; the allocate step no longer refuses such a workspace (`start.ts:89`).
In a pod the request is still refused, as `not_supported_restore_source`, beside the `bundle` kind
(`reconcile.ts:191`): a pod cannot read an artifact yet (D13, D36; W-021's D48 gives that read to W-022).

**`WorkspaceManager.restore(ctx, checkpointRef, generation, ownerEpoch)`** (SI-35). Runner identity,
task-scoped caller. Unlocked: read the manifest (`readVerified`, 32 MiB) and validate it as a
`CheckpointManifest`. Locked, on the row `manifest.workspaceId`: the row's `checkpoint_ref` equals
`checkpointRef` (artifact id and digest); `generation` and `ownerEpoch` are the row's and the
manifest's generation is older; the state is `allocated` with no accepted receipt; repository, base
commit and setup profile ref equal the manifest's. It returns the record and touches no
filesystem: the manager never does (W-018). `LocalWorkspaceHost.ensureRestored` calls it and then
`ensureMaterialized`, which now handles the `restore` kind.

**`LocalMaterializer`, restore kind** (`#fromCheckpoint`, in the one staging path, as every kind):

1. The host supplies the bytes: the bundle (at most 256 MiB), both patches (128 MiB each) (`readVerified`, C18) and the index manifest (found by its `checkpoint/.../index` link), read under the caller's own scope, as `readCandidateSource` does (`manager.ts:130-138`).
2. `assertFullBundle`; `git init`; `git bundle verify`; fetch `+refs/factory/checkpoint/*:refs/factory/checkpoint/*` with object checks on. `refs/factory/checkpoint/head` must be the manifest's `headCommit`.
3. W-018's `#digest` of `HEAD` (limits, symlink rule, folding on macOS), then its `#checkout` onto the row's branch (or detached when the row has none), with `FACTORY_ATTRIBUTES` in `info/attributes` and `verifyCheckout` (`materializer.ts:162-171`, `:216-235`).
4. `git apply --index --binary` of the staged patch, which changes the index **and** the working tree, so that the working tree then matches the index (review, Furio L5: with `--cached` the unstaged patch, whose base is the index, would meet a working tree still at `HEAD`); `git write-tree` must equal the index manifest's index tree. Then `git apply --binary` of the unstaged patch, in the working tree only. Then the flags, **with every path on stdin, NUL-separated** (rule 8, G4): `update-index -z --stdin --skip-worktree`, `update-index -z --stdin --assume-unchanged`, and `add --intent-to-add --pathspec-from-file=- --pathspec-file-nul` for intent-to-add entries. `GIT_LITERAL_PATHSPECS=1` is in every call's environment (7.4), so a path such as `:(glob)*` names only itself, and no path is ever an argument, so `--pathspec-from-file=/...` cannot be one. The patches name their paths inside the patch text, which `git apply` reads as data.
5. **The proof that it reproduced the checkpoint.** The reader of 20a is run on the staging directory, which has exactly the factory's layout and which no candidate has touched: its `HEAD` must be `headCommit`, its `treeDigest` the index manifest's `headTreeDigest`, its `indexDigest` the index manifest's, and its source digest the manifest's `sourceDigest` (7.3, "Where each recorded digest lives"). `git rev-parse HEAD` and `git write-tree` are checked as well, so the reader is not the only witness. Any difference is `restore_mismatch` and nothing is renamed into place.
6. Rename into place. The receipt (`factory-workspace-restore/1`) holds the generation, `headCommit`, `treeDigest`, the Git version, the checkpoint's artifact id, the index and source digests, and three fields that say what was not done: `nativeState: 'absent'`, `fallback: 'portable_handoff'`, `setup: 'not_rerun'`.

**Acceptance of a restore receipt** is `acceptInTx` with the restore's expectations, read before the
lock from the manifest and the index manifest: the commit, both digests and the checkpoint's id.
With C16 the receipt object is put before the lock. The same receipt again is `unchanged`.

**AC-16's record.** Accepting a restore receipt also writes an audit row,
`workspace.restore_fallback`, with `{ nativeState: 'absent', used: 'portable_handoff' }`. No native
session exists before W-077 (A-36), so the fallback is always taken. The record is what AC-16 asks
for, and it is material only until a resuming task can reach a restore (O1).

**Not done by restore:** the setup profile is not rerun (`06:82`). There is no local executor for
setup recipes, by W-018's design (setup is candidate code and runs only in the sandbox), so the
first writer of the restored generation runs it. SI-39.

### 7.6 Race and crash rules

1. **Finalize against cancel.** A cancel takes the stage run's lock, then the allocation's (`start.ts:172`, `:185`). If it commits first (`running → stopping`), the finalize statement finds `stopping`, answers `not_renewable` with `stopping`, and the supervisor, having sent finalize, ends (C17); no checkpoint (D29). The finalize route takes only the allocation's lock, so it cannot meet cancel's lock order the other way round (rule 9). If finalize commits first, the cancel finds `finalizing`, writes its record and nothing else (`start.ts:186`); the checkpoint is stored at acceptance and the result is not.
2. **Finalize against the lease, and against the harness-exit wait.** Both stops are `move` compare-and-swaps from `running` (`reconcile.ts:38-50`), and finalize is a compare-and-swap from `running` with the lease clause in the statement. One commits; the other changes nothing. A finalize that meets `suspect` is retryable and wins on the next beat, unless the lease stop wins first (C20).
3. **Two controllers in `finalizing`.** The child insert is fenced by `one_live_checkpoint_job`; the Job name is deterministic, so the second create is `AlreadyExists` and is validated, not attached blindly; the proof is registered once (W-019 rule 6).
4. **A crash between the child row and its Job, or between the Job and its UID.** The next pass creates or fetches by name and binds, as `passDesired` does for an allocation.
5. **Two pods for one child Job.** `begin` claims `pod_uid` by compare-and-swap; the other pod is refused at the guard and deleted by the pass. Both mount the claim read-only, so the loser cannot have changed anything.
6. **A part uploaded, the runner dies before the link.** The artifact exists with its `stage_output` link and nothing else. It is not a checkpoint (rule 10). The child's retry uploads again; the artifact service registers the same digest once (`service.ts:259-271`) and the link is written then.
7. **The child dies after uploading.** The attempt fails once its pod is shown gone. The second attempt builds commits with the same ids (fixed identity and date), so its bundle and patches have the same digests and dedupe.
8. **Acceptance crashes after the result object is put.** The object is an orphan for the artifact sweep. A retry mints a result with another `completedAt` and commits it; there is never more than one `result_ref`.
9. **A stale child returns.** Attempt 2 is admitted only after attempt 1's pods are shown gone (7.4, step 5), so a stale child can only be a late request carrying attempt 1's identity: its pod no longer exists, so the guard's pod read refuses it even inside the API server's short cache of a successful review (section 2), and its row is `failed`, so the row check refuses it too. Neither reaches acceptance (AC-206's material).
10. **The finalize deadline passes during acceptance.** The `completed` move carries the deadline in its own statement; it changes nothing and acceptance rolls back whole. The pass then gives up.
11. **Acceptance repeated after its commit.** The finalize route checks `result_ref` before any state check (7.4), so while the child's pod exists the retry gets the stored result (`06:88`). The sweep leaves a completed child's Job for one reconcile interval for this. A retry later than that is refused at the pod read; the result is stored either way, and the child's non-zero exit is ignored because its row is `completed`.
12. **The worker writes `result_ref` first** (today's `persistence.ts:41`). Acceptance writes only where it is null, so it fails as `conflict`, audited, and the parent gives up at its deadline. W-023 must make that impossible (hand-off).
13. **The object store is down.** No part, no acceptance: the attempt fails, the second fails, and the parent goes to `stopping` and then `terminated` with its proof. The work since the last accepted checkpoint is lost, in the safe direction (as W-019 rule 9).
14. **The runner restarts mid-upload.** The child sees a broken stream and retries the part; the abandoned reservation expires and `sweepExpiredUploads` removes its object.
15. **A renewal or `stop-ack` in `finalizing`.** A renewal is `not_renewable` with `finalizing` (C17); `stop-ack` is for `stopping` only and is refused.
16. **A parent that gives up with a child live.** The child is ended first (7.4, step 3), so no `starting` or `running` row outlives its parent, `one_live_checkpoint_job` is freed, and the claim is not left `in_use` for ever (review, Livia 6).
17. **A compromised `read`.** It can write anything into `/export`: a symlink, a file larger than its cap, a pre-made Git repository, a forged snapshot. `build` never follows a symlink there (`fs-safe` rules), never uses anything there as a repository (its own exclusive `/work/repo`), lets Git compute every object id (`index-pack --strict`), and parses the snapshot under caps. The worst it can do is make the checkpoint fail or describe a tree that restore's proof then refuses (review, Furio M5).
18. **A quarantined child.** It holds `one_live_checkpoint_job` for good. The parent gives up (7.4, step 3), and `volumeDisposition` answers `in_use` for the claim while a child is live or quarantined, so W-024 does not delete a claim a lingering child pod may still mount.
19. **Restore, crash between rename and accept.** As in W-018: the host finds the target with no receipt under the row lock, removes it and starts again.
20. **Restore against a newer checkpoint.** `restore` and the receipt's acceptance both compare `checkpoint_ref` under the row lock; a checkpoint accepted in between makes the first one's restore `conflict`.

### 7.7 Files

| File | Content | Commit |
| --- | --- | --- |
| `packages/workspace/src/git-reader/{index,limits,errors,fs-safe,inflate,loose,pack,delta,objects,commit,tree,refs,index-file,worktree,path-rules,reader}.ts` | The reader (7.3). | 20a |
| `packages/workspace/package.json` | Exports `./git-reader` and `./checkpoint-build`; the package index re-exports neither. | 20a, 20b |
| `packages/workspace/src/checkpoint-manifest.ts` | The index and working-tree manifest types (`factory-checkpoint-index/1`, `factory-checkpoint-worktree/1`), the handoff (`factory-portable-handoff/1`), part names and caps, the purposes, and their validators. | 20a |
| `packages/workspace/src/checkpoint-build.ts` | The builder (7.4): its own exclusive repository, `index-pack --strict` from the export, commits, bundle, patches, handoff, manifest. The third caller of `claimFactoryOwned`. | 20b |
| `packages/workspace/src/git.ts` | `GIT_LITERAL_PATHSPECS=1` in `gitEnvironment()` (G4). | 20b |
| `packages/workspace/src/manager.ts`, `packages/database/src/workspace.ts` | Release also requires every part linked under the checkpoint's purpose to be retained (C21). | 20b |
| `packages/workspace/src/quarantine-record.ts`, `src/volume-disposition.ts`, `src/index.ts`, `README.md` | `finalizing` as a source; the `finalizing` row and the optional `checkpointChild` input (C1, race rule 16); exports; the reader, the builder, rules 8 to 10, the captured and excluded lists. | 20b |
| `packages/workspace/src/manager.ts`, `src/materializer.ts`, `src/local-host.ts` | The `restore` request kind and `probe`; `restore` and `checkpoint` (SI-35); the receipt put before the lock (C16); `#fromCheckpoint` and its receipt; `ensureRestored`. | 20c |
| `packages/runner-protocol/src/pod-api.ts`, `src/checkpoint-api.ts`, `test/vectors.json` | The finalize route, `not_finalizable` and the grant's `finalizeOffered`; the checkpoint routes, parsers, part names and caps. | 20b |
| `packages/database/src/allocation.ts`, `src/checkpoint-job.ts`, `src/workspace.ts`, `src/index.ts` | `finalizing` in the work list; a record-age read on `clock_timestamp()`; `setStageResultOnce` (only where null); child rows (insert, lock, guarded transitions, list by parent) on the existing grants; a plain `linkArtifact`. | 20b |
| `apps/runner/src/listener/pod-listener.ts`, `src/listener/checkpoint-listener.ts`, `src/pod-guard.ts`, `src/child-guard.ts` | The finalize route; the second listener, its limits and its review bucket; `review(req, { audience, subjects, bucket })` (X2), the pod listener's subjects never including the checkpoint account; `finalize` in the `stale_epoch` branch (C22); the child guard and `ChildBinding`. | 20b |
| `apps/runner/src/finalize-request.ts`, `src/finalizer.ts`, `src/checkpoint-job.ts` | The route's service; `StageFinalizer.finalize` and acceptance; `renderCheckpointJob` and its validation. | 20b |
| `apps/runner/src/reconcile.ts`, `src/records.ts`, `src/names.ts`, `src/states.ts`, `src/config.ts`, `src/main.ts`, `src/runner.ts`, `src/index.ts` | `passFinalizing`, the harness-exit wait, `registerProof` and `toQuarantined` for `finalizing`, the child sweep; the intent and exit-seen records; child, receipt and record ids; nothing in the edge table (`running → finalizing` and the three edges out of `finalizing` exist; finalize uses no other, C20); `profiles.checkpoint`, `images.checkpoint`, the new settings and the two budget checks; the second listener; the finalizer on the service. | 20b |
| `apps/runner/src/checkpoint-pod/{read-entry,read-run,build-entry,build-run,client}.ts` | The two container entries and the child's client. The production entries read no environment variable. | 20b |
| `apps/runner/src/start.ts`, `src/reconcile.ts` | `start.ts:89` removed; the `restore` kind refused in a pod. | 20c |
| `apps/supervisor/src/heartbeat.ts`, `src/runner-client.ts`, `src/state.ts` | The finalize call on a `terminated` harness when the grant offered it; after it is sent, any final denial takes the `ending` path. | 20b |
| `packages/test-support/src/faults.ts` | `runner.after_finalize_intent`, `before_child_job_create`, `after_child_job_create`, `after_part_finalize`, `before_part_link`, `after_result_put`, `before_acceptance_tx`, `workspace.after_restore_rename`. | 20b, 20c |
| `deploy/images/checkpoint`, `deploy/k8s/checkpoint-sa.yaml`, `deploy/k8s/local/egress-listener-only.yaml`, `scripts/k3s.sh` | The image (Node, tini, Git 2.48 or later, the two entries, a numeric user; built from a staged context of named files as section 6's images are); the service account with no Role; the local policy file keeps its select-all rule unchanged and gains a **separate** policy, `factory-exec-egress-checkpoint-local`, selected by `<prefix>profile: checkpoint`, allowing only the checkpoint listener's address and port (X3); the image build and the port in `.k3s/env`. | 20b |
| `eslint.config.js` | Under `src/git-reader/`, `node:fs` only in `fs-safe.ts`; `node:child_process` and `node:worker_threads` nowhere. | 20a |
| `docs/design/w020-probes/` | The probes of 7.2, copied at merge. | merge |

Not changed: anything under `apps/worker`; any migration; the publisher; D17's two methods; the
pod listener's limits and admission order for its three existing routes; the edge table.

**Every edit to an earlier package's test**, so that none is a surprise:

| File | Edit | Commit |
| --- | --- | --- |
| `apps/runner/test/harness.ts:54`, `:117` | Pins `finalizeRequestWaitSeconds` to 0 in both `createTestConfig` calls, as W-019 pinned the cancel window. With the wait at 0 the runner offers no finalize, so no supervisor sends one and nothing races (C24). | 20b |
| `tests/recovery/test/kit.ts:68-73`, `apps/runner/test/k8s/supervised.ts:29` | **No edit, and checked:** both build their runner through `harness.ts:117` (`kit.ts` through `@factory/runner/test-harness`, `apps/runner/package.json:9`), so they inherit the pin. W-019's `w019-lifecycle`, `ac-15-process-cancellation`, `ac-12-stale-live-writer`, `ac-10-duplicate-supervisor`, `w019-hint-flood` and its three k3s files therefore keep their expected outcomes, `stopping` with `harness_exited` where they assert it. W-020's own cross-app and k3s files set the wait to 20 explicitly. | 20b |
| `apps/runner/test/w017-states.test.ts:55-59` | "A `finalizing` row is unchanged by a pass" becomes: a `finalizing` row with its proof stored, a child `running` and the deadline ahead is unchanged by a pass. **Control:** the same row with the deadline backdated moves to `stopping`. | 20b |
| `apps/runner/test/w019-container-exit.test.ts:60-72` | The same change to its last assertion. Its harness-exit cases run with the wait at 0 and are otherwise unchanged. | 20b |
| `apps/runner/test/w019-volume-disposition.test.ts:12` | `finalizing` with a qualifying proof is `quiescent`; without a proof still `in_use`; a live or quarantined child makes every state `in_use`. | 20b |
| `apps/runner/test/w019-quarantine-record.test.ts` | One case added: the `finalizing` source. | 20b |
| `packages/runner-protocol/test/w019-pod-api.test.ts` | The new denial code and the grant's optional field in the vectors. | 20b |
| `apps/supervisor/test/w019-heartbeat.test.ts` | No edit expected: its grants carry no `finalizeOffered`, so no finalize is sent. Listed because it is the file that would show it. | 20b |
| `packages/workspace/test/ac-12-stale-writer-fencing.test.ts:65-73` | With a `checkpoint_ref` set the request now answers the `restore` kind, and the host refuses to restore from an artifact that is not a `CheckpointManifest`; still no fresh clone. | 20c |
| `apps/runner/test/w017-start-or-attach.test.ts:227-237` | A workspace with a `checkpoint_ref` is now allocated, and its first pass stops it as `not_supported_restore_source` with nothing cloned. | 20c |

If the first run of a sub-part shows another edit is needed, it is added here before that review,
not after.

### 7.8 Tests, and which tier proves what

Real Postgres wherever a row is involved; real Git for every fixture, bundle and restore. Time is
moved by backdating row timestamps and running one pass. **Every refusal has, in the same setup, the
accepted case.** A cross-app file keeps at most two pods alive at once and closes its kubelet in
`afterEach`. 20a's eleven files are in 7.3.

**20b: units and the runner, fake tier.**

| Test file | Shows |
| --- | --- |
| `packages/runner-protocol/test/w020-checkpoint-api.test.ts` | Every checkpoint request and answer round-trips through the committed vectors; unknown keys, `__proto__`, an unknown part name, a part cap of 0 or past the configured cap are refused. **Control:** the vectors parse. The finalize route's request and `not_finalizable` are in the pod vectors. |
| `packages/workspace/test/w020-checkpoint-build.test.ts` | From a reader snapshot of a real dirty fixture (a binary edit, staged and unstaged changes to one file, a deletion, an untracked file, a symlink, an execute-bit change, an intent-to-add entry, a skip-worktree entry): the bundle verifies in an empty repository with no prerequisites; the three refs name `HEAD`, the index commit and the working-tree commit; `write-tree` of the index commit equals the index manifest's tree; applying the two patches to a checkout of `HEAD` reproduces both trees. **Determinism:** two builds give byte-identical parts. Trailers are the server's values. **Attributes:** with `* -diff` and `diff=evil` (a driver that writes a canary) in the tree, no canary appears and the patch is binary-capable. **Control:** the same diff with `--attr-source=HEAD` and the driver configured does write the canary. A `snapshot.json` that is malformed or past its cap is refused. The builder's Git is unaffected by the hostile parent environment of `w018-hostile-environment.test.ts`. **Determinism with `pack.threads=1`:** two builds give byte-identical bundles (review, Livia 14). **A hostile export** (review, Furio M5), each refused or harmless: `/export/snapshot.json` as a symlink to a file standing in for the token (not followed; `path_unsafe`); a snapshot past its cap; a pre-made Git repository with a planted `config` (`fsck.*` severities, `alternates`) at `/work/repo` (the exclusive `mkdir` refuses it) and in `/export` (never used as a repository); a pack whose objects carry names that do not match their bytes (`index-pack --strict` computes the real ids, and the snapshot's references then fail). **Paths that are Git syntax** (review, Furio M1): index entries named `--pathspec-from-file=/etc/hosts` (a directory and a file) and `:(glob)*`, and a name containing LF, go through `update-index -z` and come out as exactly those entries. **Control:** the same names passed as arguments without the hardening read `/etc/hosts` and expand the glob (G4). |
| `packages/workspace/test/w020-capture.test.ts` | D34: an untracked `node_modules/x` and `.env` are excluded and listed with their reasons; a **tracked** file under `node_modules` and a tracked `.env.example` are captured; a file named in `.gitignore` is captured (**control:** `git status` in the same tree hides it, so the ignore rule is live); a FIFO and a nested `.git` are excluded. Past the entry cap the checkpoint is refused, not trimmed. |
| `apps/runner/test/w020-finalize-route.test.ts` | Granted only when the pod read shows the harness `terminated`; **control:** with it running, `not_finalizable` and nothing written. The lease clause: backdated past expiry, `lease_expired`, the row still `running`; **control:** fresh, `finalizing` with the deadline set. A fenced workspace is `stale_epoch`; another pod's token is refused; a repeat answers the same and writes nothing. The intent record holds the pod and the exit code from the pod read and nothing from the body. A renewal in `finalizing` answers `not_renewable`, `finalizing`. In `suspect`, `not_finalizable` with `suspect` and `retryable: true`; after a renewal returns the row to `running`, the retry is granted (C20). With no workspace, `not_finalizable`, `no_workspace` (C23). A grant offers finalize only with a workspace and the wait above 0; **control:** with the wait at 0 no grant offers it. A fenced workspace is `stale_epoch`, not `not_startable` (C22). |
| `apps/runner/test/w020-harness-exit-wait.test.ts` | The harness exits with the supervisor running: no stop while the exit-seen record is under 20 s old (backdated 19 s: nothing); at 21 s, `stopping` with `harness_exited`. A finalize inside the window wins. A supervisor exit stops at once; no start record stops at once. **Control:** with the wait at 0 the first pass stops, as in W-019. With no workspace, the first pass stops at once (nothing was offered). |
| `apps/runner/test/w020-finalizing-pass.test.ts` | With the fake kubelet: the authoring pod is deleted without a hold; the proof is stored in `finalizing`; the workspace goes `retained`. **Admission:** an unlabelled, unfinished pod naming the claim blocks the child; **control:** one naming another claim does not. The child row's fields, its receipt per attempt and its Job name. A foreign Job under the child's name quarantines the child and the parent gives up. **Give-up:** the deadline backdated, two failed attempts, an urgent stop: each `→ stopping → terminated` with the proof and the earlier `checkpoint_ref`. Not proved past the stop deadline: `quarantined` with source `finalizing`, the workspace `quiescing`. **One-way door:** proof stored, then a foreign pod appears; not quarantined. **Give-up with a live child** (review, Livia 6): a child `running` at the deadline is deleted, shown gone and marked `failed` before the parent leaves `finalizing`; no child row is live afterwards and `volumeDisposition` answers `quiescent`. **Control:** a child whose pod the fake keeps past the delete ends `quarantined`, and the claim is `in_use`. |
| `apps/runner/test/w020-checkpoint-job.test.ts` | `renderCheckpointJob` against **every row of 7.4's shape table**: init container `read` and container `build` and no other; the `<prefix>profile: checkpoint` label; the account from `profiles.checkpoint`; the audience `factory-checkpoint:<childId>`, the projected token in `build` only; requests and limits on both from `profiles.checkpoint.resources`; `images.checkpoint`; no `fsGroup`; the claim read-only in its source and its mount and only in `read`; `export` writable in `read` and read-only in `build`; `work` only in `build`; uids 10001 and 10003; the deadlines and arguments, all from rows; no `StageInput`. Structural: no container mounts both the claim and the token. The committed `checkpoint-job.expected.json` equals the render. A Job with any template change is not attached (`templateDifferences`). |
| `apps/runner/test/w020-checkpoint-listener.test.ts` | TLS and the limits of section 6 with 2 open connections per source. **AC-231 material:** an authoring supervisor's valid token is refused (subject, audience), and so is a token for another child and a pod of another Job; **control:** the child's token is admitted. `begin` from two pods: one wins. A part with no length (411), a length past the cap (413, nothing written), a wrong digest (refused, the upload `failed`), a body under 1 MiB/s for 30 s (cut), a second part while one is in flight (refused); the same name and digest again answers the same ref, another digest is `conflict`. A parent no longer `finalizing`, or past its deadline, refuses every writing route. **No transaction while streaming:** with an upload held by a fault, an `UPDATE` of the parent's row is not blocked. **Control:** the pod listener still answers 413 to a 17 KiB body. **Also missing before** (review, Furio): a child's valid token presented to the **pod** listener is refused (subject), and the pod listener's subject set contains no checkpoint account; **control:** the same token is admitted by the checkpoint listener. The checkpoint review bucket: 100 child reviews in a burst leave the pod listener's budget untouched. A part link after the parent's deadline has passed is refused. |
| `apps/runner/test/w020-acceptance.test.ts` | One transaction: workspace `checkpointed` with the ref, allocation `completed`, child `completed`, `result_ref` set, capacity released; `getResult` returns a valid `StageResult` with `producerKind: 'runner'` and **`status: 'inconclusive'` whether the harness exited 0 or 3** (D30), the exit code only in the handoff and the intent record. The manifest and every part it names, and the index manifest, are linked under `checkpoint/<workspaceId>/g<generation>/...` (C21). Each manifest field that differs from the rows (workspace, generation, epoch, base, setup profile, `createdAt`, prerequisites), and a ref not linked to this child or linked to another, is refused. A duplicate identical finalize returns the stored result; a conflicting one is `conflict` and audited. An expired deadline fails inside the statement. A `failed` child is refused. **AC-231 material:** finalize with the runner identity, a control-plane identity, the supervisor's subject, or the checkpoint identity without a `ChildBinding` is refused and audited. **Cancel:** with a cancel record the checkpoint is stored and no result written, and `getRun` answers `cancelled`. A `result_ref` already set by someone else is `conflict`. **A retried finalize after the commit** (review, Livia 11), while the child's pod exists, returns the stored result although the parent is `completed` and the child `completed`. **Release** (C21): with one part's retention backdated past `now()`, release of the `checkpointed` workspace is `checkpoint_not_accepted`; **control:** all retained, it releases. |
| `apps/runner/test/ac-14-unacknowledged-checkpoint.test.ts` | Seeded rows with an accepted checkpoint R1 and a new `finalizing` generation. The child uploads every part and the manifest; a fault at `before_acceptance_tx`; the runner is replaced **and the child's pod is killed** (AC-14's "runner/pod dies"; review, Livia 12: with the pod alive its retry against the new runner would win). The attempt fails, the parent gives up and ends `terminated`; `checkpoint_ref` is still R1, `checkpoint()` answers R1, and the next generation's request names R1. The failed attempt's parts exist as artifacts, and no `checkpoint/...` link names any of them. **Control:** without the fault, R2. **First checkpoint lost:** with no earlier checkpoint, `checkpoint()` is `no_checkpoint` and the next request is `remote` from the base: no recovery is promised that does not exist. **Control for the kill:** with the pod left alive, the retry is accepted and the result is R2, which is why the test kills it. |
| `apps/runner/test/w020-sweep.test.ts` | A child Job whose row is `failed`, one `completed` longer than one reconcile interval, one no row records, and one whose parent is not `finalizing` are deleted with their UID; a `quarantined` child's Job is not. **Control:** a running child's Job is kept. A `completed` child's Job is kept for one interval. |
| `apps/supervisor/test/w020-finalize.test.ts` | A grant reporting the harness `terminated` causes exactly one finalize; transport errors retry until the fence time; the answer, or `not_renewable` with `finalizing`, takes the `ending` path with no stop acknowledgement. **Control:** with the harness running no finalize is sent. With no `finalizeOffered`, nothing is sent. **After sending**, a `not_this_job` (the pod already being deleted), `not_renewable` with `stopping`, and any other final denial each take the `ending` path, never `fenced` (C17). |

**20b: cross-app, fake tier** (`tests/recovery/test`; the real runner, both listeners, `FakeKube`
and its kubelet, the real supervisor and launcher, and the child's two entries through test
entries in `test/entry`). New scripted harnesses, each baked in as A-33 says: `dirty-edits` (the
fixture changes of `w020-checkpoint-build`, then exit 0) and `plant-git` (plants every item of
`w020-reader-hostile-metadata`, plus `.env` with a marker, then exit 0).

| Test file | Shows |
| --- | --- |
| `ac-230-hostile-git-at-checkpoint.test.ts` | `plant-git` runs, finalizes, and the child is accepted. No canary exists anywhere; the source digest equals one the test computes itself from the raw bytes on the claim directory; the replace ref did not change any digest. **Control:** `git status` run by the test in the planted tree writes the canary. Material for W-134's claim, not the claim itself. |
| `w020-lifecycle.test.ts` | `exit0`: finalize, proof, child, acceptance, `completed`, an `inconclusive` `StageResult` (D30). Exit 3: the same. **A lost finalize answer, with the pass running** (review, Livia 10): a proxy drops the first answer; the pass deletes the pod; the supervisor's retry is refused at the pod read and it ends, exit 0, not fenced. An allocation with no workspace: no finalize, `stopping` with `harness_exited` as in W-019. A cancel during `finalizing`: the checkpoint is stored and the run is `cancelled`. An urgent cancel: no checkpoint, `terminated`. A harness that never exits: the wall deadline ends it with no checkpoint. Time from intent to acceptance is recorded. |

**20c: restore.**

| Test file | Shows |
| --- | --- |
| `packages/workspace/test/w020-restore.test.ts` | `restore` refuses, each with its code: another `checkpoint_ref`, another generation or epoch, a row that is not `allocated`, a receipt already accepted, a manifest whose repository, base or setup profile differs. The materializer refuses a bundle with prerequisites, a head that is not the manifest's, a tampered patch, an index tree that differs, and a source digest that differs (`restore_mismatch`), and nothing is renamed into place. A crash at `workspace.after_restore_rename` is repaired on the next call. **C16:** with a store that fails every put, the row is unchanged and no receipt is linked; **control:** with it working, accepted. On macOS a checkpoint with case-only collisions is refused; **control:** with `foldPaths` off it restores. **One file changed in both the index and the working tree** restores exactly (review, Furio L5); **control:** with `--cached` in place of `--index` the same checkpoint is `restore_mismatch`. **Paths that are Git syntax** (review, Furio M1): a checkpoint whose index holds intent-to-add and skip-worktree entries named `--pathspec-from-file=/etc/hosts` and `:(glob)*` restores exactly those flags on exactly those paths, no file outside the staging directory is opened (an `fs` spy on the Git child's arguments and an `/etc/hosts` canary copy), and no error message carries a line of the canary. |
| `tests/recovery/test/ac-13-dirty-checkpoint-restore.test.ts` | Restore mechanics, material for AC-13 (7.9). `dirty-edits` runs and its checkpoint is accepted. The test records the oracle from the original tree with Git (`ls-files -s`, the flags, the bytes of every file). The pod is lost; `replaceWriter`; `ensureRestored` into a fresh host directory. The restored `HEAD`, index (entries and flags) and every file's bytes and mode equal the oracle; `.env` is absent. **Control:** with the unstaged patch removed from the parts, the restore is `restore_mismatch`. |
| `tests/recovery/test/ac-16-missing-native-session.test.ts` | Material for AC-16 (7.9). The restored generation's receipt says `nativeState: 'absent'` and `fallback: 'portable_handoff'`, the `workspace.restore_fallback` row exists, and the handoff it names is the checkpoint's. The manifest has no `nativeStateRef`, and the restore asked for none. |

**k3s tier, opt-in** (run once at the end of 20b and once at the end of 20c, on AC power, under the
local egress policies and TLS; the build-log line gives the date, the image digests and the results
of the five questions of 7.9):

| Test file | Shows |
| --- | --- |
| `apps/runner/test/w020-checkpoint.k8s.test.ts` | The real images. `dirty-edits` finalizes; the authoring pod object is gone before the child pod is scheduled; the child is admitted, reads and uploads; acceptance; the claim survives. `stat` in the node shows the tree's modes and owners unchanged by the child's mount (question 2). The bundle part's upload rate is recorded (question 4). `plant-git` in the same file: no canary in the node's tree. **The second port** (review, Furio M3): a probe pod with the authoring profile's labels cannot connect to the checkpoint listener's port; **control:** a probe pod with `<prefix>profile: checkpoint` can, and the pod listener's port stays reachable from both. (The supervisor's gate cannot show this: it would need a ninth deny target, `config.ts:134`.) |
| `apps/runner/test/kube-conformance.k8s.test.ts` (rows 29 to 31) | **Cluster-only**, registered in the `opts.cluster` block as rows 13 and 15 are (`suite.ts:328-329`), since the plan's rule that the fake models every row (`m2-plan.md:131`) cannot hold for them. Until W-021's admission exists they run in the execution namespace with the checkpoint profile's account and label; once it does, they move with rows 1 to 21 to the namespace W-021 sets aside for conformance, where its admission model is off (X5). 29: a second pod mounts a `ReadWriteOncePod` claim once the first pod object is gone (question 3). 30: with `persistentVolumeClaim.readOnly` and a read-only mount, a write is `EROFS` (question 1). 31: with no `fsGroup` a second mount changes no mode or owner (question 2). Rows 22 to 28 are W-021's. |

**Which tier proves what.**

| Claim | F | K | Needs R |
| --- | --- | --- | --- |
| The reader reads objects, packs, deltas, the index and refs as Git does, and refuses hostile ones | Yes (differential, hostile and fuzz) | The same library | |
| `treeDigest` reproduced byte for byte | Yes (differential) | | |
| No candidate program runs at checkpoint | Yes (canaries, structural tests) | Yes (canaries in the node) | A sandboxed runtime |
| The checkpoint mount is read-only | No (the fake kubelet does not enforce it) | Yes (row 30) | CSI storage |
| No ownership pass on the child's mount | No | Yes (row 31) | |
| One checkpoint per finalizing allocation; stale and duplicate children refused | Yes | The happy path | |
| Only the child's identity finalizes | Yes | The happy path | |
| Unacknowledged work is never offered (AC-14) | Yes | | |
| Dirty state restored exactly (AC-13 mechanics; the claim waits for O1) | Yes, through `LocalMaterializer`, reached by a test | No (no pod restore, D36) | |
| Fallback to the portable handoff recorded (AC-16 mechanics; the claim waits for O1) | Yes, with no native session ever present | | A real adapter (W-077) |
| Authoring pods cannot reach the checkpoint port | No | Yes (local policy) | W-021's rendered policy on the real CNI |
| Large parts stream from a pod | Units only | Yes, one size, one machine (question 4) | Real network |

### 7.9 What W-020 claims, hand-offs, and what to confirm in the k3s tier

**Claims.**

- **AC-14.** Parts uploaded, acceptance not committed, the runner and the child's pod both lost: the last accepted checkpoint stays authoritative and none is promised that does not exist: fake tier.
- **AC-13 and AC-16: material only** (coordinator's decision, review Livia 2). W-020 shows the **restore mechanics**: binary edits, staged and unstaged changes, a deletion and untracked files come back in a clean generation that reproduces the recorded head, index and source digests, with no deny-listed file; and the restore records its fallback to the portable handoff when no native session exists. Fake tier, real Git, through `LocalMaterializer` on the same workspace row, **reached only by a test** (7.5). The build-log line logs them as "AC-13, AC-16: restore mechanics (material); claim waits for O1 and D36". Only the "absent" native-session case can occur before W-077 (A-36). "Without secrets" rests on construction and the deny list (C12, W-116).
- **The exit-evidence checkpoint.** Its lost-pod scenario (section 1: AC-10, AC-13, AC-14) **cannot be reached until O1 is decided**: no runner path today starts a stage from an acknowledged checkpoint, and a pod cannot yet read one (D36). AC-14's half can be shown; AC-13's cannot. The section 1 notes for the checkpoint should say so in those words.
- **Built here, claimed elsewhere:** checkpoint child fencing (AC-206, W-129: C5); hostile Git metadata at checkpoint (AC-230) and checkpoint-only finalization (AC-231), both W-134's, for which 7.3 and 7.8 supply the material.
- **Not built:** pod restore (D36); the cross-stage binding (O1); mid-stage and incremental checkpoints (P-30); the sweep of unfinalized checkpoint parts (`06:104`, W-024); secret scanning (W-116); setup rerun at restore (SI-39); native session state (W-077); proposals, outputs and a semantic status in the result (W-075, D30); log chunks (D26).
- **Residual risks, for the READMEs:**
  - The reader is new parsing code over hostile input in a process that runs as the tree's owner. The two containers and the read-only export (D33) keep the credential out of its reach and its output out of the credential's process except as data; the fuzz tests bound what has been looked at, not what exists.
  - Node's SHA-1 has no collision detection. The reader's check is integrity against accident and simple forgery; the collision check is Git's `index-pack --strict` in `build`, which must never be skipped (rule 8; review, Furio L3).
  - A self-contained bundle carries the whole history. A repository past the caps cannot be checkpointed at all, and its stage cannot complete; that is a cliff to know about before real repositories arrive (P-30).
  - A candidate can make its own checkpoint fail (a 0000 file, a sparse index, a merge in progress, an escaping symlink, a zero-padded tree). It loses its own work and nobody else's.
  - The deny list is a short interim list (A-38); it does not make a checkpoint secret-free.
  - Restore holds the bundle in memory, up to 256 MiB (C18, P-31).
  - The object store is needed to finish a stage, as it is to finish a stop (race rule 13).
  - Until W-023 changes the worker, a fake-executor result can block a runner result (race rule 12).
  - In the local tier every pod is one source (A-32), so the checkpoint listener's per-source cap is relaxed there; only the egress policy keeps authoring pods off its port.

**Hand-offs.**

- **W-021** (built after W-020, its D49). Answered in W-021's 21b ("The checkpoint profile", section 8), with the shape the coordinator fixed on 2026-11-21. What it must meet:
  - Admit exactly the checkpoint child of 7.4's shape table: init container `read`, container `build`, the `<prefix>profile: checkpoint` label tied to `profiles.checkpoint.serviceAccount`, the audience `factory-checkpoint:<childId>` with the projected token in `build` only, requests and limits on both containers, `images.checkpoint` in the allowlist, the claim read-only and only in `read`, `export` read-only in `build`, `work` only in `build`, and no container mounting both a claim and a token (D33).
  - Render the third policy, `factory-exec-egress-checkpoint`, selected by the checkpoint profile label and allowing only the checkpoint listener's address and port; leave `factory-exec-egress-listener` as it is, and name both ports in D50 (X3).
  - Keep `review(req, { audience, subjects, bucket })` as 7.4 uses it: the pod listener's subject set never includes the checkpoint account (X2).
  - Count the checkpoint listener's own review bucket in the review-ceiling product (X4).
  - Showing authoring pods denied the checkpoint port through the supervisor's gate would need a ninth deny target (`config.ts:134` caps them at eight); W-020's k3s file shows it with probe pods instead.
  - Move conformance rows 29 to 31 with rows 1 to 21 (X5).
- **W-022 (or whoever owns the pod artifact read, W-021's D48):** the `restore` request kind in a pod; it is already a typed refusal there (D36).
- **W-023:** the worker must not write `result_ref` for a runner stage, and must read the result through `getResult`; it is the caller that needs O1 answered; `getRun` now answers `finalizing`; a cancelled run may carry an accepted checkpoint and no result; a runner result is `inconclusive` until W-075 (D30).
- **W-024:** the sweep of unfinalized parts: artifacts with a `checkpoint_part/...` link and **no** `checkpoint/...` link, older than the finalize deadline. Accepted parts always have the second link (C21), so the rule cannot match them; W-024's test must show that, with an accepted checkpoint whose bundle survives the sweep. Also: child Jobs and pods of `quarantined` children; a claim is deletable only when `volumeDisposition` is `quiescent` with no live or quarantined child.
- **W-075:** `submit_result` as a second finalize trigger, and the source of a semantic status (D30); proposals and outputs in the minted result; the authenticated local tool routes stay off the checkpoint listener.
- **W-077:** native session state and its compatibility check (`07:128`); a narrative in the handoff, labelled untrusted (`07:132`); the first writer after a restore reruns setup.
- **W-116:** scan the staged and unstaged patches and the untracked additions before acceptance, and replace the deny list with its findings.
- **W-129:** the operational projections of child Jobs over the rows W-020 writes.
- **W-134:** AC-230 and AC-231 from 7.3's and 7.8's material, with the mount enforced at K.

**To confirm in the k3s tier.** Five questions the design rests on, each with its fallback:

| # | To show | If it does not hold |
| --- | --- | --- |
| 1 | On `local-path`, `persistentVolumeClaim.readOnly: true` with a read-only mount makes a write `EROFS` (row 30). | The reader is still read-only by construction and the `read` process runs under `node --permission` with no write outside `/export` (P1); the claim of a read-only mount narrows to the code. |
| 2 | With no `fsGroup` the kubelet changes no mode or owner on the child's mount (row 31); uid 10001 reads the tree the harness left (0640 files, 0750 directories). | The reader already takes only the owner's execute bit (C9), and the kubelet's pass adds group bits without touching the owner's. If it does more, the `read` container gets `runAsGroup: 10001` and the finding goes to the build-log line. |
| 3 | A `ReadWriteOncePod` claim is mountable by the child as soon as the authoring pod object is gone, with the authoring pod's volume torn down (row 29). | The child stays `Pending` until the kubelet releases the claim; the 60 s start allowance inside `childDeadlineSeconds` covers a short wait. If the wait is longer, the allowance is raised (the budget check moves with it) and the time recorded. |
| 4 | A 100 MiB part streams from a pod through the podman gateway to the Mac at 1 MiB/s or better. | The minimum rate is lowered for the local tier only (a test-configuration setting, A-37) and the measured rate is recorded; production keeps 1 MiB/s. |
| 5 | The separate policy `factory-exec-egress-checkpoint-local`, selected by the profile label, lets a checkpoint pod reach the second port while the select-all policy keeps an authoring pod off it, on this CNI. | The checkpoint port is not opened to any pod and every k3s checkpoint fails visibly; nothing widens the select-all rule. The finding goes to W-021's step 0. |

Recorded, not relied on: the reader's time and peak memory on the largest fixture inside the
1,800 MB node; whether the child's default requests (1 GiB for the pod, the larger of the init
container's and the main container's) fit beside the system pods there, and if not, the local
tier's lower values (A-37); the image's size; the time from intent to acceptance.

### 7.10 Owner decisions, an open question, assumptions, spec issues and plan additions

The owner accepted the recommended default of every decision here, D28 to D37, on 2026-11-22,
including the security calls D28, D33 and D34, and D30 (always `inconclusive` until W-075). None
blocks 20a. D30 and D36 change what the exit-evidence checkpoint can show. O1 starts a new series
in section 3: open questions, which are not decisions with a default. **O1 stays open and is
assigned to silvio.**

| # | Decision | Recommended default |
| --- | --- | --- |
| D28 | The reader's scope and limits (7.3). | SHA-1 repositories only; loose objects, pack v2/v3 with idx v2, offset and reference deltas to depth 512; loose and packed refs, no reftable; index v2 to v4 with no split or sparse index and no unmerged entries; the limit table of 7.3; Git's own path rules plus a refusal of backslashes. Everything outside is a typed refusal, never a fallback to Git. Not taken: depth 4,095 (Git's maximum; the work budget would bound it, but nothing needs it); accepting backslashes (legal on Linux, unrepresentable on hosts the factory may restore to). |
| D29 | What a cancel does to a checkpoint (C13, SI-29). | A cancel never starts one. A cancel that finds the allocation `finalizing` lets the checkpoint finish and be stored, and the stage ends `cancelled` with no result. An urgent cancel gives the checkpoint up at once. The hold of section 6 stays a courtesy for `running` stops. |
| D30 | Who mints the `StageResult`, and with what status (C6). **Set by the coordinator on 2026-11-21 after the security review (Furio M4); accepted by the owner, 2026-11-22.** | W-020 builds `StageFinalizer.finalize` for the child's identity only. **The runner mints `inconclusive` with the checkpoint and no outputs. The harness exit code is a diagnostic only**, kept in the intent record and the handoff, until W-075's `submit_result` gives a source for a semantic status. Not taken: `completed` on exit code 0 (the brief's earlier default), which would let a hostile harness's own exit make a runner-authored `completed` (`06:7`, AC-231). SI-38. |
| D31 | Retries of the checkpoint child (C7). | One receipt per attempt, at most two attempts, each admitted only after the previous one's pods are shown gone. |
| D32 | How a child streams large parts (C8). | A second TLS listener on its own port with its own limits and the same admission order; parts streamed into the artifact service; the pod listener unchanged. Not taken: special-casing streamed routes on the pod listener (its limits are server-wide). |
| D33 | The child's topology. A security call. | Two containers and two exchange volumes (7.4's shape table): `read` mounts the claim read-only, holds no credential and writes only `export`; `build` holds the token, never mounts the claim, mounts `export` read-only, keeps its repository in `work`, which only it mounts, and loads objects from `export` only as data through `index-pack --strict`. Not taken: one container (a reader bug would run beside the token); one shared scratch volume (the brief's earlier form: the process D33 distrusts would write the credential holder's working directory; review, Furio M5, Livia 9). |
| D34 | What is captured (SI-37). | Every tracked path; untracked files except the root and nested `.git`, special files, five rebuildable directory names and the deny list of 7.4 (case-folded, an interim under A-38); repository ignore files not honoured; over a cap, refuse. Not taken: honouring `.gitignore` (a second parser over candidate data, and ignored files are where a harness may leave work). |
| D35 | W-020 is larger than its estimate: 18 to 21 days against 4–6 (3–5 more for the reader); 7.11 shows the arithmetic. | Three commits, 20a, 20b and 20c, each with its own review; one build-log line after 20c. 20a lands as a library with no caller. |
| D36 | Restore into a pod (C10, D13). | Not in W-020: a typed refusal until a pod can read an artifact (D13; W-021's D48, accepted by the owner on 2026-11-22, gives it to W-022, and its design goes to silvio first). AC-13 and AC-16 are logged as restore mechanics only, through `LocalMaterializer`. **Consequence:** the exit-evidence lost-pod scenario needs that read, and O1, before it can run end to end. |
| D37 | How a stage reaches `finalizing` in M2. | The supervisor asks when the cluster reports the harness exited; the runner offers finalize in the grant only to an allocation with a workspace and a wait above 0, and waits up to 20 s for that request before stopping as W-019 does. Not taken: the runner alone moving `running → finalizing` on a harness exit (no route, no wait; but `06:112` has the supervisor record the request first, and W-019 handed over a route). |

**Open question O1, assigned to silvio (open).** How does a later stage run start from an earlier
stage run's accepted checkpoint? A workspace row is bound to one stage run by W-018's identity rule
(`manager.ts:228`, `start.ts:87`), while `06:39` speaks of one clone per task and repository and
`06:76` of replaying from the last acknowledged boundary; the reference `restore` takes a checkpoint
and no target. The candidates are (a) a new row seeded with a source `checkpoint_ref`, which needs a
field the row does not have, or (b) one row per task and repository across stage runs, which
reverses W-018's identity rule and touches W-017's allocate step. Either changes W-018 and W-023
together and is expensive to undo, so it is not decided here. W-020's mechanics serve both.
**Until it is decided, the exit-evidence lost-pod scenario is not reachable**, and AC-13 and AC-16
stay material (7.9).

Assumptions W-020 writes to `docs/assumptions.md`:

| ID | Package | Stands in for | Assumption | Until |
| --- | --- | --- | --- | --- |
| A-36 | W-020 | W-077 (adapter), INT-08 | No native session state exists; every restore takes the portable handoff, and the handoff holds factory records only. | W-077 |
| A-37 | W-020 | INT-05 | In the k3s tier the checkpoint listener runs in the test process beside the pod listener, on a second port, with the same throwaway CA; the local egress file adds a separate policy for that port selected by the checkpoint profile label, and the select-all rule is not widened. Every pod there is one source (A-32), so the listener's per-source caps are relaxed by the test configuration. The local tier may lower the part's minimum rate and the child's resource requests (7.9). | INT-05 decided; a real cluster (D4) |
| A-38 | W-020 | W-116 | No checkpoint is scanned for secrets. No factory credential is ever on the volume, and the deny list of 7.4 keeps a short list of well-known names out of untracked files. It does not make a checkpoint secret-free. | W-116 |
| A-39 | W-020 | D4 (storage) | `local-path` is the only storage class: a read-only claim mount and the absence of an ownership pass are what 7.9 measures there; CSI storage is `unknown` to `volumeDisposition`, so no child is admitted on it. | D4 |

Spec issues W-020 records in `docs/spec-issues.md`:

| ID | Location | Problem | Proposed choice |
| --- | --- | --- | --- |
| SI-34 | `06:69`; `CheckpointManifest` (`additionalProperties: false`) | "Record original index state" is required, and the manifest has no field for it. | A factory index manifest, `factory-checkpoint-index/1`, linked by purpose beside the manifest. |
| SI-35 | `contracts/interfaces.ts:92-94`; `06:112` | `WorkspaceManager.checkpoint` and `restore` read as if the manager snapshots and restores, but the snapshot is the child's and the manager never touches a filesystem; `restore` names no target workspace. | `checkpoint` reads the accepted ref; `restore` checks the binding and returns the record; the materializer does the work. |
| SI-36 | `CheckpointManifest.handoffRef` (required); `07:128`, `:132` | A portable handoff is required and has no schema. | `factory-portable-handoff/1`, factory records only. |
| SI-37 | `06:69`; `untrackedArchiveRef` | "Selected untracked files" names no selector and the archive no format. | D34's rule; untracked files travel in the working-tree commit and the unstaged patch; no archive. |
| SI-38 | `06:7`; `StageResult.status`; AC-231 | Completion may not be inferred from an exit code alone, and without an adapter or a tool receipt nothing else describes the outcome. | D30: the runner mints `inconclusive` with the accepted checkpoint; the exit code is a diagnostic; W-075's `submit_result` supplies the semantic status. |
| SI-39 | `06:82` | Restore must rerun declared setup, and no trusted executor may run setup recipes. | Not rerun at restore; the first writer runs it, and the receipt says so. |
| SI-40 | `schema.sql:983` | `one_live_checkpoint_job` counts `quarantined` as live, so one quarantined child blocks every retry for its parent. | Kept: the parent gives up and ends `terminated`. |
| SI-41 | `06:67` | Tool versions must match the setup profile's before acceptance, and no observed versions exist for a step that runs no candidate setup. | The child records its own Git and reader versions in the handoff; the comparison waits for a setup executor (W-077). |
| SI-42 | `06:84` | Behaviour-release and recipe trailers must be written from server records; M2 has neither record. | Task, stage run and checkpoint trailers only. |

Plan additions for `docs/plan-additions.md`:

- **P-30**: incremental bundles with a retained prerequisite chain (`06:74`), before repositories outgrow self-contained bundles.
- **P-31**: a streaming verified read in the artifact service, so that restore does not hold a bundle in memory.
- **P-32**: a longer fuzz run of the reader outside the default suite, its corpus kept, run before any real tenant.

### 7.11 Definition of done, estimate and split, confidence

**Definition of done.**

- **20a:** the eleven reader files of 7.3 pass; W-018's eleven and W-019's files pass unchanged; `pnpm check` is green; the reader has no caller. Independent review, with the reader's security review, before 20b starts.
- **20b:** the twelve unit files and the two cross-app files of 7.8 pass, with the 20b edits of 7.7's table and no others; `pnpm check` is green. `pnpm test:k8s` passes once on this machine on AC power: W-017's and W-019's files (unchanged, through the pin of 7.7), conformance rows 29 to 31 and `w020-checkpoint.k8s.test.ts`, with the five questions of 7.9 each answered or met by its fallback. Independent review.
- **20c:** `w020-restore.test.ts`, `ac-13-dirty-checkpoint-restore.test.ts` and `ac-16-missing-native-session.test.ts` pass with the 20c edits of 7.7's table; `pnpm check` is green; the k3s file runs once more. Independent review.
- The build-log line logs **AC-14** as claimed at F, and **AC-13 and AC-16 as restore mechanics, material only, the claim waiting for O1 and D36**, naming W-129 for AC-206 and W-134 for AC-230 and AC-231, and saying that the exit-evidence lost-pod scenario is not reachable until O1 is decided. The k3s date, image digests and the five answers are in the same line.
- No file under `apps/worker` changes; no migration; no new npm dependency; the checkpoint image adds Git, which the materializer image already carries.
- `docs/assumptions.md` has A-36 to A-39; `docs/spec-issues.md` has SI-34 to SI-42; `docs/plan-additions.md` has P-30 to P-32; section 3 has D28 to D37 and O1, and D30 is marked as accepted by the owner, 2026-11-22.
- The READMEs state rules 8 to 10, the reader's open list and limits, the child's shape table, the routes and their clauses, the captured and excluded lists, acceptance's lock order, restore's proof, the residual risks (the SHA-1 one among them) and what is not built. `packages/workspace/README.md` drops "checkpoint and restore" from "Not built".
- Nothing is left behind by either tier: each file checks its process groups, both listener ports and its namespace at teardown.

**Estimate and split** (D35). Livia's round-1 estimate (15) was 8 to 10 days for 20b and 14 to 18
in all, against this brief's 12 to 15. The review then added work to every sub-part. Counted item
by item, in days:

| Sub-part | Items | Days |
| --- | --- | --- |
| 20a | zlib and loose objects 0.5; packs, idx and positioned reads 1.0; deltas, cache and the work budget 0.75; refs 0.25; the index, versions 2 to 4, 0.75; commits, trees, the walk and the digest 0.5; the working tree, `fs-safe` from the mount root and the path rules 0.75; eleven test files, the differential, fuzz, layout and limit tests among them, 1.5 | **6.0** (5 to 6.5) |
| 20b | finalize route, the grant's offer, the supervisor's changes and the harness-exit wait 1.5; `passFinalizing`, child rows, give-up and the sweep 1.5; `renderCheckpointJob`, the image, the account and both egress files 1.0; the checkpoint listener, the child guard, `review` generalised, streaming and part links 2.0; the builder with its exclusive repository and `index-pack` 1.5; acceptance, `StageFinalizer`, the release check of C21 and the lock order 1.25; twelve unit and two cross-app files and the edits 2.0; the k3s file, rows 29 to 31 and the run 0.75 | **11.5** (10 to 12) |
| 20c | the restore request kind, `restore`, `checkpoint` and C16 0.75; the materializer's restore kind with `--index` and the stdin forms 1.0; the host 0.25; three test files 0.75 | **2.75** (2.5 to 3.5) |
| Total | | **20.25**, so **18 to 21** against the backlog's 4–6 (and section 1's 3–5 for the reader) |

| Sub-part | Delivers | Can start |
| --- | --- | --- |
| 20a | The reader, its manifests' types, eleven test files | Now: it depends on W-018 only |
| 20b | Finalize route and wait, `passFinalizing`, the child Job and image, the checkpoint listener, the builder, acceptance, the sweep, the k3s file | After 20a's review; after W-019's k3s tier has passed once (W-021's D49) |
| 20c | Restore kind, `restore`, `checkpoint`, C16, the restore mechanics for AC-13 and AC-16 | After 20b |

The day count assumes W-019's k3s tier passes unchanged first. W-021 (section 8) is built after
W-020 (its D49); its admission is written against 7.4's shape table.

**Confidence.**

- **Verified by reading today:** every file and line cited; the layout of a generation directory; that `treeDigest` is computed by functions the reader can call unchanged; that `states.ts:16` has `running → finalizing` and no `suspect → finalizing`; that `checkpointRetained` checks one artifact; the lease clause in `transitionAllocation`; the cancel path's treatment of `finalizing`; the artifact service's streaming upload, its in-memory read and its active-stage check; that a workspace row is bound to one stage run (the root of O1); the `checkpoint_job` columns, index and grants; that the worker writes `result_ref` unconditionally; that `kit.ts` and `supervised.ts` build their runner through `harness.ts:117`; that `gitEnvironment()` sets no literal pathspecs; the tests that assert the old behaviour.
- **Verified by running:** Node's zlib behaviour (Z1 to Z4), the permission model and `O_NOFOLLOW` (P1 to P3, run twice), Git's mode canonicalisation (G1), its attribute source in a bare repository (G2), its refusal of zero-padded trees at clone and `index-pack` (G3), and the pathspec reads (G4).
- **Inferred, not run:** the five k3s questions of 7.9. The one I trust least is question 3 (when a `ReadWriteOncePod` claim is free again after a pod delete); the one with the widest effect if wrong is question 5, the second egress policy, because without it no k3s checkpoint can run at all.
- **Inferred from Git's documentation and source behaviour, to be pinned by the differential tests:** index extensions and their required or optional rule; `check-ref-format`; `verify_path`'s HFS and NTFS rules; delta encoding; that `--literal-pathspecs` covers every command the builder and restore run.
- **Judgement:** the estimate; the limits (they follow W-018's where they mean the same thing); the resource defaults; the 20 s wait; the deadlines (now derived, 7.4); D34's lists.
- **Beyond research:** O1, recommended for silvio before W-023's brief. If the owner wants the lost-pod exit scenario end to end in M2, O1 and D36 are both on that path. D30 was accepted by the owner on 2026-11-22.
- **Where I would point the next review:** the reader's pack and delta code and its fuzz control; the builder's handling of a hostile export; acceptance's lock order and its cancel branch; the finalize retry window of race rule 11.

### 7.12 Response to the two reviews (round 1, 2026-11-21)

The response to the design review and the security review is recorded as round 6 of section 10.

## 8. Fifth package brief: W-021 Capability proxy and execution profiles

Written 2026-11-19 against `a119964` (W-019b committed: the supervisor, launcher, images and k3s
files, fake tier run), and revised on 2026-11-21 after a design review and a security review
("Response to review", at the end of this section). No test, suite or cluster was run for this
brief: every code fact below was read on those days, and every Kubernetes behaviour is a row of
section 2, a result of W-019's step 0 (`docs/build-log.md:38`), a line of the Kubernetes source read
on those days (cited where used), or marked **to confirm in the k3s tier**. Six of those carry
design weight and are probed first (step 0). **W-019's own k3s tier has not run yet**
(`docs/build-log.md:40-41`: "the k3s tier written and NOT run"), and this package replaces the
policy those files run under; see C10 and D49.

**Goal.** Make the runner the one place that decides what a stage's pod may do, and make the cluster
refuse what the runner does not render. When W-021 is done:

- a supervisor can ask the runner whether a named operation on a named resource is allowed, and the
  answer comes from grants the runner derived from stored rows; nothing in a request, a `StageInput`
  or a prompt adds authority, and every decision is audited (denials under W-019's cap);
- a grant's call limit survives a runner restart and holds across two runner replicas;
- a capability is refused the moment its allocation is not `running` or `suspect` with a live lease,
  at its epoch, with its workspace still owned by that pod and its task `running`;
- each stage role runs under the service account and execution profile of its role class (D42), and
  the guard checks the reviewed identity against the one stored on the allocation;
- the execution namespace has default-deny ingress and egress, with two allow rules: allocation
  pods may reach the pod listener's port and nothing else, and the checkpoint child (W-020) may
  reach the checkpoint listener's port and nothing else. A pod there cannot reach the API server,
  the metadata address, the databases, the workflow engine, another port on the runner's host, the
  node's kubelet, DNS or another task's pod;
- admission in that namespace refuses any Job, pod or claim not created by the right identity, any
  pod that breaks the chapter 09 hardening rules or its profile (the checkpoint child's included),
  any container running an image other than the one its name is tied to, any image change on a
  live pod, any pod delete or eviction that shortens the grace period (the kubelet and the pod
  garbage collector excepted, D44), any ephemeral container, exec or attach, and any orphaning Job
  delete.

No Temporal, no workflow change, **no migration** (D40), no new npm dependency, no Claude, no factory
tool server (W-075), no checkpoint child (W-020 builds it; this package admits it), no bundle reads
from pods (D48). The one change in `apps/supervisor/src` is the deny-target cap, which moves to
`@factory/runner-protocol` and rises from 8 to 16 (`args.ts:63`, `config.ts:134`; X3, L7).

**Size.** More than the backlog's 4–6 days; I expect 10 to 12 (D38), after the two reviews.
**Step 0**: the probe, most of a day, after W-019's k3s tier has passed once. **21a**: the grants,
the durable counter, the capability route, the per-profile identity in the guard, and the
retirement of the in-memory proxy, in the fake tier. **21b**: the execution profiles as typed
manifests (three network policies, admission for four profiles, limits, image allowlist), the real
deny-target list, the control namespace, the presence check, the move of conformance rows 1 to 21
to the control namespace, and the k3s tier. Each commit has its own review. The acceptance lines
are logged after 21b.

**Words.** "Grant" is one `CapabilityGrant` as the contract defines it (`domain.schema.json` `$defs`
`CapabilityGrant`, `:742`). "The proxy" is the runner's capability check service. "A check" is one
call to it. "A slot" is the audit row that records one allowed check (D40). "Profile" is an
execution profile: the service account, network policy, image set, resources and volume rules one
kind of allocation pod runs under. "Role class" is the group of stage roles that share a profile.
"The exec namespace" is `factory-exec-local`. "The control namespace" is the local-only
`factory-exec-control` (D45). "Admission" means the ValidatingAdmissionPolicy set this package
ships. "The listener", "the guard", "the gate" and "fenced" are as in section 6.

**Spec to read.** `09-verification-security.md:69-77` (identities, role boundaries, the Kubernetes
and network boundary), `:93` (incidents revoke capabilities); `07-harness-context.md:5`, `:38`
(run input carries capability grants, never an admin token), `:74` (role instructions cannot grant
credentials), `:92-96` (grants name operation, scope, environment, lifetime, maximum calls and
side-effect class; network access is role/profile-specific); `06-runner-workspaces.md:25` (deny
stale-epoch tool operations; no reusable publishing credential in the pod), `:90` (cancel revokes
further tool actions), `:108-120` (pod boundary; the projected identity only in the supervisor;
"NetworkPolicy ... are implementation-profile obligations"; grants are checked per call against the
current epoch); `25-data-security-operational-safeguards.md:57-64` (the emergency stop cancels
through the cancellation protocol); `22-reference-practice-adoption.md:91` (a rejected or undecided
candidate leaves the specification in force: no Kyverno, Gatekeeper or agent-sandbox, A-26);
`16-acceptance-catalogue.md:185-193` (AC-19), `:555-563` (AC-56); `01-scope-architecture.md:37`,
`:42`, `:44` (INV-07, INV-12, INV-14); `14-build-backlog.md:263-271`.
Code: `apps/api/src/auth/capability-proxy.ts` (whole file), `apps/api/test/ac-19-unauthorized-tool-request.test.ts`;
`apps/runner/src/config.ts:26-38`, `:77-86`, `:134`, `:193-194`; `src/pod-guard.ts:30-39`, `:63-70`,
`:96-140`, `:161-194`; `src/listener/pod-listener.ts:56-62`, `:96-149`; `src/job-manifest.ts:18-24`,
`:26-38`, `:56-84`; `src/startup-checks.ts:25-45`; `src/records.ts`; `src/start.ts:103`; `src/token.ts:19`, `:108-112`;
`packages/runner-protocol/src/pod-api.ts:4-31`; `packages/database/src/allocation.ts:175-185`,
`:234-261`; `packages/database/migrations/0005_operations_delivery_ledgers.sql:165-174`,
`0010_roles_ownership_grants.sql:146-147`, `:174-175`, `0013_retention_job_grants.sql:12`;
`deploy/k8s/*.yaml`, `deploy/k8s/local/egress-listener-only.yaml`, `deploy/images/harness-scripted/Containerfile:4-7`;
`apps/runner/test/conformance/suite.ts:39-47`; `apps/runner/test/k8s/cluster.ts:116-120`, `:150-170`;
`scripts/k3s.sh:150-167`; `apps/runner/README.md:249-251`;
`docs/assumptions.md` A-07, A-25, A-26, A-31, A-33, A-35. Kubernetes source:
`staging/src/k8s.io/apiserver/pkg/admission/plugin/cel/condition.go:95-157` (master, read
2026-11-19: the CEL `request` variable carries `Options: attr.GetOperationOptions()`, so a policy
can read a DELETE's options).

### What is already built, and is not rebuilt here

- The role table and the rule that no stage role is minted a publish, merge, deploy or credential grant (`capability-proxy.ts:17-27`, A-07). It moves; it does not change (D41).
- The audit shape of a capability decision: `capability.<operation>`, resource kind `capability`, a request digest and a small reason object, never the request text (`capability-proxy.ts:80-83`). Slots keep it.
- The pod call guard and its admission order (section 6, "The listener", steps 1 to 7). The capability route is one more route behind it, with its own per-pod bucket (D43).
- The lease clause in the locked statement of every route that grants (rule 4) and the workspace clause of the renewal (`allocation.ts:175-185`). The slot statement reuses both.
- Deterministic `audit_event` records with pinned fields and `ON CONFLICT DO NOTHING` (D18, `records.ts`, `allocation.ts:239-244`). Slots are records of that kind.
- Restricted pod security on the namespace (`deploy/k8s/namespace.yaml:9-14`), no Role for the supervisor's account (`service-accounts.yaml:1-4`), the runner's Role (`runner-rbac.yaml:1-16`), and the hardened Job the runner renders (`job-manifest.ts:18-24`, `:74-75`): admission checks what is already rendered, so no W-017 or W-019 Job changes shape except its service account and, for read-only roles, one mount (D42).
- The network gate and the local listener-only egress policy (W-019, D24). Step 0 item 5 of W-019 showed k3s enforces egress here, refusing at once (`docs/build-log.md:38`).

### Conflicts and corrections

Each row was checked against the code or the spec today.

| # | Where | What it says | What is actually there | Brief |
| --- | --- | --- | --- | --- |
| C1 | `backlog.json` W-021 `modules` | `apps/runner`, `deploy/helm`. | D8 decided plain manifests under `deploy/k8s`; there is no `deploy/helm`. The design also needs `packages/runner-protocol`, `packages/database`, `packages/domain`, `apps/api` (the retirement) and `scripts/k3s.sh`. | `deploy/k8s`, and every file is listed under "Files", as W-019 did. |
| C2 | Section 6 hand-off "W-021 and W-090 (admission)"; A-33; `harness-scripted/Containerfile:4`, `:7` | Admission must refuse an image labelled `factory.harness=scripted` outside the local tier. | Admission sees the object in the request (the pod spec and its image string), not the image's configuration; nothing in the API server reads image labels. A policy cannot test that label. | D46: the tier's **image allowlist** is the rule. The production allowlist is digest-only and can never name a scripted image, because no production build makes one; the label stays as documentation. |
| C3 | Section 5 hand-off; `capability-proxy.ts:59` | Narrow `starting` to `running`. | `suspect` is still a valid lease: renewals accept it (`allocation.ts:178`, `pod-guard.ts:38`). | Live means `running` or `suspect`, at the epoch, with the lease unexpired **in the statement that takes the slot**. `starting`, `stopping` and every terminal state are refused. |
| C4 | `capability-proxy.ts:47`, `:79`, `:81` | Call counters. | An in-memory `Map` per proxy object, so a restart or a second replica resets every limit; and the counter is incremented before the audit insert, so a failed insert still spends a call. | The allowed audit row **is** the counter (D40): one slot per allowed call, written in the statement that decides it. |
| C5 | `capability-proxy.ts:29-40` | Grants are minted per proxy. | `grantId` is `randomUUID()`, lifetime and limit are caller arguments, and the grants live only in the object. Two runners would mint two different sets. | Grants are a pure function of stored rows, with deterministic ids (D39). |
| C6 | `pod-guard.ts:114`, `:134`; `start.ts:103`; `allocation.ts:19` | The guard checks the supervisor's identity. | It checks one subject from configuration. The allocation row stores `supervisor_identity`, and nothing reads it. | The local check accepts any configured profile account; after the row read the reviewed username must equal `a.supervisorIdentity` (21a). |
| C7 | Section 5 hand-off (A-25 only); `09-verification-security.md:75` | Admission backs A-25: who creates Jobs, pods and claims. | Chapter 09 also requires, by "additional admission policy ... plus a LimitRange": `readOnlyRootFilesystem`, CPU, memory and ephemeral-storage requests and limits, `automountServiceAccountToken=false`, and no runtime socket mount. | All of it is W-021's (21b), with the A-25 rules. |
| C8 | `suite.ts:39-47`, `:92`, `:117`, `:211`, `:293`; `kube-conformance.k8s.test.ts:13`; `cluster.ts:118`, `:160-161`; `w017-run.k8s.test.ts:92`, `:112`, `:120`, `:179`, `:208`, `:212`; `w019-supervised-run.k8s.test.ts:52`, `:57`; `w019-network-gate.k8s.test.ts:63`, `:71` | The k3s tier's own helpers. | **Corrected after review (design finding 1):** the conformance suite creates its objects through the **runner's** client (`runnerKube`, `kube-conformance.k8s.test.ts:13`), not as the admin; the other files do use the admin. Either way they break 21b's rules: suite containers are named `c`, `polite`/`stubborn`, `app`, `keeper`/`leaver`; templates carry no allocation or profile label; claims are 64Mi; row 5's control is `ReadWriteOnce`; rows 3 and 14 make an orphaning Job delete and a force delete on purpose; helpers delete pods with grace 0; and `w017-run.k8s` reads files with `kubectl exec` in the exec namespace, which `factory-exec-no-debug` refuses. | Rows 1 to 21 are facts about Kubernetes: they move to the control namespace (D45) and run with the fake's admission model off. The `kubectl exec` reads become node-side `crictl exec` reads through `inNode` (`cluster.ts:137`), which do not go through the API server. Every edit is in the edits table under "Files". |
| C9 | D13; A-31; W-020's draft ("Restore into a pod waits for ... W-021") | A scoped artifact read from inside a pod arrives with W-021. | The pod's identity is mounted only in the supervisor (`06:110`), and the materializer is an init container with no credential (`job-manifest.ts:53-54`). Serving a bundle to it needs either a credential in the init container, which `06:110` forbids, or the supervisor writing into the shared volume before start, which is a new trusted path. Neither is designed. | Not built here (D48, accepted by the owner, 2026-11-22; the design goes to silvio before W-022's brief). First user is W-022. |
| C10 | `docs/build-log.md:40-41` | W-019's k3s tier is written. | It has not run. This package changes the policy, the admission and the helpers those files run under. | D49: W-019's k3s tier passes once, unchanged, before W-021's step 0. A failure there is W-019's to fix first. |
| C11 | Section 6 residual "local-path does not enforce a claim's size (W-021, W-024)" | W-021 may close it. | Container `ephemeral-storage` limits and `emptyDir.sizeLimit` cover the writable layer and scratch, not a `local-path` claim, which is a host directory. A ResourceQuota counts requested sizes, not use. | Not closed. It stays with W-024 and D4 (a CSI class with enforced capacity). |
| C12 | Section 5 residual; section 6 hand-off ("an admission rule against grace 0") | Refuse a pod delete with grace 0. | The kubelet removes every pod object, after its containers end, with its own delete at grace 0. A rule that refuses grace 0 for everyone leaves every pod Terminating for ever. | The rule refuses a delete whose grace is below the pod's `terminationGracePeriodSeconds` unless the requester is in `system:nodes` (D44); step 0 item 1 shows both halves. |
| C13 | `config.ts:31`, `:108` | One per-pod bucket: burst 5, one every 2 s. | It was sized for one renewal every 10 s. A harness's tool calls through the supervisor would be throttled at once, and would starve the same pod's renewals if they shared it. | The capability route has its own per-pod bucket, and the review budget's sizing counts both (D43). |
| C14 | The assignment's "H4/H6 hand-offs from W-017b" | | No item labelled H4 or H6 exists in the repository, the plan or the commit history (searched today). The W-017b hand-offs to W-021 that do exist are `apps/runner/README.md:249-251` and `m2-plan.md:854`, `:863`: the egress policy for internal and cluster addresses, the ValidatingAdmissionPolicy that backs A-25, and the grace-0 rule. | Treated as those three; all are answered here. **The coordinator should confirm** that H4 and H6 meant these and not items of a review kept outside the repository. |
| C15 | Section 6 hand-off (grace 0); this brief's first `factory-exec-delete` | A pod-`DELETE` rule stops a force delete. | An **eviction** (`CREATE` on `pods/eviction`, with `deleteOptions`) is admitted as a create of the subresource (`pkg/registry/core/pod/storage/eviction.go:152-153`) and then deletes the pod internally with `rest.ValidateAllObjectFunc` (`:193`, `:382`): no pod-`DELETE` policy sees it (security finding M1; read in the Kubernetes source on 2026-11-21, master). | `factory-exec-delete` also matches `CREATE` of `pods/eviction` and refuses `object.deleteOptions.gracePeriodSeconds` below 15, the kubelet's group excepted; step 0 item 1 and conformance row 24 show it, with `deletecollection`. |
| C16 | 21a, grant derivation ("a role with no workspace gets its repository-scoped entries") | Repository grants come from rows. | Neither `execution_allocation` nor `stage_run` has a repository column (`0003_tasks_execution.sql`, both tables); only the workspace row has `repository_id` (`packages/database/src/workspace.ts:12`). And `validateStartRequest` is pure (`start.ts:30-44`), so it cannot see a repository (design finding 3). | Repository grants take `workspace.repositoryId`; **no workspace, no grants** (`knowledge_curator`, whose entries are all repository-scoped, gets none until a later package names a source, P-38). The input-grants check moves into the allocate transaction, after the workspace row is read. |
| C17 | Security finding L2 ("no container mounts both a claim and a projected token") | | W-019's supervisor mounts the claim read-only **and** the token (`job-manifest.ts:64`): the workspace view needs both (section 6). The rule as worded refuses every allocation pod. | The rule is per profile: in an allocation profile only `supervisor` may hold the token, and only with a read-only claim mount; no container holds a read-write claim and a token; in the `checkpoint` profile no container holds both (W-020's D33). "Response to review" says why. |
| C18 | D45 ("a RoleBinding of the runner's Role" in the control namespace) | | A RoleBinding can name a Role of its own namespace or a ClusterRole, never a Role of another namespace (`runner-rbac.yaml:1-25`; design finding 6, security L6). | The control namespace gets its own Role with the same rules, in `deploy/k8s/local/control-namespace.yaml`. |
| C19 | `pod-guard.ts:191` | A workspace denial maps to a code by route. | Only `renew` and `stop-ack` map to `stale_epoch`; any other route, the capability route included, gets `not_startable` (design finding 6). | `capability` joins the `stale_epoch` list; `w021-capability-liveness` asserts the code. |
| C20 | `config.ts:134`; `apps/supervisor/src/args.ts:63` | At most eight deny targets. | Both the runner's configuration and the supervisor's argument parser cap the list at eight. This tier now needs ten, W-023 adds one, and production needs more (design X3, security L7). | The cap moves to one constant, `MAX_DENY_TARGETS = 16`, in `@factory/runner-protocol`, imported by both. That is the one change in `apps/supervisor/src`. |

### Rules

W-017's three rules and W-019's four stand, and W-020's draft adds 8 to 10. Three more:

11. **Authority is derived, never carried.** A grant is a pure function of the allocation, its
    stage run, its workspace and its writer-start record. Nothing a caller sends (a request body, a
    `StageInput`, a grant id, a prompt) can add an operation, widen a resource, lengthen a lifetime
    or raise a limit. Two runners derive the same grants with the same ids.
12. **An allowed call is a row.** A check is allowed only by the commit of its slot, written in one
    statement that also carries the lease, epoch, writer, workspace, task and expiry conditions. No
    count, cache or answer in memory is authority; an in-memory hint may only make a check cheaper.
13. **The cluster refuses what the runner does not render.** Every Job, pod and claim in the exec
    namespace must match a profile the runner renders, created by the identity that renders it.
    Admission is a second line under the runner's own rules, not a replacement for them; each
    admission rule has a test showing the runner never needs the refused request.

### Step 0: the probe

Most of a day on AC power, **after W-019's k3s tier has passed once** (D49), with the pinned k3s image,
W-019's images and hand-written throwaway policies; no W-021 code. Items 1 to 3 and 5 shape the
admission rules of 21b, item 4 the network policy, item 6 the presence check. Each has a named
fallback. If item 1 or item 2 fails, the owner is told before 21b starts.

| # | To show | If it does not hold |
| --- | --- | --- |
| 1 | A ValidatingAdmissionPolicy on `DELETE` of pods sees `request.options`: an admin delete with `gracePeriodSeconds: 0` and one with `1` are refused with the policy's message; one with `15` and one with no options are accepted; **the kubelet's own final delete passes** (the pod object is gone about 15 s after an accepted delete, and no refusal names a `system:node:` requester). The same for `DELETE` of Jobs: no `propagationPolicy`, `Orphan` and `orphanDependents: true` refused; `Background` and `Foreground` accepted. **Eviction** (security M1, C15): an admin `CREATE` on `pods/eviction` with `deleteOptions.gracePeriodSeconds: 0` is refused by the policy bound to that subresource; with `15`, and with no options, the eviction is accepted and the pod ends after its grace. **Control:** with the eviction binding removed, the grace-0 eviction removes the pod object at once while its TERM-ignoring process is still alive (the hazard). **`deletecollection`:** `DELETE` on the pod collection with grace 0 is refused item by item (the policy sees `oldObject` and the options per pod); with grace 15 it is accepted. | Delete or eviction options not visible: that rule cannot be built as a policy on this version; it is dropped from 21b, the residual risks of sections 5 and 6 stand, and a webhook (a new server and its own TLS) is raised with the owner, not built (recommend silvio). `deletecollection` not consulted per item: RBAC (no collection delete for the runner, `runner-rbac.yaml:1`) is the only control, and the residual list says so. |
| 2 | Who the API server says created a Job's pod, who deletes the pods of a Job deleted with `Background`, and **who the pod garbage collector is** (design finding 4): a policy that refuses every pod create, delete and eviction in a throwaway namespace with `messageExpression` naming `request.userInfo.username` and groups shows the Job controller's identity in the Job's `FailedCreate` event and the garbage collector's in the refused delete. For the pod garbage collector: a pod whose node object is deleted (a second, fake `Node` object created by the admin and named in the pod's `nodeName`; the pod never runs) is force-deleted by it at grace 0; record its identity and the refusal. | If the Job controller and the pod garbage collector share one identity (`system:kube-controller-manager`), the pod-create rule names it and also requires a controlling owner reference to a Job, and the grace exemption for it covers every controller; A-41 records both. If the fake-node scenario cannot be produced on one node, the pod garbage collector's identity is taken from the k3s controller-manager's arguments (`--use-service-account-credentials`) and marked inferred. |
| 3 | A policy is consulted for `CONNECT` on `pods/exec` and `pods/attach` and for `UPDATE` on `pods/ephemeralcontainers`: each, by the admin, is refused in the exec namespace. **Control:** the same in the control namespace succeeds. | The rule that is not consulted is dropped; RBAC (the runner has no such right, the supervisor's account has no Role) is the only control, and the residual list says so. |
| 4 | Under a default-deny policy for both `Ingress` and `Egress` on every pod, plus the listener allow rule: from pod A in the exec namespace, a TCP connect to pod B's port in the same namespace, to the cluster DNS service (`10.43.0.10`, UDP and TCP 53) and to `10.88.0.1:55432` and `:57233` all fail; a pod in the control namespace cannot connect to pod B either (ingress); the listener still completes a handshake. **Two listeners** (X3): with a third policy that selects only pods labelled `<prefix>profile: checkpoint` and allows a second port, a pod without that label cannot connect to the second port and a pod with it can, and the labelled pod cannot connect to the first port. The node's own address on 10250 (kubelet) and 6443 is refused from every exec pod. **Control:** the same probes between two pods of the control namespace connect, and DNS answers there. Record refused or timed out for each, and for UDP how a lost answer looks. | If pod-to-pod or DNS is not enforced by this CNI, AC-56's other-task half is not shown at K; the build-log line says so, and the gate gains the reachable targets that a literal list can name. |
| 5 | A policy with `paramKind: ConfigMap` and a binding with `paramRef` reads a space-separated image list (`params.data.images.split(' ')`), refuses a pod whose image is not in it, and accepts one that is; a missing param ConfigMap with `parameterNotFoundAction: Deny` refuses everything. Record the CEL cost the API server reports, if any. | Inline the allowlist into the policy's expressions, rendered per tier (the typed renderer of 21b does this either way); the params ConfigMap is dropped. |
| 6 | The runner's account can `get` the named ValidatingAdmissionPolicies and bindings (cluster scope), the exec namespace object, and the named NetworkPolicies, LimitRange and params ConfigMap in the exec namespace, once a ClusterRole and a Role name them by `resourceNames`; it cannot `list` any of them, cannot `get` another by name, and still cannot write a ConfigMap (row 20). | The presence check is **not built**: 21b adds no `profileCheck` key and `createConfig` requires nothing of it (design finding 5's contradiction removed). The residual "a cluster without the policies can still run pods" stays, covered only by the gate for the network half, and the build-log line says so. |

Recorded, not relied on: whether the LimitRange's `max` without a `default` sets a pod's missing
limits to the maximum before validation runs (mutating admission runs first). The runner renders
every request and limit itself and the policy requires them, so the answer changes what a pod
created by someone else would look like, not what is admitted from the runner.

### The parts, and where each runs

| Part | Runs in | Touches |
| --- | --- | --- |
| Role table (`@factory/domain`, `capabilities.ts`): role to operations and side effects, role to role class | Imported by the runner (and, until it is deleted, nothing else) | Nothing. Pure. |
| Grant derivation (`apps/runner/src/capability/grants.ts`) | The runner process | The allocation, stage run, workspace and writer-start rows it is given. Pure over them. |
| The proxy (`src/capability/proxy.ts`) and its slot statements (`packages/database/src/capability.ts`) | The runner process | `audit_event` (insert and primary-key reads), a row share lock on the allocation, a transaction advisory lock per grant. |
| The capability route (`POST /pod/v1/capability/check`) | The listener | The guard, then the proxy. |
| Profile identity in the guard | The runner process | The reviewed username against `execution_allocation.supervisor_identity`. |
| Profile renderer (`src/profiles/render.ts`) and its print entry | The runner process at start-up (presence check); `scripts/k3s.sh` through the entry (apply) | Nothing; a pure function of `RunnerConfig`. |
| Admission policies, network policies, LimitRange, service accounts | The cluster's API server and CNI | Every request in the exec namespace. |
| Start-up and periodic presence check | The runner process | `get` by name on four objects. |
| `FakeKube` admission model | The test process | Memory. Off by default; must agree with the cluster on every conformance row it models (rows 22 to 26). |

### 21a: grants, the durable counter and the capability route

**The role table** moves from `apps/api/src/auth/capability-proxy.ts:17-27` to
`packages/domain/src/capabilities.ts`, unchanged in content, keyed by the contract's `Role` enum
(`domain.schema.json` `$defs` `Role`: the same nine roles as `StageRole`). It adds, per role, its
role class (D42) and, per operation, the default `maxCalls` (A-45). A function
`assertNoDeliveryGrant(table)` throws if any entry has a side effect other than `read` or
`workspace_write`, or an operation matching `push|merge|deploy|credential|release`; the domain test
runs it on the real table and on a planted bad one.

**Grant derivation** (`deriveGrants(rows)` in `src/capability/grants.ts`, pure):

- Input: the allocation row, its stage run (for `role`), its workspace row (for `id` and `repositoryId`), and its writer-start record (`records.ts:31-35`, `created_at` read with it). No writer-start record: no grants. That is the "no supervisor was ever granted" case of section 6, so a check in `starting` has nothing to match even before the state test refuses it.
- One grant per role-table entry: `grantId = v8Uuid(['factory-capability-grant/1', org, allocationId, String(ownerEpoch), operation, resourceId])` (`names.ts:32-38`); `resourceIds: [workspaceId]` or `[repositoryId]` as the entry says; `environmentScope: 'task-workspace'`; `sideEffect` from the entry; `allocationEpoch: ownerEpoch`; `maxCalls` from the entry, capped by `capabilities.maxCallsCap` (default 10,000); `expiresAt` = the writer-start record's `created_at` plus the stage run's `limits.wallSeconds`, computed in SQL and returned as text, never from the process clock.
- **No workspace, no grants** (C16, design finding 3). Repository-scoped entries take `repositoryId` from the workspace row (`packages/database/src/workspace.ts:12`); neither the allocation nor the stage run has a repository column. An allocation with `workspace_id` null gets no grants at all, so `knowledge_curator`, whose entries are all repository-scoped, gets none in M2 (P-38 records where a source would come from).
- `CapabilityGrant` validation: every derived grant passes `validateContract('CapabilityGrant', g)`; a failure is a hard error.
- Two runner instances, or one before and after a restart, derive equal arrays (deep equality, ids included). A new epoch derives new ids, so a replaced writer's counters start at zero and the old epoch's slots can never be spent again (race rule 7).

**`StageInput.capabilityGrants`** (D39). The contract requires the field (`domain.schema.json:844`,
`:886`) and `07:38` says run input carries the grants. From W-021 it carries no authority:
the allocate step gains one check, **inside the allocate transaction, after the workspace row is
read** (`allocateOnce`, `start.ts:58`, after the workspace's share lock at `:86`; `validateStartRequest`, `:30-44`, is pure and cannot see a
repository, C16). Every listed grant must name an `operation`, `sideEffect` and `environmentScope`
that the role table gives the input's `role`, with resources drawn from the workspace row's `id`
and `repositoryId`; otherwise `invalid_request` ("the input lists a capability the role does not
have"), and the transaction rolls back with nothing created. With no workspace, only an empty list
is accepted. An empty list is always accepted. The ids, `expiresAt` and `maxCalls` in the input are ignored; the derived grant is what
the proxy uses. So a caller that lists too much is refused before anything is created, and one that
lists too little narrows nothing (SI-43). `ac-11-run-identity-conflict.test.ts:58` (3,000 grants) is
still refused first by the size cap.

**The slot** (D40). One allowed call is one `audit_event` row:

| Field | Value |
| --- | --- |
| `id` | `v8Uuid(['factory-capability-slot/1', org, grantId, String(n)])`, `n` from 1 to `maxCalls` |
| `actor_id` | the reviewed username (the profile's service account subject) |
| `action` | `capability.<operation>` (as W-008) |
| `resource_kind`, `resource_id` | `capability`, the requested resource id |
| `outcome` | `allowed` |
| `correlation_id` | `capability-slot:<grantId>` |
| `request_digest` | the caller's 64-hex digest of its tool request (never interpreted) |
| `details_ref` | `{ grantId, slot: n, callId, epoch, podUid, role, environment }` |

Beside each slot, in the same statement's transaction, one **call marker**: an `audit_event` row at `v8Uuid(['factory-capability-call/1', org, grantId, callId])`, action `capability.call`, outcome `allowed`, `details_ref` `{ grantId, slot: n }`. `callId` is the caller's UUID for one tool call (W-075's `factory_tool_call.call_id`). A retry with the same `callId` finds the marker by primary key and gets the same slot back, spending nothing (race rule 4).

The proxy takes a slot in **one short transaction of its own** (`withTenant`, as `capability-proxy.ts:71`), which does nothing but steps 0 to 4 and commits. **Lock order: the grant's advisory lock, then the allocation row.** No transaction anywhere takes the allocation row and then a grant's advisory lock: cancel, the passes and renewals never take the advisory lock, so no cycle exists (design finding 2).

0. The call marker, by primary key: present means this `callId` already holds a slot; answer it again (allowed, same slot) and stop. Read again under the lock in step 1 before any insert.

1. `pg_advisory_xact_lock(hashtextextended('factory-capability/' || org || '/' || grantId, 0))`, as the capacity stand-in locks a pool (`allocation.ts:212-214`). Checks of one grant are then serial across replicas; checks of different grants are not.
2. Find the first free slot by primary-key probes only (`audit_event` has no other index, `0005:165-174`, and this brief adds none): with an in-memory hint `h` for the grant, probe `h` (must exist) and `h + 1` (must not); on any surprise, or no hint, binary-search `[1, maxCalls]`, at most `ceil(log2(maxCalls)) + 1` probes. Slots are only ever taken in order under the lock, so the boundary is exact. All slots used: `call_limit`, no row.
3. **The slot statement**: `INSERT INTO factory.audit_event (...) SELECT ... FROM factory.execution_allocation a JOIN factory.stage_run s ... JOIN factory.task t ... WHERE a.org_id = $1 AND a.id = $2 AND a.owner_epoch = $3 AND a.pod_uid = $4 AND a.state IN ('running','suspect') AND a.controller_lease_until > clock_timestamp() AND t.status = 'running' AND (a.workspace_id IS NULL OR EXISTS (<the renewal's workspace clause, allocation.ts:180-181>)) AND clock_timestamp() < $expiresAt::timestamptz FOR SHARE OF a ON CONFLICT (org_id, id) DO NOTHING`. One row written: allowed. Rule 4 is applied as W-019 applies it: the lease condition is in the statement that grants. `FOR SHARE OF a` makes a concurrent transition wait for this commit, so a cancel is ordered strictly before or after the call (race rule 4).
4. No row written: re-read the row in the same transaction to classify, in this order: gone or another pod (`not_this_job`), epoch (`stale_epoch`), state (`not_live`, with the state), lease (`lease_expired`), workspace (`stale_epoch`, `workspace`), task (`task_not_running`), expiry (`grant_expired`). A conflict on the slot id under the lock is a hard error (`record_conflict`): the lock was bypassed.

`FOR SHARE` needs `UPDATE` on at least one column, which the runtime role has on
`execution_allocation` (it makes every transition today); `audit_event` stays insert-only for it
(`0010:146-147`), so a slot cannot be updated or deleted by the runtime, and the retention role
can only insert there (`0013:12`).

**A denied check** writes one `audit_event` row with a random id, outcome `denied`, through the
guard's per-pod audit bucket (`pod-guard.ts:142-148`); over the cap it is counted in memory, as
W-019's denials are (SI-46). It never writes a slot. Matching is exact: `operation`, a `resourceId`
in `resourceIds`, and `environmentScope`; no grant matches: `no_grant` with the operation, never a
hint of what would match.

**The capability route.** `POST /pod/v1/capability/check`, behind the same admission order as the
permit routes (section 6, steps 1 to 7), through the generalised review (decided 2026-11-21, X2):
`review(req, { audience, subjects, bucket })`. Each listener passes its own subject set: the pod
listener the three allocation profiles' accounts, **never the checkpoint account**; W-020's
checkpoint listener the checkpoint account only. The bucket names which per-pod bucket the call
spends (`renew`, `capability`, or the checkpoint listener's).

- `@factory/runner-protocol` gains `ROUTES.capability`, `CapabilityRequest { orgId, allocationId, epoch, callId, operation, resourceId, environment, requestDigest }` (`callId` a UUID, required) (operation and environment `^[a-z][a-z0-9._-]{0,63}$`, resource id at most 256 bytes, digest 64 lower-case hex), `CapabilityAnswer` (`{ allowed: true, grantId, slot, remaining }` or `{ allowed: false, code, reason? }`), `CapabilityDenialCode` (`no_grant`, `grant_expired`, `call_limit`, `not_live`, `lease_expired`, `task_not_running`, plus every `PermitDenialCode` the guard can answer), parsers with the same own-keys rule, committed vectors, and `statusOf` for the new answer (200 allowed, 403 a refused decision, the guard's statuses as today).
- The guard runs with `NEED_CAPABILITY = { route: 'capability', states: ['running','suspect'], stateDenial: 'not_renewable', claimable: false, workspace: 'writer_active' }`. Its row reads are advisory; the slot statement decides.
- **Its own per-pod bucket** (D43), `capabilityPodRate` (default burst 20, one every 400 ms), keyed by the reviewed pod UID, after local verification and before the shared review budget, so a pod's tool calls cannot spend its own renewals' allowance.
- **The shared review budget counts every listener** (X4). `reviewRateForWriters` (`config.ts:63-69`) becomes `2 × (podRate + capabilityPodRate) × liveWriters + 2 × checkpointPodRate × liveChildren`, where `checkpointPodRate` is the checkpoint listener's per-pod rate (W-020's setting) and each pass counts live children as it counts live writers. Configuration refuses `2 × (podRate + capabilityPodRate) × P + 2 × checkpointPodRate × P > review.ceilingPerSecond`, with `P = pools.authoring + pools.verifier` (at most one live child per finalizing parent, and parents are within the pools). With the defaults and a checkpoint rate of one every 2 s: `2 × (0.5 + 2.5) × 20 + 2 × 0.5 × 20 = 140`, under the ceiling of 200. The ceiling goes to P-14's load test with the other rates, and P-33 records what W-075 must measure.
- Every check is reviewed; there is no review cache (D43).
- The route answers and does nothing after: no reconcile pass is set off.

**The in-process proxy** (`CapabilityService.check(req)` and `takeSlot(req)`, both in
`src/capability/proxy.ts`; corrected after both reviews: design 2, security M2). The route calls
the first; a later runner route that performs a remote side effect itself (W-075's tools and
proposals, W-022) calls the second. **`takeSlot` takes the slot in its own short transaction and
commits before it returns; no caller may pass its own transaction, and none may perform an effect
inside it.** That is rule 1 (no remote call inside a transaction), and it keeps the allocation's
share lock as short as the slot statement, so a cancel, a stop or W-119's emergency stop is never
held behind a remote call the harness can slow down. The rule W-075 must follow is under
"Hand-offs": slot first, keyed by `factory_tool_call.call_id`; effect after the commit; outcome in a
separate transaction.

**Profile identity in the guard** (D42).

- `RunnerConfig` gains `profiles: Record<ProfileName, { serviceAccount: string }>` for `authoring`, `read_only`, `verifier` and `checkpoint`, defaulting to `factory-allocation-supervisor`, `factory-sup-read-only`, `factory-sup-verifier` and `factory-checkpoint`. **`profiles.checkpoint` is the one key for the checkpoint account**, which W-020 uses too (decided 2026-11-21, X2); W-020's `config.checkpoint.serviceAccount` does not exist. `supervisorServiceAccount` becomes the `authoring` entry (kept as an alias so W-017's and W-019's tests read the same value).
- `start.ts:103` stores the subject of the stage role's profile in `supervisor_identity`; `job-manifest.ts:74` renders that profile's `serviceAccountName`.
- `verifyTokenLocally` (`token.ts:19`, `:108-112`) and the TokenReview check (`pod-guard.ts:134`) take the subject set the listener passes to `review` instead of one subject. For the pod listener that set is the `authoring`, `read_only` and `verifier` accounts and never `checkpoint`, so a child's token is refused on every pod route by subject, before its audience is even compared (a test shows it).
- The workspace-denial mapping (`pod-guard.ts:191`) gains `capability` beside `renew` and `stop-ack`, so a fenced workspace answers `stale_epoch` on the capability route (C19).
- After the row read, `who.username !== a.supervisorIdentity` is `not_this_job`, reason `identity`, audited under the cap. A token of the right audience minted for another profile's account (only an admin can mint one) is therefore refused, as is a pod rendered under one profile and admitted under another.
- **Read-only profile:** the harness's workspace mount is `readOnly: true`; the materializer init container's stays read-write. W-019's container-exit and proof rules are unchanged.

**Retirement of the W-008 proxy** (D41). `apps/api/src/auth/capability-proxy.ts` and its export
(`apps/api/src/index.ts:6`) are deleted; `apps/api/test/ac-19-unauthorized-tool-request.test.ts`
is replaced by `apps/runner/test/ac-19-capability-proxy.test.ts`, which keeps every one of its
cases (the six injected attempts, the never-minted delivery grants, limit, lifetime, epoch and
state) against the runner's proxy, and adds restart and replica. A structural test shows no file
under `apps/*/src` other than `apps/runner/src/capability/` defines a capability check, with a
planted file as its control. Nothing else imports the deleted module (searched today: only the
test and the index).

**Config added** (`src/config.ts`): `profiles`, `capabilityPodRate`, `capabilities: { maxCallsCap }`,
and, in 21b, `profileTier`, `listenerReach`, `profileCheckIntervalMs` (there is no switch to turn
the presence check off: if step 0 item 6 fails it is not built at all). Validation gains: every
profile account a valid DNS label and distinct; `maxCallsCap` between 1 and 10,000; the product
above; and `createConfig` refuses the namespace `factory-exec-control` (security L6), so a
production runner can never be pointed at the control namespace.

### 21b: the execution profiles

**Profiles** (D42). A profile is chosen by the stage role's class in the role table, or, for
`checkpoint`, by W-020's child renderer; the runner renders it and nothing else can choose it.

| Profile | Roles (from the role table) | Service account (`profiles.<name>`) | Containers and images | Workspace mounts | First real user |
| --- | --- | --- | --- | --- | --- |
| `authoring` | `criteria_author`, `implementer`, `adversarial_tester` (roles with `workspace.write`) | `factory-allocation-supervisor` (unchanged) | init `materialize` (`images.materializer`); `supervisor` (`images.supervisor`); `harness` (`images.harness`) | `materialize` read-write; `supervisor` read-only; `harness` read-write | W-077 |
| `read_only` | `discovery`, `planner`, `reviewer`, `publisher`, `knowledge_curator` | `factory-sup-read-only` | as `authoring` | as `authoring`, but `harness` read-only | W-025 onward |
| `verifier` | `verifier` | `factory-sup-verifier` | as `authoring` | as `read_only` | W-022 |
| `checkpoint` | none: W-020's child | `factory-checkpoint` | init `read` and container `build`, both `images.checkpoint` (`factory-checkpoint`, by digest) | `read`: the claim read-only; `build`: none | W-020 |

The renderer adds one label, `<prefix>profile: <name>`, to every Job and its template (W-020's
child Job included); admission ties it to the account, the containers, the images and the network
policy. The account for each profile has one home, `profiles.<name>` (decided 2026-11-21, X2).
W-020 renders the child Job itself; it reads `profiles.checkpoint`, `images.checkpoint` and the
label key from this configuration.

**The checkpoint profile, exactly** (X1; the child shape W-020 specifies, fixed by the coordinator
on 2026-11-21). Every rule below is checked by `factory-exec-create` for a pod or Job whose profile
label is `checkpoint`, and only for those:

- Service account `profiles.checkpoint`; `automountServiceAccountToken: false`; **no `fsGroup`** (W-020's C9); `runAsNonRoot`, `RuntimeDefault` seccomp; grace 15; `restartPolicy: Never`; `enableServiceLinks: false`; `shareProcessNamespace` absent or false.
- Exactly one init container, `read`, and exactly one container, `build`. Both run `images.checkpoint` and nothing else (the name-to-image tie below).
- Both have `readOnlyRootFilesystem`, no privilege escalation, all capabilities dropped, and requests and limits for `cpu`, `memory` and `ephemeral-storage` (`profiles.checkpoint.resources`, which W-020 sizes from its caps; design finding 8 on W-020).
- Volumes, and only these: the claim (`persistentVolumeClaim` with `readOnly: true`), `export` and `work` (`emptyDir` with `sizeLimit`), one private `/tmp` per container (`emptyDir`), and `factory-identity` (`projected`: a `serviceAccountToken` and the CA `configMap`).
- `read` mounts the claim (`readOnly: true`), `export` read-write and its own `/tmp`. It mounts no token.
- `build` mounts `export` **read-only**, `work`, its own `/tmp` and `factory-identity`. It mounts no claim.
- The token's audience is `'factory-checkpoint:' + <the child id label>` (the coordinator's form; see "Response to review", open item 1), `expirationSeconds` at most 600, and only `build` mounts it.
- Claim name: the one W-020's renderer names for the parent's generation. Admission cannot recompute it (the name is a hash, and a policy has no SHA-256), so it is tied by consistency only: the claim volume is the pod's only `persistentVolumeClaim` volume. This is the same limit as for allocation pods (security L5).

**The renderer** (`src/profiles/render.ts`, `renderProfiles(config)`, pure, D47). It returns the
objects below, named and ordered, and `src/profiles/print-entry.ts` writes them as one JSON `List`
for `kubectl apply -f -`. A committed fixture, `apps/runner/test/fixtures/profiles.expected.json`,
pins the output for the default test configuration, as `job.expected.json` does for the Job,
**including the checkpoint profile's rules, its egress policy and its allowlist entries**.
Configuration gains `profileTier: 'local' | 'cluster'` and `listenerReach`: `{ kind: 'ipBlock',
address }` (local: the podman host gateway, A-32) or `{ kind: 'pods', namespace, labels }` (a
runner inside the cluster, A-43). `createConfig` refuses `profileTier: 'local'`.

| Object | Content |
| --- | --- |
| ServiceAccounts `factory-sup-read-only`, `factory-sup-verifier` | `automountServiceAccountToken: false`, no Role, as `service-accounts.yaml:12-17`. The checkpoint account is W-020's file (`deploy/k8s/checkpoint-sa.yaml`), whose name must equal `profiles.checkpoint`'s default; `w021-profiles-render` checks it. |
| NetworkPolicy `factory-exec-default-deny` | `podSelector: {}`, `policyTypes: [Ingress, Egress]`, no rules. Every pod of the namespace is isolated both ways: no other task's pod can reach it, it can reach nothing. |
| NetworkPolicy `factory-exec-egress-listener` | `podSelector` with `<prefix>profile In [authoring, read_only, verifier]`, `policyTypes: [Egress]`, one rule: `listenerReach` (an `ipBlock` `/32`, or a `namespaceSelector` and `podSelector`) **and** `podListener.port`, TCP. Never a whole host, so W-023's port and the checkpoint port on the same runner stay denied to allocation pods (section 6 hand-off; security M3). It replaces `deploy/k8s/local/egress-listener-only.yaml`, which is deleted with the line W-020 adds to it. |
| NetworkPolicy `factory-exec-egress-checkpoint` | `podSelector` with `<prefix>profile: checkpoint`, `policyTypes: [Egress]`, one rule: `listenerReach` **and** the checkpoint listener's port (W-020's `checkpointListener.port`), TCP. A checkpoint pod reaches that port and nothing else, not even the pod listener (X3, decided 2026-11-21). A harness pod cannot wear the label: admission ties it to the checkpoint account and the checkpoint image. |
| LimitRange `factory-exec-limits` | `Container` `max` of CPU, memory and ephemeral storage at the largest configured container limit across the four profiles; `PersistentVolumeClaim` `max` storage at `pvcSize`. No `default` (recorded at step 0). |
| ValidatingAdmissionPolicy and binding `factory-exec-create` | `CREATE` of `jobs`, `pods`, `persistentvolumeclaims`. Rules below. |
| ValidatingAdmissionPolicy and binding `factory-exec-update` | `UPDATE` of `pods` (not its `status` subresource): every container's and init container's image equals `oldObject`'s (security L3). Labels, annotations and finalizers may still change (the Job controller removes its tracking finalizer that way). |
| ValidatingAdmissionPolicy and binding `factory-exec-delete` | `DELETE` of `pods` and `jobs`, and `CREATE` of `pods/eviction` (C15). Rules below. |
| ValidatingAdmissionPolicy and binding `factory-exec-no-debug` | `CONNECT` of `pods/exec`, `pods/attach`, `pods/portforward`; `UPDATE` of `pods/ephemeralcontainers`. Refuses every request. |
| ConfigMap `factory-exec-admission-params` | The image allowlist, one key per container name (below). Written by whoever installs the profiles, never by the runner. |

Every binding: `matchResources.namespaceSelector` on `kubernetes.io/metadata.name` equal to the
exec namespace, `validationActions: [Deny]`, and the policy's `failurePolicy: Fail` (a CEL error or
a cost overrun refuses). `factory-exec-create` and `factory-exec-update` take `paramKind:
ConfigMap` with a binding `paramRef` to `factory-exec-admission-params` and
`parameterNotFoundAction: Deny` (step 0 item 5). The ConfigMap is written by whoever installs the
profiles (`scripts/k3s.sh` here; the operator on a real cluster), never by the runner, which keeps
no ConfigMap write right (conformance row 20).

**`factory-exec-create`, rule by rule.** One variable, `spec`, is the pod spec of a pod or the
template spec of a Job, so the pod rules are checked at both: at the Job, so a bad Job is refused
when the runner creates it instead of leaving it without pods; at the pod, because that is what runs.
A second variable, `profile`, is the profile label; a pod or Job without one, or with an unknown
one, is refused.

- **Who** (A-25, D44): a Job or a claim only from the runner's account (`request.userInfo.username`); a pod only from the Job controller's identity (step 0 item 2), with exactly one controlling owner reference, of kind `Job`.
- **Job:** `backoffLimit == 0`, `activeDeadlineSeconds` set, `manualSelector` not true, template labels carry the profile label and either the allocation label (allocation profiles) or the child label (`checkpoint`).
- **Pod spec:** `serviceAccountName` is `profiles[profile]`; `automountServiceAccountToken == false`; `terminationGracePeriodSeconds == 15`; `restartPolicy == 'Never'`; `enableServiceLinks == false`; `shareProcessNamespace` absent or false; `fsGroup` 10001 in allocation profiles and absent in `checkpoint`.
- **Pod security, repeated here** (security L4): `hostNetwork`, `hostPID` and `hostIPC` absent or false; `runAsNonRoot` true at pod level; `seccompProfile.type == 'RuntimeDefault'`; and for every container `privileged` absent or false, `capabilities.drop == ['ALL']`, no `capabilities.add`. The namespace's Restricted labels still apply; this makes them a second line, not the only one.
- **Containers by name, and each name tied to its image** (security L2): the container and init-container names are exactly the profile's set (table above), and each container's image is in the allowlist entry **for its own name** (`params.data['images.' + c.name].split(' ')`). A `supervisor` container running the harness image, or a `harness` running the supervisor image, is refused.
- **Every container and init container:** `readOnlyRootFilesystem == true`, `allowPrivilegeEscalation == false`; requests and limits for `cpu`, `memory` and `ephemeral-storage`; no `hostPort`; no `envFrom`, and no `env` entry with a `valueFrom.secretKeyRef`.
- **Volumes:** only `persistentVolumeClaim`, `emptyDir` (default medium, with `sizeLimit`) and `projected`, whose sources are only a `serviceAccountToken` and a `configMap` source of the CA. That excludes `hostPath`, `secret`, `csi`, `ephemeral` and any runtime socket by construction (`09:75`). At most one `persistentVolumeClaim` volume.
- **The token** (security L5): an allocation pod's audience equals `'factory-allocation:' + <org label> + ':' + <allocation label>` (the labels hold the full ids, `job-manifest.ts:26-33`), so a token cannot be rendered for another allocation's audience; `expirationSeconds` at most 600.
- **Who may hold the token and a claim** (security L2, as amended in C17): in an allocation profile only `supervisor` mounts the token, and its claim mount is read-only; no container anywhere mounts a read-write claim and the token; in `checkpoint` no container mounts both (above).
- **Profile mounts:** in a `read_only` or `verifier` pod the harness's workspace mount is read-only.
- **Claim:** `accessModes == ['ReadWriteOncePod']`, the configured class, the configured size; and `volumeName`, `dataSource`, `dataSourceRef` and `selector` absent (security L5), so a claim can neither bind a chosen volume nor be cloned from another.
- **Tier:** in a `cluster` rendering one more rule requires every allowlisted entry to match `^[^@]+@sha256:[0-9a-f]{64}$` (security L4), so a tag cannot be admitted even from a hand-edited allowlist (D46).

**`factory-exec-delete`.**

- A pod delete whose `request.options.gracePeriodSeconds` is below the pod's `oldObject.spec.terminationGracePeriodSeconds` is refused unless the requester is in the group `system:nodes` (C12; the kubelet's final delete) **or is the pod garbage collector** (design finding 4; identity from step 0 item 2). Why the exemption, not a refusal: the garbage collector force-deletes only pods whose node is gone, or that are terminating on a node marked out of service. Refused, such a pod object would stay for ever, and nobody else could remove it, since admission refuses the administrator too; W-019's proof already treats a pod gone with its node as not proved (`writer_node_missing`, section 6), so the exemption changes no proof. The out-of-service case stays in section 6's residual list.
- The same rule for `CREATE` of `pods/eviction` (C15, security M1): refused when `object.deleteOptions.gracePeriodSeconds` is below 15 (every pod in the namespace has grace 15, so the policy needs no lookup), with the same exemptions. An eviction with no options, or with 15, is admitted: a drain still works, and the pod ends through its grace period like any other stop.
- `deletecollection` of pods reaches the same rule once per pod (to confirm, step 0 item 1).
- A Job delete whose `request.options.propagationPolicy` is absent or `Orphan`, or whose `orphanDependents` is true, is refused.
- The runner's own deletes already send grace 15 and `Background` (section 2, conformance rows 3 and 14; `w017-kube-client.test.ts:130-131`), so no runner path is refused (rule 13).

**What admission does not police**, stated in the README: `UPDATE` of Jobs and claims, and of pods
beyond their images and ephemeral containers (a cluster admin can still lower a deadline or relabel
a pod); claim deletes; anything outside the exec namespace; and **`nodes/proxy`**, through which a
caller with that right can exec into a container through the kubelet without touching
`pods/exec` (security L3). Nothing in the factory holds `nodes/proxy`; the README says an operator
must not grant it.

**Image allowlist** (D46). The renderer writes `factory-exec-admission-params`: one key per
container name, `images.<name>`, each a space-separated list. `cluster` tier: the params keys `images.supervisor`,
`images.harness`, `images.materialize`, `images.read` and `images.build` each hold exactly one
configured digest (`config.ts:172` already requires digests; `images.read` and `images.build` both
hold `images.checkpoint`). `local` tier: the same keys, plus the stub, materializer-test and
scripted-harness images `scripts/k3s.sh` builds, each under the container name it runs as (the
scripted images under `harness` only; A-44). The scripted label of A-33 is therefore enforced by
where those names can appear: only in a `local` rendering, which `createConfig` refuses.

**Start-up and periodic presence check** (D47). In production, at start and every
`profileCheckIntervalMs` (default 300,000), the runner `get`s by name: the four policies and their
bindings, the **three** network policies, the LimitRange, the exec namespace object (its Pod
Security labels) and the params ConfigMap (its data; security L4). It compares each to the rendered
one after the API server's defaults (as `templateDifferences` does for a Job,
`job-manifest.ts:226-231`). **Failure modes** (design finding 5):

| Answer | At start | While running |
| --- | --- | --- |
| Every object present and equal | Start | Nothing |
| 404, or a spec, label or data difference | Refuse to start, naming the object | `startOrAttach` refuses new work with `profiles_missing`, and the pass warns. **For a network policy only**, every live allocation is also stopped (`→ stopping`, reason `policy_missing`), because its pods are then exposed. A missing admission object stops nothing: admission acts on new requests only. |
| 403, 5xx, timeout or transport error | Refuse to start (the runner cannot show the cluster is protected) | Warn and retry at the next interval. Three failures in a row refuse new work as above; **nothing is ever stopped on an error that is not a 404 or a difference**, so an API blip cannot stop every writer. |

The port gains `getAdmissionPolicy`, `getAdmissionPolicyBinding`, `getNetworkPolicy`,
`getLimitRange`, `getNamespace` and `getConfigMap`; RBAC gains `get` with `resourceNames` on
exactly those objects (a ClusterRole rule for the two policy kinds and the namespace, a Role rule
for the network policies, the LimitRange and the one ConfigMap). The runner still has no ConfigMap
write right (row 20). If step 0 item 6 fails, none of this is built (its fallback).

**The real deny-target list.** On this machine: the API service (`10.43.0.1:443`),
`169.254.169.254:80`, `192.168.127.254:55432` and `:57233` (W-019's four, `supervised.ts:13-16`),
`10.88.0.1:55432` and `:57233` (reachable from a pod with no policy, W-019 step 0 item 1), the
cluster DNS service on TCP 53 (read from the `kube-dns` Service by the test rig), the node's own
address on 10250 (kubelet) and 6443 (security L7; read from the node's status by the rig), and
the checkpoint listener's address and port, which allocation pods must not reach (X3): **ten**.
The cap rises from 8 to 16 (C20), so W-023's port fits too. Production: `createConfig` with the
gate `required` also refuses a deny list without `169.254.169.254:80`; the rest are INT-05's
addresses (databases, workflow frontend, the node's kubelet, every other port of the runner's
host), and W-023 adds its own port (hand-off). **What cannot be shown:** the gate tests only what
it lists, and sixteen literal targets cannot list every port of every host; a cluster with more
than sixteen addresses to deny relies on the policy for the rest, and the gate shows only that
listed rules are active (D11). The checkpoint child runs no gate (it has no supervisor), so its
egress policy is shown only by `w021-network.k8s` and step 0 item 4.

**D24's `disabled`.** Step 0 item 5 of W-019 held, so the fallback that allowed `disabled` at K is
not needed. A structural test (`w021-no-disabled-gate`) fails if any `*.k8s.test.ts`, or anything
under `apps/runner/test/k8s/`, sets the gate to `disabled`, with a planted file as its control.
`disabled` remains for the fake tier only.

**The control namespace** (D45, local only). `deploy/k8s/local/control-namespace.yaml`:
`factory-exec-control`, Restricted pod security as the exec namespace, `factory-allocation-supervisor`
there, **its own Role `factory-runner` with the same rules as the exec namespace's** and a
RoleBinding to it (a RoleBinding cannot name another namespace's Role, C18). No network policy, no
admission binding, no profile, no params. Only the k3s test driver uses it: **conformance rows 1 to
21**, which are facts about Kubernetes and break the exec namespace's rules on purpose (C8; the
cluster-only RBAC rows 13, 15, 19, 20 and 21 still ask their questions about the exec namespace,
and row 13 is asked again for the control namespace's Role), and every positive control that needs
a pod the exec namespace would refuse or isolate. `scripts/k3s.sh up` applies it; `createConfig`
refuses it as a namespace (security L6); nothing outside `deploy/k8s/local/` and the k3s test
helpers names it, and a test checks that.

**The fake's admission model** (`kube/fake.ts`). Off by default, so the fake tier's existing W-017 and W-019
files, which build pods and Jobs of their own shape, are untouched (design finding 1). It is on in the
W-021 files that need it and in conformance rows 22 to 26. A property test shows that every Job and
claim the runner renders, for every profile (W-020's child Job included, from its renderer), passes
the model, so turning it off elsewhere hides nothing the runner makes.

**`scripts/k3s.sh up`** gains, after the CA ConfigMap: run the print entry with `profileTier:
local`, both listeners' addresses and ports, and the images it built; apply the List (the params
ConfigMap with it); apply the control namespace; wait for the new service accounts as it waits for
the old (`k3s.sh:153`). The old `sed` of the local policy (`:166-167`) goes, with W-020's second
port line in it; the checkpoint port now reaches the cluster through the rendered
`factory-exec-egress-checkpoint`. `down` is unchanged.

### Threat model: a hostile harness in the pod

The attacker runs arbitrary code as uid 10001 in the `harness` container, from the moment the
launcher starts the program, for the rest of the pod's life. It shares the pod's network with the
supervisor, writes the workspace, and can read everything the harness container mounts. It does
not hold the supervisor's token, which is mounted only in the supervisor container
(`job-manifest.ts:64`), and it cannot see the supervisor's processes (`shareProcessNamespace:
false`, `:75`). Out of scope: a cluster administrator, a compromised node or kernel, and the
container escape that `09:75` says containers alone do not prevent (a sandbox runtime, D4).

| # | It tries to | What stops it | Shown by |
| --- | --- | --- | --- |
| T1 | Call the capability route itself | No token: 401, charged to its source before any review (section 6, step 3). | `w021-capability-route` |
| T2 | Get the supervisor to ask on its behalf for something the role lacks (through W-075's local tools later, or by text in a request) | Grants come from rows (rule 11); the request's text is only a digest; no role has a delivery grant. | `ac-19-capability-proxy` |
| T3 | Spend another task's limits, or reach another allocation's grants | A token is bound to one allocation's audience; grant ids include the allocation and epoch; slots are per grant. | `w021-durable-counter`, `w021-profile-identity` |
| T4 | Exhaust its own grant | It can: that is the limit doing its job. The stage then fails its own tool calls; no other stage is affected. | `w021-durable-counter` |
| T5 | Flood the route to starve renewals or the shared review budget | Its own per-pod capability bucket before the review budget; the renewal bucket is separate (D43). | `w021-capability-route` |
| T6 | Make a stale or cancelled writer's call count | The slot statement carries the lease, epoch, writer, workspace and task conditions and a share lock (rule 12). | `w021-capability-liveness` |
| T7 | Reach the API server, metadata, Postgres, Temporal, DNS, the node's kubelet or another port of the runner's host | Default-deny egress with one allow rule for its profile (the pod listener's address or runner pods, and that port only). The start-up window (SI-15) is covered by the gate, which now lists ten targets here. | `w021-network.k8s`, W-019's gate files |
| T8 | Reach, or be reached by, another task's pod | Default-deny ingress and egress on every pod of the namespace. | `w021-network.k8s` |
| T9 | Write where it should not | Read-only root; read-only workspace in `read_only` and `verifier` profiles; `emptyDir` size limits; ephemeral-storage limits. Not the claim's size on `local-path` (C11). | `w021-profiles.k8s`, residuals |
| T10 | Exhaust process ids or memory of the node | Memory and CPU limits per container. Process ids are bounded only by the node's `podPidsLimit`, which this brief does not set (P-35). | Residual |
| T11 | Use a leaked or copied token from a log or the workspace | The token is never in the harness's mounts, never logged (section 6), expires in 600 s, and is refused once its pod is gone (section 2's review timing). | Section 6's tests |
| T12 | Get a pod of its choice created, kept alive or changed | It holds no Kubernetes credential (automount off, `09:75`). In the namespace, even an administrator's pod create, force delete, grace-0 eviction, orphaning Job delete, image change on a live pod, exec or ephemeral container is refused (rule 13). Not covered: `nodes/proxy`, which nothing in the factory holds ("What admission does not police"). | `w021-admission.k8s` |
| T13 | Have a test image run in production, or the right image in the wrong container | Only digest-pinned images listed for the `cluster` tier are admitted, each only under its own container name, at create and at update (D46). | `w021-profiles-render`, `w021-admission.k8s` |
| T14 | Grow the audit table without bound | Allowed rows are at most the sum of the grants' `maxCalls` per allocation epoch; denied rows are capped per pod (W-019). | `w021-durable-counter`, `w019-pod-rate` |
| T15 | Reach the checkpoint listener, to hold its few connections and starve every child's upload (security M3 on W-020) | Allocation pods are not selected by `factory-exec-egress-checkpoint`, and the default-deny refuses the port; the gate lists it as a deny target. A pod cannot wear the checkpoint label without the checkpoint account and image. | `w021-network.k8s`, step 0 item 4 |
| T16 | Use a checkpoint child's token on the pod listener, or a supervisor's on the checkpoint listener | Each listener reviews only its own subject set (X2): the pod listener's never includes the checkpoint account, and the audiences differ. | `w021-profile-identity`, W-020's child-guard tests |

### Race and crash rules

1. **Two replicas check one grant at once.** The transaction advisory lock serializes them; each
   finds the free slot under the lock, so exactly `maxCalls` checks are ever allowed. A slot id that
   already exists under the lock is a hard error, never a second allowance.
2. **A runner restarts.** Grants are derived again, with the same ids; the slots are in Postgres;
   the in-memory hint is empty, so the first check of each grant binary-searches. Nothing resets.
3. **A crash after the slot insert and before the commit.** The transaction rolls back: no slot, no
   allowance, and the next check takes the same number.
4. **A crash after the commit and before the answer is written**, or an answer lost in transport.
   The slot and its call marker are committed together. The retry carries the same `callId`,
   finds the marker by primary key and gets the same slot back: a lost answer costs nothing and
   can never add a call. A retry with a new `callId` is a new call. W-075's `callId` is
   `factory_tool_call.call_id`, which is unique per stage run (`0005:176-196`).
5. **A cancel races a check.** The slot statement holds a share lock on the allocation row for the
   life of the slot's own short transaction and no longer. If the cancel's transition commits
   first, the check sees `stopping` and is refused. If the check's statement runs first, the
   transition waits for that commit, which does no remote work; the call was decided while the
   writer was live, and every later check is refused (`06:90`: cancel revokes further tool
   actions). A remote effect runs after the slot's commit, outside any transaction, so a slow effect
   never holds the row (design 2, security M2). Its outcome is recorded in a separate transaction,
   which W-075 must refuse to count as accepted if the allocation has left `running` or `suspect`
   at its epoch by then.
5a. **Lock order.** Every transaction that takes a grant's advisory lock takes it before the
   allocation row, and nothing takes the allocation row first and the advisory lock after. A
   deadlock between a check and a transition therefore cannot form.
6. **The lease expires during a check.** The condition is `controller_lease_until >
   clock_timestamp()` in the slot statement itself, so a check is refused from the moment of expiry,
   whether or not a pass has moved the row yet.
7. **The writer is replaced.** The new epoch derives new grant ids: its counters start at zero, and
   no call of the old epoch can be counted against, or allowed by, the new one.
8. **A stage run moves to a new generation after a quarantine.** Same as rule 7: a new allocation,
   new grants. So a harness that kills its own pod earns a fresh budget and a fresh wall clock
   (security L1). The bound already exists: a logical stage run has at most `maxGenerations`
   allocations (3, `config.ts:21`, `:99`; D14), so its calls are at most three times the per-epoch
   limits. A new stage run (a new semantic attempt) is the workflow's retry, not the runner's, and
   W-023 must not use one to recover an infrastructure failure (hand-off).
9. **A profile changes between a Job's render and a later attach.** The service account and the
   profile label are part of the Job spec, which an attach compares exactly
   (`job-manifest.ts:226-231`): the allocation quarantines, as with any other spec change.
10. **The policies are deleted or changed while the runner runs.** The periodic presence check
    refuses new work and, for a network policy, stops live allocations within one interval
    (5 minutes by default), on a 404 or a difference only; a 403, a 5xx or a timeout warns and
    retries, and three in a row refuse new work without stopping anything. Between the change and the check, pods already running are not
    protected by the missing rule; the gate does not run again after start. That window is a
    residual risk.
11. **Admission itself fails** (a CEL error, a cost overrun, an absent params ConfigMap). Every
    policy fails closed: the request is refused, the runner's create fails, and the allocation's
    existing error path applies (W-017's `desired` pass and its quarantine at the start deadline).
12. **The kubelet's final delete, and the pod garbage collector.** Both are allowed by identity, so
    pods leave as before, and a pod on a lost node is removed as Kubernetes removes it; W-019's
    node check then answers `writer_node_missing` and the stop is quarantined, not proved. If a node identity
    were compromised it could force-delete pods on its own node only (the API server's node
    restriction); that is outside the threat model (D4).

### Files

| File | Content |
| --- | --- |
| `packages/domain/src/capabilities.ts`, `src/index.ts` | The role table, role classes, default `maxCalls`, `assertNoDeliveryGrant` (21a). |
| `packages/database/src/capability.ts`, `src/index.ts` | The grant lock, the call-marker read, the primary-key probe, the slot and marker statements, the classifying re-read; the writer-start `created_at` read (21a). |
| `packages/runner-protocol/src/pod-api.ts`, `src/index.ts`, `test/vectors.json`, `README.md` | `ROUTES.capability`, the request (with `callId`) and answer types, denial codes, parsers, `statusOf`; `MAX_DENY_TARGETS = 16` (21a). |
| `apps/supervisor/src/args.ts:63`, `apps/supervisor/test/w019-network-gate.test.ts` | The cap imported from `@factory/runner-protocol` instead of the literal 8; one new case: sixteen targets are accepted, seventeen refused (exit 64). No existing test asserts the old cap (searched). The only change in `apps/supervisor` (21b, C20). |
| `apps/runner/src/capability/grants.ts`, `src/capability/proxy.ts` (new) | Derivation; `CapabilityService.check`, `takeSlot` (its own transaction, never the caller's), the hint table (21a). |
| `apps/runner/src/pod-guard.ts`, `src/token.ts` | `review(req, { audience, subjects, bucket })` (shared with W-020, X2); `NEED_CAPABILITY`; the capability per-pod bucket; the pod listener's subject set; the reviewed username against `supervisor_identity`; `capability` in the `:191` mapping (21a). |
| `apps/runner/src/listener/pod-listener.ts` | The fourth route; no pass after it (21a). |
| `apps/runner/src/config.ts`, `src/start.ts`, `src/job-manifest.ts`, `src/names.ts`, `src/runner.ts`, `src/index.ts` | `profiles` (with `checkpoint`), `capabilityPodRate`, `capabilities`, the sizing product with the checkpoint listener's share; the profile's subject at insert (`start.ts:103`) and the input-grants check in `allocateOnce`; the profile's account and label and the read-only mount; `grantId`, `slotId`, `callMarkerId`; `checkCapability`; exports (21a). `profileTier`, `listenerReach`, `profileCheckIntervalMs`, the metadata deny-target rule, the refusal of `factory-exec-control` (21b). |
| `apps/api/src/auth/capability-proxy.ts` (deleted), `apps/api/src/index.ts:6`, `apps/api/test/ac-19-unauthorized-tool-request.test.ts` (deleted) | The retirement (21a, D41). |
| `apps/runner/src/profiles/render.ts`, `src/profiles/print-entry.ts` (new) | The renderer, four profiles, three network policies, four admission policies, the params, and its entry (21b). |
| `apps/runner/src/startup-checks.ts`, `src/main.ts`, `src/reconcile.ts` | The presence check at start, with its failure table; the env entry's new variables (`FACTORY_PROFILES`, `FACTORY_LISTENER_REACH`); the periodic check and the `policy_missing` stop (21b). |
| `apps/runner/src/kube/api.ts`, `https-client.ts`, `fake.ts` | The six `get` calls; the fake's stored policy objects and its admission model, off by default (21b). |
| `packages/test-support/src/faults.ts` | `runner.before_capability_slot`, `after_capability_slot_commit` (21a). |
| `deploy/k8s/runner-rbac.yaml` | `get` by name on the policy kinds, the namespace, the network policies, the LimitRange and the params ConfigMap (21b). |
| `deploy/k8s/local/egress-listener-only.yaml` (deleted, with W-020's added line), `deploy/k8s/local/control-namespace.yaml` (new), `deploy/k8s/README.md` (new) | The rendered policies replace the local file; the control namespace, its own Role and binding; the profile table, every admission rule, what admission does not police and the isolation limits of AC-56 (21b). |
| `scripts/k3s.sh` | Render with both listeners, apply, params, control namespace, new accounts; the local policy's `sed` removed (21b). |
| `apps/runner/README.md` (`apps/api` has no README) | The rules, the slot and its transaction, the route, the profiles, residual risks, what is not built. |

Not changed: any migration; `apps/worker`; `packages/workspace`; `apps/supervisor/src` beyond
`args.ts:63`; W-019's proof, quarantine and hold code; any image.

**Every edit to a W-017, W-019, W-020 or W-008 file**, so that none is a surprise. W-020's rows
assume D49's order (W-020 committed first):

| File | Edit | Commit |
| --- | --- | --- |
| `apps/runner/test/fixtures/job.expected.json` | The profile label on the Job and its template. The account is unchanged for the default `implementer` (`harness.ts:79`). | 21a |
| `apps/runner/test/w017-names-manifest.test.ts` | The new fixture. | 21a |
| `apps/runner/test/w017-permit.test.ts`, `w019-pod-guard.test.ts` | None expected: their tokens are minted for the pod's own account (`fake.ts:285-288`). If a case mints for a fixed account and a non-authoring role, it gains the matching account. | 21a |
| `apps/runner/test/w019-pod-rate.test.ts`, `w019-config.test.ts` | The sizing product now counts `capabilityPodRate` and the checkpoint share; a case that sets the per-pod rate to exactly the ceiling's share sets the other two as well. | 21a |
| `apps/api/test/ac-19-unauthorized-tool-request.test.ts` | Deleted; every case moves to `apps/runner/test/ac-19-capability-proxy.test.ts` (D41). | 21a |
| W-020's `src/pod-guard.ts` review and `src/child-guard.ts` | If W-020 lands first with `review` generalised to a subject and an audience, 21a adds the subject **set** and the bucket to that one signature; it does not write a second review. | 21a |
| `apps/runner/test/conformance/suite.ts` | Rows 1 to 21 take their namespace from a second driver bound to the control namespace (C8); their helpers are unchanged, because the control namespace has no admission. Rows 13 and 15 gain the three new accounts (no Role; nothing else uses them; design finding 6), and row 13 is asked once more for the control namespace's Role. Rows 22 to 28 are new and use the rendered Jobs and claims. | 21b |
| `apps/runner/test/kube-conformance.k8s.test.ts:13` | A second `runnerKube` for the control namespace, passed to rows 1 to 21. | 21b |
| `apps/runner/test/kube-conformance.fake.test.ts` | Rows 1 to 21 with the fake's admission model off (its default); rows 22 to 26 with it on. | 21b |
| `apps/runner/test/k8s/cluster.ts:116-120`, `:150-170` | `clean` deletes pods with grace 15 and waits, instead of grace 0, in both namespaces; the driver gains the control-namespace client, used by `rawDeleteJob` and `forceDeletePod`; `leftovers` checks both namespaces. | 21b |
| `apps/runner/test/w017-run.k8s.test.ts:92`, `:120`, `:179` | The hand-made second pod and the foreign Job are created **through the runner's client** as hardened Jobs with a profile label (they still are not the allocation's), and deleted with grace 15. The assertions stand. | 21b |
| `apps/runner/test/w017-run.k8s.test.ts:112`, `:208`, `:212` | The three `kubectl exec` reads (the projected token, `/tmp/stalled`, `/proc/1/comm`) become `crictl exec` in the node through `inNode` (`cluster.ts:137`), which does not pass through the API server and so not through `factory-exec-no-debug` (design finding 1). The assertions stand. | 21b |
| `apps/runner/test/w019-supervised-run.k8s.test.ts:52`, `:57` | The same as `w017-run`'s second pod. | 21b |
| `apps/runner/test/w019-network-gate.k8s.test.ts:63`, `:71` | The probe pod is a hardened Job created through the runner's client in the exec namespace (it must be under the policy), and is deleted with grace 15; the deny list comes from the rig, now ten targets. | 21b |
| `apps/runner/test/w017-main.test.ts:41`, `w019-main-env.test.ts:36`, `:57`, `:70`, `w017-review-fixes.test.ts:350` | Their production deny lists (`['10.96.0.1:443']` and the like) gain `169.254.169.254:80`, which `createConfig` now requires with the gate `required`; `:70`'s refusal for a mistyped API address must still be the API-address refusal, so its list gains the metadata target too. | 21b |
| `apps/runner/test/k8s/supervised.ts:13-16` | `standingDenyTargets` adds the bridge address's two ports, the DNS service, the node's 10250 and 6443, and the checkpoint listener. | 21b |
| W-020's `apps/runner/src/checkpoint-job.ts` and its fixture | The child Job gains the `<prefix>profile: checkpoint` label and `profiles.checkpoint.resources`, if W-020 has not already rendered them; its account comes from `profiles.checkpoint`. | 21b |
| W-020's `deploy/k8s/local/egress-listener-only.yaml` line and `scripts/k3s.sh` port | Removed; the checkpoint port is in the rendered `factory-exec-egress-checkpoint` and in `.k3s/env` as before. | 21b |
| W-020's child k3s file and conformance rows 29 to 31 | They run in the exec namespace under the rendered policies and the `checkpoint` profile (design X5); they must pass unchanged, which `w021-checkpoint-profile.k8s` shows first. | 21b |

If the first run of 21a or 21b shows another edit is needed, it is added to this table before the
review, not after (section 6's rule).

**Overlap with W-020** (its file table, 7.7 of its brief, read 2026-11-21):

| Area | W-021 touches | W-020 touches | Conflict |
| --- | --- | --- | --- |
| `packages/workspace` | **Nothing** | The reader, the manifests, the builder, `quarantine-record.ts`, `volume-disposition.ts`, the manager and materializer (20c) | None |
| `apps/runner/src/pod-guard.ts`, `src/listener/pod-listener.ts`, `packages/runner-protocol/src/pod-api.ts` | The capability route, a `Need`, a bucket, the subject set, the identity rule | The finalize route, `not_finalizable`, the review generalised to a subject and audience | **Same functions.** One `review` signature (X2); whoever lands second extends it. |
| `apps/runner/src/listener/checkpoint-listener.ts`, `src/child-guard.ts` | Only the subject set it passes (the checkpoint account) and its share of the review budget | Both files | Small; X2 and X4. |
| `apps/runner/src/config.ts`, `src/job-manifest.ts`, `src/checkpoint-job.ts`, `test/fixtures/*.expected.json` | `profiles` (with `checkpoint`), the account, the label, the read-only mount | The child Job, its settings | **Same files**: one key, `profiles.checkpoint` (X2). |
| `apps/runner/src/start.ts`, `src/runner.ts`, `src/names.ts`, `src/index.ts`, `src/reconcile.ts`, `src/main.ts` | One line, the input check, exports, three id functions, the presence stop, two env variables | Cancel and `getResult`, receipts per attempt, `passFinalizing`, the second listener | Same files, different functions |
| `apps/runner/src/kube/fake.ts`, `test/conformance/suite.ts`, `test/k8s/*` | Admission model, rows 22 to 28, the control-namespace driver | The child's Job, rows 29 to 31 | Same files |
| `deploy/k8s/local/egress-listener-only.yaml`, `scripts/k3s.sh` | Deletes the file; rewrites the policy step | Adds the second port to both | **W-021 removes W-020's lines** and renders them instead (X3) |
| `apps/supervisor/src` | `args.ts:63` | `heartbeat.ts`, `runner-client.ts`, `state.ts` | None |
| `apps/runner/src/states.ts`, `src/records.ts`, `src/workspaces.ts`, `src/finalizer.ts`, `src/checkpoint-pod/*` | Nothing | Edges, records, acceptance, the child's entries | None |

Recommendation (D49): build in plan order: **W-020 first, then W-021 on top**. 21b then admits the
child exactly as W-020 built it, and W-020's own k3s file is the first check that the checkpoint
profile is right. If the owner wants them in parallel, only 21a's new files (`packages/domain`,
`packages/database/src/capability.ts`, `apps/runner/src/capability/`) are free of conflict; every
other 21a edit rebases onto W-020.

### Tests

Real Postgres everywhere a row is involved. Time is moved by backdating row timestamps, as in
section 6. **Every refusal has, in the same setup, the accepted case.**

**21a: fake tier.**

| Test file | Shows |
| --- | --- |
| `packages/domain/test/w021-capability-roles.test.ts` | Every role of the contract's `Role` enum has an entry and a class; `assertNoDeliveryGrant` passes on the real table. **Control:** it throws on a planted `git.push` entry and on a planted `publish` side effect. |
| `packages/runner-protocol/test/w021-capability-api.test.ts` | The vectors round-trip; unknown key, `__proto__`, a 257-byte resource id, an upper-case digest, an operation with a space, a missing field: each refused. **Control:** the vector parses. Every capability denial code has a status. |
| `packages/database/test/w021-capability-slots.test.ts` | The slot statement writes one row with the pinned fields when every condition holds. **Each condition broken alone writes none:** epoch, writer pod, state (`starting`, `stopping`), lease (backdated), workspace fenced, task `paused`, expiry passed. The probe finds the boundary for 0, 1, 7 and `maxCalls` slots used, in at most `ceil(log2(maxCalls)) + 1` reads. The runtime role cannot `UPDATE` or `DELETE` a slot (**control:** it can insert one). Another organization's session sees no slot (RLS). **Call marker:** the slot and its marker are written in one transaction or not at all; a second take with the same `callId` writes nothing and returns the first slot; **control:** a new `callId` takes the next slot. |
| `apps/runner/test/w021-grants.test.ts` | Two runner instances derive deep-equal grants, ids included; a third after a restart too. A new epoch changes every id; a `read_only` role gets no `workspace.write`; no writer-start record, no grants; `expiresAt` is the record's time plus `wallSeconds`. Every grant validates against the contract. **Input grants:** a `StageInput` listing `git.push`, or `workspace.write` for a `reviewer`, or a resource that is not its workspace, is `invalid_request` with nothing created; **control:** an empty list and an exact subset are accepted, and a subset with an absurd `maxCalls` changes no derived limit. **No workspace, no grants:** a `knowledge_curator` or any role with `workspace_id` null derives an empty set; with a workspace, `telemetry.query` for `discovery` names the workspace row's `repositoryId` (C16). The input-grants check runs inside the allocate transaction: a refused input leaves no allocation, no capacity row and no audit row of a start. |
| `apps/runner/test/ac-19-capability-proxy.test.ts` | W-008's cases, against the runner: the implementer may read and write its workspace; `git.push`, `git.merge`, `deploy.apply`, `credentials.issue`, a production environment and another workspace are each refused with the injected prompt text in the request, each audited with a digest and no text; no role is ever minted a delivery grant. Limit, lifetime, epoch and state, as W-008 had them. **Plus:** a structural check that `@factory/api` exports no capability check and that only `apps/runner/src/capability/` defines one, with a planted file as its control. |
| `apps/runner/test/w021-durable-counter.test.ts` | `maxCalls` 3: three allowed, the fourth `call_limit`. **Restart:** a new runner instance on the same database answers `call_limit` at once. **Replicas:** two instances, 20 concurrent checks against `maxCalls` 5: exactly 5 allowed, exactly slots 1 to 5 exist. **Control:** a second grant of the same allocation is unaffected throughout. **Crash:** a fault at `before_capability_slot` that throws leaves no slot and the retry takes slot 1; a fault at `after_capability_slot_commit` leaves the slot spent and the retry takes slot 2 (race rule 4). A stale hint (a slot written by the other instance) is detected and the search is exact. **Lost answer, same call:** after `after_capability_slot_commit`, the retry with the same `callId` gets slot 1 back and slot 2 is never written (race rule 4); **control:** a retry with a new `callId` takes slot 2. |
| `apps/runner/test/w021-capability-liveness.test.ts` | Each refused with its own code, each next to its accepted twin: `starting`; `suspect` with a live lease (**allowed**); the lease backdated past expiry with the row still `running` and no pass run (refused: the clause is in the statement); `stopping`; `terminated`; `replaceWriter` called while `running` (`stale_epoch`); the task paused; the grant expired. **Cancel order:** a check held at `before_capability_slot` after its guard; a cancel then waits on the share lock; the check commits allowed and the cancel commits after it; the next check is `not_live`. The mirror: the cancel commits first and the held check is refused. A fenced workspace answers `stale_epoch`, not `not_startable` (C19). **A slow effect does not hold the row** (security's missing test): `takeSlot` returns; a test effect then sleeps 10 s holding nothing; a cancel issued during it commits within one second, and a check after it is `not_live`. **Control:** a test-only variant that holds the slot's transaction open across the sleep delays the cancel by the sleep, which is what the rule forbids. **Lock order:** a check held after its advisory lock and a transition held after its row lock, released in both orders, never deadlock (twenty runs). |
| `apps/runner/test/w021-capability-route.test.ts` | Through the listener: allowed and refused answers with their statuses; no token is 401 and charged to the source, never reviewed; a token for another allocation is refused. **The flood:** 200 checks from pod A in one burst: at most the capability burst reach the review, the rest `throttled` with no `reviewToken` call; pod A's own renewal and pod B's checks, sent in the middle, are granted. **Control:** with the capability bucket off (a test switch) the same burst empties the shared budget and B is `throttled`. Denials are audited under the per-pod cap. No pass is set off by the route. Config refuses a capability rate whose product with the pools passes the ceiling. |
| `apps/runner/test/w021-profile-identity.test.ts` | A `reviewer` stage renders `factory-sup-read-only`, the `read_only` label and a read-only harness mount, and stores that subject in `supervisor_identity`; its supervisor stub is granted. A token of the right audience minted for `factory-allocation-supervisor` instead (`mintToken` with `serviceAccount`) is `not_this_job`, `identity`, audited. **Control:** the pod's own account is granted. An account outside the profiles fails local verification and is charged to the source. **A checkpoint child's token** (subject `factory-checkpoint`, audience `factory-checkpoint:<childId>`) presented on each pod route is refused at local verification by subject and charged to the source (security's missing test on W-020); **control:** the same token is accepted by the checkpoint listener's review with its own subject set. |

**21b: fake tier.**

| Test file | Shows |
| --- | --- |
| `apps/runner/test/w021-profiles-render.test.ts` | The rendering for the default test configuration equals `profiles.expected.json`. The default-deny selects every pod, has both types and no rule. **Three egress policies, each with exactly one peer and one port:** the listener policy selects the three allocation profiles and names `podListener.port`; the checkpoint policy selects only `<prefix>profile: checkpoint` and names the checkpoint listener's port; neither names the other's port (X3). A `cluster` rendering has the digest-regex rule and, per container name, only the configured digest: `images.read` and `images.build` hold `images.checkpoint`, and **no scripted, stub or materializer-test name appears** (checked against the list `scripts/k3s.sh` builds, read from the script). The checkpoint profile's rules are present: containers `read` and `build`, no `fsGroup`, the token in `build` only, `export` read-only in `build`, `work` only in `build`, the claim read-only in `read` only. `profiles.checkpoint`'s default equals the account name in W-020's `deploy/k8s/checkpoint-sa.yaml`. `createConfig` refuses `profileTier: 'local'`. **Control:** the test configuration renders `local` with those names. The `pods` form of `listenerReach` renders a namespace and pod selector and no `ipBlock`. |
| `apps/runner/test/w021-fake-admission.test.ts` | The fake's model, rule by rule, each with a rendered object as its accepted control. **Allocation profiles:** a pod created outside the Job controller; a Job from another account; each hardening and pod-security field broken alone; a container name outside the profile's set; **the `supervisor` container running the harness image** (security L2's missing test), and the harness running the supervisor's; the token mounted in `harness`; the token mounted with a read-write claim; an audience naming another allocation; the authoring account under a `read_only` label; a pod with no profile label. **Checkpoint profile** (X1): W-020's rendered child Job is admitted; each of these alone is refused: an `fsGroup`; a third container; `build` mounting the claim; `read` mounting the token; `export` read-write in `build`; `work` mounted in `read`; a missing limit on either container; an image other than `images.checkpoint`; the checkpoint label with an allocation account, and an allocation label with the checkpoint account. **Claims:** `ReadWriteOnce`; `volumeName`; `dataSource`; `dataSourceRef`; `selector` (security L5). **Updates:** a pod `UPDATE` that changes a container's image (security L3); **control:** an update that removes a finalizer. **Deletes:** grace 0 by the driver (refused), by the fake kubelet (accepted) and by the pod-garbage-collector identity (accepted); an eviction with grace 0 (refused) and with none (accepted); a Job delete with no propagation. Then the property: every Job and claim the runner renders, for every profile and for W-020's child, passes the model. |
| `apps/runner/test/w021-presence-check.test.ts` | With every object present and equal the runner starts. Each object missing (404), then each changed in one field, refuses the start with its name, the namespace's Pod Security labels and the params ConfigMap's data included (security L4's missing test: labels removed). A 403, a 500 and a timeout at start also refuse it. **While running, the failure table row by row:** a 404 or a difference on a network policy refuses `startOrAttach` with `profiles_missing` and moves a `running` allocation to `stopping` with `policy_missing`; the same on an admission policy refuses new work and stops nothing; **a 500 or a timeout on any object stops nothing and refuses nothing** on the first and second interval, and refuses new work, still stopping nothing, on the third (design finding 5). **Control:** restored, new work is accepted. There is no configuration that turns the check off. |
| `apps/runner/test/w021-deny-targets.test.ts` | `createConfig` with the gate `required` refuses a deny list without `169.254.169.254:80`; **control:** with it, it starts. Sixteen targets are accepted and seventeen refused, by the runner's configuration and by the supervisor's parser, from one constant. `createConfig` refuses the namespace `factory-exec-control` (security L6's missing test); **control:** `factory-exec-local` is accepted. `w021-no-disabled-gate`: no k3s file sets `disabled`; a planted file fails it. Nothing outside `deploy/k8s/local/` and the k3s test helpers names `factory-exec-control`. |
| `apps/runner/test/kube-conformance.fake.test.ts` (rows 22 to 26) | See below. |

**Conformance additions** (`apps/runner/test/conformance/suite.ts`). Rows 1 to 21 now run in the
control namespace at K and with the fake's model off at F (C8). Rows 22 to 28 run in the exec
namespace with the model on.

| # | Behaviour asserted | Tiers |
| --- | --- | --- |
| 22 | A pod create by any identity but the Job controller is refused; the rendered Job's pod is created, for each of the four profiles (W-020's child Job for `checkpoint`). | Both; K confirms step 0 item 2 |
| 23 | A Job breaking any one hardening, pod-security, name-to-image or profile rule is refused at the Job, for an allocation profile and for `checkpoint`; the rendered Job is admitted. | Both |
| 24 | A pod delete below the pod's grace by a non-node identity is refused; at 15 it is accepted and the pod is gone about 15 s later (the kubelet's delete passed). **An eviction** with grace 0 is refused and one with no options is accepted and ends the pod through its grace (security M1). **`deletecollection`** with grace 0 is refused. **The pod garbage collector's** grace-0 delete of a pod whose node object is gone is accepted (design finding 4). Each half has its fallback in step 0 items 1 and 2: if a half cannot be shown, the row asserts the fallback's documented behaviour and the residual list grows. | Both; K confirms step 0 items 1 and 2 (the garbage-collector half is cluster only if the fake cannot model the identity) |
| 25 | A Job delete without `Background` or `Foreground` is refused; with `Background` it is accepted and its pods end. | Both; K confirms step 0 item 1 |
| 26 | A claim that is not `ReadWriteOncePod`, of another class, from another account, or with `volumeName`, `dataSource`, `dataSourceRef` or `selector`, is refused; the rendered claim is created. | Both |
| 27 | Exec, attach, port-forward, an ephemeral container and an image change on a live pod are refused in the exec namespace. **Control:** in the control namespace exec succeeds. | Cluster only (step 0 item 3) |
| 28 | Under the rendered policies, the probes of step 0 item 4, including both sides of the checkpoint port. | Cluster only |

**k3s tier, opt-in.** Run once at the end of 21b and at its review, on AC power, never beside the
full suite, after W-019's k3s tier has passed once (D49). Every run is under the rendered policies
and admission.

| Test file | Shows |
| --- | --- |
| `apps/runner/test/w021-admission.k8s.test.ts` | Each refusal of the four policies by the real API server, with its message, each beside its accepted twin: the admin's pod; an admin Job; the runner's Job with one rule broken; a `supervisor` container running the harness image; an image the allowlist does not name; an image `UPDATE` on a running pod; grace 0 and grace 1 against grace 15; **a grace-0 eviction against an eviction with no options; a grace-0 `deletecollection`** (security M1); an orphaning Job delete against `Background`; exec and an ephemeral container against the same in the control namespace; a PVC with `ReadWriteOnce`, and one with `dataSource`. A rendered Job of each allocation profile is admitted and its supervisor granted. |
| `apps/runner/test/w021-network.k8s.test.ts` | From a probe Job in the exec namespace (created through the runner's client, allocation profile): the API service, `169.254.169.254:80`, the gateway's and the bridge's Postgres and Temporal ports, the DNS service (UDP and TCP), the node's 10250 and 6443, a second probe pod's port, **and the checkpoint listener's port** all fail; the pod listener completes a handshake. From a checkpoint-labelled probe (checkpoint account and image): the checkpoint listener completes a handshake and the pod listener's port fails (security M3's missing test, both pod kinds). From the control namespace, a connect to the exec probe's port fails (ingress). **Control:** the same probes between two control-namespace pods connect, and DNS answers. Records refused or timed out per target. The metadata target is not claimed (A-35). |
| `apps/runner/test/w021-profiles.k8s.test.ts` | A `reviewer` stage with the `write-file` harness: the write fails (read-only file system) and the tree is unchanged; **control:** an `implementer` with the same script writes. Each profile's supervisor reads its own token and is granted, with the stored identity. The supervisor's gate passes with the ten targets. |
| `apps/runner/test/w021-checkpoint-profile.k8s.test.ts` | W-020's child, as its renderer makes it, is admitted and runs under `factory-exec-egress-checkpoint`: `read` sees the claim read-only and no token file; `build` sees the token and `export` read-only, and no claim (checked by node-side `crictl exec`, never `pods/exec`). Each one-field change of the child from `w021-fake-admission`'s checkpoint list is refused by the real API server. It runs before W-020's own k3s file in the same run, so a profile defect is named here and not as a checkpoint failure. |

### Which tier proves what

| Claim | F | K | Needs R |
| --- | --- | --- | --- |
| Prompt text and request fields grant nothing; delivery grants are never minted (AC-19) | Yes | Not needed | |
| Call limits survive a restart and hold across replicas | Yes (two instances, one database) | Not needed | Two runners on the real deployment |
| A stale, cancelled, fenced or expired writer's call is refused | Yes | Not needed | |
| Per-profile identity is checked against the row | Yes (fake tokens) | Real tokens of three accounts | Workload identity on the organization's issuer |
| Read-only profiles cannot write the workspace | Manifest only | **Yes** | |
| Admission refuses every listed request, evictions and image updates included | The fake's model | **Yes, on k3s 1.36.6** | The real API server's version and controller identities |
| W-020's child is admitted exactly as rendered, and nothing else wears its profile | The fake's model and the property test | **Yes** (`w021-checkpoint-profile.k8s`) | |
| Only checkpoint pods reach the checkpoint port; allocation pods only the pod listener's | No | **Yes, on this CNI** | The real CNI |
| Default-deny egress and ingress; each profile reaches its own listener's port only | No (no network in the fake) | **Yes, on this CNI** | The real CNI, its start-up window, metadata on a cloud node (AC-56) |
| Metadata access is denied | No | No: refused here with no policy (A-35) | **Yes** |
| A cluster without the policies starts no work; an API error stops nothing | Yes (presence check and its failure table) | The presence check against the real objects | |
| Isolation is sufficient for hostile multi-tenant work | No | No | A sandbox runtime or isolated nodes (`09:75`, D4) |

### What W-021 claims, and what it does not

- **AC-19.** An author's request for publishing or production credentials is refused by the runner's proxy and audited; prompt text and request fields cannot grant authority; the limit, lifetime and epoch of a grant hold across a restart and two replicas: fake tier, in full. This replaces W-008's line, whose proxy is retired (D41). Not claimed: the same through W-075's tool server (its own line will cite this one).
- **AC-56, local tier only.** Candidate code in the exec namespace cannot reach the API server, the workflow engine, the databases, DNS, another port of the runner's host, or another task's pod, and cannot be reached by one; its own listener's port alone is reachable (the pod listener for allocation pods, the checkpoint listener for W-020's child); the cluster refuses pods, Jobs, claims, deletes, evictions, image changes, exec and ephemeral containers the runner does not render: k3s, with each refusal next to its accepted twin. The **qualified isolation limits are documented** in `deploy/k8s/README.md` (no sandbox runtime; containers alone not sufficient, `09:75`; a single node; NAT in front of the listener, A-32; `local-path` size; no process-id limit; the policy's start-up window, SI-15, behind the gate; the presence check's interval; what admission does not police). **Not claimed:** "enforced on the real cluster" (R, D4), and metadata denial, which this machine cannot show (A-35). The build-log line says "local tier only", as D4 requires.
- Built here, claimed elsewhere: the admission and network material for **AC-236** and **AC-233** (W-134); the slot that **W-075**'s tool calls and proposals take before their effects (`takeSlot`); the per-profile account that **W-115**'s scoped gateway credential will be bound to; the `verifier` profile **W-022** fills in.
- Not built: bundle or artifact reads from pods (D48); any factory tool (W-075); the checkpoint child itself (W-020; this package admits it); routes for package mirrors, Git mirrors, the model gateway or task dependencies (`09:77`, D50, P-36); an egress proxy or FQDN policy; a review cache (P-33); the `factory_tool_call` rows and outcomes (W-075); a process-id limit (P-35); a runner deployment inside the cluster (P-37); anything on a real cluster (D4).
- Residual risks, for the READMEs:
  - Between a policy's deletion and the next presence check (5 minutes by default), running pods lack the deleted rule (race rule 10).
  - Admission does not police updates other than a pod's images and ephemeral containers, nor claim deletes, nor `nodes/proxy`; a cluster administrator can still lower a deadline, relabel a pod, delete a claim or exec through the kubelet.
  - A presence check that keeps failing with errors (not 404s) refuses new work after three intervals but stops nothing; a cluster whose API answers 5xx for a long time therefore keeps its running pods running under whatever policies it has.
  - The pod garbage collector may force-delete a pod whose node is gone or out of service (D44); W-019's node check covers the first case, and section 6's residual covers the second.
  - Admission cannot tie a pod's claim name to its allocation (a policy has no hash); only the runner's account can create either.
  - The pod-create rule trusts the Job controller's identity; if step 0 item 2 shows one identity for every controller, any controller could create a pod that passes the shape rules (A-41).
  - Capability checks cost a TokenReview and a pod read each; at tool-call rates that is the API server's load, bounded by the review ceiling, and not measured (P-33, P-14).
  - The kubelet's group is exempt from the grace rule; a compromised node is outside the model.
  - A cluster operator can add any digest to the production allowlist, including a scripted image pushed to a registry (D46): the allowlist is an operational control there.
  - Everything in section 6's residual list that this brief does not answer stands, including NAT and the gate's "listed rules only".

### Hand-offs

- **W-020:** the `checkpoint` profile is specified in 21b, for the child shape fixed on 2026-11-21. W-020's renderer must emit exactly that shape: the `<prefix>profile: checkpoint` label; `profiles.checkpoint` as the account (no `config.checkpoint.serviceAccount`); `read` and `build` with `profiles.checkpoint.resources`; the volumes `export` and `work` as listed; the token in `build` only, with the audience form agreed (open item 1 under "Response to review"). Its review uses the one `review(req, { audience, subjects, bucket })`, with the checkpoint account as the checkpoint listener's only subject. Its egress comes from `factory-exec-egress-checkpoint`; its local policy line and `sed` go. Its conformance rows 29 to 31 run in the exec namespace under the rendered policies (X5).
- **W-022:** fill the `verifier` profile (images, containers, whether the harness mount stays read-only for canonical runs), and design the scoped artifact read from a pod with D48's answer.
- **W-023:** its worker-facing listener is another port on the runner: add `<runner address>:<port>` to the deny list (there is room, C20) and to `createConfig`'s required targets; no egress policy names it. Its wire types go in `@factory/runner-protocol` beside the capability route's. **Do not recover an infrastructure failure with a new semantic attempt** (a new stage run): limits are per allocation epoch, and a stage run's bound is `maxGenerations` times them (race rule 8, security L1); a new stage run would reset it.
- **W-075, a rule and not an option** (decided 2026-11-21; design 2, security M2). For every tool call with a remote effect:
  1. **One short transaction, then commit:** insert the `factory_tool_call` row (`reserved`, keyed by its `call_id`, unique per stage run) and call `takeSlot` with that `call_id` as `callId`. The lock order inside is the grant's advisory lock, then the allocation row's share lock; nothing W-075 adds may take the allocation row before a grant's advisory lock. A retry with the same `call_id` finds both and takes no second slot.
  2. **The effect, after the commit, outside any transaction.** No Postgres transaction is open while a remote call runs (rule 1), so a cancel, a stop or W-119's emergency stop is never held behind it.
  3. **The outcome, in a separate transaction:** the `factory_tool_call` row moves on (`finalized` or `failed`), and an effect whose result the factory itself accepts (a proposal) is accepted only if the allocation is still `running` or `suspect` at the same epoch with an unexpired lease, in that statement.
  Also: measure tool-call rates against the capability bucket and the review ceiling before W-077 (P-33), and never forward a request from the local tool routes that the proxy has not allowed.
- **W-077:** the production harness image is the first entry of the `cluster` allowlist for the `authoring` profile; anything it needs from the network beyond the listener (the model gateway) is a new allow rule and a new profile field, with its own test (D50).
- **W-090:** role admission and revocation of compiled role content build on the role table in `@factory/domain`; a revoked role grants nothing from the next derivation.
- **W-115:** the scoped gateway credential is minted for the allocation's stored `supervisor_identity` and profile, never for a request field.
- **W-119:** the emergency stop revokes capabilities through the cancellation protocol (`25:62`): every allocation it moves to `stopping` is refused by the next check (race rule 5). No new rule is needed.
- **W-134:** the admission refusals, the network probes and the identity tests are the material for AC-233 and AC-236.
- **D4 qualification:** rerun `w021-admission.k8s`, `w021-network.k8s` and step 0 items 1 to 4 on the real cluster; replace A-41 and A-43 with what it shows; add the metadata target there.

### To confirm in the k3s tier

The six step 0 items, each confirmed or answered by its fallback, and four more that nothing rests
on: the LimitRange defaulting (recorded); the time from a NetworkPolicy's creation to enforcement on
this CNI, measured as section 2 did for the start-up window; the CEL cost of the create policy
against the API server's budget; and that a refused pod create shows on its Job as a `FailedCreate`
event naming the policy, which the runner does not read today (recorded for diagnosis).

### Owner decisions, assumptions, spec issues and plan additions

The owner accepted the recommended default of every decision here, D38 to D50, on 2026-11-22,
including the security calls D44, D46 and D50. None blocks step 0 or 21a's start. D48 changes a
plan decision (D13) and is accepted; **its follow-up stays open and is assigned to silvio**: the
design of the pod artifact read goes to him before W-022's brief.

| # | Decision | Recommended default |
| --- | --- | --- |
| D38 | W-021 is larger than its estimate: 10 to 12 days against 4–6, after the two reviews. | Step 0, then 21a, then 21b, each commit with an independent review; one build-log line after 21b. 21b's review includes a security reviewer. |
| D39 | Where grants come from (C5, SI-43). `07:38` puts grants in the run input; `StageInput` carries them, unhashed and unstored. | The runner derives them from rows, with deterministic ids (rule 11). A `StageInput` that lists anything outside the derived set is refused; one that lists less narrows nothing. Not taken: honouring the input's grants (the runner would trust its caller's authority), or requiring an exact match (W-023 would have to rebuild the runner's derivation). |
| D40 | Where durable counters live (C4). | **No migration.** One `audit_event` row per allowed call, at a deterministic id, written by the statement that decides it, under a per-grant advisory lock, found by primary-key probes. The runtime role can only insert there, so a spent call cannot be given back. Not taken: a `capability_slot` table with `UNIQUE (org_id, grant_id, n)` (a migration, a grant change and a retention rule, for the same guarantee), or a counter column on the allocation (one counter per allocation, not per grant). |
| D41 | What happens to W-008's proxy in `apps/api`. | Delete it, with its test, and move the role table to `@factory/domain`; AC-19's cases move to the runner. It has no caller (searched today) and keeps the very counters this package exists to replace; two proxies would be two answers. |
| D42 | Granularity of "per-role identities" (SI-45). | One service account per **profile**, four profiles (`authoring`, `read_only`, `verifier`, and `checkpoint` for W-020's child), with **one configuration home, `profiles.<name>`** (X2, decided 2026-11-21); the role table maps each of the nine roles to one of the first three. The authoring account keeps its name. Each listener accepts only its own subjects: the pod listener never the checkpoint account. Not taken: nine accounts, one per stage role (the audience already binds a token to one allocation, so nine accounts add names, not authority); one account for everything (the status quo, which the backlog item exists to end). |
| D43 | What a capability check costs, and how it is limited (C13, X4). | Every check is reviewed and reads the pod, as the permit calls do; its own per-pod bucket (burst 20, one every 400 ms); the shared review budget counts the renewal, capability and checkpoint listeners' buckets together; no review cache. P-33 records that W-075 must measure. Not taken: caching a successful review for a few seconds (cheaper, but section 2 measured that the API server already keeps a review alive after its pod is gone, and a second cache would widen that window); a separate budget for the checkpoint listener (two budgets would let their sum pass the ceiling that protects the API server). |
| D44 | **Security call.** The admission rule set, its exemptions and its failure mode. | The rules of 21b, four policies, `failurePolicy: Fail`, bound to the exec namespace only. Exemptions: the kubelet's group and the pod garbage collector for the grace rule (deletes and evictions), and the Job controller's identity for pod creation only. No exemption for cluster administrators. Evictions are held to the same grace rule (C15). Not taken: refusing the pod garbage collector (its pods would stay for ever, with no one able to remove them). |
| D45 | Where the k3s tier shows Kubernetes doing what the exec namespace now refuses (C8, C18). | A local-only control namespace, `factory-exec-control`, with its own copy of the runner's Role, no policy and no admission, used only by the test driver: conformance rows 1 to 21 and the positive controls. `createConfig` refuses it. Not taken: binding admission with an exception for the admin (then the admin could do in the exec namespace what a test needs, and so could anyone with that certificate); making rows 1 to 21 conform to admission (they show Kubernetes behaviour, several by breaking the rules on purpose). |
| D46 | **Security call.** How "refuse the scripted label outside the local tier" is enforced (C2). | By the tier's image allowlist, **per container name**: a `cluster` rendering admits under each container name only its one configured digest, a CEL rule refuses anything not matching `^[^@]+@sha256:[0-9a-f]{64}$`, and an image cannot be changed on a live pod. The label stays as documentation. Not taken: a mutating or validating webhook that pulls image configuration (a new server, registry credentials in the admission path, and a new dependency). |
| D47 | How the profiles are packaged, and how the runner knows they are installed. D8 chose plain manifests and typed code for the Job. | The profile objects are rendered by typed code from `RunnerConfig`, as the Job is, with a committed fixture, and applied through a print entry; the namespace, the accounts that never vary and RBAC stay plain YAML. The runner checks at start and every 5 minutes that the policies, the three network policies, the LimitRange, the namespace's Pod Security labels and the params equal what it renders. **Only a 404 or a difference stops anything**, and only for a network policy; any other error warns and retries (design finding 5). Not taken: plain YAML for everything (the namespace, account names, label prefix, listener ports, images and sizes would be written twice, with nothing to catch drift). |
| D48 | **Changes D13.** Who builds the scoped artifact read from inside a pod (C9). | Not W-021. W-022 is its first user and should own it; the design (how a pod gets a bundle when only the supervisor holds an identity, `06:110`) needs its own brief. **Accepted by the owner, 2026-11-22.** **Follow-up, open:** the design goes to silvio before W-022's brief. Until then W-020's restores run through `LocalMaterializer`, as its draft already says. |
| D49 | Order. W-019's k3s tier has not run (C10), and W-020 and W-021 share files (overlap table). | W-019's k3s tier passes once, unchanged, before W-021's step 0. Then plan order: W-020, then W-021 on top of it, with 21b filling in the `checkpoint` profile. If the owner wants them in parallel, only 21a's new files are built ahead. |
| D50 | **Security call.** Which of `09:77`'s explicit routes the M2 profiles allow (SI-44). | Two, each to one port of the runner only: allocation pods may reach the pod listener's port, and the checkpoint child the checkpoint listener's port (`factory-exec-egress-checkpoint`, X3); neither reaches the other's. Nothing in M2 resolves a name (every target is a literal address, `config.ts:184-191`) or needs a mirror or the model gateway (A-27, A-33). Each later route (DNS, mirrors, the gateway) is a profile field with its own allow rule and its own test, added by the package that needs it. |

Assumptions W-021 writes to `docs/assumptions.md`:

- **A-40** (INT-05, W-005; extends A-25): one execution namespace, with one service account per profile (`factory-allocation-supervisor`, `factory-sup-read-only`, `factory-sup-verifier`, and W-020's `factory-checkpoint`), all named under `profiles` in the runner's configuration, and the role-to-profile table of 21b. None of them has a Role.
- **A-41** (INT-05): the Job controller's, the garbage collector's and the pod garbage collector's identities on the local cluster are those step 0 item 2 recorded; the pod-create rule and the grace exemption name them. A real cluster's must be measured again (D4).
- **A-42** (INT-05; extends A-35): the local tier's ten deny targets are the API service, `169.254.169.254:80`, the podman gateway's and the podman bridge's Postgres and Temporal ports, the cluster DNS service on TCP 53, the node's 10250 and 6443, and the checkpoint listener's address and port; the metadata target still shows no rule active here. The cap is sixteen.
- **A-43** (INT-05): on a real cluster the runner runs inside it, and the egress allow rule names the runner's namespace and pod labels and the listener port. That form is rendered and unit-tested only; nothing on this machine runs it.
- **A-44** (W-077, INT-08; extends A-33): the local tier's image allowlist names the stub, materializer-test and scripted-harness images by their `:local` names, each under the container name it runs as (scripted images under `harness` only); the `cluster` allowlist holds one configured digest per container name (`images.checkpoint` for both `read` and `build`) and nothing else.
- **A-45** (W-005, ADR-12; extends A-07): a grant's lifetime is the writer-start record's time plus the stage's `wallSeconds`, and each operation's `maxCalls` is a code default (`source.read` and `workspace.write` 2,000, `factory.verify` 20, `telemetry.query` and `knowledge.read` 200), capped at 10,000. Judgement, not from the spec.
- **A-46** (INT-05): the control namespace `factory-exec-control` exists only on the local cluster, is created by `scripts/k3s.sh`, has no network policy and no admission, and is used only by the k3s test driver.

Spec issues W-021 records in `docs/spec-issues.md`:

| ID | Location | Problem | Proposed choice |
| --- | --- | --- | --- |
| SI-43 | `07-harness-context.md:38`, `:92`; `domain.schema.json` `StageInput.capabilityGrants` | Run input "includes ... capability grants", and the proxy "checks each call against ... current capability", without saying whether the input's grants are authority or a statement of it. | The runner derives the grants; the input's list may only restate a subset and carries no authority (D39). |
| SI-44 | `09-verification-security.md:77`; `07-harness-context.md:94` | Default deny "with explicit DNS, artifact, Git mirror, package mirror, model gateway, task-dependency routes", while network access is "role/profile-specific". It is not said whether every profile gets every route. | Routes are per profile and added only when a profile needs one; M2's allocation profiles allow the pod listener's port only and the checkpoint profile the checkpoint listener's port only (D50). |
| SI-45 | `09-verification-security.md:71`; `14-build-backlog.md:269` | Chapter 09 names service identities per component (authoring runner, verifier, finalizer, publisher, deployer); the backlog asks for "per-role identities". | One account per execution profile, mapped from the stage role (D42). |
| SI-46 | `16-acceptance-catalogue.md:191` (AC-19); `09-verification-security.md:93` | "Call is denied and audited" with no bound on audit volume from a hostile caller. | Every allowed call is audited (its slot); denials are audited under W-019's per-pod cap and counted beyond it. |
| SI-47 | `09-verification-security.md:75`; `06-runner-workspaces.md:90`, `:116` | Admission and a LimitRange are required, but nothing says who may delete pods, with what grace, or how a Job may be deleted, although the whole-pod stop (`06:90`) and quiescence rest on both. | Pod deletes below the pod's grace are refused except for the kubelet; orphaning Job deletes are refused; exec, attach and ephemeral containers are refused (D44). |
| SI-48 | `16-acceptance-catalogue.md:559-561` (AC-56) | "Qualified isolation limits are documented" names no document and no owner. | `deploy/k8s/README.md` carries them, per tier, and the D4 qualification replaces the local list with the real cluster's. |

Plan additions for `docs/plan-additions.md`:

- **P-33**: measure capability-check rates under W-075's tool server against the capability bucket and the review ceiling; if too costly, design a review cache or a batched check with its own security review. Open.
- **P-34**: a secondary index or a dedicated table for capability slots if primary-key probing ever shows in a profile. Open; the probe count is logarithmic in `maxCalls`.
- **P-35**: a process-id limit for allocation pods (the node's `podPidsLimit`, or a per-pod limit where the cluster offers one). Open; INT-05.
- **P-36**: the explicit routes of `09:77` (DNS, artifact, Git mirror, package mirror, model gateway, task dependencies) as profile fields, and an egress proxy or FQDN policy where a domain must be named. Open; each with the package that first needs it.
- **P-37**: a runner deployment inside the cluster (its namespace, Deployment, Service and the pod labels the allow rule names). Open; needed before A-43 can be tested, with INT-05.
- **P-38**: a source for repository-scoped grants of an allocation with no workspace (`knowledge_curator`, `discovery`'s telemetry without a checkout): today no row names a repository there (C16). Open; with W-090 or the first package that runs such a role.

### Estimate and split

| Part | Days | What is in it |
| --- | --- | --- |
| Step 0 | 0.5 to 1 | Six probes and the recorded one, after W-019's k3s tier has passed once. Items 1, 2 and 4 grew in review: evictions, `deletecollection`, the pod garbage collector (a fake node), two listeners and the node's ports. |
| 21a | 4.5 to 5 | Role table and its move; derivation (no workspace, no grants); the slot, the call marker and the probe in their own transaction; the proxy and the route; the protocol types and vectors; the shared `review` signature and per-profile identity; the input-grants check in the allocate transaction; the retirement; nine test files and the edits table's 21a rows. |
| 21b | 5 to 6 | The renderer and entry; four profiles (the checkpoint profile in full), three network policies, four admission policies, the LimitRange and the per-container params; the fake's admission model and its property test; the presence check with its failure table, the namespace and params reads; RBAC; the deny list and the cap; the control namespace with its own Role; moving conformance rows 1 to 21 there and replacing `kubectl exec`; `scripts/k3s.sh`; four fake files, conformance rows 22 to 28, four k3s files and the k3s helper edits. |
| **Total** | **10 to 12** | Against the backlog's 4–6 (D38), and up from 8 to 10 before review. The overrun is admission (chapter 09's full list, the checkpoint child, evictions and updates) and the k3s tier's own helpers, which the policies refuse. |

Each commit has an independent review. 21a can be reviewed without a cluster. 21b's review includes
a security reviewer for D44, D46 and D50.

### Definition of done

- **Step 0:** the six items run, each confirmed or answered by its fallback, with the script and output kept as W-019's were, in `docs/design/` rather than a session scratchpad; the owner is told before 21b if item 1 or 2 failed.
- **21a:** the nine new 21a files pass on the fake; W-017's and W-019's files pass with the 21a rows of the edits table and no other; W-018's eleven pass unchanged; `apps/api`'s suite passes without the deleted file; `pnpm check` is green. Independent review.
- **21b:** the four new fake files and conformance rows 22 to 26 pass on the fake, rows 1 to 21 pass on the fake with the model off, and `pnpm check` is green. `pnpm test:k8s` passes once on this machine on AC power, under the rendered policies: W-017's and W-019's k3s files with the 21b edits, W-020's k3s file and rows 29 to 31 unchanged, conformance rows 1 to 21 in the control namespace and 22 to 28 in the exec namespace, and the four new files. Independent review, with a security reviewer.
- **AC-19** is logged as fake tier, in full, replacing W-008's evidence. **AC-56** is logged as "local tier only", with the date, the k3s image digest, the refused-or-timed-out result per target, and the line "metadata denial not shown on this machine (A-35); real cluster not qualified (D4)".
- No migration; no new npm dependency; no file under `apps/worker` or `packages/workspace` changes, and in `apps/supervisor` only `args.ts:63` and its one test case. `apps/api/src/auth/capability-proxy.ts` is gone and nothing names `CapabilityProxy`. Nothing runs `kubectl exec` in the exec namespace.
- `docs/assumptions.md` has A-40 to A-46, and A-07 names W-021 as its closing package with "closed: grants derived by the runner"; `docs/spec-issues.md` has SI-43 to SI-48; `docs/plan-additions.md` has P-33 to P-38.
- The READMEs (`apps/runner`, `deploy/k8s`) state rules 11 to 13, the slot, its own transaction and the lock order, the W-075 rule, the route and its bucket, the profile table with the checkpoint profile, every admission rule, what admission does not police (`nodes/proxy` included), the presence check and its failure table, the deny list and what it cannot show, the control namespace's purpose and limits, the isolation limits of AC-56, the residual risks and what is not built.
- Nothing is left behind by either tier: each k3s file checks both namespaces at teardown, and `scripts/k3s.sh down` removes the control namespace with the cluster.

### Confidence

- **Verified by reading the repository (2026-11-19 and 2026-11-21):** every file and line cited; that the counters are an in-memory map incremented before the audit insert (`capability-proxy.ts:47`, `:79`, `:81`); that grant ids are random and grants live in the object; that only the AC-19 test and the index import the proxy; that `supervisor_identity` is stored and never read by the guard; that `audit_event` has no index but its primary key, is insert-only for the runtime role and insert-only for the retention role; that the fake mints tokens for the pod's own account; **that the conformance suite creates through the runner's client and the other k3s files through the admin** (corrected, C8), and that `w017-run.k8s` uses `kubectl exec`; that neither the allocation nor the stage run has a repository column; that the supervisor's parser also caps deny targets at eight and no test asserts that cap; that five existing tests build a production deny list without the metadata target; the default test role; W-020's file table and child shape as of 2026-11-21.
- **Verified by reading the Kubernetes source (master):** the CEL `request` variable carries the operation's options (`condition.go:154-156`); an eviction is admitted as a create of `pods/eviction` and deletes the pod without a pod-`DELETE` admission call (`eviction.go:152-153`, `:193`, `:382`). Not yet seen on k3s 1.36.6: step 0 item 1.
- **Inferred, not run:** all six step 0 items. The ones I trust least are item 2 (which identities k3s gives the Job controller and the pod garbage collector; if one identity is shared by all controllers, both the pod-create rule and the grace exemption are wider than intended) and item 1's `deletecollection` half (whether the policy is consulted per item). That `INSERT ... SELECT ... FOR SHARE ... ON CONFLICT` is accepted as written is Postgres grammar as I know it, not run; the first 21a test settles it. That Kubernetes CEL has no hash function (so a claim name cannot be recomputed) is from my knowledge of its libraries, not checked today.
- **From the Kubernetes documentation, not run:** that ValidatingAdmissionPolicy supports `CONNECT` and the `pods/ephemeralcontainers` subresource (item 3); that a LimitRange `max` without `default` may default limits (recorded only).
- **Judgement:** the 10-to-12-day estimate; the four profiles; the capability bucket (burst 20, one every 400 ms), the checkpoint listener's assumed one every 2 s, and their share of the review ceiling; the `maxCalls` defaults; the 5-minute presence interval and the three-error threshold. All rates go to P-14's load test with W-019's.
- **Where I would point the next review:** the checkpoint profile against W-020's revised renderer (open items 1 and 2 below); the slot's own transaction and the W-075 rule; the admission exemptions (D44); and whether anything a harness controls can make the presence check stop allocations (I found nothing: it reads only cluster objects the harness cannot reach).

### Response to review

Both reviews of 2026-11-21 (design: Livia; security: Furio) were checked item by item against the
repository and, for Kubernetes behaviour, the Kubernetes source. Taken unless the row says
otherwise.

| Item | Disposition | Where |
| --- | --- | --- |
| Design 1: the k3s tier breaks under 21b's own admission | **Taken, and C8 corrected**: the suite does create through `runnerKube` (`kube-conformance.k8s.test.ts:13`); its container names (`suite.ts:92`, `:211`, `:293`), missing labels, 64Mi claims and row 5's `ReadWriteOnce` control (`:117`) all fail the rules; `w017-run.k8s.test.ts:112`, `:208`, `:212` use `kubectl exec`. Rows 1 to 21 move to the control namespace with the fake's model off; the exec reads become node-side `crictl exec`. **One refinement:** the cluster-only RBAC rows 13, 15, 19, 20 and 21 keep asking about the exec namespace, because moving them would test the copy of the Role, not the real one; row 13 is asked once more for the copy. | C8, 21b, edits table, D45 |
| Design 2 / security M2: `takeSlotTx` inside the effect's transaction | **Taken as the coordinator decided**: `takeSlot` owns a short transaction keyed by `call_id`; the effect runs after the commit; the outcome is recorded separately; lock order advisory, then allocation. Written as a rule for W-075. | 21a, race rules 4, 5 and 5a, hand-offs |
| Design 3: repository grants have no source | **Taken**: no workspace, no grants; repository from the workspace row; the input check runs in the allocate transaction. P-38 records the gap. | C16, 21a |
| Design 4: the grace rule refuses the pod garbage collector | **Taken, by exemption rather than residual.** Refused, a pod on a lost node could never be removed by anyone (admission refuses the administrator too); W-019's node check already makes such a stop unproved. Its identity is probed in step 0 item 2, with a fallback. | D44, 21b, step 0, row 24 |
| Design 5: presence-check failure modes; the `profileCheck: 'off'` contradiction | **Taken, with one addition**: only a 404 or a difference stops, and only for a network policy; errors warn and retry. Added: at **start** an error refuses to start (the runner cannot show the cluster is protected), and three errors in a row refuse new work without stopping anything. The `'off'` switch is gone; item 6's fallback is "not built". | 21b failure table, step 0 item 6 |
| Design 6: the RoleBinding; `pod-guard.ts:191`; rows 13 and 15 | **Taken**: a Role of its own in the control namespace (C18); `capability` in the mapping (C19); rows 13 and 15 cover the new accounts. | C18, C19, edits table |
| Design 7: stale text | **Taken**: the overlap table is rebuilt from W-020's file table; Confidence and the numbering note are updated. | Files, the numbering of this merge |
| Design X1 / X2 / X3 / X4 | **Taken as the coordinator decided**: the checkpoint profile in full; one key, `profiles.checkpoint`, and one `review(req, { audience, subjects, bucket })` with per-listener subject sets; a third policy, `factory-exec-egress-checkpoint`; the checkpoint listener's share inside the one review ceiling (not a separate budget, which would let the sum pass the ceiling). | 21a, 21b, D42, D43, D50 |
| Design X5 | **Taken**: rows 29 to 31 run in the exec namespace under the `checkpoint` profile, after `w021-checkpoint-profile.k8s`. | Edits table |
| Design numbering | **Taken as decided**: D38 to D50, A-40 to A-46, SI-43 to SI-48, P-33 to P-38 (P-38 is new in this revision), no holes. | The numbering of this merge |
| Security M1: eviction | **Taken, confirmed in the source** (`eviction.go:152-153`, `:193`, `:382`). Of the two fixes offered, the grace rule on `pods/eviction` is taken rather than refusing all evictions, so a node drain still works and ends pods through their grace; `deletecollection` is probed too. | C15, step 0 item 1, row 24 |
| Security M3 | **Taken** (X3), with both sides tested. | 21b, T15, `w021-network.k8s` |
| Security L1: limits reset per epoch | **Partly disputed.** The bound the finding asks for already exists: a stage run has at most `maxGenerations` (3) allocations (`config.ts:21`, `:99`; D14), so a stage run's calls are at most three times the per-epoch limits. No new cap is added; the W-023 hand-off forbids resetting it with a new semantic attempt. | Race rule 8, hand-offs |
| Security L2: name-to-image tie; no container with both claim and token | **First half taken. Second half amended:** as worded, it refuses W-019's own supervisor, which mounts the claim read-only and the token (`job-manifest.ts:64`) because the workspace view needs both. The rule is per profile: only `supervisor` may hold the token, and only with a read-only claim; no container holds a read-write claim and the token; in `checkpoint`, no container holds both. | C17, 21b |
| Security L3: image updates; `nodes/proxy` | **Taken**: `factory-exec-update`; `nodes/proxy` documented under "what admission does not police". | 21b |
| Security L4: namespace labels and allowlist not checked; digest regex | **Taken, both ways**: the pod-security fields are repeated in the create policy, and the presence check reads the namespace and the params; the regex replaces "contains `@sha256:`". | 21b, D46, D47 |
| Security L5: claim and volume gaps | **Partly taken.** `volumeName`, `dataSource`, `dataSourceRef` and `selector` are refused, and the token audience is tied to the allocation labels. **Not taken:** tying `claimName` to the allocation label. The name is `factory-ws-` plus a base32 SHA-256 prefix (`names.ts:24`, `:28`), and to my knowledge Kubernetes CEL has no hash function, so a policy cannot recompute it. The residual list says so; only the runner's account can create either object. | 21b, residuals |
| Security L6 / L7 | **Taken**: `createConfig` refuses the control namespace; the node's 10250 and 6443 join the list; the cap rises to 16 in one constant (C20). That puts one line into `apps/supervisor/src`, against the brief's earlier "no change there". | C20, 21b |
| Security missing tests | **All added**: eviction and `deletecollection` (`w021-admission.k8s`, row 24); image `UPDATE` (`w021-fake-admission`, row 27); the supervisor running a non-supervisor image; claim `volumeName` and `dataSource`; Pod Security labels removed (`w021-presence-check`); `createConfig` with the control namespace (`w021-deny-targets`); checkpoint-port egress from both pod kinds (`w021-network.k8s`); a cancel against a slow effect (`w021-capability-liveness`); a child token on the pod listener (`w021-profile-identity`). | Tests |

**Open, for the coordinator or the owner:**

1. **The checkpoint audience: resolved.** W-020's revised master uses `factory-checkpoint:<childId>` (7.4, "The child's identity"), the same form as this brief's admission rule.
2. **The checkpoint resources key: resolved.** W-020's revised master uses `profiles.checkpoint.resources` (7.4 shape table and 7.5 config), the same key as this brief.
3. **D48** changes the plan's D13 and was accepted by the owner on 2026-11-22. Its follow-up is open: the pod artifact-read design goes to silvio before W-022's brief.
4. **C14: resolved.** The coordinator confirmed on 2026-11-21 that "H4/H6" was a mislabel in the assignment; the three W-017b hand-offs found in the repository are the intended ones.
5. **`checkpointPodRate`** is assumed at one every 2 s for the ceiling product; W-020 sets the real value, and the product is checked in configuration either way.

## 9. Risks

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

## 10. Response to the adversarial review

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

Round 6 (the W-020 brief, section 7). A design review and a security review of 2026-11-21, checked against `a119964`. The content is that of 7.12 of the brief, which points here.

Livia's design review (W-020 findings 1 to 15, X5) and Furio's security review (M1 to M5, L1 to
L5, "Also missing") were each checked against `a119964` before anything changed. All were taken,
three in a form other than proposed. The coordinator settled D30, the checkpoint account, the
child's shape, egress, the AC-13 and AC-16 claims and the probes' home (decisions 1 to 7 of that
day); they are applied as given.

| Finding | Checked | Change |
| --- | --- | --- |
| Livia 1 (sweep eats accepted parts) | `workspace.ts:151-155` checks one artifact | C21; every part linked under `checkpoint/...`; release checks each; W-024's test |
| Livia 2 (AC-13, AC-16 unreachable) | `start.ts:69-70`; no caller of `replaceWriter` on a completed stage | Material only; exit-evidence text (7.9); O1 |
| Livia 3 (`suspect → finalizing`) | `states.ts:16`, `reconcile.ts:39` | C20, **in another form**: finalize from `running` only, `suspect` retryable; no new edge |
| Livia 4 (W-019 files) | `kit.ts:68-73`; `w019-lifecycle.test.ts:22-39` | C24, the grant's `finalizeOffered`; edits table, **in another form** (below) |
| Livia 5 (no workspace) | `job-manifest.ts:47`, `pod-guard.ts:182` | C23 |
| Livia 6 (live child after give-up) | 7.4 step 3 as it was | Give-up ends the child first; race rule 16; test |
| Livia 7 (budgets) | Arithmetic as stated | Derived deadlines and two validation checks (7.4) |
| Livia 8, Furio M2 (memory, resources) | Whole-file reads at 7.3; no `resources` | Positioned pack reads, streamed trailer hash, `maxWorkBytes` counting delta output, per-object deadline, resources in the shape table; `w020-reader-limits` |
| Livia 9, Furio M5 (`/scratch`) | By POSIX, uid 10003 cannot unlink 10001's files in 0755 directories; `claimFactoryOwned` checks nothing (`git.ts:26-28`) | `export` and `work`; exclusive repository; `index-pack --strict`; hostile-export tests |
| Livia 10 (repeat finalize) | `pod-guard.ts:156`, `heartbeat.ts:98` | Any final denial after sending is `ending` (C17); lifecycle test with the pass |
| Livia 11 (duplicate finalize) | Guard needed `finalizing` | `result_ref` checked first; sweep keeps the Job one interval; race rule 11, **with a limit** (below) |
| Livia 12 (AC-14 test) | The live child would win | The test kills the child's pod; control |
| Livia 13 (lock order) | `start.ts:172`, `:185` | Rule 9; guard unlocked and advisory |
| Livia 14 (smaller items) | Each | C22; "Where each recorded digest lives"; deleted `sha256`; digest after exclusions; `pack.threads=1`; rows 29 to 31 cluster-only |
| Livia 15 (estimate, notes, probes) | `m2-plan.md:898` (the Risks table, now in section 9); the Summary does not mention it | 18 to 21 with arithmetic; the renumbering of sections 7 and 8; `docs/design/w020-probes/` |
| X5 (rows' namespace) | `suite.ts:328-329` | Rows 29 to 31 in the cluster block; move with W-021's rows |
| Furio M1 (pathspecs) | G4 reproduced; `git.ts:85-97` | Rule 8; `GIT_LITERAL_PATHSPECS=1`; stdin, NUL-separated; `-z` in the builder; tests |
| Furio M3 (second port) | `egress-listener-only.yaml` selects every pod | A separate policy by profile label; k3s test both ways |
| Furio M4 (exit code decides `completed`) | `06:7`, AC-231 | D30 `inconclusive`, accepted by the owner, 2026-11-22 |
| Furio L1 (`maxOutputLength: 0`) | Z4 reproduced | Cap of 1 for size 0; packed empty blob and tree in the fixtures |
| Furio L2 (walk from the mount root) | `job-manifest.ts:65` | `fs-safe` from `/workspace`; Buffer paths; layout test; FIFO and non-UTF-8 tests |
| Furio L3 (SHA-1 collisions) | Node has no SHA-1DC | Rule 8 and the residual risks; `index-pack --strict` is mandatory |
| Furio L4 (deny list) | As listed | Extended and case-folded, interim under A-38 |
| Furio L5 (`--cached`; deadlines) | The unstaged patch's base is the index | `git apply --index`; the deadlines of Livia 7 |
| Furio, "Also missing" | — | Child token at the pod listener; the checkpoint port from an authoring pod |

**Where this brief takes a finding differently, and why:**

- **Livia 3.** Adding `suspect → finalizing` would widen W-017's edge table for a state in which the runner already doubts the writer. A renewal returns `suspect` to `running` in the same supervisor's next beat (`allocation.ts:176`), so a retryable denial costs one beat and changes no table.
- **Livia 4.** The finding says `kit.ts` does not pin the wait, which is true of the file, but `kit.ts` builds its runner through `harness.ts:117` (`@factory/runner/test-harness`, `apps/runner/package.json:9`), so a pin there reaches it, and `apps/runner/test/k8s/supervised.ts` too. The race at a wait of 0 is real; the fix is the runner's offer in the grant, since the supervisor cannot know the runner's setting.
- **Livia 11.** A retried finalize can be answered only while the child's pod exists: once it is deleted, a fresh token review fails (section 2: "service account token has been invalidated"), and requiring the reviewed token is the finding's own condition. The brief keeps the Job for one reconcile interval after acceptance; a retry later than that is refused, the result is stored either way, and nothing depends on the child hearing it.
- **Furio M5's `--strict`.** I expected `index-pack --strict` to refuse trees that W-018's clone accepts. G3 shows it does not for the two cases checked (a `100664` mode is a warning in both, a zero-padded mode is refused by both), so `--strict` is taken as proposed. G3 also showed that this brief's earlier text, which accepted zero-padded trees, was wrong; 7.3 now refuses them.

## Confidence

- **Verified by running or reading today:** the package list, order, dependencies and acceptance IDs; every row of the section 2 table; the hard-link and relative-worktree behaviour of Git 2.50.1; the code and schema facts cited in sections 4 and 5.
- **Inferred, not tested:** that kind and k3d offer nothing extra here; the size column; the reader's 3–5 days; that durable capability counters fit without a new table (answered by design in section 8, D40: they fit in `audit_event` with no migration; not yet shown by a run); the SI-13 and SI-14 choices.
- **Measured on one cluster only:** the network-policy start-up window. It says nothing yet about any other CNI.
- **Section 5 (W-017), verified by reading today:** the `execution_allocation` columns, indexes and grants and the conclusion that no migration is needed; W-018's interfaces as committed; the boundary rule that apps are not importable; the worker's stage-run insert, input hash and budget key; the spec lines cited.
- **Section 5, run on k3s in the third session:** the termination-message receipt and the pod-bound token review, which the design rests on. One assumption of mine was wrong and is corrected: a review does not fail the moment its pod is deleted.
- **Section 5, inferred and not run:** the nine items listed as "to confirm in the k3s tier". The 8-to-10-day estimate is a judgement. That `settleWorkspace` covers every interleaving of a permit and a stop is argued in the brief and tested at two fault points; it is the part I would ask the next review to attack first.
