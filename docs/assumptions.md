# Assumptions

Local-development defaults that stand in for organisation-only decisions. Each one names the
decision-register entry (docs/spec/15-decisions-sources.md) it stands in for. None of these closes
a decision-register entry; every referenced entry remains `proposed`/open.

| ID | Package | Stands in for | Assumption | Revisit when |
| --- | --- | --- | --- | --- |
| A-01 | W-002 | INT-04 (Temporal hosting), INT-07 (database provider), ADR-11 | Local podman compose services: Temporal CLI dev server 1.9.1 (server 1.32.0) and PostgreSQL 18.6, pinned by digest. Managed Temporal and the production database are not selected. | W-001 inventory |
| A-02 | W-002 | ADR-11 | Node 24.22.2 is pinned through fnm + `.node-version`; pnpm 12.16.1 through corepack. TypeScript is pinned to 6.0.3, not 7.x, because typescript-eslint 8.72.1 supports `<6.1.0`. | typescript-eslint supports TS 7 |
| A-03 | W-004 | INT-01 (first application, build/test commands), INT-09 (trace backend) | The fixture system runs its services in-process (node:http) against a throwaway Postgres database per environment, instead of container images. Release "images" are pinned as exact source digests. Traces go to an in-memory collector rather than an observability backend. Fixture callers identify themselves with an `x-customer-id` header, not OIDC. | W-001 inventory / W-038 telemetry adapter |
| A-04 | W-006 | INT-07 (database provider, credentials, backups) | Local login roles `factory_migrate_login` (NOINHERIT, may only SET ROLE factory_migrator) and `factory_app_login` (inherits factory_runtime) with fixed local passwords. Each test suite gets a throwaway database on the compose Postgres 18.6. Backup/restore qualification is not attempted. | W-001 inventory; W-056 backup/restore |
| A-05 | W-007 | INT-07 (object storage, encryption, retention) | Artifacts use `FileObjectStore`, a local filesystem store with hard-link conditional promotion, instead of an S3-compatible service; no encryption at rest. Reservation TTL defaults to 1 hour, download capabilities to 5 minutes, retention to 365 days. Sweeps run as a separate `factory_retention` job role (BYPASSRLS, column-limited grants in migration 0013). The reference DDL names that job role but does not define it. | W-001 inventory; W-056/W-055 retention and storage qualification |
