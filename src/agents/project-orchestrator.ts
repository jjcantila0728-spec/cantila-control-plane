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
import type {
  ImageProvider,
  GenerateImageInput,
  GenerateAnimationInput,
} from "../skills/image-provider";

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
}

interface ProjectState {
  messages: ProjectMessage[];
  assets: ProjectAsset[];
  memory: ProjectMemorySnapshot;
}

export class ProjectOrchestrator {
  private state: Map<string, ProjectState> = new Map();

  constructor(private deps: ProjectOrchestratorDeps) {}

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
   *  render op cards as they happen. */
  async runBuild(input: {
    projectId: string;
    plan: DeployPlan;
    onEvent: OrchestratorEventHandler;
  }): Promise<void> {
    const { projectId, plan, onEvent } = input;

    try {
      // Round 1 — scaffold
      await this.runOp(projectId, "scaffold", "scaffold", `Scaffolding ${plan.templateRef ?? plan.stack}`, async () => {
        // Pretend to lay down the template tree. In production this calls
        // the data-plane's filesystem skill against runtime/projects/<id>/workspace.
        await sleep(450);
        return `template ${plan.templateRef ?? "blank"} laid down`;
      }, onEvent);

      // Round 2 — media (images + animations)
      if (plan.media.logo) {
        await this.generateAndPersistImage(projectId, {
          prompt: `Logo for ${plan.name}. ${plan.summary}`,
          preset: "logo",
        }, "public/logo.svg", "image", onEvent);
      }
      if (plan.media.favicon) {
        await this.generateAndPersistImage(projectId, {
          prompt: `Favicon for ${plan.name}, monochrome, simple mark.`,
          preset: "icon",
        }, "public/favicon.svg", "icon", onEvent);
      }
      if (plan.media.hero) {
        await this.generateAndPersistImage(projectId, {
          prompt: `Hero illustration for ${plan.name}. ${plan.summary}`,
          preset: "hero",
          aspect: "16:9",
        }, "public/hero.svg", "image", onEvent);
      }
      if (plan.media.iconSet) {
        for (const slug of ["feature-fast", "feature-secure", "feature-scale"]) {
          await this.generateAndPersistImage(projectId, {
            prompt: `Outline icon: ${slug.replace("feature-", "")} for ${plan.name}.`,
            preset: "icon",
          }, `public/icons/${slug}.svg`, "icon", onEvent);
        }
      }
      if (plan.media.heroAnimation) {
        await this.generateAndPersistAnimation(projectId, {
          prompt: `Hero animation for ${plan.name}, looped, calm.`,
          mode: "lottie",
        }, "public/hero.lottie.json", "lottie", onEvent);
      }
      if (plan.media.socialOgImage) {
        await this.generateAndPersistImage(projectId, {
          prompt: `Open Graph social card for ${plan.name}. ${plan.summary}`,
          preset: "og",
        }, "public/og.svg", "image", onEvent);
      }

      // Round 3 — deploy
      await this.runOp(projectId, "deploy", "deploy", "Running deploy pipeline", async () => {
        // The actual deploy is driven through the existing ControlPlane API
        // by the chat-deploy frontend. The orchestrator records the op card
        // here so the project chat history reflects what happened.
        return "queued · streaming via /deploy";
      }, onEvent);

      this.appendMessage(projectId, {
        role: "agent",
        agent: "orchestrator",
        kind: "result",
        content: `${plan.name} is shipping. Open the deployment tab to watch the build.`,
        metadata: { name: plan.name, url: `${plan.name}.cantila.app`, stack: plan.stack },
      }, onEvent);
      onEvent({ kind: "result", name: plan.name, url: `${plan.name}.cantila.app`, stack: plan.stack });
      onEvent({ kind: "done" });
    } catch (err) {
      onEvent({ kind: "error", error: err instanceof Error ? err.message : "build failed" });
    }
  }

  /** Continue the conversation on an existing project. The chat-driven
   *  follow-up flow: classify the intent, dispatch to a skill, stream
   *  the op card, persist the messages. */
  async runChat(input: {
    projectId: string;
    message: string;
    onEvent: OrchestratorEventHandler;
  }): Promise<void> {
    const { projectId, message, onEvent } = input;
    this.appendMessage(projectId, { role: "user", kind: "message", content: message }, onEvent);

    const intent = classifyIntent(message);

    if (intent.kind === "generate_image") {
      await this.generateAndPersistImage(projectId, {
        prompt: intent.prompt,
        preset: intent.preset,
      }, `public/${slugify(intent.prompt)}.svg`, "image", onEvent);
      this.appendMessage(projectId, {
        role: "agent",
        agent: "media",
        kind: "message",
        content: `Generated. Added to the project's public/ folder.`,
      }, onEvent);
      onEvent({ kind: "done" });
      return;
    }

    if (intent.kind === "generate_animation") {
      await this.generateAndPersistAnimation(projectId, {
        prompt: intent.prompt,
        mode: intent.mode,
      }, `public/${slugify(intent.prompt)}.${intent.mode === "lottie" ? "lottie.json" : intent.mode === "css" ? "css" : "mp4"}`,
        intent.mode === "lottie" ? "lottie" : intent.mode === "css" ? "css_anim" : "video",
        onEvent);
      this.appendMessage(projectId, {
        role: "agent",
        agent: "media",
        kind: "message",
        content: `${intent.mode} animation ready.`,
      }, onEvent);
      onEvent({ kind: "done" });
      return;
    }

    if (intent.kind === "scale") {
      await this.runOp(projectId, "scale", "scale", `Scaling to ${intent.memoryMb} MB RAM`, async () => {
        return `${intent.memoryMb} MB RAM · pending operator approval`;
      }, onEvent);
      this.appendMessage(projectId, {
        role: "agent",
        agent: "scale",
        kind: "message",
        content: `Scale proposal recorded. The ScaleAgent will pick it up on the next brain tick.`,
      }, onEvent);
      onEvent({ kind: "done" });
      return;
    }

    if (intent.kind === "deploy") {
      await this.runOp(projectId, "deploy", "deploy", "Triggering deploy", async () => "queued", onEvent);
      onEvent({ kind: "done" });
      return;
    }

    // Default: a one-line response. In production this becomes a Sonnet
    // tool-use call with the full skill registry as tools.
    this.appendMessage(projectId, {
      role: "agent",
      agent: "orchestrator",
      kind: "message",
      content: defaultReply(message),
    }, onEvent);
    onEvent({ kind: "done" });
  }

  /* ----- internals ----- */

  private async runOp(
    projectId: string,
    opKey: string,
    agent: string,
    title: string,
    work: () => Promise<string>,
    onEvent: OrchestratorEventHandler,
  ): Promise<void> {
    onEvent({ kind: "op_started", opKey, agent, title });
    this.appendMessage(projectId, {
      role: "agent",
      agent,
      kind: "op_card",
      content: title,
      metadata: { opKey, status: "running" },
    }, onEvent);
    try {
      const detail = await work();
      onEvent({ kind: "op_finished", opKey, agent, title, detail, status: "ok" });
      this.appendMessage(projectId, {
        role: "agent",
        agent,
        kind: "op_card",
        content: title,
        metadata: { opKey, status: "done", detail },
      }, onEvent);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "op failed";
      onEvent({ kind: "op_finished", opKey, agent, title, detail: msg, status: "failed" });
      this.appendMessage(projectId, {
        role: "agent",
        agent,
        kind: "op_card",
        content: title,
        metadata: { opKey, status: "failed", detail: msg },
      }, onEvent);
    }
  }

  private async generateAndPersistImage(
    projectId: string,
    input: GenerateImageInput,
    path: string,
    kind: ProjectAssetKind,
    onEvent: OrchestratorEventHandler,
  ): Promise<void> {
    const opKey = `image:${path}`;
    const title = `Generating ${kind} → ${path}`;
    onEvent({ kind: "op_started", opKey, agent: "media", title });
    this.appendMessage(projectId, {
      role: "agent",
      agent: "media",
      kind: "op_card",
      content: title,
      metadata: { opKey, status: "running", path, prompt: input.prompt },
    }, onEvent);

    const result = await this.deps.images.generateImage(input);
    const asset: ProjectAsset = {
      id: `ast_${randomBytes(8).toString("hex")}`,
      projectId,
      kind,
      path,
      mimeType: result.mimeType,
      width: result.width,
      height: result.height,
      prompt: input.prompt,
      provider: result.provider,
      sizeBytes: estimateBytes(result.dataUrl),
      createdAt: nowIso(),
      dataUrl: result.dataUrl,
    };
    this.ensure(projectId).assets.push(asset);

    onEvent({ kind: "asset_created", asset });
    onEvent({ kind: "op_finished", opKey, agent: "media", title, detail: `${result.width}×${result.height} · ${result.provider}`, status: "ok" });
    this.appendMessage(projectId, {
      role: "agent",
      agent: "media",
      kind: "asset",
      content: title,
      metadata: { opKey, status: "done", path, assetId: asset.id, provider: result.provider, dataUrl: result.dataUrl },
    }, onEvent);
  }

  private async generateAndPersistAnimation(
    projectId: string,
    input: GenerateAnimationInput,
    path: string,
    kind: ProjectAssetKind,
    onEvent: OrchestratorEventHandler,
  ): Promise<void> {
    const opKey = `anim:${path}`;
    const title = `Generating ${input.mode} animation → ${path}`;
    onEvent({ kind: "op_started", opKey, agent: "media", title });
    this.appendMessage(projectId, {
      role: "agent",
      agent: "media",
      kind: "op_card",
      content: title,
      metadata: { opKey, status: "running", path, prompt: input.prompt },
    }, onEvent);

    const result = await this.deps.images.generateAnimation(input);
    const dataUrl =
      result.mimeType === "application/json"
        ? "data:application/json;utf8," + encodeURIComponent(result.content)
        : result.mimeType === "text/css"
        ? "data:text/css;utf8," + encodeURIComponent(result.content)
        : result.content;

    const asset: ProjectAsset = {
      id: `ast_${randomBytes(8).toString("hex")}`,
      projectId,
      kind,
      path,
      mimeType: result.mimeType,
      prompt: input.prompt,
      provider: result.provider,
      sizeBytes: estimateBytes(result.content),
      createdAt: nowIso(),
      dataUrl,
    };
    this.ensure(projectId).assets.push(asset);

    onEvent({ kind: "asset_created", asset });
    onEvent({ kind: "op_finished", opKey, agent: "media", title, detail: `${input.mode} · ${result.provider}`, status: "ok" });
    this.appendMessage(projectId, {
      role: "agent",
      agent: "media",
      kind: "asset",
      content: title,
      metadata: { opKey, status: "done", path, assetId: asset.id, provider: result.provider, dataUrl },
    }, onEvent);
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

/* ---------- intent classifier (deterministic v0) ---------- */

type Intent =
  | { kind: "generate_image"; prompt: string; preset: GenerateImageInput["preset"] }
  | { kind: "generate_animation"; prompt: string; mode: "lottie" | "css" | "video" }
  | { kind: "scale"; memoryMb: number }
  | { kind: "deploy" }
  | { kind: "chat" };

function classifyIntent(message: string): Intent {
  const m = message.toLowerCase();
  if (/animat|motion|lottie|keyframes/.test(m)) {
    const mode: "lottie" | "css" | "video" =
      /video|mp4|clip/.test(m) ? "video" :
      /css|keyframes/.test(m) ? "css" : "lottie";
    return { kind: "generate_animation", prompt: message, mode };
  }
  if (/image|logo|hero|banner|icon|illustration|picture|favicon|og image/.test(m)) {
    const preset: GenerateImageInput["preset"] =
      /logo/.test(m) ? "logo" :
      /icon|favicon/.test(m) ? "icon" :
      /og|social/.test(m) ? "og" :
      /hero|banner/.test(m) ? "hero" : "illustration";
    return { kind: "generate_image", prompt: message, preset };
  }
  const scaleMatch = m.match(/scale.*?(\d+)\s*(gb|mb)\b/);
  if (scaleMatch) {
    const n = Number(scaleMatch[1]);
    const memoryMb = scaleMatch[2] === "gb" ? n * 1024 : n;
    return { kind: "scale", memoryMb };
  }
  if (/redeploy|push|ship|deploy/.test(m)) {
    return { kind: "deploy" };
  }
  return { kind: "chat" };
}

function defaultReply(_message: string): string {
  return "Got it — I'll dispatch this to the right agent in the next round. Try asking for a logo, a hero animation, or 'scale to 2 GB RAM'.";
}

/* ---------- helpers ---------- */

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "asset";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function nowIso(): string {
  return new Date().toISOString();
}

function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

function estimateBytes(s: string): number {
  return Buffer.byteLength(s, "utf8");
}
