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
import { DeployBridge } from "../fleet/deploy-bridge";
import { getSandboxRunner, type SandboxRunner } from "../fleet/sandbox";
import { fleetConfig } from "../fleet/config";
import { workspaceDir } from "../fleet/workspace";
import { ownerAccountId } from "../lib/owner-account";

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
  /** Optional deploy bridge override — injected by tests, defaults to real DeployBridge. */
  deployBridge?: { publish(input: { projectId: string; workspaceDir: string; onEvent: OrchestratorEventHandler }): Promise<{ deployed: boolean; detail: string; liveUrl?: string }> };
  /** Optional sandbox runner override — injected by tests, defaults to getSandboxRunner(). */
  sandbox?: SandboxRunner;
}

interface ProjectState {
  messages: ProjectMessage[];
  assets: ProjectAsset[];
  memory: ProjectMemorySnapshot;
}

export class ProjectOrchestrator {
  private state: Map<string, ProjectState> = new Map();
  private claudeFleet: ClaudeFleet;
  private deployBridge: { publish(input: { projectId: string; workspaceDir: string; onEvent: OrchestratorEventHandler }): Promise<{ deployed: boolean; detail: string; liveUrl?: string }> };
  private sandbox: SandboxRunner;
  readonly sessionRegistry: FleetSessionRegistry;

  constructor(private deps: ProjectOrchestratorDeps) {
    const query = this.deps.fleet?.query !== undefined ? this.deps.fleet.query : loadQuery();
    const workspaceRoot = this.deps.fleet?.workspaceRoot ?? process.env.FLEET_WORKSPACE_ROOT ?? "runtime/projects";
    this.sessionRegistry = this.deps.fleet?.registry ?? new FleetSessionRegistry();
    this.claudeFleet = new ClaudeFleet({ query, workspaceRoot, registry: this.sessionRegistry });
    this.deployBridge = this.deps.deployBridge ?? new DeployBridge({
      cp: {
        ensureProjectRepo: (id: string) => this.deps.cp.ensureProjectRepo(id),
        getAccount: (id: string) => this.deps.cp.getAccount(id),
        deploy: (id: string, opts: any) => this.deps.cp.deploy(id, opts),
      },
    });
    this.sandbox = this.deps.sandbox ?? getSandboxRunner();
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
    /** Conversation (thread) the seeded rows attach to. Omitted →
     *  the project's default "Main" conversation (conversations design
     *  2026-05-30). */
    conversationId?: string;
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
    // Mirror the seed into the durable, conversation-scoped store so the
    // thread auto-titles + floats to the top of the conversation list.
    // Fire-and-forget — the in-memory state above is what the live stream
    // renders from; this is the persistence layer behind it.
    void this.persistToConversation(input.projectId, input.conversationId, {
      role: "user",
      kind: "message",
      content: input.prompt,
    });
    void this.persistToConversation(input.projectId, input.conversationId, {
      role: "agent",
      agent: "orchestrator",
      kind: "message",
      content: `${input.plan.summary} Stack: ${input.plan.stack}.`,
    });
    s.memory = {
      ...s.memory,
      summary: this.composeSummary(s.memory.summary, input.prompt, input.plan),
      tokenCount: estimateTokens(input.plan.summary + " " + input.prompt),
      updatedAt: nowIso(),
    };
  }

  /** Run the multi-round build for a freshly-created project. Streams
   *  every step to the handler so the project workspace's chat UI can
   *  render op cards as they happen. Delegates to the ClaudeFleet engine.
   *  When FLEET_AUTODEPLOY=on and the build succeeds, auto-deploys via
   *  DeployBridge (owner-account projects only in v1). */
  async runBuild(input: {
    projectId: string;
    plan: DeployPlan;
    onEvent: OrchestratorEventHandler;
    /** Conversation the build's streamed rows attach to (default "Main"). */
    conversationId?: string;
    /** Account that owns this project — used to resolve a per-tenant
     *  claude.ai subscription token for the fleet run. When set and the
     *  account has a token stored, that token is used instead of the
     *  platform-level credentials (§BYO-subscription). */
    accountId?: string;
  }): Promise<void> {
    const { projectId, plan, onEvent, conversationId, accountId } = input;
    const tenantToken = accountId
      ? await this.resolveTenantToken(accountId)
      : undefined;
    const res = await this.claudeFleet.build({ projectId, plan, tenantToken, onEvent: (e) => this.persistAndForward(projectId, e, onEvent, conversationId) });
    if (!res?.buildOk || !fleetConfig().autodeploy) return;
    const project = await this.deps.cp.getProject(projectId);
    if (!project || project.accountId !== ownerAccountId()) return; // owner-account only in v1
    const root = this.deps.fleet?.workspaceRoot ?? process.env.FLEET_WORKSPACE_ROOT ?? "runtime/projects";
    const ws = workspaceDir(root, projectId);

    // Independent pre-deploy smoke test: boot the built product in a sandbox and
    // gate publish on sandbox.passed. Noop by default (FLEET_SANDBOX=noop).
    const sbKey = `sandbox:${projectId}`;
    const sb = await this.sandbox.run({ workspaceDir: ws, stack: plan.stack, projectId, timeoutMs: fleetConfig().sandboxTimeoutMs });
    this.persistAndForward(projectId, { kind: "op_finished", opKey: sbKey, agent: "sandbox", title: sb.passed ? `sandbox: ${sb.detail}` : `sandbox failed: ${sb.detail}`, status: sb.passed ? "ok" : "failed" }, onEvent, conversationId);
    if (!sb.passed) return;

    await this.deployBridge.publish({ projectId, workspaceDir: ws, onEvent: (e) => this.persistAndForward(projectId, e, onEvent, conversationId) });
  }

  /** Continue the conversation on an existing project. Persists the user
   *  message then delegates to the ClaudeFleet engine for a live response.
   *  `conversationId` scopes the persisted rows to a thread (default
   *  "Main"). */
  async runChat(input: {
    projectId: string;
    message: string;
    onEvent: OrchestratorEventHandler;
    conversationId?: string;
    /** Account that owns this project — resolves per-tenant subscription
     *  token for the fleet run (§BYO-subscription). */
    accountId?: string;
  }): Promise<void> {
    const tenantToken = input.accountId
      ? await this.resolveTenantToken(input.accountId)
      : undefined;
    this.appendMessage(input.projectId, { role: "user", kind: "message", content: input.message }, input.onEvent, input.conversationId);
    await this.claudeFleet.chat({ projectId: input.projectId, message: input.message, tenantToken, onEvent: (e) => this.persistAndForward(input.projectId, e, input.onEvent, input.conversationId) });
  }

  /* ----- internals ----- */

  /** Resolve the per-tenant claude.ai subscription token for a fleet run.
   *  Returns the plaintext token when the account has one stored, or
   *  undefined to fall back to platform-level credentials. */
  private async resolveTenantToken(accountId: string): Promise<string | undefined> {
    try {
      return await this.deps.cp.resolveFleetToken(accountId);
    } catch {
      return undefined;
    }
  }

  /** Mirror streamed fleet events into the existing in-memory state, then
   *  forward. Also persists each row into the conversation-scoped store so
   *  the thread's `updatedAt` floats and the history survives a restart. */
  private persistAndForward(projectId: string, e: OrchestratorEvent, onEvent: OrchestratorEventHandler, conversationId?: string): void {
    switch (e.kind) {
      case "agent_message":
        this.ensure(projectId).messages.push(this.makeMessage({ projectId, role: "agent", agent: e.agent, kind: "message", content: e.content }));
        void this.persistToConversation(projectId, conversationId, { role: "agent", agent: e.agent, kind: "message", content: e.content });
        break;
      case "op_started":
        this.ensure(projectId).messages.push(this.makeMessage({ projectId, role: "agent", agent: e.agent, kind: "op_card", content: e.title, metadata: { opKey: e.opKey, status: "running" } }));
        void this.persistToConversation(projectId, conversationId, { role: "agent", agent: e.agent, kind: "op_card", content: e.title, metadata: { opKey: e.opKey, status: "running" } });
        break;
      case "op_finished":
        this.ensure(projectId).messages.push(this.makeMessage({ projectId, role: "agent", agent: e.agent, kind: "op_card", content: e.title, metadata: { opKey: e.opKey, status: e.status === "ok" ? "done" : "failed", detail: e.detail } }));
        void this.persistToConversation(projectId, conversationId, { role: "agent", agent: e.agent, kind: "op_card", content: e.title, metadata: { opKey: e.opKey, status: e.status === "ok" ? "done" : "failed", detail: e.detail } });
        break;
      case "asset_created":
        this.ensure(projectId).assets.push(e.asset);
        break;
      case "result":
        this.ensure(projectId).messages.push(this.makeMessage({ projectId, role: "agent", agent: "orchestrator", kind: "result", content: `${e.name} is ready.`, metadata: { name: e.name, url: e.url, stack: e.stack } }));
        void this.persistToConversation(projectId, conversationId, { role: "agent", agent: "orchestrator", kind: "result", content: `${e.name} is ready.`, metadata: { name: e.name, url: e.url, stack: e.stack } });
        break;
      default:
        break;
    }
    onEvent(e);
  }

  /** Persist a single message into the conversation-scoped store via the
   *  control plane, which auto-titles untitled threads from the first user
   *  message and bumps `updatedAt`. Best-effort: a store failure must not
   *  break the live stream the user is watching. */
  private async persistToConversation(
    projectId: string,
    conversationId: string | undefined,
    partial: {
      role: ProjectMessageRole;
      kind: ProjectMessageKind;
      content: string;
      agent?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<void> {
    try {
      await this.deps.cp.appendChatMessage({ projectId, conversationId, ...partial });
    } catch {
      // swallow — durable persistence is best-effort behind the live stream
    }
  }

  private appendMessage(
    projectId: string,
    partial: Omit<ProjectMessage, "id" | "projectId" | "createdAt">,
    onEvent: OrchestratorEventHandler,
    conversationId?: string,
  ): ProjectMessage {
    const msg = this.makeMessage({ projectId, ...partial });
    this.ensure(projectId).messages.push(msg);
    void this.persistToConversation(projectId, conversationId, { role: partial.role, kind: partial.kind, content: partial.content, agent: partial.agent, metadata: partial.metadata });
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
