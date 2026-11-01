#!/bin/sh
# The full check every package must pass (BUILD-PROMPT workflow step 4). Requires the
# podman compose services (pnpm services:up) or equivalent Postgres/Temporal endpoints.
set -eu
cd "$(dirname "$0")/.."
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm contracts:check
