/* ============================================================
   ProjectOrchestrator — Cantila's per-project agent team.

   The orchestrator owns the brain of a single project:
   - Holds the chat thread (ProjectMessage rows)
   - Holds the rolling summary (ProjectMemory)
   - Holds the asset catalogue (ProjectAsset rows)
   - Knows how to run a build round (scaffold → media → deploy)
   - Streams each step out to the chat UI as op cards

   v1 keeps state in-memory (same posture as the default control
   plane store). When `STORE=prisma` we can swap each Map for a
   PrismaClient call; the public surface stays the same.

   This module deliberately does not own the LLM call itself —
   it composes `DeployPlanner` (initial intent) with skill calls
   (write_file / generate_image / deploy / ...). Tool-use chats
   for follow-ups land in `runChat()`, which currently performs a
   small deterministic intent classifier; swap in a Sonnet-tool-use
   call here when ANTHROPIC_API_KEY is configured.
   ============================================================ */

import { randomBytes } from "crypto";
import type { ControlPlane } from "../core/control-plane";
import type {
  DeployPlan,
  DeployPlanner,
} from "../ai/deploy-planner";
import type { ImageProvider } from "../skills/image-provider";
import { ClaudeFleet } from "../fleet/claude-fleet";
import { FleetSessionRegistry } from "../fleet/session-registry";
import { loadQuery, type QueryFn } from "../fleet/sdk";

/* ---------- types ---------- */

export type ProjectMessageRole = "user" | "agent" | "system" | "tool";
export type ProjectMessageKind = "message" | "op_card" | "result" | "asset";

export interface ProjectMessage {
  id: string;
  projectId: string;
  role: ProjectMessageRole;
  agent?: string;
  kind: ProjectMessageKind;
  content: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export type ProjectAssetKind =
  | "image"
  | "icon"
  | "lottie"
  | "css_anim"
  | "video"
  | "copy"
  | "file";

export interface ProjectAsset {
  id: string;
  projectId: string;
  kind: ProjectAssetKind;
  path: string;
  mimeType: string;
  width?: number;
  height?: number;
  prompt?: string;
  provider: string;
  sizeBytes: number;
  createdAt: string;
  /** Inline data (data URL or text) so the gallery can preview without
   *  hitting a blob store. In production this is replaced by a CDN url. */
  dataUrl?: string;
}

export interface ProjectMemorySnapshot {
  projectId: string;
  summary: string;
  tokenCount: number;
  lastSummarizedMessageId?: string;
  updatedAt: string;
}

export interface BrainSnapshot {
  memory: ProjectMemorySnapshot;
  messageCount: number;
  assetCount: number;
  lastChangeAt?: string;
}

export type OrchestratorEvent =
  | { kind: "agent_message"; agent: string; content: string }
  | { kind: "op_started"; opKey: string; agent: string; title: string }
  | { kind: "op_finished"; opKey: string; agent: string; title: string; detail?: string; status: "ok" | "failed" }
  | { kind: "asset_created"; asset: ProjectAsset }
  | { kind: "message_persisted"; message: ProjectMessage }
  | { kind: "result"; name: string; url: string; stack: string }
  | { kind: "error"; error: string }
  | { kind: "done" };

export type OrchestratorEventHandler = (event: OrchestratorEvent) => void;

/* ---------- orchestrator ---------- */

export interface ProjectOrchestratorDeps {
  cp: ControlPlane;
  planner: DeployPlanner;
  images: ImageProvider;
  /** Fleet wiring. Defaults to the real SDK query + env workspace root. Tests inject a fake query. */
  fleet?: { query?: QueryFn | null; workspaceRoot?: string; registry?: FleetSessionRegistry };
}

interface ProjectState {
  messages: ProjectMessage[];
  assets: ProjectAsset[];
  memory: ProjectMemorySnapshot;
}

export class ProjectOrchestrator {
  private state: Map<string, ProjectState> = new Map();
  private claudeFleet: ClaudeFleet;
  readonly sessionRegistry: FleetSessionRegistry;

  constructor(private deps: ProjectOrchestratorDeps) {
    const query = this.deps.fleet?.query !== undefined ? this.deps.fleet.query : loadQuery();
    const workspaceRoot = this.deps.fleet?.workspaceRoot ?? process.env.FLEET_WORKSPACE_ROOT ?? "runtime/projects";
    this.sessionRegistry = this.deps.fleet?.registry ?? new FleetSessionRegistry();
    this.claudeFleet = new ClaudeFleet({ query, workspaceRoot, registry: this.sessionRegistry });
  }

  /* ----- state accessors (the HTTP layer reads these) ----- */

  listMessages(projectId: string): ProjectMessage[] {
    return this.ensure(projectId).messages.slice();
  }

  listAssets(projectId: string): ProjectAsset[] {
    return this.ensure(projectId).assets.slice();
  }

  getBrain(projectId: string): BrainSnapshot {
    const s = this.ensure(projectId);
    return {
      memory: s.memory,
      messageCount: s.messages.length,
      assetCount: s.assets.length,
      lastChangeAt: s.messages.at(-1)?.createdAt ?? s.assets.at(-1)?.createdAt,
    };
  }

  /** Seed the initial user prompt + agent intro so the project workspace
   *  has something to render the moment the user lands on it. Called by
   *  the deploy planner endpoint right before the redirect. */
  seedFromDeploy(input: {
    projectId: string;
    prompt: string;
    plan: DeployPlan;
  }): void {
    const s = this.ensure(input.projectId);
    s.messages.push(this.makeMessage({
      projectId: input.projectId,
      role: "user",
      kind: "message",
      content: input.prompt,
    }));
    s.messages.push(this.makeMessage({
      projectId: input.projectId,
      role: "agent",
      agent: "orchestrator",
      kind: "message",
      content: `${input.plan.summary} Stack: ${input.plan.stack}.`,
    }));
    s.memory = {
      ...s.memory,
      summary: this.composeSummary(s.memory.summary, input.prompt, input.plan),
      tokenCount: estimateTokens(input.plan.summary + " " + input.prompt),
      updatedAt: nowIso(),
    };
  }

  /** Run the multi-round build for a freshly-created project. Streams
   *  every step to the handler so the project workspace's chat UI can
   *  render op cards as they happen. Delegates to the ClaudeFleet engine. */
  async runBuild(input: {
    projectId: string;
    plan: DeployPlan;
    onEvent: OrchestratorEventHandler;
  }): Promise<void> {
    await this.claudeFleet.build({ projectId: input.projectId, plan: input.plan, onEvent: (e) => this.persistAndForward(input.projectId, e, input.onEvent) });
  }

  /** Continue the conversation on an existing project. Persists the user
   *  message then delegates to the ClaudeFleet engine for a live response. */
  async runChat(input: {
    projectId: string;
    message: string;
    onEvent: OrchestratorEventHandler;
  }): Promise<void> {
    this.appendMessage(input.projectId, { role: "user", kind: "message", content: input.message }, input.onEvent);
    await this.claudeFleet.chat({ projectId: input.projectId, message: input.message, onEvent: (e) => this.persistAndForward(input.projectId, e, input.onEvent) });
  }

  /* ----- internals ----- */

  /** Mirror streamed fleet events into the existing in-memory state, then forward. */
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

  private appendMessage(
    projectId: string,
    partial: Omit<ProjectMessage, "id" | "projectId" | "createdAt">,
    onEvent: OrchestratorEventHandler,
  ): ProjectMessage {
    const msg = this.makeMessage({ projectId, ...partial });
    this.ensure(projectId).messages.push(msg);
    onEvent({ kind: "message_persisted", message: msg });
    return msg;
  }

  private makeMessage(partial: Omit<ProjectMessage, "id" | "createdAt"> & { createdAt?: string }): ProjectMessage {
    return {
      id: `pmsg_${randomBytes(8).toString("hex")}`,
      createdAt: partial.createdAt ?? nowIso(),
      ...partial,
    };
  }

  private ensure(projectId: string): ProjectState {
    let s = this.state.get(projectId);
    if (!s) {
      s = {
        messages: [],
        assets: [],
        memory: {
          projectId,
          summary: "",
          tokenCount: 0,
          updatedAt: nowIso(),
        },
      };
      this.state.set(projectId, s);
    }
    return s;
  }

  private composeSummary(prev: string, prompt: string, plan: DeployPlan): string {
    const intro = `Project "${plan.name}" (${plan.kind}, ${plan.stack}). Built from prompt: "${prompt.slice(0, 240)}".`;
    if (!prev) return intro;
    return prev + "\n" + intro;
  }
}

/* ---------- helpers ---------- */

function nowIso(): string {
  return new Date().toISOString();
}

function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}
