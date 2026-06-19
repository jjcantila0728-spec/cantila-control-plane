#!/bin/bash
# ============================================================================
# Native git cutover (plan §22) — run ON box 1 (168.119.97.112).
#
# Brings up the native git smart-HTTP server over the already-mirrored
# /srv/cantila-git store and (optionally) repoints git.cantila.app off Gitea.
# Idempotent and reversible: Gitea is left running as the rollback until the
# final `--decommission` step (not done here).
#
# STAGES (run in order; each is safe to re-run):
#   ./cutover.sh build              # build the native-git image
#   ./cutover.sh serve-test         # run container on nativegit.cantila.app (side route) to verify
#   ./cutover.sh verify <host>      # clone a repo through <host> with the token
#   ./cutover.sh cutover            # repoint git.cantila.app: native ON, Gitea route OFF
#   ./cutover.sh rollback           # git.cantila.app back to Gitea
#
# The control-plane container still needs, separately (see README):
#   -v /srv/cantila-git:/srv/cantila-git  and  CANTILA_GIT=native + roots.
# ============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
IMAGE="cantila/native-git:latest"
CONTAINER="cantila-native-git"
NETWORK="coolify"
GITEA_CONTAINER="$(docker ps --format '{{.Names}}' | grep -E '^gitea-' | head -1 || true)"
# Reuse the token the build/deploy path already injects (Gitea token today).
TOKEN="${NATIVE_GIT_TOKEN:-${GITEA_TOKEN:-}}"

router_labels() { # $1 = host, $2 = router name
  echo "-l traefik.enable=true \
    -l traefik.http.routers.$2.rule=Host(\`$1\`) \
    -l traefik.http.routers.$2.entrypoints=https \
    -l traefik.http.routers.$2.tls=true \
    -l traefik.http.routers.$2.tls.certresolver=letsencrypt \
    -l traefik.http.services.$2.loadbalancer.server.port=80 \
    -l traefik.docker.network=$NETWORK"
}

run_container() { # $1 = host, $2 = router name
  [ -n "$TOKEN" ] || { echo "ERROR: set NATIVE_GIT_TOKEN or GITEA_TOKEN"; exit 1; }
  docker rm -f "$CONTAINER" 2>/dev/null || true
  # shellcheck disable=SC2046
  docker run -d --name "$CONTAINER" --restart unless-stopped --network "$NETWORK" \
    -v /srv/cantila-git:/srv/cantila-git \
    -e "NATIVE_GIT_TOKEN=$TOKEN" \
    $(router_labels "$1" "$2") \
    "$IMAGE"
  echo "started $CONTAINER serving $1"
}

case "${1:-}" in
  build)
    docker build -t "$IMAGE" "$HERE" ;;
  serve-test)
    run_container "nativegit.cantila.app" "nativegit" ;;
  verify)
    host="${2:-nativegit.cantila.app}"
    rm -rf /tmp/ng-verify
    git clone --depth 1 "https://oauth2:${TOKEN}@${host}/cantila/grittrade.git" /tmp/ng-verify \
      && echo "VERIFY_OK files=$(ls /tmp/ng-verify | wc -l)" || { echo "VERIFY_FAIL"; exit 1; }
    rm -rf /tmp/ng-verify ;;
  cutover)
    # Native takes git.cantila.app; drop Gitea's claim to the host so Traefik
    # routes the host to the native container. Gitea container stays running.
    run_container "git.cantila.app" "nativegit-prod"
    if [ -n "$GITEA_CONTAINER" ]; then
      # Disable Gitea's traefik router by relabel via recreate is heavy; instead
      # we rely on the native router now owning the Host rule. If both claim the
      # host, REMOVE Gitea's label set (manual: see README) — Traefik dedupes by
      # router name, not host, so the Gitea router must be retired explicitly.
      echo "NOTE: retire Gitea's git.cantila.app router — see README 'cutover' step."
    fi ;;
  rollback)
    docker rm -f "$CONTAINER" 2>/dev/null || true
    echo "native-git container removed; ensure Gitea's git.cantila.app router is active." ;;
  *)
    echo "usage: $0 {build|serve-test|verify <host>|cutover|rollback}"; exit 2 ;;
esac
