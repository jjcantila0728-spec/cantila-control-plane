# Cantila Fleet Build Engine — Design

**Date:** 2026-05-30
**Status:** Approved (brainstorming) → ready for implementation plan
**Scope (slice 1):** A real, server-side multi-agent build engine in the control-plane that
replaces the *simulated* internals of `ProjectOrchestrator`, wiring **all 78 AgentFleet agents**
into Cantila's chat → project-builder flow. Produces **real files** in a per-project workspace,
streams real op cards to the existing console workspace, and persists messages/assets. Deploy to a
live URL and Prisma persistence are explicitly later phases.

---

## 1. Background & goal

Cantila's chat (`/chat` → `Chat.tsx`) already shapes a prompt into a deploy plan, creates a project,
and redirects into the per-project workspace (`/@handle/<name>` → `ProjectWorkspace` → `ProjectChat`),
which opens an SSE stream to `POST /v1/projects/:id/build` and renders streamed **op cards**.

The streaming, the workspace UI, the asset gallery, and the `OrchestratorEvent` event shape all exist
and work. The gap is purely the **engine**: `ProjectOrchestrator.runBuild`/`runChat`
(`src/agents/project-orchestrator.ts`) are simulated — `sleep(450)`, "pretend to lay down the template
tree", a regex intent classifier, and canned replies. The file itself notes: *"swap in a Sonnet
tool-use call here."*

Separately, `AgentFleet/` is a Claude-Code-native workspace of **78 specialist agents** across 13
divisions plus a coordination contract (`memory.md`, `handoff-template.md`) and the build→MVP loop
(`FLEET.md`). Each agent is a markdown file: YAML front-matter (`name`, `description`, `tools`,
`model: opus|sonnet`) + a markdown body that is the system prompt.

**Goal:** make the chat actually drive a real fleet build, using the AgentFleet roster, by replacing
the orchestrator's simulated internals with a generic Anthropic-SDK-backed engine — **without changing
the HTTP routes, the SSE protocol, or the console UI.**

### Decisions locked in brainstorming
- Integration target: **real server-side fleet build engine** (not a Claude-Code bridge, not dev-tooling).
- Fleet breadth: **all 78 agents** (as data; the engine is generic).
- Build depth (slice 1): **real files in a per-project workspace, streamed + persisted.** Deploy-to-live-URL deferred.
- Persistence: **in-memory** for slice 1 (matches `STORE=memory` default + the existing orchestrator). Prisma later.

---

## 2. Non-goals (later phases)

- **Phase 2** — Deploy-to-live-URL: chain the finished build into the *existing* deploy pipeline
  (`src/deploy/*`, Coolify data plane). Do **not** rebuild deploy.
- **Phase 3** — Prisma persistence of fleet memory / files / handoffs (mind the boot-migrations
  gotcha: new columns must be added to `boot-migrations.ts` or prod 500s).
- **Later** — sandboxed `run_command` / real `npm build` inside the workspace (security/sandboxing).
- We do **not** run the AgentFleet `.claude` PowerShell launchers or Workflow scripts on the server;
  the server engine reimplements their *intent* natively.

---

## 3. Architecture

All new code lives under `cantila-control-plane/src/fleet/`. The only edit to existing runtime code is
that `ProjectOrchestrator.runBuild`/`runChat` delegate to the new `FleetOrchestrator`. Env-gated like
the rest of the codebase: live when `ANTHROPIC_API_KEY` is set, graceful fallback otherwise.

```
chat prompt
  → (existing) builderApi.planDeploy → DeployPlanner            [unchanged]
  → (existing) api.createProject                                [unchanged]
  → workspace opens SSE POST /v1/projects/:id/build             [unchanged]
  → ProjectOrchestrator.runBuild(plan, onEvent)                 [delegates ↓]
      → FleetOrchestrator.build({ projectId, plan, workspaceDir, onEvent })
          → plan: DoD checklist + parallel batch plan
          → for each batch: fan out agents via FleetAgentRunner (capped concurrency)
              → each agent: Anthropic tool-use loop, calls skills (write_file → real files)
              → emits op_started / op_finished / asset_created / agent_message
              → writes handoff (status: pending-review)
          → review gate: approve | changes-requested (+ re-run)
          → integrate → QA roles vs DoD → route fixes → repeat until green or budget hit
          → emit result + done
```

### 3.1 Components (each isolated, one clear purpose)

**A. Roster — `src/fleet/roster/`**
- `types.ts`: `AgentRole { id; name; division; description; model: 'opus'|'sonnet'; allowedSkills: SkillId[]; systemPrompt: string }`.
- `roster.generated.ts`: the 78 roles as data, produced by a build script.
- `index.ts`: `getRole(id)`, `listRoles()`, `rolesByDivision()`.
- `scripts/port-fleet.mjs`: reads `AgentFleet/.claude/agents/**/*.md`, parses YAML front-matter +
  body, maps `tools:` → `allowedSkills` (see B), and writes `roster.generated.ts`. Re-runnable so the
  roster stays faithful to AgentFleet. Committed output (no build-time dependency on the AgentFleet dir
  at runtime).
- **What it does:** the source of truth for who the agents are. **Depends on:** the AgentFleet md files
  (build-time only) + the skill registry's SkillId set.

**B. Skill registry — `src/fleet/skills/`**
- Each skill = `{ id, tool: Anthropic.Tool, run(ctx, input): Promise<SkillResult> }` where `ctx`
  carries `projectId`, `workspaceDir`, the `ImageProvider`, and a `FleetMemory` handle.
- Slice-1 skills:
  - `write_file(path, contents)`, `read_file(path)`, `list_files()` — sandboxed to
    `runtime/projects/<id>/workspace`; **path-traversal guarded** (resolve + assert prefix). The "real
    files" output.
  - `generate_image(prompt, preset, aspect?)`, `generate_animation(prompt, mode)` — delegate to the
    existing `ImageProvider`; persist as a `ProjectAsset` (same shape the gallery renders) + emit
    `asset_created`.
  - `read_memory()`, `write_handoff(handoff)` — coordination contract against `FleetMemory`.
- `tools:` → SkillId mapping: `Write|Edit` → file-write skills, `Read|Glob|Grep` → `read_file`/`list_files`,
  image/asset agents → image skills, all agents → `read_memory`/`write_handoff`. `Bash`/`Task` map to
  **no** skill in slice 1 (deferred). Mapping table lives in `skills/tool-map.ts`.
- **What it does:** the only way agents affect the world. **Depends on:** workspace fs, ImageProvider, FleetMemory.

**C. FleetMemory — `src/fleet/memory.ts`**
- Per-project shared state mirroring `memory.md` + `handoffs/`:
  `{ project: {name, goal, stack, status}; dod: DoDItem[]; decisions: Decision[]; summary: string;
  handoffs: Map<agentId, Handoff> }`.
- `Handoff { agent; round; status: 'pending-review'|'approved'|'changes-requested'; reviewer?; feedback?; body }`
  — the state machine from `handoff-template.md`.
- API: `read()`, `setDoD(items)`, `checkDoD(id, done)`, `putHandoff(h)`, `review(agent, verdict, feedback?)`,
  `appendDecision(d)`, `relevantSlice(agentId)` (returns the memory context an agent should see, kept
  small for token budget).
- **In-memory v1**, one instance per project, held by `ProjectOrchestrator` state.

**D. FleetAgentRunner — `src/fleet/runner.ts`**
- `run({ role, task, memory, ctx, onEvent, budget }): Promise<Handoff>`.
- Bounded Anthropic tool-use loop (reuses the `claude.ts` pattern): model from `role.model`, system =
  `role.systemPrompt` (+ a short Cantila-fleet preamble) marked `cache_control: ephemeral`; tools =
  `role.allowedSkills` defs; user turn = task + `memory.relevantSlice(role.id)`.
- Loop: call model → if `tool_use`, run the skill, stream op cards, feed `tool_result` back → repeat
  until the model stops or the **per-agent step cap** is hit. Final assistant text → handoff body
  (`write_handoff` if the model didn't call it explicitly).
- Streams `op_started`/`op_finished`/`asset_created`/`agent_message` with `agent: role.id` so the UI
  attributes each card to the specialist.
- **Graceful fallback:** no client → emit one `op_finished {status:'failed', detail:'fleet offline — set ANTHROPIC_API_KEY'}` and return a stub handoff. Never fake success.

**E. FleetOrchestrator — `src/fleet/orchestrator.ts`** (the `00-orchestrator` brain)
- `build({ projectId, plan, workspaceDir, onEvent })`:
  1. **Plan** — run the orchestrator role with a forced-tool-use `emit_build_plan` tool →
     `{ dod: string[]; batches: { agents: agentId[] }[] }`. Seed `FleetMemory` (name/goal/stack from the
     DeployPlan). Stream the plan as an `agent_message`.
  2. **Batches** — for each batch, fan out its agents via `FleetAgentRunner` with a **concurrency cap**
     (default 4). Each writes a `pending-review` handoff.
  3. **Review gate** — orchestrator role reviews each handoff (forced-tool-use `review_handoff` →
     `{verdict, feedback?}`); `changes-requested` re-runs that agent (bump round) up to a per-agent
     retry cap.
  4. **Integrate + QA** — run `qa-engineer` (+ `human-tester` reasoning) against the DoD; gaps → route
     fix tasks back to the responsible agents (a new batch).
  5. **Loop** until every DoD item passes or the **build budget** (token + round caps) is exhausted;
     then emit `result { name, url, stack }` (url = `<name>.cantila.app` placeholder until phase 2) +
     `done`. If budget-bounded out, say so honestly in the result message.
- `chat({ projectId, message, onEvent })`: route a follow-up — orchestrator/task-router role picks the
  responsible agent(s); run them via the runner; review; stream. Replaces the regex `classifyIntent`.
- **Routing** uses division + the agents' `Collaborates with` graph as hints in the orchestrator's
  context (not hard-coded edges).

**F. Integration seam — `src/agents/project-orchestrator.ts`** (edited)
- Construct a `FleetOrchestrator` (inject planner, ImageProvider, a `workspaceRoot` from env
  `FLEET_WORKSPACE_ROOT` default `runtime/projects`). Hold one `FleetMemory` per project in the existing
  state map.
- `runBuild` → `fleet.build(...)`; `runChat` → `fleet.chat(...)`. Keep `seedFromDeploy`, `listMessages`,
  `listAssets`, `getBrain` (brain reads from `FleetMemory.summary` + counts). Persist messages/assets in
  the existing maps via the same `appendMessage`/asset paths so a refresh shows the same thing.
- **No changes** to `src/index.ts` routes, the SSE protocol, or any console file.

### 3.2 Config & safety
- `src/fleet/config.ts`: `FLEET_LIVE = !!process.env.ANTHROPIC_API_KEY`; caps —
  `MAX_ROUNDS` (default 4), `MAX_AGENT_STEPS` (default 8), `MAX_CONCURRENCY` (4),
  `BUILD_TOKEN_BUDGET` (default ~300k output tokens; configurable via env). Caps surface as honest
  result messages, never silent truncation.
- Security-division agents operate authorized/defensive-only (system preamble enforces it).
- Workspace writes are sandboxed; no arbitrary shell in slice 1.

---

## 4. Event contract (unchanged — what the UI consumes)

The engine emits exactly the existing `OrchestratorEvent` union (`src/agents/project-orchestrator.ts`):
`agent_message` · `op_started` · `op_finished` · `asset_created` · `message_persisted` · `result` ·
`error` · `done`, each op carrying an `agent` string (now a real specialist id like `system-architect`,
`react-engineer`). `ProjectChat` already attributes op cards by `agent` and renders assets by `path` —
no UI work required. Op `opKey` conventions kept (`image:<path>`, `anim:<path>`) so the asset upsert in
`ProjectChat` keeps working.

---

## 5. Testing (TDD)

- **Roster loader:** all 78 md files parse; every role has a valid model + ≥1 skill; ids unique.
- **Skill executors:** `write_file`/`read_file` confined to workspace; path-traversal (`../`, absolute)
  rejected; image skill produces a `ProjectAsset` + `asset_created`.
- **FleetMemory:** handoff state machine (pending-review → approved / changes-requested → re-run bumps round);
  `relevantSlice` stays within a size bound.
- **Runner:** with a **mocked Anthropic client**, a scripted tool_use → executes skill → feeds tool_result →
  terminates at step cap; emits the expected op events; offline fallback emits a failed card, not fake success.
- **Orchestrator:** mocked client drives plan → 1 batch → review → DoD pass; asserts the exact ordered
  event sequence `ProjectChat` consumes; budget cap ends the loop with an honest result.
- **Integration:** `ProjectOrchestrator.runBuild` with the stub client writes ≥1 real file into a temp
  workspace and streams a coherent op-card sequence ending in `result` + `done`.

---

## 6. Files (slice 1)

```
cantila-control-plane/
  src/fleet/
    config.ts
    types.ts                 # shared fleet types (events re-exported from project-orchestrator)
    roster/
      types.ts
      index.ts
      roster.generated.ts    # produced by port-fleet.mjs (committed)
    skills/
      index.ts               # registry
      tool-map.ts            # AgentFleet tools: → SkillId
      files.ts               # write/read/list (workspace-sandboxed)
      media.ts               # generate_image / generate_animation (ImageProvider)
      memory-skills.ts       # read_memory / write_handoff
    memory.ts                # FleetMemory
    runner.ts                # FleetAgentRunner
    orchestrator.ts          # FleetOrchestrator
  scripts/
    port-fleet.mjs           # md → roster.generated.ts
  src/agents/project-orchestrator.ts   # EDIT: delegate runBuild/runChat
  test/fleet/**              # vitest specs
```

---

## 7. Risks & mitigations

- **Cost/runaway loops** → hard token budget + round/step/concurrency caps; honest budget-exhausted result.
- **Untrusted file writes** → workspace sandbox + path-traversal guard; no shell in slice 1.
- **Roster drift from AgentFleet** → committed generated roster + re-runnable port script.
- **Token bloat per agent** → `relevantSlice` trims memory; cached system prompts.
- **Behaviour change with no key** → graceful "fleet offline" cards; existing rule-based DeployPlanner
  path unaffected.
- **Prod parity** → slice 1 is in-memory only; no migrations, so the boot-migrations gotcha is untouched
  until phase 3.
