#!/bin/sh
# Local Postgres 18 + Temporal dev server through podman compose.
# Usage: sh scripts/services.sh up|down|wait
set -eu
PODMAN="${PODMAN:-$HOME/.local/bin/podman}"
cd "$(dirname "$0")/.."
wait_ready() {
  i=0
  until "$PODMAN" compose exec -T postgres pg_isready -U factory_admin -d factory >/dev/null 2>&1; do
    i=$((i+1)); [ "$i" -gt 60 ] && { echo "postgres not ready" >&2; exit 1; }; sleep 1
  done
  i=0
  until "$PODMAN" compose exec -T temporal temporal operator namespace describe -n factory --address 127.0.0.1:7233 >/dev/null 2>&1; do
    i=$((i+1)); [ "$i" -gt 90 ] && { echo "temporal not ready" >&2; exit 1; }; sleep 1
  done
  echo "services ready: postgres 127.0.0.1:55432, temporal 127.0.0.1:57233"
}
case "${1:-up}" in
  up)
    "$PODMAN" machine inspect --format '{{.State}}' 2>/dev/null | grep -q running || "$PODMAN" machine start
    "$PODMAN" compose up -d
    wait_ready ;;
  wait) wait_ready ;;
  down) "$PODMAN" compose down -v ;;
  *) echo "usage: $0 up|down|wait" >&2; exit 2 ;;
esac
