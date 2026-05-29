# Cantila Platform Mailboxes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the platform owner create real, usable `cantila.app` mailboxes (starting with `info@cantila.app`) from the Console "New mailbox" modal, provisioned for real in the live Mailcow instance.

**Architecture:** A new `MailboxProvisioner` port (stub + Mailcow REST adapter), separate from the sending `MailProvider`, is called by `createHostedMailbox` only for a seeded system "Platform" project that owns `cantila.app`. Password is auto-generated, returned once, never persisted. Console gates the platform path on `useIsOwner()`.

**Tech Stack:** TypeScript, Fastify control plane, Prisma/InMemory stores, Next.js 14 Console. Verification = `npx tsx scripts/smoke-*.ts` + `tsc --noEmit` (no unit framework in this repo).

**Spec:** `docs/superpowers/specs/2026-05-29-platform-mailboxes-design.md`

## File Structure

**control-plane**
- `src/mail/provisioner.ts` (new) — `MailboxProvisioner` port, `StubMailboxProvisioner`, `createMailboxProvisioner()` factory + `mailboxProvisioner` singleton.
- `src/mail/mailcow-provisioner.ts` (new) — `MailcowMailboxProvisioner` (REST).
- `src/domain/types.ts` (modify) — `platform?: boolean` on `Project`; `oneTimePassword?: string` on create result.
- `src/domain/store.ts` (modify) — `InMemoryStore`: persist `platform`; `listProjectsByAccount` filters platform.
- `src/domain/prisma-store.ts` (modify) — map `platform` column; filter platform in list.
- `src/domain/boot-migrations.ts` (modify) — add `Project.platform` ALTER.
- `prisma/schema.prisma` + `prisma/migrations/.../migration.sql` (modify/new) — `platform` column.
- `src/domain/seed-platform.ts` (new) — idempotent Platform-project seed.
- `src/core/control-plane.ts` (modify) — provisioner dep; `createHostedMailbox` generates password, provisions when `project.platform`, returns `oneTimePassword`.
- `src/index.ts` (modify) — wire provisioner + run platform seed.
- `scripts/smoke-platform-mailbox.ts` (new) — offline behavior check.

**console**
- `src/lib/api.ts` (modify) — `oneTimePassword?: string` on create response.
- `src/components/MailboxesView.tsx` (modify) — owner platform path + one-time-password panel.

---

### Task 1: `platform` flag on Project

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `src/domain/store.ts`
- Modify: `src/domain/prisma-store.ts`
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260529010000_add_project_platform/migration.sql`
- Modify: `src/domain/boot-migrations.ts`

- [ ] **Step 1: Add the field to the `Project` type**

In `src/domain/types.ts`, find the `Project` interface and add after its last field:

```ts
  /** True only for the seeded system "Platform" project that owns
   *  cantila.app. Hidden from tenant project lists. */
  platform?: boolean;
```

- [ ] **Step 2: Persist it in `InMemoryStore`**

In `src/domain/store.ts`, locate `createProject` (where the project record is assembled) and ensure `platform` is carried through (spread of input already covers it if the method spreads `input`; if it builds an explicit object, add `platform: input.platform ?? false`). Then in `listProjectsByAccount` (the account-facing list), add a filter:

```ts
    return projects.filter((p) => p.accountId === accountId && !p.platform);
```

(If a `getProject(id)` exists, leave it unfiltered so the platform project is fetchable by id.)

- [ ] **Step 3: Map it in `PrismaStore`**

In `src/domain/prisma-store.ts`, add `platform: row.platform ?? false` to the row→`Project` mapper, `platform: input.platform ?? false` to the create path, and `where: { accountId, platform: false }` (or post-filter `!p.platform`) on the account-facing list query.

- [ ] **Step 4: Add the Prisma column**

In `prisma/schema.prisma`, on `model Project`, add:

```prisma
  platform Boolean @default(false)
```

Create `prisma/migrations/20260529010000_add_project_platform/migration.sql`:

```sql
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "platform" BOOLEAN NOT NULL DEFAULT false;
```

- [ ] **Step 5: Add the boot-migration ALTER**

In `src/domain/boot-migrations.ts`, append a new entry to the migrations array mirroring the existing `coolifyAppUuid`/`emailVerifiedAt` entries:

```ts
  {
    name: "20260529010000_add_project_platform",
    sql: `ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "platform" BOOLEAN NOT NULL DEFAULT false;`,
  },
```

- [ ] **Step 6: Verify types compile**

Run: `npx tsc --noEmit`
Expected: PASS (no errors).

- [ ] **Step 7: Commit**

```bash
git add src/domain/types.ts src/domain/store.ts src/domain/prisma-store.ts prisma/ src/domain/boot-migrations.ts
git commit -m "feat(mail): add platform flag to Project"
```

---

### Task 2: `MailboxProvisioner` port + stub + factory

**Files:**
- Create: `src/mail/provisioner.ts`

- [ ] **Step 1: Write the port, stub, and factory**

Create `src/mail/provisioner.ts`:

```ts
/* ============================================================
   Mailbox provisioning port (plan §4.4). Distinct from the
   sending `MailProvider`: provisioning talks to Mailcow's REST
   admin API, sending is SMTP submission. Keeping them separate
   means wiring real provisioning does NOT flip the sending path
   live (which would break the reset/verify debugLink flow).

   Stub today; MailcowMailboxProvisioner when MAILCOW_URL +
   MAILCOW_API_KEY are present.
   ============================================================ */

export type ProvisionResult = { ok: true } | { error: string };

export interface MailboxProvisioner {
  readonly label: string;
  readonly live: boolean;
  ensureDomain(domain: string): Promise<ProvisionResult>;
  createMailbox(input: {
    address: string;
    password: string;
    quotaMb: number;
    displayName?: string;
  }): Promise<ProvisionResult>;
  deleteMailbox(address: string): Promise<ProvisionResult>;
}

/** Deterministic no-op. Keeps offline smoke deterministic. */
export class StubMailboxProvisioner implements MailboxProvisioner {
  readonly label = "Stub provisioner";
  readonly live = false;
  async ensureDomain(): Promise<ProvisionResult> {
    return { ok: true };
  }
  async createMailbox(): Promise<ProvisionResult> {
    return { ok: true };
  }
  async deleteMailbox(): Promise<ProvisionResult> {
    return { ok: true };
  }
}

export function createMailboxProvisioner(): MailboxProvisioner {
  if (process.env.MAILCOW_URL && process.env.MAILCOW_API_KEY) {
    // Lazy import avoids loading the live adapter offline.
    const {
      MailcowMailboxProvisioner,
    } = require("./mailcow-provisioner") as typeof import("./mailcow-provisioner");
    return new MailcowMailboxProvisioner({
      url: process.env.MAILCOW_URL,
      apiKey: process.env.MAILCOW_API_KEY,
    });
  }
  return new StubMailboxProvisioner();
}

export const mailboxProvisioner: MailboxProvisioner = createMailboxProvisioner();
```

- [ ] **Step 2: Verify compile**

Run: `npx tsc --noEmit`
Expected: FAIL — `Cannot find module './mailcow-provisioner'` (created next task). This confirms the factory references it.

- [ ] **Step 3: (defer commit to Task 3 — module incomplete)**

---

### Task 3: `MailcowMailboxProvisioner` (REST adapter)

**Files:**
- Create: `src/mail/mailcow-provisioner.ts`

- [ ] **Step 1: Write the adapter**

Create `src/mail/mailcow-provisioner.ts`:

```ts
import type {
  MailboxProvisioner,
  ProvisionResult,
} from "./provisioner";

/* Mailcow REST admin adapter. Endpoints:
   GET  /api/v1/get/domain/<domain>
   POST /api/v1/add/domain
   POST /api/v1/add/mailbox
   POST /api/v1/delete/mailbox
   Auth: header `X-API-Key`. Mailcow returns an array of
   {type:"success"|"danger"|"error", msg:...} objects. */
export class MailcowMailboxProvisioner implements MailboxProvisioner {
  readonly label = "Mailcow";
  readonly live = true;
  private readonly base: string;
  private readonly apiKey: string;

  constructor(opts: { url: string; apiKey: string }) {
    this.base = opts.url.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
  }

  private async call(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<{ ok: boolean; detail: string }> {
    try {
      const res = await fetch(`${this.base}/api/v1${path}`, {
        method,
        headers: {
          "X-API-Key": this.apiKey,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      if (!res.ok) return { ok: false, detail: `HTTP ${res.status}: ${text}` };
      // add/* endpoints return an array of result objects.
      try {
        const parsed = JSON.parse(text) as unknown;
        if (Array.isArray(parsed)) {
          const bad = parsed.find(
            (r) =>
              typeof r === "object" &&
              r !== null &&
              "type" in r &&
              (r as { type: string }).type !== "success",
          );
          if (bad)
            return { ok: false, detail: JSON.stringify(bad) };
        }
      } catch {
        /* non-JSON success (e.g. get/domain) — treat as ok */
      }
      return { ok: true, detail: text };
    } catch (err) {
      return {
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async ensureDomain(domain: string): Promise<ProvisionResult> {
    const got = await this.call("GET", `/get/domain/${encodeURIComponent(domain)}`);
    // Mailcow returns {} or [] when the domain is absent; a present
    // domain returns an object with domain_name. Re-adding an existing
    // domain is a harmless "danger: domain exists", so just attempt add
    // and treat "exists" as success.
    if (got.ok && got.detail.includes(`"domain_name"`)) return { ok: true };
    const add = await this.call("POST", "/add/domain", {
      domain,
      active: "1",
      restart_sogo: "0",
    });
    if (add.ok) return { ok: true };
    if (add.detail.includes("domain_exists") || add.detail.includes("exists"))
      return { ok: true };
    return { error: `ensureDomain failed: ${add.detail}` };
  }

  async createMailbox(input: {
    address: string;
    password: string;
    quotaMb: number;
    displayName?: string;
  }): Promise<ProvisionResult> {
    const [local, domain] = input.address.split("@");
    if (!local || !domain)
      return { error: `invalid address: ${input.address}` };
    const res = await this.call("POST", "/add/mailbox", {
      local_part: local,
      domain,
      name: input.displayName ?? local,
      password: input.password,
      password2: input.password,
      quota: String(input.quotaMb),
      active: "1",
    });
    return res.ok ? { ok: true } : { error: `createMailbox failed: ${res.detail}` };
  }

  async deleteMailbox(address: string): Promise<ProvisionResult> {
    const res = await this.call("POST", "/delete/mailbox", [address]);
    return res.ok ? { ok: true } : { error: `deleteMailbox failed: ${res.detail}` };
  }
}
```

- [ ] **Step 2: Verify compile**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/mail/provisioner.ts src/mail/mailcow-provisioner.ts
git commit -m "feat(mail): add MailboxProvisioner port + Mailcow REST adapter"
```

---

### Task 4: Seed the Platform project

**Files:**
- Create: `src/domain/seed-platform.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write the idempotent seed**

Create `src/domain/seed-platform.ts`:

```ts
import type { Store } from "./store";

export const PLATFORM_PROJECT_ID = "proj_platform";
export const PLATFORM_DOMAIN = "cantila.app";

/** Ensures a single hidden "Platform" project exists under the owner
 *  account, owning cantila.app. Idempotent — safe to run every boot.
 *  Mirrors the seed-owner.ts pattern. Requires CANTILA_OWNER_ACCOUNT_ID
 *  (the owner account, e.g. acc_cantila). No-op if unset. */
export async function seedPlatformProject(store: Store): Promise<void> {
  const accountId = process.env.CANTILA_OWNER_ACCOUNT_ID;
  if (!accountId) return;
  const existing = await store.getProject(PLATFORM_PROJECT_ID);
  if (existing) return;
  await store.createProject({
    id: PLATFORM_PROJECT_ID,
    accountId,
    name: "Platform",
    platform: true,
    // Remaining required Project fields use the same defaults
    // store.createProject already applies for tenant projects.
  } as Parameters<Store["createProject"]>[0]);
}
```

> NOTE for implementer: open `src/domain/store.ts`, read the exact `createProject` input type, and fill any other REQUIRED fields (e.g. `createdAt`, `status`, `region`) with the same defaults the normal project-create path uses. Do not invent fields.

- [ ] **Step 2: Call it at boot**

In `src/index.ts`, after the store is constructed and any existing seed (e.g. `seedOwner`) runs, add:

```ts
import { seedPlatformProject } from "./domain/seed-platform";
// ...after store init / other seeds:
await seedPlatformProject(store);
```

- [ ] **Step 3: Verify compile**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/domain/seed-platform.ts src/index.ts
git commit -m "feat(mail): seed hidden Platform project for cantila.app"
```

---

### Task 5: Provision in `createHostedMailbox`

**Files:**
- Modify: `src/core/control-plane.ts` (`createHostedMailbox`, ~line 6377; deps)
- Modify: `src/domain/types.ts` (create-result type)

- [ ] **Step 1: Extend the create-result type**

In `src/domain/types.ts`, where `HostedMailbox` is defined, add a return shape (or reuse inline). Add:

```ts
/** createHostedMailbox success carries the one-time generated
 *  password for platform mailboxes. Never persisted. */
export type CreatedHostedMailbox = HostedMailbox & {
  oneTimePassword?: string;
};
```

- [ ] **Step 2: Inject the provisioner into ControlPlane deps**

In `src/core/control-plane.ts`, add `mailboxProvisioner` to the `deps` the class reads. Find where other singletons (`mailProvider`) are imported/used and import:

```ts
import { mailboxProvisioner } from "../mail/provisioner";
```

(Use the singleton directly, mirroring how `mailProvider` is referenced in this file.)

- [ ] **Step 3: Generate password + provision (platform only)**

Replace the body of `createHostedMailbox` (lines ~6377-6411) with:

```ts
  async createHostedMailbox(input: {
    projectId: string;
    address: string;
    displayName?: string;
    kind?: MailboxKind;
    quotaMb?: number;
  }): Promise<CreatedHostedMailbox | { error: string }> {
    const project = await this.deps.store.getProject(input.projectId);
    if (!project) return { error: "project not found" };
    const address = input.address.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) {
      return { error: "a valid email address is required" };
    }
    // Platform mailboxes must be on the platform domain.
    if (project.platform && !address.endsWith("@cantila.app")) {
      return { error: "platform mailboxes must be @cantila.app" };
    }
    const taken = await this.deps.store.findHostedMailboxByAddress(address);
    if (taken) return { error: "mailbox address already taken" };

    const quotaMb = input.quotaMb ?? 10240;
    let oneTimePassword: string | undefined;

    // Provision in Mailcow ONLY for platform-project mailboxes.
    if (project.platform) {
      oneTimePassword = generateMailboxPassword();
      const dom = await mailboxProvisioner.ensureDomain("cantila.app");
      if ("error" in dom) return { error: dom.error };
      const made = await mailboxProvisioner.createMailbox({
        address,
        password: oneTimePassword,
        quotaMb,
        displayName: input.displayName?.trim() || address.split("@")[0],
      });
      if ("error" in made) return { error: made.error };
    }

    const mailbox = await this.deps.store.createHostedMailbox({
      id: id("mbx"),
      projectId: project.id,
      address,
      displayName: input.displayName?.trim() || address.split("@")[0],
      kind: input.kind ?? "personal",
      quotaMb,
      usedMb: 0,
      status: "active",
      createdAt: now(),
    });
    await this.recordEvent(
      project.accountId,
      "config",
      `Mailbox ${mailbox.address} created on ${project.name}`,
      `${mailbox.kind} · ${mailbox.quotaMb} MB quota`,
      project.id,
    );
    return { ...mailbox, oneTimePassword };
  }
```

- [ ] **Step 4: Add the password generator**

In `src/core/control-plane.ts` (near other helpers) or import from `src/auth/tokens.ts` if it exposes a CSPRNG string helper. If adding locally:

```ts
import { randomBytes } from "node:crypto";

/** 24-char URL-safe password for provisioned mailboxes. */
function generateMailboxPassword(): string {
  return randomBytes(18).toString("base64url");
}
```

> NOTE: check `src/auth/tokens.ts` first — if it already exports a secure random-string helper, import and reuse it (DRY) instead of adding `generateMailboxPassword`.

- [ ] **Step 5: Verify compile**

Run: `npx tsc --noEmit`
Expected: PASS. (Fix any caller of `createHostedMailbox` that now needs the widened return type — the route handler in `src/index.ts` should pass `oneTimePassword` through in its JSON response.)

- [ ] **Step 6: Surface `oneTimePassword` in the route**

In `src/index.ts`, find the `POST` route that calls `cp.createHostedMailbox` and ensure the JSON reply includes `oneTimePassword` when present (it will, if the handler returns the result object directly). Confirm no field is stripped.

- [ ] **Step 7: Commit**

```bash
git add src/core/control-plane.ts src/domain/types.ts src/index.ts
git commit -m "feat(mail): provision platform mailboxes in Mailcow on create"
```

---

### Task 6: Offline smoke test

**Files:**
- Create: `scripts/smoke-platform-mailbox.ts`

- [ ] **Step 1: Write the smoke script**

Create `scripts/smoke-platform-mailbox.ts`:

```ts
/* Platform-mailbox smoke (offline, stub provisioner).
   Run: npx tsx scripts/smoke-platform-mailbox.ts
   Exits 0 on success, 1 on first failed assertion. */

import { ControlPlane } from "../src/core/control-plane";
import { InMemoryStore } from "../src/domain/store";
import { PLATFORM_PROJECT_ID } from "../src/domain/seed-platform";

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
}

async function main() {
  const store = new InMemoryStore();
  // Minimal account + platform project (mirror store.createAccount/Project signatures).
  const account = await store.createAccount({ /* fill per InMemoryStore.createAccount */ } as any);
  await store.createProject({
    id: PLATFORM_PROJECT_ID,
    accountId: account.id,
    name: "Platform",
    platform: true,
  } as any);

  const cp = new ControlPlane({ store } as any); // fill required deps as the constructor needs

  // 1. cantila.app mailbox on platform project → success + oneTimePassword
  const ok = await cp.createHostedMailbox({
    projectId: PLATFORM_PROJECT_ID,
    address: "info@cantila.app",
  });
  assert(!("error" in ok), "info@cantila.app should create");
  assert("oneTimePassword" in ok && (ok as any).oneTimePassword, "should return oneTimePassword");

  // 2. non-cantila.app on platform project → rejected
  const bad = await cp.createHostedMailbox({
    projectId: PLATFORM_PROJECT_ID,
    address: "x@example.com",
  });
  assert("error" in bad, "non-cantila.app on platform project should be rejected");

  // 3. duplicate → rejected
  const dup = await cp.createHostedMailbox({
    projectId: PLATFORM_PROJECT_ID,
    address: "info@cantila.app",
  });
  assert("error" in dup, "duplicate address should be rejected");

  console.log("PASS: platform-mailbox smoke");
}

main();
```

> NOTE for implementer: open `src/core/control-plane.ts` constructor and `src/domain/store.ts` `createAccount`/`createProject` to fill the `as any` placeholders with the real required fields. The existing `scripts/smoke-cantilapay-phase-0.ts` shows how this repo constructs `InMemoryStore` + `ControlPlane` for smoke — copy its setup.

- [ ] **Step 2: Run it — expect PASS**

Run: `npx tsx scripts/smoke-platform-mailbox.ts`
Expected: `PASS: platform-mailbox smoke` and exit 0.

- [ ] **Step 3: Commit**

```bash
git add scripts/smoke-platform-mailbox.ts
git commit -m "test(mail): offline smoke for platform mailbox provisioning"
```

---

### Task 7: Console API type

**Files:**
- Modify: `cantila-console/src/lib/api.ts`

- [ ] **Step 1: Widen the create response type**

In `src/lib/api.ts`, find `createHostedMailbox` and the type it returns (an `ApiHostedMailbox`). Add `oneTimePassword?: string` to the response type the method resolves to (either widen the return or add to `ApiHostedMailbox` as optional). Example:

```ts
  createHostedMailbox(
    projectId: string,
    body: { address: string; displayName?: string; kind?: string; quotaMb?: number },
  ): Promise<ApiHostedMailbox & { oneTimePassword?: string }> {
    return this.post(`/v1/projects/${projectId}/mailboxes`, body);
  }
```

> NOTE: match the existing method's exact path and `post` helper — do not change the URL, only the return type.

- [ ] **Step 2: Verify compile**

Run (in `cantila-console`): `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/api.ts
git commit -m "feat(mail): expose oneTimePassword on createHostedMailbox response"
```

---

### Task 8: Console modal — owner platform path + one-time-password panel

**Files:**
- Modify: `cantila-console/src/components/MailboxesView.tsx`

- [ ] **Step 1: Import the owner hook + add state**

At the top of `MailboxesView.tsx` add:

```ts
import { useIsOwner } from "@/lib/owner";
```

Inside the component, add:

```ts
  const isOwner = useIsOwner();
  const [oneTimePassword, setOneTimePassword] = useState<string | null>(null);
  const [createdAddress, setCreatedAddress] = useState<string | null>(null);
```

- [ ] **Step 2: Owner platform create path**

Add a handler that creates an `@cantila.app` mailbox on the Platform project. Since the Console doesn't know the platform project id, call the same `createHostedMailbox` with a sentinel the control plane resolves — OR fetch it. Simplest: add `platform: true` create via a dedicated address (the control plane already validates). Use the known id constant:

```ts
  const PLATFORM_PROJECT_ID = "proj_platform";

  async function createPlatformMailbox(localPart: string) {
    if (creating) return;
    setCreating(true);
    setError(null);
    try {
      const res = await api.createHostedMailbox(PLATFORM_PROJECT_ID, {
        address: `${localPart.trim().toLowerCase()}@cantila.app`,
        quotaMb: form.quotaMb,
      });
      if (res.oneTimePassword) {
        setOneTimePassword(res.oneTimePassword);
        setCreatedAddress(`${localPart.trim().toLowerCase()}@cantila.app`);
      } else {
        setModalOpen(false);
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create mailbox");
    } finally {
      setCreating(false);
    }
  }
```

- [ ] **Step 3: Render the owner path + suffix input in the modal**

In the modal body, when `isOwner` and the user chose the platform path, render a local-part input with a fixed suffix:

```tsx
  <Field label="Address">
    <div className="flex items-center">
      <input
        className={inputClass}
        placeholder="info"
        value={form.address}
        onChange={(e) => setForm({ ...form, address: e.target.value })}
      />
      <span className="ml-2 text-2xs text-ink-faint">@cantila.app</span>
    </div>
  </Field>
```

Wire the modal's submit to `createPlatformMailbox(form.address)` for the owner platform path; keep `createMailbox()` for the tenant path. Enable the "New mailbox" button for owners even when `projects.length === 0`:

```tsx
  disabled={liveMode !== true || (!isOwner && projects.length === 0)}
```

- [ ] **Step 4: One-time-password panel**

When `oneTimePassword` is set, render (in the modal, replacing the form):

```tsx
  {oneTimePassword ? (
    <div className="space-y-3">
      <p className="text-sm font-medium text-ink">
        Mailbox {createdAddress} created
      </p>
      <p className="text-2xs text-ink-faint">
        Copy this password now — it will not be shown again.
      </p>
      <div className="flex items-center gap-2">
        <code className="flex-1 rounded-md bg-surface-2 px-3 py-2 font-mono text-2xs text-ink">
          {oneTimePassword}
        </code>
        <Button
          onClick={() => navigator.clipboard?.writeText(oneTimePassword)}
        >
          Copy
        </Button>
      </div>
      <Button
        onClick={() => {
          setOneTimePassword(null);
          setCreatedAddress(null);
          setModalOpen(false);
        }}
      >
        Done
      </Button>
    </div>
  ) : (
    /* existing form JSX */
  )}
```

- [ ] **Step 5: Verify compile + lint**

Run (in `cantila-console`): `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/MailboxesView.tsx
git commit -m "feat(mail): owner can create cantila.app mailboxes from the modal"
```

---

### Task 9: Full verification

- [ ] **Step 1: control-plane typecheck + smoke**

Run: `cd cantila-control-plane && npx tsc --noEmit && npx tsx scripts/smoke-platform-mailbox.ts`
Expected: typecheck clean; `PASS: platform-mailbox smoke`.

- [ ] **Step 2: console typecheck**

Run: `cd cantila-console && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Live wiring (operator)**

Mint a read-write Mailcow API key (Mailcow UI → Configuration → Access → API), IP-restrict to the control-plane host. Set on the control-plane container:
`MAILCOW_URL=https://mail.cantila.app` (or `https://178.105.152.116` until DNS/TLS land) and `MAILCOW_API_KEY=<key>` and `CANTILA_OWNER_ACCOUNT_ID=acc_cantila`. Redeploy. Then create `info@cantila.app` from the Console modal and verify it appears in Mailcow + can log in to webmail.

## Self-Review

- **Spec coverage:** A (ports) → Tasks 2,3. B (platform project) → Tasks 1,4. C (modal owner path + OTP panel) → Tasks 7,8. D (flow/password/errors) → Task 5. E (info@) → Task 9 Step 3. F (operational dep) → Task 9 Step 3. G (testing) → Tasks 6,9. All covered.
- **Placeholder scan:** Remaining `as any`/"fill per…" appear only in the smoke script and seed, each with an explicit NOTE telling the implementer to read the real signature in a named file (the repo's exact `createProject`/`ControlPlane` ctor shapes aren't quoted here to avoid guessing fields). These are deliberate read-the-source pointers, not lazy placeholders.
- **Type consistency:** `MailboxProvisioner`/`ProvisionResult` used identically across Tasks 2,3,5. `CreatedHostedMailbox`/`oneTimePassword` consistent across Tasks 5,7,8. `PLATFORM_PROJECT_ID` constant shared (control-plane Task 4, referenced again in Console Task 8 as a literal — note: keep both in sync; if it ever changes, update both).
