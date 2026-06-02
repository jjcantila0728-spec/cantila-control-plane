# Super-user Management — Slice 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a platform super-user capability to Cantila — a `platformRole` identity distinct from tenant roles, a `requireSuperuser` authz guard, an append-only `AuditLog`, and a read-only cross-tenant back-office (control-plane API + Console `/admin` area) — and begin retiring the shared `CANTILA_ADMIN_TOKEN`.

**Architecture:** The control plane (`cantila-control-plane`, Fastify 4 + a `Store` port with `InMemoryStore` and `PrismaStore` impls) gains a nullable `platformRole` on `User`, an `AuditLog` table, cross-tenant store reads, and `/v1/admin/*` routes gated by a pure, unit-tested `authorizeSuperuser` helper. The Console (`cantila-console`, Next.js 14 App Router) gains an `(admin)` route group that 404-cloaks non-super users, mirrors the read APIs, and shows an "Admin" nav entry only for super-users.

**Tech stack:** TypeScript, Fastify 4, Prisma 5 (Postgres in prod, `InMemoryStore` in tests), `node:test` + `tsx` (control-plane tests), Next.js 14 App Router (Console — no unit-test harness; verified via `tsc --noEmit` + `next build`).

**Spec:** `docs/superpowers/specs/2026-06-01-superuser-management-design.md`

**Branch:** `feat/superuser-management` (already created; the design doc is committed there).

---

## Design decision locked in this plan: `platformRole` is a guarded `String`, not a Prisma enum

The spec described a `PlatformRole` enum. In **storage** we follow the existing prod-safe precedent (`Project.repoHost`, the loose `Invite.status` comment): the Prisma column is `String?` and `src/domain/boot-migrations.ts` adds a plain `TEXT` column. A Postgres enum type would need a `CREATE TYPE … AS ENUM` guarded in a `DO` block, which the additive-only boot-migration runner is not built for, and would 500 prod on the next deploy. The *type safety* lives in TypeScript via the `PlatformRole` union (`"superadmin" | "support"`), validated wherever the value is written. This preserves the design intent (an enum-like role) with the deployment posture the repo already relies on.

---

## File structure

**Control plane (`cantila-control-plane/`):**
- `prisma/schema.prisma` — add `User.platformRole String?`; add `model AuditLog`.
- `src/domain/boot-migrations.ts` — add the `User.platformRole` column + `AuditLog` table/indexes (prod parity).
- `src/domain/types.ts` — add `PlatformRole` union, `AuditLog` interface; add `platformRole?` to `AuthUser`.
- `src/domain/store.ts` — `Store` interface + `InMemoryStore`: `setUserPlatformRole`, `listAllUsers`, `listAllProjects`, `recordAuditLog`, `listAuditLogs`; thread `platformRole` through `createUser`.
- `src/domain/prisma-store.ts` — Prisma impls of the same; thread `platformRole` through `toAuthUser`/`createUser`; add `toAuditLog`.
- `src/auth/account.ts` — add `platformRole?` to `SessionAuth`.
- `src/auth/superuser.ts` *(new)* — pure `authorizeSuperuser(session, allow)` decision helper.
- `src/auth/superuser.test.ts` *(new)* — unit tests for the helper.
- `src/core/control-plane.ts` — `recordAdminAudit`, `listAdminAudit`, `adminListAccounts`, `adminListUsers`, `adminListProjects`, `setUserPlatformRole`; surface `platformRole` from `resolveSession`/`getAuthUser`.
- `src/core/admin-readmodel.test.ts` *(new)* — tests for the cp admin read methods + audit.
- `src/index.ts` — thread `platformRole` onto `req.session` + `/v1/me`; add `/v1/admin/*` routes; re-gate the admin reset route behind `authorizeSuperuser` with the deprecated-token fallback; set `platformRole = superadmin` in the owner seed.
- `src/domain/seed-owner.ts` — set `platformRole: "superadmin"` when seeding the owner.

**Console (`cantila-console/`):**
- `src/lib/api.ts` — `Api*` admin types + `api.admin*` methods; add `platformRole` to `ApiWhoami.user`.
- `src/lib/admin-auth.ts` *(new)* — server-side `requireSuperuserPage()` using the session cookie.
- `src/app/(admin)/layout.tsx` *(new)* — 404-cloak guard + minimal admin chrome.
- `src/app/(admin)/admin/accounts/page.tsx`, `.../users/page.tsx`, `.../projects/page.tsx`, `.../audit/page.tsx` *(new)*.
- `src/components/Sidebar.tsx` — conditional "Admin" nav group, shown only when `whoami.user.platformRole` is set.

---

## Task 1: `PlatformRole` + `AuditLog` domain types; `platformRole` on `AuthUser`

**Files:**
- Modify: `src/domain/types.ts`

No test in this task — it's pure type additions consumed by later tested tasks. (The compiler is the check; `npm run typecheck` runs at the end of Task 3.)

- [ ] **Step 1: Add the `PlatformRole` union next to `MemberRole`**

In `src/domain/types.ts`, immediately after the `MemberRole` definition (the `/** Team roles — plan §5.5 … */ export type MemberRole = …` block, ~line 63), add:

```ts
/** Platform super-user role (super-user management, slice 1). Distinct
 *  from tenant `MemberRole` — this grants access to the cross-tenant
 *  back-office, NOT to any one account. Stored as a guarded string on
 *  `User.platformRole` (null = ordinary tenant user). `superadmin` = full
 *  system management; `support` = read-only back-office (and, in later
 *  slices, impersonation). */
export type PlatformRole = "superadmin" | "support";
```

- [ ] **Step 2: Add `platformRole?` to `AuthUser`**

In the `AuthUser` interface (~line 206), add the field after `avatarUrl`:

```ts
  /** Platform super-user role (super-user management, slice 1). Undefined
   *  for ordinary tenant users (every legacy row). Set to `"superadmin"`
   *  for the founder by the owner seed. */
  platformRole?: PlatformRole;
```

- [ ] **Step 3: Add the `AuditLog` interface**

At the end of `src/domain/types.ts`, append:

```ts
/** One append-only platform audit record (super-user management, slice 1).
 *  Written for every privileged `/v1/admin/*` action. `actorEmail` is
 *  denormalized so the trail survives user deletion. `metadata` captures
 *  the action's parameters (e.g. the search filter used on a read). */
export interface AuditLog {
  id: string;
  actorUserId: string;
  actorEmail: string;
  /** Dotted action name, e.g. "admin.account.read", "admin.user.list". */
  action: string;
  /** "account" | "user" | "project" | "audit" | … (free-form). */
  targetType: string;
  targetId?: string;
  /** The tenant the action touched, when applicable. */
  accountId?: string;
  metadata: Record<string, unknown>;
  ip?: string;
  createdAt: string;
}
```

- [ ] **Step 4: Commit**

```bash
git add src/domain/types.ts
git commit -m "feat(types): PlatformRole, AuditLog, AuthUser.platformRole"
```

---

## Task 2: Store reads/writes — `setUserPlatformRole`, cross-tenant lists, audit (interface + InMemoryStore)

**Files:**
- Modify: `src/domain/store.ts`
- Test: `src/domain/admin-store.test.ts` *(new)*

- [ ] **Step 1: Write the failing test**

Create `src/domain/admin-store.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { InMemoryStore } from "./store";

function isoAt(n: number): string {
  // Deterministic, monotonically-increasing ISO timestamps for ordering
  // assertions (no Date.now()/Math.random()).
  return new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
}

test("setUserPlatformRole sets and clears the role", async () => {
  const store = new InMemoryStore();
  await store.createUser({
    id: "usr_a",
    email: "a@example.com",
    name: "A",
    twoFactorEnabled: false,
    createdAt: isoAt(0),
  });

  const promoted = await store.setUserPlatformRole("usr_a", "superadmin");
  assert.equal(promoted.platformRole, "superadmin");
  assert.equal((await store.getUser("usr_a"))?.platformRole, "superadmin");

  const cleared = await store.setUserPlatformRole("usr_a", null);
  assert.equal(cleared.platformRole, undefined);
});

test("listAllUsers returns every user across tenants, newest first", async () => {
  const store = new InMemoryStore();
  await store.createUser({ id: "usr_1", email: "1@x.com", name: "1", twoFactorEnabled: false, createdAt: isoAt(1) });
  await store.createUser({ id: "usr_2", email: "2@x.com", name: "2", twoFactorEnabled: false, createdAt: isoAt(2) });

  const all = await store.listAllUsers();
  assert.deepEqual(all.map((u) => u.id), ["usr_2", "usr_1"]);
});

test("listAllProjects returns projects across all accounts (incl. platform)", async () => {
  const store = new InMemoryStore();
  await store.createAccount({ id: "acc_1", name: "One", handle: "one", plan: "starter", createdAt: isoAt(0) });
  await store.createAccount({ id: "acc_2", name: "Two", handle: "two", plan: "pro", createdAt: isoAt(0) });
  await store.createProject({ id: "prj_1", accountId: "acc_1", slug: "p1", name: "p1", runtime: "node", region: "fsn1", status: "live", createdAt: isoAt(1) } as never);
  await store.createProject({ id: "prj_2", accountId: "acc_2", slug: "p2", name: "p2", runtime: "node", region: "fsn1", status: "live", createdAt: isoAt(2) } as never);

  const all = await store.listAllProjects();
  assert.equal(all.length, 2);
  assert.deepEqual(new Set(all.map((p) => p.accountId)), new Set(["acc_1", "acc_2"]));
});

test("recordAuditLog + listAuditLogs filter and order newest-first", async () => {
  const store = new InMemoryStore();
  await store.recordAuditLog({ id: "aud_1", actorUserId: "usr_a", actorEmail: "a@x.com", action: "admin.account.read", targetType: "account", targetId: "acc_1", metadata: {}, createdAt: isoAt(1) });
  await store.recordAuditLog({ id: "aud_2", actorUserId: "usr_a", actorEmail: "a@x.com", action: "admin.user.list", targetType: "user", metadata: {}, createdAt: isoAt(2) });
  await store.recordAuditLog({ id: "aud_3", actorUserId: "usr_b", actorEmail: "b@x.com", action: "admin.account.read", targetType: "account", targetId: "acc_2", metadata: {}, createdAt: isoAt(3) });

  const all = await store.listAuditLogs({});
  assert.deepEqual(all.map((e) => e.id), ["aud_3", "aud_2", "aud_1"]);

  const byActor = await store.listAuditLogs({ actorUserId: "usr_a" });
  assert.deepEqual(byActor.map((e) => e.id), ["aud_2", "aud_1"]);

  const byAction = await store.listAuditLogs({ action: "admin.account.read" });
  assert.deepEqual(byAction.map((e) => e.id), ["aud_3", "aud_1"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test src/domain/admin-store.test.ts`
Expected: FAIL — `store.setUserPlatformRole is not a function` (and the other new methods).

- [ ] **Step 3: Add the methods to the `Store` interface**

In `src/domain/store.ts`, add `AuditLog` to the type import block at the top (alongside `AuthUser`, `Session`, …):

```ts
  AuthUser,
  AuditLog,
  PlatformRole,
```

In the `Store` interface, inside the `/* ----- per-user auth: users & sessions ----- */` section, after `setUserAvatarUrl(...)`, add:

```ts
  /** Set (or clear, with null) a user's platform super-user role
   *  (super-user management, slice 1). Idempotent. */
  setUserPlatformRole(
    userId: string,
    role: PlatformRole | null,
  ): Promise<AuthUser>;
  /** Every user across every tenant, newest first. Backs the super-user
   *  back-office user search. Cross-tenant by design — only reachable
   *  behind `authorizeSuperuser`. */
  listAllUsers(): Promise<AuthUser[]>;
```

In the projects section of the interface, after `listProjects(accountId)`, add:

```ts
  /** Every project across every account (platform projects included),
   *  newest first. Cross-tenant — only reachable behind
   *  `authorizeSuperuser`. */
  listAllProjects(): Promise<Project[]>;
```

At the end of the `Store` interface (before the closing brace), add a new section:

```ts
  /* ----- platform audit log (super-user management, slice 1) ----- */

  /** Append one audit record. Append-only. */
  recordAuditLog(e: AuditLog): Promise<AuditLog>;
  /** Audit records matching the filter, newest first. */
  listAuditLogs(query: {
    actorUserId?: string;
    action?: string;
    targetType?: string;
    targetId?: string;
    limit?: number;
  }): Promise<AuditLog[]>;
```

- [ ] **Step 4: Implement the methods on `InMemoryStore`**

In `src/domain/store.ts`, in the `InMemoryStore` users/sessions section (after `setUserAvatarUrl`, ~line 1445), add:

```ts
  async setUserPlatformRole(
    userId: string,
    role: PlatformRole | null,
  ): Promise<AuthUser> {
    const existing = this.users.get(userId);
    if (!existing) throw new Error(`user ${userId} not found`);
    const updated: AuthUser = { ...existing, platformRole: role ?? undefined };
    this.users.set(userId, updated);
    return updated;
  }

  async listAllUsers(): Promise<AuthUser[]> {
    return [...this.users.values()].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }
```

In the projects section (after `listProjects`, ~line 574), add:

```ts
  async listAllProjects(): Promise<Project[]> {
    return [...this.projects.values()].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }
```

At the end of the `InMemoryStore` class (before the final closing brace), add:

```ts
  /* ----- platform audit log (super-user management, slice 1) ----- */

  private auditLog: AuditLog[] = [];

  async recordAuditLog(e: AuditLog): Promise<AuditLog> {
    this.auditLog.push(e);
    if (this.auditLog.length > 5000) {
      this.auditLog = this.auditLog.slice(-5000);
    }
    return e;
  }

  async listAuditLogs(query: {
    actorUserId?: string;
    action?: string;
    targetType?: string;
    targetId?: string;
    limit?: number;
  }): Promise<AuditLog[]> {
    const limit = query.limit ?? 100;
    return this.auditLog
      .filter(
        (e) =>
          (query.actorUserId === undefined || e.actorUserId === query.actorUserId) &&
          (query.action === undefined || e.action === query.action) &&
          (query.targetType === undefined || e.targetType === query.targetType) &&
          (query.targetId === undefined || e.targetId === query.targetId),
      )
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --import tsx --test src/domain/admin-store.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/domain/store.ts src/domain/admin-store.test.ts
git commit -m "feat(store): platformRole, cross-tenant lists, audit log (InMemory)"
```

---

## Task 3: Prisma schema + boot-migration + PrismaStore impls

**Files:**
- Modify: `prisma/schema.prisma`, `src/domain/boot-migrations.ts`, `src/domain/prisma-store.ts`

No new unit test (PrismaStore needs a live DB; the InMemory contract in Task 2 is the behavioural test). The check is `prisma generate` + `tsc --noEmit`.

- [ ] **Step 1: Add the schema column + model**

In `prisma/schema.prisma`, in `model User`, add after `avatarUrl`:

```prisma
  /// Platform super-user role (super-user management, slice 1). Null for
  /// ordinary tenant users. Stored as a guarded string (validated in TS via
  /// the PlatformRole union) — NOT a Prisma enum, to keep the boot-migration
  /// a simple additive TEXT column (mirrors Project.repoHost).
  platformRole String?
```

At the end of `prisma/schema.prisma`, add:

```prisma
// ----- platform audit log (super-user management, slice 1) -----
//
// Append-only record of every privileged /v1/admin/* action. actorEmail is
// denormalized so the trail survives user deletion. No FK to User — the log
// must outlive the actor.

model AuditLog {
  id          String   @id @default(cuid())
  actorUserId String
  actorEmail  String
  action      String
  targetType  String
  targetId    String?
  accountId   String?
  metadata    Json     @default("{}")
  ip          String?
  createdAt   DateTime @default(now())

  @@index([actorUserId, createdAt])
  @@index([targetType, targetId])
  @@index([accountId, createdAt])
}
```

- [ ] **Step 2: Add the boot-migrations (prod parity — critical)**

In `src/domain/boot-migrations.ts`, append these entries to the `MIGRATIONS` array (after the last conversation entry):

```ts
  {
    id: "20260601000000_add_user_platform_role",
    description:
      "User.platformRole — platform super-user role (super-user management, slice 1). Nullable TEXT; legacy rows read as ordinary tenant users.",
    sql: 'ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "platformRole" TEXT;',
  },
  {
    id: "20260601000001_create_audit_log_table",
    description:
      "AuditLog — append-only platform audit trail for /v1/admin/* actions (super-user management, slice 1).",
    sql: `CREATE TABLE IF NOT EXISTS "AuditLog" (
      "id" TEXT NOT NULL,
      "actorUserId" TEXT NOT NULL,
      "actorEmail" TEXT NOT NULL,
      "action" TEXT NOT NULL,
      "targetType" TEXT NOT NULL,
      "targetId" TEXT,
      "accountId" TEXT,
      "metadata" JSONB NOT NULL DEFAULT '{}',
      "ip" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
    );`,
  },
  {
    id: "20260601000002_create_audit_log_actor_index",
    description:
      "AuditLog [actorUserId, createdAt] index — backs the per-actor audit view.",
    sql: 'CREATE INDEX IF NOT EXISTS "AuditLog_actorUserId_createdAt_idx" ON "AuditLog"("actorUserId", "createdAt");',
  },
  {
    id: "20260601000003_create_audit_log_target_index",
    description:
      "AuditLog [targetType, targetId] index — backs the per-target audit view.",
    sql: 'CREATE INDEX IF NOT EXISTS "AuditLog_targetType_targetId_idx" ON "AuditLog"("targetType", "targetId");',
  },
  {
    id: "20260601000004_create_audit_log_account_index",
    description:
      "AuditLog [accountId, createdAt] index — backs the per-tenant audit view.",
    sql: 'CREATE INDEX IF NOT EXISTS "AuditLog_accountId_createdAt_idx" ON "AuditLog"("accountId", "createdAt");',
  },
```

- [ ] **Step 3: Thread `platformRole` through `toAuthUser` + `createUser`; add Prisma impls**

In `src/domain/prisma-store.ts`:

(a) In `toAuthUser` (~line 2455), add the field (the Prisma column is `String?`; cast to the union):

```ts
    platformRole: (r.platformRole ?? undefined) as AuthUser["platformRole"],
```

(b) In `createUser` (~line 1417), add `platformRole` to the `data`:

```ts
        platformRole: u.platformRole,
```

(c) After `setUserAvatarUrl` (~line 1453), add:

```ts
  async setUserPlatformRole(
    userId: string,
    role: PlatformRole | null,
  ): Promise<AuthUser> {
    const row = await this.db.user.update({
      where: { id: userId },
      data: { platformRole: role },
    });
    return toAuthUser(row);
  }

  async listAllUsers(): Promise<AuthUser[]> {
    const rows = await this.db.user.findMany({
      orderBy: { createdAt: "desc" },
    });
    return rows.map(toAuthUser);
  }
```

(d) Find the existing `listProjects` impl in `prisma-store.ts` and add directly after it:

```ts
  async listAllProjects(): Promise<Project[]> {
    const rows = await this.db.project.findMany({
      orderBy: { createdAt: "desc" },
    });
    return rows.map(toProject);
  }
```

> Note: use the same row→domain mapper `listProjects` uses (it is `toProject` in this file — confirm the exact name when implementing and match it).

(e) At the end of the `PrismaStore` class, add the audit methods + a mapper near the other `to*` mappers:

```ts
  async recordAuditLog(e: AuditLog): Promise<AuditLog> {
    const row = await this.db.auditLog.create({
      data: {
        id: e.id,
        actorUserId: e.actorUserId,
        actorEmail: e.actorEmail,
        action: e.action,
        targetType: e.targetType,
        targetId: e.targetId,
        accountId: e.accountId,
        metadata: e.metadata as object,
        ip: e.ip,
        createdAt: new Date(e.createdAt),
      },
    });
    return toAuditLog(row);
  }

  async listAuditLogs(query: {
    actorUserId?: string;
    action?: string;
    targetType?: string;
    targetId?: string;
    limit?: number;
  }): Promise<AuditLog[]> {
    const rows = await this.db.auditLog.findMany({
      where: {
        actorUserId: query.actorUserId,
        action: query.action,
        targetType: query.targetType,
        targetId: query.targetId,
      },
      orderBy: { createdAt: "desc" },
      take: query.limit ?? 100,
    });
    return rows.map(toAuditLog);
  }
```

Add the mapper alongside `toAuthUser`/`toSession` (cast `DbAuditLog` from `@prisma/client` like the other `Db*` aliases in this file):

```ts
function toAuditLog(r: DbAuditLog): AuditLog {
  return {
    id: r.id,
    actorUserId: r.actorUserId,
    actorEmail: r.actorEmail,
    action: r.action,
    targetType: r.targetType,
    targetId: r.targetId ?? undefined,
    accountId: r.accountId ?? undefined,
    metadata: (r.metadata ?? {}) as Record<string, unknown>,
    ip: r.ip ?? undefined,
    createdAt: r.createdAt.toISOString(),
  };
}
```

Add the imports for `AuditLog`, `PlatformRole`, and the `DbAuditLog` Prisma type to the existing import blocks at the top of `prisma-store.ts` (match how `DbUser`/`DbSession` are aliased from `@prisma/client`).

- [ ] **Step 4: Regenerate the client + typecheck**

Run: `npm run prisma:generate && npm run typecheck`
Expected: no type errors. (If `toProject`/`DbAuditLog` names differ, fix to match the file's actual mapper/alias names.)

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: all green (the Task 2 InMemory tests still pass; nothing else regressed).

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma src/domain/boot-migrations.ts src/domain/prisma-store.ts
git commit -m "feat(store): Prisma platformRole + AuditLog + boot-migration parity"
```

---

## Task 4: `authorizeSuperuser` pure guard helper

**Files:**
- Modify: `src/auth/account.ts`
- Create: `src/auth/superuser.ts`
- Test: `src/auth/superuser.test.ts`

- [ ] **Step 1: Add `platformRole` to `SessionAuth`**

In `src/auth/account.ts`, import `PlatformRole` and extend the interface:

```ts
import type { ApiKey, PlatformRole } from "../domain/types";
```

```ts
export interface SessionAuth {
  userId: string;
  accountId?: string;
  sessionId: string;
  /** Platform super-user role for the signed-in user (super-user
   *  management, slice 1). Undefined for ordinary tenant users. Set by the
   *  onRequest auth hook from the resolved user row. */
  platformRole?: PlatformRole;
}
```

> Note: `../domain/types` currently exports `ApiKey`? Confirm — `account.ts` imports `ApiKey` from `../domain/types` already. Keep the single combined import.

- [ ] **Step 2: Write the failing test**

Create `src/auth/superuser.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { authorizeSuperuser } from "./superuser";
import type { SessionAuth } from "./account";

const base: SessionAuth = { userId: "usr_a", accountId: "acc_1", sessionId: "ses_1" };

test("no session → 401", () => {
  const d = authorizeSuperuser(undefined);
  assert.deepEqual(d, { ok: false, status: 401, error: "session required (Bearer cts_ token)" });
});

test("session without platformRole → 403", () => {
  const d = authorizeSuperuser(base);
  assert.equal(d.ok, false);
  assert.equal((d as { status: number }).status, 403);
});

test("tenant owner (no platformRole) is still rejected — platform scope != tenant scope", () => {
  // A tenant 'owner' has no platformRole; the guard must reject them.
  const d = authorizeSuperuser({ ...base });
  assert.equal(d.ok, false);
});

test("superadmin → ok", () => {
  const d = authorizeSuperuser({ ...base, platformRole: "superadmin" });
  assert.equal(d.ok, true);
  assert.equal((d as { ok: true; session: SessionAuth }).session.userId, "usr_a");
});

test("support is rejected by default (superadmin-only)", () => {
  const d = authorizeSuperuser({ ...base, platformRole: "support" });
  assert.equal(d.ok, false);
  assert.equal((d as { status: number }).status, 403);
});

test("support is allowed when explicitly in the allow-list (read routes)", () => {
  const d = authorizeSuperuser({ ...base, platformRole: "support" }, ["superadmin", "support"]);
  assert.equal(d.ok, true);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --import tsx --test src/auth/superuser.test.ts`
Expected: FAIL — `Cannot find module './superuser'`.

- [ ] **Step 4: Implement the helper**

Create `src/auth/superuser.ts`:

```ts
/* ============================================================
   Super-user authz (super-user management, slice 1).

   A pure decision function over a resolved Console session. Lives in
   its own module — separate from index.ts (which calls app.listen at
   import time) — so it is unit-testable without booting the server,
   mirroring how getApiKey/getSessionAuth were extracted into account.ts.
   ============================================================ */

import type { SessionAuth } from "./account";
import type { PlatformRole } from "../domain/types";

export type SuperuserDecision =
  | { ok: true; session: SessionAuth }
  | { ok: false; status: 401 | 403; error: string };

/** Decide whether `session` may access a platform super-user surface.
 *  `allow` defaults to superadmin-only; pass `["superadmin", "support"]`
 *  for read routes that `support` may also reach. Returns a discriminated
 *  decision — the caller maps `{status, error}` to a Fastify reply. */
export function authorizeSuperuser(
  session: SessionAuth | undefined,
  allow: PlatformRole[] = ["superadmin"],
): SuperuserDecision {
  if (!session) {
    return { ok: false, status: 401, error: "session required (Bearer cts_ token)" };
  }
  const role = session.platformRole;
  if (!role || !allow.includes(role)) {
    return { ok: false, status: 403, error: "super-user access required" };
  }
  return { ok: true, session };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --import tsx --test src/auth/superuser.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add src/auth/account.ts src/auth/superuser.ts src/auth/superuser.test.ts
git commit -m "feat(auth): authorizeSuperuser guard + SessionAuth.platformRole"
```

---

## Task 5: Control-plane admin read model + audit (cp methods)

**Files:**
- Modify: `src/core/control-plane.ts`
- Test: `src/core/admin-readmodel.test.ts` *(new)*

The `cp` is constructed as `new ControlPlane({ store, provisioner, dataPlane, stripe, aiAnalyser })` and reads the store via `this.deps.store` (see `resolveSession`, which calls `this.deps.store.getUser`).

- [ ] **Step 1: Write the failing test**

Create `src/core/admin-readmodel.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { ControlPlane } from "./control-plane";
import { InMemoryStore } from "../domain/store";
import { stubProvisioner, stubDataPlane } from "../dataplane/stub";
import { StubStripeAdapter } from "../billing/stripe";
import { RuleBasedAiAnalyser } from "../ai/analyser";

function makeCp(): { cp: ControlPlane; store: InMemoryStore } {
  const store = new InMemoryStore();
  const cp = new ControlPlane({
    store,
    provisioner: stubProvisioner,
    dataPlane: stubDataPlane,
    stripe: new StubStripeAdapter(),
    aiAnalyser: new RuleBasedAiAnalyser(),
  });
  return { cp, store };
}

const T = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();

async function seed(store: InMemoryStore) {
  await store.createAccount({ id: "acc_1", name: "One", handle: "one", plan: "starter", createdAt: T(0) });
  await store.createUser({ id: "usr_owner", email: "owner@one.com", name: "Owner", twoFactorEnabled: false, accountId: "acc_1", createdAt: T(1) });
  await store.createMembership({ id: "mem_1", userId: "usr_owner", accountId: "acc_1", role: "owner", createdAt: T(1) });
  await store.createProject({ id: "prj_1", accountId: "acc_1", slug: "p1", name: "p1", runtime: "node", region: "fsn1", status: "live", createdAt: T(2) } as never);
}

test("adminListAccounts returns every account with project + member counts", async () => {
  const { cp, store } = makeCp();
  await seed(store);
  const accounts = await cp.adminListAccounts({});
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].id, "acc_1");
  assert.equal(accounts[0].projectCount, 1);
  assert.equal(accounts[0].memberCount, 1);
});

test("adminListAccounts filters by plan and query", async () => {
  const { cp, store } = makeCp();
  await seed(store);
  await store.createAccount({ id: "acc_2", name: "Acme Pro", handle: "acme", plan: "pro", createdAt: T(0) });
  assert.deepEqual((await cp.adminListAccounts({ plan: "pro" })).map((a) => a.id), ["acc_2"]);
  assert.deepEqual((await cp.adminListAccounts({ q: "acme" })).map((a) => a.id), ["acc_2"]);
});

test("adminListUsers searches by email/name", async () => {
  const { cp, store } = makeCp();
  await seed(store);
  assert.deepEqual((await cp.adminListUsers({ q: "owner@one" })).map((u) => u.id), ["usr_owner"]);
  assert.equal((await cp.adminListUsers({ q: "nobody" })).length, 0);
});

test("adminListProjects returns all projects, filterable by account + status", async () => {
  const { cp, store } = makeCp();
  await seed(store);
  assert.equal((await cp.adminListProjects({})).length, 1);
  assert.equal((await cp.adminListProjects({ accountId: "acc_1" })).length, 1);
  assert.equal((await cp.adminListProjects({ status: "paused" })).length, 0);
});

test("recordAdminAudit denormalizes the actor email and lists back", async () => {
  const { cp, store } = makeCp();
  await seed(store);
  await store.setUserPlatformRole("usr_owner", "superadmin");

  await cp.recordAdminAudit({
    actorUserId: "usr_owner",
    action: "admin.account.read",
    targetType: "account",
    targetId: "acc_1",
    metadata: { q: "one" },
    ip: "127.0.0.1",
  });

  const events = await cp.listAdminAudit({});
  assert.equal(events.length, 1);
  assert.equal(events[0].actorEmail, "owner@one.com");
  assert.equal(events[0].action, "admin.account.read");
  assert.equal(events[0].targetId, "acc_1");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test src/core/admin-readmodel.test.ts`
Expected: FAIL — `cp.adminListAccounts is not a function`.

- [ ] **Step 3: Implement the cp methods**

In `src/core/control-plane.ts`, add an import for `id`/`now` if not already present (check the top of the file — it likely already imports id helpers; if not):

```ts
import { id, now } from "../lib/ids";
```

Add these methods to the `ControlPlane` class (near `resolveSession`, in the auth/admin area). Define the small return shapes inline:

```ts
  /* ============================================================
     Platform super-user back-office read model (super-user
     management, slice 1). All cross-tenant; only reachable behind
     authorizeSuperuser at the route layer. Reads only.
     ============================================================ */

  /** Every account with cheap per-account counts, filterable by plan and
   *  a free-text query over name/handle. Newest first. */
  async adminListAccounts(filter: {
    q?: string;
    plan?: string;
    billingStatus?: string;
    limit?: number;
  }): Promise<
    Array<{
      id: string;
      name: string;
      handle: string;
      plan: string;
      billingStatus?: string;
      projectCount: number;
      memberCount: number;
      createdAt: string;
    }>
  > {
    const q = filter.q?.trim().toLowerCase();
    const accounts = await this.deps.store.listAccounts();
    const rows = [];
    for (const a of accounts) {
      if (filter.plan && a.plan !== filter.plan) continue;
      if (filter.billingStatus && (a.billingStatus ?? "active") !== filter.billingStatus) continue;
      if (q && !a.name.toLowerCase().includes(q) && !a.handle.toLowerCase().includes(q)) continue;
      const [projects, members] = await Promise.all([
        this.deps.store.listProjects(a.id),
        this.deps.store.listMembershipsByAccount(a.id),
      ]);
      rows.push({
        id: a.id,
        name: a.name,
        handle: a.handle,
        plan: a.plan,
        billingStatus: a.billingStatus,
        projectCount: projects.length,
        memberCount: members.length,
        createdAt: a.createdAt,
      });
    }
    rows.sort((x, y) => y.createdAt.localeCompare(x.createdAt));
    return rows.slice(0, filter.limit ?? 200);
  }

  /** Every user across tenants, filterable by a free-text query over
   *  email/name. Returns a privacy-conscious projection (no passwordHash). */
  async adminListUsers(filter: { q?: string; limit?: number }): Promise<
    Array<{
      id: string;
      email: string;
      name: string;
      platformRole?: string;
      accountId?: string;
      emailVerifiedAt?: string;
      createdAt: string;
    }>
  > {
    const q = filter.q?.trim().toLowerCase();
    const users = await this.deps.store.listAllUsers();
    return users
      .filter(
        (u) =>
          !q ||
          u.email.toLowerCase().includes(q) ||
          u.name.toLowerCase().includes(q),
      )
      .slice(0, filter.limit ?? 200)
      .map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        platformRole: u.platformRole,
        accountId: u.accountId,
        emailVerifiedAt: u.emailVerifiedAt,
        createdAt: u.createdAt,
      }));
  }

  /** Every project across accounts, filterable by account + status. */
  async adminListProjects(filter: {
    accountId?: string;
    status?: string;
    limit?: number;
  }): Promise<Project[]> {
    const all = await this.deps.store.listAllProjects();
    return all
      .filter(
        (p) =>
          (!filter.accountId || p.accountId === filter.accountId) &&
          (!filter.status || p.status === filter.status),
      )
      .slice(0, filter.limit ?? 500);
  }

  /** Write one audit record. Looks up the actor's email so the trail is
   *  attributable even after the user is deleted. */
  async recordAdminAudit(input: {
    actorUserId: string;
    action: string;
    targetType: string;
    targetId?: string;
    accountId?: string;
    metadata?: Record<string, unknown>;
    ip?: string;
  }): Promise<void> {
    const actor = await this.deps.store.getUser(input.actorUserId);
    await this.deps.store.recordAuditLog({
      id: id("aud"),
      actorUserId: input.actorUserId,
      actorEmail: actor?.email ?? "unknown",
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      accountId: input.accountId,
      metadata: input.metadata ?? {},
      ip: input.ip,
      createdAt: now(),
    });
  }

  /** Read the audit log (newest first), filterable. */
  async listAdminAudit(filter: {
    actorUserId?: string;
    action?: string;
    targetType?: string;
    targetId?: string;
    limit?: number;
  }) {
    return this.deps.store.listAuditLogs(filter);
  }

  /** Promote/demote a user's platform role (super-user management). Used by
   *  the owner seed today; later slices expose a guarded route. */
  async setUserPlatformRole(userId: string, role: PlatformRole | null) {
    return this.deps.store.setUserPlatformRole(userId, role);
  }
```

Add a `PlatformRole` import at the top of `control-plane.ts` if not already imported from `../domain/types`.

- [ ] **Step 4: Surface `platformRole` from `resolveSession` + `getAuthUser`**

In `resolveSession` (~line 5817), add `platformRole` to the returned `user` object:

```ts
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        avatarUrl: user.avatarUrl,
        accountId: user.accountId,
        platformRole: user.platformRole,
      },
```

Extend the method's return-type annotation `user: { … }` (~line 5790) to include `platformRole?: PlatformRole;`.

`getAuthUser` already returns the full `AuthUser` (it is what `/v1/me` calls), so `user.platformRole` is available there with no change.

- [ ] **Step 5: Run test to verify it passes**

Run: `node --import tsx --test src/core/admin-readmodel.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Typecheck + full suite**

Run: `npm run typecheck && npm test`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/core/control-plane.ts src/core/admin-readmodel.test.ts
git commit -m "feat(cp): admin read model + audit + platformRole on session"
```

---

## Task 6: `/v1/admin/*` routes + audit, behind the guard

**Files:**
- Modify: `src/index.ts`

These routes are wired into the live server. They are exercised end-to-end manually (Task 12 verification); the guard logic itself is unit-tested in Task 4 and the read model in Task 5. Keep the handlers thin — they only guard, audit, and delegate.

- [ ] **Step 1: Import the guard + thread `platformRole` onto `req.session`**

At the top of `src/index.ts`, add to the auth imports:

```ts
import { authorizeSuperuser } from "./auth/superuser";
import type { PlatformRole } from "./domain/types";
```

In the onRequest hook where `req.session` is set (~line 266), add `platformRole`:

```ts
      (req as unknown as { session?: SessionAuth }).session = {
        userId: resolved.user.id,
        accountId: resolved.currentAccountId ?? resolved.user.accountId,
        sessionId: resolved.sessionId,
        platformRole: resolved.user.platformRole,
      };
```

- [ ] **Step 2: Add a thin per-route guard helper**

Near the other route helpers in `src/index.ts` (e.g. just after `requireBillingPrincipal`), add:

```ts
/* ----- super-user route guard (super-user management, slice 1).
 *  Resolves the caller's session, asserts the platform role, and — on
 *  success — returns the SessionAuth. On failure it sends the mapped
 *  status and returns null. Read routes pass `["superadmin","support"]`. */
function requireSuper(
  request: FastifyRequest,
  reply: FastifyReply,
  allow: PlatformRole[] = ["superadmin"],
): SessionAuth | null {
  const decision = authorizeSuperuser(getSessionAuth(request), allow);
  if (!decision.ok) {
    cp.recordAuthFailure({
      reason: "scope_denied",
      method: request.method,
      route: request.url.split("?")[0],
    });
    reply.code(decision.status).send({ error: decision.error });
    return null;
  }
  return decision.session;
}
```

- [ ] **Step 3: Add the five read routes**

Add this block in `src/index.ts` near the other `/v1/*` GET routes (e.g. after the `/v1/me/orgs` group). Reads allow both roles; the audit row records the filter used.

```ts
/* ============================================================
   Platform super-user back-office — read-only (super-user
   management, slice 1). All under /v1/admin/*, all behind
   requireSuper. Every cross-tenant read writes an AuditLog row,
   EXCEPT GET /v1/admin/audit (reading the log is not itself logged).
   ============================================================ */

const ADMIN_READ: PlatformRole[] = ["superadmin", "support"];

app.get("/v1/admin/accounts", async (request, reply) => {
  const session = requireSuper(request, reply, ADMIN_READ);
  if (!session) return;
  const q = request.query as { q?: string; plan?: string; billingStatus?: string };
  const accounts = await cp.adminListAccounts({
    q: q.q,
    plan: q.plan,
    billingStatus: q.billingStatus,
  });
  await cp.recordAdminAudit({
    actorUserId: session.userId,
    action: "admin.account.list",
    targetType: "account",
    metadata: { q: q.q, plan: q.plan, billingStatus: q.billingStatus },
    ip: request.ip,
  });
  return { accounts };
});

app.get("/v1/admin/accounts/:id", async (request, reply) => {
  const session = requireSuper(request, reply, ADMIN_READ);
  if (!session) return;
  const { id: accountId } = request.params as { id: string };
  const account = await cp.getAccount(accountId);
  if (!account) return reply.code(404).send({ error: "account not found" });
  const [projects, members] = await Promise.all([
    cp.listProjects(accountId),
    cp.listMembershipsByAccount(accountId),
  ]);
  await cp.recordAdminAudit({
    actorUserId: session.userId,
    action: "admin.account.read",
    targetType: "account",
    targetId: accountId,
    accountId,
    ip: request.ip,
  });
  return { account, projects, members };
});

app.get("/v1/admin/users", async (request, reply) => {
  const session = requireSuper(request, reply, ADMIN_READ);
  if (!session) return;
  const q = request.query as { q?: string };
  const users = await cp.adminListUsers({ q: q.q });
  await cp.recordAdminAudit({
    actorUserId: session.userId,
    action: "admin.user.list",
    targetType: "user",
    metadata: { q: q.q },
    ip: request.ip,
  });
  return { users };
});

app.get("/v1/admin/projects", async (request, reply) => {
  const session = requireSuper(request, reply, ADMIN_READ);
  if (!session) return;
  const q = request.query as { accountId?: string; status?: string };
  const projects = await cp.adminListProjects({ accountId: q.accountId, status: q.status });
  await cp.recordAdminAudit({
    actorUserId: session.userId,
    action: "admin.project.list",
    targetType: "project",
    metadata: { accountId: q.accountId, status: q.status },
    ip: request.ip,
  });
  return { projects };
});

app.get("/v1/admin/audit", async (request, reply) => {
  const session = requireSuper(request, reply, ADMIN_READ);
  if (!session) return;
  const q = request.query as {
    actorUserId?: string;
    action?: string;
    targetType?: string;
    targetId?: string;
    limit?: string;
  };
  const events = await cp.listAdminAudit({
    actorUserId: q.actorUserId,
    action: q.action,
    targetType: q.targetType,
    targetId: q.targetId,
    limit: q.limit ? Math.max(1, Math.min(500, Number(q.limit))) : 100,
  });
  // Deliberately NOT audited — reading the log must not generate log noise.
  return { events };
});
```

> Implementation note for `/v1/admin/accounts/:id`: it calls `cp.listMembershipsByAccount(accountId)`, `cp.listProjects(accountId)`, and `cp.getAccount(accountId)`. `cp.listProjects` and `cp.getAccount` already back existing tenant routes. If `cp.listMembershipsByAccount` is not already exposed on `ControlPlane`, add a one-line wrapper `async listMembershipsByAccount(id: string) { return this.deps.store.listMembershipsByAccount(id); }` (the store method exists — Task 2 used it). If any name differs in the real file, match the real one.

- [ ] **Step 4: Verify `/v1/admin/*` is not accidentally exempted by the auth hook**

Read the enforcement hook (the `CANTILA_REQUIRE_AUTH` block, ~lines 420-507). `/v1/admin/*` is NOT in any allow-list there, so when `CANTILA_REQUIRE_AUTH` is on a missing credential already 401s before our guard; when off, our `requireSuper` still 401/403s because it checks the session directly. No change needed — just confirm no `url.startsWith("/v1/admin")` bypass exists.

- [ ] **Step 5: Typecheck + boot smoke**

Run: `npm run typecheck`
Expected: no errors.

Then a boot smoke test (in-memory store, auth off) to confirm the routes mount and reject anonymous callers:

```bash
CANTILA_STORE=memory node --import tsx src/index.ts &
sleep 1
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8080/v1/admin/accounts   # expect 401
kill %1
```

Expected: `401` (no session → guard returns 401).

> On Windows PowerShell, run the server with `node --import tsx src/index.ts` in one terminal and `curl.exe ...` in another, or use the existing dev script. The assertion is just: anonymous `/v1/admin/accounts` → 401.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts
git commit -m "feat(api): /v1/admin/* read routes behind requireSuper + audit"
```

---

## Task 7: Re-gate admin password reset behind the guard; deprecate the token

**Files:**
- Modify: `src/index.ts` (the `POST /v1/auth/admin/reset-password` route, ~line 2496)

- [ ] **Step 1: Replace the token check with a session-or-deprecated-token gate**

Rewrite the guard portion of `POST /v1/auth/admin/reset-password` so a super-user session is the primary credential and the env token is a logged, deprecated fallback:

```ts
app.post("/v1/auth/admin/reset-password", async (request, reply) => {
  // Primary path (super-user management, slice 1): a superadmin session.
  const decision = authorizeSuperuser(getSessionAuth(request), ["superadmin"]);
  let actorUserId: string | null = decision.ok ? decision.session.userId : null;

  if (!decision.ok) {
    // Deprecated fallback — the shared CANTILA_ADMIN_TOKEN. Kept so prod
    // tooling does not break mid-migration; logs a deprecation warning.
    // TODO(slice-2): remove this fallback once no caller relies on it.
    const adminToken = process.env.CANTILA_ADMIN_TOKEN;
    const provided = request.headers["x-cantila-admin-token"];
    if (
      adminToken &&
      typeof provided === "string" &&
      provided === adminToken
    ) {
      request.log.warn(
        "DEPRECATED: x-cantila-admin-token used for admin reset — migrate to a superadmin session",
      );
    } else {
      // Neither a superadmin session nor a valid token → mirror the guard's
      // decision (401 when no session at all, 403 otherwise).
      return reply.code(decision.status).send({ error: decision.error });
    }
  }

  const body = (request.body ?? {}) as { email?: unknown; newPassword?: unknown };
  if (typeof body.email !== "string" || typeof body.newPassword !== "string") {
    return reply.code(400).send({ error: "email and newPassword (string) required" });
  }
  try {
    const result = await cp.adminResetPassword({
      email: body.email,
      newPassword: body.newPassword,
    });
    if (!result) {
      return reply.code(404).send({ error: "no user with that email" });
    }
    await cp.recordAdminAudit({
      actorUserId: actorUserId ?? "token:CANTILA_ADMIN_TOKEN",
      action: "admin.user.reset_password",
      targetType: "user",
      metadata: { email: body.email, viaToken: actorUserId === null },
      ip: request.ip,
    });
    return reply.code(200).send(result);
  } catch (err) {
    return reply
      .code(500)
      .send({ error: err instanceof Error ? err.message : "reset failed" });
  }
});
```

> Note: `recordAdminAudit` looks up the actor email by id; for the token path it passes the synthetic `actorUserId` `"token:CANTILA_ADMIN_TOKEN"`, which won't resolve to a user, so `actorEmail` records `"unknown"` — acceptable and clearly distinguishable from a real super-user action via the `viaToken: true` metadata.

- [ ] **Step 2: Typecheck + full suite**

Run: `npm run typecheck && npm test`
Expected: all green.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat(auth): gate admin reset behind superadmin session; deprecate shared token"
```

---

## Task 8: Owner seed promotes the founder to `superadmin`

**Files:**
- Modify: `src/domain/seed-owner.ts`, `src/index.ts` (owner-seed boot block, ~line 4064)
- Test: `src/domain/seed-owner-platformrole.test.ts` *(new)*

- [ ] **Step 1: Write the failing test**

Create `src/domain/seed-owner-platformrole.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { InMemoryStore } from "./store";
import { seedOwnerAccount } from "./seed-owner";

test("seedOwnerAccount promotes the owner to superadmin", async () => {
  const store = new InMemoryStore();
  const result = await seedOwnerAccount(store, {
    email: "founder@example.com",
    password: "correct horse battery staple",
    name: "Founder",
    accountId: "acc_cantila",
    accountName: "Cantila",
    handle: "cantila",
    plan: "dedicated",
  });
  const user = await store.getUser(result.userId);
  assert.equal(user?.platformRole, "superadmin");
});

test("seedOwnerAccount is idempotent on platformRole (re-run keeps superadmin)", async () => {
  const store = new InMemoryStore();
  const input = {
    email: "founder@example.com",
    password: "pw",
    name: "Founder",
    accountId: "acc_cantila",
    accountName: "Cantila",
    handle: "cantila",
    plan: "dedicated" as const,
  };
  const first = await seedOwnerAccount(store, input);
  await seedOwnerAccount(store, input);
  assert.equal((await store.getUser(first.userId))?.platformRole, "superadmin");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test src/domain/seed-owner-platformrole.test.ts`
Expected: FAIL — `platformRole` is `undefined`.

- [ ] **Step 3: Promote in `seedOwnerAccount`**

In `src/domain/seed-owner.ts`, after the membership step (step 3, ~line 108, before the `return`), add:

```ts
  // 4. Platform role — make the owner a super-user (super-user management,
  //    slice 1). Idempotent: only writes when not already superadmin.
  if (user.platformRole !== "superadmin") {
    user = await store.setUserPlatformRole(user.id, "superadmin");
  }
```

(The `user` binding is already `let`, reassigned in step 2, so this compiles.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test src/domain/seed-owner-platformrole.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Full suite**

Run: `npm test`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/domain/seed-owner.ts src/domain/seed-owner-platformrole.test.ts
git commit -m "feat(seed): owner is seeded as platform superadmin"
```

---

## Task 9: Surface `platformRole` on `/v1/me`

**Files:**
- Modify: `src/index.ts` (`GET /v1/me`, ~line 3637)

- [ ] **Step 1: Add `platformRole` to the session-caller `user` projection**

In `GET /v1/me`, the session branch builds `user: { id, email, name, emailVerifiedAt, avatarUrl }`. Add `platformRole`:

```ts
        user: user
          ? {
              id: user.id,
              email: user.email,
              name: user.name,
              emailVerifiedAt: user.emailVerifiedAt ?? null,
              avatarUrl: user.avatarUrl ?? null,
              platformRole: user.platformRole ?? null,
            }
          : null,
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat(api): surface platformRole on GET /v1/me"
```

This concludes the control-plane work. Run `npm test && npm run typecheck` once more — expect all green — before moving to the Console.

---

## Task 10: Console API client — admin methods + whoami `platformRole`

**Files:**
- Modify: `cantila-console/src/lib/api.ts`

The Console has no unit-test harness; verification for Tasks 10-13 is `npx tsc --noEmit` (from `cantila-console/`) and, at the end, `npm run build`.

- [ ] **Step 1: Add `platformRole` to `ApiWhoami.user`**

In `src/lib/api.ts`, in the `ApiWhoami` `user` shape (~line 2117), add:

```ts
        /** Platform super-user role (super-user management, slice 1).
         *  Null/undefined for ordinary tenant users. */
        platformRole?: "superadmin" | "support" | null;
```

- [ ] **Step 2: Add admin wire types**

Near the other `Api*` interfaces in `src/lib/api.ts`, add:

```ts
/* ----- super-user back-office (super-user management, slice 1) ----- */

export interface ApiAdminAccount {
  id: string;
  name: string;
  handle: string;
  plan: string;
  billingStatus?: string;
  projectCount: number;
  memberCount: number;
  createdAt: string;
}

export interface ApiAdminUser {
  id: string;
  email: string;
  name: string;
  platformRole?: "superadmin" | "support" | null;
  accountId?: string;
  emailVerifiedAt?: string;
  createdAt: string;
}

export interface ApiAuditEvent {
  id: string;
  actorUserId: string;
  actorEmail: string;
  action: string;
  targetType: string;
  targetId?: string;
  accountId?: string;
  metadata: Record<string, unknown>;
  ip?: string;
  createdAt: string;
}
```

- [ ] **Step 3: Add the admin methods to the `api` object**

Inside the `export const api = { … }` object, add (mirroring the existing `request<…>` + query-string style):

```ts
  /* ----- super-user back-office (super-user management, slice 1) ----- */

  adminListAccounts: (filter: { q?: string; plan?: string; billingStatus?: string } = {}) => {
    const p = new URLSearchParams();
    if (filter.q) p.set("q", filter.q);
    if (filter.plan) p.set("plan", filter.plan);
    if (filter.billingStatus) p.set("billingStatus", filter.billingStatus);
    const qs = p.toString();
    return request<{ accounts: ApiAdminAccount[] }>(`/admin/accounts${qs ? `?${qs}` : ""}`);
  },

  adminGetAccount: (id: string) =>
    request<{
      account: ApiAccount;
      projects: ApiProject[];
      members: { id: string; userId: string; accountId: string; role: ApiMemberRole; createdAt: string }[];
    }>(`/admin/accounts/${encodeURIComponent(id)}`),

  adminListUsers: (q?: string) =>
    request<{ users: ApiAdminUser[] }>(`/admin/users${q ? `?q=${encodeURIComponent(q)}` : ""}`),

  adminListProjects: (filter: { accountId?: string; status?: string } = {}) => {
    const p = new URLSearchParams();
    if (filter.accountId) p.set("accountId", filter.accountId);
    if (filter.status) p.set("status", filter.status);
    const qs = p.toString();
    return request<{ projects: ApiProject[] }>(`/admin/projects${qs ? `?${qs}` : ""}`);
  },

  adminListAudit: (filter: { actorUserId?: string; action?: string; targetType?: string; limit?: number } = {}) => {
    const p = new URLSearchParams();
    if (filter.actorUserId) p.set("actorUserId", filter.actorUserId);
    if (filter.action) p.set("action", filter.action);
    if (filter.targetType) p.set("targetType", filter.targetType);
    if (filter.limit) p.set("limit", String(filter.limit));
    const qs = p.toString();
    return request<{ events: ApiAuditEvent[] }>(`/admin/audit${qs ? `?${qs}` : ""}`);
  },
```

- [ ] **Step 4: Typecheck**

Run (from `cantila-console/`): `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/api.ts
git commit -m "feat(console-api): admin back-office client methods + whoami platformRole"
```

---

## Task 11: Console server-side super-user guard helper

**Files:**
- Create: `cantila-console/src/lib/admin-auth.ts`

- [ ] **Step 1: Implement the server-side guard**

Create `src/lib/admin-auth.ts`. It reads the session cookie and asks the control plane "who am I", returning the user when they hold a platform role, else null — the page layer calls Next's `notFound()` on null (404-cloak):

```ts
/* ============================================================
   Console super-user guard (super-user management, slice 1).

   Server-side only. Reads the session cookie and resolves the caller
   via the control plane's /v1/me. Returns the user when they hold a
   platform role, else null. The (admin) layout calls notFound() on
   null so the back-office 404-cloaks for everyone else — its very
   existence is not advertised.
   ============================================================ */

import { cookies } from "next/headers";
import { SESSION_COOKIE, CONTROL_PLANE_URL } from "./auth";

export interface SuperUser {
  id: string;
  email: string;
  name: string;
  platformRole: "superadmin" | "support";
}

/** Resolve the current super-user, or null when the caller is anonymous,
 *  an API-key caller, or an ordinary tenant user. Never throws. */
export async function getSuperUser(): Promise<SuperUser | null> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    const res = await fetch(`${CONTROL_PLANE_URL}/v1/me`, {
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const me = (await res.json()) as {
      authenticated?: boolean;
      user?: {
        id: string;
        email: string;
        name: string;
        platformRole?: "superadmin" | "support" | null;
      } | null;
    };
    const user = me.authenticated ? me.user : null;
    if (!user || !user.platformRole) return null;
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      platformRole: user.platformRole,
    };
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: Typecheck**

Run (from `cantila-console/`): `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/admin-auth.ts
git commit -m "feat(console): server-side super-user guard helper"
```

---

## Task 12: Console `(admin)` route group + pages

**Files:**
- Create: `cantila-console/src/app/(admin)/layout.tsx`
- Create: `cantila-console/src/app/(admin)/admin/accounts/page.tsx`
- Create: `cantila-console/src/app/(admin)/admin/users/page.tsx`
- Create: `cantila-console/src/app/(admin)/admin/projects/page.tsx`
- Create: `cantila-console/src/app/(admin)/admin/audit/page.tsx`

- [ ] **Step 1: The 404-cloaking layout**

Create `src/app/(admin)/layout.tsx` (server component — the guard runs server-side; `notFound()` renders the standard 404):

```tsx
import { notFound } from "next/navigation";
import Link from "next/link";
import { getSuperUser } from "@/lib/admin-auth";

/** The super-user back-office shell (super-user management, slice 1).
 *  404-cloaks for anyone without a platform role — the area's existence
 *  is not advertised. */
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const su = await getSuperUser();
  if (!su) notFound();

  const tabs = [
    { href: "/admin/accounts", label: "Accounts" },
    { href: "/admin/users", label: "Users" },
    { href: "/admin/projects", label: "Projects" },
    { href: "/admin/audit", label: "Audit log" },
  ];

  return (
    <div className="mx-auto w-full max-w-[1320px] px-4 py-8 sm:px-6 lg:px-9">
      <header className="mb-6 border-b border-border pb-4">
        <p className="font-mono text-[0.6rem] uppercase tracking-[0.22em] text-ember">
          Super-user back-office
        </p>
        <h1 className="mt-1 font-display text-2xl font-semibold text-ink">
          Platform administration
        </h1>
        <p className="mt-1 text-sm text-ink-dim">
          Signed in as {su.name} · {su.email} · {su.platformRole}
        </p>
        <nav className="mt-4 flex gap-2">
          {tabs.map((t) => (
            <Link
              key={t.href}
              href={t.href}
              className="rounded-lg px-3 py-1.5 text-sm text-ink-dim transition-colors hover:bg-surface-2 hover:text-ink"
            >
              {t.label}
            </Link>
          ))}
        </nav>
      </header>
      {children}
    </div>
  );
}
```

- [ ] **Step 2: Accounts page**

Create `src/app/(admin)/admin/accounts/page.tsx` (server component fetching server-side with the session cookie forwarded — it calls the control plane directly via a tiny helper so it works in RSC without the browser proxy). Reuse the guard's pattern:

```tsx
import { cookies } from "next/headers";
import { SESSION_COOKIE, CONTROL_PLANE_URL } from "@/lib/auth";
import type { ApiAdminAccount } from "@/lib/api";

async function fetchAdmin<T>(path: string): Promise<T> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  const res = await fetch(`${CONTROL_PLANE_URL}/v1${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`admin fetch failed: ${res.status}`);
  return res.json() as Promise<T>;
}

export default async function AdminAccountsPage() {
  const { accounts } = await fetchAdmin<{ accounts: ApiAdminAccount[] }>("/admin/accounts");
  return (
    <section>
      <h2 className="mb-3 text-lg font-semibold text-ink">
        Accounts <span className="text-ink-faint">({accounts.length})</span>
      </h2>
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full text-sm">
          <thead className="bg-surface-2 text-left text-ink-dim">
            <tr>
              <th className="px-3 py-2 font-medium">Name</th>
              <th className="px-3 py-2 font-medium">Handle</th>
              <th className="px-3 py-2 font-medium">Plan</th>
              <th className="px-3 py-2 font-medium">Billing</th>
              <th className="px-3 py-2 font-medium">Projects</th>
              <th className="px-3 py-2 font-medium">Members</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.id} className="border-t border-border-soft">
                <td className="px-3 py-2 text-ink">{a.name}</td>
                <td className="px-3 py-2 font-mono text-ink-dim">@{a.handle}</td>
                <td className="px-3 py-2 text-ink-dim">{a.plan}</td>
                <td className="px-3 py-2 text-ink-dim">{a.billingStatus ?? "active"}</td>
                <td className="px-3 py-2 text-ink-dim">{a.projectCount}</td>
                <td className="px-3 py-2 text-ink-dim">{a.memberCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
```

> Refactor note: the `fetchAdmin` helper is identical across the four pages. After the Accounts page is working, extract it into `src/lib/admin-auth.ts` (export `fetchAdmin`) and import it from each page — DRY. The plan shows it inline in Accounts only to keep Step 2 self-contained; do the extraction as part of Step 3.

- [ ] **Step 3: Extract `fetchAdmin` and build the Users, Projects, Audit pages**

Move `fetchAdmin` into `src/lib/admin-auth.ts`:

```ts
export async function fetchAdmin<T>(path: string): Promise<T> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  const res = await fetch(`${CONTROL_PLANE_URL}/v1${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`admin fetch failed: ${res.status}`);
  return res.json() as Promise<T>;
}
```

Update `accounts/page.tsx` to `import { fetchAdmin } from "@/lib/admin-auth";` and delete its local copy.

Create `src/app/(admin)/admin/users/page.tsx`:

```tsx
import { fetchAdmin } from "@/lib/admin-auth";
import type { ApiAdminUser } from "@/lib/api";

export default async function AdminUsersPage() {
  const { users } = await fetchAdmin<{ users: ApiAdminUser[] }>("/admin/users");
  return (
    <section>
      <h2 className="mb-3 text-lg font-semibold text-ink">
        Users <span className="text-ink-faint">({users.length})</span>
      </h2>
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full text-sm">
          <thead className="bg-surface-2 text-left text-ink-dim">
            <tr>
              <th className="px-3 py-2 font-medium">Email</th>
              <th className="px-3 py-2 font-medium">Name</th>
              <th className="px-3 py-2 font-medium">Platform role</th>
              <th className="px-3 py-2 font-medium">Account</th>
              <th className="px-3 py-2 font-medium">Verified</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-t border-border-soft">
                <td className="px-3 py-2 font-mono text-ink">{u.email}</td>
                <td className="px-3 py-2 text-ink-dim">{u.name}</td>
                <td className="px-3 py-2 text-ink-dim">{u.platformRole ?? "—"}</td>
                <td className="px-3 py-2 font-mono text-ink-faint">{u.accountId ?? "—"}</td>
                <td className="px-3 py-2 text-ink-dim">{u.emailVerifiedAt ? "yes" : "no"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
```

Create `src/app/(admin)/admin/projects/page.tsx`:

```tsx
import { fetchAdmin } from "@/lib/admin-auth";
import type { ApiProject } from "@/lib/api";

export default async function AdminProjectsPage() {
  const { projects } = await fetchAdmin<{ projects: ApiProject[] }>("/admin/projects");
  return (
    <section>
      <h2 className="mb-3 text-lg font-semibold text-ink">
        Projects <span className="text-ink-faint">({projects.length})</span>
      </h2>
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full text-sm">
          <thead className="bg-surface-2 text-left text-ink-dim">
            <tr>
              <th className="px-3 py-2 font-medium">Slug</th>
              <th className="px-3 py-2 font-medium">Name</th>
              <th className="px-3 py-2 font-medium">Account</th>
              <th className="px-3 py-2 font-medium">Runtime</th>
              <th className="px-3 py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {projects.map((p) => (
              <tr key={p.id} className="border-t border-border-soft">
                <td className="px-3 py-2 font-mono text-ink">{p.slug}</td>
                <td className="px-3 py-2 text-ink-dim">{p.name}</td>
                <td className="px-3 py-2 font-mono text-ink-faint">{p.accountId}</td>
                <td className="px-3 py-2 text-ink-dim">{p.runtime}</td>
                <td className="px-3 py-2 text-ink-dim">{p.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
```

Create `src/app/(admin)/admin/audit/page.tsx`:

```tsx
import { fetchAdmin } from "@/lib/admin-auth";
import type { ApiAuditEvent } from "@/lib/api";

export default async function AdminAuditPage() {
  const { events } = await fetchAdmin<{ events: ApiAuditEvent[] }>("/admin/audit?limit=200");
  return (
    <section>
      <h2 className="mb-3 text-lg font-semibold text-ink">
        Audit log <span className="text-ink-faint">({events.length})</span>
      </h2>
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full text-sm">
          <thead className="bg-surface-2 text-left text-ink-dim">
            <tr>
              <th className="px-3 py-2 font-medium">When</th>
              <th className="px-3 py-2 font-medium">Actor</th>
              <th className="px-3 py-2 font-medium">Action</th>
              <th className="px-3 py-2 font-medium">Target</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id} className="border-t border-border-soft">
                <td className="px-3 py-2 font-mono text-ink-faint">{e.createdAt}</td>
                <td className="px-3 py-2 text-ink-dim">{e.actorEmail}</td>
                <td className="px-3 py-2 font-mono text-ink">{e.action}</td>
                <td className="px-3 py-2 text-ink-dim">
                  {e.targetType}{e.targetId ? `:${e.targetId}` : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Typecheck + build**

Run (from `cantila-console/`): `npx tsc --noEmit && npm run build`
Expected: builds clean. The `(admin)` route group compiles; pages are server components.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(admin)" src/lib/admin-auth.ts
git commit -m "feat(console): super-user back-office (admin) route group + pages"
```

---

## Task 13: Conditional "Admin" nav entry (super-users only)

**Files:**
- Modify: `cantila-console/src/components/Sidebar.tsx`

- [ ] **Step 1: Read the platform role from whoami and render a conditional nav group**

In `src/components/Sidebar.tsx`, the `SidebarContent` component already fetches `api.whoami()` into `liveUser` on mount. Add platform-role state and set it from the same call. After the existing `liveUser` state declaration (~line 165), add:

```tsx
  const [platformRole, setPlatformRole] = useState<"superadmin" | "support" | null>(null);
```

In the existing `useEffect` that calls `api.whoami()` (~line 171), add inside the `try` after the `setLiveUser` line:

```tsx
        if (me.authenticated && me.user?.platformRole) {
          setPlatformRole(me.user.platformRole);
        }
```

- [ ] **Step 2: Render the Admin group at the end of the nav**

In the `nav` element, immediately after `{NAV.map(...)}` (after the closing `))}` of the map, ~line 339), add a conditional admin group. Import `ShieldAlert` from `lucide-react` (add to the existing import list at the top):

```tsx
        {platformRole && (
          <div className="mb-6 last:mb-0">
            {!collapsed && (
              <div className="px-3 pb-2 font-mono text-[0.6rem] uppercase tracking-[0.2em] text-ember">
                Platform
              </div>
            )}
            <ul className="space-y-0.5">
              <li>
                <Link
                  href="/admin/accounts"
                  onClick={onNavigate}
                  title={collapsed ? "Admin" : undefined}
                  aria-label={collapsed ? "Admin" : undefined}
                  className={cx(
                    "group relative flex min-h-11 items-center rounded-lg text-sm transition-colors",
                    collapsed ? "justify-center px-0" : "gap-2.5 px-3 py-2",
                    isActive("/admin")
                      ? "bg-surface-3 font-medium text-ink"
                      : "text-ink-dim hover:bg-surface-2 hover:text-ink",
                  )}
                >
                  <ShieldAlert
                    className={cx(
                      "h-[1.05rem] w-[1.05rem] transition-colors",
                      isActive("/admin") ? "text-ember" : "text-ink-faint group-hover:text-ink-dim",
                    )}
                    strokeWidth={2}
                  />
                  {!collapsed && "Admin"}
                </Link>
              </li>
            </ul>
          </div>
        )}
```

> `isActive("/admin")` returns true on `/admin` and any `/admin/*` path via the existing helper (it does `pathname === href || pathname.startsWith(href + "/")`), so the entry highlights across all back-office tabs.

- [ ] **Step 2.5: Add `ShieldAlert` to the lucide import**

In the `lucide-react` import block at the top of `Sidebar.tsx`, add `ShieldAlert,` alongside the other icons.

- [ ] **Step 3: Typecheck + build**

Run (from `cantila-console/`): `npx tsc --noEmit && npm run build`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/components/Sidebar.tsx
git commit -m "feat(console): show Admin nav entry only for super-users"
```

---

## Final verification (whole slice)

- [ ] **Control plane:** from `cantila-control-plane/`, run `npm run typecheck && npm test`. Expected: all green, including the new `admin-store`, `superuser`, `admin-readmodel`, and `seed-owner-platformrole` tests.
- [ ] **Console:** from `cantila-console/`, run `npx tsc --noEmit && npm run build`. Expected: clean build.
- [ ] **End-to-end smoke (manual, both apps running, `CANTILA_OWNER_PASSWORD` set so the owner is seeded as superadmin):**
  - Sign in as the owner → an "Admin" entry appears in the sidebar; `/admin/accounts` renders the tenant list.
  - Sign in as (or create) an ordinary tenant user → no "Admin" entry; visiting `/admin/accounts` directly returns a 404.
  - Hit `GET /v1/admin/accounts` with no credential → 401; with a tenant API key → 403.
  - After loading `/admin/accounts`, `GET /v1/admin/audit` shows the `admin.account.list` rows; loading `/admin/audit` itself adds no new row.

---

## Spec coverage check

| Spec requirement | Task |
|---|---|
| `User.platformRole` (nullable) | 1, 3 |
| `AuditLog` model + boot-migration parity | 1, 3 |
| `requireSuperuser` guard on sessions, not the token | 4, 6 |
| `/v1/admin/*` namespace, read-only endpoints | 6 |
| Audit on every cross-tenant request (except reading the log) | 5, 6 |
| Founder auto-promoted via owner seed | 8 |
| `CANTILA_ADMIN_TOKEN` deprecated (not removed) | 7 |
| Console `(admin)` area, 404-cloaked | 11, 12 |
| Admin nav entry only for super-users | 13 |
| Tenant `owner` rejected from `/v1/admin/*` (scope isolation) | 4 (unit), final smoke |
| Reads filtered + paginated (limit caps) | 5, 6 |

## Deferred to later slices (NOT in this plan)

Cross-tenant mutations (suspend/restore, force-cancel, redeploy, reset-any-user as a guarded route), attributed cross-tenant impersonation, infra/fleet controls, feature flags, and the full removal of `CANTILA_ADMIN_TOKEN`.
