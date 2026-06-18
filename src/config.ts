/* Cantila control plane — environment configuration. */

/** Persistence backend. "memory" needs no infrastructure; "prisma" uses Postgres. */
export type StoreKind = "memory" | "prisma";

function storeKind(): StoreKind {
  return process.env.STORE === "prisma" ? "prisma" : "memory";
}

function flag(env: string | undefined): boolean {
  if (!env) return false;
  const v = env.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export const config = {
  port: Number(process.env.PORT ?? 8080),
  nodeEnv: process.env.NODE_ENV ?? "development",
  /** Persistence backend — see StoreKind. Defaults to the in-memory store. */
  store: storeKind(),
  /** Platform database URL — required when store is "prisma". */
  databaseUrl: process.env.DATABASE_URL ?? "",
  /** Escape hatch for the production safety guard in `createStore` —
   *  when true, an ephemeral `STORE=memory` is allowed in prod (used
   *  by short-lived diagnostic / smoke containers). Default is to
   *  refuse so the durable backend can't be forgotten by accident. */
  allowMemoryInProd: flag(process.env.CANTILA_ALLOW_MEMORY_IN_PROD),
  /** When true, write routes (POST/PUT/PATCH/DELETE) require a valid bearer
   *  token with sufficient scope (plan §5.4). Defaults to false so the
   *  in-process demo flow needs no setup. Recommended for any deployment
   *  that is reachable from the public internet. */
  requireAuth: flag(process.env.CANTILA_REQUIRE_AUTH),
  /** Shared secret the Mailcow→CP inbound-mail bridge presents in the
   *  `x-cantila-mail-secret` header on `POST /v1/projects/:id/mail/inbound`.
   *  That route is exempt from API-key auth (a mail bridge can't hold a
   *  Cantila admin key), so this secret is its credential. When unset the
   *  route stays open (dev/test); set it on any internet-reachable
   *  deployment so forged inbound mail can't be injected. */
  mailInboundWebhookSecret: process.env.MAIL_INBOUND_WEBHOOK_SECRET ?? "",
  /** Public-face origin the SeoAgent crawls and emits canonical URLs for.
   *  Defaults to https://cantila.app; override in dev/staging. */
  seoOrigin:
    process.env.SEO_PUBLIC_ORIGIN ??
    `https://${process.env.CANTILA_PUBLIC_HOST ?? "cantila.app"}`,
  /** Tick interval for the SeoAgent. SEO doesn't need fast cadence and
   *  crawling is expensive, so it ticks slowly — every 6h by default. */
  seoTickMs: Number(process.env.SEO_AGENT_TICK_MS ?? 6 * 60 * 60 * 1000),
  /** When true AND a GitHub PAT is configured, the SeoAgent commits its
   *  mechanical fixes (sitemap regen, missing canonical, missing alt) to
   *  the cantila-console repo automatically. When false (the default),
   *  the agent only queues proposals for human review. */
  seoAgentAutoApply: flag(process.env.SEO_AGENT_AUTO_APPLY),
  /** GitHub PAT used by the live SeoFixer adapter. When absent, the stub
   *  fixer is used — auto-apply degrades to a no-op that logs intent. */
  githubToken: process.env.GITHUB_TOKEN ?? "",
  /** owner/repo of the cantila-console repo the SeoAgent commits into. */
  githubRepo: process.env.GITHUB_REPO ?? "",
  /** Cantila-hosted Gitea base URL (e.g. https://git.cantila.app). Empty →
   *  the StubGitProvider is used for repoHost="cantila" projects. */
  giteaUrl: process.env.GITEA_URL ?? "",
  /** Gitea admin API token used to create orgs/repos and read/write files. */
  giteaToken: process.env.GITEA_TOKEN ?? "",
  /** Cantila-native git backend (plan §22 — drop the Gitea bundle). When
   *  `CANTILA_GIT=native`, repoHost="cantila" projects resolve to the
   *  NativeGitProvider (bare repo per project on box 1) instead of Gitea.
   *  Unset → Gitea (back-compat). Reversible env flip. */
  nativeGit: (process.env.CANTILA_GIT ?? "") === "native",
  /** Filesystem root for per-project bare repos. */
  nativeGitRoot: process.env.CANTILA_GIT_ROOT ?? "/srv/cantila-git",
  /** Public base for clone URLs the native backend hands back (served by
   *  git http-backend behind Traefik at the same git.cantila.app shape). */
  nativeGitPublicBase: (
    process.env.CANTILA_GIT_PUBLIC_BASE ?? "https://git.cantila.app"
  ).replace(/\/+$/, ""),
  /** Product-layer LLM provider (plan §5.6). Defaults reproduce the
   *  original Anthropic/Claude behaviour exactly, so leaving these unset
   *  changes nothing. Set LLM_PROVIDER=openai (with OPENAI_API_KEY) to
   *  route the product analyser + deploy-planner to OpenAI — far cheaper
   *  than Claude for these structured tool-calling tasks (default model
   *  gpt-5.4-mini). Per-provider key/model resolution lives in ai/llm.ts.
   *  NOTE 1: this governs the platform-default product LLM only — the
   *  Fleet code-builder stays on the Claude Agent SDK.
   *  NOTE 2: a tenant's bring-your-own Anthropic key (plan §4.3.1) always
   *  targets real Anthropic regardless of these vars. */
  llm: {
    /** Active product provider: "anthropic" (default) or "openai". */
    provider: (process.env.LLM_PROVIDER ?? "anthropic").trim().toLowerCase(),
    /** Model id. Empty → per-provider default (claude-sonnet-4-6 for
     *  anthropic, gpt-5.4-mini for openai). */
    model: process.env.LLM_MODEL ?? "",
    /** Base URL override for the active provider. Empty → provider default
     *  (api.anthropic.com / api.openai.com). Point at a compatible endpoint
     *  to use a self-hosted or alternate model. */
    baseUrl: process.env.LLM_BASE_URL ?? "",
    /** Explicit key override for the active provider. When unset the
     *  provider-specific key below is used. */
    apiKey: process.env.LLM_API_KEY ?? "",
    /** Anthropic key — also the bring-your-own-key fallback. */
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
    /** claude.ai subscription OAuth token (from `claude setup-token`). When
     *  set — and no custom LLM_BASE_URL is in play — the product-layer Claude
     *  analysers authenticate with this Bearer token instead of an API key, so
     *  product LLM usage rides the subscription rather than metered API billing
     *  (§BYO-subscription). Mirrors the fleet's CLAUDE_CODE_OAUTH_TOKEN /
     *  ANTHROPIC_AUTH_TOKEN precedence. */
    oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? process.env.ANTHROPIC_AUTH_TOKEN ?? "",
    /** OpenAI key — used when provider is "openai". */
    openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  },
} as const;
