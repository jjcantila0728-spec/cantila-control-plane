#!/bin/bash
# ============================================================
# ship-platform.sh — one-command deploy of a Cantila PLATFORM app
# to box 1, post-Coolify. Run from a DEV machine.
#
# Collapses the manual two-step (git archive | ssh tar x  ->
# /root/deploy-platform.sh <app>) into a single command. Pushes the
# committed HEAD of the app's local repo, then runs the box-side
# build+swap (canonical Node Dockerfile + buildx, env/labels
# preserved). See scripts/deploy-platform.sh for the box side and
# the plan §19.12 Phase 2.
#
# Usage:  scripts/ship-platform.sh <control-plane|console|gritcode> [repo-dir]
#   repo-dir defaults to the known sibling checkout for that app.
#
# Requires: SSH access to box 1 with the deploy key, and the app's
# source committed (it ships HEAD, not the dirty working tree).
# ============================================================
set -euo pipefail

app="${1:?usage: ship-platform.sh <control-plane|console|gritcode> [repo-dir]}"
box="${CANTILA_BOX:-root@168.119.97.112}"
key="${CANTILA_SSH_KEY:-$HOME/.ssh/id_ed25519}"

# default local repo dir per app (sibling checkouts under Projects/cantila/)
here="$(cd "$(dirname "$0")/.." && pwd)"      # cantila-control-plane/
parent="$(dirname "$here")"
case "$app" in
  control-plane) def="$here" ;;
  console)       def="$parent/cantila-console" ;;
  gritcode)      def="$parent/gritcode" ;;
  *) echo "unknown app: $app (expected control-plane|console|gritcode)"; exit 1 ;;
esac
repo="${2:-$def}"
[ -d "$repo/.git" ] || { echo "ERROR: $repo is not a git checkout (pass repo-dir as arg 2)"; exit 1; }

sha="$(git -C "$repo" rev-parse --short HEAD)"
branch="$(git -C "$repo" rev-parse --abbrev-ref HEAD)"
if [ -n "$(git -C "$repo" status --porcelain)" ]; then
  echo "WARNING: $repo has uncommitted changes — shipping committed HEAD ($branch $sha), not the working tree."
fi

echo "[1/3] archive $app HEAD ($branch $sha) from $repo"
tmp="$(mktemp -t ship-XXXX.tgz)"
trap 'rm -f "$tmp"' EXIT
git -C "$repo" archive --format=tar.gz -o "$tmp" HEAD

echo "[2/3] push source -> $box:/root/build/$app"
ssh -i "$key" "$box" "rm -rf /root/build/$app && mkdir -p /root/build/$app"
scp -i "$key" "$tmp" "$box:/root/build/$app/src.tgz"
ssh -i "$key" "$box" "cd /root/build/$app && tar xzf src.tgz && rm src.tgz"

echo "[3/3] build + swap on box"
ssh -i "$key" "$box" "/root/deploy-platform.sh $app"

echo "shipped $app ($sha). verify the app's URL responds."
