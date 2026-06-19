#!/bin/bash
# ============================================================
# deploy-platform.sh — redeploy a Cantila PLATFORM app to box1
# WITHOUT Coolify (Coolify was dropped 2026-06-18).
#
# Pipeline: canonical Node Dockerfile (from the CP fast-builds
# generator) -> `docker buildx build` -> re-run the live container
# with the new image, preserving its env + Traefik labels + network
# by reconstructing the run command from the running container.
#
# Source must already be on the box at /root/build/<app>, pushed
# from a dev machine with:
#   git archive --format=tar.gz HEAD | ssh root@box \
#     'mkdir -p /root/build/<app> && tar xz -C /root/build/<app>'
#
# Usage (on the box):  ./deploy-platform.sh <control-plane|console|gritcode>
# Rollback: the prior image stays tagged; re-run with it, or use
#   /root/coolify-dropped/redeploy-<container>.sh
# ============================================================
set -euo pipefail

app="${1:?usage: deploy-platform.sh <control-plane|console|gritcode>}"
case "$app" in
  control-plane) cn="bd3l9kee90ic661e4rmpzjez-015854665436" ;;
  console)       cn="jsyg2k7i89jg352o9dignhe8-165656603856" ;;
  gritcode)      cn="h5483a2oyu5eayxldvpbkoly-005559653726" ;;
  *) echo "unknown app: $app (expected control-plane|console|gritcode)"; exit 1 ;;
esac

src="/root/build/$app"
[ -d "$src" ] || { echo "ERROR: no source at $src — push it first"; exit 1; }
docker inspect "$cn" >/dev/null 2>&1 || { echo "ERROR: live container $cn not found"; exit 1; }

repo="${cn%-*}"                          # image repo name Coolify used
tag="manual-$(date -u +%Y%m%d%H%M%S)"
img="$repo:$tag"

# --- canonical Node Dockerfile (mirrors src/deploy/dockerfiles.ts) ---
cat > "$src/Dockerfile.cantila" <<'DOCKERFILE'
# syntax=docker/dockerfile:1
FROM node:20-alpine AS deps
WORKDIR /app
# .npmrc* is optional — copies it when present (e.g. control-plane's
# legacy-peer-deps=true) so npm ci doesn't die on a peer conflict.
COPY package*.json .npmrc* ./
RUN npm ci
FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build --if-present
FROM node:20-alpine AS run
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app ./
EXPOSE 3000
CMD ["npm", "run", "start"]
DOCKERFILE

echo "[1/3] build $img  (from $src)"
docker buildx build --load -f "$src/Dockerfile.cantila" -t "$img" "$src"

echo "[2/3] reconstruct run command from live $cn, swapping image -> $img"
net="$(docker inspect "$cn" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}')"
restart="$(docker inspect "$cn" --format '{{.HostConfig.RestartPolicy.Name}}')"
run="/root/build/$app/.run-$tag.sh"
{
  echo "#!/bin/bash"
  echo "set -e"
  echo "docker rm -f $cn 2>/dev/null || true"
  printf 'docker run -d --name %s --restart %s --network %s \\\n' "$cn" "${restart:-unless-stopped}" "${net:-coolify}"
  # env minus container-runtime defaults that belong to the image, not the app
  docker inspect "$cn" --format '{{range .Config.Env}}{{println .}}{{end}}' \
    | grep -vE '^(PATH|HOME|HOSTNAME|TERM|NODE_VERSION|YARN_VERSION)=' \
    | while IFS= read -r e; do [ -n "$e" ] && printf '  -e %q \\\n' "$e"; done
  # labels (keep Traefik routing + everything else Coolify set; harmless)
  docker inspect "$cn" --format '{{range $k,$v := .Config.Labels}}{{$k}}={{$v}}{{println}}{{end}}' \
    | while IFS= read -r l; do [ -n "$l" ] && printf '  -l %q \\\n' "$l"; done
  echo "  $img"
} > "$run"
chmod +x "$run"

echo "[3/3] swap container -> $img"
bash "$run"
sleep 3
docker ps --filter "name=$cn" --format '  running: {{.Names}}  {{.Status}}  ({{.Image}})'
echo "done. rollback: docker images $repo  then re-run with a prior tag, or /root/coolify-dropped/redeploy-$cn.sh"
