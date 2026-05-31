# `cantila_push_files` MCP Tool — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an MCP tool that commits an agent's files into a project's own Cantila Gitea repo (auto-created) and deploys, so an app can ship without a public repo or GitHub credentials.

**Architecture:** One new tool in `cantilaTools()` that orchestrates existing `ControlPlane` methods — `ensureProjectRepo` → `listProjectFiles` (sha lookup) → `writeProjectFile` (per file) → `deploy`. No new control-plane or git code; the tool holds only validation + orchestration. Because `index.ts` (stdio) and the `/v1/mcp` HTTP route both build their tool set from `cantilaTools(cp)`, registering it in that one array exposes it on every transport.

**Tech Stack:** TypeScript (Node 20+), `node:test` + `node:assert/strict`, run with `npx tsx --test <file>`. No test script in package.json — invoke tsx directly.

---

## File Structure

- **Modify:** `src/mcp/tools.ts` — add the `cantila_push_files` ToolDefinition to the array returned by `cantilaTools(cp)`. Reuses the existing `text()` / `errorText()` helpers at the top of the file.
- **Create:** `src/mcp/push-files.test.ts` — offline unit tests against a real in-memory `ControlPlane` (mirrors `src/core/files-via-provider.test.ts`).
- **Modify:** `src/app`-side docs are in the console repo, not here. Within control-plane, update the tool inventory doc if one exists (Task 4) — skip if none.

Reused, unchanged: `ControlPlane.ensureProjectRepo`, `.listProjectFiles`, `.writeProjectFile`, `.readProjectFile`, `.listProjectDeployments`, `.deploy`; `CantilaGitProvider`.

---

## Task 1: Add `cantila_push_files` (first behavior, TDD)

**Files:**
- Create: `src/mcp/push-files.test.ts`
- Modify: `src/mcp/tools.ts` (add one tool object inside the array returned by `cantilaTools`, after `cantila_create_connection`)

- [ ] **Step 1: Write the failing test**

Create `src/mcp/push-files.test.ts`:

```ts
/* ============================================================
   cantila_push_files — commit files into the project's own
   Cantila repo and deploy. Offline: in-memory store + stub
   provider/data-plane, no network.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";

import { ControlPlane } from "../core/control-plane";
import { InMemoryStore } from "../domain/store";
import { stubProvisioner, stubDataPlane } from "../dataplane/stub";
import { StubStripeAdapter } from "../billing/stripe";
import { RuleBasedAiAnalyser } from "../ai/analyser";
import { cantilaTools } from "./tools";
import type { ToolDefinition, ToolResult } from "./server";

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

function pushTool(cp: ControlPlane): ToolDefinition {
  const tool = cantilaTools(cp).find((t) => t.name === "cantila_push_files");
  assert.ok(tool, "cantila_push_files tool must be registered");
  return tool;
}

function textOf(r: ToolResult): string {
  return r.content.map((c) => ("text" in c ? c.text : "")).join("\n");
}

async function seededProject(cp: ControlPlane, store: InMemoryStore) {
  await store.createAccount({
    id: "acc_test",
    name: "Cantila",
    handle: "cantila",
    plan: "starter",
    createdAt: new Date().toISOString(),
  });
  return cp.createProject({
    accountId: "acc_test",
    name: "Homes",
    runtime: "node",
    region: "fsn1",
  });
}

test("commits files to the project's cantila repo and deploys", async () => {
  const { cp, store } = makeCp();
  const project = await seededProject(cp, store);
  const res = await pushTool(cp).handler({
    projectId: project.id,
    files: [
      { path: "index.html", content: "<h1>Homes</h1>" },
      { path: "about.html", content: "<p>about</p>" },
    ],
  });
  assert.ok(!res.isError, textOf(res));
  const out = textOf(res);
  assert.match(out, /Committed 2 file\(s\)/);
  assert.match(out, /Deploy live/);

  const list = await cp.listProjectFiles(project.id);
  assert.ok(list && "files" in list);
  const paths = (list as { files: { path: string }[] }).files.map((f) => f.path);
  assert.ok(paths.includes("index.html") && paths.includes("about.html"));

  const deployments = await cp.listProjectDeployments(project.id);
  assert.ok(deployments.length >= 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/mcp/push-files.test.ts`
Expected: FAIL — the `assert.ok(tool, ...)` in `pushTool` throws because no tool named `cantila_push_files` is registered yet.

- [ ] **Step 3: Add the tool implementation**

In `src/mcp/tools.ts`, inside `cantilaTools(cp)`, add this object as the last element of the returned array (immediately after the `cantila_create_connection` tool, before the closing `];`):

```ts
    /* ---------- cantila_push_files ---------- */
    {
      name: "cantila_push_files",
      description:
        "Commit a set of files into a project's own Cantila git repo (auto-created if the project has none) and deploy. Lets an agent ship an app with no public repo and no GitHub credentials — files land in the project's git.cantila.app repo and go live.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: {
            type: "string",
            description: "The Cantila project id.",
          },
          files: {
            type: "array",
            description:
              "Files to commit. Each entry: { path, content, encoding?, message? }.",
            items: {
              type: "object",
              properties: {
                path: {
                  type: "string",
                  description: "Repo-relative path, e.g. src/app/page.tsx.",
                },
                content: { type: "string", description: "File contents." },
                encoding: {
                  type: "string",
                  enum: ["utf-8", "base64"],
                  description:
                    "Content encoding. Use base64 for binary assets. Defaults to utf-8.",
                },
                message: {
                  type: "string",
                  description: "Optional per-file commit message.",
                },
              },
              required: ["path", "content"],
            },
          },
          message: {
            type: "string",
            description:
              "Default commit message for files that don't carry their own.",
          },
          deploy: {
            type: "boolean",
            description: "Deploy after committing. Defaults to true.",
          },
        },
        required: ["projectId", "files"],
      },
      handler: async (args) => {
        const projectId = String(args.projectId ?? "");
        if (!projectId) return errorText("projectId is required.");
        const rawFiles = Array.isArray(args.files) ? args.files : [];
        if (rawFiles.length === 0) {
          return errorText("files must be a non-empty array.");
        }

        // Validate + normalise every entry before any side effect.
        const files: { path: string; content: string; message?: string }[] = [];
        for (const f of rawFiles) {
          if (!f || typeof f !== "object") {
            return errorText("each file must be an object.");
          }
          const rec = f as Record<string, unknown>;
          const path = String(rec.path ?? "").trim();
          if (!path) return errorText("each file needs a non-empty path.");
          if (typeof rec.content !== "string") {
            return errorText(`file ${path}: content must be a string.`);
          }
          let content = rec.content;
          if (rec.encoding === "base64") {
            try {
              content = Buffer.from(rec.content, "base64").toString("utf-8");
            } catch {
              return errorText(`file ${path}: invalid base64 content.`);
            }
          }
          files.push({
            path,
            content,
            message:
              typeof rec.message === "string" ? rec.message : undefined,
          });
        }

        // Ensure the project has a Cantila git repo.
        const ensured = await cp.ensureProjectRepo(projectId);
        if (!ensured) return errorText("project not found.");
        if (!ensured.repoUrl) {
          return errorText(
            "Cantila git backend not configured (GITEA_URL unset) — cannot host files for this project.",
          );
        }

        // Look up existing blob shas so re-pushed paths update instead of failing.
        const listing = await cp.listProjectFiles(projectId);
        const shaByPath = new Map<string, string>();
        if (listing && "files" in listing) {
          for (const node of listing.files) {
            if (node.sha) shaByPath.set(node.path, node.sha);
          }
        }

        const defaultMessage =
          typeof args.message === "string" && args.message.trim()
            ? args.message.trim()
            : "Push files via Cantila MCP";

        let committed = 0;
        let lastCommitSha = "";
        for (const file of files) {
          const result = await cp.writeProjectFile(projectId, {
            path: file.path,
            content: file.content,
            sha: shaByPath.get(file.path),
            message: file.message ?? defaultMessage,
          });
          if (!result || "error" in result) {
            const reason =
              result && "error" in result ? result.error : "unknown";
            return errorText(
              `Committed ${committed}/${files.length} file(s); failed on ${file.path}: ${reason}.`,
            );
          }
          committed += 1;
          lastCommitSha = result.commitSha;
        }

        const lines = [
          `Committed ${committed} file(s) to ${ensured.repoUrl} (${ensured.branch ?? "main"})`,
          `Last commit: ${lastCommitSha}`,
        ];

        if (args.deploy === false) {
          lines.push(
            "Skipped deploy (deploy:false) — run cantila_deploy when ready.",
          );
          return text(lines.join("\n"));
        }

        try {
          const outcome = await cp.deploy(projectId, {
            trigger: "mcp",
            source: { kind: "chat" },
          });
          lines.push(
            `Deploy ${outcome.status} — ${outcome.url}`,
            `Deployment: ${outcome.deploymentId}`,
            `Steps: ${outcome.steps.join(" -> ")}`,
          );
        } catch (err) {
          lines.push(
            `Files committed, but deploy failed: ${
              err instanceof Error ? err.message : "deploy failed"
            }. Retry with cantila_deploy.`,
          );
          return errorText(lines.join("\n"));
        }
        return text(lines.join("\n"));
      },
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/mcp/push-files.test.ts`
Expected: PASS (1 test, 1 pass).

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools.ts src/mcp/push-files.test.ts
git commit -m "feat(mcp): add cantila_push_files tool (commit to own git + deploy)"
```

---

## Task 2: Cover deploy:false, base64, re-push, and validation

**Files:**
- Modify: `src/mcp/push-files.test.ts`

- [ ] **Step 1: Append the remaining tests**

Add to `src/mcp/push-files.test.ts`:

```ts
test("deploy:false commits without deploying", async () => {
  const { cp, store } = makeCp();
  const project = await seededProject(cp, store);
  const res = await pushTool(cp).handler({
    projectId: project.id,
    files: [{ path: "index.html", content: "hi" }],
    deploy: false,
  });
  assert.ok(!res.isError, textOf(res));
  assert.match(textOf(res), /Skipped deploy/);
  const deployments = await cp.listProjectDeployments(project.id);
  assert.equal(deployments.length, 0);
});

test("base64 content is decoded before commit", async () => {
  const { cp, store } = makeCp();
  const project = await seededProject(cp, store);
  const encoded = Buffer.from("<h1>b64</h1>", "utf-8").toString("base64");
  const res = await pushTool(cp).handler({
    projectId: project.id,
    files: [{ path: "index.html", content: encoded, encoding: "base64" }],
    deploy: false,
  });
  assert.ok(!res.isError, textOf(res));
  const read = await cp.readProjectFile(project.id, "index.html");
  assert.ok(read && "content" in read && read.content === "<h1>b64</h1>");
});

test("re-pushing a path updates its content", async () => {
  const { cp, store } = makeCp();
  const project = await seededProject(cp, store);
  const tool = pushTool(cp);
  await tool.handler({
    projectId: project.id,
    files: [{ path: "index.html", content: "v1" }],
    deploy: false,
  });
  const res = await tool.handler({
    projectId: project.id,
    files: [{ path: "index.html", content: "v2" }],
    deploy: false,
  });
  assert.ok(!res.isError, textOf(res));
  const read = await cp.readProjectFile(project.id, "index.html");
  assert.ok(read && "content" in read && read.content === "v2");
});

test("empty files array errors with no side effect", async () => {
  const { cp, store } = makeCp();
  const project = await seededProject(cp, store);
  const res = await pushTool(cp).handler({ projectId: project.id, files: [] });
  assert.equal(res.isError, true);
});

test("missing projectId errors", async () => {
  const { cp } = makeCp();
  const res = await pushTool(cp).handler({
    files: [{ path: "a.txt", content: "b" }],
  });
  assert.equal(res.isError, true);
});
```

- [ ] **Step 2: Run the full test file**

Run: `npx tsx --test src/mcp/push-files.test.ts`
Expected: PASS — 6 tests, 6 pass. If `re-pushing` or `deploy:false` fails, fix the implementation in `tools.ts` (sha lookup / `args.deploy === false` branch), not the test.

- [ ] **Step 3: Commit**

```bash
git add src/mcp/push-files.test.ts
git commit -m "test(mcp): cover push-files deploy:false, base64, re-push, validation"
```

---

## Task 3: Typecheck the whole package

**Files:** none (verification only)

- [ ] **Step 1: Run the typechecker**

Run: `npm run typecheck`
Expected: exits 0 with no errors. The new tool uses only existing `ControlPlane` methods and the `text`/`errorText` helpers, so types should line up. If `tsc` flags the `find(...)` return as possibly-undefined in the test, the `assert.ok(tool)` narrowing handles it at runtime — if `tsc` still complains under strict settings, change `return tool;` to `return tool as ToolDefinition;` in `pushTool`.

- [ ] **Step 2: Commit only if a fix was needed**

```bash
git add -A
git commit -m "fix(mcp): satisfy typecheck for push-files"
```

(Skip this commit if `npm run typecheck` was already clean.)

---

## Task 4: Update the MCP tool inventory (if present in this repo)

**Files:**
- Modify: any in-repo doc that enumerates MCP tools (search first).

- [ ] **Step 1: Find an in-repo tool list**

Run: `grep -rl "cantila_create_connection" --include=*.md --include=*.mdx . | grep -v node_modules`
Expected: lists docs that enumerate tools, if any live in this repo. (The console-facing `docs/mcp` page lives in the **console** repo, out of scope here.)

- [ ] **Step 2: Add a row for the new tool**

If a markdown table of tools is found, add:

```
| `cantila_push_files`   | Commit files into the project's own Cantila git repo and deploy — no public repo or GitHub creds needed. |
```

If no such in-repo doc exists, skip — the tool's `description` is the source of truth over MCP, and there is nothing to update.

- [ ] **Step 3: Commit (only if a doc was changed)**

```bash
git add -A
git commit -m "docs(mcp): list cantila_push_files in tool inventory"
```

---

## Task 5: Final verification

**Files:** none

- [ ] **Step 1: Run the new test file once more + the sibling files test (no regressions)**

Run: `npx tsx --test src/mcp/push-files.test.ts src/core/files-via-provider.test.ts`
Expected: all tests pass.

- [ ] **Step 2: Confirm the tool is exposed on stdio**

Run: `npm run mcp` in one shell; in another, send a `tools/list` JSON-RPC request (or stop after the `[cantila-mcp] ready` line). Confirm `cantila_push_files` appears. Stop the server after.

- [ ] **Step 3 (post-deploy, manual — flagged): live smoke against prod**

This requires the new tool shipped to the prod control-plane (Coolify deploy of this branch) first. After that, push the real CantilaHomes files via the hosted MCP at `https://mcp.cantila.app/v1/mcp` and confirm `https://cantilahomes.cantila.app` serves the actual Next.js app (landing + `/login` return real content, not the nginx placeholder). This is the acceptance test for the original problem. Do NOT mark the feature "shipped" until this passes — local tests prove the tool's logic, not that the prod Gitea build serves the app.

---

## Notes for the implementer

- **Do not** add the tool to `index.ts` or the HTTP route separately — both build from `cantilaTools(cp)`. One array entry is enough.
- The stub data-plane's `healthCheck()` always returns `true`, so the Task 1 deploy reports `live` offline. That's expected for the unit test; it is also the known adjacent weakness (any-200 = verified) called out in the spec — out of scope here.
- Keep the handler's validate-before-side-effect ordering: all input is checked before `ensureProjectRepo`, so a bad request never creates a repo.
