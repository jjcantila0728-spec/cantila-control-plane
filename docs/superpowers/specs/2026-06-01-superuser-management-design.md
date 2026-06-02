# Super-user management — Slice 1: identity, authz, audit, read-only back-office

**Date:** 2026-06-01
**Status:** Design approved, pending spec review
**Scope:** Slice 1 of a multi-slice platform super-admin capability

## Problem

Cantila has no platform super-user concept. Today:

- RBAC is **tenant-scoped only** — the `Role` enum (`owner/admin/developer/viewer`)
  governs an account's own org via `Membership`. It says nothing about the platform.
- Platform-level operations (e.g. admin password reset) are gated by a single shared
  secret, `CANTILA_ADMIN_TOKEN`, sent in the `x-cantila-admin-token` header. This is
  **unattributed** (not tied to a person), **all-or-nothing**, and wired to only a
  couple of endpoints.
- The "owner account" (`acc_cantila`, founder `jjcantila0728`) is just a regular tenant
  with no elevated platform powers.
- Impersonation (`X-Cantila-Act-As`) is **intra-tenant only**.
- The Console is entirely tenant-scoped — no back-office area — and there is no audit log.

The founder (and, later, trusted operators) needs to manage the whole system across all
tenants, with proper authz and a full audit trail, without resorting to the shared-token
back door or direct DB access.

## Goal

A real **platform super-admin (back-office)** capability, distinct from tenant roles.
This spec covers **Slice 1**: the foundation everything else stands on —
super-user identity, an authz guard, an append-only audit log, and a **read-only**
back-office (API + Console) over all tenants. It also begins retiring `CANTILA_ADMIN_TOKEN`.

### Non-goals (deferred to later slices)

- Cross-tenant **mutations** (suspend/restore accounts, force-cancel billing,
  pause/redeploy any project, reset any user) — **slice 2**.
- Attributed cross-tenant **impersonation** ("view as account", time-boxed, logged) —
  **slice 3** (the deferred plan §5.5 work).
- Infra/fleet controls, capacity, feature flags, platform-wide settings — **slice 4**.
- Back-office UX polish (advanced search, dashboards) — **slice 5**.

## Design

### 1. Data model (`prisma/schema.prisma`, additive)

**`PlatformRole` enum + `User.platformRole`**

```prisma
enum PlatformRole {
  superadmin   // full system management
  support      // read-only back-office + (later) impersonation
}

model User {
  // ...existing fields...
  platformRole PlatformRole?  // null = ordinary tenant user (every existing row)
}
```

- One nullable column. `null` is the default for every existing row, so the migration is
  trivially backward-compatible. Lives on `User` because that is the identity sessions
  already resolve to.
- `support` lands now (so we don't re-migrate) but is only *read*-capable in slice 1;
  mutations and impersonation that use it arrive in later slices.

**`AuditLog` model (append-only)**

```prisma
model AuditLog {
  id           String   @id @default(cuid())
  actorUserId  String
  actorEmail   String   // denormalized — survives user deletion
  action       String   // e.g. "admin.account.read", "admin.user.reset_password"
  targetType   String   // "account" | "user" | "project" | ...
  targetId     String?
  accountId    String?  // tenant the action touched, when applicable
  metadata     Json     @default("{}")
  ip           String?
  createdAt    DateTime @default(now())

  @@index([actorUserId, createdAt])
  @@index([targetType, targetId])
  @@index([accountId, createdAt])
}
```

- The spine every later slice writes to. Slice 1 writes a row for each privileged
  super-user action (including reads of cross-tenant data, since reads are themselves
  sensitive at platform scope — `metadata` records the filter/query used).

**Boot-migration parity (critical, prod gotcha)**

The prod prisma baseline marks migrations applied **without running their SQL**, so any new
column/table must *also* be added to `src/domain/boot-migrations.ts`, or prod 500s on first
read. Both `User.platformRole` and the `AuditLog` table (with indexes) must be added there.

### 2. Authz

- **`requireSuperuser(opts?: { allow?: PlatformRole[] })`** — a guard in the control plane.
  Resolves the caller's session → `User` (reusing the existing session-auth path), asserts
  `user.platformRole` is in the allowed set (default `['superadmin']`; read routes also
  accept `'support'`), else **403**. Built on sessions, **not** the shared token.
- New routes mount under **`/v1/admin/*`** (platform scope), namespaced apart from tenant
  `/v1/*`. The top-level auth hook treats `/v1/admin/*` as requiring a session that passes
  `requireSuperuser`; a tenant API key (even `admin` scope) is **not** sufficient.
- **Audit on every `/v1/admin/*` request** that touches cross-tenant data — a thin wrapper
  writes the `AuditLog` row (actor, action, target, ip, metadata) after authz passes. The
  one exception is `GET /v1/admin/audit` itself: reading the log does **not** write a new
  row (avoids recursive self-logging and trail noise).

**Retiring `CANTILA_ADMIN_TOKEN`**

- Re-implement the existing admin password-reset endpoint behind `requireSuperuser`,
  emitting an audit row.
- Keep the `x-cantila-admin-token` path as a **deprecated fallback** (logs a deprecation
  warning when used) so prod tooling doesn't break mid-migration. A `TODO(slice-2)` marks
  full removal once no caller relies on it.

**Bootstrapping the first super-user**

- The owner seed (`src/domain/seed-owner.ts`) sets `platformRole = superadmin` for the user
  matching `CANTILA_OWNER_EMAIL` on boot. This avoids a chicken-and-egg problem: the founder
  becomes the first super-user automatically, with no shared token and no manual DB edit.

### 3. Read-only back-office API (slice 1)

All under `/v1/admin/`, all read-only, all behind `requireSuperuser` (superadmin or support):

| Route | Purpose |
|-------|---------|
| `GET /v1/admin/accounts` | List/search all tenants. Filters: `q`, `plan`, `billingStatus`. Returns per-account counts (projects, members). Paginated. |
| `GET /v1/admin/accounts/:id` | One account: members, projects, billing, services. |
| `GET /v1/admin/users` | Search all users across tenants (`q` on email/name). Paginated. |
| `GET /v1/admin/projects` | All projects platform-wide. Filters: `status`, `accountId`. Paginated. |
| `GET /v1/admin/audit` | The audit log. Filters: `actorUserId`, `action`, `targetType`, `targetId`. Paginated, newest first. |

Pagination follows the existing list-endpoint convention in the control plane.

### 4. Console back-office UI

- A new route group **`(admin)`** in the Console, served at `/admin`.
- **404-cloaked**: a session whose user is not `superadmin`/`support` gets a **404**, not a
  redirect — the area's existence is not advertised. Enforced server-side in the group's
  layout/guard, mirroring the control-plane authz.
- Pages mirror the read APIs: **Accounts** (list + detail), **Users** (search), **Projects**
  (list/filter), **Audit log** (filterable table). Reuses existing Console components
  (tables, `AreaChart`, `LogStream`, `CopyButton`).
- An **"Admin"** nav entry appears **only** when the session user has a platform role.

### 5. Data flow

```
Console /admin page (server component)
  -> session resolved -> platformRole checked (else 404)
  -> calls control-plane GET /v1/admin/* with the session credential
       -> auth hook: requireSuperuser (else 403)
       -> handler reads cross-tenant data via the store
       -> writes AuditLog row
       -> returns paginated result
  -> page renders with existing Console components
```

### 6. Error handling

- Non-super session → **403** at the API, **404** at the Console route group.
- Tenant API key (any scope) on `/v1/admin/*` → **403** (platform scope ≠ tenant scope).
- Missing/expired session → existing 401 path.
- Audit write failure must **not** silently swallow the action's effect for reads, but for
  any future mutation (slice 2+) the audit write is part of the transaction. For slice 1
  (reads), a failed audit write is logged and surfaced as a 500 so we never serve
  cross-tenant data without a trail.

## Testing (TDD)

- **Guard**: non-super session → 403; superadmin → 200; support → 200 on reads.
- **Scope isolation** (key negative test): a tenant `owner` (highest *tenant* role) is
  **rejected** from `/v1/admin/*`, proving platform scope ≠ tenant scope.
- **Audit**: every `/v1/admin/*` cross-tenant read writes an `AuditLog` row with the right
  actor/action/target/metadata.
- **Read endpoints**: filters and pagination honored; cross-tenant results returned.
- **Console cloak**: non-super session on `/admin` → 404; super session → renders.
- **Bootstrap**: owner seed sets `platformRole = superadmin` for `CANTILA_OWNER_EMAIL`.
- **Deprecated token**: `x-cantila-admin-token` still works but logs a deprecation warning;
  the session path is preferred.

## Affected components

- `cantila-control-plane`: `prisma/schema.prisma`, `src/domain/boot-migrations.ts`,
  `src/domain/seed-owner.ts`, the auth hook + new `requireSuperuser` guard and
  `/v1/admin/*` routes in `src/index.ts` (or an extracted `src/admin/` module),
  store reads for cross-tenant listing, an `AuditLog` writer.
- `cantila-console`: new `(admin)` route group, guard, pages, and a conditional nav entry.

## Rollout

1. Ship the schema + boot-migration parity + seed change (founder becomes superadmin).
2. Ship the guard + read API + audit, behind `/v1/admin/*`.
3. Ship the Console `(admin)` area.
4. Deprecate (not yet remove) `CANTILA_ADMIN_TOKEN`.

Each later slice (mutations, impersonation, infra) is its own spec → plan → build cycle.
