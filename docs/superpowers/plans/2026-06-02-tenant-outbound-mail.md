# Tenant Outbound Mail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a tenant project send real email as its own `info@<slug>.cantila.app` by actually provisioning a Mailcow mailbox at deploy time and authenticating sends with that mailbox's own credentials.

**Architecture:** The data-plane `createMailbox` seam (today record-only) gains a live implementation backed by the Mailcow REST provisioner; the `MailProvider` send port gains optional per-mailbox SMTP auth; stored passwords are encrypted at rest; a boot backfill re-provisions legacy tenant mailboxes. Deliverability rides one-time wildcard DNS (`*.cantila.app` MX + SPF) under the existing `p=none` DMARC.

**Tech Stack:** TypeScript (Node 20, CommonJS), Fastify control plane, nodemailer SMTP, Mailcow REST API, `node:test` runner, Prisma/in-memory store.

**Spec:** [docs/superpowers/specs/2026-06-02-tenant-outbound-mail-design.md](../specs/2026-06-02-tenant-outbound-mail-design.md)

**Branch:** `feat/tenant-outbound-mail` (already created from `origin/master`).

**Run tests with:** `node --import tsx --test "src/**/*.test.ts"` (single file: `node --import tsx --test src/path/file.test.ts`). Typecheck: `npx tsc --noEmit`.

---

## File Structure

- **Modify** `src/mail/default-mailbox.ts` — fix `smtpHost` to the real MTA (`mail.cantila.app`).
- **Modify** `src/mail/provider.ts` — add optional `auth` to `SendMailInput`.
- **Modify** `src/mail/mailcow-mail-provider.ts` — per-mailbox transport selection + factory wiring.
- **Create** `src/mail/mailbox-service-provisioner.ts` — `ServiceProvisioner`-shaped `createMailbox` backed by the live Mailcow provisioner; env-gated factory.
- **Modify** `src/dataplane/coolify-provisioner.ts` — `selectProvisioner` injects the live mailbox provisioner.
- **Modify** `src/deploy/provisioning.ts` — encrypt `smtpPassword` at store, inject plaintext into the product env.
- **Modify** `src/core/control-plane.ts` — `cp.sendMail` passes decrypted per-mailbox auth.
- **Create** `src/domain/backfill-mailboxes.ts` — idempotent boot backfill of legacy tenant mailboxes.
- **Modify** `src/index.ts` — call the backfill at boot before `reconcileProjectMailboxes`.
- **Tests** alongside each (`*.test.ts`).

---

## Task 1: Point the default mailbox at the real MTA

**Files:**
- Modify: `src/mail/default-mailbox.ts:29`
- Test: `src/mail/default-mailbox.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `src/mail/default-mailbox.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";

import { defaultProjectMailbox } from "./default-mailbox";

test("default mailbox points at the real MTA host", () => {
  const mb = defaultProjectMailbox("acme");
  assert.equal(mb.address, "info@acme.cantila.app");
  assert.equal(mb.sendingDomain, "acme.cantila.app");
  assert.equal(mb.smtpUser, "info@acme.cantila.app");
  // smtp.cantila.app resolves to the APP server, not the MTA — must be mail.cantila.app.
  assert.equal(mb.smtpHost, "mail.cantila.app");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test src/mail/default-mailbox.test.ts`
Expected: FAIL — `smtpHost` is `"smtp.cantila.app"`, expected `"mail.cantila.app"`.

- [ ] **Step 3: Make the change**

In `src/mail/default-mailbox.ts`, change the `smtpHost` line in `defaultProjectMailbox`:

```typescript
  return {
    address,
    sendingDomain,
    smtpHost: "mail.cantila.app",
    // SMTP submission authenticates with the full mailbox address —
    // the convention real MTAs (Mailcow) expect.
    smtpUser: address,
  };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test src/mail/default-mailbox.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite (guard against host-string assumptions elsewhere)**

Run: `node --import tsx --test "src/**/*.test.ts"`
Expected: all pass. If a test asserted `smtp.cantila.app`, update it to `mail.cantila.app`.

- [ ] **Step 6: Commit**

```bash
git add src/mail/default-mailbox.ts src/mail/default-mailbox.test.ts
git commit -m "fix(mail): default mailbox smtpHost -> mail.cantila.app (real MTA)"
```

---

## Task 2: Per-mailbox SMTP auth on the MailProvider port

**Files:**
- Modify: `src/mail/provider.ts:48-72` (add `auth` to `SendMailInput`)
- Modify: `src/mail/mailcow-mail-provider.ts` (transport selection + factory)
- Test: `src/mail/mailcow-mail-provider.test.ts` (extend)

- [ ] **Step 1: Write the failing tests**

Append to `src/mail/mailcow-mail-provider.test.ts`:

```typescript
test("sendMail uses a per-mailbox transport when auth is provided", async () => {
  const seen: Array<{ user: string; msgFrom: string }> = [];
  const p = new MailcowMailProvider({
    transport: { sendMail: async () => ({ messageId: "env" }) },
    makeTransport: (auth) => ({
      sendMail: async (m) => {
        seen.push({ user: auth.user, msgFrom: m.from });
        return { messageId: `per:${auth.user}` };
      },
    }),
  });
  const res = await p.sendMail({
    from: "info@acme.cantila.app",
    to: "x@y.com",
    subject: "S",
    body: "B",
    auth: { host: "mail.cantila.app", user: "info@acme.cantila.app", pass: "pw" },
  });
  assert.equal(res.accepted, true);
  assert.equal(res.providerMessageId, "per:info@acme.cantila.app");
  assert.deepEqual(seen, [
    { user: "info@acme.cantila.app", msgFrom: "info@acme.cantila.app" },
  ]);
});

test("sendMail falls back to the env transport when no auth is given", async () => {
  let used = "";
  const p = new MailcowMailProvider({
    transport: {
      sendMail: async () => {
        used = "env";
        return { messageId: "env" };
      },
    },
    makeTransport: () => ({
      sendMail: async () => {
        used = "per";
        return { messageId: "per" };
      },
    }),
  });
  await p.sendMail({ from: "noreply@cantila.app", to: "x@y.com" });
  assert.equal(used, "env");
});

test("per-mailbox transports are cached by user", async () => {
  let builds = 0;
  const p = new MailcowMailProvider({
    transport: { sendMail: async () => ({ messageId: "env" }) },
    makeTransport: () => {
      builds++;
      return { sendMail: async () => ({ messageId: "m" }) };
    },
  });
  const auth = { host: "mail.cantila.app", user: "info@acme.cantila.app", pass: "pw" };
  await p.sendMail({ from: "info@acme.cantila.app", to: "a@b.com", auth });
  await p.sendMail({ from: "info@acme.cantila.app", to: "c@d.com", auth });
  assert.equal(builds, 1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test src/mail/mailcow-mail-provider.test.ts`
Expected: FAIL — `MailcowMailProvider` constructor ignores `makeTransport`; `SendMailInput` has no `auth`.

- [ ] **Step 3: Add `auth` to `SendMailInput`**

In `src/mail/provider.ts`, inside `interface SendMailInput` (after the `outcomeBias` field, before the closing brace at line ~72):

```typescript
  /** Optional per-mailbox SMTP submission credentials. When set, a live
   *  provider authenticates as THIS mailbox (so `from` matches the login
   *  and passes the MTA's sender-check) instead of the shared platform
   *  submission account. The control plane passes the tenant project's
   *  own mailbox creds here (decrypted at call time). */
  auth?: {
    host: string;
    user: string;
    pass: string;
    port?: number;
    secure?: boolean;
  };
```

- [ ] **Step 4: Rework `MailcowMailProvider` for transport selection**

Replace the class fields, constructor, and `sendMail` in `src/mail/mailcow-mail-provider.ts`. Keep `parseInbound` / `parseStatusUpdate` unchanged. The new constructor accepts an optional `makeTransport` factory and the class caches per-user transports:

```typescript
export class MailcowMailProvider implements MailProvider {
  readonly label = "Mailcow";
  readonly live = true;
  private readonly transport: MailcowSmtpTransport;
  private readonly makeTransport?: (auth: {
    host: string;
    user: string;
    pass: string;
    port?: number;
    secure?: boolean;
  }) => MailcowSmtpTransport;
  private readonly perMailbox = new Map<string, MailcowSmtpTransport>();
  private seq = 9000;

  constructor(opts: {
    transport: MailcowSmtpTransport;
    makeTransport?: (auth: {
      host: string;
      user: string;
      pass: string;
      port?: number;
      secure?: boolean;
    }) => MailcowSmtpTransport;
  }) {
    this.transport = opts.transport;
    this.makeTransport = opts.makeTransport;
  }

  private nextId(): string {
    this.seq += 1;
    return `mmsg_${this.seq.toString(36)}`;
  }

  /** Resolve the transport for a send: a cached/freshly-built per-mailbox
   *  transport when `auth` is present and a factory is wired, else the
   *  default (platform submission) transport. */
  private transportFor(input: SendMailInput): MailcowSmtpTransport {
    if (input.auth && this.makeTransport) {
      const cached = this.perMailbox.get(input.auth.user);
      if (cached) return cached;
      const built = this.makeTransport(input.auth);
      this.perMailbox.set(input.auth.user, built);
      return built;
    }
    return this.transport;
  }

  async sendMail(input: SendMailInput): Promise<SendResult> {
    try {
      const info = await this.transportFor(input).sendMail({
        from: input.from,
        to: input.to,
        subject: input.subject,
        text: input.body,
      });
      return { providerMessageId: info.messageId || this.nextId(), accepted: true };
    } catch {
      return { providerMessageId: "", accepted: false };
    }
  }
```

Note: `SendMailInput` is already imported in this file. Leave the existing `parseInbound`, `parseStatusUpdate`, `parseJson`, `makeNodemailerTransport`, and `SendResult` type as-is.

- [ ] **Step 5: Wire `makeTransport` into the factory**

In `src/mail/mailcow-mail-provider.ts`, update `createMailcowMailProvider`'s `return new MailcowMailProvider({...})` to also pass a `makeTransport` that builds a nodemailer transport from per-mailbox creds:

```typescript
  return new MailcowMailProvider({
    transport: makeNodemailerTransport({ host, port, secure, user, pass }),
    makeTransport: (auth) =>
      makeNodemailerTransport({
        host: auth.host,
        port: auth.port ?? 587,
        secure: auth.secure ?? (auth.port === 465),
        user: auth.user,
        pass: auth.pass,
      }),
  });
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --import tsx --test src/mail/mailcow-mail-provider.test.ts`
Expected: PASS (all cases, including the three new ones).

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/mail/provider.ts src/mail/mailcow-mail-provider.ts src/mail/mailcow-mail-provider.test.ts
git commit -m "feat(mail): per-mailbox SMTP auth on MailProvider send port"
```

---

## Task 3: `cp.sendMail` passes the project mailbox's own auth

**Files:**
- Modify: `src/core/control-plane.ts:1497-1504` (the `mailProvider.sendMail({...})` call)
- Test: `src/core/send-mail-auth.test.ts` (create)

**Context:** `decryptSecret` is already imported in `control-plane.ts` (line 102). A plaintext stored password (no `enc.v1.` prefix) passes through `decryptSecret` unchanged, so this is safe for both encrypted and legacy rows.

- [ ] **Step 1: Write the failing test**

Create `src/core/send-mail-auth.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";

import { ControlPlane } from "./control-plane";
import { InMemoryStore } from "../domain/store";
import { stubProvisioner, stubDataPlane } from "../dataplane/stub";

// A MailProvider spy that captures the SendMailInput it receives.
function makeDeps(captured: { input?: unknown }) {
  const store = new InMemoryStore();
  return {
    store,
    cp: new ControlPlane({
      store,
      provisioner: stubProvisioner,
      dataPlane: stubDataPlane,
    }),
  };
}

test("cp.sendMail forwards the project mailbox's own SMTP auth", async () => {
  const store = new InMemoryStore();
  const cp = new ControlPlane({ store, provisioner: stubProvisioner, dataPlane: stubDataPlane });

  // Seed an account + project + mailbox directly in the store.
  const account = await store.createAccount({ id: "acc_1", name: "A", createdAt: new Date().toISOString() });
  const project = await store.createProject({
    id: "prj_1", accountId: account.id, name: "Acme", slug: "acme",
    region: "eu", status: "live", createdAt: new Date().toISOString(),
  } as any);
  await store.createMailbox({
    id: "mbx_1", projectId: project.id,
    address: "info@acme.cantila.app", sendingDomain: "acme.cantila.app",
    smtpHost: "mail.cantila.app", smtpUser: "info@acme.cantila.app",
    smtpPassword: "plain-pw", status: "active", createdAt: new Date().toISOString(),
  } as any);

  // Swap the bundled mailProvider for a spy via the module seam.
  const mod = await import("../mail/provider");
  let seen: any;
  const orig = mod.mailProvider.sendMail;
  (mod.mailProvider as any).sendMail = async (input: any) => {
    seen = input;
    return { providerMessageId: "x", accepted: true };
  };
  try {
    const res = await cp.sendMail(project.id, { to: "z@ext.com", subject: "S", body: "B" });
    assert.ok(!("error" in res), `unexpected error: ${JSON.stringify(res)}`);
    assert.deepEqual(seen.auth, {
      host: "mail.cantila.app",
      user: "info@acme.cantila.app",
      pass: "plain-pw",
      port: 587,
    });
    assert.equal(seen.from, "info@acme.cantila.app");
  } finally {
    (mod.mailProvider as any).sendMail = orig;
  }
});
```

> If `InMemoryStore`'s `createAccount` / `createProject` signatures differ, adapt the seed to the store's actual API (check `src/domain/store.ts`) — the assertion on `seen.auth` is the point of the test.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test src/core/send-mail-auth.test.ts`
Expected: FAIL — `seen.auth` is `undefined` (cp.sendMail doesn't pass auth yet).

- [ ] **Step 3: Pass per-mailbox auth from `cp.sendMail`**

In `src/core/control-plane.ts`, in the `sendMail` method, change the `mailProvider.sendMail({...})` call (around line 1497) to add `auth`:

```typescript
    const hand = await mailProvider.sendMail({
      from: mailbox.address,
      to: input.to,
      subject: input.subject,
      body: input.body,
      poolId,
      outcomeBias: input.outcomeBias,
      auth: {
        host: mailbox.smtpHost,
        user: mailbox.smtpUser,
        pass: decryptSecret(mailbox.smtpPassword),
        port: 587,
      },
    });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test src/core/send-mail-auth.test.ts`
Expected: PASS.

- [ ] **Step 5: Run full suite + typecheck**

Run: `node --import tsx --test "src/**/*.test.ts"` then `npx tsc --noEmit`
Expected: all pass, tsc exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/core/control-plane.ts src/core/send-mail-auth.test.ts
git commit -m "feat(mail): cp.sendMail authenticates as the project mailbox"
```

---

## Task 4: Live mailbox `ServiceProvisioner` backed by Mailcow

**Files:**
- Create: `src/mail/mailbox-service-provisioner.ts`
- Test: `src/mail/mailbox-service-provisioner.test.ts`

**Context:** `ServiceProvisioner.createMailbox(project)` must return `{address, sendingDomain, smtpHost, smtpUser, smtpPassword}`. The live impl calls `MailboxProvisioner.ensureDomain` + `createMailbox` (the Mailcow REST adapter) and returns the generated password as `smtpPassword`. `randomBytes` is from `node:crypto`.

- [ ] **Step 1: Write the failing test**

Create `src/mail/mailbox-service-provisioner.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";

import { createMailboxServiceProvisioner } from "./mailbox-service-provisioner";
import type { MailboxProvisioner, ProvisionResult } from "./provisioner";

function fakeProvisioner(over: Partial<MailboxProvisioner> = {}): {
  prov: MailboxProvisioner;
  calls: string[];
} {
  const calls: string[] = [];
  const prov: MailboxProvisioner = {
    label: "Fake",
    live: true,
    async ensureDomain(d) { calls.push(`ensureDomain:${d}`); return { ok: true } as ProvisionResult; },
    async createMailbox(i) { calls.push(`createMailbox:${i.address}`); return { ok: true } as ProvisionResult; },
    async deleteMailbox() { return { ok: true } as ProvisionResult; },
    ...over,
  };
  return { prov, calls };
}

const project = { slug: "acme", name: "Acme" } as any;

test("provisions the project's domain + mailbox and returns real creds", async () => {
  const { prov, calls } = fakeProvisioner();
  const svc = createMailboxServiceProvisioner(prov);
  const m = await svc.createMailbox(project);

  assert.equal(m.address, "info@acme.cantila.app");
  assert.equal(m.sendingDomain, "acme.cantila.app");
  assert.equal(m.smtpHost, "mail.cantila.app");
  assert.equal(m.smtpUser, "info@acme.cantila.app");
  assert.ok(m.smtpPassword.length >= 16, "a real password is generated");
  assert.deepEqual(calls, [
    "ensureDomain:acme.cantila.app",
    "createMailbox:info@acme.cantila.app",
  ]);
});

test("ensureDomain failure aborts before creating a mailbox", async () => {
  const { prov, calls } = fakeProvisioner({
    async ensureDomain() { return { error: "boom" }; },
  });
  const svc = createMailboxServiceProvisioner(prov);
  await assert.rejects(() => svc.createMailbox(project), /ensureDomain.*boom/);
  assert.ok(!calls.some((c) => c.startsWith("createMailbox")));
});

test("createMailbox failure rejects (no ghost mailbox row)", async () => {
  const { prov } = fakeProvisioner({
    async createMailbox() { return { error: "exists-bad" }; },
  });
  const svc = createMailboxServiceProvisioner(prov);
  await assert.rejects(() => svc.createMailbox(project), /createMailbox.*exists-bad/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test src/mail/mailbox-service-provisioner.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the module**

Create `src/mail/mailbox-service-provisioner.ts`:

```typescript
/* ============================================================
   Live mailbox creation for the data-plane `ServiceProvisioner`
   seam (plan §4.2 / tenant-outbound-mail spec).

   The stub's `createMailbox` is record-only — it fabricates a
   random password and never creates a real mailbox. This wraps the
   Mailcow REST `MailboxProvisioner` so a tenant project gets a real,
   login-capable `info@<slug>.cantila.app` mailbox at deploy time,
   returning the generated password as `smtpPassword`.

   Env-gated via `createLiveMailboxServiceProvisioner`: returns null
   unless the bundled `mailboxProvisioner` is live (MAILCOW_URL +
   MAILCOW_API_KEY set), so dev/test stay on the stub.
   ============================================================ */

import { randomBytes } from "node:crypto";

import type { Project } from "../domain/types";
import type { ServiceProvisioner } from "../deploy/provisioning";
import { defaultProjectMailbox } from "./default-mailbox";
import { mailboxProvisioner, type MailboxProvisioner } from "./provisioner";

/** Default mailbox quota for an auto-wired tenant mailbox (10 GB). */
const DEFAULT_QUOTA_MB = 10240;

/** Build a `ServiceProvisioner`-shaped object whose `createMailbox`
 *  actually provisions a Mailcow mailbox via `provisioner`. */
export function createMailboxServiceProvisioner(
  provisioner: MailboxProvisioner,
): Pick<ServiceProvisioner, "createMailbox"> {
  return {
    async createMailbox(project: Project) {
      const base = defaultProjectMailbox(project.slug);
      const password = randomBytes(18).toString("base64url");

      const dom = await provisioner.ensureDomain(base.sendingDomain);
      if ("error" in dom) {
        throw new Error(`ensureDomain(${base.sendingDomain}): ${dom.error}`);
      }
      const made = await provisioner.createMailbox({
        address: base.address,
        password,
        quotaMb: DEFAULT_QUOTA_MB,
        displayName: project.name || base.address.split("@")[0],
      });
      if ("error" in made) {
        throw new Error(`createMailbox(${base.address}): ${made.error}`);
      }
      return {
        address: base.address,
        sendingDomain: base.sendingDomain,
        smtpHost: base.smtpHost,
        smtpUser: base.smtpUser,
        smtpPassword: password,
      };
    },
  };
}

/** Env-gated factory — returns the live mailbox createMailbox only when
 *  the bundled Mailcow provisioner is live, else null (caller keeps the
 *  stub). */
export function createLiveMailboxServiceProvisioner():
  | Pick<ServiceProvisioner, "createMailbox">
  | null {
  if (!mailboxProvisioner.live) return null;
  return createMailboxServiceProvisioner(mailboxProvisioner);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test src/mail/mailbox-service-provisioner.test.ts`
Expected: PASS (all three cases).

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc --noEmit` (exit 0), then:

```bash
git add src/mail/mailbox-service-provisioner.ts src/mail/mailbox-service-provisioner.test.ts
git commit -m "feat(mail): live mailbox ServiceProvisioner backed by Mailcow"
```

---

## Task 5: Wire live mailbox provisioning + encrypt at rest

**Files:**
- Modify: `src/dataplane/coolify-provisioner.ts:215-227` (`selectProvisioner`)
- Modify: `src/deploy/provisioning.ts:96-115` (encrypt at store, inject plaintext)
- Test: `src/deploy/provisioning-mailbox.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `src/deploy/provisioning-mailbox.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";

import { provisionProjectServices } from "./provisioning";
import type { ServiceProvisioner } from "./provisioning";
import { InMemoryStore } from "../domain/store";
import { isEncryptedSecret } from "../lib/secrets";

const project = { id: "prj_1", slug: "acme", name: "Acme", region: "eu" } as any;

function provisionerReturning(smtpPassword: string): ServiceProvisioner {
  return {
    async createDatabase() {
      return { engine: "postgres", version: "16", connectionUri: "postgres://x@db:5432/x" };
    },
    async createMailbox() {
      return {
        address: "info@acme.cantila.app",
        sendingDomain: "acme.cantila.app",
        smtpHost: "mail.cantila.app",
        smtpUser: "info@acme.cantila.app",
        smtpPassword,
      };
    },
  };
}

test("stored mailbox password is encrypted; injected SMTP_PASSWORD is plaintext", async () => {
  process.env.CANTILA_SECRET_KEY = "test-master-key-please";
  try {
    const store = new InMemoryStore();
    await provisionProjectServices(store, provisionerReturning("real-secret-pw"), project);

    const mb = await store.getMailboxByProject(project.id);
    assert.ok(mb, "mailbox row exists");
    assert.ok(isEncryptedSecret(mb!.smtpPassword), "stored password is an enc.v1 envelope");

    const env = await store.listEnvVars(project.id);
    const pw = env.find((e) => e.key === "SMTP_PASSWORD");
    assert.equal(pw?.value, "real-secret-pw", "injected env password is plaintext");
    const host = env.find((e) => e.key === "SMTP_HOST");
    assert.equal(host?.value, "mail.cantila.app");
  } finally {
    delete process.env.CANTILA_SECRET_KEY;
  }
});
```

> If `store.listEnvVars` has a different name, use the store's actual env-listing method (check `src/domain/store.ts`).

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test src/deploy/provisioning-mailbox.test.ts`
Expected: FAIL — stored password is plaintext (`isEncryptedSecret` false) because `provisionProjectServices` stores `m.smtpPassword` as-is.

- [ ] **Step 3: Encrypt at store, inject plaintext**

In `src/deploy/provisioning.ts`, add the import at the top (after the existing imports):

```typescript
import { encryptSecret } from "../lib/secrets";
```

Then in the mailbox block (lines ~97-113), store the encrypted password but inject the raw one:

```typescript
    const m = await provisioner.createMailbox(project);
    const mailbox = await store.createMailbox({
      id: id("mbx"),
      projectId: project.id,
      address: m.address,
      sendingDomain: m.sendingDomain,
      smtpHost: m.smtpHost,
      smtpUser: m.smtpUser,
      // Encrypt the credential at rest; the product still gets the raw
      // value below so its own SMTP client can authenticate.
      smtpPassword: encryptSecret(m.smtpPassword),
      status: "active",
      createdAt: now(),
    });
    await inject("SMTP_HOST", mailbox.smtpHost);
    await inject("SMTP_PORT", "587");
    await inject("SMTP_USER", mailbox.smtpUser);
    await inject("SMTP_PASSWORD", m.smtpPassword);
    await inject("MAIL_FROM", mailbox.address);
    mailboxCreated = true;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test src/deploy/provisioning-mailbox.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the live mailbox provisioner into `selectProvisioner`**

In `src/dataplane/coolify-provisioner.ts`, add the import at the top (with the other imports):

```typescript
import { createLiveMailboxServiceProvisioner } from "../mail/mailbox-service-provisioner";
```

Then in `selectProvisioner`, pass the live mailbox provisioner into the Coolify provisioner. Replace the `if (apiUrl && apiToken && serverUuid && projectUuid) { return {...} }` block body:

```typescript
  if (apiUrl && apiToken && serverUuid && projectUuid) {
    const liveMailbox = createLiveMailboxServiceProvisioner();
    return {
      provisioner: new CoolifyServiceProvisioner({
        apiUrl,
        apiToken,
        serverUuid,
        projectUuid,
        environmentName: env.COOLIFY_ENVIRONMENT_NAME?.trim() || undefined,
        // Real Mailcow mailbox creation when MAILCOW_* is set; else the
        // constructor default (stubProvisioner) keeps mail record-only.
        mailbox: liveMailbox
          ? ({ ...stubProvisioner, createMailbox: liveMailbox.createMailbox } as ServiceProvisioner)
          : undefined,
      }),
      live: true,
    };
  }
```

> `stubProvisioner` is already imported in this file; spreading it supplies `createDatabase` (unused by the mailbox delegate) so the object satisfies `ServiceProvisioner`. `CoolifyServiceProvisioner` only ever calls `this.mailbox.createMailbox`.

- [ ] **Step 6: Run full suite + typecheck**

Run: `node --import tsx --test "src/**/*.test.ts"` then `npx tsc --noEmit`
Expected: all pass (including the existing `coolify-provisioner.test.ts` delegation test, which uses the default stub), tsc exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/dataplane/coolify-provisioner.ts src/deploy/provisioning.ts src/deploy/provisioning-mailbox.test.ts
git commit -m "feat(mail): wire live Mailcow mailbox provisioning + encrypt smtpPassword at rest"
```

---

## Task 6: Boot backfill of legacy tenant mailboxes

**Files:**
- Create: `src/domain/backfill-mailboxes.ts`
- Modify: `src/index.ts:4086` (call backfill before reconcile)
- Test: `src/domain/backfill-mailboxes.test.ts`

**Context:** Legacy tenant mailboxes carry a fake password and the old `smtp.cantila.app` host. Detection signal: `smtpHost !== "mail.cantila.app"` (encryption state is NOT a reliable signal — prod has no `CANTILA_SECRET_KEY` yet, so values are plaintext). Backfill must run BEFORE `reconcileProjectMailboxes` (which would otherwise overwrite `smtpHost` to the new default and erase the signal). Platform projects (`project.platform === true`) are skipped — their `cantila.app` mailboxes are already real.

- [ ] **Step 1: Write the failing test**

Create `src/domain/backfill-mailboxes.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";

import { backfillTenantMailboxes } from "./backfill-mailboxes";
import { InMemoryStore } from "./store";
import type { MailboxProvisioner, ProvisionResult } from "../mail/provisioner";

function fakeProvisioner(): { prov: MailboxProvisioner; calls: string[] } {
  const calls: string[] = [];
  const prov: MailboxProvisioner = {
    label: "Fake", live: true,
    async ensureDomain(d) { calls.push(`dom:${d}`); return { ok: true } as ProvisionResult; },
    async createMailbox(i) { calls.push(`mbx:${i.address}`); return { ok: true } as ProvisionResult; },
    async deleteMailbox() { return { ok: true } as ProvisionResult; },
  };
  return { prov, calls };
}

async function seed(store: InMemoryStore, opts: { slug: string; smtpHost: string; platform?: boolean }) {
  const account = await store.createAccount({ id: `acc_${opts.slug}`, name: "A", createdAt: new Date().toISOString() });
  const project = await store.createProject({
    id: `prj_${opts.slug}`, accountId: account.id, name: opts.slug, slug: opts.slug,
    region: "eu", status: "live", platform: opts.platform ?? false, createdAt: new Date().toISOString(),
  } as any);
  await store.createMailbox({
    id: `mbx_${opts.slug}`, projectId: project.id,
    address: `info@${opts.slug}.cantila.app`, sendingDomain: `${opts.slug}.cantila.app`,
    smtpHost: opts.smtpHost, smtpUser: `info@${opts.slug}.cantila.app`,
    smtpPassword: "old-fake-pw", status: "active", createdAt: new Date().toISOString(),
  } as any);
  return project;
}

test("backfill repairs legacy tenant mailboxes once and is idempotent", async () => {
  const store = new InMemoryStore();
  await seed(store, { slug: "legacy", smtpHost: "smtp.cantila.app" });
  const { prov, calls } = fakeProvisioner();

  const r1 = await backfillTenantMailboxes(store, prov);
  assert.equal(r1.repaired, 1);
  const mb = await store.getMailboxByProject("prj_legacy");
  assert.equal(mb!.smtpHost, "mail.cantila.app");
  assert.notEqual(mb!.smtpPassword, "old-fake-pw", "password rotated to the real one");
  assert.deepEqual(calls, ["dom:legacy.cantila.app", "mbx:info@legacy.cantila.app"]);

  const r2 = await backfillTenantMailboxes(store, prov);
  assert.equal(r2.repaired, 0, "second run is a no-op");
});

test("backfill skips already-real and platform mailboxes", async () => {
  const store = new InMemoryStore();
  await seed(store, { slug: "fresh", smtpHost: "mail.cantila.app" });
  await seed(store, { slug: "platform", smtpHost: "smtp.cantila.app", platform: true });
  const { prov } = fakeProvisioner();

  const r = await backfillTenantMailboxes(store, prov);
  assert.equal(r.repaired, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test src/domain/backfill-mailboxes.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the backfill**

Create `src/domain/backfill-mailboxes.ts`:

```typescript
/* ============================================================
   Boot backfill — give legacy tenant projects a REAL Mailcow
   mailbox (tenant-outbound-mail spec §5).

   Projects auto-wired while mailbox creation was record-only carry a
   fabricated password and the old `smtp.cantila.app` host. For each
   such tenant mailbox this provisions the real domain + mailbox in
   Mailcow, rotates the stored password (encrypted at rest), fixes the
   host, and re-injects the project's SMTP_* env so its next deploy
   picks up working credentials.

   Detection signal: `smtpHost !== "mail.cantila.app"`. Idempotent —
   once repaired the host matches and the row is skipped. Must run
   BEFORE `reconcileProjectMailboxes` (which rewrites smtpHost).
   Platform (`project.platform`) mailboxes are already real and skipped.
   ============================================================ */

import type { Store } from "./store";
import type { MailboxProvisioner } from "../mail/provisioner";
import { defaultProjectMailbox } from "../mail/default-mailbox";
import { encryptSecret } from "../lib/secrets";
import { id, now } from "../lib/ids";
import { randomBytes } from "node:crypto";

const REAL_HOST = "mail.cantila.app";
const DEFAULT_QUOTA_MB = 10240;

export async function backfillTenantMailboxes(
  store: Store,
  provisioner: MailboxProvisioner,
): Promise<{ repaired: number; scanned: number }> {
  let repaired = 0;
  let scanned = 0;
  const accounts = await store.listAccounts();
  for (const account of accounts) {
    const projects = await store.listProjects(account.id);
    for (const project of projects) {
      if (project.platform) continue;
      const mb = await store.getMailboxByProject(project.id);
      if (!mb) continue;
      scanned++;
      if (mb.smtpHost === REAL_HOST) continue; // already real

      const base = defaultProjectMailbox(project.slug);
      const password = randomBytes(18).toString("base64url");
      const dom = await provisioner.ensureDomain(base.sendingDomain);
      if ("error" in dom) {
        console.error(`[backfill] ${project.slug}: ensureDomain failed: ${dom.error}`);
        continue;
      }
      const made = await provisioner.createMailbox({
        address: base.address,
        password,
        quotaMb: DEFAULT_QUOTA_MB,
        displayName: project.name || base.address.split("@")[0],
      });
      if ("error" in made) {
        console.error(`[backfill] ${project.slug}: createMailbox failed: ${made.error}`);
        continue;
      }

      await store.updateMailbox(mb.id, {
        address: base.address,
        sendingDomain: base.sendingDomain,
        smtpHost: base.smtpHost,
        smtpUser: base.smtpUser,
        smtpPassword: encryptSecret(password),
      });
      // Re-inject working SMTP_* env (plaintext password) for next deploy.
      const envs: Array<[string, string]> = [
        ["SMTP_HOST", base.smtpHost],
        ["SMTP_PORT", "587"],
        ["SMTP_USER", base.smtpUser],
        ["SMTP_PASSWORD", password],
        ["MAIL_FROM", base.address],
      ];
      for (const [key, value] of envs) {
        await store.upsertEnvVar({
          id: id("env"),
          projectId: project.id,
          key,
          value,
          secret: true,
          scope: "all",
          updatedAt: now(),
        });
      }
      repaired++;
    }
  }
  return { repaired, scanned };
}
```

> Verify `store.updateMailbox` accepts `smtpPassword` in its patch type (it is used by `reconcile-mailboxes.ts` for the other fields). If the patch type omits `smtpPassword`, widen it in `src/domain/store.ts` (and the Prisma store) to include the optional field.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test src/domain/backfill-mailboxes.test.ts`
Expected: PASS (both cases).

- [ ] **Step 5: Call backfill at boot before reconcile**

In `src/index.ts`, add the import near the existing `reconcileProjectMailboxes` import (line ~12):

```typescript
import { backfillTenantMailboxes } from "./domain/backfill-mailboxes";
import { mailboxProvisioner } from "./mail/provisioner";
```

Then, immediately BEFORE the `const mbxReco = await reconcileProjectMailboxes(store);` line (~4086), insert:

```typescript
    if (mailboxProvisioner.live) {
      const bf = await backfillTenantMailboxes(store, mailboxProvisioner);
      console.log(`mailbox backfill: repaired=${bf.repaired}/${bf.scanned}`);
    }
```

> If `mailboxProvisioner` is already imported in `index.ts`, don't duplicate the import.

- [ ] **Step 6: Run full suite + typecheck**

Run: `node --import tsx --test "src/**/*.test.ts"` then `npx tsc --noEmit`
Expected: all pass, tsc exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/domain/backfill-mailboxes.ts src/domain/backfill-mailboxes.test.ts src/index.ts
git commit -m "feat(mail): boot backfill provisions real mailboxes for legacy tenants"
```

---

## Task 7: DNS, deploy, and live verification (ops)

This task has no failing test — it is the rollout. Do it after Tasks 1-6 are merged.

- [ ] **Step 1: Add the one-time wildcard DNS records (Namecheap, cantila.app zone)**

- `*.cantila.app  MX  10  mail.cantila.app`
- `*.cantila.app  TXT  "v=spf1 a:mail.cantila.app -all"`

Verify after propagation:

```bash
# Expect mail.cantila.app as the MX target:
nslookup -type=MX anyslug.cantila.app
# Expect the SPF string:
nslookup -type=TXT anyslug.cantila.app
```

- [ ] **Step 2: Set `CANTILA_SECRET_KEY` in prod (enables encryption-at-rest)**

Prod currently has no `CANTILA_SECRET_KEY`, so `encryptSecret` is pass-through. Set a long random value in Coolify (control-plane app `bd3l9kee90ic661e4rmpzjez`) so new/backfilled `smtpPassword` rows are encrypted (it also protects the existing `anthropicApiKey`). Create-env payload: `{"key":"CANTILA_SECRET_KEY","value":"<48+ random chars>","is_preview":false,"is_literal":false}`.

> Note: decrypt is backward-compatible (plaintext rows pass through), so setting the key does not break existing data.

- [ ] **Step 3: Merge the branch and deploy the control plane**

```bash
git checkout master && git pull origin master
git merge --no-ff feat/tenant-outbound-mail
git push origin master
```

Then trigger a forced redeploy (Coolify): `GET /api/v1/deploy?uuid=bd3l9kee90ic661e4rmpzjez&force=true`. Watch the deployment to `finished` and confirm `GET https://api.cantila.app/v1/health` is 200. Boot logs should show `mailbox backfill: repaired=…/…`.

- [ ] **Step 4: Verify a real tenant send**

Pick a real tenant project id, then (with an owner Bearer token) `POST https://api.cantila.app/v1/projects/<id>/mail/send` with `{ "to": "<an external inbox you control>", "subject": "Cantila tenant send test", "body": "hello" }`. Confirm: the message arrives, and its headers show SPF `pass` aligned to `<slug>.cantila.app` (DMARC pass via SPF). If it lands in spam, capture the Authentication-Results header for follow-up (DKIM hardening is the deferred next step).

- [ ] **Step 5: Confirm the mailbox exists in Mailcow**

```bash
curl -s -H "X-API-Key: <MAILCOW_API_KEY>" "https://mail.cantila.app/api/v1/get/mailbox/info@<slug>.cantila.app"
```

Expect a mailbox object (not an empty array).

---

## Self-Review

**Spec coverage:**
- §1 real provisioning seam → Tasks 1 (host), 4 (live createMailbox), 5 (wiring). ✓
- §2 per-mailbox auth → Tasks 2 (port + provider), 3 (cp.sendMail). ✓
- §3 wildcard DNS → Task 7 Step 1. ✓
- §4 encrypt at rest → Task 5 Step 3 (store), Task 3 (decrypt on send). ✓
- §5 backfill → Task 6. ✓
- Rollout → Task 7. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code. Adaptation notes (store method names, `updateMailbox` patch type) are explicit verification instructions, not placeholders.

**Type consistency:** `SendMailInput.auth` shape (`{host,user,pass,port?,secure?}`) is identical in Task 2 (port), Task 2 (provider `makeTransport`), and Task 3 (cp.sendMail call). `createMailbox` return shape matches `ServiceProvisioner` in Tasks 4-5. `MailboxProvisioner` (`ensureDomain`/`createMailbox`/`deleteMailbox`, `ProvisionResult = {ok:true}|{error}`) used consistently in Tasks 4 and 6. Backfill host signal (`mail.cantila.app`) matches Task 1's new default.

**Risks called out in-plan:** store API name drift (env listing, account/project seed, `updateMailbox` patch) — each step says to adapt to the real signature; the assertions remain the contract.
