# @factory/runner (W-017, part 17a)

The Kubernetes controller and Job protocol (chapter 06, `docs/m2-plan.md` section 5): at most one live
allocation, one Job and one writer per stage run, kept true when two controllers race, when a controller
dies between any two steps, and when Kubernetes shows a duplicate pod. No Temporal, no supervisor
(W-019), no migration, no network listener (D12): the service is an object, and every input is validated as
if it had come off the wire. This is the first half (17a). 17b adds the pod executor, PVC removal and
release, the manifests and images, and the k3s tier.

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
| Pod materializer entry, `PodVolumeMaterializer` | 17b | |

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
   non-resource URL, and 17b's conformance row 13 asserts it), `exp` (60 s of clock-skew allowance, the same as `nbf`),
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
**Defaults the k3s tier (17b) must confirm against the pinned cluster**, because a default the cluster adds that is not
listed makes every attach quarantine (the safe failure, which the tier will show): `imagePullPolicy` (IfNotPresent for a
digest or a tag other than `latest`), `terminationMessagePath` (`/dev/termination-log`), `dnsPolicy` (`ClusterFirst`),
`schedulerName` (`default-scheduler`), the deprecated `serviceAccount` alias, the projected volume's `defaultMode` (420),
`parallelism` and `completions` (1), `completionMode` (`NonIndexed`), `suspend` (false), `podReplacementPolicy`
(`TerminatingOrFailed`), the generated `selector`, and the four generated template labels. The check covers the create
path; it does not replace RBAC.

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

## Known limits

- `reconcileOne`'s inline budget is a deadline that list calls (and the checks between passes) see; the other Kubernetes calls
  (create, get, delete, review) still have only their own 10 s timeout, so one pass can overrun the budget by up to that.
- `deps.onError` is optional; when absent, an error after a commit is logged as a warning (never dropped).

## Hand-offs

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
- The 17b k3s tier asserts the RBAC half as conformance rows 13 and 15 (registered only where there is a cluster).
- Jobs render `enableServiceLinks: false`. A production configuration (`createConfig`) must pin every image by `@sha256` digest
  and bind every control-plane identity to an organization (`identityOrgs`); it accepts no test switch. The unpinned, unbound
  variant is `createTestConfig` in `@factory/runner/testing`, which the production entry does not import (a test checks it).
- A configured identity's denied calls are audited at a bounded rate per identity (`refusalAudit`, 5 a second, burst 20); the
  rest are counted (`audit_capped`).

## Seams left for 17b

- `src/pod/materialize-entry.ts` writes with `encodeReceiptMessage` and `encodeRefusalMessage`; the init container's
  args are `['materialize', '--request', <canonical JSON of the materialization request>]` (`renderJob`).
- `PodVolumeMaterializer.remove` (PVC removal; `absent: true` only with no live allocation and no PVC left) is what
  W-018's `release` calls; the facade already refuses with `allocation_live` and the tests use a stub that reports the volume absent.
- `HttpsKube.assertStorageClass` (reclaim policy `Delete`) is to be called at process start by `main.ts`.
- `test/conformance/suite.ts` takes a `KubeApi` and a driver; `kube-conformance.k8s.test.ts` supplies the cluster ones
  (row 13, the RBAC check, is cluster only and not registered here).
- Image names come from `config.images`; the kubelet runs the stub images (`factory-stub:local` and variants).
- An allocation with no workspace renders no init container and an `emptyDir` for `/workspace` (not specified by the brief).

## Not built

The supervisor and any real harness; a network listener; result acceptance and `completed`; `finalizing` and
checkpoint Jobs; the checkpoint request on cancel; `watchEvents` (typed `not_supported`); bundle sources in pods; a Git
credential in a pod; deletion of older generations' PVCs and the general orphan sweep (W-024); queued admission (W-088);
NetworkPolicy and admission policy (W-021); anything on a real cluster (D4).

## Tests

`pnpm vitest run apps/runner packages/workspace`. Real PostgreSQL, `FakeKube` and `FakeKubelet`; time is moved by backdating the row's
timestamps and running a pass, never by sleeping. Every refusal has a control in the same setup that shows the accepted case.
