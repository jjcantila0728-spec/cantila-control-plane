# Phase 1 — Claude Code Fleet + /agents Org Chart — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make Cantila's 78 build agents live via the Claude Agent SDK (in-container), redesign `/agents` into a live org flow-chart, and make chat→build produce real files — streamed through the existing SSE/UI unchanged.

**Architecture:** All engine code under `cantila-control-plane/src/fleet/`. One `query()` session per build; orchestrator delegates to subagents inside it. SDK stream → existing `OrchestratorEvent` shape via a pure `event-map`. `ProjectOrchestrator` delegates to `ClaudeFleet`. New `GET /v1/agents/org` feeds a new console org-chart that sits above the preserved ops-brain diary.

**Tech Stack:** TypeScript (CommonJS), `@anthropic-ai/claude-agent-sdk`, `tsx`, `node:test`. Worktree: `cantila-control-plane/.claude/worktrees/fleet-build-engine` on branch `feat/fleet-build-engine`. Console repo is separate (`cantila-console`).

## Already built (surviving Tasks 1–4, committed)
`src/fleet/config.ts`, `src/fleet/types.ts`, `src/fleet/workspace.ts`, `src/fleet/memory.ts`. Tasks below extend these.

## Conventions
- Tests: `node:test` + `node:assert/strict`, colocated `*.test.ts`, run `npx tsx --test <file>`.
- The SDK `query` is ALWAYS injected as a `QueryFn` param so tests pass a fake async generator — never call the real API in a test.
- Commit after each task.
- Confirmed SDK facts: package `@anthropic-ai/claude-agent-sdk`; `import { query, type AgentDefinition, type SDKMessage, type Options } from "@anthropic-ai/claude-agent-sdk"`. `query({prompt, options})` returns an async iterable of `SDKMessage`. Relevant variants: `SDKAssistantMessage { type:"assistant"; message:{content: Array<{type:"text",text}|{type:"tool_use",id,name,input}>}; parent_tool_use_id: string|null }`; `SDKUserMessage { type:"user"; message:{content: Array<{type:"tool_result", tool_use_id, content, is_error?}>}; parent_tool_use_id }`; `SDKResultMessage { type:"result"; subtype:"success"|"error"; total_cost_usd:number; is_error:boolean; result?:string }`; `SDKSystemMessage { type:"system"; subtype:"init" }`. Options include `cwd, agents, allowedTools, disallowedTools, permissionMode, maxTurns, maxBudgetUsd, model`. **The implementer MUST confirm exact field names against `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` and adjust access if they differ.**

---

## Task P0: Add the SDK dependency + .npmrc (unblock install everywhere)

**Files:** Modify `package.json`; Create `.npmrc`.

- [ ] **Step 1:** Create `.npmrc` at the control-plane root with:
```
legacy-peer-deps=true
```
(The SDK peer-requires zod 4; the project uses zod 3. `legacy-peer-deps` lets both local and Coolify `npm install` resolve. zod 3 stays at root; the SDK module loads fine with it — verified.)

- [ ] **Step 2:** Install + pin the dependency:
```bash
npm install @anthropic-ai/claude-agent-sdk
```
Confirm `package.json` now lists `@anthropic-ai/claude-agent-sdk` under dependencies.

- [ ] **Step 3:** Runtime smoke (no model call) — confirm the SDK loads with zod 3 present:
```bash
node -e "const s=require('@anthropic-ai/claude-agent-sdk'); if(typeof s.query!=='function') throw new Error('no query'); console.log('ok: query present')"
```
Expected: `ok: query present`. If it throws a zod-related error, STOP and report BLOCKED (fallback: isolated sub-package — escalate to controller).

- [ ] **Step 4:** Typecheck still green:
```bash
npm run typecheck
```
Expected: no errors.

- [ ] **Step 5: Commit**
```bash
git add package.json package-lock.json .npmrc
git commit -m "build(fleet): add @anthropic-ai/claude-agent-sdk + legacy-peer-deps"
```

---

## Task P1: Extend config + types for the SDK

**Files:** Modify `src/fleet/config.ts`, `src/fleet/types.ts`; Tests: extend `src/fleet/config.test.ts`, create `src/fleet/types.sdk.test.ts`.

- [ ] **Step 1: Extend the config test** — add to `src/fleet/config.test.ts`:
```ts
test("fleetConfig exposes budget + concurrency caps", () => {
  const c = fleetConfig();
  assert.ok(c.maxBudgetUsd > 0);
  assert.ok(c.maxConcurrentBuilds >= 1);
});
```

- [ ] **Step 2: Run** `npx tsx --test src/fleet/config.test.ts` → FAIL (missing fields).

- [ ] **Step 3: Edit `src/fleet/config.ts`** — add to `FleetConfig` interface: `maxBudgetUsd: number;` and `maxConcurrentBuilds: number;`. Add to the returned object:
```ts
    maxBudgetUsd: num("FLEET_MAX_BUDGET_USD", 2),
    maxConcurrentBuilds: num("FLEET_MAX_CONCURRENT_BUILDS", 2),
```

- [ ] **Step 4: Create `src/fleet/types.sdk.test.ts`:**
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { SDK_TOOL_NAMES, AGENT_SESSION_STATUSES } from "./types";

test("SDK tool names cover the slice-1 allow-list", () => {
  for (const t of ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "Agent"]) {
    assert.ok(SDK_TOOL_NAMES.includes(t as any), `missing ${t}`);
  }
});

test("agent session statuses are the four lifecycle states", () => {
  assert.deepEqual([...AGENT_SESSION_STATUSES], ["idle", "working", "done", "failed"]);
});
```

- [ ] **Step 5: Run** `npx tsx --test src/fleet/types.sdk.test.ts` → FAIL.

- [ ] **Step 6: Edit `src/fleet/types.ts`** — append:
```ts
export const SDK_TOOL_NAMES = ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "Agent"] as const;
export type SdkToolName = (typeof SDK_TOOL_NAMES)[number];

export const AGENT_SESSION_STATUSES = ["idle", "working", "done", "failed"] as const;
export type AgentSessionStatus = (typeof AGENT_SESSION_STATUSES)[number];
```

- [ ] **Step 7: Run both tests** → PASS. Then `npm run typecheck` → clean.

- [ ] **Step 8: Commit**
```bash
git add src/fleet/config.ts src/fleet/config.test.ts src/fleet/types.ts src/fleet/types.sdk.test.ts
git commit -m "feat(fleet): config budget/concurrency caps + SDK tool/status types"
```

---

## Task P2: Roster port script + generated roster

**Files:** Create `scripts/port-fleet.mjs`, `src/fleet/roster/types.ts`, `src/fleet/roster/roster.generated.ts` (generated), `src/fleet/roster/index.ts`; Test `src/fleet/roster/index.test.ts`.

- [ ] **Step 1: Create `scripts/port-fleet.mjs`** — reads `../../../../AgentFleet/.claude/agents` relative to the worktree is unreliable; instead resolve the AgentFleet path from an env or the known repo layout. Use:
```js
/* Port AgentFleet agent markdown into a committed TS roster.
   Usage: node scripts/port-fleet.mjs [agentsDir]
   Default agentsDir: $FLEET_AGENTS_DIR or <repoRoot>/../AgentFleet/.claude/agents
   (repoRoot = the main checkout, not the worktree). Pass the dir explicitly when in a worktree. */
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const agentsDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : process.env.FLEET_AGENTS_DIR
  ? path.resolve(process.env.FLEET_AGENTS_DIR)
  : path.resolve(repoRoot, "..", "AgentFleet", ".claude", "agents");

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(abs)));
    else if (e.name.endsWith(".md")) out.push(abs);
  }
  return out;
}
function parseFrontMatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text.trim() };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i === -1) continue;
    meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: m[2].trim() };
}
function divisionFromPath(absPath) {
  const rel = path.relative(agentsDir, absPath).split(path.sep);
  return rel.length > 1 ? rel[0] : "governance";
}
const files = (await walk(agentsDir)).sort();
const roles = [];
for (const f of files) {
  const { meta, body } = parseFrontMatter(await readFile(f, "utf8"));
  const id = meta.name || path.basename(f, ".md");
  roles.push({
    id,
    name: id,
    division: divisionFromPath(f),
    description: meta.description || "",
    model: meta.model === "opus" ? "opus" : "sonnet",
    tools: (meta.tools || "").split(",").map((s) => s.trim()).filter(Boolean),
    systemPrompt: body,
  });
}
const header = `/* AUTO-GENERATED by scripts/port-fleet.mjs — do not edit by hand.
   Source: AgentFleet/.claude/agents/**/*.md (${roles.length} agents). */
import type { AgentRoleRaw } from "./types";

export const ROSTER: AgentRoleRaw[] = ${JSON.stringify(roles, null, 2)};
`;
const outPath = path.resolve(repoRoot, "src", "fleet", "roster", "roster.generated.ts");
await writeFile(outPath, header, "utf8");
console.log(`Wrote ${roles.length} agents to ${path.relative(repoRoot, outPath)}`);
```

- [ ] **Step 2: Create `src/fleet/roster/types.ts`:**
```ts
import type { AgentModel } from "../types";

/** Raw role as ported from AgentFleet markdown (tools kept as raw strings). */
export interface AgentRoleRaw {
  id: string;
  name: string;
  division: string;
  description: string;
  model: AgentModel;
  tools: string[];
  systemPrompt: string;
}
```

- [ ] **Step 3: Run the port script** (pass the AgentFleet dir explicitly; it lives in the MAIN checkout, outside the worktree):
```bash
node scripts/port-fleet.mjs "../../../AgentFleet/.claude/agents"
```
If that relative path doesn't resolve from the worktree, use the absolute path:
`node scripts/port-fleet.mjs "C:/Users/canti/OneDrive/Documents/Claude/Projects/cantila/AgentFleet/.claude/agents"`
Expected: `Wrote 78 agents ...` (accept the actual `.md` count; report it).

- [ ] **Step 4: Write the failing test** `src/fleet/roster/index.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { listRoles, getRole, rolesByDivision } from "./index";

test("roster has the full fleet", () => {
  assert.ok(listRoles().length >= 70, `got ${listRoles().length}`);
});
test("orchestrator + key specialists present", () => {
  for (const id of ["00-orchestrator", "react-engineer", "api-engineer", "qa-engineer"]) {
    assert.ok(getRole(id), `missing ${id}`);
  }
});
test("rolesByDivision groups", () => {
  assert.ok(Object.keys(rolesByDivision()).length >= 5);
});
```

- [ ] **Step 5: Create `src/fleet/roster/index.ts`:**
```ts
import type { AgentRoleRaw } from "./types";
import { ROSTER } from "./roster.generated";

const byId = new Map<string, AgentRoleRaw>(ROSTER.map((r) => [r.id, r]));
export function listRoles(): AgentRoleRaw[] { return ROSTER.slice(); }
export function getRole(id: string): AgentRoleRaw | undefined { return byId.get(id); }
export function rolesByDivision(): Record<string, AgentRoleRaw[]> {
  const out: Record<string, AgentRoleRaw[]> = {};
  for (const r of ROSTER) (out[r.division] ??= []).push(r);
  return out;
}
```

- [ ] **Step 6: Run** `npx tsx --test src/fleet/roster/index.test.ts` → PASS.

- [ ] **Step 7: Commit**
```bash
git add scripts/port-fleet.mjs src/fleet/roster/
git commit -m "feat(fleet): port all AgentFleet agents into committed roster"
```

---

## Task P3: AgentRole → SDK AgentDefinition mapping

**Files:** Create `src/fleet/roster/agent-defs.ts`; Test `src/fleet/roster/agent-defs.test.ts`.

- [ ] **Step 1: Write the failing test:**
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { toSdkTools, agentDefinitions } from "./agent-defs";

test("toSdkTools maps AgentFleet tools to SDK tool names", () => {
  assert.deepEqual(toSdkTools(["Read", "Write", "Edit", "Glob", "Grep", "Bash"]).sort(),
    ["Bash", "Edit", "Glob", "Grep", "Read", "Write"].sort());
  assert.ok(toSdkTools(["Task"]).includes("Agent")); // Task -> Agent (delegation)
  assert.deepEqual(toSdkTools(["Bogus"]), []); // unknown dropped
});

test("agentDefinitions yields a record keyed by agent id with prompt/description", () => {
  const defs = agentDefinitions();
  assert.ok(Object.keys(defs).length >= 70);
  const re = defs["react-engineer"];
  assert.ok(re && typeof re.prompt === "string" && re.prompt.length > 0);
  assert.ok(typeof re.description === "string");
  assert.ok(["opus", "sonnet"].includes(re.model as string));
});
```

- [ ] **Step 2: Run** `npx tsx --test src/fleet/roster/agent-defs.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/fleet/roster/agent-defs.ts`:**
```ts
import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";
import type { SdkToolName } from "../types";
import { SDK_TOOL_NAMES } from "../types";
import { listRoles } from "./index";

const TOOL_ALIAS: Record<string, SdkToolName> = {
  read: "Read", write: "Write", edit: "Edit", glob: "Glob",
  grep: "Grep", bash: "Bash", task: "Agent", agent: "Agent",
};

/** Map AgentFleet `tools:` strings to SDK tool names; unknown tools dropped. */
export function toSdkTools(tools: string[]): SdkToolName[] {
  const out = new Set<SdkToolName>();
  for (const t of tools) {
    const mapped = TOOL_ALIAS[t.trim().toLowerCase()];
    if (mapped && SDK_TOOL_NAMES.includes(mapped)) out.add(mapped);
  }
  return [...out];
}

const SECURITY_DIVISIONS = new Set(["security"]);

/** All build agents as SDK subagent definitions, keyed by id. */
export function agentDefinitions(): Record<string, AgentDefinition> {
  const defs: Record<string, AgentDefinition> = {};
  for (const r of listRoles()) {
    if (r.id === "00-orchestrator") continue; // the orchestrator is the session's main agent
    const prompt = SECURITY_DIVISIONS.has(r.division)
      ? `${r.systemPrompt}\n\nIMPORTANT: authorized/defensive security work only.`
      : r.systemPrompt;
    defs[r.id] = {
      description: r.description,
      prompt,
      tools: toSdkTools(r.tools),
      model: r.model,
    } as AgentDefinition;
  }
  return defs;
}
```

- [ ] **Step 4: Run** `npx tsx --test src/fleet/roster/agent-defs.test.ts` → PASS. `npm run typecheck` → clean (confirm `AgentDefinition` import resolves; if its field names differ, adjust to the d.ts).

- [ ] **Step 5: Commit**
```bash
git add src/fleet/roster/agent-defs.ts src/fleet/roster/agent-defs.test.ts
git commit -m "feat(fleet): map roster to SDK AgentDefinitions"
```

---

## Task P4: SDK loader (`QueryFn` + graceful load)

**Files:** Create `src/fleet/sdk.ts`; Test `src/fleet/sdk.test.ts`.

- [ ] **Step 1: Write the failing test:**
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadQuery } from "./sdk";

test("loadQuery returns a function (SDK installed) or null", () => {
  const q = loadQuery();
  assert.ok(q === null || typeof q === "function");
});
```

- [ ] **Step 2: Run** `npx tsx --test src/fleet/sdk.test.ts` → FAIL (no module).

- [ ] **Step 3: Implement `src/fleet/sdk.ts`:**
```ts
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

/** The subset of the SDK query signature we depend on. Injected so tests fake it. */
export type QueryFn = (args: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>;

/** Lazily load the real SDK `query`. Returns null if the package can't be
 *  loaded (missing dep / incompatible env) so callers degrade gracefully. */
export function loadQuery(): QueryFn | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("@anthropic-ai/claude-agent-sdk");
    return typeof mod.query === "function" ? (mod.query as QueryFn) : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run** `npx tsx --test src/fleet/sdk.test.ts` → PASS. `npm run typecheck` → clean.

- [ ] **Step 5: Commit**
```bash
git add src/fleet/sdk.ts src/fleet/sdk.test.ts
git commit -m "feat(fleet): SDK query loader (injectable, graceful)"
```

---

## Task P5: event-map (SDK message → OrchestratorEvent[])

**Files:** Create `src/fleet/event-map.ts`; Test `src/fleet/event-map.test.ts`.

**Note:** Pure function. Maps assistant text → `agent_message`; assistant `tool_use` → `op_started`; user `tool_result` → `op_finished` (paired by `tool_use_id`); result → `result`(if name/url available via ctx) then nothing else; errors → `error`. Subagent attribution: prefer `parent_tool_use_id`→agent lookup via a ctx map; default `"orchestrator"`. The implementer confirms field access against `sdk.d.ts`.

- [ ] **Step 1: Write the failing test:**
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mapSdkMessage, type MapCtx } from "./event-map";

function ctx(): MapCtx { return { agentByToolUseId: new Map() }; }

test("assistant text -> agent_message", () => {
  const evs = mapSdkMessage({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "Planning the build." }] } } as any, ctx());
  assert.equal(evs[0].kind, "agent_message");
  assert.match((evs[0] as any).content, /Planning/);
});

test("assistant tool_use -> op_started", () => {
  const evs = mapSdkMessage({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "tu1", name: "Write", input: { file_path: "src/page.tsx" } }] } } as any, ctx());
  const op = evs.find((e) => e.kind === "op_started") as any;
  assert.ok(op);
  assert.equal(op.opKey, "tool:tu1");
});

test("user tool_result -> op_finished ok", () => {
  const c = ctx();
  c.agentByToolUseId.set("tu1", { agent: "react-engineer", title: "Write src/page.tsx" });
  const evs = mapSdkMessage({ type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok" }] } } as any, c);
  const fin = evs.find((e) => e.kind === "op_finished") as any;
  assert.ok(fin);
  assert.equal(fin.status, "ok");
  assert.equal(fin.agent, "react-engineer");
});

test("result success -> result+done; error -> error+done", () => {
  const ok = mapSdkMessage({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.1, result: "built" } as any, ctx());
  assert.ok(ok.some((e) => e.kind === "result"));
  assert.equal(ok.at(-1)!.kind, "done");
  const bad = mapSdkMessage({ type: "result", subtype: "error", is_error: true, total_cost_usd: 0.1 } as any, ctx());
  assert.ok(bad.some((e) => e.kind === "error"));
  assert.equal(bad.at(-1)!.kind, "done");
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement `src/fleet/event-map.ts`:**
```ts
import type { OrchestratorEvent } from "../agents/project-orchestrator";

export interface MapCtx {
  /** tool_use_id -> the agent + title that started it (filled as ops start). */
  agentByToolUseId: Map<string, { agent: string; title: string }>;
  /** Build identity used in the final result event. */
  result?: { name: string; url: string; stack: string };
}

/** Pure mapping from one SDK message to zero+ OrchestratorEvents. Defensive about
 *  field shape — confirm names against node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts. */
export function mapSdkMessage(msg: any, ctx: MapCtx): OrchestratorEvent[] {
  const out: OrchestratorEvent[] = [];
  const agent = subagentId(msg) ?? "orchestrator";

  if (msg?.type === "assistant") {
    for (const block of msg.message?.content ?? []) {
      if (block.type === "text" && block.text?.trim()) {
        out.push({ kind: "agent_message", agent, content: block.text.trim() });
      } else if (block.type === "tool_use") {
        const title = `${agent} · ${block.name}`;
        const opKey = `tool:${block.id}`;
        ctx.agentByToolUseId.set(block.id, { agent, title });
        out.push({ kind: "op_started", opKey, agent, title });
      }
    }
  } else if (msg?.type === "user") {
    for (const block of msg.message?.content ?? []) {
      if (block.type === "tool_result") {
        const started = ctx.agentByToolUseId.get(block.tool_use_id);
        const a = started?.agent ?? agent;
        const title = started?.title ?? `${a} · tool`;
        const detail = typeof block.content === "string" ? block.content.slice(0, 300) : "done";
        out.push({
          kind: "op_finished",
          opKey: `tool:${block.tool_use_id}`,
          agent: a,
          title,
          detail,
          status: block.is_error ? "failed" : "ok",
        });
      }
    }
  } else if (msg?.type === "result") {
    if (msg.is_error) {
      out.push({ kind: "error", error: msg.result ?? "build failed" });
    } else if (ctx.result) {
      out.push({ kind: "result", name: ctx.result.name, url: ctx.result.url, stack: ctx.result.stack });
    }
    out.push({ kind: "done" });
  }
  return out;
}

/** Best-effort subagent attribution. The SDK marks subagent output via
 *  parent_tool_use_id / agent fields; default to orchestrator when absent. */
function subagentId(msg: any): string | null {
  return msg?.agent_type ?? msg?.agent_id ?? null;
}
```

- [ ] **Step 4: Run** → PASS. Typecheck clean.

- [ ] **Step 5: Commit**
```bash
git add src/fleet/event-map.ts src/fleet/event-map.test.ts
git commit -m "feat(fleet): map SDK stream messages to OrchestratorEvents"
```

---

## Task P6: FleetSessionRegistry (live status for the org chart)

**Files:** Create `src/fleet/session-registry.ts`; Test `src/fleet/session-registry.test.ts`.

- [ ] **Step 1: Write the failing test:**
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { FleetSessionRegistry } from "./session-registry";

test("tracks per-agent status + active build count", () => {
  const r = new FleetSessionRegistry();
  assert.equal(r.activeBuilds(), 0);
  r.startBuild("p1");
  assert.equal(r.activeBuilds(), 1);
  r.setAgentStatus("p1", "react-engineer", "working");
  assert.equal(r.statusOf("react-engineer"), "working");
  r.setAgentStatus("p1", "react-engineer", "done");
  r.endBuild("p1");
  assert.equal(r.activeBuilds(), 0);
  assert.equal(r.statusOf("react-engineer"), "done");
});

test("unknown agent is idle", () => {
  const r = new FleetSessionRegistry();
  assert.equal(r.statusOf("nobody"), "idle");
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement `src/fleet/session-registry.ts`:**
```ts
import type { AgentSessionStatus } from "./types";

interface AgentLive { status: AgentSessionStatus; lastAt: string; }

export class FleetSessionRegistry {
  private active = new Set<string>();
  private agents = new Map<string, AgentLive>();

  startBuild(projectId: string): void { this.active.add(projectId); }
  endBuild(projectId: string): void { this.active.delete(projectId); }
  activeBuilds(): number { return this.active.size; }

  setAgentStatus(_projectId: string, agentId: string, status: AgentSessionStatus): void {
    this.agents.set(agentId, { status, lastAt: new Date().toISOString() });
  }
  statusOf(agentId: string): AgentSessionStatus { return this.agents.get(agentId)?.status ?? "idle"; }
  lastAtOf(agentId: string): string | undefined { return this.agents.get(agentId)?.lastAt; }
}
```

- [ ] **Step 4: Run** → PASS.

- [ ] **Step 5: Commit**
```bash
git add src/fleet/session-registry.ts src/fleet/session-registry.test.ts
git commit -m "feat(fleet): in-memory session registry for live agent status"
```

---

## Task P7: ClaudeFleet (the engine)

**Files:** Create `src/fleet/claude-fleet.ts`; Test `src/fleet/claude-fleet.test.ts`.

- [ ] **Step 1: Write the failing test** (injects a fake `QueryFn`):
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ClaudeFleet } from "./claude-fleet";
import { FleetSessionRegistry } from "./session-registry";
import type { OrchestratorEvent } from "../agents/project-orchestrator";

const plan = { name: "shop", stack: "Next.js", summary: "a shop", kind: "live_app" } as any;

function fakeQuery(capture: { options?: any }) {
  return async function* ({ options }: any) {
    capture.options = options;
    yield { type: "system", subtype: "init" };
    yield { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "Building." }] } };
    yield { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: "page.tsx" } }] } };
    yield { type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "wrote page.tsx" }] } };
    yield { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.05, result: "done" };
  };
}

test("build streams events and passes safe options to query", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "cf-"));
  const cap: { options?: any } = {};
  const events: OrchestratorEvent[] = [];
  const fleet = new ClaudeFleet({ query: fakeQuery(cap), workspaceRoot: root, registry: new FleetSessionRegistry() });
  await fleet.build({ projectId: "p1", plan, onEvent: (e) => events.push(e) });
  assert.ok(events.some((e) => e.kind === "agent_message"));
  assert.ok(events.some((e) => e.kind === "op_started"));
  assert.ok(events.some((e) => e.kind === "result"));
  assert.equal(events.at(-1)!.kind, "done");
  assert.equal(cap.options.permissionMode, "dontAsk");
  assert.equal(cap.options.cwd, path.resolve(root, "p1", "workspace"));
  assert.ok(cap.options.maxTurns >= 1 && cap.options.maxBudgetUsd > 0);
  assert.ok(Array.isArray(cap.options.disallowedTools) && cap.options.disallowedTools.length > 0);
});

test("offline (null query) emits a message + done, no fake success", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "cf-"));
  const events: OrchestratorEvent[] = [];
  const fleet = new ClaudeFleet({ query: null, workspaceRoot: root, registry: new FleetSessionRegistry() });
  await fleet.build({ projectId: "p2", plan, onEvent: (e) => events.push(e) });
  assert.ok(events.some((e) => e.kind === "agent_message" && /offline|ANTHROPIC/i.test((e as any).content)));
  assert.equal(events.at(-1)!.kind, "done");
  assert.ok(!events.some((e) => e.kind === "result"));
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement `src/fleet/claude-fleet.ts`:**
```ts
import { mkdir } from "node:fs/promises";
import type { QueryFn } from "./sdk";
import type { DeployPlan } from "../ai/deploy-planner";
import type { OrchestratorEventHandler } from "../agents/project-orchestrator";
import { workspaceDir } from "./workspace";
import { agentDefinitions } from "./roster/agent-defs";
import { mapSdkMessage, type MapCtx } from "./event-map";
import { FleetSessionRegistry } from "./session-registry";
import { fleetConfig } from "./config";

const DISALLOWED = [
  "Bash(rm:*)", "Bash(sudo:*)", "Bash(git push:*)", "Bash(curl:*)", "Bash(wget:*)",
];
const ALLOWED = ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "Agent"];

export interface ClaudeFleetDeps {
  query: QueryFn | null;
  workspaceRoot: string;
  registry: FleetSessionRegistry;
}

export class ClaudeFleet {
  private inFlight = 0;
  constructor(private deps: ClaudeFleetDeps) {}

  async build(input: { projectId: string; plan: DeployPlan; onEvent: OrchestratorEventHandler }): Promise<void> {
    const prompt =
      `You are 00-orchestrator, driver + approval gate of Cantila's build fleet. Build a shippable MVP for this request, ` +
      `delegating to specialist subagents (use the Agent tool). Write real files into the working directory — no mock data. ` +
      `Request: "${input.plan.summary}". Project name: ${input.plan.name}. Stack: ${input.plan.stack}. ` +
      `Keep scope tight; stop when the core flow works.`;
    await this.run(input.projectId, prompt, input.onEvent, {
      name: input.plan.name, url: `${input.plan.name}.cantila.app`, stack: input.plan.stack,
    });
  }

  async chat(input: { projectId: string; message: string; onEvent: OrchestratorEventHandler }): Promise<void> {
    await this.run(input.projectId, input.message, input.onEvent, {
      name: input.projectId, url: `${input.projectId}.cantila.app`, stack: "",
    });
  }

  private async run(projectId: string, prompt: string, onEvent: OrchestratorEventHandler, result: { name: string; url: string; stack: string }): Promise<void> {
    const cfg = fleetConfig();
    if (!this.deps.query) {
      onEvent({ kind: "agent_message", agent: "orchestrator", content: "Fleet is offline — set ANTHROPIC_API_KEY and install the Claude Agent SDK to run a live build." });
      onEvent({ kind: "done" });
      return;
    }
    if (this.inFlight >= cfg.maxConcurrentBuilds) {
      onEvent({ kind: "agent_message", agent: "orchestrator", content: "Fleet is at capacity; queued. Try again shortly." });
      onEvent({ kind: "done" });
      return;
    }
    this.inFlight++;
    this.deps.registry.startBuild(projectId);
    const cwd = workspaceDir(this.deps.workspaceRoot, projectId);
    await mkdir(cwd, { recursive: true });
    const ctx: MapCtx = { agentByToolUseId: new Map(), result };
    try {
      const stream = this.deps.query({
        prompt,
        options: {
          cwd,
          agents: agentDefinitions(),
          allowedTools: ALLOWED,
          disallowedTools: DISALLOWED,
          permissionMode: "dontAsk",
          maxTurns: cfg.maxAgentSteps * cfg.maxRounds,
          maxBudgetUsd: cfg.maxBudgetUsd,
          model: "opus",
        } as any,
      });
      for await (const msg of stream) {
        for (const ev of mapSdkMessage(msg, ctx)) {
          if (ev.kind === "op_started") this.deps.registry.setAgentStatus(projectId, ev.agent, "working");
          if (ev.kind === "op_finished") this.deps.registry.setAgentStatus(projectId, ev.agent, ev.status === "ok" ? "done" : "failed");
          onEvent(ev);
        }
      }
    } catch (err) {
      onEvent({ kind: "error", error: err instanceof Error ? err.message : "fleet run failed" });
      onEvent({ kind: "done" });
    } finally {
      this.inFlight--;
      this.deps.registry.endBuild(projectId);
    }
  }
}
```

- [ ] **Step 4: Run** → PASS (2 tests). Typecheck clean (cast `options as any` covers SDK option-name drift; the implementer may instead import `Options` and type precisely).

- [ ] **Step 5: Commit**
```bash
git add src/fleet/claude-fleet.ts src/fleet/claude-fleet.test.ts
git commit -m "feat(fleet): ClaudeFleet engine over the Agent SDK"
```

---

## Task P8: Wire ClaudeFleet into ProjectOrchestrator

**Files:** Modify `src/agents/project-orchestrator.ts`; Test `src/agents/project-orchestrator.fleet.test.ts`.

- [ ] **Step 1: Write the failing integration test:**
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProjectOrchestrator, type OrchestratorEvent } from "./project-orchestrator";

const planner = { async plan() { return { name: "shop", stack: "Next.js", summary: "a shop", kind: "live_app", runtime: "node", region: "fsn1", services: { needsDatabase: false, needsMail: false, needsSms: false }, buildPlan: [], media: { logo: false, hero: false, favicon: false, iconSet: false, heroAnimation: false, socialOgImage: false } }; } };
const images = { async generateImage() { return { dataUrl: "x", mimeType: "image/svg+xml", width: 1, height: 1, provider: "fake" }; }, async generateAnimation() { return { content: "{}", mode: "lottie" as const, mimeType: "application/json", provider: "fake" }; } };

function fakeQuery() {
  return async function* ({ options }: any) {
    yield { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: "page.tsx" } }] } };
    // simulate the Write tool actually creating the file the orchestrator persists separately;
    // here we just assert the event flow + that build completes.
    yield { type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } };
    yield { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.01, result: "done" };
  };
}

test("runBuild delegates to the fleet and streams result+done; messages persist", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "po-"));
  const events: OrchestratorEvent[] = [];
  const orch = new ProjectOrchestrator({ cp: {} as any, planner: planner as any, images: images as any, fleet: { query: fakeQuery(), workspaceRoot: root } } as any);
  await orch.runBuild({ projectId: "p1", plan: await planner.plan() as any, onEvent: (e) => events.push(e) });
  assert.ok(events.some((e) => e.kind === "result"));
  assert.equal(events.at(-1)!.kind, "done");
  assert.ok(orch.listMessages("p1").length > 0);
});
```

- [ ] **Step 2: Run** `npx tsx --test src/agents/project-orchestrator.fleet.test.ts` → FAIL.

- [ ] **Step 3: Edit `src/agents/project-orchestrator.ts`:**

3a. Add imports near the top:
```ts
import { ClaudeFleet } from "../fleet/claude-fleet";
import { FleetSessionRegistry } from "../fleet/session-registry";
import { loadQuery, type QueryFn } from "../fleet/sdk";
```

3b. Extend `ProjectOrchestratorDeps`:
```ts
  /** Fleet wiring. Defaults to the real SDK query + env workspace root. Tests inject a fake query. */
  fleet?: { query?: QueryFn | null; workspaceRoot?: string; registry?: FleetSessionRegistry };
```

3c. In the constructor body add:
```ts
    const query = this.deps.fleet?.query !== undefined ? this.deps.fleet.query : loadQuery();
    const workspaceRoot = this.deps.fleet?.workspaceRoot ?? process.env.FLEET_WORKSPACE_ROOT ?? "runtime/projects";
    this.sessionRegistry = this.deps.fleet?.registry ?? new FleetSessionRegistry();
    this.claudeFleet = new ClaudeFleet({ query, workspaceRoot, registry: this.sessionRegistry });
```
and add the fields:
```ts
  private claudeFleet: ClaudeFleet;
  readonly sessionRegistry: FleetSessionRegistry;
```

3d. Replace the body of `runBuild` with:
```ts
  async runBuild(input: { projectId: string; plan: DeployPlan; onEvent: OrchestratorEventHandler }): Promise<void> {
    await this.claudeFleet.build({ projectId: input.projectId, plan: input.plan, onEvent: (e) => this.persistAndForward(input.projectId, e, input.onEvent) });
  }
```

3e. Replace the body of `runChat` with:
```ts
  async runChat(input: { projectId: string; message: string; onEvent: OrchestratorEventHandler }): Promise<void> {
    this.appendMessage(input.projectId, { role: "user", kind: "message", content: input.message }, input.onEvent);
    await this.claudeFleet.chat({ projectId: input.projectId, message: input.message, onEvent: (e) => this.persistAndForward(input.projectId, e, input.onEvent) });
  }
```

3f. Add the bridge method:
```ts
  private persistAndForward(projectId: string, e: OrchestratorEvent, onEvent: OrchestratorEventHandler): void {
    switch (e.kind) {
      case "agent_message":
        this.ensure(projectId).messages.push(this.makeMessage({ projectId, role: "agent", agent: e.agent, kind: "message", content: e.content }));
        break;
      case "op_started":
        this.ensure(projectId).messages.push(this.makeMessage({ projectId, role: "agent", agent: e.agent, kind: "op_card", content: e.title, metadata: { opKey: e.opKey, status: "running" } }));
        break;
      case "op_finished":
        this.ensure(projectId).messages.push(this.makeMessage({ projectId, role: "agent", agent: e.agent, kind: "op_card", content: e.title, metadata: { opKey: e.opKey, status: e.status === "ok" ? "done" : "failed", detail: e.detail } }));
        break;
      case "asset_created":
        this.ensure(projectId).assets.push(e.asset);
        break;
      case "result":
        this.ensure(projectId).messages.push(this.makeMessage({ projectId, role: "agent", agent: "orchestrator", kind: "result", content: `${e.name} is ready.`, metadata: { name: e.name, url: e.url, stack: e.stack } }));
        break;
      default: break;
    }
    onEvent(e);
  }
```

3g. Remove the now-dead simulated internals only if unreferenced: `runOp`, `classifyIntent`, `defaultReply`, `generateAndPersistImage`, `generateAndPersistAnimation`, `Intent` type, `slugify`, `sleep`, `estimateBytes`. Keep `ensure`, `makeMessage`, `appendMessage`, `seedFromDeploy`, `listMessages`, `listAssets`, `getBrain`, `nowIso`, `estimateTokens` (still referenced). Run typecheck to confirm what's unused.

- [ ] **Step 4: Run** the integration test → PASS. Then `npm run typecheck` → clean.

- [ ] **Step 5: Commit**
```bash
git add src/agents/project-orchestrator.ts src/agents/project-orchestrator.fleet.test.ts
git commit -m "feat(fleet): delegate ProjectOrchestrator build/chat to ClaudeFleet"
```

---

## Task P9: GET /v1/agents/org endpoint

**Files:** Modify `src/index.ts`; Create `src/fleet/org.ts` (+ test `src/fleet/org.test.ts`).

- [ ] **Step 1: Write the failing test** `src/fleet/org.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAgentOrg } from "./org";
import { FleetSessionRegistry } from "./session-registry";

test("buildAgentOrg groups roster by division with live status", () => {
  const reg = new FleetSessionRegistry();
  reg.setAgentStatus("p1", "react-engineer", "working");
  const org = buildAgentOrg(reg);
  assert.ok(org.divisions.length >= 5);
  const fe = org.divisions.find((d) => d.agents.some((a) => a.id === "react-engineer"));
  assert.ok(fe);
  const re = fe!.agents.find((a) => a.id === "react-engineer")!;
  assert.equal(re.status, "working");
  assert.equal(typeof org.activeBuilds, "number");
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement `src/fleet/org.ts`:**
```ts
import { rolesByDivision } from "./roster/index";
import type { FleetSessionRegistry } from "./session-registry";
import type { AgentSessionStatus } from "./types";

export interface OrgAgent { id: string; name: string; model: string; description: string; status: AgentSessionStatus; lastAt?: string; }
export interface OrgDivision { key: string; label: string; agents: OrgAgent[]; }
export interface AgentOrg { divisions: OrgDivision[]; activeBuilds: number; }

function label(key: string): string { return key.charAt(0).toUpperCase() + key.slice(1).replace(/-/g, " "); }

export function buildAgentOrg(registry: FleetSessionRegistry): AgentOrg {
  const byDiv = rolesByDivision();
  const divisions: OrgDivision[] = Object.entries(byDiv).map(([key, roles]) => ({
    key,
    label: label(key),
    agents: roles.map((r) => ({
      id: r.id, name: r.name, model: r.model, description: r.description,
      status: registry.statusOf(r.id), lastAt: registry.lastAtOf(r.id),
    })),
  }));
  return { divisions, activeBuilds: registry.activeBuilds() };
}
```

- [ ] **Step 4: Run** → PASS.

- [ ] **Step 5: Wire the endpoint in `src/index.ts`** — near the other `/v1/agents/*` routes add:
```ts
app.get("/v1/agents/org", async () => {
  const { buildAgentOrg } = await import("./fleet/org");
  return buildAgentOrg(projectOrchestrator.sessionRegistry);
});
```
(Confirm `projectOrchestrator` is in scope there — it is, constructed earlier in the file.)

- [ ] **Step 6: Run** `npm run typecheck` → clean.

- [ ] **Step 7: Commit**
```bash
git add src/fleet/org.ts src/fleet/org.test.ts src/index.ts
git commit -m "feat(fleet): GET /v1/agents/org — live org chart data"
```

---

## Task P10: Console — org-chart API + component (separate repo)

**Files (in `cantila-console`):** Modify `src/lib/api.ts`; Create `src/components/agents/FleetOrgChart.tsx`; Modify `src/components/AgentsView.tsx`.

**Setup note:** The console is a SEPARATE git repo at `cantila-console/`. The implementer creates branch `feat/fleet-org-chart` there (not the control-plane worktree). It has no Node test runner; verification is `npm run build` / `npx tsc --noEmit` + a render check.

- [ ] **Step 1: Add to `src/lib/api.ts`** — types + method (place near the other agent types/methods):
```ts
export type ApiAgentSessionStatus = "idle" | "working" | "done" | "failed";
export interface ApiOrgAgent { id: string; name: string; model: string; description: string; status: ApiAgentSessionStatus; lastAt?: string; }
export interface ApiOrgDivision { key: string; label: string; agents: ApiOrgAgent[]; }
export interface ApiAgentOrg { divisions: ApiOrgDivision[]; activeBuilds: number; }
```
and in the `api` object:
```ts
  getAgentOrg: () => request<ApiAgentOrg>("/agents/org"),
```

- [ ] **Step 2: Create `src/components/agents/FleetOrgChart.tsx`** — a client component that polls `api.getAgentOrg()` every 5s and renders divisions as labelled groups with agent nodes + a status dot (idle=muted, working=ember pulse, done=live/green, failed=down/red). Use existing `cx`/tokens from `@/components/ui`. Full code:
```tsx
"use client";
import { useEffect, useState } from "react";
import { api, isControlPlaneLive, type ApiAgentOrg, type ApiAgentSessionStatus } from "@/lib/api";
import { cx } from "@/components/ui";

const DOT: Record<ApiAgentSessionStatus, string> = {
  idle: "bg-ink-faint/40",
  working: "bg-ember animate-pulse",
  done: "bg-live",
  failed: "bg-down",
};

export default function FleetOrgChart() {
  const [org, setOrg] = useState<ApiAgentOrg | null>(null);
  const [live, setLive] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    void (async () => {
      const ok = await isControlPlaneLive();
      if (cancelled) return;
      setLive(ok);
      if (!ok) return;
      const load = async () => { try { const o = await api.getAgentOrg(); if (!cancelled) setOrg(o); } catch {} };
      void load();
      timer = window.setInterval(load, 5000);
    })();
    return () => { cancelled = true; if (timer) window.clearInterval(timer); };
  }, []);

  if (live === false) return <div className="panel py-6 text-center text-2xs text-ink-faint">Control plane offline.</div>;
  if (!org) return <div className="panel py-6 text-center text-2xs text-ink-faint">Loading the fleet…</div>;

  return (
    <div className="space-y-4">
      <p className="text-2xs text-ink-faint">
        {org.divisions.reduce((n, d) => n + d.agents.length, 0)} agents · {org.divisions.length} divisions · {org.activeBuilds} active build{org.activeBuilds === 1 ? "" : "s"}
      </p>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {org.divisions.map((d) => (
          <div key={d.key} className="panel p-3">
            <h3 className="kv mb-2 text-ink-dim">{d.label}</h3>
            <ul className="space-y-1">
              {d.agents.map((a) => (
                <li key={a.id} className="flex items-center gap-2 text-2xs">
                  <span className={cx("h-1.5 w-1.5 shrink-0 rounded-full", DOT[a.status])} />
                  <span className="font-mono text-ink">{a.name}</span>
                  <span className="ml-auto rounded bg-surface-2 px-1 py-0.5 text-[0.55rem] uppercase tracking-wider text-ink-faint">{a.model}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Edit `src/components/AgentsView.tsx`** — render `FleetOrgChart` as the primary surface at the top of the returned tree (under the existing `PageHeader`), keeping the existing ops-brain canvas + learnings/proposals/actions sections below under a heading like "Operations brain". Minimal change: `import FleetOrgChart from "@/components/agents/FleetOrgChart";` and insert `<section><h2 className="kv mb-3 text-ink-dim">The whole operation</h2><FleetOrgChart /></section>` immediately after `<PageHeader … />`. Do not remove existing sections.

- [ ] **Step 4: Verify** in `cantila-console`:
```bash
npx tsc --noEmit
```
Expected: no errors. (If the console has a build script, optionally `npm run build`.)

- [ ] **Step 5: Commit** (in the console repo, branch `feat/fleet-org-chart`):
```bash
git add src/lib/api.ts src/components/agents/FleetOrgChart.tsx src/components/AgentsView.tsx
git commit -m "feat(agents): live fleet org-chart on /agents"
```

---

## Task P11: Full suite + manual smoke

- [ ] **Step 1:** Control-plane fleet + agents tests:
```bash
npx tsx --test src/fleet/**/*.test.ts src/fleet/*.test.ts src/agents/*.test.ts
```
Expected: all PASS.

- [ ] **Step 2:** `npm run typecheck` (control plane) → clean. `npx tsc --noEmit` (console) → clean.

- [ ] **Step 3 (manual, live — uses real API + tokens):** From the worktree, `npm run dev` (loads `.env.local` → `ANTHROPIC_API_KEY` set). In the console, open `/chat`, send "build a simple landing page for a coffee shop". Confirm: redirect to the workspace; op cards stream attributed to real agents; files appear under `runtime/projects/<id>/workspace`; `/agents` shows agents flipping to working/done. Stop after one short build to bound cost. Record the observed cost from the result.

- [ ] **Step 4: Commit** any fixes:
```bash
git add -A && git commit -m "test(fleet): Phase 1 suite green + smoke notes"
```

---

## Self-Review notes (author)
- **Spec coverage:** SDK dep+npmrc (P0), config/types (P1), roster port (P2), AgentDefinition mapping (P3), SDK loader (P4), event-map (P5), session registry (P6), ClaudeFleet engine with safe options + offline + concurrency (P7), ProjectOrchestrator delegation + persistence bridge, no SSE change (P8), /v1/agents/org (P9), console org-chart + preserved ops brain (P10), suite+smoke (P11). Safety (permissionMode/disallowedTools/cwd/budget) in P7.
- **Controlled deviation:** exact SDK message/option field names are confirmed against `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` at implementation time; `event-map`/`claude-fleet` are written defensively and use `as any` on the options object to tolerate field drift. This is the one place the plan defers exact field access to the installed types — intentional, because guessing private field names would be worse.
- **Type consistency:** `QueryFn` (sdk.ts), `MapCtx` (event-map.ts), `AgentSessionStatus`/`SdkToolName` (types.ts), `AgentRoleRaw` (roster/types.ts), `AgentOrg` (org.ts) each defined once and imported. Events/`ProjectAsset` from project-orchestrator.ts.
- **Cross-repo:** P10 is the only console-repo task; it gets its own branch there.
