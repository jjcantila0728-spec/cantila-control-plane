<p align="center">
  <img src="../brand/logo/mark.svg" alt="Cantila" width="64" height="64">
</p>

<h1 align="center">Cantila Control Plane</h1>

<p align="center">
  <em>Ship anything, live — from one chat.</em>
</p>

<p align="center">
  <a href="../brand/README.md"><img src="https://img.shields.io/badge/brand-cantila-ff6a3d?style=flat-square&labelColor=0b0c0e" alt="brand: cantila"></a>
  <a href="../Cantila_Complete_Plan.md"><img src="https://img.shields.io/badge/plan-v1.3-ece9e3?style=flat-square&labelColor=0b0c0e" alt="plan v1.3"></a>
</p>

---

The brain of the **Cantila** hosting cloud — the API, deploy pipeline and
MCP server that sit behind the Console, the CLI and Claude.

This repository is the **Phase 1 scaffold of the control plane** (§7.1 of
`../Cantila_Complete_Plan.md`). It is a real, runnable TypeScript service. To
keep it runnable with zero infrastructure — exactly like the Console runs on
mock data — it ships an **in-memory store** and a **simulated data plane**.
The production `schema.prisma` and the swap-in points for real adapters are
all here.

---

## The two planes

Cantila is built as two planes (plan §7):

- **Control plane** — _this repo._ Operated by Cantila. Holds all platform
  state, exposes the API, and runs the deploy pipeline.
- **Data plane** — the fleet of VPS nodes where customer workloads actually
  run (containers, reverse proxy, managed-service containers). The control
  plane talks to it through two contracts defined here: `DataPlane` (build /
  schedule / run / route) and `ServiceProvisioner` (stand up a project's
  database, mailbox and SMS number).

The scaffold provides **stub implementations** of both contracts
(`src/dataplane/stub.ts`) so the whole deploy pipeline runs end-to-end on
simulated infrastructure. Replace the stubs with real adapters (Docker +
Traefik + Hetzner, etc.) to make it live.

---

## Quick start

```bash
npm install
cp .env.example .env
npm run dev          # HTTP API on http://localhost:8080
npm run mcp          # MCP server on stdio
```

```bash
npm run build        # compile to dist/
npm run typecheck    # tsc --noEmit
npm run prisma:generate
```

Requires Node.js 20+.

---

## The deploy pipeline

Every deploy — from Chat Deploy, git, the CLI or the MCP server — runs the
same eight steps (plan §7.3). `src/deploy/pipeline.ts`:

1. **Source arrives**
2. **Stack detection**
3. **Provision project services** — the auto-wiring (see below)
4. **Build** — image pushed to the registry
5. **Schedule** — orchestrator picks a node
6. **Deploy** — node agent starts the container
7. **Route** — reverse proxy maps the domain, issues SSL
8. **Verify** — health check, return the URL

## Auto-wired services — every project, fully connected

The defining behaviour (plan §4.2). On a project's **first deploy**,
`src/deploy/provisioning.ts` gives the project its **own**:

- a dedicated **managed database** → injects `DATABASE_URL`
- a dedicated **mailbox / email service** → injects `SMTP_HOST`, `SMTP_PORT`,
  `SMTP_USER`, `SMTP_PASSWORD`, `MAIL_FROM`
- a dedicated **SMS number** → injects `CANTILA_SMS_NUMBER`,
  `CANTILA_SMS_API_KEY`

Credentials are written into the project's environment as **secrets before
the build runs**, so the app can reach its database and send email and SMS
the moment it is live. The step is **idempotent** — a no-op on later deploys.
Each project's services are private to it and torn down with it.

---

## Project structure

```
prisma/
  schema.prisma          The platform data model (PostgreSQL)
src/
  index.ts               Fastify HTTP API — thin transport over ControlPlane
  config.ts              Environment configuration
  lib/
    ids.ts               ID + timestamp helpers
    prisma.ts            PrismaClient singleton
  core/
    control-plane.ts     ControlPlane — the shared service layer
  domain/
    types.ts             Core domain types (Prisma-independent)
    store.ts             Store port + in-memory implementation
    prisma-store.ts      Store port — Prisma / PostgreSQL implementation
    create-store.ts      Store factory — picks memory or prisma
  deploy/
    provisioning.ts      Auto-wired services — the headline behaviour
    pipeline.ts          The 8-step deploy pipeline
  dataplane/
    stub.ts              Simulated data plane (ServiceProvisioner + DataPlane)
  mcp/
    protocol.ts          JSON-RPC 2.0 types
    server.ts            From-scratch MCP server (stdio)
    tools.ts             The Cantila MCP tools
    index.ts             MCP server entry point
```

## API

| Method | Route                          | Purpose                                          |
| ------ | ------------------------------ | ------------------------------------------------ |
| GET    | `/v1/health`                   | Liveness probe                                   |
| GET    | `/v1/projects`                 | List projects under an account                   |
| POST   | `/v1/projects`                 | Create a project (creates its `*.cantila.app` subdomain) |
| GET    | `/v1/projects/:id`             | Project detail + auto-wired services + domains   |
| POST   | `/v1/projects/:id/deploy`      | Run the deploy pipeline                          |
| GET    | `/v1/projects/:id/logs`        | Build & deploy logs for the project              |
| GET    | `/v1/projects/:id/env`         | Environment variables (secrets masked)           |
| POST   | `/v1/projects/:id/env`         | Set or update an environment variable            |
| POST   | `/v1/projects/:id/domains`     | Attach a custom domain (returns DNS + SSL state) |
| POST   | `/v1/projects/:id/scale`       | Vertical resize (vCPU / RAM / disk / always-on)  |
| POST   | `/v1/projects/:id/database`    | Provision the bundled managed database (idempotent) |

## The MCP server

`src/mcp/` is the **Cantila MCP server** — built from scratch: JSON-RPC 2.0
over stdio, no SDK. Add it to any Claude surface and "deploy to Cantila"
becomes a native capability (plan §4.3.2 / §7.6).

```bash
npm run mcp
```

It exposes the full v1 tool set (plan §4.3.2), each a thin wrapper over the
same `ControlPlane` service the HTTP API uses:

| Tool                     | Purpose                                              |
| ------------------------ | ---------------------------------------------------- |
| `cantila_deploy`         | Run the deploy pipeline; returns the live URL        |
| `cantila_status`         | Project state + auto-wired services + domains        |
| `cantila_list_projects`  | List the user's projects                             |
| `cantila_get_logs`       | Build & deploy logs                                  |
| `cantila_set_env`        | Set or update an environment variable                |
| `cantila_provision_db`   | Provision the bundled managed database (idempotent)  |
| `cantila_add_domain`     | Attach a custom domain; reports DNS + SSL state      |
| `cantila_scale`          | Vertical resize (vCPU / RAM / disk / always-on)      |
| `cantila_create_project` | Create a new Cantila project                         |

On boot it seeds one demo project (its id is printed to stderr) so the tools
can be exercised immediately.

## Auth (plan §5.4)

Off by default — the in-process demo flow has no auth wall. Flip it on with
`CANTILA_REQUIRE_AUTH=true` (see `.env.example`). When on:

| Route                       | Required scope                                |
| --------------------------- | --------------------------------------------- |
| `GET /v1/health`            | none — always open                            |
| `GET /v1/me`                | none — returns `{ authenticated: false }` if no key |
| `GET /v1/*`                 | any (`read`, `deploy`, or `admin`)            |
| `POST/PUT/PATCH/DELETE`     | `deploy` or `admin`                           |
| `*/v1/api-keys*`            | `admin`                                       |

Mint a key with `cantila keys create <name> --scope deploy`, then pass it
as `Authorization: Bearer ctk_live_…` on every request. The Console can
auto-attach a server-side key — set `CANTILA_API_KEY` in
`cantila-console/.env.local`.

## What is simulated

`schema.prisma` is the real production data model. By default the scaffold
uses an in-memory `Store` and the stub data plane, so no Postgres, Docker or
VPS fleet is needed to exercise the full deploy flow. Set `STORE=prisma`
(with a `DATABASE_URL`) to switch persistence to the Prisma-backed `Store`
in `src/domain/prisma-store.ts` — nothing else in the code changes. Real
`DataPlane` / `ServiceProvisioner` adapters are the remaining swap-in.

## Next increments

- Real `DataPlane` / `ServiceProvisioner` adapters (Docker, Traefik, Hetzner)
- Auth & identity, billing & metering, the orchestrator
- Streaming build/deploy logs over SSE/WebSocket
- Git connection + automatic deploys on push

---

_Cantila Control Plane · Phase 1 scaffold · v0.1 · May 2026_
