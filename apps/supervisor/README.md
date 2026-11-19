# @factory/supervisor (W-019, 19b)

The process in the supervisor slot of the allocation Job, the launcher that withholds the harness's start, and the scripted harness (A-33). Brief: `docs/m2-plan.md`, section 6.
Dependencies: `@factory/runner-protocol` and `node:` modules. No database, no Kubernetes client.

## Order: gate, then permit, then workspace

`boot -> gating -> acquiring -> preparing -> running -> ending | fenced`; TERM, in any state, sets the stop flag and exits within a second (0 from `ending`, else 143).

| State | Does | Leaves to |
| --- | --- | --- |
| `boot` | Parses its arguments (`serve --org --allocation --epoch --generation [--workspace] --runner --runner-ca-sha256 --listen --network-gate [--deny-target ...]`). Refuses a runner URL that is not `https:` or whose host is loopback, link-local or unspecified, and a CA file whose digest is not the argument's (the file is read once, here). | `gating`; exit 64 |
| `gating` (D11) | With the gate `required`: one round a second, each a TCP connect to every deny target (literal addresses, one to eight) and to the listener. A round passes when every target fails and the listener accepts; then ONE TLS handshake. Bounded at 120 s. The workspace is not touched. | `acquiring`; exit 68 |
| `acquiring` | `acquire` with the gate's report. Retries `not_ready`, `throttled`, `review_unavailable` and transport errors from 2 s up to 5 s. | `preparing`; exit 65 on `duplicate_writer`; 66 on any other final denial |
| `preparing` | Starts the beat. The workspace view lists `work/main`. One more gate round. | `running`; exit 69 (workspace) or 68 (gate), fenced first |
| `running` | Opens the start gate (only while the local fence time has not passed). Beats. | `ending`, `fenced` |
| `ending` | A renewal was denied with `stopping`: stop flag, one `stop-ack`, wait for TERM. | exit 0 |
| `fenced` | Any other final denial, or no renewal confirmed by the fence time (send time of the last grant plus `lease - beat`, 50 s, on the monotonic clock): stop flag, no further call. | exit 70 |

Exit codes: `@factory/runner-protocol`'s `SUPERVISOR_EXIT`.

## The beat and the hints

A beat every `beatSeconds` with a 5 s request limit, capped at what is left until the fence (a timer fires at the fence time; no call is begun, and no 401 retried, after it); transport errors, `throttled` and `review_unavailable` retried every 2 s until the fence time. `POST /v1/exit` can cause at most
one early renewal per beat interval (it does not move the regular beat), never while a renewal is in flight, and only in `running` before a grant has reported the harness `terminated`;
in every other state it is dropped. The hint decides nothing (rule 5).

Known property: a transport retry counts as a regular beat and so resets the hint allowance. While the runner is unreachable a
hinting harness therefore reaches at most one renewal a second; the runner's per-pod bucket throttles the excess (one renewal
every 2 s still gets through, far inside the lease) and the shared review budget never sees them.

## The workspace view

Built only from a grant (minted in `runner-client.ts` alone; a hand-made or spread copy is refused at run time), and it works ONLY in `preparing`: every method asserts the state and throws in any
other. Its walk is `lstat` by path and then a listing by path, which is safe only while no candidate code runs: after the start a component can be swapped for a symlink between the two calls and the
supervisor would follow it inside its own mount namespace, where the token is. It is the only file besides `token-file.ts` that imports `node:fs` (lint rule and structural test).

**The rule for everyone after:** any read of the workspace once the harness has started uses descriptor-relative, no-follow traversal, or a helper process with no credential (`06:108`).

## The local endpoint and the launcher

`127.0.0.1:8765`: loopback peers only, eight connections, `GET /v1/start` and `GET /v1/stop` (long polls), `POST /v1/exit` (256 bytes), 404 for the rest. None grants anything; the authenticated tool
routes are W-075's. The launcher (`src/launcher.ts`, the harness container's entry) starts nothing until `start: true`; sets umask 027; starts the program in a new process group; on TERM or when
`/v1/stop` answers sends TERM to the group and KILL 10 s later; exits with the program's code after the hint. It never signals pid -1: `group.ts` holds the one negative pid (lint rule).

## Scripted harness

`idle`, `exit0`, `write-file`, `spawn-tree`, `ignore-term`, `hint-flood`, one per image (`factory-harness-scripted-<script>`): the script is baked in at build time (the image holds that one script, and nothing in it can pick another) and the image is labelled `factory.harness=scripted`, which W-021's and W-090's admission rules must refuse outside the local tier (A-33). `spawn-tree` is for the k3s tier: the fake kubelet's group kill
does not reach a process that left the group. No Claude, no gateway, no model call (A-33).

## Test seams

`runSupervisor` takes no seam. `runSupervisorWith(options, { allowPlainLoopbackRunner, coalesceHints })` is exported from `@factory/supervisor/testing` only, which `tools/boundaries.json` limits to `@factory/recovery-tests` and this package's own tests. The CA file must be exactly one valid X.509 CA certificate (an empty file would otherwise make Node trust the public roots).
