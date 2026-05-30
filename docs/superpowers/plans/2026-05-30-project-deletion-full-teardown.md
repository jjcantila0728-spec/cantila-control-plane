# Delete a project (with complete infra teardown) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a signed-in user delete a project from the Console `/projects` page, and make that deletion tear down everything connected to it — app + subdomain, database, mailboxes, and phone number — not just the records.

**Architecture:** Two repos. (1) `cantila-control-plane`: harden `cp.deleteProject` to also tear down real mailboxes (`mailboxProvisioner.deleteMailbox`) and release the carrier number (`this.deactivateSms`), best-effort, before the existing record cascade. (2) `cantila-console`: add `api.deleteProject` and a kebab → type-to-confirm delete affordance on live project cards.

**Tech Stack:** Control plane — TypeScript, Fastify, `node:test` (run via `node --test --import tsx <file>`; tsx 4.19.1, node 24). Console — Next.js 14, React 18, Tailwind; **no test runner** (gates: `npx tsc --noEmit`, `npm run lint`, `npm run build`).

**Branches:** control plane `feat/project-delete-teardown` (off `master`); console — create `feat/project-delete-ui` (off `main`).

---

## File Structure

**Workstream 1 — control plane (`cantila-control-plane`):**
- Modify `src/core/control-plane.ts` — extend `deleteProject` (~line 8531) with best-effort mailbox + number teardown.
- Modify `src/core/delete-project.test.ts` — add teardown assertions.

**Workstream 2 — console (`cantila-console`):**
- Modify `src/lib/api.ts` — add `deleteProject`.
- Modify `src/components/ProjectsView.tsx` — kebab menu on live cards + type-to-confirm delete modal + wiring.

---

## Workstream 1 — Control plane: complete the cascade

### Task 1: Tear down mailboxes + number in `deleteProject` (TDD)

**Files:**
- Modify: `src/core/delete-project.test.ts`
- Modify: `src/core/control-plane.ts` (`deleteProject`, ~8531–8569)

- [ ] **Step 1: Add the failing tests**

In `src/core/delete-project.test.ts`, change the first import line to also import `mock`, and add an import for the mailbox provisioner. The current line 7 is `import { test } from "node:test";` — replace it with:

```ts
import { test, mock } from "node:test";
```

Add, after the existing import block (after line 14 `import { RuleBasedAiAnalyser } from "../ai/analyser";`):

```ts
import { mailboxProvisioner } from "../mail/provisioner";
```

Then append these three tests at the end of the file:

```ts
test("deleteProject deletes real mailboxes via the provisioner (best-effort)", async () => {
  const { cp, store } = makeCp();
  const project = await seedProject(cp, store);
  const made = await cp.createHostedMailbox({
    projectId: project.id,
    address: "hello@example.com",
  });
  assert.ok(!("error" in made), "mailbox seed should succeed");

  const spy = mock.method(mailboxProvisioner, "deleteMailbox");
  try {
    const result = await cp.deleteProject(project.id);
    assert.deepEqual(result, { ok: true, slug: project.slug });
    assert.equal(spy.mock.callCount(), 1);
    assert.deepEqual(spy.mock.calls[0].arguments, ["hello@example.com"]);
    assert.equal(
      (await store.listHostedMailboxesByProject(project.id)).length,
      0,
    );
  } finally {
    spy.mock.restore();
  }
});

test("deleteProject still succeeds when mailbox teardown throws", async () => {
  const { cp, store } = makeCp();
  const project = await seedProject(cp, store);
  await cp.createHostedMailbox({ projectId: project.id, address: "x@example.com" });

  const spy = mock.method(mailboxProvisioner, "deleteMailbox", async () => {
    throw new Error("mailcow down");
  });
  try {
    const result = await cp.deleteProject(project.id);
    assert.deepEqual(result, { ok: true, slug: project.slug });
    assert.equal(await store.getProject(project.id), null);
  } finally {
    spy.mock.restore();
  }
});

test("deleteProject releases the project's SMS number", async () => {
  const { cp, store } = makeCp();
  const project = await seedProject(cp, store);
  const phone = await cp.activateSms("acc_test", project.id, {
    country: "US",
    numberType: "local",
  });
  assert.ok(!("error" in phone), "SMS activation should succeed");
  const stored = await store.getPhoneNumberByProject(project.id);
  assert.ok(stored?.marketplaceNumberId, "number linked to a marketplace row");
  const mpId = stored!.marketplaceNumberId!;

  const result = await cp.deleteProject(project.id);
  assert.deepEqual(result, { ok: true, slug: project.slug });

  // Project number row is gone (cascade) and the carrier lease was released.
  assert.equal(await store.getPhoneNumberByProject(project.id), null);
  const mp = await store.getMarketplaceNumber(mpId);
  assert.equal(mp?.status, "released");
});
```

- [ ] **Step 2: Run the tests to verify they FAIL**

Run: `node --test --import tsx src/core/delete-project.test.ts`
Expected: the two mailbox tests FAIL (`deleteMailbox` spy `callCount` is 0 because `deleteProject` doesn't call it yet) and the number test FAILS (`mp?.status` is not `"released"` — today `deleteProject` deletes the row without releasing the lease). The original 4 tests still PASS.

- [ ] **Step 3: Implement the teardown in `deleteProject`**

In `src/core/control-plane.ts`, locate the `deleteProject` method. After the managed-database teardown block (the `if (db && this.deps.provisioner.destroyDatabase) { … }` block) and BEFORE `const removed = await this.deps.store.deleteProject(projectId);`, insert:

```ts
    // Tear down the real hosted mailboxes in the MTA (best-effort). The
    // record cascade below removes the rows regardless; this releases the
    // actual Mailcow mailboxes so deleting a project leaves no live inbox.
    const mailboxes =
      await this.deps.store.listHostedMailboxesByProject(projectId);
    for (const mb of mailboxes) {
      try {
        await mailboxProvisioner.deleteMailbox(mb.address);
      } catch {
        /* swallow — a stale/already-gone mailbox must not block removal */
      }
    }

    // Release the project's carrier number + stop its billing (best-effort).
    // deactivateSms releases the lease, stops Stripe billing, and strips the
    // SMS env; it is a no-op when the project has no number. Swallow failures
    // so a stuck number never blocks project removal.
    try {
      await this.deactivateSms(project.accountId, projectId);
    } catch {
      /* swallow */
    }
```

(`mailboxProvisioner` is already imported at the top of the file — `import { mailboxProvisioner } from "../mail/provisioner";`, line 113. `this.deactivateSms` and `store.listHostedMailboxesByProject` already exist. No new imports.)

- [ ] **Step 4: Run the tests to verify they PASS**

Run: `node --test --import tsx src/core/delete-project.test.ts`
Expected: all 7 tests PASS (4 original + 3 new).

- [ ] **Step 5: Type-check**

Run: `npm run typecheck`
Expected: PASS, no errors.

- [ ] **Step 6: Commit**

```bash
git add src/core/control-plane.ts src/core/delete-project.test.ts
git commit -m "feat(projects): tear down mailboxes + release number on project delete"
```
(End the commit body with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.)

---

## Workstream 2 — Console: the delete UI

> Create the console branch first: in `cantila-console`, `git checkout main && git checkout -b feat/project-delete-ui`. Leave the 4 pre-existing unrelated WIP files (`AutomationsView.tsx`, `ConnectionsView.tsx`, `SettingsView.tsx`, `marketing/MarketingHeader.tsx`) untouched/unstaged.

### Task 2: Add `api.deleteProject`

**Files:**
- Modify: `src/lib/api.ts`

- [ ] **Step 1: Add the client method**

In `src/lib/api.ts`, inside the `api` object, immediately after the `getProject` method (the line `getProject: (projectId: string) => request<ApiProjectDetail>(\`/projects/${encodeURIComponent(projectId)}\`),`), add:

```ts
  deleteProject: (projectId: string) =>
    request<{ ok: true; slug: string }>(
      `/projects/${encodeURIComponent(projectId)}`,
      { method: "DELETE" },
    ),
```

(`request()` throws `ApiError` on non-2xx, so a resolved call means success. `DELETE` is not in the write-methods set, so no `{}` body is sent — the control plane's `DELETE /v1/projects/:id` needs none.)

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/api.ts
git commit -m "feat(api): add deleteProject client method"
```
(End with the `Co-Authored-By` trailer.)

---

### Task 3: Kebab + type-to-confirm delete on `/projects`

**Files:**
- Modify: `src/components/ProjectsView.tsx`

- [ ] **Step 1: Extend imports**

In `src/components/ProjectsView.tsx`, add `useRef` to the React import (line 3 is `import { useEffect, useState } from "react";`):

```ts
import { useEffect, useRef, useState } from "react";
```

Add `MoreHorizontal` and `Trash2` to the lucide-react import (the block `import { Rocket, MapPin, Clock, ArrowUpRight, Cpu, Search, Zap, Loader2 } from "lucide-react";`):

```ts
import {
  Rocket,
  MapPin,
  Clock,
  ArrowUpRight,
  Cpu,
  Search,
  Zap,
  Loader2,
  MoreHorizontal,
  Trash2,
} from "lucide-react";
```

- [ ] **Step 2: Add the kebab-menu component**

Insert this component just above `function ProjectCard(` (above the `/* ---------- project card ---------- */` block is fine):

```tsx
function ProjectCardMenu({ onDelete }: { onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="absolute right-3 top-3 z-10">
      <button
        type="button"
        aria-label="Project actions"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        className="flex h-7 w-7 items-center justify-center rounded-lg border border-border bg-surface-2 text-ink-dim transition-colors hover:border-ink-faint hover:text-ink"
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {open && (
        <div className="absolute right-0 top-8 w-40 overflow-hidden rounded-lg border border-border bg-surface shadow-lift">
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
              onDelete();
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-2xs font-medium text-down transition-colors hover:bg-down/10"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete project
          </button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Wire the kebab into `ProjectCard`**

Change the `ProjectCard` signature to accept `onDelete`. Replace the signature line:

```tsx
function ProjectCard({ p, handle }: { p: DisplayProject; handle: string | null }) {
```

with:

```tsx
function ProjectCard({
  p,
  handle,
  onDelete,
}: {
  p: DisplayProject;
  handle: string | null;
  onDelete?: (p: DisplayProject) => void;
}) {
```

Immediately after the `const href = …` block and before `const cpuNow = …`, add:

```tsx
  const showMenu = Boolean(p.live && p.liveId && onDelete);
```

In the header row inside `body`, reserve space for the kebab so it doesn't overlap the `StatusBadge`. Change:

```tsx
      <div className="flex items-start gap-3">
        <RuntimeMark runtime={p.runtime} />
```

to:

```tsx
      <div className={cx("flex items-start gap-3", showMenu && "pr-7")}>
        <RuntimeMark runtime={p.runtime} />
```

Finally, replace the component's `return` (the `return href ? ( … ) : ( … );` at the end of `ProjectCard`) with a version that overlays the menu for live cards:

```tsx
  const card = href ? (
    <Link href={href} className={className}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  );

  if (!showMenu) return card;
  return (
    <div className="relative">
      {card}
      <ProjectCardMenu onDelete={() => onDelete!(p)} />
    </div>
  );
```

- [ ] **Step 4: Add delete state + handler in `ProjectsView`**

Inside `ProjectsView`, after the existing `const [handle, setHandle] = useState<string | null>(null);` line, add:

```tsx
  const [deleteTarget, setDeleteTarget] = useState<DisplayProject | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  function closeDelete() {
    if (deleting) return;
    setDeleteTarget(null);
    setConfirmText("");
    setDeleteError(null);
  }

  async function confirmDelete() {
    if (
      !deleteTarget ||
      !deleteTarget.liveId ||
      confirmText !== deleteTarget.name ||
      deleting
    )
      return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.deleteProject(deleteTarget.liveId);
      setItems((prev) => (prev ?? []).filter((x) => x.id !== deleteTarget.id));
      setDeleteTarget(null);
      setConfirmText("");
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "delete failed");
    } finally {
      setDeleting(false);
    }
  }
```

- [ ] **Step 5: Pass `onDelete` to the cards**

In the grid, replace:

```tsx
          {filtered.map((p) => (
            <ProjectCard key={p.id} p={p} handle={handle} />
          ))}
```

with:

```tsx
          {filtered.map((p) => (
            <ProjectCard
              key={p.id}
              p={p}
              handle={handle}
              onDelete={(proj) => {
                setDeleteError(null);
                setConfirmText("");
                setDeleteTarget(proj);
              }}
            />
          ))}
```

- [ ] **Step 6: Add the type-to-confirm modal**

Immediately before the closing `</div>` of the component's returned tree (right after the `</Modal>` of the "new project modal"), add:

```tsx
      {/* delete project modal — type-to-confirm */}
      <Modal
        open={deleteTarget !== null}
        onClose={closeDelete}
        title={deleteTarget ? `Delete ${deleteTarget.name}?` : "Delete project"}
        description="This permanently removes the app and everything connected to it."
        footer={
          <>
            <Button variant="ghost" onClick={closeDelete} disabled={deleting}>
              Cancel
            </Button>
            <button
              onClick={confirmDelete}
              disabled={
                !deleteTarget ||
                confirmText !== deleteTarget.name ||
                deleting
              }
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-down/40 bg-down/10 px-3.5 text-sm font-semibold text-down transition-colors hover:bg-down/20 disabled:cursor-default disabled:opacity-50"
            >
              {deleting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )}
              {deleting ? "Deleting…" : "Delete project"}
            </button>
          </>
        }
      >
        {deleteTarget && (
          <>
            <p className="rounded-md border border-down/30 bg-down/5 px-3 py-2 text-2xs text-down">
              This permanently deletes the project, its database, domains,
              mailboxes, and phone number. This cannot be undone.
            </p>
            <Field label={`Type "${deleteTarget.name}" to confirm`}>
              <input
                autoFocus
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && confirmText === deleteTarget.name)
                    confirmDelete();
                }}
                placeholder={deleteTarget.name}
                className={inputClass}
              />
            </Field>
            {deleteError && (
              <p className="rounded-md border border-down/30 bg-down/5 px-3 py-2 text-2xs text-down">
                {deleteError}
              </p>
            )}
          </>
        )}
      </Modal>
```

- [ ] **Step 7: Type-check, lint, build**

Run: `npx tsc --noEmit && npm run lint && npm run build`
Expected: all PASS (the pre-existing `no-img-element` warning in `ProjectChatMessages.tsx` is fine; an unrelated `ECONNREFUSED` during static generation is a runtime fetch, not a build failure). Fix any unused-import or class-name issues surfaced.

- [ ] **Step 8: Commit**

```bash
git add src/components/ProjectsView.tsx
git commit -m "feat(projects): delete a project from /projects (kebab + type-to-confirm)"
```
(End with the `Co-Authored-By` trailer.)

---

### Task 4: Manual verification (post-deploy, signed in)

- [ ] **Step 1: Verify on the live console**

After both services deploy (control plane FIRST), open `/projects` signed in:
1. Each **live** card shows a ⋯ button; clicking it opens a menu with red "Delete project". Clicking elsewhere / Escape closes it; clicking the card body still navigates.
2. Choosing Delete opens the modal; the red Delete button stays disabled until the typed text exactly equals the project name.
3. Confirming deletes the project: the card disappears, and re-listing confirms it's gone. The project's subdomain stops resolving; where Mail/SMS providers are live, the mailbox and number are torn down (number billing stops).
4. A mismatched name keeps Delete disabled; Cancel/observe leaves the project intact.

Record the observed result. If the API call errors, capture the message shown in the modal and fix forward.

---

## Self-Review (completed during planning)

**Spec coverage:**
- Mailbox teardown → Task 1 (loop over `listHostedMailboxesByProject` → `mailboxProvisioner.deleteMailbox`). ✓
- Number release → Task 1 (`this.deactivateSms`, best-effort). ✓
- App/subdomain + database + records → unchanged existing code (not re-implemented). ✓
- Tests assert teardown calls + best-effort survival → Task 1 Step 1 (3 tests). ✓
- `api.deleteProject` → Task 2. ✓
- Kebab on live cards only + overlay (no nested anchor) → Task 3 Steps 2–3 (`showMenu`, relative wrapper, `absolute z-10`). ✓
- Type-to-confirm modal + optimistic removal + inline error → Task 3 Steps 4, 6. ✓
- Live-only / offline excluded → `showMenu = p.live && p.liveId && onDelete`. ✓
- Two-deploy shipping note → spec (control plane first). ✓

**Placeholder scan:** none — every step has complete code/commands.

**Type consistency:** `deleteTarget: DisplayProject | null`; `onDelete?: (p: DisplayProject) => void`; `api.deleteProject(projectId: string)` matches the WS1 route `DELETE /v1/projects/:id`. Test helpers (`makeCp`, `seedProject`, `cp.createHostedMailbox`, `cp.activateSms`, `store.getMarketplaceNumber`, `store.listHostedMailboxesByProject`, `store.getPhoneNumberByProject`) all exist in the control-plane sources read during planning.
