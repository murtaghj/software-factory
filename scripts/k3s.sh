#!/bin/sh
# The opt-in local cluster for the k3s test tier (W-017, 17b; A-28). A privileged k3s container in the ROOTFUL
# podman machine (rootless fails with "failed to find cpuset cgroup (v2)"). Nothing is installed on the Mac.
#
#   sh scripts/k3s.sh up      start the pinned k3s, apply deploy/k8s, build and load the images, write .k3s/
#   sh scripts/k3s.sh status  say what is running
#   sh scripts/k3s.sh stage   only write the image build contexts under .k3s/ctx (no podman)
#   sh scripts/k3s.sh pki     only make the throwaway CA and the listener's ECDSA P-256 certificate under .k3s/pki (no podman)
#   sh scripts/k3s.sh down    remove the container, its volumes, the images this script built, and .k3s/
#
# Run it on AC power, and never beside the full suite: the node is capped at 2 CPUs and 1,800 MB. The compose Postgres
# and Temporal are never touched.
set -eu
umask 077 # the admin key and the runner's token are never, even briefly, readable by anyone else

K3S_IMAGE="docker.io/rancher/k3s:v1.36.6-k3s1@sha256:6d654de9f73e36a5a7879c051349a6f43a7941f3552a2f2a00fa9087bd546b85"
NAME="${K3S_NAME:-factory-k3s}"
PORT="${K3S_PORT:-56443}"
NS="factory-exec-local"
PODMAN="${PODMAN:-$HOME/.local/bin/podman}"
CONNECTION="${K3S_CONNECTION:-podman-machine-default-root}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${K3S_OUT:-$ROOT/.k3s}"
# The address the runner's listener is reached at from a pod: the podman machine's host gateway (`host.containers.internal`), which gvproxy maps to the Mac's loopback
# (W-019 step 0). The listener binds 127.0.0.1 and its certificate is named for this address. The port is the test's to choose.
LISTENER_ADDRESS="${K3S_LISTENER_ADDRESS:-192.168.127.254}"
LISTENER_PORT="${K3S_LISTENER_PORT:-18443}"
CA_CONFIGMAP="factory-runner-ca"
SCRIPTS="idle exit0 write-file spawn-tree ignore-term hint-flood"
HARNESS_IMAGES=""
for sc in $SCRIPTS; do HARNESS_IMAGES="$HARNESS_IMAGES factory-harness-scripted-$sc:local"; done
IMAGES="factory-materializer:local factory-materializer-test:local factory-stub:local factory-stub-ignore-term:local factory-stub-exit0:local factory-stub-exit1:local factory-stub-message:local factory-stub-stderr-fail:local factory-supervisor:local$HARNESS_IMAGES"

p() { "$PODMAN" --connection "$CONNECTION" "$@"; }
k() { p exec "$NAME" kubectl "$@"; }
say() { printf '%s\n' "$*" >&2; }
full() { printf 'docker.io/library/%s' "$1"; }

need_ac_power() {
  if [ "${K3S_ALLOW_BATTERY:-0}" = "1" ]; then return 0; fi
  if ! pmset -g batt 2>/dev/null | head -1 | grep -q "AC Power"; then say "not on AC power: the k3s tier runs on AC power only (K3S_ALLOW_BATTERY=1 overrides)"; exit 1; fi
}

wait_for() { # description, command...
  desc="$1"; shift; i=0
  until "$@" >/dev/null 2>&1; do i=$((i+1)); if [ "$i" -gt 90 ]; then say "timed out waiting for $desc"; exit 1; fi; sleep 2; done
}

fixture() { # a deterministic bare repository: the same commit id on every machine
  rm -rf "$OUT/fixture" && mkdir -p "$OUT/fixture/work"
  w="$OUT/fixture/work"
  export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_AUTHOR_NAME=fixture GIT_AUTHOR_EMAIL=fixture@example.test GIT_COMMITTER_NAME=fixture GIT_COMMITTER_EMAIL=fixture@example.test
  export GIT_AUTHOR_DATE="2026-01-01T00:00:00Z" GIT_COMMITTER_DATE="2026-01-01T00:00:00Z"
  git init -q --initial-branch=main "$w"
  mkdir -p "$w/src"
  printf 'fixture repository for the k3s tier\n' > "$w/README.md"
  printf 'export const answer = 42;\n' > "$w/src/answer.ts"
  git -C "$w" add -A
  git -C "$w" -c commit.gpgsign=false commit -q -m "fixture"
  git -C "$w" rev-parse HEAD > "$OUT/fixture-commit"
  git clone -q --bare "$w" "$OUT/fixture/repo.git"
  rm -rf "$w"
}

stage_materializer() {
  c="$OUT/ctx/materializer"; rm -rf "$c" && mkdir -p "$c/app/apps/runner/src/pod" "$c/app/packages/workspace/src/internal" "$c/app/packages/domain" "$c/app/stubs" "$c/app/node_modules/@noble"
  cp "$ROOT/apps/runner/package.json" "$c/app/apps/runner/package.json"
  for f in materialize-entry.ts materialize-run.ts receipt.ts; do cp "$ROOT/apps/runner/src/pod/$f" "$c/app/apps/runner/src/pod/$f"; done
  cp "$ROOT/packages/workspace/package.json" "$c/app/packages/workspace/package.json"
  for f in pod-exports materializer errors git paths tree-digest internal/pod-mode; do cp "$ROOT/packages/workspace/src/$f.ts" "$c/app/packages/workspace/src/$f.ts"; done
  cp "$ROOT/packages/domain/package.json" "$c/app/packages/domain/package.json"; cp -R "$ROOT/packages/domain/src" "$c/app/packages/domain/src"
  cp -R "$ROOT/deploy/images/materializer/stubs/database" "$c/app/stubs/database"
  noble="$(ls -d "$ROOT"/node_modules/.pnpm/@noble+hashes@*/node_modules/@noble/hashes | head -1)"
  cp -RL "$noble" "$c/app/node_modules/@noble/hashes"
  cp "$ROOT/deploy/images/materializer/Containerfile" "$c/Containerfile"
}

stage_materializer_test() {
  c="$OUT/ctx/materializer-test"; rm -rf "$c" && mkdir -p "$c/test-app/pod"
  cp "$ROOT/apps/runner/test/pod/materialize-test-entry.ts" "$c/test-app/pod/materialize-test-entry.ts"
  cp -R "$OUT/fixture" "$c/fixture"; rm -rf "$c/fixture/work"
  cp "$ROOT/deploy/images/materializer-test/Containerfile" "$c/Containerfile"
  cp "$ROOT/deploy/images/materializer-test/git-wrapper.sh" "$c/git-wrapper.sh"
}

# The supervisor's image context: the named source files and the wire contract, and nothing under test/ or any test entry.
stage_supervisor() {
  c="$OUT/ctx/supervisor"; rm -rf "$c" && mkdir -p "$c/app/apps/supervisor/src" "$c/app/packages/runner-protocol/src"
  cp "$ROOT/apps/supervisor/package.json" "$c/app/apps/supervisor/package.json"
  for f in main args grant group heartbeat local-endpoint network-gate runner-client state supervisor token-file workspace-view; do cp "$ROOT/apps/supervisor/src/$f.ts" "$c/app/apps/supervisor/src/$f.ts"; done
  cp "$ROOT/packages/runner-protocol/package.json" "$c/app/packages/runner-protocol/package.json"
  for f in index pod-api exit-codes; do cp "$ROOT/packages/runner-protocol/src/$f.ts" "$c/app/packages/runner-protocol/src/$f.ts"; done
  cp "$ROOT/deploy/images/supervisor/Containerfile" "$c/Containerfile"
}

# The scripted harness's contexts: the launcher, the group helper and ONE script each. One image per script (a build argument, as the stub's mode is), and an image holds no other.
stage_harness() {
  for sc in $SCRIPTS; do
    c="$OUT/ctx/harness-scripted-$sc"; rm -rf "$c" && mkdir -p "$c/app/apps/supervisor/src/scripts"
    cp "$ROOT/apps/supervisor/package.json" "$c/app/apps/supervisor/package.json"
    for f in launcher group; do cp "$ROOT/apps/supervisor/src/$f.ts" "$c/app/apps/supervisor/src/$f.ts"; done
    cp "$ROOT/apps/supervisor/src/scripts/$sc.ts" "$c/app/apps/supervisor/src/scripts/$sc.ts" # this image's one script, and no other
    cp "$ROOT/deploy/images/harness-scripted/Containerfile" "$c/Containerfile"
  done
}

# A throwaway CA and the listener's certificate. ECDSA P-256 (a handshake with it costs the listener a fraction of an RSA one; the choice is recorded for INT-05 in A-32).
# The certificate's name is the address pods reach the listener at. The keys live OUTSIDE .k3s/ctx (the build contexts), mode 0600, and the CA's key is deleted once the
# certificate is signed. Nothing here needs podman.
make_pki() {
  d="$OUT/pki"; rm -rf "$d" && mkdir -p "$d"
  printf '[req]\ndistinguished_name=dn\nprompt=no\nx509_extensions=ca\n[dn]\nCN=factory-local-runner-ca\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n' > "$d/ca.cnf"
  printf '[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=factory-local-runner-listener\n[san]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:%s\n' "$LISTENER_ADDRESS" > "$d/leaf.cnf"
  openssl ecparam -name prime256v1 -genkey -noout -out "$d/ca.key"
  openssl req -x509 -new -key "$d/ca.key" -sha256 -days 3 -config "$d/ca.cnf" -out "$d/ca.crt"
  openssl ecparam -name prime256v1 -genkey -noout -out "$d/listener.key"
  openssl req -new -key "$d/listener.key" -config "$d/leaf.cnf" -out "$d/listener.csr"
  openssl x509 -req -in "$d/listener.csr" -CA "$d/ca.crt" -CAkey "$d/ca.key" -CAserial "$d/ca.srl" -CAcreateserial -sha256 -days 3 -extfile "$d/leaf.cnf" -extensions san -out "$d/listener.crt" 2>/dev/null
  rm -f "$d/ca.key" "$d/ca.srl" "$d/listener.csr" "$d/ca.cnf" "$d/leaf.cnf"
  chmod 600 "$d"/*
  # The digest the supervisor compares is the digest of the FILE it reads (the PEM bytes).
  { if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$d/ca.crt"; else sha256sum "$d/ca.crt"; fi; } | cut -d' ' -f1 > "$d/ca.sha256"
}

build_images() {
  fixture; stage_materializer; stage_materializer_test; stage_supervisor; stage_harness
  chmod -R a+rX "$OUT/ctx" # umask 077 made the staged copies private, and the image's user (10001) must read /app
  p build -q -t "$(full factory-materializer:local)" -f "$OUT/ctx/materializer/Containerfile" "$OUT/ctx/materializer" >/dev/null
  p build -q -t "$(full factory-materializer-test:local)" -f "$OUT/ctx/materializer-test/Containerfile" "$OUT/ctx/materializer-test" >/dev/null
  p build -q -t "$(full factory-supervisor:local)" -f "$OUT/ctx/supervisor/Containerfile" "$OUT/ctx/supervisor" >/dev/null
  for sc in $SCRIPTS; do p build -q --build-arg "SCRIPT=$sc" -t "$(full "factory-harness-scripted-$sc:local")" -f "$OUT/ctx/harness-scripted-$sc/Containerfile" "$OUT/ctx/harness-scripted-$sc" >/dev/null; done
  for mode in run ignore-term exit0 exit1 message stderr-fail; do
    case "$mode" in run) tag=factory-stub:local ;; *) tag="factory-stub-$mode:local" ;; esac
    p build -q --build-arg "MODE=$mode" -t "$(full "$tag")" -f "$ROOT/deploy/images/stub/Containerfile" "$ROOT/deploy/images/stub" >/dev/null
  done
}

load_images() {
  for img in $IMAGES; do p save "$(full "$img")" | p exec -i "$NAME" ctr -n k8s.io images import - >/dev/null; done
}

up() {
  need_ac_power
  mkdir -p "$OUT"
  if p container exists "$NAME"; then say "$NAME already exists; reusing it (down removes it)"; else
    p pull -q "$K3S_IMAGE" >/dev/null
    p run -d --name "$NAME" --privileged --cpus 2 --memory 1800m -p "127.0.0.1:$PORT:6443" "$K3S_IMAGE" server \
      --disable traefik --disable servicelb --disable metrics-server --write-kubeconfig-mode 644 --tls-san 127.0.0.1 >/dev/null
  fi
  wait_for "the API server" k get --raw /readyz
  wait_for "the node to be Ready" sh -c "\"$PODMAN\" --connection \"$CONNECTION\" exec \"$NAME\" kubectl get nodes | grep -q ' Ready'"
  for f in "$ROOT"/deploy/k8s/*.yaml; do printf -- '---\n'; cat "$f"; done | p exec -i "$NAME" kubectl apply -f - >/dev/null
  wait_for "the service accounts" sh -c "\"$PODMAN\" --connection \"$CONNECTION\" exec \"$NAME\" kubectl -n $NS get serviceaccount default factory-runner factory-allocation-supervisor"
  build_images
  load_images
  tls=/var/lib/rancher/k3s/server/tls
  p exec "$NAME" cat "$tls/server-ca.crt" > "$OUT/ca.crt"
  p exec "$NAME" cat "$tls/client-admin.crt" > "$OUT/admin.crt"
  p exec "$NAME" cat "$tls/client-admin.key" > "$OUT/admin.key"; chmod 600 "$OUT/admin.key"
  k -n "$NS" create token factory-runner --duration=24h > "$OUT/runner.token"; chmod 600 "$OUT/runner.token"
  # The listener's CA, as an IMMUTABLE ConfigMap, written with the admin certificate: the runner's account never writes a ConfigMap. Its digest is in the supervisor's arguments.
  make_pki
  # An immutable ConfigMap cannot be changed and every `up` makes a new CA: delete the old one first, or a second `up` without `down` leaves digests that disagree (every supervisor would exit 64).
  k -n "$NS" delete configmap "$CA_CONFIGMAP" --ignore-not-found >/dev/null
  { printf 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: %s\n  namespace: %s\nimmutable: true\ndata:\n  runner-ca.crt: |\n' "$CA_CONFIGMAP" "$NS"; sed 's/^/    /' "$OUT/pki/ca.crt"; } | p exec -i "$NAME" kubectl apply -f - >/dev/null
  # The local egress policy, on EVERY run: default-deny, and one allow rule for the listener's address and port.
  sed -e "s|__LISTENER_ADDRESS__|$LISTENER_ADDRESS|" -e "s|__LISTENER_PORT__|$LISTENER_PORT|" "$ROOT/deploy/k8s/local/egress-listener-only.yaml" | p exec -i "$NAME" kubectl apply -f - >/dev/null
  p image inspect "$K3S_IMAGE" --format '{{.Digest}}' > "$OUT/k3s-image-digest"
  cat > "$OUT/env" <<ENV
FACTORY_K3S_SERVER=https://127.0.0.1:$PORT
FACTORY_K3S_CA_FILE=$OUT/ca.crt
FACTORY_K3S_ADMIN_CERT_FILE=$OUT/admin.crt
FACTORY_K3S_ADMIN_KEY_FILE=$OUT/admin.key
FACTORY_K3S_RUNNER_TOKEN_FILE=$OUT/runner.token
FACTORY_K3S_NAMESPACE=$NS
FACTORY_K3S_FIXTURE_COMMIT=$(cat "$OUT/fixture-commit")
FACTORY_K3S_IMAGE_DIGEST=$(cat "$OUT/k3s-image-digest")
FACTORY_K3S_LISTENER_ADDRESS=$LISTENER_ADDRESS
FACTORY_K3S_LISTENER_PORT=$LISTENER_PORT
FACTORY_K3S_LISTENER_CERT_FILE=$OUT/pki/listener.crt
FACTORY_K3S_LISTENER_KEY_FILE=$OUT/pki/listener.key
FACTORY_K3S_RUNNER_CA_FILE=$OUT/pki/ca.crt
FACTORY_K3S_RUNNER_CA_SHA256=$(cat "$OUT/pki/ca.sha256")
FACTORY_K3S_RUNNER_CA_CONFIGMAP=$CA_CONFIGMAP
ENV
  say "k3s is up: $(cat "$OUT/k3s-image-digest"); environment in .k3s/env"
}

status() {
  if p container exists "$NAME"; then say "container $NAME: $(p inspect "$NAME" --format '{{.State.Status}}')"; k get nodes 2>&1 | sed 's/^/  /' >&2; else say "container $NAME: absent"; fi
  p images --format '{{.Repository}}:{{.Tag}}' | grep -E "factory-(materializer|stub|supervisor|harness)" | sed 's/^/  image /' >&2 || true
}

down() {
  p rm -f -v "$NAME" >/dev/null 2>&1 || true
  for img in $IMAGES; do p rmi -f "$(full "$img")" >/dev/null 2>&1 || true; done
  rm -rf "$OUT"
  say "k3s is down: container, volumes, built images and .k3s/ removed"
}

case "${1:-}" in
  up) up ;;
  stage) mkdir -p "$OUT"; fixture; stage_materializer; stage_materializer_test; stage_supervisor; stage_harness ;;
  pki) mkdir -p "$OUT"; make_pki ;;
  status) status ;;
  down) down ;;
  *) say "usage: sh scripts/k3s.sh up|status|stage|pki|down"; exit 2 ;;
esac
