# Native git serving — cutover runbook (plan §22)

Smart-HTTP serving for Cantila's own git backend. The bare repos live at
`/srv/cantila-git/<owner>/<slug>.git` on **box 1** (`168.119.97.112`) and are
operated by the control-plane with git plumbing (`NativeGitProvider`, enabled by
`CANTILA_GIT=native`). This container serves the **same store** over
`git.cantila.app` for `clone`/`fetch`/`push`, replacing Gitea's serving.

## State as of 2026-06-19
- **Storage: DONE.** All 22 `repoHost=cantila` repos mirrored into
  `/srv/cantila-git` (additive; Gitea untouched, still the live backend).
- **Serving + cutover: STAGED HERE, NOT YET RUN.** Gitea still serves
  `git.cantila.app` and the control-plane still uses `GITEA_URL` (no
  `CANTILA_GIT`).

## Auth model
Gitea's cantila repos are **private** (anon clone → 401). The deploy/build path
authenticates as `https://oauth2:<token>@git.cantila.app/...`. This container
reuses the **same token value** (`NATIVE_GIT_TOKEN`, default `GITEA_TOKEN`), so
**no control-plane code change is needed** — only an env + serving swap. The
htpasswd registers the token under the usernames Cantila clients use
(`oauth2`, `cantila`, `git`, `x-access-token`) and as a username itself.

> Open item to confirm before `cutover`: the buildx/vps builder clones the
> token-less `project.repoUrl` and relies on **host git credentials** on the
> build host (`10.0.1.1`), not the URL. Verify that host can still authenticate
> to the native endpoint (same token), or deploys of cantila-hosted products
> will 401. The Coolify dataplane path already injects the token in the URL.

## Cutover (run on box 1, from this dir)
```sh
export GITEA_TOKEN=...                 # already in CP env; reuse its value
./cutover.sh build                     # build cantila/native-git:latest
./cutover.sh serve-test                # side route: nativegit.cantila.app
./cutover.sh verify nativegit.cantila.app   # clone grittrade via the token → VERIFY_OK
# --- point of no easy return below; Gitea stays up as rollback ---
./cutover.sh cutover                   # native owns git.cantila.app
# Retire Gitea's git.cantila.app Traefik router (two claimants on one Host):
#   docker inspect <gitea> | find the traefik router labels, then recreate
#   Gitea WITHOUT the git.cantila.app router (Coolify mgmt is down — edit the
#   container's labels via its compose/recreate artifact), OR stop Gitea once
#   the control-plane flip below is verified.
```

### Control-plane flip (separate, api/mcp blast radius)
The CP container (`bd3l9kee90ic661e4rmpzjez-*`, serves **api+mcp**) needs the
store mounted + native env. `git` is already in its image. **Recreate via the
compose file** at `/artifacts/awmypqg7gae4f9gj0ye11gyy/docker-compose.yaml` (the
captured `redeploy-*.sh` has a literal `\n` bug — don't use it raw). Add:
```yaml
    volumes:
      - /srv/cantila-git:/srv/cantila-git
    environment:
      CANTILA_GIT: native
      CANTILA_GIT_ROOT: /srv/cantila-git
      CANTILA_GIT_PUBLIC_BASE: https://git.cantila.app
```
Then `docker compose up -d` that service. Verify `https://api.cantila.app/v1/health`
→ 200 and a Console file-edit + a product deploy.

## Rollback
- Serving: `./cutover.sh rollback` (removes native container; re-activate Gitea's
  `git.cantila.app` router).
- Control-plane: recreate CP without the volume/`CANTILA_GIT` env → back to Gitea.
- Gitea and `/srv/cantila-git` both persist, so the flip is reversible until the
  **deferred** steps: move the image registry off Gitea's built-in to standalone
  `registry:2`, then decommission Gitea.
