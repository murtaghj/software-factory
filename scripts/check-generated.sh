#!/bin/sh
# Regenerate contract outputs and fail if the committed files differ (AC-260 reproducibility).
set -eu
cd "$(dirname "$0")/.."
if [ ! -f packages/contracts/scripts/generate.ts ]; then echo "no contract generator yet"; exit 0; fi
node packages/contracts/scripts/generate.ts
if ! git diff --exit-code --stat -- packages/contracts/src/generated; then
  echo "Generated contracts differ from the committed files. Run pnpm contracts:generate and commit." >&2
  exit 1
fi
untracked=$(git ls-files --others --exclude-standard -- packages/contracts/src/generated)
if [ -n "$untracked" ]; then echo "Untracked generated files: $untracked" >&2; exit 1; fi
echo "Generated contracts: reproducible"
