#!/bin/sh
# AC-260 reproducibility: regenerate the contracts into a fresh directory and require it to be
# byte-identical to packages/contracts/src/generated (no git index involved, so staged drift
# cannot hide). Also fails if the committed generated tree differs from HEAD.
set -eu
cd "$(dirname "$0")/.."
GEN=packages/contracts/scripts/generate.ts
[ -f "$GEN" ] || { echo "contract generator missing: $GEN" >&2; exit 1; }
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
node "$GEN" --out "$tmp/generated" >/dev/null
if ! diff -r "$tmp/generated" packages/contracts/src/generated; then
  echo "Generated contracts differ from a fresh generation. Run pnpm contracts:generate." >&2
  exit 1
fi
if git rev-parse --verify -q HEAD >/dev/null && [ -n "$(git status --porcelain -- packages/contracts/src/generated)" ] && [ "${ALLOW_UNCOMMITTED_GENERATED:-0}" != "1" ]; then
  echo "packages/contracts/src/generated has uncommitted changes:" >&2
  git status --porcelain -- packages/contracts/src/generated >&2
  exit 1
fi
echo "Generated contracts: reproducible"
