/* ============================================================
   DeployPlanner — turns a free-form chat prompt into a typed
   deployment plan that the chat-deploy UI can act on.

   Modelled after `ClaudeAiAnalyser`:
   - `Anthropic` SDK + Sonnet 4.6
   - `tool_choice: {type:"tool"}` so the structured output is the
     tool's JSON schema, parsed with `JSON.parse`
   - Stable system prompt marked `cache_control: ephemeral` so the
     prefix is reused across calls

   Fallback path: `RuleBasedDeployPlanner` mirrors the old regex
   `blueprint()` from the console's ChatDeploy. Used when no API
   key is configured or the LLM errors out — same posture as
   `RuleBasedAiAnalyser`.
   ============================================================ */

import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 1500;

export type DeployPlanKind =
  | "live_app"
  | "automation"
  | "worker"
  | "cron"
  | "ai_agent"
  | "static_site"
  | "api";

export type DeployPlanRuntime =
  | "static"
  | "node"
  | "python"
  | "php"
  | "go"
  | "ruby"
  | "docker";

export type DeployPlanAutomationKind = "n8n" | "openclaw";

export interface DeployPlanServices {
  needsDatabase: boolean;
  dbEngine?: "postgres" | "mysql" | "mongodb" | "redis";
  needsMail: boolean;
  needsSms: boolean;
}

export interface DeployPlanMedia {
  /** Things the build agent should generate as part of the project. */
  logo: boolean;
  hero: boolean;
  favicon: boolean;
  iconSet: boolean;
  heroAnimation: boolean;
  socialOgImage: boolean;
}

export interface DeployPlan {
  kind: DeployPlanKind;
  name: string;
  /** Short, friendly stack label ("Next.js · Tailwind", "n8n · Docker"). */
  stack: string;
  runtime: DeployPlanRuntime;
  region: "fsn1" | "hel1" | "ash";
  services: DeployPlanServices;
  automationKind?: DeployPlanAutomationKind;
  /** Template the scaffold step should pull in. */
  templateRef?: string;
  /** Human-readable build steps the chat shows as op cards. */
  buildPlan: string[];
  /** Media assets the build agent should generate. */
  media: DeployPlanMedia;
  /** One-line summary the chat replies with before kicking off the build. */
  summary: string;
}

export interface DeployPlannerInput {
  prompt: string;
  /** Names of attached files (their contents are processed elsewhere). */
  files?: string[];
}

export interface DeployPlanner {
  plan(input: DeployPlannerInput): Promise<DeployPlan>;
}

/* ---------- rule-based fallback ---------- */

export class RuleBasedDeployPlanner implements DeployPlanner {
  async plan(input: DeployPlannerInput): Promise<DeployPlan> {
    const p = input.prompt.toLowerCase();
    const wantsDb = /postgres|database|\bdb\b|sql|mongo|redis/.test(p);
    const wantsLanding = /landing|saas|marketing|site|website|storefront|shop|store/.test(p);
    const wantsAnimation = /animation|animated|motion|hero anim|lottie/.test(p);

    if (/n8n|workflow|zapier|automation/.test(p)) {
      return {
        kind: "automation",
        name: deriveName(input.prompt, "n8n-flow"),
        stack: "n8n · Docker template",
        runtime: "docker",
        region: "fsn1",
        services: { needsDatabase: true, dbEngine: "postgres", needsMail: false, needsSms: false },
        automationKind: "n8n",
        templateRef: "automation/n8n-base",
        buildPlan: ["resolve template", "pull image", "wire postgres", "schedule container", "verify"],
        media: { logo: false, hero: false, favicon: false, iconSet: false, heroAnimation: false, socialOgImage: false },
        summary: "n8n automation with Postgres, wired and live.",
      };
    }
    if (/librechat|chat ui|chatbot|ai agent/.test(p)) {
      return {
        kind: "ai_agent",
        name: deriveName(input.prompt, "ai-agent"),
        stack: "LibreChat · Docker template",
        runtime: "docker",
        region: "fsn1",
        services: { needsDatabase: true, dbEngine: "mongodb", needsMail: false, needsSms: false },
        templateRef: "ai-agent/librechat",
        buildPlan: ["resolve template", "pull image", "wire mongodb", "schedule container", "verify"],
        media: { logo: true, hero: false, favicon: true, iconSet: false, heroAnimation: false, socialOgImage: false },
        summary: "LibreChat agent with MongoDB, ready to chat.",
      };
    }
    if (/python|fastapi|flask|django/.test(p)) {
      return {
        kind: /api\b/.test(p) ? "api" : "live_app",
        name: deriveName(input.prompt, "api-service"),
        stack: "Python 3.12 · FastAPI · Nixpacks",
        runtime: "python",
        region: "fsn1",
        services: { needsDatabase: wantsDb, dbEngine: wantsDb ? "postgres" : undefined, needsMail: false, needsSms: false },
        templateRef: "api/fastapi-postgres",
        buildPlan: ["nixpacks detect python", "pip install", "discover uvicorn entrypoint", "push image"],
        media: { logo: false, hero: false, favicon: true, iconSet: false, heroAnimation: false, socialOgImage: false },
        summary: "FastAPI service ready to serve.",
      };
    }
    if (/next|react|storefront|store|shop|landing|website|site|saas/.test(p)) {
      return {
        kind: "live_app",
        name: deriveName(input.prompt, "web-app"),
        stack: "Next.js 14 · Tailwind · Nixpacks",
        runtime: "node",
        region: "fsn1",
        services: { needsDatabase: wantsDb, dbEngine: wantsDb ? "postgres" : undefined, needsMail: false, needsSms: false },
        templateRef: "web/next-saas",
        buildPlan: ["nixpacks detect next.js", "npm ci", "next build", "push image"],
        media: { logo: true, hero: wantsLanding, favicon: true, iconSet: true, heroAnimation: wantsAnimation, socialOgImage: wantsLanding },
        summary: "Next.js site with a generated logo and hero.",
      };
    }
    return {
      kind: "live_app",
      name: deriveName(input.prompt, "new-app"),
      stack: "Node.js 20 · Nixpacks",
      runtime: "node",
      region: "fsn1",
      services: { needsDatabase: wantsDb, dbEngine: wantsDb ? "postgres" : undefined, needsMail: false, needsSms: false },
      templateRef: "web/node-blank",
      buildPlan: ["nixpacks detect node", "npm ci", "build", "push image"],
      media: { logo: true, hero: false, favicon: true, iconSet: false, heroAnimation: false, socialOgImage: false },
      summary: "Node.js app scaffolded and live.",
    };
  }
}

/* ---------- Claude-backed planner ---------- */

const SYSTEM_PROMPT = `You are Cantila's deploy planner. Cantila is a managed hosting + automation cloud — every project gets an auto-wired managed Postgres (when needed), a sending mailbox, and an SMS number. Projects fall into a fixed set of kinds: live_app, static_site, api, automation, worker, cron, ai_agent.

Read a user's free-form chat prompt (sometimes with file attachments) and emit a single typed plan through the provided tool. Pick the kind, runtime, region, a friendly name, a one-line stack label, the auto-wired services it needs, an optional template reference, an ordered list of human-readable build steps, and the media assets the build agent should generate (logo, hero, favicon, icon set, hero animation, social OG image).

Names: kebab-case, ≤ 32 chars, no leading dash. Build plan: 3–6 short imperative steps. Always emit a media object — set every field to false explicitly when none are needed. Never invent runtimes — pick from: static, node, python, php, go, ruby, docker.`;

const PLAN_TOOL: Anthropic.Tool = {
  name: "emit_deploy_plan",
  description: "Emit a single typed deploy plan for the prompt.",
  input_schema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["live_app", "static_site", "api", "automation", "worker", "cron", "ai_agent"] },
      name: { type: "string" },
      stack: { type: "string" },
      runtime: { type: "string", enum: ["static", "node", "python", "php", "go", "ruby", "docker"] },
      region: { type: "string", enum: ["fsn1", "hel1", "ash"] },
      services: {
        type: "object",
        properties: {
          needsDatabase: { type: "boolean" },
          dbEngine: { type: "string", enum: ["postgres", "mysql", "mongodb", "redis"] },
          needsMail: { type: "boolean" },
          needsSms: { type: "boolean" },
        },
        required: ["needsDatabase", "needsMail", "needsSms"],
      },
      automationKind: { type: "string", enum: ["n8n", "openclaw"] },
      templateRef: { type: "string" },
      buildPlan: { type: "array", items: { type: "string" } },
      media: {
        type: "object",
        properties: {
          logo: { type: "boolean" },
          hero: { type: "boolean" },
          favicon: { type: "boolean" },
          iconSet: { type: "boolean" },
          heroAnimation: { type: "boolean" },
          socialOgImage: { type: "boolean" },
        },
        required: ["logo", "hero", "favicon", "iconSet", "heroAnimation", "socialOgImage"],
      },
      summary: { type: "string" },
    },
    required: ["kind", "name", "stack", "runtime", "region", "services", "buildPlan", "media", "summary"],
  },
};

export interface ClaudeDeployPlannerOptions {
  apiKey?: string;
  fallback: DeployPlanner;
}

export class ClaudeDeployPlanner implements DeployPlanner {
  private client: Anthropic | null;
  private fallback: DeployPlanner;

  constructor(opts: ClaudeDeployPlannerOptions) {
    const key = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
    this.client = key ? new Anthropic({ apiKey: key }) : null;
    this.fallback = opts.fallback;
  }

  async plan(input: DeployPlannerInput): Promise<DeployPlan> {
    if (!this.client) return this.fallback.plan(input);
    try {
      const userTurn =
        `Prompt: ${input.prompt}\n` +
        (input.files && input.files.length > 0
          ? `Attached files: ${input.files.join(", ")}\n`
          : "");

      const resp = await this.client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        tools: [PLAN_TOOL],
        tool_choice: { type: "tool", name: PLAN_TOOL.name },
        system: [
          {
            type: "text",
            text: SYSTEM_PROMPT,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [{ role: "user", content: userTurn }],
      });

      for (const block of resp.content) {
        if (block.type === "tool_use" && block.name === PLAN_TOOL.name) {
          const parsed = block.input as DeployPlan;
          return normalisePlan(parsed);
        }
      }
      return this.fallback.plan(input);
    } catch {
      return this.fallback.plan(input);
    }
  }
}

/* ---------- helpers ---------- */

function deriveName(prompt: string, fallback: string): string {
  // pick the first 3 alpha words from the prompt as a kebab name
  const words = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w))
    .slice(0, 3);
  const candidate = words.join("-");
  return (candidate.length >= 3 ? candidate : fallback).slice(0, 32);
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "into", "that", "this", "have",
  "but", "not", "what", "all", "can", "her", "his", "their", "your",
  "you", "use", "any", "deploy", "build", "make", "create", "new",
  "app", "project", "site",
]);

function normalisePlan(plan: DeployPlan): DeployPlan {
  // Guard against missing nested fields when the LLM forgets a required
  // sub-property — defensive only, the tool schema makes them required.
  return {
    ...plan,
    name: (plan.name ?? "new-app").replace(/[^a-z0-9-]/gi, "-").toLowerCase().slice(0, 32),
    services: {
      needsDatabase: !!plan.services?.needsDatabase,
      dbEngine: plan.services?.dbEngine,
      needsMail: !!plan.services?.needsMail,
      needsSms: !!plan.services?.needsSms,
    },
    media: {
      logo: !!plan.media?.logo,
      hero: !!plan.media?.hero,
      favicon: !!plan.media?.favicon,
      iconSet: !!plan.media?.iconSet,
      heroAnimation: !!plan.media?.heroAnimation,
      socialOgImage: !!plan.media?.socialOgImage,
    },
  };
}

/** Convenience factory — uses Claude when ANTHROPIC_API_KEY is set,
 *  rule-based otherwise. */
export function buildDeployPlanner(): DeployPlanner {
  const ruleBased = new RuleBasedDeployPlanner();
  if (process.env.ANTHROPIC_API_KEY) {
    return new ClaudeDeployPlanner({ fallback: ruleBased });
  }
  return ruleBased;
}
