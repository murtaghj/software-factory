# @factory/dashboard (W-014)

The task view's client side:

- `TaskStore` applies events strictly in sequence, exactly once. Older or duplicate events and older
  snapshots are refused. A conflicting duplicate is recorded as an integrity error, and a gap
  triggers a snapshot refresh.
- `TaskEventStream` resumes with `Last-Event-ID`. On `410 EventCursorExpired` it refreshes the
  snapshot and resumes after the snapshot's `lastEventSequence`. It reconnects after drops and stops
  on `reauthenticate`.
- `taskModel` builds the task, stage and gate views with honest staleness. Disconnected, refreshing
  or silent-for-60-seconds states are labelled with the projection time. Terminal tasks are never
  shown as stale.
- `TaskDetail` (React) renders text only, with accessible tables and a live-region freshness banner.

**Not yet built:** the served SPA shell (bundler, routing, sign-in with OIDC PKCE). The components
and the live client are tested directly (`react-dom/server`, plus a system test against the real
API). Building the shell is the next dashboard step (W-032/W-067).
