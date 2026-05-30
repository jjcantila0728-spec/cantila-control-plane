# Delete a project (with complete infra teardown) — design

Date: 2026-05-30
Status: approved (design), pending implementation plan
Repos: `cantila-control-plane` (Workstream 1), `cantila-console` (Workstream 2)

## Goal

Let a signed-in user delete a project from the Console `/projects` page, and
make that deletion tear down **everything connected to the project** — the
running app, its subdomain, the managed database, hosted mailboxes, and the
phone number — not just the database records.

## Background / current state

- REST route already exists: `DELETE /v1/projects/:id`
  (`cantila-control-plane/src/index.ts:3779`) → `assertProjectAccess` →
  `cp.deleteProject(id)`; 404 on missing, 200 `{ ok: true, slug }` on success.
- `cp.deleteProject` (`src/core/control-plane.ts:8531`) today:
  - tears down the running app + subdomain via `dataPlane.destroyApp(project)`
    (deletes the Coolify Application, which owns the `*.cantila.app` FQDN),
  - tears down the managed database via `provisioner.destroyDatabase(uri)`,
  - deletes the project record; `store.deleteProject` / Prisma `onDelete:
    Cascade` removes all project-scoped rows (database, mailbox, domains, env,
    deployments, aliases, phone number),
  - records a `system` activity event.
  - **Gap:** it does NOT call the mail provisioner to delete the real Mailcow
    mailbox, nor release the carrier phone number — so those rows vanish but
    the real mailbox/number can be orphaned (a number keeps billing).
- Teardown hooks exist and are safe to call:
  - `mailProvisioner.deleteMailbox(address)` — Mailcow delete; the stub
    provisioner no-ops cleanly (`src/mail/provisioner.ts`,
    `src/mail/mailcow-provisioner.ts:113`).
  - `telephonyProvider.releaseNumber({ providerId })` — already used by
    `deactivateSms` (`src/core/control-plane.ts:2857`); stub no-ops.
- Console side: `api` (in `cantila-console/src/lib/api.ts`) has no
  `deleteProject`; `ProjectsView.tsx` renders live project cards as full-card
  `<Link>`s and has no delete affordance.

## Workstream 1 — Control plane: complete the cascade

Extend `cp.deleteProject` so that, **before** deleting the records (after the
existing `destroyApp` / `destroyDatabase` best-effort calls), it also:

1. **Mailboxes** — look up the project's hosted mailboxes and call
   `mailProvisioner.deleteMailbox(address)` for each. Best-effort: wrap in
   try/catch and swallow, exactly like `destroyApp`/`destroyDatabase`, so a
   stale/already-gone mailbox never blocks project removal.
2. **Phone number** — if the project has a number with a provider id, call
   `telephonyProvider.releaseNumber({ providerId })` (best-effort, swallow).
   This stops carrier billing.

All teardown is env-gated by the same adapter discipline already in the file
(real provider when configured, stub no-op otherwise). The record cascade,
audit event, and return shape (`{ ok: true, slug } | { error }`) are unchanged.

Net effect: deleting a project removes the running **app + subdomain**,
**database**, **mailboxes**, and **phone number** — real infrastructure, not
just rows.

### Tests
Extend `src/core/delete-project.test.ts` to assert, with stub/spy providers,
that deleting a project which has a mailbox and a number invokes
`mailProvisioner.deleteMailbox` (per mailbox) and `telephonyProvider.releaseNumber`
(for the number), and that deletion still succeeds when those calls throw
(best-effort) and when the project has neither (no-op, no crash). Keep the
existing not-found assertion.

## Workstream 2 — Console: the UI

1. **`src/lib/api.ts`** — add:
   ```ts
   deleteProject: (projectId: string) =>
     request<{ ok: true; slug: string }>(
       `/projects/${encodeURIComponent(projectId)}`,
       { method: "DELETE" },
     ),
   ```
   `request()` throws `ApiError` on non-2xx, so a resolved call means success.

2. **`src/components/ProjectsView.tsx`**
   - Show a **kebab (⋯)** control only on **live** cards (`p.live && p.liveId`).
     Render it as an `absolute top-3 right-3 z-10` sibling layered over the card
     `<Link>` (inside a `relative` wrapper) so clicking ⋯ never navigates and we
     avoid nested-anchor issues. Give the card header right padding when live so
     ⋯ doesn't collide with the `StatusBadge`.
   - The ⋯ opens a small popover with one destructive item **"Delete project"**
     (trash icon, `down`/red tokens); closes on outside-click / Escape.
   - Lift delete state to `ProjectsView`: `deleteTarget: DisplayProject | null`.
     The kebab's Delete sets it; a single `Modal` renders at page level.
   - **Type-to-confirm modal** (reusing `Modal`/`Field`/`inputClass`): title
     `Delete <name>?`, a warning that it permanently removes the app, its
     database, domains, mailboxes, and number — cannot be undone; a `Field`
     input that must **exactly equal** `p.name` to enable the red **Delete**
     button (also disabled while the request is in flight). On confirm →
     `await api.deleteProject(p.liveId)` → remove the card from `items`, close,
     clear target; on failure show the error inline in the modal (card stays).
   - Empty state: if the last project is removed, the existing "No projects yet"
     state shows.

## Scope

- **Only live (control-plane) projects** are deletable — offline/mock demo cards
  have no `liveId` and no backend, so they get no kebab.
- **Out of scope** (YAGNI): a Pause action (no endpoint); a Delete control in
  the workspace Settings danger-zone (separate surface — possible follow-up now
  that the endpoint exists); releasing account-level marketplace numbers that
  are not bound to the project.

## Shipping

Two services change, so going live is **two prod deploys, control plane first**
(so the Console's button hits the hardened cascade):
1. `cantila-control-plane` → `api.cantila.app` (Coolify app `bd3l9kee…`, branch `master`)
2. `cantila-console` → `console.cantila.app` (Coolify app `jsyg2k7i…`, branch `main`)

## Verification

- Control plane: `npm test` (delete-project.test.ts incl. new teardown
  assertions) green; build clean.
- Console: `npx tsc --noEmit`, `npm run lint`, `npm run build` clean.
- Manual (post-deploy, signed in): on `/projects`, ⋯ → Delete → type the exact
  name → card disappears; re-list confirms the project is gone; the subdomain no
  longer resolves and (where providers are live) the mailbox/number are gone. A
  mismatched name keeps the Delete button disabled.
