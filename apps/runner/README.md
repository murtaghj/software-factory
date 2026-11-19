# @factory/runner (W-017: 17a the controller, 17b the pod side and the k3s tier)

The Kubernetes controller and Job protocol (chapter 06, `docs/m2-plan.md` section 5): at most one live
allocation, one Job and one writer per stage run, kept true when two controllers race, when a controller
dies between any two steps, and when Kubernetes shows a duplicate pod. No Temporal, no supervisor
(W-019), no migration, no network listener (D12): the service is an object, and every input is validated as
if it had come off the wire. 17a is the controller, the port, the fake and the permits. 17b adds the pod executor
(the `materialize` init container), PVC removal and release, the process entry, the manifests and images, and the k3s
tier, which runs the same conformance suite against a real cluster.

## Three rules

1. **No Kubernetes call inside a database transaction.** Every operation is unlocked preparation, then a
   short locked phase that touches only Postgres, then commit, then Kubernetes. A session lost in the locked
   phase means nothing outside the database happened; the call fails with the session's own error and is safe to retry.
2. **Two controllers are never kept apart by a lease.** They are kept apart by deterministic ids and names,
   the three uniqueness rules in the schema, compare-and-swap on epoch and state, and the 409. Either can finish
   what the other started, and neither undoes what the other bound.
3. **`terminated` is a proof, not an event.** It is reached only through `terminateTx`, after
   `evaluateQuiescence` (a pure function over pod and container status). It proves that no pod of the allocation was
   running when it was read; it cannot stop a controller paused in the middle of a create (a Job that appears
   afterwards can never get a permit and is deleted on sight).

## Which part runs where

| Part | Runs in | Touches |
| --- | --- | --- |
| `createRunner` (`startOrAttach`, `getRun`, `describeRun`, `cancel`, `getResult`) | The runner process | Postgres; after its commit one reconcile pass |
| Workspace facade (`allocateWorkspace`, `releaseWorkspace`) | The runner process | W-018's manager, called with the runner identity and the caller's task scope |
| Reconciler (`reconcileOnce`, `reconcileOne`, loop every 15 s with 20% jitter, `sweepJobs`) | The runner process | Postgres and the `KubeApi` port |
| Permit service (`acquireStartPermit`, `renewPermit`) | The runner process; its caller is the supervisor (W-019), in 17a the tests | Postgres, a token review and one pod read per call |
| `KubeApi` port, `HttpsKube` | The runner process | The cluster API |
| `FakeKube`, `FakeKubelet` (`@factory/runner/testing`) | The test process | Memory and local child processes in their own process groups |
| Pod materializer entry (`src/pod/materialize-entry.ts`) | A trusted init container of the allocation Job, alone on the empty volume | The volume only: no database, no identity token, no factory credential |
| `PodVolumeMaterializer` (the workspace manager's `GitMaterializer` in pod mode) | The runner process | The port, and one read-only lookup ("does this workspace have a live allocation") that opens and closes its own transaction |
| `startRunnerProcess`, `main.ts` | The runner process | Checks the storage class first (reclaim policy `Delete`, D15), then builds the manager, the runner and the loop |
| `scripts/k3s.sh`, `deploy/k8s`, `deploy/images` | The developer's machine and the podman machine | The opt-in cluster (17b) |

## The allocation row and its states

No migration. Identity columns are written once; `state` moves by compare-and-swap on id, epoch and expected
state; `job_uid` and `pod_uid` go from null to a value once; `controller_lease_until` is the deadline of the
current phase (start deadline in `desired` and `starting`, the writer's lease in `running` and `suspect`, the
stop deadline in `stopping`). Every age and deadline is computed in SQL on `clock_timestamp()` after the row is
locked; `Date.now()` is forbidden by lint in `src`.

| State | `RunHandle.state` |
| --- | --- |
| `desired` (row committed, nothing confirmed), `starting` (Job bound, no permit) | `accepted` |
| `running` | `running` |
| `suspect`, `stopping`, `quarantined` | `reconciling` |
| `finalizing` (W-019/W-020, left alone here) | `finalizing` |
| `terminated` | `cancelled` if the run has a cancel record, else `reconciling` (the next `startOrAttach` allocates a new generation) |
| `completed` (later packages) | `completed` |

Legal edges are one table (`src/states.ts`); every other pair is refused. A new generation after `quarantined` is
intended (`06-runner-workspaces.md:25`); it is fenced through `replaceWriter`, gets a new PVC, an audit row, and
D14's limit of three generations counts it.

## The cancel record (D18)

One `audit_event` row per stage run, id a version-8 UUID of SHA-256 of `factory-run-cancel/1`, the organization
and the logical stage run id; `actor_id` the runner identity, `action` `runner.cancel`, `resource_kind`
`stage_run`, `resource_id` the logical stage run id, `outcome` `accepted`. Written under the stage run's
`FOR UPDATE` lock, read back by primary key; a row at that id with other fields is a hard error
(`cancel_record_conflict`). A cancel after a terminal result writes nothing.

## Workspace states (D17)

`markWriterQuiescing` (`active` to `quiescing`) is called on every `stopping` pass; `markWriterStopped`
(`quiescing` to `retained`) on the proof. `stopping` to `terminated` locks the workspace `FOR SHARE` first and
is refused while the workspace is `active` or `quiescing` at this epoch for the allocation's pod; the pass
settles it and tries again. A permit whose `markWriterStarted` lands after `terminated` settles the workspace
itself, and `releaseWorkspace` does so again before delegating. A `quarantined` allocation leaves the
workspace `quiescing`, and `release` refuses it.

## Permits (runner side)

`acquireStartPermit` and `renewPermit` take `{ token, orgId, allocationId, epoch, source? }`. Each call, in order:

1. Shape checks (token at most 8 KiB, ids, epoch). Nothing is written.
2. The failed-token memory, keyed by SHA-256 of the token and the audience (a token that failed for one allocation is
   not refused for the one it is for).
3. The per-source cap hook (`deps.admitSource`, for W-019's listener to fill in).
4. **Local verification, before the shared review budget is spent** (`src/token.ts`): the signature against the cluster's
   own service-account JWKS (`/openid/v1/jwks` through `KubeApi`; the runner's ClusterRole needs `get` on that
   non-resource URL, and conformance row 13 asserts it on k3s), `exp` (60 s of clock-skew allowance, the same as `nbf`),
   the key's type bound to the algorithm (RS256 needs an RSA key, ES256 an EC P-256 key), the exact audience `factory-allocation:<org>:<allocation>`, the subject (the configured supervisor
   service account in the execution namespace) and the pod-binding claims. A flood of junk tokens therefore dies here
   and cannot starve anyone's renewals.
5. The shared TokenReview budget (token bucket; `perSecond` is sized from the pools: four times the allowed writers
   divided by the beat, 20 at least), then the review itself: authenticated, no error, the audience listed in
   `audiences`, the subject, and the pod name and UID equal to the token's own claims.
6. The pod read: same UID, no deletion timestamp, this allocation's label, owned by its Job.

Refusals before step 6 write nothing and are counted by reason (`permitRefusals()`); callers that are not configured
control-plane identities are counted too (`refusalCounts()`) and write nothing. Only after a good review is a denial
audited. Acquire then does the candidate check (init step exit 0 with a receipt equal to the accepted one), the one
compare-and-swap on `pod_uid` that picks the winner, `markWriterStarted`, then `starting` to `running`; a run that has a
cancel record is never started, whatever state its row is in. A crash between steps is repaired by the same pod's retry.
Denials after a good review are typed and audited (`not_this_job`, `duplicate_writer`, `no_receipt`, `stale_epoch`,
`not_ready`, `not_startable`, `not_renewable`).

The key set is reachable without authentication, so it never fans out to the cluster: one fetch in flight at a time shared
by every caller, no new fetch for 5 s after a failed one, a refetch for an unknown key id at most once per 30 s, a refresh
every 5 minutes, and the last good key set served for up to an hour when the cluster cannot be reached (safe, since
TokenReview stays mandatory). A token whose key id is not known is a retryable `review_unavailable` and is **not**
remembered as failed, so a key rotation heals itself after one refetch. Null or malformed entries in the key list are skipped.

## Attach: the whole Job is compared

An existing Job under our name is attached only when its annotations are ours **and** its whole spec equals the re-rendered
one, exactly. Both sides first get the API server's known defaults filled in where absent, and the keys the server
generates (the selector, the four generated pod-template labels) stripped; resource quantities are compared as numbers
(`0.5` is `500m`). Any other key on the Job spec, the pod template's metadata, the pod spec, or any container or volume
(a command, a hook, a probe, `envFrom`, a host port, `dnsConfig`, host aliases, tolerations, a runtime class,
`managedBy`, a sidecar `restartPolicy`, a label on the template, ...) is a difference and quarantines the allocation.
**Defaults the API server adds, confirmed on k3s 1.36.6** (a default the cluster adds that is not listed makes every attach
quarantine, which is the safe failure, and is exactly how the tier found `manualSelector`; the quarantine's audit reason now
names the differing paths): `imagePullPolicy` (IfNotPresent for a
digest or a tag other than `latest`), `terminationMessagePath` (`/dev/termination-log`), `dnsPolicy` (`ClusterFirst`),
`schedulerName` (`default-scheduler`), the deprecated `serviceAccount` alias, the projected volume's `defaultMode` (420),
`parallelism` and `completions` (1), `completionMode` (`NonIndexed`), `suspend` (false), `podReplacementPolicy`
(`TerminatingOrFailed`), **`manualSelector` (false; the one default the list lacked until the k3s run)**, the generated `selector`, and
the four generated template labels. All were read back from a live Job on k3s 1.36.6; the whole-Job comparison of a real
second controller's attach is empty. The check covers the create path; it does not replace RBAC.

## Receipt rules (`src/pod/receipt.ts`)

Only the `materialize` init container's status is read; the harness container's message is never parsed. Policy
`File` is pinned (the fallback policy would deliver a failed step's log tail as the message). A receipt counts only
with exit code 0 and a refusal only with a non-zero one (`receipt_inconsistent` otherwise). The message is capped
at 4,096 bytes before parsing and must be exactly the canonical text the entry writes (fixed key order, fixed-length
hex values, no duplicate keys, no whitespace). It then goes to `acceptMaterialization`, which checks generation,
epoch and commit under the row lock. Two pods with the same receipt are both candidates; before the writer claim no
candidate is deleted, after it `pod_uid` governs and every other pod is deleted.

## Capacity (A-30)

Pool `verifier` or `authoring` by role, 10 each, one row per allocation keyed `<pool>/g<generation>`; see A-30.

## W-019, 19a: the pod-facing side

The supervisor, the launcher, the manifests' new arguments, the images and the k3s files are 19b. This commit is the runner's side, built and
tested in the fake tier with tests as the callers. Section 6 of `docs/m2-plan.md` is the brief.

**Seven rules.** W-017's three stand; the first gains "no object-store call inside a transaction either". Four more. (4) Authority is the
runner's answer to this call, checked against the lease: every route that grants or changes state carries `controller_lease_until > clock_timestamp()`
in its own locked statement and every grant refreshes it. (5) Only the pod delete stops a writer; nothing reported from inside the pod decides
anything. (6) A stored proof is a one-way door: once an allocation has a proof it can only become `terminated`, and every move to `quarantined` reads the
proof link under the row lock and refuses when one exists. (7) One generation, one claim, one writer (D19).

**Admission, in this order** (`src/listener/pod-listener.ts`, `src/pod-guard.ts`), each step so that the next cannot be starved by someone who failed the
one before: (1) new connections per source, 5 a second, burst 20, on the plain socket before any TLS work; (2) open connections, 512 in all and 4 per source,
5 s handshake, 5 s headers and body, 10 s per request, 16 KiB of headers; (3) source charge: every request is charged to its source (10 a second, burst 50)
**unless its token verified locally**; (4) local verification; (5) the per-pod bucket, keyed by the pod UID in the token that just verified (burst 5, then one
every 2 s); (6) the shared review budget, sized each pass from the running and suspect writers (`max(20, 2 x podRate x writers)`, to a ceiling of 200);
(7) the guard. TLS is always on (D23); the only plaintext is the test configuration's flag.

**The route table.**

| Route | States | Workspace clause | Lease clause |
| --- | --- | --- | --- |
| acquire, first commit | `starting` | at this epoch; `allocated`, or `active` owned by this pod | `starting -> running` only while the start deadline has not passed |
| acquire, wherever it finds the row `running` for this pod | `running`, `suspect` | as renew | it is the renewal statement |
| renew | `running`, `suspect` | at this epoch, owned by this pod, `active`, in the same `UPDATE` | unexpired, and refreshed |
| stop-ack | `stopping` | at this epoch, owned by this pod, `active` or `quiescing` | none: it grants nothing and changes no state |

**Records.** Audit rows with deterministic ids (D18): writer start (`factory-writer-start/1`), stop acknowledgement, cancel stop (written only in the
transaction where `cancel` itself makes the transition), urgent stop (per stage run). Controller artifacts, through `prepare`, `register` and `read` in
`packages/workspace`: the `QuiescenceProof` (`quiescence_proof/<allocationId>`) and the `QuarantineRecord` (restricted, `quarantine_record/<allocationId>`).

**The proof's conditions** are W-017's plus: the writer's node still exists with the recorded UID when the allocation has a start record and the writer's pod is no
longer listed; no unfinished pod, labelled or not, names this generation's claim (a namespace list with no selector, and a capped list is not proved). The
body keeps the writer's pod and at most 99 others, with their count and a digest of all of them.

**The hold** (`06:90`): a stop caused by a cancel waits, and deletes nothing, while the allocation has a cancel-stop record, the stage run has no urgent stop,
a start record exists, the last heartbeat was within `suspectSeconds` of the stop, no acknowledgement exists and the row has been `stopping` for under
`cancelCheckpointWaitSeconds` (30). A stop for a lost lease, a lost pod or a container exit never waits.

**`volumeDisposition`** (`packages/workspace`): `in_use` (live, no proof); `quiescent` (`stopping` or `terminated`, a `no_consumer_pod` proof, node check passed or not
needed); `quarantined` (with its record); `unknown` otherwise, and for any storage but `pod_scoped_local`. No answer permits a second writer.

**Configuration fails closed.** Outside the test configuration `review.ceilingPerSecond` is a safe integer of at least 20 (default 200) and the budget is sized from
the writers on every pass, with the tokens it has left carried over; a token bucket refuses a rate or burst that is not a finite number above zero; the listener's key
must be ECDSA P-256 and pair with its certificate, and its host a literal, specified IP address, all checked when the configuration is built; `buildConfig` refuses
`test` unless it is the test configuration, and a built configuration is frozen. A pass reads the API's objects as it sends them: an empty `volumes`, `labels` or
`annotations` is omitted, and every reader says `?? []`. An unreadable writer node is retried, not quarantined, until `nodeReadGraceSeconds` (60) past the stop
deadline; only a 404 or a changed UID is "gone".

**The writer start record's `report` is untrusted text**: it is whatever the supervisor sent, capped at 1 KiB and stored as reported. Anything that later displays
it must treat it as untrusted.

**19b hand-off.** The production entry (`runnerProcessFromEnv`) must read the network gate and the pod listener from the environment, with a test that starts the env
entry against the fake. Until then it fails closed (the gate is `required` with no deny target).

**Deployment invariants (added).** The listener must see real pod addresses: run the runner in the cluster with no source NAT in front of it. Behind NAT the
per-source limits mean nothing (step 0 on k3s: every pod arrives as `127.0.0.1`).

**Residual risks (added).** The object store is now needed to finish any stop. A runner outage longer than the fence time stops every writer (D27, P-28).
Every proof lists the whole namespace, under the port's cap of 500 pods. Moving the listener to a worker thread is not built (P-29). The node check excludes a
deleted node, not an operator's out-of-service taint. A quarantined allocation's process is not stopped again by anything here; its Job's deadline bounds it.
Until W-024 ships a quarantined volume can be removed early only by hand.

**Not built in 19a.** The supervisor, the launcher, the scripted harness, the CA and the manifest arguments, the images and `scripts/k3s.sh` changes, the 0750
modes, the fake kubelet's token files, volumes and ports, and the k3s files (19b); `finalizing` (W-020, D22); `watchEvents` and log chunks (D26).

## W-019, 19b: the pod side

`apps/supervisor` (README there), the manifest's arguments, the modes, the images, the fake kubelet's extensions, the production entry and the k3s files. Fake tier first: `tests/recovery`
runs the real runner, its listener (TLS, a throwaway CA), `FakeKube` and the fake kubelet with the real supervisor and launcher as processes from the test entries in `tests/recovery/test/entry`
(the production entries read no environment variable, and the supervisor's refuses a loopback runner URL). Every cross-app file keeps at most two live pods and moves time by backdating rows; the only
real waits are a fence time, a beat or the hint flood's ten beats, because the supervisor's own clock is monotonic.

- **Manifest** (`job-manifest.ts`; still a pure function of rows and config, no `StageInput`): with `config.supervisor` the supervisor's arguments are `serve --org --allocation --epoch --generation [--workspace]
  --runner <url> --runner-ca-sha256 <hex> --listen 127.0.0.1:<port> --network-gate <mode> [--deny-target ...]`, the harness's `harness --supervisor http://127.0.0.1:<port> -- <program>`, and the identity volume gains
  a `configMap` source for the listener's CA (`runner-ca.crt`). The CA is public; the token stays the only secret in the volume. Without `config.supervisor` (W-017's stub containers) the old arguments stand.
- **Modes** (`packages/workspace/src/internal/pod-mode.ts`, not re-exported): the pod export makes `/workspace/factory` and every level the materializer makes 0750 and sets `umask 027` before Git, so `git/` and
  `work/main` come out 0750 and their files 0640. Every host path keeps 0700; a `PodMode` can be minted only in that module and reaches the materializer under a private key.
- **Images** (`deploy/images/supervisor`, `deploy/images/harness-scripted`): built from staged contexts of named files (`scripts/k3s.sh stage`), tini, a numeric user, apk removed, no test entry. The harness image is built
  once per script.
- **`scripts/k3s.sh up`** also makes a throwaway CA and an ECDSA P-256 listener certificate named for the host-gateway address (keys outside `.k3s/ctx`, 0600, the CA key deleted once the certificate is signed; `sh scripts/k3s.sh pki`
  does only that), applies the CA as an **immutable** ConfigMap (the script holds the admin certificate; the runner's account never writes a ConfigMap), writes the digest and the listener's address and port to `.k3s/env`, and
  applies `deploy/k8s/local/egress-listener-only.yaml` on **every** run.
- **RBAC**: `get` on `nodes` (ClusterRole) and a Role in `default` that names only the `kubernetes` Service.
- **Configuration** (`createConfig`): a production configuration needs the supervisor contract AND the pod listener together (otherwise a Job would render W-017's ungated arguments), a `required` gate (D24: `disabled` is the fake tier's), and a runner URL that is https and not loopback, link-local or unspecified (one definition, in `@factory/runner-protocol`). The test builder keeps W-017's stubs.
- **Test seams** are not on the exported API: `composeFromEnv(env, kube)` is exported from `@factory/runner/testing` (the production `runnerProcessFromEnv(env)` takes no cluster client); `@factory/runner/test-harness`, `@factory/runner/testing`, `@factory/supervisor/testing` and `@factory/workspace/pod` are restricted in `tools/boundaries.json` (`restrictedModules`), the last to `apps/runner/src/pod/**`.
- **The production entry** reads `FACTORY_NETWORK_GATE`, `FACTORY_POD_LISTENER` (host, port, certFile, keyFile) and `FACTORY_SUPERVISOR`; with none of them set the gate is `required` with no deny target and start-up refuses
  (`w019-main-env.test.ts` starts the entry against the fake).
- **k3s files** (`pnpm test:k8s`, on AC power, never beside the full suite, one gating supervisor at a time because every pod is one source through the gateway): `w019-supervised-run`, `ac-15-tree-stop`,
  `w019-network-gate`, and conformance rows 16 to 21.

**What k3s showed in step 0 and 19a that 19b relies on:** pods reach the listener at `192.168.127.254` over loopback (the listener binds `127.0.0.1` and sees source `127.0.0.1`); `169.254.169.254:80` is refused even with no
policy, so that target shows no rule active here; a second mount under `fsGroup` rewrites modes, so the 0700-control of a directory holds on the first mount only.

## Known limits

- `reconcileOne`'s inline budget is a deadline that list calls (and the checks between passes) see; the other Kubernetes calls
  (create, get, delete, review) still have only their own 10 s timeout, so one pass can overrun the budget by up to that.
- `deps.onError` is optional; when absent, an error after a commit is logged as a warning (never dropped).

## Hand-offs

- **W-019:** every directory level W-018 makes is 0700: `ensureSafeChild` (`packages/workspace/src/paths.ts`, the organization and workspace levels),
  and `materializer.ts` where it makes the workspace directory and the staging path (`mkdirSync(..., 0o700)`), plus this entry's `/workspace/factory`. They are owned by the
  harness user (10001). The supervisor (uid 10002, `fsGroup` 10001) mounts the volume read-only and can read none of it, so a 0750 root alone
  changes nothing. W-019 must change W-018's directory modes in those three places (`assertSafeRoot` and `ensureSafeChild` only test `& 0o022`, so
  0750 passes them), and this entry's root mode with them. Not changed in W-017.
- **W-021:** besides what the plan lists: an egress NetworkPolicy that blocks internal and cluster addresses (the API server, the metadata
  endpoint, other pods) for the allocation pods, and a ValidatingAdmissionPolicy that backs A-25 (only the runner's account and the Job controller
  create Jobs, pods and claims in the execution namespace; nothing else uses the supervisor's account), since Role bindings are only half of it.

- **W-023:** the stage budget (see above): either reserve for every runner stage, or define what an unbudgeted task does; as it
  stands the runner answers `budget_not_reserved` for it every time.

## Residual risks

- Someone with cluster rights who force-deletes a pod can make "no pod" untrue. The port has no grace parameter, the
  client sends 15, and a lint rule forbids the field elsewhere in `src`; the runner's Role is the only delete right.
- Kubernetes removes the pods of a deleted node while that node's processes may still run (not tested; a single-node
  cluster cannot show it). On a real cluster the proof must also read the node (D4, W-019).
- A paused controller can create a PVC and a Job for an allocation that has since been stopped. The Job can never get
  a permit and is deleted on sight by the next pass; **the PVC is not covered**. If the workspace was released in
  the meantime, a labelled PVC stays under a `released` row until W-024 finds it by label.
- "Released" means the PVC object is gone; removal of the bytes is the storage class's reclaim.

## Decisions the brief left open, and where this build chose

- **Check order in `startOrAttach`.** Field conflicts (input hash, role, node, attempt, limits) first; then a terminal result
  (the completed handle); then the cancel record (`run_cancelled`); then the task and stage-state refusals
  (`task_not_running`, `stage_run_not_current`); then the specHash comparison over every allocation; then a live
  allocation; then budget, workspace, generation limit and capacity. A finished or cancelled run therefore never answers
  with a stage-state error. The brief lists the task and stage state first and calls them all `conflict`; this build uses
  its own codes and moves them after the result and cancel checks.
- **"Stage run id" is the logical id** in the cancel record's id and `resource_id`, and in the allocation id derivation.
- **A cancel is judged on the locked row.** It locks the stage run, writes the record, then locks the allocation row and
  stops it from whatever state that row is in (desired, starting, running or suspect). The record is also read by the
  permit's claim and its final commit, so a run with a record is never started.
- **The cancel record's actor is not compared**, so renaming the runner identity does not turn old records into conflicts;
  the action, resource kind, resource id and outcome must match.
- **A call that has committed does not fail on what comes after.** `startOrAttach` and `cancel` catch errors from the
  post-commit reconcile pass (reported through `deps.onError`) and answer with the handle; the loop finishes the rest.
  `reconcileOne`'s budget is a deadline that the list calls see (`ListOptions.signal`), not only a limit between passes.
- **Cross-organization.** A start whose input names another organization than the caller is `forbidden` and audited in the
  caller's own organization. Reads of another organization's run (`getRun` and the rest) cannot see it and answer
  `unknown_stage_run` with no audit row. An identity that is not configured is never audited: it is counted in memory
  (an audit row would be written into an organization of the caller's choosing).
- **An extra fault point**, `runner.before_writer_started`, sits just before `markWriterStarted`; without it the case where
  the writer lands after `terminated` cannot be forced. The fault hook itself (`src/faults.ts`) lives in this package, so
  production code never loads `@factory/test-support`.
- **Pod read order.** `passStarting` processes pods in the order the cluster listed them. Two controllers may read in
  different orders; the outcome does not depend on it (a candidate is never deleted before the claim, the claim's
  compare-and-swap picks the winner).
- **Unbudgeted tasks** are refused by the runner with `budget_not_reserved` every time: the worker reserves a stage's
  budget only when the plan carries a ceiling (`apps/worker/src/workflows/stage-execution.ts:16`). W-023 must either reserve
  one for every runner stage or decide what the runner does without one (hand-off below).

## Deployment invariants (S3)

- Only the runner's service account and the Job controller may create Jobs, pods and PVCs in `factory-exec-local`, and
  nothing else may use the `factory-allocation-supervisor` service account (no one else may mint tokens for it or create a
  pod that runs as it). Whoever can do either can forge the very objects the controller attaches to. The controller's
  defence is partial: an attach compares the live pod template to the re-rendered one (security-relevant objects exactly,
  defaulted fields tolerated; extra host paths, host networking and a different service account, image or security context
  quarantine the allocation). That covers the create path; it does not replace RBAC.
- The k3s tier asserts the RBAC half as conformance rows 13 and 15 (registered only where there is a cluster). Both pass on k3s 1.36.6.
- Jobs render `enableServiceLinks: false`. A production configuration (`createConfig`) must pin every image by `@sha256` digest
  and bind every control-plane identity to an organization (`identityOrgs`); it accepts no test switch. The unpinned, unbound
  variant is `createTestConfig` in `@factory/runner/testing`, which the production entry does not import (a test checks it).
- A production deployment must set `FACTORY_POD_LISTENER`, `FACTORY_SUPERVISOR` and `FACTORY_NETWORK_GATE`. Without the first
  two together the runner refuses to start (it would otherwise render W-017's ungated Job arguments), and the gate may not be
  `disabled` in production.
- The listener CA's private key never reaches a pod, a harness image or a build context. The supervisor trusts that one
  pinned CA and no system roots, so a process on loopback or a name that resolves to loopback cannot impersonate the runner
  without it (INT-05).
- A configured identity's denied calls are audited at a bounded rate per identity (`refusalAudit`, 5 a second, burst 20); the
  rest are counted (`audit_capped`).

## The pod side (17b)

**Two phases.** In the runner, the `desired` pass calls W-018's `materializationRequest` (its only call site) and puts the answer in
the init container's arguments: `['materialize', '--request', <canonical JSON>]` (`renderJob`). It holds no secret. In the pod,
`src/pod/materialize-entry.ts` parses the request once and compares it to its canonical text (at most 8 KiB, exact keys, UUIDs, a full
object id, a branch and a subpath that pass anchored patterns; a `bundle` request is `not_supported`, D13), then runs W-018's
`LocalMaterializer`, unchanged, as the harness user (uid 10001). Its root is `/workspace/factory`, a subdirectory it creates itself with
mode 0700 (a provisioned volume's mount point is group- and world-writable and W-018's `assertSafeRoot` would refuse it). It writes one
line to its termination message with `encodeReceiptMessage` (and exits 0) or `encodeRefusalMessage` (and exits non-zero: 2 for a request
it refuses, 1 for a materialization that failed, 143 on TERM). On TERM it aborts: Git's process group is killed and awaited, the staging
path is removed.

**Which remotes.** The production entry accepts `https://` URLs only, with no userinfo, so no credential can ride in a clone URL; Git
itself has `file` off (`protocol.allow=never`) unless a `GitRunner` is built with the test-only option. The `file` transport is a property of
the test image's own entry file (`test/pod/materialize-test-entry.ts`, A-31), which also accepts the fixture over `file:///`. Nothing in
a Job, an argument or an environment variable switches it on in the production entry (a test sets hostile ones). The fixture bare repository
is built by `scripts/k3s.sh` with a fixed author and date, so its commit id is the same on every machine.

**`PodVolumeMaterializer.remove`** (what W-018's `release` calls once the row is `releasing`): `absent: false` while the workspace has a live
allocation (N5; the facade refuses with `allocation_live` first, and this is checked again inside `remove`), while a pod carrying the
workspace and generation labels exists in any phase, while the claim under the derived name is not ours (exact label match, nothing is
deleted) or is replaced during the wait; the claim of the generation is deleted by the UID just observed and read until 404 (30 s); then
any claim left with the workspace's label, of any generation, or a list that stopped at its cap, is `absent: false`. Only an empty list is `absent: true`, so
no row is `released` while a PVC with its label exists (D15), and an older generation's claim leaves the row `releasing` with `needsOperator`. Every
failure is an `absent: false` with a message; nothing throws and an unknown outcome is never "absent".

**The order for callers** is cancel, wait for `terminated`, then release through the facade: `allocation_live` and `writer_active` are retryable. A workspace with a **quarantined** allocation is refused (`allocation_quarantined`, `needsOperator`) even before any permit: nothing proved its pod stopped, so its PVC is untouched. The ownership check in `remove` is `pvcIsOurs`, the predicate the attach uses (task label included). `checkpoint_not_accepted` is not retryable until W-020.

**Images** (`deploy/images`, built by `scripts/k3s.sh` from staged contexts): `materializer` (node:24-alpine pinned by digest, Git from the
distribution (2.54.1 at the build), the entry and the six files of the workspace package it loads plus `@factory/domain`; a stub stands in for
`@factory/database`, which the path module imports for a function the pod never calls, so the image carries no database client),
`materializer-test` (the production image plus the test entry and the fixture), and `stub` (one tag per behaviour: `factory-stub` runs
until TERM, `-ignore-term`, `-exit0`, `-exit1`, `-message`, `-stderr-fail`). The materialize container has its own `emptyDir` at `/tmp`
(Git's private home and temporary files; the root file system is read-only).

**Manifests** (`deploy/k8s`): the execution namespace with Restricted pod security; two service accounts (the runner's, and the supervisor's,
which has no Role at all); the runner's Role (jobs: create, get, list, delete; pods: get, list, delete; claims: create, get, list, delete) and a ClusterRole
(token review, `get` on storage classes, `get` on the non-resource URL `/openid/v1/jwks`). No patch, exec, watch or collection delete.

## The k3s tier

**This is a privileged container in a rootful VM (A-28). It is a test rig, and must never run a real harness or any candidate code.**

`sh scripts/k3s.sh up` starts the pinned `rancher/k3s:v1.36.6-k3s1` (by digest) as a privileged container on the ROOTFUL podman connection
(2 CPUs, 1,800 MB; traefik, servicelb and metrics-server off), applies `deploy/k8s`, builds and loads the images, and writes `.k3s/`
(CA, the runner's token, the admin certificate for the driver, the fixture commit). `pnpm test:k8s` runs `*.k8s.test.ts` with one worker; the
default configuration excludes them (`tools/test/k8s-exclusion.test.ts`), so `pnpm test` and `pnpm check` never do. **A missing cluster
or a missing compose Postgres fails the run with one line; it is never a skip.** Run it on AC power and never beside the full suite;
`sh scripts/k3s.sh down` removes the container, its volumes, the images it built and `.k3s/`. The runner's own client uses the runner's
service-account token, so a call outside its Role fails in the tier the way it would in production; the admin certificate is for the driver only (raw
requests the port does not offer, token minting, RBAC questions, cleanup).

- `kube-conformance.k8s.test.ts` runs the shared suite (`test/conformance/suite.ts`), rows 1 to 15 including the cluster-only 13 and 15 (RBAC,
  asked through SubjectAccessReview with the groups the API server gives a service account).
- `w017-run.k8s.test.ts` runs the real controller: controller A dies right after creating the Job and B attaches it (the whole Job compared);
  twelve concurrent starts over two controllers; the init container clones the fixture and its receipt is accepted; a hand-made second pod on the
  claim stays Pending and its token is refused, while the token read from the allocation pod's own projected volume is granted; cancel, retained, the
  PVC survives; release is refused without a checkpoint, and with one seeded it removes that generation's PVC and the backing directory.

### What k3s showed (v1.36.6, local-path, containerd; where it differed from what the brief or the fake assumed)

- **`/openid/v1/jwks` answers 406 to `Accept: application/json`**; it is `application/jwk-set+json`. `HttpsKube.getServiceAccountJwks` asks for that. The
  cluster's keys are RS256 (the fake's were ES256); both are verified.
- **The server writes `spec.manualSelector: false`** on a Job that sets none. Added to the attach defaults; a live `true` still differs.
- **Row 4.** TERM does reach both containers at once (the container runtime shows the polite one exited at once, through `crictl`), but the
  **pod status keeps that container `running` until the whole pod is gone**: the API never shows a Terminating pod with one container finished. The fake
  publishes the exit. The quiescence proof is safe either way (a Terminating pod is "not finished" until it is gone); the suite now asserts the runtime fact on both tiers and
  records the API view.
- **Row 14.** After a force delete the Job pod's object lingers for a moment (the Job controller's tracking finalizer) and then goes, while its
  process is still running on the node (the suite waits for the object to go, then asks the runtime). No replacement pod appeared in the run
  (recorded as `row14.replacement_pod=false`). The fake removes the object at once; the proof is the same.
- **Row 9.** After a pod delete the container's exit was seen before the Job's `Failed` condition (recorded; the design does not depend on the order).
- **Volume ownership.** The `local-path` mount point is `root:10001` mode `2777` (`fsGroup` adds the group and the setgid bit); the 0700 subdirectory is `10001:10001`
  mode `2700` and satisfies `assertSafeRoot`. The supervisor (uid 10002) can read none of W-018's 0700 levels: see the W-019 hand-off.
- `local-path` removes the backing directory within a second of the claim's deletion (a helper pod in `kube-system`).
- Image import into the node: 4 s for the 170 MB stub image and 9.5 s for the 184 MB materializer image; the node uses about 480 MB with the images loaded.

## Not built

The supervisor and any real harness; a network listener; result acceptance and `completed`; `finalizing` and
checkpoint Jobs; the checkpoint request on cancel; `watchEvents` (typed `not_supported`); bundle sources in pods; a Git
credential in a pod; deletion of older generations' PVCs and the general orphan sweep (W-024); queued admission (W-088);
NetworkPolicy and admission policy (W-021); anything on a real cluster (D4).

## Tests

`pnpm vitest run apps/runner packages/workspace`. Real PostgreSQL, `FakeKube` and `FakeKubelet`; time is moved by backdating the row's
timestamps and running a pass, never by sleeping. Every refusal has a control in the same setup that shows the accepted case.
17b's fake-tier files: `w017-pod-materializer` (the real test entry under the fake kubelet with real Git against a fixture: clone, receipt, permit,
a missing commit, `target_exists`, a pod deleted mid-clone with Git gated by a marker file, the production entry refusing `file://` with hostile
arguments and environment, the request and URL policies with their linear-time bounds), `w017-release` (the release path, cases a to e),
`w017-pod-volume-materializer` (`remove` rule by rule, no database), `w017-main` (the storage class is checked first, at start) and the
exclusion test in `tools/test`. `pnpm test:k8s` is the cluster tier (above).
