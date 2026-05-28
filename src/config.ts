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
} as const;
