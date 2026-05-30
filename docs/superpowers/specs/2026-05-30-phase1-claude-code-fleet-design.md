# Phase 1 — Claude Code Fleet + /agents Org Chart — Design

**Date:** 2026-05-30
**Status:** Approved (brainstorming) → ready for implementation plan
**Part of:** the Cantila agent-organization north-star (see memory `project_cantila_agent_org`).
Supersedes `2026-05-30-fleet-build-engine-design.md` (hand-rolled engine).

## 1. Goal

Make Cantila's build agents **live, powered by Claude Code** (the Claude Agent SDK,
`@anthropic-ai/claude-agent-sdk`), running **in the control-plane container**; port **all 78
AgentFleet build agents** to SDK `AgentDefinition`s; redesign the console **`/agents`** page into a
**live organizational flow-chart of the whole operation**; and make **chat → build** produce **real
files** in a per-project workspace via a single bounded Claude Code session — streamed to the existing
UI with no SSE/route changes.

## 2. Decisions (locked)

- Engine: **Claude Agent SDK**, headless, in-container. One `query()` session per build (the
  orchestrator delegates to subagents *inside* the session → ~1–2 GiB RAM per active build).
- Breadth: **all 78 build agents** ported to programmatic `AgentDefinition`s.
- `/agents`: becomes the **org-flowchart of the whole operation** (every division + agent as nodes,
  live status). The existing ops-brain "diary" (learnings/proposals/actions) is **preserved** as a
  section/tab — nothing removed.
- Persistence: in-memory (matches current posture). Prisma later.
- Auth: `ANTHROPIC_API_KEY` (already in `.env.local`).

## 3. Non-goals (later phases)

- **Phase 2:** unify the 9-agent ops brain onto Claude Code + Claude-Code auto-fix for safe/high-
  confidence ops (destructive stays gated).
- **Phase 3:** 24/7 autonomous scheduler + org-wide outcome→confidence learning + budget governance.
- **Phase 4:** deploy built products to live URLs; widen autonomy.
- Phase 1 does **not** change ops-brain behaviour, deploy, or persistence.

## 4. Architecture

New + changed code under `cantila-control-plane/src/fleet/` (engine) and `cantila-console/src/`
(UI). Env-gated: live when the SDK + `ANTHROPIC_API_KEY` are present; otherwise a graceful "fleet
offline" path (no fake work).

### 4.1 Engine (control-plane)

**Survives from the superseded plan (already built, branch `feat/fleet-build-engine`):**
- `config.ts` — extend with `maxBudgetUsd` (default 2.0) and `maxConcurrentBuilds` (default 2).
- `types.ts` — `AgentRole` reused; add `SdkToolName` + `AgentSessionStatus` types.
- `workspace.ts` — the per-project `cwd` sandbox (`workspaceDir`, `resolveInWorkspace`) — reused as
  the session `cwd` root.
- `memory.ts` — `FleetMemory` reused to hold DoD/decisions/handoffs for **surfacing to the UI**
  (optional in the run loop; the SDK session coordinates via its own context + workspace files).

**New:**
- `roster/roster.generated.ts` + `scripts/port-fleet.mjs` — port every `AgentFleet/.claude/agents/
  **/*.md` (front-matter + body) into `AgentRole` records (id, name, division, model, description,
  systemPrompt, the raw `tools:` list). Committed, re-runnable.
- `roster/agent-defs.ts` — `agentDefinitions(): Record<string, AgentDefinition>` maps each `AgentRole`
  to an SDK `AgentDefinition` `{ description, prompt, tools, model }`. `tools:` → SDK tool names via
  `toSdkTools()` (Read/Write/Edit/Glob/Grep/Bash/Agent; unknown dropped). The orchestrator role
  (`00-orchestrator`) is the session's main agent and always gets `Agent` (delegation).
- `sdk.ts` — `QueryFn` type alias for the SDK `query` signature; `loadQuery(): QueryFn | null` lazily
  imports `@anthropic-ai/claude-agent-sdk` and returns `query`, or `null` if the package/key is
  missing. Injected everywhere so tests pass a fake async-generator `query`.
- `event-map.ts` — `mapSdkMessage(msg, ctx): OrchestratorEvent[]` — pure mapping from SDK stream
  messages (assistant text, tool_use, tool_result, result) to the existing `OrchestratorEvent` union
  (`agent_message` / `op_started` / `op_finished` / `asset_created` / `result` / `error` / `done`),
  attributing ops to the acting subagent. Tracks tool_use→result pairing by id for `op_finished`.
- `session-registry.ts` — `FleetSessionRegistry`: in-memory per-project session + per-agent live
  status (`idle|working|done|failed` + lastAt), updated as events stream; read by the org endpoint.
- `claude-fleet.ts` — `ClaudeFleet` with deps `{ query: QueryFn | null; workspaceRoot; registry }`:
  - `build({ projectId, plan, onEvent })`: resolve `cwd = workspaceDir(root, projectId)` (mkdir);
    compose the orchestrator build prompt from the `DeployPlan`; call `query({ prompt, options: {
    cwd, agents: agentDefinitions(), allowedTools, disallowedTools, permissionMode: 'dontAsk',
    maxTurns, maxBudgetUsd, model: 'opus' } })`; for-await the stream, run each msg through
    `mapSdkMessage`, update the registry, forward via `onEvent`; end with `result` + `done`.
  - `chat({ projectId, message, onEvent })`: same, continuing in the project `cwd`.
  - Offline (`query === null`): emit one informative `agent_message` + `done`. Never fake success.
  - A small **concurrency gate** (`maxConcurrentBuilds`) queues excess builds.

**Integration seam — `src/agents/project-orchestrator.ts` (edit):**
- Construct a `ClaudeFleet` (inject `loadQuery()`, `FLEET_WORKSPACE_ROOT` default `runtime/projects`,
  the shared `FleetSessionRegistry`). `runBuild` → `fleet.build`, `runChat` → `fleet.chat`, each
  through a `persistAndForward(projectId, e, onEvent)` bridge that mirrors events into the existing
  message/asset state maps (so `listMessages`/`listAssets`/`getBrain` + refresh keep working) and
  forwards the event unchanged. `seedFromDeploy` unchanged. **No HTTP/SSE/route change** for
  build/chat.

**New endpoint — `src/index.ts`:**
- `GET /v1/agents/org` → `{ divisions: [{ key, label, agents: [{ id, name, model, description,
  status, lastAt }] }], activeBuilds: number }`. Built from the roster (grouped by division) joined
  with the `FleetSessionRegistry` live status. Read-only; session-gated like other console reads.

### 4.2 Safety

`permissionMode: 'dontAsk'` (deny anything not allow-listed); `allowedTools` limited to
Read/Write/Edit/Glob/Grep/Bash/Agent; `disallowedTools` blocks destructive bash
(`Bash(rm:*)`, `Bash(sudo:*)`, `Bash(git push:*)`, etc.); `cwd` sandbox = the project workspace;
`maxTurns` + `maxBudgetUsd` + `maxConcurrentBuilds` bound cost; security-division agents are
authorized/defensive-only via their prompt. The ops-brain destructive-action approval gate is
untouched.

### 4.3 UI (console)

- `lib/api.ts` — add `getAgentOrg(): Promise<ApiAgentOrg>` (+ the `ApiAgentOrg` types) hitting
  `/v1/agents/org`.
- `components/agents/FleetOrgChart.tsx` — renders the org-flowchart: divisions as groups, agents as
  nodes, live-status badges (idle/working/done/failed). Polls `getAgentOrg()` (~5 s) like the
  existing snapshot loop. Mobile-first, on-brand (Tailwind tokens already in the console).
- `components/AgentsView.tsx` — redesign: the **org chart is the primary surface**; the existing
  ops-brain diary (learnings / pending proposals / recent actions / observations) + owner chat +
  suggestion rail are kept **below or under a tab** (no functionality removed). The current
  `AgentsCanvas` (9-node hub) is retained inside the ops-brain section.

## 5. Data flow

chat → (existing) planDeploy → createProject → workspace SSE `/v1/projects/:id/build` →
`ProjectOrchestrator.runBuild` → **`ClaudeFleet.build`** → one Claude Code `query()` session in the
project `cwd`, orchestrator delegating to specialist subagents that use real Read/Write/Edit/Bash
tools → SDK stream → `mapSdkMessage` → existing op-card events → UI renders cards attributed per
agent, real files land in `runtime/projects/<id>/workspace`, `/agents` org chart shows live status.

## 6. Files (Phase 1)

```
cantila-control-plane/
  src/fleet/
    config.ts                 # EDIT: + maxBudgetUsd, maxConcurrentBuilds
    types.ts                  # EDIT: + SdkToolName, AgentSessionStatus
    workspace.ts              # reuse
    memory.ts                 # reuse (surfacing)
    roster/
      roster.generated.ts     # NEW (port-fleet.mjs output)
      agent-defs.ts           # NEW (AgentRole -> SDK AgentDefinition) + toSdkTools()
      index.ts                # NEW (listRoles/getRole/rolesByDivision)
    sdk.ts                    # NEW (QueryFn + loadQuery)
    event-map.ts              # NEW (SDK message -> OrchestratorEvent[])
    session-registry.ts       # NEW (live status)
    claude-fleet.ts           # NEW (ClaudeFleet.build/chat + concurrency gate)
  scripts/port-fleet.mjs      # NEW
  src/agents/project-orchestrator.ts   # EDIT: delegate to ClaudeFleet
  src/index.ts                # EDIT: GET /v1/agents/org
  test/fleet/**               # node:test specs
cantila-console/
  src/lib/api.ts                       # EDIT: getAgentOrg + types
  src/components/agents/FleetOrgChart.tsx   # NEW
  src/components/AgentsView.tsx        # EDIT: org chart primary + ops brain preserved
```

## 7. Testing (TDD)

- **agent-defs/roster:** all 78 `.md` parse; each maps to a valid `AgentDefinition`; `toSdkTools`
  maps Write/Edit→Write+Edit, Read/Glob/Grep→those, Bash→Bash, Task→Agent; unknown dropped;
  orchestrator gets `Agent`.
- **event-map:** SDK message fixtures (assistant text, tool_use, tool_result ok/err, result) →
  expected `OrchestratorEvent[]`; tool_use/result paired into op_started/op_finished by id.
- **session-registry:** status transitions idle→working→done/failed; org grouping by division.
- **ClaudeFleet.build:** injected **fake `query`** (async generator of SDK messages) → asserts the
  forwarded event sequence ends in `result`+`done`, registry updates, and that `options` passed to
  query carry `cwd`, `permissionMode:'dontAsk'`, `maxTurns`, `maxBudgetUsd`; offline path emits a
  message + done (no fake success); concurrency gate queues beyond the cap.
- **/v1/agents/org:** returns divisions+agents+activeBuilds in the documented shape.
- **ProjectOrchestrator integration:** with the fake query, `runBuild` streams result+done and a
  written file lands under a temp workspace; messages/assets persist in the existing maps.
- **UI:** `FleetOrgChart` renders divisions/agents/status from a fixture (render smoke).

## 8. Risks & mitigations

- **Cost/runaway** → `maxTurns` + `maxBudgetUsd` + `maxConcurrentBuilds`; honest budget-exhausted result.
- **Untrusted tool use** → `permissionMode:'dontAsk'`, `disallowedTools` for destructive bash, `cwd` sandbox.
- **RAM under concurrency** → concurrency gate (default 2); each build = one subprocess.
- **SDK availability in the Coolify image** → `loadQuery()` returns null gracefully; the binary is
  bundled with the npm package (no separate CLI install), Node 18+.
- **Roster drift** → committed generated roster + re-runnable port script.
- **Concurrent repo work** → all Phase 1 work in the `feat/fleet-build-engine` git worktree.
