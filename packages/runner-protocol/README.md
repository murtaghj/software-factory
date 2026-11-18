# @factory/runner-protocol (W-019, P-27)

The wire contract of the runner's pod-facing HTTPS API: route names, request and answer types, hand-written parsers,
the caps, the denial codes (`PermitDenialCode`, moved here from `apps/runner/src/permit.ts`, which re-exports it), the
status mapping and the supervisor's exit codes. No I/O, no dependency. It is outside the module list of
`01-scope-architecture.md:84-99`; W-023 adds the worker-facing half.

- Routes: `POST /pod/v1/permit/acquire`, `/pod/v1/permit/renew`, `/pod/v1/stop-ack`. The token travels in
  `Authorization: Bearer`, never in the body.
- Caps: body 16 KiB, token 8 KiB, report 1 KiB.
- Parsers accept a plain object's own keys and refuse any key not listed (`__proto__` and `constructor` too).
- Status: 200 granted; 400 `invalid_request`; 401 `unauthenticated`; 429 `throttled`; 503 `review_unavailable`; 409 every other typed
  denial. The body is the answer; the status is a hint.
- `test/vectors.json` pins every shape; `w019-pod-api.test.ts` round-trips it.
