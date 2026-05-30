# Fleet Build Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the simulated internals of `ProjectOrchestrator.runBuild`/`runChat` with a real, generic, Anthropic-SDK-backed multi-agent engine that wires all 78 AgentFleet agents into Cantila's chat → project-builder flow, producing real files in a per-project workspace and streaming the existing `OrchestratorEvent` shape.

**Architecture:** New code under `src/fleet/`. The 78 agents are ported (build-time) from `AgentFleet/.claude/agents/**/*.md` into a committed `roster.generated.ts`. A skill registry (file/media/memory tools) gives agents their only side effects, sandboxed to `runtime/projects/<id>/workspace`. A `FleetAgentRunner` runs any role as a bounded Anthropic tool-use loop; a `FleetOrchestrator` plans (DoD + batches), fans out agents with capped concurrency, runs the approve/changes-requested gate, QAs against the DoD, and loops within a budget. `ProjectOrchestrator` delegates to it; no HTTP/SSE/UI changes.

**Tech Stack:** TypeScript (CommonJS), `@anthropic-ai/sdk@^0.98`, `tsx` runtime, `node:test` + `node:assert/strict`, existing `ImageProvider` port. Tests run via `npx tsx --test <file>`.

---

## Conventions (read once)

- **Test framework:** `node:test`. Each test file: `import { test } from "node:test"; import assert from "node:assert/strict";`. Run a file with `npx tsx --test src/fleet/<x>.test.ts`. Tests are colocated next to source (e.g. `src/fleet/memory.test.ts`).
- **Module style:** CommonJS output, but source uses ESM `import`/`export` (tsx handles it), matching existing `src/` files. Use `.js`-less relative imports like the rest of `src/`.
- **No real network in tests:** the Anthropic client is always injected as a parameter so tests pass a fake. Never call the real API in a test.
- **Commit after every task** on branch `feat/fleet-build-engine` (already created).
- **Event shape is fixed:** reuse `OrchestratorEvent` / `OrchestratorEventHandler` / `ProjectAsset` from `src/agents/project-orchestrator.ts`. Do not redefine them.

---

## File Structure

```
src/fleet/
  config.ts                 # caps + FLEET_LIVE flag
  types.ts                  # AgentRole, Handoff, DoDItem, BuildPlan, fleet-internal types
  workspace.ts              # per-project workspace dir resolution + path-traversal guard
  memory.ts                 # FleetMemory (in-memory shared state + handoff state machine)
  roster/
    index.ts                # getRole / listRoles / rolesByDivision (reads roster.generated)
    roster.generated.ts     # 78 AgentRole records (produced by scripts/port-fleet.mjs)
  skills/
    tool-map.ts             # AgentFleet `tools:` line -> SkillId[]
    files.ts                # write_file / read_file / list_files
    media.ts                # generate_image / generate_animation
    memory-skills.ts        # read_memory / write_handoff
    index.ts                # SkillRegistry: id -> { tool, run }
  runner.ts                 # FleetAgentRunner (bounded tool-use loop)
  orchestrator.ts           # FleetOrchestrator (plan -> batches -> review -> QA -> loop)
  anthropic.ts              # thin client factory + AnthropicLike interface (for test fakes)
scripts/
  port-fleet.mjs            # md -> roster.generated.ts (re-runnable, committed output)
src/agents/project-orchestrator.ts   # EDIT: delegate runBuild/runChat to FleetOrchestrator
```

Tests live beside their source as `*.test.ts`.

---

## Task 1: Fleet config + caps

**Files:**
- Create: `src/fleet/config.ts`
- Test: `src/fleet/config.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { fleetConfig } from "./config";

test("fleetConfig exposes positive caps and a boolean live flag", () => {
  const c = fleetConfig();
  assert.equal(typeof c.live, "boolean");
  assert.ok(c.maxRounds >= 1);
  assert.ok(c.maxAgentSteps >= 1);
  assert.ok(c.maxConcurrency >= 1);
  assert.ok(c.buildTokenBudget > 0);
});

test("fleetConfig reads ANTHROPIC_API_KEY for the live flag", () => {
  const prev = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-test";
  assert.equal(fleetConfig().live, true);
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal(fleetConfig().live, false);
  if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/fleet/config.test.ts`
Expected: FAIL — cannot find module `./config`.

- [ ] **Step 3: Write minimal implementation**

```ts
/* Fleet engine configuration + safety caps. Env-overridable; sane defaults. */

export interface FleetConfig {
  /** True when a real Anthropic key is configured. */
  live: boolean;
  /** Max build→review→fix rounds before the loop stops. */
  maxRounds: number;
  /** Max tool-use turns a single agent may take. */
  maxAgentSteps: number;
  /** Max agents running at once within a batch. */
  maxConcurrency: number;
  /** Soft cap on total output tokens spent in one build. */
  buildTokenBudget: number;
}

function num(envKey: string, fallback: number): number {
  const raw = process.env[envKey];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function fleetConfig(): FleetConfig {
  return {
    live: !!process.env.ANTHROPIC_API_KEY,
    maxRounds: num("FLEET_MAX_ROUNDS", 4),
    maxAgentSteps: num("FLEET_MAX_AGENT_STEPS", 8),
    maxConcurrency: num("FLEET_MAX_CONCURRENCY", 4),
    buildTokenBudget: num("FLEET_BUILD_TOKEN_BUDGET", 300_000),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/fleet/config.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/fleet/config.ts src/fleet/config.test.ts
git commit -m "feat(fleet): config + safety caps"
```

---

## Task 2: Fleet types

**Files:**
- Create: `src/fleet/types.ts`
- Test: `src/fleet/types.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { isAgentRole, HANDOFF_STATUSES } from "./types";

test("isAgentRole accepts a well-formed role", () => {
  assert.equal(
    isAgentRole({
      id: "react-engineer",
      name: "react-engineer",
      division: "frontend",
      description: "builds UI",
      model: "sonnet",
      allowedSkills: ["write_file"],
      systemPrompt: "You are react-engineer.",
    }),
    true,
  );
});

test("isAgentRole rejects a bad model", () => {
  assert.equal(
    isAgentRole({
      id: "x", name: "x", division: "d", description: "",
      model: "haiku", allowedSkills: [], systemPrompt: "p",
    }),
    false,
  );
});

test("handoff statuses are the three contract states", () => {
  assert.deepEqual([...HANDOFF_STATUSES], [
    "pending-review",
    "approved",
    "changes-requested",
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/fleet/types.test.ts`
Expected: FAIL — cannot find module `./types`.

- [ ] **Step 3: Write minimal implementation**

```ts
/* Fleet-internal types. Runtime events (OrchestratorEvent, ProjectAsset) are
   imported from ../agents/project-orchestrator and intentionally NOT redefined. */

export type AgentModel = "opus" | "sonnet";
export type SkillId =
  | "write_file"
  | "read_file"
  | "list_files"
  | "generate_image"
  | "generate_animation"
  | "read_memory"
  | "write_handoff";

export interface AgentRole {
  id: string;
  name: string;
  division: string;
  description: string;
  model: AgentModel;
  allowedSkills: SkillId[];
  systemPrompt: string;
}

export const HANDOFF_STATUSES = [
  "pending-review",
  "approved",
  "changes-requested",
] as const;
export type HandoffStatus = (typeof HANDOFF_STATUSES)[number];

export interface Handoff {
  agent: string;
  round: number;
  status: HandoffStatus;
  reviewer?: string;
  feedback?: string;
  /** Free-text body: what was done / decisions / next / artifacts. */
  body: string;
  updatedAt: string;
}

export interface DoDItem {
  id: string;
  text: string;
  done: boolean;
}

export interface BuildBatch {
  /** Agent ids that run concurrently in this batch. */
  agents: string[];
}

export interface BuildPlan {
  dod: string[];
  batches: BuildBatch[];
}

const VALID_MODELS = new Set<AgentModel>(["opus", "sonnet"]);

export function isAgentRole(v: unknown): v is AgentRole {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.name === "string" &&
    typeof r.division === "string" &&
    typeof r.description === "string" &&
    typeof r.model === "string" &&
    VALID_MODELS.has(r.model as AgentModel) &&
    Array.isArray(r.allowedSkills) &&
    typeof r.systemPrompt === "string"
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/fleet/types.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/fleet/types.ts src/fleet/types.test.ts
git commit -m "feat(fleet): core types + role/handoff guards"
```

---

## Task 3: Workspace path sandbox

**Files:**
- Create: `src/fleet/workspace.ts`
- Test: `src/fleet/workspace.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { workspaceDir, resolveInWorkspace } from "./workspace";
import path from "node:path";

test("workspaceDir nests under the root by project id", () => {
  const dir = workspaceDir("/tmp/projroot", "proj_123");
  assert.equal(dir, path.resolve("/tmp/projroot", "proj_123", "workspace"));
});

test("resolveInWorkspace allows a normal relative path", () => {
  const ws = workspaceDir("/tmp/projroot", "p1");
  const abs = resolveInWorkspace(ws, "src/app/page.tsx");
  assert.equal(abs, path.join(ws, "src/app/page.tsx"));
});

test("resolveInWorkspace rejects traversal and absolute paths", () => {
  const ws = workspaceDir("/tmp/projroot", "p1");
  assert.throws(() => resolveInWorkspace(ws, "../../etc/passwd"), /outside workspace/);
  assert.throws(() => resolveInWorkspace(ws, "/etc/passwd"), /outside workspace/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/fleet/workspace.test.ts`
Expected: FAIL — cannot find module `./workspace`.

- [ ] **Step 3: Write minimal implementation**

```ts
import path from "node:path";

/** Absolute workspace dir for a project: <root>/<projectId>/workspace. */
export function workspaceDir(root: string, projectId: string): string {
  return path.resolve(root, projectId, "workspace");
}

/** Resolve a caller-supplied relative path inside the workspace, refusing any
 *  path that escapes it (traversal or absolute). */
export function resolveInWorkspace(ws: string, relPath: string): string {
  const abs = path.resolve(ws, relPath);
  const rel = path.relative(ws, abs);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`path outside workspace: ${relPath}`);
  }
  return abs;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/fleet/workspace.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/fleet/workspace.ts src/fleet/workspace.test.ts
git commit -m "feat(fleet): workspace path sandbox"
```

---

## Task 4: FleetMemory (shared state + handoff state machine)

**Files:**
- Create: `src/fleet/memory.ts`
- Test: `src/fleet/memory.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { FleetMemory } from "./memory";

test("setDoD + checkDoD toggles items", () => {
  const m = new FleetMemory("proj_1");
  m.setDoD(["app builds", "core flow works"]);
  const read = m.read();
  assert.equal(read.dod.length, 2);
  const firstId = read.dod[0].id;
  m.checkDoD(firstId, true);
  assert.equal(m.read().dod[0].done, true);
  assert.equal(m.allDoDPassed(), false);
});

test("putHandoff stores pending-review; review approves it", () => {
  const m = new FleetMemory("proj_1");
  m.putHandoff({ agent: "react-engineer", round: 1, status: "pending-review", body: "did x" });
  assert.equal(m.read().handoffs["react-engineer"].status, "pending-review");
  m.review("react-engineer", "approved");
  const h = m.read().handoffs["react-engineer"];
  assert.equal(h.status, "approved");
  assert.equal(h.reviewer, "00-orchestrator");
});

test("changes-requested carries feedback and bumps round on re-put", () => {
  const m = new FleetMemory("proj_1");
  m.putHandoff({ agent: "api-engineer", round: 1, status: "pending-review", body: "v1" });
  m.review("api-engineer", "changes-requested", "add validation");
  assert.equal(m.read().handoffs["api-engineer"].status, "changes-requested");
  assert.equal(m.read().handoffs["api-engineer"].feedback, "add validation");
  m.putHandoff({ agent: "api-engineer", round: 2, status: "pending-review", body: "v2" });
  assert.equal(m.read().handoffs["api-engineer"].round, 2);
  assert.equal(m.read().handoffs["api-engineer"].status, "pending-review");
});

test("relevantSlice stays under a size bound", () => {
  const m = new FleetMemory("proj_1");
  m.setProject({ name: "shop", goal: "sell things", stack: "Next.js", status: "building" });
  m.setDoD(["a", "b"]);
  for (let i = 0; i < 50; i++) m.appendDecision(`decision ${i} `.repeat(20));
  const slice = m.relevantSlice("react-engineer");
  assert.ok(slice.length <= 4000, `slice too big: ${slice.length}`);
  assert.match(slice, /shop/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/fleet/memory.test.ts`
Expected: FAIL — cannot find module `./memory`.

- [ ] **Step 3: Write minimal implementation**

```ts
import { randomBytes } from "node:crypto";
import type { DoDItem, Handoff, HandoffStatus } from "./types";

export interface FleetProject {
  name: string;
  goal: string;
  stack: string;
  status: string;
}

export interface FleetMemorySnapshot {
  projectId: string;
  project: FleetProject;
  dod: DoDItem[];
  decisions: string[];
  summary: string;
  handoffs: Record<string, Handoff>;
}

const SLICE_MAX = 4000;

export class FleetMemory {
  private project: FleetProject = { name: "", goal: "", stack: "", status: "new" };
  private dod: DoDItem[] = [];
  private decisions: string[] = [];
  private summary = "";
  private handoffs: Map<string, Handoff> = new Map();

  constructor(public readonly projectId: string) {}

  setProject(p: Partial<FleetProject>): void {
    this.project = { ...this.project, ...p };
  }

  setDoD(items: string[]): void {
    this.dod = items.map((text) => ({
      id: `dod_${randomBytes(4).toString("hex")}`,
      text,
      done: false,
    }));
  }

  checkDoD(id: string, done: boolean): void {
    const item = this.dod.find((d) => d.id === id);
    if (item) item.done = done;
  }

  allDoDPassed(): boolean {
    return this.dod.length > 0 && this.dod.every((d) => d.done);
  }

  appendDecision(text: string): void {
    this.decisions.push(text.trim());
  }

  setSummary(text: string): void {
    this.summary = text;
  }

  putHandoff(h: Omit<Handoff, "updatedAt">): void {
    this.handoffs.set(h.agent, { ...h, updatedAt: new Date().toISOString() });
  }

  review(agent: string, verdict: Exclude<HandoffStatus, "pending-review">, feedback?: string): void {
    const h = this.handoffs.get(agent);
    if (!h) return;
    h.status = verdict;
    h.reviewer = "00-orchestrator";
    h.feedback = verdict === "changes-requested" ? feedback : undefined;
    h.updatedAt = new Date().toISOString();
  }

  read(): FleetMemorySnapshot {
    return {
      projectId: this.projectId,
      project: { ...this.project },
      dod: this.dod.map((d) => ({ ...d })),
      decisions: this.decisions.slice(),
      summary: this.summary,
      handoffs: Object.fromEntries(this.handoffs),
    };
  }

  /** Compact, size-bounded context an agent should read before working. */
  relevantSlice(agentId: string): string {
    const lines: string[] = [];
    lines.push(`Project: ${this.project.name || "(unnamed)"} — ${this.project.goal || ""}`);
    lines.push(`Stack: ${this.project.stack || "TypeScript/Next.js"}`);
    lines.push("MVP Definition-of-Done:");
    for (const d of this.dod) lines.push(`  [${d.done ? "x" : " "}] ${d.text}`);
    const own = this.handoffs.get(agentId);
    if (own?.feedback) lines.push(`Reviewer feedback for you: ${own.feedback}`);
    const recentDecisions = this.decisions.slice(-8);
    if (recentDecisions.length) {
      lines.push("Recent decisions:");
      for (const d of recentDecisions) lines.push(`  - ${d.slice(0, 200)}`);
    }
    const approved = [...this.handoffs.values()].filter((h) => h.status === "approved");
    if (approved.length) {
      lines.push("Approved work so far:");
      for (const h of approved.slice(-8)) lines.push(`  - ${h.agent}: ${h.body.slice(0, 160)}`);
    }
    return lines.join("\n").slice(0, SLICE_MAX);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/fleet/memory.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/fleet/memory.ts src/fleet/memory.test.ts
git commit -m "feat(fleet): in-memory shared state + handoff state machine"
```

---

## Task 5: tools→skill mapping

**Files:**
- Create: `src/fleet/skills/tool-map.ts`
- Test: `src/fleet/skills/tool-map.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { skillsForTools } from "./tool-map";

test("Write/Edit grant file write + read skills, plus memory", () => {
  const s = skillsForTools(["Read", "Write", "Edit", "Glob", "Grep"]);
  assert.ok(s.includes("write_file"));
  assert.ok(s.includes("read_file"));
  assert.ok(s.includes("list_files"));
  assert.ok(s.includes("read_memory"));
  assert.ok(s.includes("write_handoff"));
});

test("creative agents get image skills via description hint", () => {
  const s = skillsForTools(["Read", "Write"], "image-generation", "generates real assets, logos, og");
  assert.ok(s.includes("generate_image"));
  assert.ok(s.includes("generate_animation"));
});

test("every agent always gets memory skills even with no tools", () => {
  const s = skillsForTools([]);
  assert.deepEqual(s.sort(), ["read_memory", "write_handoff"].sort());
});

test("Bash and Task do not grant any skill in slice 1", () => {
  const s = skillsForTools(["Bash", "Task"]);
  assert.deepEqual(s.sort(), ["read_memory", "write_handoff"].sort());
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/fleet/skills/tool-map.test.ts`
Expected: FAIL — cannot find module `./tool-map`.

- [ ] **Step 3: Write minimal implementation**

```ts
import type { SkillId } from "../types";

const IMAGE_HINT = /image|logo|favicon|hero|og|asset|brand|mockup|icon|illustration|social|motion|graphic/i;

/** Map an AgentFleet `tools:` list (+ optional id/description hints) to the
 *  slice-1 SkillIds the role may call. Every agent gets memory skills.
 *  Bash/Task map to nothing yet (no shell sandbox in slice 1). */
export function skillsForTools(tools: string[], id = "", description = ""): SkillId[] {
  const set = new Set<SkillId>(["read_memory", "write_handoff"]);
  const t = tools.map((x) => x.toLowerCase());
  if (t.includes("write") || t.includes("edit")) {
    set.add("write_file");
  }
  if (t.includes("read") || t.includes("glob") || t.includes("grep") || set.has("write_file")) {
    set.add("read_file");
    set.add("list_files");
  }
  if (IMAGE_HINT.test(id) || IMAGE_HINT.test(description)) {
    set.add("generate_image");
    set.add("generate_animation");
  }
  return [...set];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/fleet/skills/tool-map.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/fleet/skills/tool-map.ts src/fleet/skills/tool-map.test.ts
git commit -m "feat(fleet): map AgentFleet tools to slice-1 skills"
```

---

## Task 6: Skill context + file skills

**Files:**
- Create: `src/fleet/skills/files.ts`
- Test: `src/fleet/skills/files.test.ts`

**Note:** Defines the shared `SkillContext` + `SkillResult` types used by every skill module.

- [ ] **Step 1: Write the failing test**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileSkills } from "./files";
import { FleetMemory } from "../memory";
import { workspaceDir } from "../workspace";

function ctx() {
  const root = mkdtempSync(path.join(tmpdir(), "fleet-"));
  const ws = workspaceDir(root, "p1");
  return { projectId: "p1", workspaceDir: ws, memory: new FleetMemory("p1"), images: null as any };
}

test("write_file creates a file under the workspace and read_file returns it", async () => {
  const c = ctx();
  const write = fileSkills.find((s) => s.id === "write_file")!;
  const res = await write.run(c, { path: "src/index.ts", contents: "export const x = 1;\n" });
  assert.equal(res.ok, true);
  const onDisk = readFileSync(path.join(c.workspaceDir, "src/index.ts"), "utf8");
  assert.equal(onDisk, "export const x = 1;\n");

  const read = fileSkills.find((s) => s.id === "read_file")!;
  const got = await read.run(c, { path: "src/index.ts" });
  assert.match(got.detail, /export const x = 1/);
});

test("list_files lists written files", async () => {
  const c = ctx();
  const write = fileSkills.find((s) => s.id === "write_file")!;
  await write.run(c, { path: "a.txt", contents: "a" });
  await write.run(c, { path: "sub/b.txt", contents: "b" });
  const list = fileSkills.find((s) => s.id === "list_files")!;
  const res = await list.run(c, {});
  assert.match(res.detail, /a\.txt/);
  assert.match(res.detail, /sub\/b\.txt|sub[\\/]b\.txt/);
});

test("write_file refuses path traversal", async () => {
  const c = ctx();
  const write = fileSkills.find((s) => s.id === "write_file")!;
  const res = await write.run(c, { path: "../escape.txt", contents: "no" });
  assert.equal(res.ok, false);
  assert.match(res.detail, /outside workspace/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/fleet/skills/files.test.ts`
Expected: FAIL — cannot find module `./files`.

- [ ] **Step 3: Write minimal implementation**

```ts
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { ImageProvider } from "../../skills/image-provider";
import type { FleetMemory } from "../memory";
import type { ProjectAsset, OrchestratorEvent } from "../../agents/project-orchestrator";
import type { SkillId } from "../types";
import { resolveInWorkspace } from "../workspace";

export interface SkillContext {
  projectId: string;
  workspaceDir: string;
  memory: FleetMemory;
  images: ImageProvider;
  /** Skills that create assets push them here so the orchestrator can persist + stream. */
  onAsset?: (asset: ProjectAsset) => void;
  /** Optional event passthrough (rarely needed; runner streams op cards). */
  emit?: (e: OrchestratorEvent) => void;
}

export interface SkillResult {
  ok: boolean;
  /** Short text fed back to the model as the tool_result + shown as op detail. */
  detail: string;
  /** Optional asset produced (media skills set this). */
  asset?: ProjectAsset;
}

export interface Skill {
  id: SkillId;
  tool: {
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
  };
  run(ctx: SkillContext, input: any): Promise<SkillResult>;
}

async function walk(dir: string, base: string, out: string[]): Promise<void> {
  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    const rel = path.relative(base, abs);
    if (e.isDirectory()) await walk(abs, base, out);
    else out.push(rel);
  }
}

export const fileSkills: Skill[] = [
  {
    id: "write_file",
    tool: {
      name: "write_file",
      description: "Create or overwrite a file in the project workspace. Path is relative to the workspace root.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path, e.g. src/app/page.tsx" },
          contents: { type: "string", description: "Full file contents" },
        },
        required: ["path", "contents"],
      },
    },
    async run(ctx, input: { path: string; contents: string }): Promise<SkillResult> {
      let abs: string;
      try {
        abs = resolveInWorkspace(ctx.workspaceDir, input.path);
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : "bad path" };
      }
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, input.contents ?? "", "utf8");
      const bytes = Buffer.byteLength(input.contents ?? "", "utf8");
      return { ok: true, detail: `wrote ${input.path} (${bytes} bytes)` };
    },
  },
  {
    id: "read_file",
    tool: {
      name: "read_file",
      description: "Read a file from the project workspace by relative path.",
      input_schema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
    async run(ctx, input: { path: string }): Promise<SkillResult> {
      let abs: string;
      try {
        abs = resolveInWorkspace(ctx.workspaceDir, input.path);
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : "bad path" };
      }
      try {
        const text = await readFile(abs, "utf8");
        return { ok: true, detail: text.slice(0, 8000) };
      } catch {
        return { ok: false, detail: `not found: ${input.path}` };
      }
    },
  },
  {
    id: "list_files",
    tool: {
      name: "list_files",
      description: "List all files currently in the project workspace (relative paths).",
      input_schema: { type: "object", properties: {} },
    },
    async run(ctx): Promise<SkillResult> {
      const out: string[] = [];
      await walk(ctx.workspaceDir, ctx.workspaceDir, out);
      return { ok: true, detail: out.length ? out.sort().join("\n") : "(workspace empty)" };
    },
  },
];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/fleet/skills/files.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/fleet/skills/files.ts src/fleet/skills/files.test.ts
git commit -m "feat(fleet): SkillContext + workspace file skills"
```

---

## Task 7: Media skills (image/animation → ProjectAsset)

**Files:**
- Create: `src/fleet/skills/media.ts`
- Test: `src/fleet/skills/media.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mediaSkills } from "./media";
import { FleetMemory } from "../memory";
import type { ImageProvider } from "../../skills/image-provider";
import type { ProjectAsset } from "../../agents/project-orchestrator";

const fakeImages: ImageProvider = {
  async generateImage(input) {
    return { dataUrl: "data:image/svg+xml,<svg/>", mimeType: "image/svg+xml", width: 512, height: 512, provider: "fake" };
  },
  async generateAnimation(input) {
    return { content: "{}", mode: input.mode, mimeType: "application/json", provider: "fake" };
  },
};

test("generate_image returns an asset and reports onAsset", async () => {
  const assets: ProjectAsset[] = [];
  const ctx = {
    projectId: "p1", workspaceDir: "/tmp/x", memory: new FleetMemory("p1"),
    images: fakeImages, onAsset: (a: ProjectAsset) => assets.push(a),
  };
  const skill = mediaSkills.find((s) => s.id === "generate_image")!;
  const res = await skill.run(ctx, { prompt: "logo", preset: "logo", path: "public/logo.svg" });
  assert.equal(res.ok, true);
  assert.ok(res.asset);
  assert.equal(res.asset!.path, "public/logo.svg");
  assert.equal(res.asset!.provider, "fake");
  assert.equal(assets.length, 1);
});

test("generate_animation produces a lottie asset", async () => {
  const ctx = {
    projectId: "p1", workspaceDir: "/tmp/x", memory: new FleetMemory("p1"),
    images: fakeImages, onAsset: () => {},
  };
  const skill = mediaSkills.find((s) => s.id === "generate_animation")!;
  const res = await skill.run(ctx, { prompt: "spin", mode: "lottie", path: "public/anim.lottie.json" });
  assert.equal(res.ok, true);
  assert.equal(res.asset!.kind, "lottie");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/fleet/skills/media.test.ts`
Expected: FAIL — cannot find module `./media`.

- [ ] **Step 3: Write minimal implementation**

```ts
import { randomBytes } from "node:crypto";
import type { ProjectAsset, ProjectAssetKind } from "../../agents/project-orchestrator";
import type { Skill, SkillContext, SkillResult } from "./files";

function nowIso() {
  return new Date().toISOString();
}
function bytes(s: string) {
  return Buffer.byteLength(s, "utf8");
}

export const mediaSkills: Skill[] = [
  {
    id: "generate_image",
    tool: {
      name: "generate_image",
      description: "Generate a real image asset (logo/hero/icon/og/illustration) for the project. Stored in the asset gallery and written to the given workspace path.",
      input_schema: {
        type: "object",
        properties: {
          prompt: { type: "string" },
          preset: { type: "string", enum: ["logo", "hero", "icon", "og", "illustration"] },
          path: { type: "string", description: "Where to place it, e.g. public/logo.svg" },
          aspect: { type: "string", enum: ["1:1", "16:9", "4:5", "3:1"] },
        },
        required: ["prompt", "path"],
      },
    },
    async run(ctx: SkillContext, input: { prompt: string; preset?: any; path: string; aspect?: any }): Promise<SkillResult> {
      const r = await ctx.images.generateImage({ prompt: input.prompt, preset: input.preset, aspect: input.aspect });
      const kind: ProjectAssetKind = input.preset === "icon" ? "icon" : "image";
      const asset: ProjectAsset = {
        id: `ast_${randomBytes(8).toString("hex")}`,
        projectId: ctx.projectId,
        kind,
        path: input.path,
        mimeType: r.mimeType,
        width: r.width,
        height: r.height,
        prompt: input.prompt,
        provider: r.provider,
        sizeBytes: bytes(r.dataUrl),
        createdAt: nowIso(),
        dataUrl: r.dataUrl,
      };
      ctx.onAsset?.(asset);
      return { ok: true, detail: `${r.width}×${r.height} · ${r.provider} → ${input.path}`, asset };
    },
  },
  {
    id: "generate_animation",
    tool: {
      name: "generate_animation",
      description: "Generate a looped animation asset (lottie JSON / CSS keyframes / video) for the project.",
      input_schema: {
        type: "object",
        properties: {
          prompt: { type: "string" },
          mode: { type: "string", enum: ["lottie", "css", "video"] },
          path: { type: "string" },
        },
        required: ["prompt", "mode", "path"],
      },
    },
    async run(ctx: SkillContext, input: { prompt: string; mode: "lottie" | "css" | "video"; path: string }): Promise<SkillResult> {
      const r = await ctx.images.generateAnimation({ prompt: input.prompt, mode: input.mode });
      const dataUrl =
        r.mimeType === "application/json"
          ? "data:application/json;utf8," + encodeURIComponent(r.content)
          : r.mimeType === "text/css"
          ? "data:text/css;utf8," + encodeURIComponent(r.content)
          : r.content;
      const kind: ProjectAssetKind = input.mode === "lottie" ? "lottie" : input.mode === "css" ? "css_anim" : "video";
      const asset: ProjectAsset = {
        id: `ast_${randomBytes(8).toString("hex")}`,
        projectId: ctx.projectId,
        kind,
        path: input.path,
        mimeType: r.mimeType,
        prompt: input.prompt,
        provider: r.provider,
        sizeBytes: bytes(r.content),
        createdAt: nowIso(),
        dataUrl,
      };
      ctx.onAsset?.(asset);
      return { ok: true, detail: `${input.mode} · ${r.provider} → ${input.path}`, asset };
    },
  },
];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/fleet/skills/media.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/fleet/skills/media.ts src/fleet/skills/media.test.ts
git commit -m "feat(fleet): media skills -> ProjectAsset"
```

---

## Task 8: Memory skills + skill registry

**Files:**
- Create: `src/fleet/skills/memory-skills.ts`
- Create: `src/fleet/skills/index.ts`
- Test: `src/fleet/skills/index.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { skillRegistry, toolsFor } from "./index";
import { FleetMemory } from "../memory";

test("registry contains all seven slice-1 skills", () => {
  const ids = [...skillRegistry.keys()].sort();
  assert.deepEqual(ids, [
    "generate_animation", "generate_image", "list_files",
    "read_file", "read_memory", "write_file", "write_handoff",
  ]);
});

test("toolsFor returns Anthropic tool defs for the given skill ids", () => {
  const tools = toolsFor(["write_file", "read_memory"]);
  assert.equal(tools.length, 2);
  assert.ok(tools.every((t) => typeof t.name === "string" && t.input_schema));
});

test("write_handoff records a pending-review handoff in memory", async () => {
  const mem = new FleetMemory("p1");
  const ctx = { projectId: "p1", workspaceDir: "/tmp/x", memory: mem, images: null as any };
  const skill = skillRegistry.get("write_handoff")!;
  const res = await skill.run(ctx, { agent: "react-engineer", round: 1, body: "built login page" });
  assert.equal(res.ok, true);
  assert.equal(mem.read().handoffs["react-engineer"].status, "pending-review");
});

test("read_memory returns the relevant slice for an agent", async () => {
  const mem = new FleetMemory("p1");
  mem.setProject({ name: "shop", goal: "sell", stack: "Next", status: "building" });
  const ctx = { projectId: "p1", workspaceDir: "/tmp/x", memory: mem, images: null as any };
  const res = await skillRegistry.get("read_memory")!.run(ctx, { agent: "react-engineer" });
  assert.match(res.detail, /shop/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/fleet/skills/index.test.ts`
Expected: FAIL — cannot find module `./index`.

- [ ] **Step 3a: Write `memory-skills.ts`**

```ts
import type { Skill, SkillContext, SkillResult } from "./files";

export const memorySkills: Skill[] = [
  {
    id: "read_memory",
    tool: {
      name: "read_memory",
      description: "Read the shared fleet memory: project, MVP Definition-of-Done, recent decisions, approved work, and any reviewer feedback addressed to you.",
      input_schema: {
        type: "object",
        properties: { agent: { type: "string", description: "Your agent id" } },
        required: ["agent"],
      },
    },
    async run(ctx: SkillContext, input: { agent: string }): Promise<SkillResult> {
      return { ok: true, detail: ctx.memory.relevantSlice(input.agent) };
    },
  },
  {
    id: "write_handoff",
    tool: {
      name: "write_handoff",
      description: "Record your handoff for the orchestrator's review. Summarise what you did, key decisions, what's next, and artifacts. Status is set to pending-review.",
      input_schema: {
        type: "object",
        properties: {
          agent: { type: "string" },
          round: { type: "integer" },
          body: { type: "string" },
        },
        required: ["agent", "body"],
      },
    },
    async run(ctx: SkillContext, input: { agent: string; round?: number; body: string }): Promise<SkillResult> {
      ctx.memory.putHandoff({
        agent: input.agent,
        round: input.round ?? 1,
        status: "pending-review",
        body: input.body,
      });
      return { ok: true, detail: "handoff recorded (pending-review)" };
    },
  },
];
```

- [ ] **Step 3b: Write `index.ts`**

```ts
import type { Skill } from "./files";
import { fileSkills } from "./files";
import { mediaSkills } from "./media";
import { memorySkills } from "./memory-skills";
import type { SkillId } from "../types";

export type { Skill, SkillContext, SkillResult } from "./files";

const all: Skill[] = [...fileSkills, ...mediaSkills, ...memorySkills];

export const skillRegistry: Map<SkillId, Skill> = new Map(all.map((s) => [s.id, s]));

export interface AnthropicToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** Anthropic tool definitions for a set of skill ids (unknown ids skipped). */
export function toolsFor(ids: SkillId[]): AnthropicToolDef[] {
  const out: AnthropicToolDef[] = [];
  for (const id of ids) {
    const s = skillRegistry.get(id);
    if (s) out.push(s.tool);
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/fleet/skills/index.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/fleet/skills/memory-skills.ts src/fleet/skills/index.ts src/fleet/skills/index.test.ts
git commit -m "feat(fleet): memory skills + skill registry"
```

---

## Task 9: Roster port script + generated roster

**Files:**
- Create: `scripts/port-fleet.mjs`
- Create (generated): `src/fleet/roster/roster.generated.ts`
- Create: `src/fleet/roster/index.ts`
- Test: `src/fleet/roster/index.test.ts`

- [ ] **Step 1: Write the port script** `scripts/port-fleet.mjs`

```js
/* Port AgentFleet agent markdown into a committed TypeScript roster.
   Usage: node scripts/port-fleet.mjs [path-to-AgentFleet/.claude/agents]
   Defaults to ../AgentFleet/.claude/agents relative to repo root. */
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const agentsDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(repoRoot, "..", "AgentFleet", ".claude", "agents");

const IMAGE_HINT = /image|logo|favicon|hero|og|asset|brand|mockup|icon|illustration|social|motion|graphic/i;

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
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text.trim() };
  const meta = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i === -1) continue;
    const key = line.slice(0, i).trim();
    let val = line.slice(i + 1).trim();
    meta[key] = val;
  }
  return { meta, body: m[2].trim() };
}

function skillsForTools(toolsLine, id, description) {
  const tools = (toolsLine || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const set = new Set(["read_memory", "write_handoff"]);
  if (tools.includes("write") || tools.includes("edit")) set.add("write_file");
  if (tools.includes("read") || tools.includes("glob") || tools.includes("grep") || set.has("write_file")) {
    set.add("read_file"); set.add("list_files");
  }
  if (IMAGE_HINT.test(id) || IMAGE_HINT.test(description)) { set.add("generate_image"); set.add("generate_animation"); }
  return [...set];
}

function divisionFromPath(absPath) {
  const rel = path.relative(agentsDir, absPath);
  const parts = rel.split(path.sep);
  return parts.length > 1 ? parts[0] : "governance";
}

const files = (await walk(agentsDir)).sort();
const roles = [];
for (const f of files) {
  const text = await readFile(f, "utf8");
  const { meta, body } = parseFrontMatter(text);
  const id = meta.name || path.basename(f, ".md");
  const model = meta.model === "opus" ? "opus" : "sonnet";
  roles.push({
    id,
    name: id,
    division: divisionFromPath(f),
    description: meta.description || "",
    model,
    allowedSkills: skillsForTools(meta.tools, id, meta.description || ""),
    systemPrompt: body,
  });
}

const header = `/* AUTO-GENERATED by scripts/port-fleet.mjs — do not edit by hand.
   Source: AgentFleet/.claude/agents/**/*.md  (${roles.length} agents). */
import type { AgentRole } from "./types";

export const ROSTER: AgentRole[] = ${JSON.stringify(roles, null, 2)};
`;

const outPath = path.resolve(repoRoot, "src", "fleet", "roster", "roster.generated.ts");
await writeFile(outPath, header, "utf8");
console.log(`Wrote ${roles.length} agents to ${path.relative(repoRoot, outPath)}`);
```

- [ ] **Step 2: Create `src/fleet/roster/types.ts`** (re-export so the generated file's import resolves)

```ts
export type { AgentRole } from "../types";
```

- [ ] **Step 3: Run the port script**

Run: `node scripts/port-fleet.mjs`
Expected: `Wrote 78 agents to src/fleet/roster/roster.generated.ts` (count should be 78; accept the actual `.md` count if it differs and note it).

- [ ] **Step 4: Write the failing test** `src/fleet/roster/index.test.ts`

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { listRoles, getRole, rolesByDivision } from "./index";
import { isAgentRole } from "../types";

test("roster has the full fleet and every entry is a valid role", () => {
  const roles = listRoles();
  assert.ok(roles.length >= 70, `expected ~78 roles, got ${roles.length}`);
  for (const r of roles) assert.equal(isAgentRole(r), true, `invalid role: ${r.id}`);
});

test("orchestrator + key specialists are present", () => {
  for (const id of ["00-orchestrator", "react-engineer", "api-engineer", "qa-engineer", "image-generation"]) {
    assert.ok(getRole(id), `missing role: ${id}`);
  }
});

test("every role has at least the memory skills", () => {
  for (const r of listRoles()) {
    assert.ok(r.allowedSkills.includes("read_memory"));
    assert.ok(r.allowedSkills.includes("write_handoff"));
  }
});

test("rolesByDivision groups by division", () => {
  const byDiv = rolesByDivision();
  assert.ok(Object.keys(byDiv).length >= 5);
});
```

- [ ] **Step 5: Write `src/fleet/roster/index.ts`**

```ts
import type { AgentRole } from "../types";
import { ROSTER } from "./roster.generated";

const byId = new Map<string, AgentRole>(ROSTER.map((r) => [r.id, r]));

export function listRoles(): AgentRole[] {
  return ROSTER.slice();
}

export function getRole(id: string): AgentRole | undefined {
  return byId.get(id);
}

export function rolesByDivision(): Record<string, AgentRole[]> {
  const out: Record<string, AgentRole[]> = {};
  for (const r of ROSTER) (out[r.division] ??= []).push(r);
  return out;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx tsx --test src/fleet/roster/index.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add scripts/port-fleet.mjs src/fleet/roster/
git commit -m "feat(fleet): port all AgentFleet agents into committed roster"
```

---

## Task 10: Anthropic client interface + factory (test-fakeable)

**Files:**
- Create: `src/fleet/anthropic.ts`
- Test: `src/fleet/anthropic.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFleetClient } from "./anthropic";

test("buildFleetClient returns null when no key is set", () => {
  const prev = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal(buildFleetClient(), null);
  if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
});

test("buildFleetClient returns a client with messages.create when key is set", () => {
  const prev = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-test";
  const c = buildFleetClient();
  assert.ok(c);
  assert.equal(typeof c!.messages.create, "function");
  if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
  else delete process.env.ANTHROPIC_API_KEY;
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/fleet/anthropic.test.ts`
Expected: FAIL — cannot find module `./anthropic`.

- [ ] **Step 3: Write minimal implementation**

```ts
import Anthropic from "@anthropic-ai/sdk";

/** Minimal shape the runner/orchestrator depend on, so tests pass a fake. */
export interface AnthropicLike {
  messages: {
    create(body: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

export function buildFleetClient(apiKey?: string): AnthropicLike | null {
  const key = apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  return new Anthropic({ apiKey: key }) as unknown as AnthropicLike;
}

export const FLEET_MODEL_IDS: Record<"opus" | "sonnet", string> = {
  opus: "claude-opus-4-8",
  sonnet: "claude-sonnet-4-6",
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/fleet/anthropic.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/fleet/anthropic.ts src/fleet/anthropic.test.ts
git commit -m "feat(fleet): anthropic client interface + factory"
```

---

## Task 11: FleetAgentRunner (bounded tool-use loop)

**Files:**
- Create: `src/fleet/runner.ts`
- Test: `src/fleet/runner.test.ts`

**Note:** Tests inject a fake `AnthropicLike` that scripts a `tool_use` then a stop. The runner returns the agent's handoff and streams op events.

- [ ] **Step 1: Write the failing test**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FleetAgentRunner } from "./runner";
import { FleetMemory } from "./memory";
import { workspaceDir } from "./workspace";
import type { AgentRole } from "./types";
import type { OrchestratorEvent } from "../agents/project-orchestrator";

const role: AgentRole = {
  id: "react-engineer", name: "react-engineer", division: "frontend",
  description: "builds UI", model: "sonnet",
  allowedSkills: ["write_file", "read_memory", "write_handoff"],
  systemPrompt: "You build UI.",
};

function fakeClient(steps: any[]) {
  let i = 0;
  return { messages: { create: async () => steps[Math.min(i++, steps.length - 1)] } };
}

const fakeImages = {
  async generateImage() { return { dataUrl: "x", mimeType: "image/svg+xml", width: 1, height: 1, provider: "fake" }; },
  async generateAnimation() { return { content: "{}", mode: "lottie" as const, mimeType: "application/json", provider: "fake" }; },
};

test("runner executes a tool_use then terminates, returns handoff, streams ops", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fleet-run-"));
  const ws = workspaceDir(root, "p1");
  const mem = new FleetMemory("p1");
  const events: OrchestratorEvent[] = [];

  const client = fakeClient([
    {
      stop_reason: "tool_use",
      usage: { output_tokens: 100 },
      content: [
        { type: "text", text: "Writing the page." },
        { type: "tool_use", id: "tu1", name: "write_file", input: { path: "src/page.tsx", contents: "export default () => null;" } },
      ],
    },
    {
      stop_reason: "end_turn",
      usage: { output_tokens: 50 },
      content: [{ type: "text", text: "Done. Wrote src/page.tsx." }],
    },
  ]);

  const runner = new FleetAgentRunner({ client, images: fakeImages as any });
  const handoff = await runner.run({
    role, task: "build the home page", projectId: "p1", workspaceDir: ws,
    memory: mem, onEvent: (e) => events.push(e), budget: { spent: 0, cap: 100000 },
  });

  assert.equal(handoff.status, "pending-review");
  assert.match(handoff.body, /src\/page\.tsx|Done/);
  assert.ok(events.some((e) => e.kind === "op_started"));
  assert.ok(events.some((e) => e.kind === "op_finished" && e.status === "ok"));
  assert.ok(events.some((e) => e.kind === "agent_message"));
});

test("runner with null client emits a failed op and an offline handoff", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fleet-run-"));
  const ws = workspaceDir(root, "p2");
  const events: OrchestratorEvent[] = [];
  const runner = new FleetAgentRunner({ client: null, images: fakeImages as any });
  const handoff = await runner.run({
    role, task: "x", projectId: "p2", workspaceDir: ws,
    memory: new FleetMemory("p2"), onEvent: (e) => events.push(e), budget: { spent: 0, cap: 100000 },
  });
  assert.equal(handoff.status, "pending-review");
  assert.match(handoff.body, /offline|ANTHROPIC_API_KEY/i);
  assert.ok(events.some((e) => e.kind === "op_finished" && e.status === "failed"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/fleet/runner.test.ts`
Expected: FAIL — cannot find module `./runner`.

- [ ] **Step 3: Write minimal implementation**

```ts
import type { AnthropicLike } from "./anthropic";
import { FLEET_MODEL_IDS } from "./anthropic";
import type { AgentRole } from "./types";
import type { Handoff } from "./types";
import type { FleetMemory } from "./memory";
import type { ImageProvider } from "../skills/image-provider";
import type { OrchestratorEvent, OrchestratorEventHandler, ProjectAsset } from "../agents/project-orchestrator";
import { skillRegistry, toolsFor } from "./skills/index";
import { fleetConfig } from "./config";

export interface RunnerBudget {
  spent: number;
  cap: number;
}

export interface RunInput {
  role: AgentRole;
  task: string;
  projectId: string;
  workspaceDir: string;
  memory: FleetMemory;
  onEvent: OrchestratorEventHandler;
  budget: RunnerBudget;
  /** Round number for the handoff (default 1). */
  round?: number;
}

const PREAMBLE =
  "You are a specialist agent inside Cantila's autonomous build fleet. You coordinate ONLY through " +
  "the provided tools and the shared memory — you cannot talk to other agents directly. Read memory " +
  "first, do real work via your tools (write real files, no placeholder/mock data), then call " +
  "write_handoff to summarise for the orchestrator's review. Keep going until your task is done or you " +
  "are blocked. Security work is authorized/defensive only.";

export class FleetAgentRunner {
  constructor(private deps: { client: AnthropicLike | null; images: ImageProvider }) {}

  async run(input: RunInput): Promise<Handoff> {
    const { role, task, projectId, workspaceDir, memory, onEvent, budget } = input;
    const round = input.round ?? 1;
    const cfg = fleetConfig();

    if (!this.deps.client) {
      const opKey = `agent:${role.id}`;
      onEvent({ kind: "op_started", opKey, agent: role.id, title: `${role.id} (offline)` });
      onEvent({ kind: "op_finished", opKey, agent: role.id, title: `${role.id} (offline)`, status: "failed", detail: "fleet offline — set ANTHROPIC_API_KEY" });
      const h: Handoff = { agent: role.id, round, status: "pending-review", body: "fleet offline — ANTHROPIC_API_KEY not configured; no work performed.", updatedAt: new Date().toISOString() };
      memory.putHandoff(h);
      return h;
    }

    const ctx = {
      projectId,
      workspaceDir,
      memory,
      images: this.deps.images,
      onAsset: (asset: ProjectAsset) => onEvent({ kind: "asset_created", asset }),
    };

    const tools = toolsFor(role.allowedSkills);
    const messages: any[] = [
      {
        role: "user",
        content:
          `Your task: ${task}\n\n` +
          `Shared memory (read this first):\n${memory.relevantSlice(role.id)}\n\n` +
          `When finished, call write_handoff with agent="${role.id}", round=${round}.`,
      },
    ];

    let lastText = "";
    for (let step = 0; step < cfg.maxAgentSteps; step++) {
      if (budget.spent >= budget.cap) break;
      const resp = await this.deps.client.messages.create({
        model: FLEET_MODEL_IDS[role.model],
        max_tokens: 4000,
        system: [{ type: "text", text: `${PREAMBLE}\n\n${role.systemPrompt}`, cache_control: { type: "ephemeral" } }],
        tools: tools as any,
        messages,
      } as any);

      budget.spent += resp.usage?.output_tokens ?? 0;

      const toolUses = resp.content.filter((b: any) => b.type === "tool_use");
      const texts = resp.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ").trim();
      if (texts) {
        lastText = texts;
        onEvent({ kind: "agent_message", agent: role.id, content: texts });
      }

      messages.push({ role: "assistant", content: resp.content });

      if (toolUses.length === 0 || resp.stop_reason !== "tool_use") break;

      const toolResults: any[] = [];
      for (const tu of toolUses) {
        const skill = skillRegistry.get(tu.name as any);
        const opKey = tu.name === "write_file" || tu.name === "read_file"
          ? `file:${(tu.input as any)?.path ?? tu.name}`
          : tu.name === "generate_image" ? `image:${(tu.input as any)?.path ?? "img"}`
          : tu.name === "generate_animation" ? `anim:${(tu.input as any)?.path ?? "anim"}`
          : `${tu.name}:${role.id}`;
        const title = `${role.id} · ${tu.name}`;
        onEvent({ kind: "op_started", opKey, agent: role.id, title });
        if (!skill) {
          onEvent({ kind: "op_finished", opKey, agent: role.id, title, status: "failed", detail: `unknown tool ${tu.name}` });
          toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: `error: unknown tool ${tu.name}`, is_error: true });
          continue;
        }
        const result = await skill.run(ctx, tu.input);
        onEvent({ kind: "op_finished", opKey, agent: role.id, title, status: result.ok ? "ok" : "failed", detail: result.detail });
        toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: result.detail, is_error: !result.ok });
      }
      messages.push({ role: "user", content: toolResults });
    }

    // Ensure a handoff exists even if the model didn't call write_handoff.
    if (!memory.read().handoffs[role.id] || memory.read().handoffs[role.id].round !== round) {
      memory.putHandoff({ agent: role.id, round, status: "pending-review", body: lastText || `${role.id} completed its turn.` });
    }
    return memory.read().handoffs[role.id];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/fleet/runner.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/fleet/runner.ts src/fleet/runner.test.ts
git commit -m "feat(fleet): bounded tool-use agent runner"
```

---

## Task 12: FleetOrchestrator (plan → batches → review → QA → loop)

**Files:**
- Create: `src/fleet/orchestrator.ts`
- Test: `src/fleet/orchestrator.test.ts`

**Note:** The orchestrator makes two kinds of orchestrator-role Anthropic calls — `emit_build_plan` and `review_handoff` — both forced tool-use. Tests inject a fake client that returns a small plan, then approvals.

- [ ] **Step 1: Write the failing test**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FleetOrchestrator } from "./orchestrator";
import type { OrchestratorEvent } from "../agents/project-orchestrator";

const fakeImages = {
  async generateImage() { return { dataUrl: "x", mimeType: "image/svg+xml", width: 1, height: 1, provider: "fake" }; },
  async generateAnimation() { return { content: "{}", mode: "lottie" as const, mimeType: "application/json", provider: "fake" }; },
};

// A fake client that answers based on which tool is forced.
function scriptedClient() {
  return {
    messages: {
      create: async (body: any) => {
        const forced = body.tool_choice?.name;
        if (forced === "emit_build_plan") {
          return {
            stop_reason: "tool_use", usage: { output_tokens: 10 },
            content: [{ type: "tool_use", id: "p", name: "emit_build_plan", input: { dod: ["app builds", "home page renders"], batches: [{ agents: ["react-engineer"] }] } }],
          };
        }
        if (forced === "review_handoff") {
          return {
            stop_reason: "tool_use", usage: { output_tokens: 10 },
            content: [{ type: "tool_use", id: "r", name: "review_handoff", input: { verdict: "approved", dodDone: ["app builds", "home page renders"] } }],
          };
        }
        // default = an agent turn: write a file then stop
        return {
          stop_reason: "end_turn", usage: { output_tokens: 10 },
          content: [{ type: "text", text: "built it" }],
        };
      },
    },
  };
}

test("build streams plan, agent ops, result and done; DoD passes", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fleet-orc-"));
  const events: OrchestratorEvent[] = [];
  const orc = new FleetOrchestrator({ client: scriptedClient(), images: fakeImages as any, workspaceRoot: root });
  await orc.build({
    projectId: "p1",
    plan: { name: "shop", stack: "Next.js · Tailwind", summary: "a shop", kind: "live_app" } as any,
    onEvent: (e) => events.push(e),
  });
  assert.ok(events.some((e) => e.kind === "agent_message"));
  assert.ok(events.some((e) => e.kind === "result"));
  assert.equal(events.at(-1)?.kind, "done");
});

test("build with null client ends gracefully with a done event", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fleet-orc-"));
  const events: OrchestratorEvent[] = [];
  const orc = new FleetOrchestrator({ client: null, images: fakeImages as any, workspaceRoot: root });
  await orc.build({ projectId: "p2", plan: { name: "x", stack: "Node", summary: "y", kind: "live_app" } as any, onEvent: (e) => events.push(e) });
  assert.equal(events.at(-1)?.kind, "done");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/fleet/orchestrator.test.ts`
Expected: FAIL — cannot find module `./orchestrator`.

- [ ] **Step 3: Write minimal implementation**

```ts
import type { AnthropicLike } from "./anthropic";
import { FLEET_MODEL_IDS } from "./anthropic";
import type { ImageProvider } from "../skills/image-provider";
import type { OrchestratorEventHandler } from "../agents/project-orchestrator";
import type { DeployPlan } from "../ai/deploy-planner";
import type { BuildPlan } from "./types";
import { FleetMemory } from "./memory";
import { FleetAgentRunner } from "./runner";
import { getRole } from "./roster/index";
import { workspaceDir } from "./workspace";
import { fleetConfig } from "./config";

const PLAN_TOOL = {
  name: "emit_build_plan",
  description: "Emit the MVP Definition-of-Done and an ordered list of parallel agent batches. Use real agent ids from the fleet roster. Architecture batches before build batches before test batches.",
  input_schema: {
    type: "object",
    properties: {
      dod: { type: "array", items: { type: "string" }, description: "Checkable MVP done criteria" },
      batches: {
        type: "array",
        items: {
          type: "object",
          properties: { agents: { type: "array", items: { type: "string" } } },
          required: ["agents"],
        },
      },
    },
    required: ["dod", "batches"],
  },
};

const REVIEW_TOOL = {
  name: "review_handoff",
  description: "Review one agent's handoff against its task and the MVP DoD. Approve only work that actually advances the MVP. List any DoD items now satisfied.",
  input_schema: {
    type: "object",
    properties: {
      verdict: { type: "string", enum: ["approved", "changes-requested"] },
      feedback: { type: "string" },
      dodDone: { type: "array", items: { type: "string" } },
    },
    required: ["verdict"],
  },
};

const ORCHESTRATOR_SYSTEM =
  "You are 00-orchestrator, the driver and approval gate of Cantila's autonomous build fleet. " +
  "Plan a shippable MVP, route to real specialist agents, review their handoffs honestly, and loop " +
  "until the Definition-of-Done passes. Default stack TypeScript/Next.js + Tailwind. Never approve broken work.";

export interface FleetOrchestratorDeps {
  client: AnthropicLike | null;
  images: ImageProvider;
  workspaceRoot: string;
}

export interface FleetBuildInput {
  projectId: string;
  plan: DeployPlan;
  onEvent: OrchestratorEventHandler;
  /** Reused per-project memory (the integration seam passes one in). */
  memory?: FleetMemory;
}

export class FleetOrchestrator {
  private runner: FleetAgentRunner;
  constructor(private deps: FleetOrchestratorDeps) {
    this.runner = new FleetAgentRunner({ client: deps.client, images: deps.images });
  }

  async build(input: FleetBuildInput): Promise<void> {
    const { projectId, plan, onEvent } = input;
    const cfg = fleetConfig();
    const memory = input.memory ?? new FleetMemory(projectId);
    memory.setProject({ name: plan.name, goal: plan.summary, stack: plan.stack, status: "building" });
    const ws = workspaceDir(this.deps.workspaceRoot, projectId);
    const budget = { spent: 0, cap: cfg.buildTokenBudget };

    try {
      if (!this.deps.client) {
        onEvent({ kind: "agent_message", agent: "orchestrator", content: "Fleet is offline — set ANTHROPIC_API_KEY to run a real build." });
        onEvent({ kind: "result", name: plan.name, url: `${plan.name}.cantila.app`, stack: plan.stack });
        onEvent({ kind: "done" });
        return;
      }

      const buildPlan = await this.makePlan(plan, budget);
      memory.setDoD(buildPlan.dod);
      onEvent({ kind: "agent_message", agent: "orchestrator", content: `Plan ready: ${buildPlan.batches.length} batch(es), ${buildPlan.dod.length} DoD items.` });

      let round = 0;
      for (const batch of buildPlan.batches) {
        if (round >= cfg.maxRounds || budget.spent >= budget.cap) break;
        round++;
        await this.runBatch(batch.agents, projectId, ws, memory, onEvent, budget, round);
        await this.reviewBatch(batch.agents, memory, budget, onEvent);
      }

      onEvent({ kind: "result", name: plan.name, url: `${plan.name}.cantila.app`, stack: plan.stack });
      onEvent({ kind: "done" });
    } catch (err) {
      onEvent({ kind: "error", error: err instanceof Error ? err.message : "fleet build failed" });
      onEvent({ kind: "done" });
    }
  }

  async chat(input: { projectId: string; message: string; onEvent: OrchestratorEventHandler; memory?: FleetMemory }): Promise<void> {
    const { projectId, message, onEvent } = input;
    const cfg = fleetConfig();
    const memory = input.memory ?? new FleetMemory(projectId);
    const ws = workspaceDir(this.deps.workspaceRoot, projectId);
    const budget = { spent: 0, cap: cfg.buildTokenBudget };
    try {
      if (!this.deps.client) {
        onEvent({ kind: "agent_message", agent: "orchestrator", content: "Fleet is offline — set ANTHROPIC_API_KEY." });
        onEvent({ kind: "done" });
        return;
      }
      // Route the follow-up to the orchestrator role itself, which can write files / dispatch via its tools.
      const role = getRole("00-orchestrator")!;
      await this.runner.run({ role, task: message, projectId, workspaceDir: ws, memory, onEvent, budget });
      onEvent({ kind: "done" });
    } catch (err) {
      onEvent({ kind: "error", error: err instanceof Error ? err.message : "fleet chat failed" });
      onEvent({ kind: "done" });
    }
  }

  private async makePlan(plan: DeployPlan, budget: { spent: number; cap: number }): Promise<BuildPlan> {
    const resp = await this.deps.client!.messages.create({
      model: FLEET_MODEL_IDS.opus,
      max_tokens: 1500,
      system: [{ type: "text", text: ORCHESTRATOR_SYSTEM, cache_control: { type: "ephemeral" } }],
      tools: [PLAN_TOOL] as any,
      tool_choice: { type: "tool", name: PLAN_TOOL.name } as any,
      messages: [{ role: "user", content: `Build request: ${plan.summary}\nName: ${plan.name}\nStack: ${plan.stack}\nKind: ${plan.kind}\n\nEmit the MVP DoD and parallel agent batches.` }],
    } as any);
    budget.spent += resp.usage?.output_tokens ?? 0;
    const tu = resp.content.find((b: any) => b.type === "tool_use");
    const input = (tu?.input ?? {}) as Partial<BuildPlan>;
    return {
      dod: Array.isArray(input.dod) && input.dod.length ? input.dod : ["App builds", "Core flow works"],
      batches: Array.isArray(input.batches) && input.batches.length ? input.batches : [{ agents: ["react-engineer"] }],
    };
  }

  private async runBatch(agentIds: string[], projectId: string, ws: string, memory: FleetMemory, onEvent: OrchestratorEventHandler, budget: { spent: number; cap: number }, round: number): Promise<void> {
    const cfg = fleetConfig();
    const valid = agentIds.map((id) => getRole(id)).filter((r): r is NonNullable<typeof r> => !!r);
    // Run with a concurrency cap.
    for (let i = 0; i < valid.length; i += cfg.maxConcurrency) {
      const chunk = valid.slice(i, i + cfg.maxConcurrency);
      await Promise.all(chunk.map((role) =>
        this.runner.run({ role, task: `Advance the MVP per your role and the shared memory.`, projectId, workspaceDir: ws, memory, onEvent, budget, round }),
      ));
    }
  }

  private async reviewBatch(agentIds: string[], memory: FleetMemory, budget: { spent: number; cap: number }, onEvent: OrchestratorEventHandler): Promise<void> {
    for (const id of agentIds) {
      const handoff = memory.read().handoffs[id];
      if (!handoff || handoff.status !== "pending-review") continue;
      const resp = await this.deps.client!.messages.create({
        model: FLEET_MODEL_IDS.opus,
        max_tokens: 600,
        system: [{ type: "text", text: ORCHESTRATOR_SYSTEM, cache_control: { type: "ephemeral" } }],
        tools: [REVIEW_TOOL] as any,
        tool_choice: { type: "tool", name: REVIEW_TOOL.name } as any,
        messages: [{ role: "user", content: `Review ${id}'s handoff:\n${handoff.body}\n\nDoD:\n${memory.read().dod.map((d) => `- ${d.text}`).join("\n")}` }],
      } as any);
      budget.spent += resp.usage?.output_tokens ?? 0;
      const tu = resp.content.find((b: any) => b.type === "tool_use");
      const verdict = (tu?.input as any)?.verdict === "approved" ? "approved" : "changes-requested";
      const feedback = (tu?.input as any)?.feedback;
      memory.review(id, verdict as any, feedback);
      for (const text of ((tu?.input as any)?.dodDone ?? []) as string[]) {
        const item = memory.read().dod.find((d) => d.text === text);
        if (item) memory.checkDoD(item.id, true);
      }
      onEvent({ kind: "agent_message", agent: "orchestrator", content: `Reviewed ${id}: ${verdict}${feedback ? ` — ${feedback}` : ""}` });
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/fleet/orchestrator.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/fleet/orchestrator.ts src/fleet/orchestrator.test.ts
git commit -m "feat(fleet): orchestrator plan/batch/review/loop"
```

---

## Task 13: Wire FleetOrchestrator into ProjectOrchestrator (integration seam)

**Files:**
- Modify: `src/agents/project-orchestrator.ts`
- Test: `src/agents/project-orchestrator.fleet.test.ts`

**Goal:** `runBuild`/`runChat` delegate to the fleet, persisting messages/assets in the existing state maps and streaming the same events. The simulated `runOp`/`classifyIntent`/`generateAndPersist*` helpers become unused by the new paths but are left in place (no dead-code churn) — or are removed if the file's other consumers don't need them (they don't; only `runBuild`/`runChat` called them).

- [ ] **Step 1: Write the failing integration test**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProjectOrchestrator } from "./project-orchestrator";
import type { OrchestratorEvent } from "./project-orchestrator";

const fakeImages = {
  async generateImage() { return { dataUrl: "x", mimeType: "image/svg+xml", width: 1, height: 1, provider: "fake" }; },
  async generateAnimation() { return { content: "{}", mode: "lottie" as const, mimeType: "application/json", provider: "fake" }; },
};
const fakePlanner = { async plan() { return { kind: "live_app", name: "shop", stack: "Next.js", runtime: "node", region: "fsn1", services: { needsDatabase: false, needsMail: false, needsSms: false }, buildPlan: [], media: { logo: false, hero: false, favicon: false, iconSet: false, heroAnimation: false, socialOgImage: false }, summary: "a shop" }; } };

function scriptedClient(root: string) {
  return { messages: { create: async (body: any) => {
    const forced = body.tool_choice?.name;
    if (forced === "emit_build_plan") return { stop_reason: "tool_use", usage: { output_tokens: 5 }, content: [{ type: "tool_use", id: "p", name: "emit_build_plan", input: { dod: ["home page renders"], batches: [{ agents: ["react-engineer"] }] } }] };
    if (forced === "review_handoff") return { stop_reason: "tool_use", usage: { output_tokens: 5 }, content: [{ type: "tool_use", id: "r", name: "review_handoff", input: { verdict: "approved", dodDone: ["home page renders"] } }] };
    // agent turn: write a file then stop
    return { stop_reason: "tool_use", usage: { output_tokens: 5 }, content: [{ type: "tool_use", id: "t", name: "write_file", input: { path: "src/page.tsx", contents: "export default () => null;" } }] };
  } } };
}

test("runBuild via the fleet writes a real file and streams result+done", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fleet-int-"));
  const events: OrchestratorEvent[] = [];
  const orch = new ProjectOrchestrator({
    cp: {} as any, planner: fakePlanner as any, images: fakeImages as any,
    fleet: { client: scriptedClient(root), workspaceRoot: root }, // test-only injection
  } as any);
  await orch.runBuild({ projectId: "p1", plan: await fakePlanner.plan() as any, onEvent: (e) => events.push(e) });
  assert.equal(events.at(-1)?.kind, "done");
  assert.ok(events.some((e) => e.kind === "result"));
  const ws = path.join(root, "p1", "workspace");
  assert.ok(existsSync(path.join(ws, "src/page.tsx")), `expected file written; ws had: ${existsSync(ws) ? readdirSync(ws) : "(none)"}`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/agents/project-orchestrator.fleet.test.ts`
Expected: FAIL — `ProjectOrchestrator` doesn't accept a `fleet` dep / still simulated.

- [ ] **Step 3: Modify `project-orchestrator.ts`**

3a. Extend imports + deps. Near the top imports add:

```ts
import { FleetOrchestrator } from "../fleet/orchestrator";
import { FleetMemory } from "../fleet/memory";
import { buildFleetClient, type AnthropicLike } from "../fleet/anthropic";
```

3b. Extend `ProjectOrchestratorDeps`:

```ts
export interface ProjectOrchestratorDeps {
  cp: ControlPlane;
  planner: DeployPlanner;
  images: ImageProvider;
  /** Fleet wiring. Defaults to a client from ANTHROPIC_API_KEY + env workspace root.
   *  Tests inject a fake client + temp root. */
  fleet?: { client?: AnthropicLike | null; workspaceRoot?: string };
}
```

3c. In the class, add fields + construct the fleet in the constructor. Replace the constructor:

```ts
  private fleet: FleetOrchestrator;
  private fleetMemories: Map<string, FleetMemory> = new Map();

  constructor(private deps: ProjectOrchestratorDeps) {
    const client = deps.fleet?.client !== undefined ? deps.fleet.client : buildFleetClient();
    const workspaceRoot = deps.fleet?.workspaceRoot ?? process.env.FLEET_WORKSPACE_ROOT ?? "runtime/projects";
    this.fleet = new FleetOrchestrator({ client, images: deps.images, workspaceRoot });
  }

  private fleetMemory(projectId: string): FleetMemory {
    let m = this.fleetMemories.get(projectId);
    if (!m) { m = new FleetMemory(projectId); this.fleetMemories.set(projectId, m); }
    return m;
  }
```

3d. Replace the body of `runBuild` with delegation that also persists messages/assets into the existing state maps:

```ts
  async runBuild(input: { projectId: string; plan: DeployPlan; onEvent: OrchestratorEventHandler }): Promise<void> {
    const { projectId, plan, onEvent } = input;
    await this.fleet.build({
      projectId,
      plan,
      memory: this.fleetMemory(projectId),
      onEvent: (e) => this.persistAndForward(projectId, e, onEvent),
    });
  }
```

3e. Replace the body of `runChat` with delegation:

```ts
  async runChat(input: { projectId: string; message: string; onEvent: OrchestratorEventHandler }): Promise<void> {
    const { projectId, message, onEvent } = input;
    // Persist the user's message first (the UI shows it optimistically too).
    this.appendMessage(projectId, { role: "user", kind: "message", content: message }, onEvent);
    await this.fleet.chat({
      projectId,
      message,
      memory: this.fleetMemory(projectId),
      onEvent: (e) => this.persistAndForward(projectId, e, onEvent),
    });
  }
```

3f. Add the `persistAndForward` bridge (maps fleet events → existing state maps + forwards verbatim):

```ts
  /** Bridge fleet events into the existing in-memory state (messages/assets)
   *  so listMessages/listAssets/getBrain still reflect the build, then forward
   *  the event unchanged to the SSE handler. */
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
      default:
        break;
    }
    onEvent(e);
  }
```

3g. Leave `seedFromDeploy`, `listMessages`, `listAssets`, `getBrain`, `ensure`, `makeMessage`, `appendMessage` as-is. (The old `runOp`/`classifyIntent`/`defaultReply`/`generateAndPersistImage`/`generateAndPersistAnimation` are now only referenced by removed code; delete them and the now-unused `Intent` type + helpers `slugify`/`sleep` to keep the file clean. Keep `estimateTokens`/`estimateBytes`/`nowIso` only if still referenced — `nowIso` is used by `makeMessage`/`seedFromDeploy`, keep it; remove `estimateBytes` if unreferenced.)

- [ ] **Step 4: Run the integration test**

Run: `npx tsx --test src/agents/project-orchestrator.fleet.test.ts`
Expected: PASS (1 test). The file `src/page.tsx` exists under the temp workspace.

- [ ] **Step 5: Typecheck the whole package**

Run: `npm run typecheck`
Expected: no errors. Fix any type issues from removed helpers (unused imports, etc.).

- [ ] **Step 6: Commit**

```bash
git add src/agents/project-orchestrator.ts src/agents/project-orchestrator.fleet.test.ts
git commit -m "feat(fleet): delegate ProjectOrchestrator build/chat to the fleet engine"
```

---

## Task 14: Full suite + manual smoke

**Files:** none (verification only)

- [ ] **Step 1: Run the full fleet + agents test suite**

Run: `npx tsx --test src/fleet/**/*.test.ts src/agents/*.test.ts`
Expected: all PASS.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Manual smoke (live, optional — uses real API + tokens)**

Start the control plane: `npm run dev` (loads `.env.local`, so `ANTHROPIC_API_KEY` is set → fleet live). In the console, open `/chat`, send "build a simple landing page for a coffee shop". Confirm: redirect to the workspace, op cards stream attributed to real agents (orchestrator, react-engineer, …), and files appear under `runtime/projects/<id>/workspace`. Stop after one round to bound cost.

- [ ] **Step 4: Commit any fixes**

```bash
git add -A
git commit -m "test(fleet): full suite green + smoke notes"
```

---

## Self-Review notes (author)

- **Spec coverage:** roster (T9), skills incl. workspace files + media + memory (T5–T8), FleetMemory state machine (T4), runner with graceful offline fallback (T11), orchestrator plan/batch/review/QA-via-DoD loop + budget caps (T12, T1), integration seam with no UI/SSE change + real-file assertion (T13), tests at each layer + integration (T1–T14). Event contract reused verbatim from `project-orchestrator.ts`.
- **Deferred (per spec non-goals):** deploy-to-live-URL, Prisma persistence, sandboxed shell — not in any task, intentionally.
- **Type consistency:** `SkillContext`/`SkillResult`/`Skill` defined once in `skills/files.ts` and imported elsewhere; `AgentRole`/`Handoff`/`BuildPlan`/`SkillId` defined once in `types.ts`; events/`ProjectAsset` imported from `project-orchestrator.ts`; `AnthropicLike` defined once in `anthropic.ts`.
- **Known approximation:** model ids in `anthropic.ts` use the env's stated ids (`claude-opus-4-8`, `claude-sonnet-4-6`); adjust if the account exposes different aliases.
