# Tenant outbound mail — multi-domain (wildcard model)

**Date:** 2026-06-02
**Status:** Approved (design)
**Scope:** Outbound only. In-app inbound (receiving into the project inbox) is a separate follow-up spec.

## Problem

A tenant project's default mailbox is `info@<slug>.cantila.app` ([default-mailbox.ts](../../../src/mail/default-mailbox.ts)), but it cannot send real email:

1. The data-plane `createMailbox` is **record-only**. `stubProvisioner.createMailbox`
   returns `defaultProjectMailbox(slug)` + a **random** `smtpPassword`
   ([dataplane/stub.ts:24](../../../src/dataplane/stub.ts)); `CoolifyServiceProvisioner`
   just delegates to the stub. No real Mailcow mailbox is ever created.
2. `defaultProjectMailbox()` bakes `smtpHost: "smtp.cantila.app"`, which resolves to the
   **app server** (168.119.97.112), not the MTA (`mail.cantila.app` = 178.105.152.116).
3. The `MailProvider` port carries a single submission credential, so `cp.sendMail` for a
   tenant (from `info@<slug>`) trips Mailcow's per-mailbox sender-check.

Two send paths depend on this:
- **Path 1 — product apps** send directly via injected `SMTP_HOST/PORT/USER/PASSWORD` env
  (their own nodemailer). Needs the injected creds to be real.
- **Path 2 — control-plane** `POST /v1/projects/:id/mail/send` uses `MailProvider`. Needs
  per-mailbox auth.

The platform already serves every tenant site from a single wildcard `*.cantila.app` A
record (→ app server); there is **no per-subdomain DNS automation** anywhere, and we will
not introduce any.

## Goal

A tenant project sends real email **as its own** `info@<slug>.cantila.app` with acceptable
deliverability, using one-time static DNS (wildcard) and no per-project DNS automation.

## Deliverability (verified 2026-06-02)

- Apex SPF: `v=spf1 a:mail.cantila.app -all`.
- DMARC `_dmarc.cantila.app`: `p=none` (monitoring), no `sp=` → subdomains inherit `p=none`,
  so DMARC failures never block delivery.
- Apex DKIM exists (selector `dkim`, 2048-bit).

**Conclusion:** a wildcard SPF TXT for `*.cantila.app` gives subdomain mail an SPF **pass**
that is **relaxed-aligned** to org-domain `cantila.app` → DMARC pass via SPF alone. DKIM for
subdomains is **not required** for delivery and is deferred.

## Components & changes

### 1. Real provisioning seam (fixes Path 1)
- `defaultProjectMailbox()`: `smtpHost` → `mail.cantila.app`.
- Wire the live `MailcowMailboxProvisioner` into the data-plane `createMailbox` path
  (env-gated on `MAILCOW_URL`/`MAILCOW_API_KEY`, already set in prod). When live:
  `ensureDomain(<slug>.cantila.app)` (already hardened to pin `backupmx=0`) +
  `createMailbox(info@<slug>…, generatedPassword)`; return the **real** password +
  `smtpHost=mail.cantila.app`. When env absent → today's stub (offline dev/tests unchanged).
- `createMailbox` must be idempotent: if the Mailcow mailbox already exists, treat as success
  and reuse/rotate per the backfill rule below.

### 2. Per-mailbox auth through the port (fixes Path 2)
- Extend `SendMailInput` with optional `auth?: { host: string; user: string; pass: string; port?: number; secure?: boolean }`.
- `MailcowMailProvider.sendMail`: when `input.auth` is present, send via a transport built
  from those creds (cache transports by `user` to avoid per-message handshakes); else use the
  env submission account (platform `noreply@`, unchanged).
- `cp.sendMail` passes the project mailbox's `{smtpHost, smtpUser, smtpPassword}` as `auth`.
- `SendMailInput.auth.pass` is decrypted from the stored envelope at call time (see §4).

### 3. DNS (one-time, static)
Add once in Namecheap (manual or single API call), then never again:
- `*.cantila.app  MX  10  mail.cantila.app`
- `*.cantila.app  TXT  "v=spf1 a:mail.cantila.app -all"`

### 4. Secret handling
Real mailbox passwords are credentials → store the `Mailbox.smtpPassword` using the existing
`encryptSecret` envelope ([lib/secrets](../../../src/lib/secrets.ts)); decrypt with
`decryptSecret` at send / env-injection time. (The stub stores plaintext today; the live path
encrypts. `isEncryptedSecret` guards mixed rows.)

### 5. Backfill existing tenant projects
A boot reconcile (idempotent), gated on the provisioner being live:
- For each non-platform project mailbox still on the stub scheme (host `smtp.cantila.app` or a
  non-encrypted/placeholder password): `ensureDomain` + provision the real Mailcow mailbox,
  store the encrypted real password, set `smtpHost=mail.cantila.app`, and mark the mailbox so
  the deploy pipeline re-injects `SMTP_*` on the project's next deploy.
- Never touch platform (`cantila.app`) mailboxes (already real).
- Log a count of repaired vs skipped; no silent caps.

## Data flow

```
deploy(project) ─▶ provisioner.createMailbox(project)
                     └─(live)─▶ Mailcow ensureDomain(<slug>.cantila.app)
                               + add/mailbox(info@<slug>…, pw)         ─▶ real mailbox
                     ◀── { address, sendingDomain, smtpHost=mail.cantila.app, smtpUser, smtpPassword(real) }
                   store.createMailbox(...) (smtpPassword encrypted)
                   inject SMTP_HOST/PORT/USER/PASSWORD/MAIL_FROM into product  ─▶ Path 1 works

POST /v1/projects/:id/mail/send ─▶ cp.sendMail
                   reads mailbox, decrypts pw
                   mailProvider.sendMail({ from, to, …, auth:{host,user,pass} })
                     └─▶ per-mailbox SMTP transport ─▶ Mailcow (sender-check passes) ─▶ Path 2 works
```

## Error handling
- Provisioner failure during deploy: surface the error; leave **no** stored mailbox row
  (provision-first, persist-second) so retry is clean.
- Send failure (auth/connect/RCPT): `MailcowMailProvider` returns `accepted:false` →
  `cp.sendMail` returns `{error}` (existing contract).
- Backfill failure for one project: log and continue; do not abort boot.

## Testing (TDD, all offline)
- Data-plane `createMailbox` (live path) calls `ensureDomain` + `add/mailbox` and returns the
  generated password + `mail.cantila.app` host (mocked Mailcow `fetch`).
- Stub path unchanged when env absent.
- `MailcowMailProvider.sendMail` selects the per-mailbox transport when `auth` present, env
  transport otherwise (injected fake transport).
- `cp.sendMail` passes decrypted mailbox creds as `auth`.
- Mailbox `smtpPassword` round-trips through `encryptSecret`/`decryptSecret`.
- Backfill: repairs a stub-scheme mailbox once, is idempotent on a second run, skips platform
  mailboxes.
- Full existing suite stays green.

## Rollout
1. Branch `feat/tenant-outbound-mail` from `origin/master` (done).
2. Implement via TDD; `tsc` + full suite green.
3. Add the two wildcard DNS records.
4. Deploy control-plane; run backfill.
5. Verify a real tenant send (e.g. trigger `/v1/projects/:id/mail/send`) reaches an external
   inbox and passes SPF/DMARC.

## Deferred (out of scope)
- In-app **inbound** for tenant subdomains (Mailcow → webhook or IMAP poll into the project
  inbox). Separate spec.
- Per-subdomain **DKIM** (signing subdomain mail with an aligned `d=`). Optional hardening;
  not needed while DMARC is `p=none` and SPF aligns.
- Custom (non-`cantila.app`) sending domains.

## YAGNI / non-goals
No DNS-record automation, no per-domain DKIM key management, no inbound pipeline, no
multi-region MTA. The wildcard model deliberately mirrors the existing web-subdomain pattern.
