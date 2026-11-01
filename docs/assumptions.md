# Assumptions

Local-development defaults that stand in for organisation-only decisions. Each one names the
decision-register entry (docs/spec/15-decisions-sources.md) it stands in for. None of these closes
a decision-register entry; every referenced entry remains `proposed`/open.

| ID | Package | Stands in for | Assumption | Revisit when |
| --- | --- | --- | --- | --- |
| A-01 | W-002 | INT-04 (Temporal hosting), INT-07 (database provider), ADR-11 | Local podman compose services: Temporal CLI dev server 1.9.1 (server 1.32.0) and PostgreSQL 18.6, pinned by digest. Managed Temporal and the production database are not selected. | W-001 inventory |
| A-02 | W-002 | ADR-11 | Node 24.22.2 is pinned through fnm + `.node-version`; pnpm 12.16.1 through corepack. TypeScript is pinned to 6.0.3, not 7.x, because typescript-eslint 8.72.1 supports `<6.1.0`. | typescript-eslint supports TS 7 |
