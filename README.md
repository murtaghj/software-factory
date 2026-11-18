# Software factory

Implementation of the software-factory specification (revision 1.13, copied read-only into
[docs/spec](docs/spec/SOURCE.md)). This repository is being built package by package from
`docs/spec/backlog.json`; see [docs/build-log.md](docs/build-log.md) for what exists and which
acceptance scenarios pass.

## Toolchain (W-002)

| Component | Pin |
| --- | --- |
| Node.js | 24.22.2 LTS (`.node-version`, `engines.node`) |
| pnpm | 12.16.1 (`packageManager`, via corepack) |
| TypeScript | 6.0.3, strict (see `tsconfig.base.json`) |
| PostgreSQL | `postgres:18.6` by digest (`compose.yaml`) |
| Temporal dev server | `temporalio/temporal:1.9.1` by digest (`compose.yaml`) |

All dependency versions are exact; the lockfile is committed and installs use `--frozen-lockfile`.

## Getting started

```sh
brew install fnm docker-compose          # docker-compose is podman compose's provider
fnm install 24.22.2 && fnm use 24.22.2
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm services:up                         # podman compose: Postgres 18 + Temporal dev server
pnpm lint && pnpm typecheck && pnpm test && pnpm contracts:check
```

`pnpm lint` runs strict type-aware ESLint and the package-boundary checker
(`tools/check-boundaries.ts`, rules in `tools/boundaries.json`). Workspace packages may import
only the packages declared as allowed for them; apps are not importable, and deterministic
packages (`domain`, `policy`) and Temporal workflow code may not import I/O modules (INV-01).

## Layout

`packages/*` and `apps/*` follow chapter 01 of the specification. Only the packages needed for
milestones M0–M1 exist so far, plus `packages/workspace` (W-018, the first M2 package).
