# Fast registry builds + direct-to-VPS data plane

**Date:** 2026-06-18
**Status:** Both stages IMPLEMENTED in code (UNDEPLOYED, env-gated, 402 cp tests green). Registry = Gitea built-in.

**Implementation (2026-06-18):**
- Stage 1: `src/deploy/dockerfiles.ts`, `image-builder.ts` (+`-host.ts`), `ImageBuilder` wired into `CoolifyDataPlane.buildImage`/`startContainer` pull path. Gate: `CANTILA_BUILDER=buildx`.
- Stage 2: `src/dataplane/vps.ts` (`VpsDataPlane`), `ssh-exec.ts` (`SshRunner`), shared `metrics-synth.ts` (extracted from coolify). Gate: `CANTILA_DATAPLANE=vps` + `CANTILA_VPS_HOST(S)`.
- Both noop/inactive by default; Coolify stays as instant rollback.
**Goal:** Make Cantila product builds fast, then remove the hard dependency on Coolify by
adding a direct-to-VPS data plane — both behind env flags, each shipping independently.

**Decisions (2026-06-18):** Build the registry/BuildKit fast path first (Stage 1), keeping Coolify
as orchestrator; then add `VpsDataPlane` (Stage 2). Container registry = **Gitea's built-in
registry** at `git.cantila.app` (no new infra, auth via existing `GITEA_TOKEN`).

---

## Problem

Tenant product builds are slow. Tracing the deploy path
([`pipeline.ts`](../../../src/deploy/pipeline.ts) → [`coolify.ts`](../../../src/dataplane/coolify.ts)):

1. **Build runs on the production box, from source, every deploy.** `POST /deploy`
   (`coolify.ts` `startContainer`) makes the Hetzner server clone the repo and build the
   image inline.
2. **Nixpacks** (`buildPackFor`) provisions a full Nix toolchain per build with weak layer
   caching — `npm install` + `next build` run cold nearly every time. This is the dominant cost.
3. **Serial queue + up to 240s poll** (`awaitDeployment`).

**Key finding:** removing Coolify does *not* by itself fix this. Raw SSH + `docker build` on
the same VPS is the same speed or worse. The real lever is the *build model*: build off-box
with layer caching, push to a registry, and have the runtime just `docker pull && run`. The
registry path already half-exists — the `upload` → `/applications/dockerimage` flow
(`coolify.ts` `createApp`, line ~592) makes Coolify pull a pre-built image instead of building.

That same registry foundation is also what lets us drop Coolify cleanly, which is why we do
fast builds **first**.

---

## Architecture (unchanged seam)

`DataPlane` (port) ← `CoolifyDataPlane` / `stubDataPlane` / **new `VpsDataPlane`**, selected by
`selectDataPlane` (`factory.ts`). We add one new collaborator — an **`ImageBuilder`** port — and
one new adapter. The eight-step pipeline is untouched.

```
ImageBuilder (port)
  └─ BuildxImageBuilder  → docker buildx build --cache-from/--cache-to registry, push

DataPlane (port)
  ├─ CoolifyDataPlane    → Stage 1: pulls pre-built image (existing dockerimage path)
  ├─ VpsDataPlane        → Stage 2: SSH + docker run + Traefik, no Coolify
  └─ stubDataPlane       → tests / local
```

---

## Stage 1 — Fast builds (registry + BuildKit cache), Coolify still orchestrates

**Outcome:** redeploys reuse cached layers; the production box only pulls. Big speedup, low risk,
fully reversible by env flag. No Coolify removal yet.

1. **`ImageBuilder` port** — `build(project, source): { imageRef }`. New module
   `src/deploy/image-builder.ts`. A `NoopImageBuilder` (returns `coolify:pending`, preserving
   today's behavior) and a `BuildxImageBuilder` that runs `docker buildx build` with
   `--cache-from type=registry,ref=<repo>:cache` / `--cache-to ...`, tags
   `<registry>/cantila-<projectId>:<sha>`, and pushes.
2. **Canonical Dockerfiles per stack** — `src/deploy/dockerfiles.ts` maps `detect-stack` output
   to a multi-stage Dockerfile (Node/Next, static→nginx, Python, Go, …). Repos that ship their
   own `Dockerfile`/compose use it verbatim (current behavior). This replaces Nixpacks for the
   common cases — Nixpacks's poor caching is the main cost.
3. **Registry** — Gitea's built-in container registry at `git.cantila.app` (already self-hosted;
   auth via existing `GITEA_TOKEN`). Zero new infra. Fallback: a `registry:2` container on the VPS.
4. **Wire into the pipeline** — `runDeploy` calls `ImageBuilder.build()` at step 4 when configured;
   the resulting `imageRef` flows through the existing `upload`/`dockerimage` path so Coolify
   *pulls* it instead of building. When `ImageBuilder` is the noop, behavior is identical to today.
5. **Env flag** — `CANTILA_BUILDER=buildx` + `CANTILA_REGISTRY_URL` + creds turn it on. Unset → noop
   → current Coolify-builds-from-source path. Reversible at any moment.

**Risk:** the control-plane host needs Docker + buildx. Mitigation: `ImageBuilder` is a port, so the
build can run on the control-plane host now and move to a dedicated build node later without
touching the pipeline. First build of a project is still cold (one-time); every redeploy is cached.

---

## Stage 2 — Direct-to-VPS data plane (`VpsDataPlane`), drop Coolify

**Outcome:** deploys hit the VPS directly over SSH + Docker; Coolify no longer required.

`VpsDataPlane implements DataPlane`, `src/dataplane/vps.ts`:

- `buildImage` — delegates to the same `BuildxImageBuilder` from Stage 1.
- `schedule` — pick a VPS node (deterministic by `hash(project.id)`, mirrors `regionFor`).
- `startContainer` — SSH: `docker pull` → `docker run -d` (or `docker compose up -d`) with env +
  Traefik labels (`traefik.http.routers.<id>.rule=Host(...)`).
- `route` — `https://<slug>.cantila.app` via Traefik (standalone Traefik on the VPS; can adopt the
  one Coolify already runs during cutover).
- `runMigration` — `docker run --rm <image> <migrate cmd>` against `DATABASE_URL` (same gate as today).
- `attachDomain` / `destroyApp` — Traefik dynamic config / `docker rm -f`.
- metrics — reuse the existing `SshDockerStatsCollector` + `TraefikRpsCollector` (already SSH to the box).

Selected by `selectDataPlane` via `CANTILA_DATAPLANE=vps` + VPS SSH target + registry creds.
Coolify config left intact so cutover is one env flip, and rollback is the reverse.

**Risk (highest):** production routing + TLS. Mitigation: stand up Traefik alongside Coolify's,
cut over one project, verify the `<slug>.cantila.app` round-trip + LE cert, then migrate the rest;
keep `CANTILA_DATAPLANE=coolify` as instant rollback.

---

## Testing

TDD throughout (matches the codebase: `coolify-*.test.ts`, `detect-stack.test.ts`):

- `image-builder.test.ts` — buildx arg assembly, cache refs, tag scheme, noop fallback (command
  runner is injected/faked; no real Docker in unit tests).
- `dockerfiles.test.ts` — each `detect-stack` result → expected Dockerfile; own-Dockerfile passthrough.
- `pipeline` test — builder wired so `imageRef` reaches the dockerimage path; noop = unchanged trace.
- `vps.test.ts` — SSH command assembly for pull/run/migrate/destroy, Traefik label generation,
  health-check + diagnose parity with the Coolify adapter (fake SSH/exec).

---

## What we are NOT doing (YAGNI)

- Not rewriting the deploy pipeline — the `DataPlane` seam stays.
- Not building a multi-node scheduler in Stage 2 (deterministic single-node per project, like today).
- Not removing the Coolify adapter — it stays as fallback until Stage 2 is proven in prod.
- Not touching mobile builds, mail, or other adapters.

---

## Sequencing

Stage 1 ships and delivers the speedup on its own. Stage 2 builds on Stage 1's registry images.
Each stage is a separate branch → tests-green → deploy → verify, reversible by env flag.
