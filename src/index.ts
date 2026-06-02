/* ============================================================
   Cantila control plane — HTTP API server.
   A thin Fastify transport over the shared ControlPlane service.
   ============================================================ */

import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { config } from "./config";
import { createStore } from "./domain/create-store";
import { seedOwnerAccount } from "./domain/seed-owner";
import { seedPlatformProject } from "./domain/seed-platform";
import { reconcileProjectMailboxes } from "./domain/reconcile-mailboxes";
import { selectDataPlane } from "./dataplane/factory";
import { selectProvisioner } from "./dataplane/coolify-provisioner";
import { ControlPlane } from "./core/control-plane";
import type { ApiKey, AccountPlan } from "./domain/types";
import { now } from "./lib/ids";
import { setRequestContext } from "./lib/request-context";
import { McpServer } from "./mcp/server";
import { cantilaTools } from "./mcp/tools";
import { StubStripeAdapter, type StripeAdapter } from "./billing/stripe";
import { StripeRealAdapter } from "./billing/stripe-real";
import { RuleBasedAiAnalyser } from "./ai/analyser";
import { buildAiAnalyser, buildDeployPlanner } from "./ai/factory";
import { buildImageProvider } from "./skills/image-provider";
import { ProjectOrchestrator } from "./agents/project-orchestrator";
import { buildDefaultRegistry } from "./automations/registry";
import { registerAutomationRoutes } from "./automations/routes";
import { registerConnectionRoutes } from "./connections/routes";
import {
  registerCantilapayRoutes,
  selectPaymentProcessor,
  startDeliveryWorker as startCantilapayDeliveryWorker,
  startBillingEngineWorker as startCantilapayBillingEngineWorker,
} from "./cantilapay";
import { getPrisma } from "./lib/prisma";
import { createRateLimiter } from "./auth/rate-limit";
import {
  NoAccountContextError,
  getApiKey,
  getActAs,
  getSessionAuth,
  resolveAccountId,
  resolveActorAccountId,
} from "./auth/account";
import type { SessionAuth } from "./auth/account";
import { authorizeSuperuser } from "./auth/superuser";
import type { PlatformRole } from "./domain/types";

// 10 auth attempts per IP per minute, shared across login/register/sso.
const authRateLimit = createRateLimiter({ windowMs: 60_000, max: 10 });

// Stripe adapter — auto-selects on `STRIPE_SECRET_KEY` presence (plan
// §15.1). When set, the real Stripe-SDK-backed adapter is wired and
// model spend lands on real customers/subscriptions. Without the key,
// the stub adapter mints deterministic fake ids so the rail is
// exercised end-to-end without an internet connection. The webhook
// signing secret defaults to the stub's fixed value so the smoke test
// keeps working when STRIPE_SECRET_KEY is unset.
const stripe: StripeAdapter = process.env.STRIPE_SECRET_KEY
  ? new StripeRealAdapter({
      secretKey: process.env.STRIPE_SECRET_KEY,
      webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? "",
    })
  : new StubStripeAdapter();

// AI analyser — auto-selects for the configured provider (plan §5.6 /
// §15.1). config.llm.provider picks Claude (default, ANTHROPIC_API_KEY) or
// OpenAI (LLM_PROVIDER=openai + OPENAI_API_KEY, default gpt-5.4-mini); the
// live analyser is wired with the rule-based one as its fallback (any LLM
// error degrades to rule-based, not "broken"). Without a key the rule-based
// analyser runs standalone.
const ruleBased = new RuleBasedAiAnalyser();
const aiAnalyser = buildAiAnalyser(ruleBased);

const store = createStore();

// Data plane — auto-selects on COOLIFY_API_URL + COOLIFY_API_TOKEN +
// COOLIFY_SERVER_UUID + COOLIFY_PROJECT_UUID (plan §19). Without all
// four, the stub data plane runs and the deploy pipeline simulates
// builds locally — same offline contract as v1.3.
// The store reference is passed so the Coolify data plane persists
// each project's Coolify Application UUID on `Project.coolifyAppUuid`
// instead of rebuilding the in-process cache from a full /applications
// scan after every restart (plan §19).
const dataPlaneSelection = selectDataPlane(process.env, { store });
const dataPlane = dataPlaneSelection.dataPlane;
console.log(`[dataplane] ${dataPlaneSelection.label} (${dataPlaneSelection.live ? "live" : "stub"})`);

// Service provisioner (plan §4.2 — auto-wired DB/mail). Goes live with a
// real Coolify Postgres provisioner when the Coolify creds + server/project
// pair are set; otherwise stays the stub. Mailbox creation stays on the
// stub regardless (Cantila Mail is a separate backend).
const provisionerSelection = selectProvisioner(process.env);
console.log(
  `[provisioner] ${provisionerSelection.live ? "Coolify (real Postgres)" : "stub"} (${provisionerSelection.live ? "live" : "stub"})`,
);

// Cantila Automations (plan §4.10) — engine adapter registry. Phase A
// ships stubs for both kinds; Phase B + D swap in `N8nEngineAdapter` and
// `OpenClawEngineAdapter` when their env vars are set.
const engineRegistry = buildDefaultRegistry();

/** In-process secrets store backing Cantila Connections (plan §4.11).
 *  Phase A placeholder for the real secrets manager — connection routes
 *  write through it, the credential broker (plan §15.5 Phase F) reads
 *  through it to push real bytes into engines. Shared at module scope
 *  so writes from `/v1/connections` are visible to the broker. */
const connectionSecrets = new Map<string, Record<string, string>>();
const writeConnectionSecret = async (
  ref: string,
  payload: Record<string, string>,
): Promise<void> => {
  connectionSecrets.set(ref, payload);
};
const readConnectionSecret = async (
  ref: string,
): Promise<Record<string, string> | null> => {
  return connectionSecrets.get(ref) ?? null;
};

const cp = new ControlPlane({
  store,
  provisioner: provisionerSelection.provisioner,
  dataPlane,
  stripe,
  aiAnalyser,
  engineRegistry,
  resolveSecret: readConnectionSecret,
});

// Per-project agent team (plan: complete-builder). Auto-selects an LLM
// planner + image provider based on env (ANTHROPIC_API_KEY,
// REPLICATE_API_TOKEN). Without either, the orchestrator runs entirely
// on deterministic stubs so every flow is exercisable offline.
const deployPlanner = buildDeployPlanner();
const imageProvider = buildImageProvider();
const projectOrchestrator = new ProjectOrchestrator({
  cp,
  planner: deployPlanner,
  images: imageProvider,
});

// Remote MCP server (plan §4.3.2 — "Cantila publishes a remote MCP
// server"). Shares the same ControlPlane instance the HTTP API uses, so
// stdio + remote + Console all read and write the same store. The same
// `McpServer` class powers both transports — see `src/mcp/server.ts`.
const mcpServer = new McpServer({ name: "cantila", version: "0.1.0" });
for (const tool of cantilaTools(cp)) mcpServer.addTool(tool);

const app = Fastify({ logger: true });

/* ----- Raw-body capture for webhook HMAC verification.
 *
 * Fastify parses application/json and hands the route the parsed object;
 * the original bytes are lost. For signature checks we MUST hash the
 * exact bytes the sender hashed — re-serialising the parsed JSON would
 * not match (key ordering, whitespace, escaping). So we register a
 * custom JSON parser that stashes the raw text on `req.rawBody` before
 * delegating to the default parser.
 * ----- */

app.addContentTypeParser(
  "application/json",
  { parseAs: "string" },
  (req, body, done) => {
    (req as unknown as { rawBody: string }).rawBody =
      typeof body === "string" ? body : body.toString("utf8");
    if (!body || (typeof body === "string" && body.length === 0)) {
      done(null, {});
      return;
    }
    try {
      const parsed = JSON.parse(typeof body === "string" ? body : body.toString("utf8"));
      done(null, parsed);
    } catch (err) {
      done(err as Error, undefined);
    }
  },
);

function rawBodyOf(req: FastifyRequest): string {
  return (req as unknown as { rawBody?: string }).rawBody ?? "";
}

/* ----- CORS — allow the Console (Next.js dev server) to call this ----- */

app.addHook("onRequest", async (req, reply) => {
  reply.header("access-control-allow-origin", "*");
  reply.header("access-control-allow-methods", "GET,POST,PUT,DELETE,OPTIONS");
  reply.header("access-control-allow-headers", "content-type,authorization");
  if (req.method === "OPTIONS") {
    return reply.code(204).send();
  }
});

/* ----- Auth gate (plan §5.4)
 *
 *   Resolution runs on every request — if a Bearer key is supplied and
 *   valid, it is attached to the request as `req.apiKey`. Downstream route
 *   handlers read it via `resolveAccountId(req)` to scope queries to the
 *   caller's account.
 *
 *   Enforcement only kicks in when CANTILA_REQUIRE_AUTH=true. When on:
 *     - GET /v1/health, GET /v1/me, OPTIONS are always allowed.
 *     - GET routes require an API key of any scope.
 *     - Mutating routes (POST/PUT/PATCH/DELETE) require `deploy` or `admin`.
 *     - API-key management (/v1/api-keys, /v1/me) requires `admin`.
 *
 *   Project-scoped routes additionally call `assertProjectAccess` so a key
 *   for account A cannot operate on a project owned by account B.
 * ----- */

const EXEMPT_PATHS = new Set([
  "/v1/health",
  // `/v1/billing/info` carries the Stripe publishable key (safe to expose
  // by design) and the public marketing pricing catalog the apex /pricing
  // page server-fetches. No sensitive data — keeping it un-authed so an
  // un-authed visitor (and the apex page itself) can render the catalog.
  "/v1/billing/info",
  // Password reset flow (plan §5.4 / v1.18): the user is signed-out by
  // definition. Enumeration-safe — both endpoints return a uniform
  // success shape regardless of whether the email/token is valid.
  "/v1/auth/forgot",
  "/v1/auth/reset-password",
  // Email-verify completion (plan §5.4 / v1.18): the click-through
  // from the email arrives without a session (e.g. on the user's
  // phone where they're not signed in). The verify-request endpoint
  // is session-gated separately at the route.
  "/v1/auth/verify-email/confirm",
  // Cantilapay health probe — surfaces the adapter label so an operator
  // can confirm the live rail is wired. No sensitive data (plan §25).
  "/v1/cantilapay/health",
]);

function scopeAllows(
  scope: "read" | "deploy" | "admin",
  method: string,
  url: string,
): boolean {
  if (url.startsWith("/v1/api-keys")) return scope === "admin";
  const isWrite = method !== "GET" && method !== "HEAD";
  if (!isWrite) return true; // any scope can read
  return scope === "deploy" || scope === "admin";
}


// Always-on hook: resolve whatever credential the caller supplied.
//   - `Bearer ctk_…` — a scoped API key → attached as `req.apiKey`.
//   - `Bearer cts_…` — a Console session → attached as `req.session`.
// Never rejects — enforcement is the next hook's job. A header that is
// present but doesn't validate is recorded as an `invalid_key` failure so
// SecurityAgent can spot brute-force probing even when enforcement is off.
app.addHook("onRequest", async (req) => {
  if (req.method === "OPTIONS") return;
  const auth = typeof req.headers.authorization === "string"
    ? req.headers.authorization
    : undefined;
  if (!auth) return;
  const m = /^Bearer\s+(\S+)$/i.exec(auth);
  const token = m ? m[1] : undefined;

  // A `cts_` Bearer token is a Console session — resolve it to the
  // signed-in user's account and attach it as `req.session`.
  if (token && token.startsWith("cts_")) {
    const resolved = await cp.resolveSession(token);
    if (resolved) {
      (req as unknown as { session?: SessionAuth }).session = {
        userId: resolved.user.id,
        // Plan §18 — Option B: prefer the session's current active org;
        // fall back to the legacy AuthUser.accountId for pre-§18 sessions.
        // May be undefined when the user has no current/legacy account —
        // routes that need a definite account go through `resolveAccountId`,
        // which throws NoAccountContextError (→ 401) rather than inventing one.
        accountId: resolved.currentAccountId ?? resolved.user.accountId,
        sessionId: resolved.sessionId,
        platformRole: resolved.user.platformRole,
      };
      return;
    }
    cp.recordAuthFailure({
      reason: "invalid_key",
      method: req.method,
      route: req.url.split("?")[0],
      keyPrefix: token.slice(0, 12),
    });
    return;
  }

  // Otherwise — a scoped API key (`ctk_`).
  const key = await cp.authenticate(auth);
  if (key) {
    (req as unknown as { apiKey?: ApiKey }).apiKey = key;
    return;
  }
  // Header was present but didn't resolve — surface the prefix (first 12
  // chars, max) so a burst can be attributed.
  cp.recordAuthFailure({
    reason: "invalid_key",
    method: req.method,
    route: req.url.split("?")[0],
    keyPrefix: token ? token.slice(0, 12) : undefined,
  });
});

/* ----- X-Cantila-Act-As — sub-account impersonation (plan §5.5).
 *
 *   An agency parent can scope a single request to one of its
 *   sub-accounts by sending `X-Cantila-Act-As: <accountId-or-handle>`.
 *   This hook resolves the header, checks `cp.canActOnAccount(caller,
 *   target)`, and attaches `req.actAs = <targetAccountId>` on success.
 *   Downstream code reads it via `resolveAccountId(req)`, which prefers
 *   `req.actAs` over the caller's own account.
 *
 *   Safety:
 *    - Without an authenticated credential (API key or session), the
 *      header is rejected (401). You cannot impersonate without first
 *      proving who you are.
 *    - `canActOnAccount` already implements the rule: the caller must
 *      either BE the target or be its agency parent. A wider grant
 *      model (delegated admin, team-membership-across-tenants) is a
 *      future drop that swaps the check without changing call sites.
 *    - Failures are recorded as `cross_account` so SecurityAgent can
 *      detect impersonation probing.
 * ----- */
app.addHook("onRequest", async (req, reply) => {
  if (req.method === "OPTIONS") return;
  const raw = req.headers["x-cantila-act-as"];
  const headerValue = typeof raw === "string" ? raw.trim() : "";
  if (!headerValue) return;

  const key = getApiKey(req);
  const session = getSessionAuth(req);
  const callerAccountId = key?.accountId ?? session?.accountId;
  if (!callerAccountId) {
    cp.recordAuthFailure({
      reason: "no_credentials",
      method: req.method,
      route: req.url.split("?")[0],
    });
    return reply.code(401).send({
      error:
        "X-Cantila-Act-As requires an authenticated API key or session token",
    });
  }

  // Resolve target by id or handle. An `acc_…` prefix is treated as an
  // id; anything else is a handle lookup. Handle resolution is a single
  // DB read; falling back to id resolution lets a caller pass either.
  let targetId = headerValue;
  if (!headerValue.startsWith("acc_")) {
    const byHandle = await cp.findAccountByHandle(headerValue);
    if (!byHandle) {
      return reply.code(404).send({
        error: `act-as target '${headerValue}' not found`,
      });
    }
    targetId = byHandle.id;
  } else {
    // Confirm the id exists so we 404 here rather than letting downstream
    // routes return a more confusing error.
    const byId = await cp.getAccount(targetId);
    if (!byId) {
      return reply.code(404).send({
        error: `act-as target '${headerValue}' not found`,
      });
    }
  }

  if (!(await cp.canActOnAccount(callerAccountId, targetId))) {
    cp.recordAuthFailure({
      reason: "cross_account",
      method: req.method,
      route: req.url.split("?")[0],
      keyPrefix: key?.prefix,
      accountId: callerAccountId,
    });
    return reply.code(403).send({
      error: `you cannot act as account '${targetId}' from '${callerAccountId}'`,
    });
  }

  (req as unknown as { actAs?: string }).actAs = targetId;
});

/* ----- Per-request audit context (plan §5.5).
 *
 *   Sets the request's `actorAccountId` / `sessionUserId` on the
 *   ambient AsyncLocalStorage store so every `recordEvent` call
 *   downstream — across the deep ControlPlane call graph — can stamp
 *   "done by <actor>" without explicit threading. The actor is only
 *   meaningful when it differs from the target account; recordEvent
 *   suppresses the stamp when actor == target.
 *
 *   Runs after the credential-resolution + act-as hooks so all three
 *   `req.apiKey` / `req.session` / `req.actAs` slots are populated.
 *   Fastify executes this hook in the same async chain as the route
 *   handler, so `setRequestContext` (via AsyncLocalStorage.enterWith)
 *   propagates to every awaited call beneath it.
 * ----- */
app.addHook("onRequest", async (req) => {
  if (req.method === "OPTIONS") return;
  const key = getApiKey(req);
  const session = getSessionAuth(req);
  // The actor is the caller's true account — ignore any act-as
  // override. For an X-Cantila-Act-As request this is the parent;
  // for a normal request it's just the caller (recordEvent then
  // notices actor == target and stamps nothing).
  const actorAccountId = key?.accountId ?? session?.accountId;
  setRequestContext({
    actorAccountId,
    sessionUserId: session?.userId,
  });
});

if (config.requireAuth) {
  app.addHook("onRequest", async (req, reply) => {
    if (req.method === "OPTIONS") return;
    const url = req.url.split("?")[0];
    if (EXEMPT_PATHS.has(url)) return;
    // /v1/auth/* — per-user login, SSO, session and logout. These can't
    // require an API key (you can't authenticate to obtain a credential
    // with a credential). The session layer is additive to API-key auth.
    if (url.startsWith("/v1/auth/")) return;
    // Carrier webhooks — inbound SMS / voice and SMS / call delivery
    // status land here. A carrier can't present an API key; the
    // TelephonyProvider verifies the carrier's own webhook signature
    // instead (same posture as the Stripe webhook).
    if (
      url.endsWith("/sms/inbound") ||
      url.endsWith("/voice/inbound") ||
      url.endsWith("/sms/status") ||
      url.endsWith("/voice/status") ||
      url.endsWith("/mail/inbound") ||
      url.endsWith("/voice/webhook/telnyx/agent")
    ) {
      return;
    }
    // Cantilapay inbound PSP webhooks — Adyen can't present an API key;
    // signature verification on the raw body is the credential (plan
    // §25). The cantilapay routes also use their OWN tenant key chain
    // (`cpk_…` / `csk_…`) for tenant traffic, separate from Cantila
    // admin keys; the route layer handles that gate itself, so /v1/cantilapay/*
    // bypasses this top-level enforcement.
    if (url.startsWith("/v1/cantilapay/")) return;
    // Node-agent endpoints (plan §5.5 — BYO-VPS). The agent on the
    // tenant's box doesn't hold an API key — the raw enrollment token
    // it presents in the body is the credential, and the CP looks it
    // up by SHA-256 hash.
    if (
      req.method === "POST" &&
      (url === "/v1/nodes/complete" || url === "/v1/nodes/heartbeat")
    ) {
      return;
    }
    // /v1/me is the "who am I" check — let it through unauthenticated so the
    // caller gets back { authenticated: false } rather than a 401 wall.
    if (url === "/v1/me") return;

    // Invite lookup + accept are by definition unauthenticated — the
    // invitee doesn't have a session yet. The token itself is the
    // credential. (`POST /v1/invites` to MINT an invite still requires
    // a real principal.)
    if (url.startsWith("/v1/invites/by-token/")) return;
    if (req.method === "POST" && url === "/v1/invites/accept") return;

    // Bootstrap window: when zero Account rows exist on the whole control
    // plane, allow either POST /v1/api-keys or POST /v1/accounts without
    // auth. Both routes provision the operator's first tenant + admin key
    // atomically; from then on the normal rules apply. (Same Stripe-style
    // first-time-setup pattern.)
    if (
      req.method === "POST" &&
      (url === "/v1/api-keys" || url === "/v1/accounts")
    ) {
      const totalAccounts = await cp.countAccounts();
      if (totalAccounts === 0) return;
    }
    // /v1/accounts/me is the "what tenant am I on" check — let it through
    // unauthenticated so it returns 404/400 with context instead of 401.
    if (req.method === "GET" && url === "/v1/accounts/me") return;

    const key = getApiKey(req);
    const session = getSessionAuth(req);
    if (!key && !session) {
      cp.recordAuthFailure({
        reason: "no_credentials",
        method: req.method,
        route: url,
      });
      return reply.code(401).send({
        error:
          "authentication required — pass a Bearer API key or session token",
      });
    }
    // A Console session is a signed-in account owner — full account
    // scope, no per-scope gating. API keys are still scope-gated.
    if (key && !scopeAllows(key.scope, req.method, url)) {
      cp.recordAuthFailure({
        reason: "scope_denied",
        method: req.method,
        route: url,
        keyPrefix: key.prefix,
        accountId: key.accountId,
      });
      return reply.code(403).send({
        error: `key scope '${key.scope}' is not allowed for ${req.method} ${url}`,
      });
    }
  });
  app.log.info("auth enforcement is ON (CANTILA_REQUIRE_AUTH)");
}

/* ----- per-request account scoping -----
 *
 * `getApiKey`, `getSessionAuth`, `getActAs`, `resolveAccountId`,
 * `resolveActorAccountId` and `NoAccountContextError` now live in
 * `./auth/account` so they can be unit-tested without booting the server
 * (this module calls `app.listen` at import time). They are imported at
 * the top of this file. */

/** Guard for billing mutations — checkout, billing-portal and plan-change.
 *  These must act on a real authenticated principal (a scoped API key or a
 *  Console session). `resolveAccountId` already throws (→ 401) when there is
 *  no principal and no explicit query account, but this guard additionally
 *  rejects an anonymous `?accountId=` query so an unauthenticated visitor
 *  cannot open a checkout or portal session against an account they do not
 *  own. Returns the target account id (which may be
 *  the caller's own account, or a sub-account they're impersonating via
 *  `X-Cantila-Act-As` — plan §5.5), or sends a 401 and returns null.
 *  Independent of `CANTILA_REQUIRE_AUTH`. Plan §8.5.3.
 *
 *  Note on act-as: the act-as header itself required an authenticated
 *  principal at the resolution hook above, so by the time we see
 *  `req.actAs` here we know the caller proved who they are AND that
 *  `canActOnAccount(caller, target)` returned true. An agency parent
 *  managing a sub-account's billing (opening its checkout, viewing its
 *  portal, changing its plan) is intentionally allowed — the parent
 *  owns the sub-account. Per-tenant Stripe customers are still
 *  distinct; the §5.5 billing-rollup follow-up is what flips this so
 *  the parent's subscription covers every child. */
function requireBillingPrincipal(
  req: FastifyRequest,
  reply: FastifyReply,
): string | null {
  const actAs = getActAs(req);
  const key = getApiKey(req);
  const session = getSessionAuth(req);
  if (!key && !session) {
    cp.recordAuthFailure({
      reason: "no_credentials",
      method: req.method,
      route: req.url.split("?")[0],
    });
    reply.code(401).send({
      error:
        "billing actions require an authenticated API key or Console session",
    });
    return null;
  }
  return actAs ?? key?.accountId ?? session?.accountId ?? null;
}

/* ----- super-user route guard (super-user management, slice 1).
 *  Resolves the caller's session, asserts the platform role, and — on
 *  success — returns the SessionAuth. On failure it sends the mapped
 *  status and returns null. Read routes pass `["superadmin","support"]`. */
function requireSuper(
  request: FastifyRequest,
  reply: FastifyReply,
  allow: PlatformRole[] = ["superadmin"],
): SessionAuth | null {
  const decision = authorizeSuperuser(getSessionAuth(request), allow);
  if (!decision.ok) {
    cp.recordAuthFailure({
      reason: "scope_denied",
      method: request.method,
      route: request.url.split("?")[0],
    });
    reply.code(decision.status).send({ error: decision.error });
    return null;
  }
  return decision.session;
}

/** Validate that `projectId` exists AND (when auth is enforced) belongs to
 *  the caller's account. Sends the right error response and returns null
 *  on failure; returns the project on success so the route can re-use it. */
async function assertProjectAccess(
  req: FastifyRequest,
  reply: FastifyReply,
  projectId: string,
): Promise<import("./domain/types").Project | null> {
  const project = await cp.getProject(projectId);
  if (!project) {
    reply.code(404).send({ error: "project not found" });
    return null;
  }
  // When a credential is on the request — an API key or a Console
  // session — enforce ownership. Without one (auth off, no session), the
  // demo flow can touch anything, same as v1.3.
  const key = getApiKey(req);
  const session = getSessionAuth(req);
  const actAs = getActAs(req);
  // Plan §5.5 — act-as is strict confinement: while a parent is acting
  // as sub-account X, they may only touch X's projects, not Y's. The
  // act-as hook already verified `canActOnAccount` so we trust the
  // target here.
  const scopeAccountId = actAs ?? key?.accountId ?? session?.accountId;
  if (scopeAccountId && project.accountId !== scopeAccountId) {
    // White-label parent → child read/write is allowed (plan §5.5) when
    // the caller has NOT pinned themselves to one sub-account via
    // act-as: an agency account can transparently act on any of its
    // sub-accounts' projects. Once act-as is set the parent has
    // narrowed their own scope and the fall-through is suppressed.
    if (
      !actAs &&
      (await cp.canActOnAccount(scopeAccountId, project.accountId))
    ) {
      return project;
    }
    cp.recordAuthFailure({
      reason: "cross_account",
      method: req.method,
      route: req.url.split("?")[0],
      keyPrefix: key?.prefix,
      accountId: scopeAccountId,
    });
    reply.code(403).send({ error: "project belongs to a different account" });
    return null;
  }
  return project;
}

/* ----- request schemas ----- */

const createProjectSchema = z.object({
  name: z.string().min(1),
  accountId: z.string().optional(),
  runtime: z
    .enum(["static", "node", "python", "php", "go", "ruby", "docker"])
    .default("node"),
  region: z.enum(["fsn1", "hel1", "ash"]).default("fsn1"),
});

const deploySchema = z.object({
  trigger: z.enum(["chat", "git", "cli", "mcp", "upload"]).default("cli"),
  source: z
    .object({
      kind: z.enum(["git", "upload", "chat"]).default("git"),
      ref: z.string().optional(),
    })
    .default({ kind: "git" }),
  // Convenience: connect a git repo as part of the deploy. When set and
  // the project isn't already pointed at this repo, the deploy connects
  // it first (equivalent to POST /v1/projects/:id/git) then builds — so a
  // one-shot "deploy this repo" works without a separate connect call.
  repoUrl: z.string().url().optional(),
  branch: z.string().optional(),
});

const setEnvSchema = z.object({
  key: z.string().min(1),
  value: z.string(),
  secret: z.boolean().default(true),
  scope: z.enum(["production", "preview", "all"]).default("all"),
});

const writeFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  sha: z.string().optional(),
  message: z.string().optional(),
});

const addDomainSchema = z.object({
  hostname: z.string().min(1),
});

const renameSlugSchema = z.object({
  slug: z.string().min(1).max(63),
});

// Conversations (multi-conversation chat history, conversations design 2026-05-30).
const createConversationSchema = z.object({
  title: z.string().min(1).max(200).optional(),
});

const renameConversationSchema = z.object({
  title: z.string().min(1).max(200),
});

const scaleSchema = z.object({
  vcpu: z.number().int().min(1).max(32).optional(),
  memoryMb: z.number().int().min(256).max(65536).optional(),
  diskGb: z.number().int().min(1).max(1000).optional(),
  alwaysOn: z.boolean().optional(),
  desiredInstances: z.number().int().min(1).max(32).optional(),
  minInstances: z.number().int().min(1).max(32).optional(),
  maxInstances: z.number().int().min(1).max(32).optional(),
});

const provisionDbSchema = z.object({
  engine: z.enum(["postgres", "mysql", "mongodb", "redis"]).default("postgres"),
});

const connectGitSchema = z.object({
  repoUrl: z.string().url(),
  branch: z.string().default("main"),
  autoDeploy: z.boolean().default(true),
});

const searchDomainsSchema = z.object({
  q: z.string().min(1),
  tlds: z.string().optional(), // comma-separated
});

const registerDomainSchema = z.object({
  accountId: z.string().optional(),
  hostname: z.string().min(3),
  years: z.number().int().min(1).max(10).default(1),
  whoisPrivacy: z.boolean().default(true),
  autoRenew: z.boolean().default(true),
  projectId: z.string().optional(),
});

const attachRegistrationSchema = z.object({
  projectId: z.string().min(1),
});

const createBucketSchema = z.object({
  projectId: z.string().min(1),
  name: z.string().min(1),
  publicRead: z.boolean().default(false),
  cdn: z.boolean().default(false),
});

const addMemberSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  role: z.enum(["owner", "admin", "developer", "viewer"]).default("developer"),
  accountId: z.string().optional(),
});

const updateMemberRoleSchema = z.object({
  role: z.enum(["owner", "admin", "developer", "viewer"]),
  accountId: z.string().optional(),
});

const createApiKeySchema = z.object({
  name: z.string().min(1),
  scope: z.enum(["read", "deploy", "admin"]).default("deploy"),
  accountId: z.string().optional(),
});

const createInviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(["owner", "admin", "developer", "viewer"]).default("developer"),
});

const acceptInviteSchema = z.object({
  token: z.string().min(8),
  name: z.string().min(1).optional(),
  password: z.string().min(1).optional(),
});

/** Bootstrap shape — used for both the first-ever POST /v1/api-keys (when
 *  no Account rows exist yet) and the admin POST /v1/accounts endpoint
 *  (when an existing operator wants to onboard a new tenant). */
const bootstrapAccountSchema = z.object({
  accountName: z.string().min(1),
  accountHandle: z.string().min(3).max(40),
  plan: z
    .enum(["hobby", "starter", "pro", "agency", "dedicated"])
    .default("hobby"),
  keyName: z.string().min(1).default("bootstrap-admin"),
  keyScope: z.enum(["read", "deploy", "admin"]).default("admin"),
});

const pushWebhookSchema = z.object({
  repoUrl: z.string().optional(),
  ref: z.string().optional(),
  branch: z.string().optional(),
  commit: z
    .object({
      hash: z.string().optional(),
      message: z.string().optional(),
      author: z.string().optional(),
    })
    .optional(),
});

/* ----- routes ----- */

app.get("/v1/health", async () => ({
  status: "ok",
  service: "cantila-control-plane",
  time: now(),
}));

// List all projects under an account.
app.get("/v1/projects", async (request) => {
  return { projects: await cp.listProjects(resolveAccountId(request)) };
});

// Create a project. The authenticated key's account is authoritative —
// the body's accountId is ignored when a key is on the request.
app.post("/v1/projects", async (request, reply) => {
  const parsed = createProjectSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }
  const project = await cp.createProject({
    ...parsed.data,
    accountId: resolveAccountId(request),
  });
  return reply.code(201).send(project);
});

// Project detail + its auto-wired services (secrets masked).
app.get("/v1/projects/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  if (!(await assertProjectAccess(request, reply, id))) return;
  const detail = await cp.getProjectDetail(id);
  if (!detail) return reply.code(404).send({ error: "project not found" });
  return detail;
});

// Run the deploy pipeline — auto-wires services on the first deploy.
app.post("/v1/projects/:id/deploy", async (request, reply) => {
  const { id } = request.params as { id: string };
  const parsed = deploySchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }
  if (!(await assertProjectAccess(request, reply, id))) return;
  // Optional inline git-connect (see deploySchema.repoUrl). Connect only
  // when the repo is new or changed so we don't rotate the webhook secret
  // on every deploy.
  if (parsed.data.repoUrl) {
    const existing = await cp.getProject(id);
    if (existing && existing.repoUrl !== parsed.data.repoUrl) {
      const connected = await cp.connectGit(id, {
        repoUrl: parsed.data.repoUrl,
        branch: parsed.data.branch,
      });
      if ("error" in connected) {
        return reply.code(400).send({ error: connected.error });
      }
    }
  }
  // Dunning gate (plan §8 / §15.2) — block deploys for an account
  // suspended/canceled for non-payment. 402 Payment Required.
  const billingGate = await cp.assertDeployAllowed(id);
  if (!billingGate.ok) {
    return reply.code(billingGate.code).send({ error: billingGate.error });
  }
  try {
    return await cp.deploy(id, {
      trigger: parsed.data.trigger,
      source: parsed.data.source,
    });
  } catch (err) {
    return reply
      .code(404)
      .send({ error: err instanceof Error ? err.message : "deploy failed" });
  }
});

// Streaming variant — Server-Sent Events of each pipeline step as it
// completes. Plan §5.3: real-time build & runtime logs.
app.post("/v1/projects/:id/deploy/stream", async (request, reply) => {
  const { id } = request.params as { id: string };
  const parsed = deploySchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }
  // Ownership check BEFORE hijacking the socket — otherwise a 403 turns
  // into a half-open SSE stream the client can't make sense of.
  if (!(await assertProjectAccess(request, reply, id))) return;
  // Optional inline git-connect (see deploySchema.repoUrl) — done before
  // the socket is hijacked so a bad repo returns a clean 400.
  if (parsed.data.repoUrl) {
    const existing = await cp.getProject(id);
    if (existing && existing.repoUrl !== parsed.data.repoUrl) {
      const connected = await cp.connectGit(id, {
        repoUrl: parsed.data.repoUrl,
        branch: parsed.data.branch,
      });
      if ("error" in connected) {
        return reply.code(400).send({ error: connected.error });
      }
    }
  }
  // Dunning gate — checked before the socket is hijacked so a blocked
  // deploy returns a clean 402 instead of a half-open SSE stream.
  const billingGate = await cp.assertDeployAllowed(id);
  if (!billingGate.ok) {
    return reply.code(billingGate.code).send({ error: billingGate.error });
  }

  // Take over the raw socket so we can write SSE frames directly.
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    "access-control-allow-origin": "*",
  });

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    send("start", { projectId: id, trigger: parsed.data.trigger });
    const outcome = await cp.deployStreaming(id, {
      trigger: parsed.data.trigger,
      source: parsed.data.source,
      onStep: (e) => send("step", e),
    });
    send("done", outcome);
  } catch (err) {
    send("error", {
      error: err instanceof Error ? err.message : "deploy failed",
    });
  } finally {
    res.end();
  }
});

// Build/deploy logs for the project's deployments.
app.get("/v1/projects/:id/logs", async (request, reply) => {
  const { id } = request.params as { id: string };
  if (!(await assertProjectAccess(request, reply, id))) return;
  const logs = await cp.getLogs(id);
  if (!logs) return reply.code(404).send({ error: "project not found" });
  return { deployments: logs };
});

// Environment variables — including the injected service credentials.
app.get("/v1/projects/:id/env", async (request, reply) => {
  const { id } = request.params as { id: string };
  if (!(await assertProjectAccess(request, reply, id))) return;
  const env = await cp.getEnv(id);
  if (!env) return reply.code(404).send({ error: "project not found" });
  return { env };
});

// Set or update an environment variable.
app.post("/v1/projects/:id/env", async (request, reply) => {
  const { id } = request.params as { id: string };
  const parsed = setEnvSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }
  if (!(await assertProjectAccess(request, reply, id))) return;
  const result = await cp.setEnv(id, parsed.data.key, parsed.data.value, {
    secret: parsed.data.secret,
    scope: parsed.data.scope,
  });
  if (!result) return reply.code(404).send({ error: "project not found" });
  return result;
});

// ---- Project files (GitHub-backed) ----
app.get("/v1/projects/:id/files", async (request, reply) => {
  const { id } = request.params as { id: string };
  const { ref } = request.query as { ref?: string };
  if (!(await assertProjectAccess(request, reply, id))) return;
  try {
    const result = await cp.listProjectFiles(id, ref);
    if (result === null) return reply.code(404).send({ error: "project not found" });
    if ("error" in result) return reply.code(409).send({ error: result.error });
    return result;
  } catch (err) {
    const status = (err as { status?: number }).status ?? 502;
    // Treat an upstream GitHub "not found" (e.g. private repo with no/invalid
    // token) as a 409 so the console shows the "no repo connected" empty state
    // rather than a hard error.
    return reply.code(status === 404 ? 409 : status).send({ error: (err as Error).message });
  }
});

app.get("/v1/projects/:id/files/content", async (request, reply) => {
  const { id } = request.params as { id: string };
  const { path, ref } = request.query as { path?: string; ref?: string };
  if (!path) return reply.code(400).send({ error: "path required" });
  if (!(await assertProjectAccess(request, reply, id))) return;
  try {
    const result = await cp.readProjectFile(id, path, ref);
    if (result === null) return reply.code(404).send({ error: "project not found" });
    if ("error" in result) return reply.code(409).send({ error: result.error });
    return result;
  } catch (err) {
    const status = (err as { status?: number }).status ?? 502;
    return reply.code(status).send({ error: (err as Error).message });
  }
});

app.put("/v1/projects/:id/files/content", async (request, reply) => {
  const { id } = request.params as { id: string };
  const parsed = writeFileSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
  if (!(await assertProjectAccess(request, reply, id))) return;
  try {
    const result = await cp.writeProjectFile(id, parsed.data);
    if (result === null) return reply.code(404).send({ error: "project not found" });
    if ("error" in result) return reply.code(409).send({ error: result.error });
    return result;
  } catch (err) {
    const status = (err as { status?: number }).status ?? 502;
    return reply.code(status).send({ error: (err as Error).message });
  }
});

app.delete("/v1/projects/:id/files/content", async (request, reply) => {
  const { id } = request.params as { id: string };
  const { path, sha } = request.query as { path?: string; sha?: string };
  if (!path || !sha) return reply.code(400).send({ error: "path and sha required" });
  if (!(await assertProjectAccess(request, reply, id))) return;
  try {
    const result = await cp.deleteProjectFile(id, { path, sha });
    if (result === null) return reply.code(404).send({ error: "project not found" });
    if ("error" in result) return reply.code(409).send({ error: result.error });
    return result;
  } catch (err) {
    const status = (err as { status?: number }).status ?? 502;
    return reply.code(status).send({ error: (err as Error).message });
  }
});

// Attach a custom domain (the free *.cantila.app subdomain is added with the project).
app.post("/v1/projects/:id/domains", async (request, reply) => {
  const { id } = request.params as { id: string };
  const parsed = addDomainSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }
  if (!(await assertProjectAccess(request, reply, id))) return;
  const result = await cp.addDomain(id, parsed.data.hostname);
  if ("error" in result) {
    const code = result.error === "project not found" ? 404 : 400;
    return reply.code(code).send({ error: result.error });
  }
  return reply.code(201).send(result);
});

// Vertical + horizontal resize (plan §5.2). 400 on bad instance bounds.
app.post("/v1/projects/:id/scale", async (request, reply) => {
  const { id } = request.params as { id: string };
  const parsed = scaleSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }
  if (!(await assertProjectAccess(request, reply, id))) return;
  const result = await cp.scale(id, parsed.data);
  if (!result) return reply.code(404).send({ error: "project not found" });
  if ("error" in result) return reply.code(400).send({ error: result.error });
  return result;
});

// Change the project's subdomain slug (plan §7.4). The live URL flips on
// the next deploy — the Coolify FQDN is derived from the slug at deploy
// time. 400 on a taken/invalid/unchanged slug, 404 on unknown project.
app.post("/v1/projects/:id/slug", async (request, reply) => {
  const { id } = request.params as { id: string };
  const parsed = renameSlugSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }
  if (!(await assertProjectAccess(request, reply, id))) return;
  const result = await cp.renameSlug(id, parsed.data.slug);
  if ("error" in result) {
    const code = result.error === "project not found" ? 404 : 400;
    return reply.code(code).send({ error: result.error });
  }
  return result;
});

// Per-instance health view (plan §5.2). Returns `desiredInstances` rows.
app.get("/v1/projects/:id/instances", async (request, reply) => {
  const { id } = request.params as { id: string };
  if (!(await assertProjectAccess(request, reply, id))) return;
  return { instances: await cp.listInstances(id) };
});

/** Project load samples (plan §5.2 — real CPU/RPS metrics). Returns the
 *  most-recent window (oldest-first) of CPU% / memory% / RPS samples
 *  the data plane produced; the stub synthesises plausible values from
 *  project state, production reads Docker / kube stats + LB counters. */
app.get("/v1/projects/:id/metrics", async (request, reply) => {
  const { id } = request.params as { id: string };
  if (!(await assertProjectAccess(request, reply, id))) return;
  return { samples: await cp.getProjectMetrics(id) };
});

/* ----- chat-driven build (complete-builder) ----- */

// Plan a deploy from a single free-form chat prompt. Pre-flight to
// `POST /v1/projects` — the Console chooses the runtime / type / services
// based on this output and creates the project with the planned values,
// then redirects to /@handle/<name>.
app.post("/v1/deploy/plan", async (request, reply) => {
  const body = (request.body ?? {}) as { prompt?: string; files?: string[] };
  if (!body.prompt || typeof body.prompt !== "string") {
    return reply.code(400).send({ error: "prompt required" });
  }
  const plan = await deployPlanner.plan({
    prompt: body.prompt,
    files: Array.isArray(body.files) ? body.files : undefined,
  });
  return { plan };
});

// Resolve a project from `@handle` + `name`. Lets the Console render a
// project page at `/@handle/<name>` without ever exposing the prj_* id.
app.get("/v1/projects/by-handle/:handle/:name", async (request, reply) => {
  const { handle, name } = request.params as { handle: string; name: string };
  const cleanHandle = handle.startsWith("@") ? handle.slice(1) : handle;
  const project = await cp.getProjectByHandle(cleanHandle, decodeURIComponent(name));
  if (!project) return reply.code(404).send({ error: "project not found" });
  if (!(await assertProjectAccess(request, reply, project.id))) return;
  const detail = await cp.getProjectDetail(project.id);
  if (!detail) return reply.code(404).send({ error: "project not found" });
  return detail;
});

// Per-project chat history. Returns the rolling thread of messages — user
// turns, agent ops, asset cards, results — in created-at order, scoped to a
// conversation (default "Main" when `?conversationId` is omitted).
app.get("/v1/projects/:id/chat", async (request, reply) => {
  const { id } = request.params as { id: string };
  if (!(await assertProjectAccess(request, reply, id))) return;
  const { conversationId } = (request.query ?? {}) as {
    conversationId?: string;
  };
  const chat = await cp.getChat(id, conversationId);
  if (!chat) {
    return reply
      .code(404)
      .send({ error: "project or conversation not found" });
  }
  // Merge the live in-memory stream (the orchestrator's per-process Map)
  // with the durable, conversation-scoped store. The store is the source of
  // truth for history; the in-memory rows cover a build/chat still
  // streaming in this process before its rows have been re-read.
  return { conversationId: chat.conversationId, messages: chat.messages };
});

// List a project's conversations (ensures the default "Main" first).
app.get("/v1/projects/:id/conversations", async (request, reply) => {
  const { id } = request.params as { id: string };
  if (!(await assertProjectAccess(request, reply, id))) return;
  const conversations = await cp.listConversations(id);
  if (!conversations) return reply.code(404).send({ error: "project not found" });
  return { conversations };
});

// Create a new conversation. Title defaults to "New chat".
app.post("/v1/projects/:id/conversations", async (request, reply) => {
  const { id } = request.params as { id: string };
  const parsed = createConversationSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }
  if (!(await assertProjectAccess(request, reply, id))) return;
  const conversation = await cp.createConversation(id, parsed.data.title);
  if (!conversation) return reply.code(404).send({ error: "project not found" });
  return reply.code(201).send(conversation);
});

// Rename a conversation.
app.patch("/v1/projects/:id/conversations/:cid", async (request, reply) => {
  const { id, cid } = request.params as { id: string; cid: string };
  const parsed = renameConversationSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }
  if (!(await assertProjectAccess(request, reply, id))) return;
  const updated = await cp.renameConversation(id, cid, parsed.data.title);
  if (!updated) return reply.code(404).send({ error: "conversation not found" });
  return updated;
});

// Delete a conversation (cascade deletes its messages). Deleting the last
// one is allowed — the list endpoint re-ensures a default on next load.
app.delete("/v1/projects/:id/conversations/:cid", async (request, reply) => {
  const { id, cid } = request.params as { id: string; cid: string };
  if (!(await assertProjectAccess(request, reply, id))) return;
  const result = await cp.deleteConversation(id, cid);
  if (!result) return reply.code(404).send({ error: "conversation not found" });
  return result;
});

// Per-project assets — the AssetGallery panel reads this. Every generated
// image / icon / lottie / video / file lands here with an inline preview.
app.get("/v1/projects/:id/assets", async (request, reply) => {
  const { id } = request.params as { id: string };
  if (!(await assertProjectAccess(request, reply, id))) return;
  return { assets: projectOrchestrator.listAssets(id) };
});

// Per-project brain snapshot — rolling summary + counts + last-change-at.
// The Brain panel reads this; it's the user-facing token-preservation
// readout (how much of the context window is in cached summary vs live
// history).
app.get("/v1/projects/:id/brain", async (request, reply) => {
  const { id } = request.params as { id: string };
  if (!(await assertProjectAccess(request, reply, id))) return;
  return projectOrchestrator.getBrain(id);
});

// Start the build for a freshly-created project. The Console calls this
// right after POST /v1/projects from the deploy chat, and the project
// page opens an SSE stream to receive the op cards as they happen.
app.post("/v1/projects/:id/build", async (request, reply) => {
  const { id } = request.params as { id: string };
  if (!(await assertProjectAccess(request, reply, id))) return;
  const body = (request.body ?? {}) as {
    prompt?: string;
    conversationId?: string;
  };
  if (!body.prompt) return reply.code(400).send({ error: "prompt required" });

  const plan = await deployPlanner.plan({ prompt: body.prompt });
  projectOrchestrator.seedFromDeploy({
    projectId: id,
    prompt: body.prompt,
    plan,
    conversationId: body.conversationId,
  });

  // Take over the socket and stream op events. Mirrors the pattern in the
  // deploy/stream route above.
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    "access-control-allow-origin": "*",
  });
  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  send("plan", plan);
  await projectOrchestrator.runBuild({
    projectId: id,
    plan,
    onEvent: (e) => send(e.kind, e),
    conversationId: body.conversationId,
  });
  res.end();
});

// Send a follow-up chat message on an existing project. Streams the
// orchestrator's reply + any dispatched agent ops + any newly-generated
// assets back as SSE events. `conversationId` in the body scopes the
// persisted rows to a thread (default "Main").
app.post("/v1/projects/:id/chat", async (request, reply) => {
  const { id } = request.params as { id: string };
  if (!(await assertProjectAccess(request, reply, id))) return;
  const body = (request.body ?? {}) as {
    message?: string;
    conversationId?: string;
  };
  if (!body.message || typeof body.message !== "string") {
    return reply.code(400).send({ error: "message required" });
  }

  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    "access-control-allow-origin": "*",
  });
  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  await projectOrchestrator.runChat({
    projectId: id,
    message: body.message,
    onEvent: (e) => send(e.kind, e),
    conversationId: body.conversationId,
  });
  res.end();
});

// AI troubleshooting — plan §5.6. Pattern-matches the deployment's step
// trace and returns plain-language suggestions + recommended actions.
app.get(
  "/v1/projects/:id/deployments/:deploymentId/troubleshoot",
  async (request, reply) => {
    const { id, deploymentId } = request.params as {
      id: string;
      deploymentId: string;
    };
    if (!(await assertProjectAccess(request, reply, id))) return;
    const result = await cp.troubleshootDeploy(id, deploymentId);
    if ("error" in result) {
      return reply.code(404).send({ error: result.error });
    }
    return result;
  },
);

// Instant rollback to a previous deployment.
app.post(
  "/v1/projects/:id/rollback/:deploymentId",
  async (request, reply) => {
    const { id, deploymentId } = request.params as {
      id: string;
      deploymentId: string;
    };
    if (!(await assertProjectAccess(request, reply, id))) return;
    const result = await cp.rollback(id, deploymentId);
    if ("error" in result) {
      const code = result.error.includes("not found") ? 404 : 400;
      return reply.code(code).send({ error: result.error });
    }
    return reply.code(201).send(result);
  },
);

/* ----- Cantila Mail + SMS fleet (plan §4.4, §4.5) ----- */

app.get("/v1/mail/fleet", async (request) => {
  return cp.listAccountMailboxes(resolveAccountId(request));
});

/** Account-wide mail deliverability rollup (plan §4.4 + §15.1 — MailAgent
 *  surface). `?sinceMinutes=N` narrows the window; default is the last hour. */
app.get("/v1/mail/deliverability", async (request) => {
  const q = (request.query ?? {}) as { sinceMinutes?: string };
  const sinceMinutes = q.sinceMinutes ? Number(q.sinceMinutes) : 60;
  const sinceIso = Number.isFinite(sinceMinutes)
    ? new Date(Date.now() - sinceMinutes * 60_000).toISOString()
    : undefined;
  const domains = await cp.getMailDeliverability(resolveAccountId(request), {
    sinceIso,
  });
  return { sinceIso, domains };
});

/** Per-pool deliverability rollup (plan §4.4 — IP-pool rotation). Same
 *  shape as `/v1/mail/deliverability` but grouped by the in-memory
 *  event's `poolId` instead of sending-domain — what MailAgent reads to
 *  reason about per-pool reputation. Events with no `poolId` (legacy
 *  or pre-rotation) are excluded. */
app.get("/v1/mail/pool-deliverability", async (request) => {
  const q = (request.query ?? {}) as { sinceMinutes?: string };
  const sinceMinutes = q.sinceMinutes ? Number(q.sinceMinutes) : 60;
  const sinceIso = Number.isFinite(sinceMinutes)
    ? new Date(Date.now() - sinceMinutes * 60_000).toISOString()
    : undefined;
  const pools = await cp.getMailPoolDeliverability(resolveAccountId(request), {
    sinceIso,
  });
  return { sinceIso, pools };
});

const sendMailSchema = z.object({
  to: z.string().email(),
  subject: z.string().optional(),
  body: z.string().optional(),
  /** Test hook — lets the smoke test force a high bounce rate without
   *  spamming real recipients. The real MTA won't honour this knob. */
  outcomeBias: z
    .object({
      delivered: z.number().min(0).max(1).optional(),
      bounced: z.number().min(0).max(1).optional(),
      complained: z.number().min(0).max(1).optional(),
    })
    .optional(),
});

/** Send one message through the project's mailbox. Today this is a mock
 *  that records the event and rolls an outcome; the route shape is what
 *  the real MTA will keep. Plan §15.2 — "Cantila Mail — fleet readout is
 *  live; the mail itself is not." */
app.post("/v1/projects/:id/mail/send", async (request, reply) => {
  const { id } = request.params as { id: string };
  const project = await assertProjectAccess(request, reply, id);
  if (!project) return;
  const parsed = sendMailSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.message });
  }
  const result = await cp.sendMail(id, parsed.data);
  if ("error" in result) return reply.code(400).send(result);
  return reply.code(202).send(result);
});

/** Inbound mail webhook — the MTA / aggregator POSTs here when a
 *  message lands on one of the project's sending domains. Carrier-called,
 *  so it carries no API key (exempt from the auth hook). Mirrors the
 *  SMS inbound shape — the real MTA verifies the carrier's own webhook
 *  signature before forwarding. */
const inboundMailSchema = z.object({
  to: z.string().email(),
  from: z.string().email(),
  subject: z.string().optional(),
  body: z.string().optional(),
  providerMessageId: z.string().optional(),
});

app.post("/v1/projects/:id/mail/inbound", async (request, reply) => {
  const { id } = request.params as { id: string };
  const parsed = inboundMailSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }
  const result = await cp.receiveInboundMail(id, parsed.data);
  if ("error" in result) return reply.code(400).send(result);
  return reply.code(200).send(result);
});

/** Persisted inbound mail message history for a project (plan §4.4 —
 *  two-way mail). Operator-facing GET, `assertProjectAccess`-gated. A
 *  distinct path from the carrier `/mail/inbound` webhook, so it is NOT
 *  covered by the inbound-webhook auth exemption. */
app.get("/v1/projects/:id/mail/inbox", async (request, reply) => {
  const { id } = request.params as { id: string };
  const project = await assertProjectAccess(request, reply, id);
  if (!project) return;
  const messages = await cp.listInboundMail(project.accountId, {
    projectId: id,
    limit: 100,
  });
  return { messages };
});

/** Account-wide inbound mail history (plan §4.4). */
app.get("/v1/mail/inbox", async (request) => {
  const messages = await cp.listInboundMail(resolveAccountId(request), {
    limit: 100,
  });
  return { messages };
});

app.get("/v1/sms/fleet", async (request) => {
  return {
    numbers: await cp.listAccountPhoneNumbers(resolveAccountId(request)),
  };
});

/** Per-number deliverability rollup (plan §4.5 + §15.1 — SmsAgent surface). */
app.get("/v1/sms/deliverability", async (request) => {
  const q = (request.query ?? {}) as { sinceMinutes?: string };
  const sinceMinutes = q.sinceMinutes ? Number(q.sinceMinutes) : 60;
  const sinceIso = Number.isFinite(sinceMinutes)
    ? new Date(Date.now() - sinceMinutes * 60_000).toISOString()
    : undefined;
  const numbers = await cp.getSmsDeliverability(resolveAccountId(request), {
    sinceIso,
  });
  return { sinceIso, numbers };
});

const sendSmsSchema = z.object({
  to: z.string().min(4),
  body: z.string().optional(),
  outcomeBias: z
    .object({
      delivered: z.number().min(0).max(1).optional(),
      failed: z.number().min(0).max(1).optional(),
      undelivered: z.number().min(0).max(1).optional(),
    })
    .optional(),
});

/** Send one SMS through the project's auto-wired phone number. Mock today
 *  (plan §15.2); the route shape is what the real SMSC will keep. */
app.post("/v1/projects/:id/sms/send", async (request, reply) => {
  const { id } = request.params as { id: string };
  const project = await assertProjectAccess(request, reply, id);
  if (!project) return;
  const parsed = sendSmsSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.message });
  }
  const result = await cp.sendSms(id, parsed.data);
  if ("error" in result) return reply.code(400).send(result);
  return reply.code(202).send(result);
});

const activateSmsSchema = z.object({
  country: z.string().min(2).max(2),
  numberType: z.enum(["local", "toll_free", "mobile", "short_code"]).optional(),
  capabilities: z.array(z.enum(["sms", "mms", "voice"])).optional(),
  e164: z.string().min(4).optional(),
});

/** Activate SMS on a project — opt-in (plan §4.5). Provisions a real
 *  carrier number, records it as the project's number, and injects
 *  `CANTILA_SMS_*`. Idempotent: returns the existing number if already on. */
app.post("/v1/projects/:id/sms/activate", async (request, reply) => {
  const { id } = request.params as { id: string };
  const project = await assertProjectAccess(request, reply, id);
  if (!project) return;
  const parsed = activateSmsSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.message });
  }
  const result = await cp.activateSms(project.accountId, id, parsed.data);
  if ("error" in result) return reply.code(400).send(result);
  return reply.code(201).send(result);
});

/** Deactivate SMS on a project — releases the number, stops billing, and
 *  strips the injected env. Idempotent. */
app.post("/v1/projects/:id/sms/deactivate", async (request, reply) => {
  const { id } = request.params as { id: string };
  const project = await assertProjectAccess(request, reply, id);
  if (!project) return;
  const result = await cp.deactivateSms(project.accountId, id);
  if ("error" in result) return reply.code(400).send(result);
  return reply.code(200).send(result);
});

const optOutSchema = z.object({
  from: z.string().min(4),
});

/** Record an inbound STOP / opt-out. The real SMSC's inbound webhook will
 *  call this; today it's the test handle SmsAgent uses to verify it sees
 *  the opt-out rate climb. */
app.post("/v1/projects/:id/sms/opt-out", async (request, reply) => {
  const { id } = request.params as { id: string };
  const project = await assertProjectAccess(request, reply, id);
  if (!project) return;
  const parsed = optOutSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.message });
  }
  const result = await cp.recordSmsOptOut(id, parsed.data.from);
  if ("error" in result) return reply.code(400).send(result);
  return reply.code(202).send(result);
});

/** Inbound SMS webhook — the carrier POSTs here when a text lands on a
 *  provisioned number. Carrier-called, so it carries no API key (exempt
 *  from the auth hook); the TelephonyProvider verifies the carrier's own
 *  webhook signature when it parses the payload. */
app.post("/v1/projects/:id/sms/inbound", async (request, reply) => {
  const { id } = request.params as { id: string };
  const result = await cp.receiveInboundSms(
    id,
    rawBodyOf(request),
    request.headers as Record<string, string>,
  );
  if ("error" in result) return reply.code(400).send(result);
  return reply.code(200).send(result);
});

/** Persisted inbound SMS message history for a project (plan §4.5 —
 *  two-way SMS). An operator-facing GET read — `assertProjectAccess`
 *  gated. A distinct path from the carrier `/sms/inbound` webhook, so it
 *  is NOT covered by the inbound-webhook auth exemption. */
app.get("/v1/projects/:id/sms/inbox", async (request, reply) => {
  const { id } = request.params as { id: string };
  const project = await assertProjectAccess(request, reply, id);
  if (!project) return;
  const messages = await cp.listInboundMessages(project.accountId, {
    projectId: id,
    limit: 100,
  });
  return { messages };
});

/** Account-wide inbound SMS message history (plan §4.5). */
app.get("/v1/sms/inbox", async (request) => {
  const messages = await cp.listInboundMessages(resolveAccountId(request), {
    limit: 100,
  });
  return { messages };
});

const voiceAgentSchema = z.object({
  name: z.string().min(1),
  instructions: z.string().min(1),
  voice: z.string().optional(),
  greeting: z.string().optional(),
  tools: z
    .array(z.object({ name: z.string(), description: z.string(), webhookUrl: z.string().url() }))
    .optional(),
});

/** Create a voice agent for a project. */
app.post("/v1/projects/:id/voice/agents", async (request, reply) => {
  const { id } = request.params as { id: string };
  const project = await assertProjectAccess(request, reply, id);
  if (!project) return;
  const parsed = voiceAgentSchema.safeParse(request.body ?? {});
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
  const result = await cp.createVoiceAgent(id, parsed.data);
  if ("error" in result) return reply.code(400).send(result);
  return reply.code(201).send(result);
});

/** Update a voice agent. */
app.patch("/v1/projects/:id/voice/agents/:agentId", async (request, reply) => {
  const { id, agentId } = request.params as { id: string; agentId: string };
  const project = await assertProjectAccess(request, reply, id);
  if (!project) return;
  const parsed = voiceAgentSchema.partial().safeParse(request.body ?? {});
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
  const result = await cp.updateVoiceAgent(id, agentId, parsed.data);
  if ("error" in result) return reply.code(400).send(result);
  return reply.code(200).send(result);
});

/** Delete a voice agent. */
app.delete("/v1/projects/:id/voice/agents/:agentId", async (request, reply) => {
  const { id, agentId } = request.params as { id: string; agentId: string };
  const project = await assertProjectAccess(request, reply, id);
  if (!project) return;
  const result = await cp.deleteVoiceAgent(id, agentId);
  if ("error" in result) return reply.code(400).send(result);
  return reply.code(200).send(result);
});

/** Bind a voice agent to the project's number. */
app.post("/v1/projects/:id/voice/agents/:agentId/attach", async (request, reply) => {
  const { id, agentId } = request.params as { id: string; agentId: string };
  const project = await assertProjectAccess(request, reply, id);
  if (!project) return;
  const result = await cp.attachVoiceAgent(id, agentId);
  if ("error" in result) return reply.code(400).send(result);
  return reply.code(200).send(result);
});

/** Agent/tool webhook — carrier-called, so auth-exempt; the signature is
 *  verified inside the port when the payload is parsed. */
app.post("/v1/projects/:id/voice/webhook/telnyx/agent", async (request, reply) => {
  const { id } = request.params as { id: string };
  const project = await cp.getProject(id);
  const result = await cp.receiveAgentEvent(
    id,
    rawBodyOf(request),
    request.headers as Record<string, string>,
    { toolWebhookUrl: project?.voiceAgentToolUrl },
  );
  if ("error" in result) return reply.code(400).send(result);
  return reply.code(200).send(result);
});

/** Persisted inbound voice-call history for a project (plan §4.5 —
 *  two-way voice). Operator-facing GET, `assertProjectAccess`-gated. */
app.get("/v1/projects/:id/voice/calls", async (request, reply) => {
  const { id } = request.params as { id: string };
  const project = await assertProjectAccess(request, reply, id);
  if (!project) return;
  const calls = await cp.listInboundCalls(project.accountId, {
    projectId: id,
    limit: 100,
  });
  return { calls };
});

/** Account-wide inbound voice-call history (plan §4.5). */
app.get("/v1/voice/calls", async (request) => {
  const calls = await cp.listInboundCalls(resolveAccountId(request), {
    limit: 100,
  });
  return { calls };
});

/** Inbound voice webhook — the carrier POSTs here on an incoming call;
 *  the response carries the routing decision (forward / voicemail / …). */
app.post("/v1/projects/:id/voice/inbound", async (request, reply) => {
  const { id } = request.params as { id: string };
  const result = await cp.receiveInboundCall(
    id,
    rawBodyOf(request),
    request.headers as Record<string, string>,
  );
  if ("error" in result) return reply.code(400).send(result);
  return reply.code(200).send(result);
});

/** Read the inbound call-routing rule on a project's number. */
app.get("/v1/projects/:id/voice/routing", async (request, reply) => {
  const { id } = request.params as { id: string };
  if (!(await assertProjectAccess(request, reply, id))) return;
  const result = await cp.getCallRouting(id);
  if ("error" in result) return reply.code(404).send(result);
  return reply.code(200).send(result);
});

const callRoutingSchema = z.object({
  action: z.enum(["forward", "voicemail", "reject", "app_webhook"]),
  target: z.string().optional(),
});

/** Set the inbound call-routing rule on a project's number. */
app.put("/v1/projects/:id/voice/routing", async (request, reply) => {
  const { id } = request.params as { id: string };
  if (!(await assertProjectAccess(request, reply, id))) return;
  const parsed = callRoutingSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.message });
  }
  const result = await cp.setCallRouting(id, parsed.data);
  if ("error" in result) return reply.code(400).send(result);
  return reply.code(200).send(result);
});

/** SMS delivery-status webhook — the carrier reports the terminal
 *  delivery state here. Carrier-called: no API key (exempt from the
 *  auth hook), like the inbound webhooks. */
app.post("/v1/projects/:id/sms/status", async (request, reply) => {
  const { id } = request.params as { id: string };
  const result = await cp.receiveSmsStatus(
    id,
    rawBodyOf(request),
    request.headers as Record<string, string>,
  );
  if ("error" in result) return reply.code(400).send(result);
  return reply.code(200).send(result);
});

/** Voice-call status webhook — the carrier reports call completion,
 *  voicemail, busy, no-answer, etc. */
app.post("/v1/projects/:id/voice/status", async (request, reply) => {
  const { id } = request.params as { id: string };
  const result = await cp.receiveCallStatus(
    id,
    rawBodyOf(request),
    request.headers as Record<string, string>,
  );
  if ("error" in result) return reply.code(400).send(result);
  return reply.code(200).send(result);
});

/* ----- SMS OTP / 2FA (plan §4.5 / §15.2 — phone verification) ----- */

const otpRequestSchema = z.object({
  phone: z.string().min(4),
  purpose: z.enum(["login", "two_factor", "phone_verification"]).optional(),
});

/** Issue a one-time passcode and deliver it over the project's SMS
 *  number. Outside production the response also carries `devCode` —
 *  there is no real SMSC behind the stub, so tests need the code. */
app.post("/v1/projects/:id/sms/otp/request", async (request, reply) => {
  const { id } = request.params as { id: string };
  const project = await assertProjectAccess(request, reply, id);
  if (!project) return;
  const parsed = otpRequestSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.message });
  }
  const result = await cp.requestSmsOtp(id, parsed.data);
  if ("error" in result) return reply.code(400).send(result);
  const body: Record<string, unknown> = { challenge: result.challenge };
  if (config.nodeEnv !== "production") body.devCode = result.code;
  return reply.code(201).send(body);
});

const otpVerifySchema = z.object({
  challengeId: z.string().optional(),
  phone: z.string().optional(),
  code: z.string().min(1),
});

/** Verify a one-time passcode. Identify the challenge by `challengeId`
 *  or by `phone` (most recent pending code wins). */
app.post("/v1/projects/:id/sms/otp/verify", async (request, reply) => {
  const { id } = request.params as { id: string };
  const project = await assertProjectAccess(request, reply, id);
  if (!project) return;
  const parsed = otpVerifySchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.message });
  }
  if (!parsed.data.challengeId && !parsed.data.phone) {
    return reply
      .code(400)
      .send({ error: "challengeId or phone is required" });
  }
  const result = await cp.verifySmsOtp(id, parsed.data);
  if ("error" in result) return reply.code(404).send(result);
  return reply.code(200).send(result);
});

/** Account-wide OTP rollup — active / verified / failed counts plus the
 *  recent challenges. Powers the Console SMS page and `cantila otp`. */
app.get("/v1/sms/otp", async (request) => {
  return cp.getOtpStats(resolveAccountId(request));
});

/* ----- number marketplace (plan §4.5 — buy & lease phone numbers) ----- */

const numberTypeEnum = z.enum([
  "local",
  "toll_free",
  "mobile",
  "short_code",
]);
const numberCapEnum = z.enum(["sms", "mms", "voice"]);

/** Search the number marketplace catalog — `?country=US&type=local&
 *  capability=voice&areaCode=415`. Prices are retail (pricebook). */
app.get("/v1/numbers/catalog", async (request) => {
  const q = (request.query ?? {}) as Record<string, string | undefined>;
  const t = numberTypeEnum.safeParse(q.type);
  const c = numberCapEnum.safeParse(q.capability);
  return {
    numbers: await cp.searchNumberCatalog({
      country: q.country ?? "US",
      type: t.success ? t.data : undefined,
      capability: c.success ? c.data : undefined,
      areaCode: q.areaCode,
    }),
  };
});

const purchaseNumberSchema = z.object({
  e164: z.string().min(4),
  country: z.string().min(2),
  numberType: numberTypeEnum,
  capabilities: z.array(numberCapEnum).min(1),
  projectId: z.string().optional(),
});

/** Purchase a number from the marketplace. The owning account is the
 *  caller's; pricing is server-set from the pricebook. */
app.post("/v1/numbers", async (request, reply) => {
  const parsed = purchaseNumberSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.message });
  }
  const result = await cp.purchaseNumber({
    accountId: resolveAccountId(request),
    ...parsed.data,
  });
  if ("error" in result) return reply.code(400).send(result);
  return reply.code(201).send(result);
});

/** List the marketplace numbers the caller's account owns. */
app.get("/v1/numbers", async (request) => {
  return { numbers: await cp.listOwnedNumbers(resolveAccountId(request)) };
});

/** Release a marketplace number — stops the monthly charge. */
app.delete("/v1/numbers/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  const result = await cp.releaseOwnedNumber(resolveAccountId(request), id);
  if ("error" in result) return reply.code(404).send(result);
  return reply.code(200).send(result);
});

const portInNumberSchema = z.object({
  e164: z.string().min(4),
  country: z.string().min(2),
  numberType: numberTypeEnum,
  capabilities: z.array(numberCapEnum).min(1),
  projectId: z.string().optional(),
});

/** Port in a number the account already owns at another carrier. The
 *  number is held in `porting` status until `complete-port` confirms it. */
app.post("/v1/numbers/port-in", async (request, reply) => {
  const parsed = portInNumberSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.message });
  }
  const result = await cp.portInNumber({
    accountId: resolveAccountId(request),
    ...parsed.data,
  });
  if ("error" in result) return reply.code(400).send(result);
  return reply.code(201).send(result);
});

/** Confirm a port-in — the carrier reports the completed port here
 *  (offline, drive it directly). Flips `porting` → `active`. */
app.post("/v1/numbers/:id/complete-port", async (request, reply) => {
  const { id } = request.params as { id: string };
  const result = await cp.completePortIn(resolveAccountId(request), id);
  if ("error" in result) return reply.code(400).send(result);
  return reply.code(200).send(result);
});

const transferNumberSchema = z.object({
  toAccountHandle: z.string().min(1),
});

/** Transfer an active number to another Cantila account by handle. */
app.post("/v1/numbers/:id/transfer", async (request, reply) => {
  const { id } = request.params as { id: string };
  const parsed = transferNumberSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.message });
  }
  const result = await cp.transferNumber({
    fromAccountId: resolveAccountId(request),
    numberId: id,
    toAccountHandle: parsed.data.toAccountHandle,
  });
  if ("error" in result) return reply.code(400).send(result);
  return reply.code(200).send(result);
});

/* ----- Compute nodes — Bring-Your-Own-VPS (plan §5.5) -----
 *
 * Two surfaces here, deliberately separated:
 *
 *   Operator API (account-scoped via `resolveAccountId`):
 *     POST /v1/nodes              — enrol a BYO node; returns the
 *                                   one-time enrollment token
 *     GET  /v1/nodes              — list the caller's nodes
 *     GET  /v1/nodes/:id          — get one
 *     DELETE /v1/nodes/:id        — retire (one-way)
 *
 *   Node-agent API (raw enrollment token is the credential, exempt
 *   from the API-key auth hook above):
 *     POST /v1/nodes/complete     — agent completes enrolment
 *     POST /v1/nodes/heartbeat    — agent posts a heartbeat
 *
 * Account isolation is enforced at the CP layer (every operator
 * method takes `callerAccountId`); the agent endpoints look up by
 * SHA-256 hash of the raw token, so a token leak is the only path
 * to another tenant's row. */

const nodeKindEnum = z.enum(["managed", "byo"]);

const enrollNodeSchema = z.object({
  label: z.string().min(1),
  region: z.string().optional(),
  host: z.string().optional(),
  sshUser: z.string().optional(),
  capacityInstances: z.number().int().min(1).max(256).optional(),
  kind: nodeKindEnum.optional(),
});

app.post("/v1/nodes", async (request, reply) => {
  const parsed = enrollNodeSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.message });
  }
  const result = await cp.enrollNode({
    accountId: resolveAccountId(request),
    ...parsed.data,
  });
  if ("error" in result) return reply.code(400).send(result);
  return reply.code(201).send(result);
});

app.get("/v1/nodes", async (request) => {
  return { nodes: await cp.listAccountNodes(resolveAccountId(request)) };
});

/** Per-account fleet summary (plan §5.5 — BYO-VPS lifecycle).
 *  Counts of nodes by status + the online aggregate capacity. Powers
 *  the Console `/nodes` summary header and `cantila nodes`'s top
 *  line. Account-scoped via `resolveAccountId`. */
app.get("/v1/nodes/summary", async (request) => {
  return cp.getNodeFleetSummary(resolveAccountId(request));
});

/** Dev/ops seam — force one heartbeat sweep. The same job runs every
 *  `NODE_HEARTBEAT_SWEEP_INTERVAL_MS` from `startBackgroundJobs`; this
 *  route exists so tests and ops can poke it without waiting. */
app.post("/v1/nodes/sweep", async () => {
  return cp.runNodeHeartbeatSweep();
});

app.get("/v1/nodes/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  const node = await cp.getNodeForAccount(resolveAccountId(request), id);
  if (!node) return reply.code(404).send({ error: "node not found" });
  return { node };
});

app.delete("/v1/nodes/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  const result = await cp.retireNode(resolveAccountId(request), id);
  if ("error" in result) return reply.code(404).send(result);
  return reply.code(200).send(result);
});

const completeNodeSchema = z.object({
  enrollmentToken: z.string().min(8),
  publicKeyFingerprint: z.string().min(8),
  capacityInstances: z.number().int().min(1).max(256).optional(),
});

app.post("/v1/nodes/complete", async (request, reply) => {
  const parsed = completeNodeSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.message });
  }
  const result = await cp.completeNodeEnrollment({
    rawToken: parsed.data.enrollmentToken,
    publicKeyFingerprint: parsed.data.publicKeyFingerprint,
    capacityInstances: parsed.data.capacityInstances,
  });
  if ("error" in result) return reply.code(401).send(result);
  return reply.code(200).send(result);
});

const nodeHeartbeatSchema = z.object({
  enrollmentToken: z.string().min(8),
  instances: z.number().int().min(0).optional(),
  loadPct: z.number().min(0).max(100).optional(),
});

app.post("/v1/nodes/heartbeat", async (request, reply) => {
  const parsed = nodeHeartbeatSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.message });
  }
  const result = await cp.recordNodeHeartbeat({
    rawToken: parsed.data.enrollmentToken,
    instances: parsed.data.instances,
    loadPct: parsed.data.loadPct,
  });
  if ("error" in result) return reply.code(401).send(result);
  return reply.code(200).send(result);
});

/* ----- A2P/10DLC carrier registration (plan §4.5) -----
 *
 * Brand + campaign records the operator submits to The Campaign
 * Registry. All routes are account-scoped via `resolveAccountId`.
 * Loose-JSON payload — the CP enforces required keys per kind, but
 * the route shape stays additive so the field set can grow without
 * a schema change. */

const A2P_STATUS_VALUES = [
  "draft",
  "submitted",
  "in_review",
  "approved",
  "rejected",
  "hold",
] as const;

const registerBrandSchema = z.object({
  name: z.string().min(1),
  payload: z.record(z.unknown()),
});

const registerCampaignSchema = z.object({
  name: z.string().min(1),
  brandRegistrationId: z.string().min(1),
  payload: z.record(z.unknown()),
});

const a2pStatusSchema = z.object({
  status: z.enum(A2P_STATUS_VALUES),
  providerRegistrationId: z.string().optional(),
  rejectionReason: z.string().optional(),
});

app.get("/v1/a2p/registrations", async (request) => {
  const q = (request.query ?? {}) as { kind?: string };
  const kind =
    q.kind === "brand" || q.kind === "campaign" ? q.kind : undefined;
  return {
    registrations: await cp.listA2pRegistrations(resolveAccountId(request), {
      kind,
    }),
  };
});

app.post("/v1/a2p/brands", async (request, reply) => {
  const parsed = registerBrandSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }
  const result = await cp.registerBrand({
    accountId: resolveAccountId(request),
    name: parsed.data.name,
    payload: parsed.data.payload,
  });
  if ("error" in result) return reply.code(400).send(result);
  return reply.code(201).send(result);
});

app.post("/v1/a2p/campaigns", async (request, reply) => {
  const parsed = registerCampaignSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }
  const result = await cp.registerCampaign({
    accountId: resolveAccountId(request),
    name: parsed.data.name,
    brandRegistrationId: parsed.data.brandRegistrationId,
    payload: parsed.data.payload,
  });
  if ("error" in result) {
    const code = result.error === "brand registration not found" ? 404 : 400;
    return reply.code(code).send(result);
  }
  return reply.code(201).send(result);
});

app.get("/v1/a2p/registrations/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  const registration = await cp.getA2pRegistration(id);
  if (!registration) {
    return reply.code(404).send({ error: "registration not found" });
  }
  if (registration.accountId !== resolveAccountId(request)) {
    return reply.code(404).send({ error: "registration not found" });
  }
  return registration;
});

app.patch("/v1/a2p/registrations/:id/status", async (request, reply) => {
  const { id } = request.params as { id: string };
  const parsed = a2pStatusSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }
  const result = await cp.setA2pRegistrationStatus(
    resolveAccountId(request),
    id,
    parsed.data.status,
    {
      providerRegistrationId: parsed.data.providerRegistrationId,
      rejectionReason: parsed.data.rejectionReason,
    },
  );
  if ("error" in result) {
    const code = result.error === "registration not found" ? 404 : 400;
    return reply.code(code).send(result);
  }
  return result;
});

/* ----- Cantila Data (plan §4.6) ----- */

// Account-wide list of every project's auto-wired managed database.
app.get("/v1/databases", async (request) => {
  return { databases: await cp.listAccountDatabases(resolveAccountId(request)) };
});

// Account-wide list of buckets.
app.get("/v1/storage/buckets", async (request) => {
  return { buckets: await cp.listBuckets(resolveAccountId(request)) };
});

// Create a bucket. The bucket's project must belong to the caller's account.
app.post("/v1/storage/buckets", async (request, reply) => {
  const parsed = createBucketSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }
  if (!(await assertProjectAccess(request, reply, parsed.data.projectId))) return;
  const result = await cp.createBucket(parsed.data);
  if ("error" in result) {
    const code = result.error === "project not found" ? 404 : 400;
    return reply.code(code).send({ error: result.error });
  }
  return reply.code(201).send(result);
});

// Delete a bucket — verify it belongs to a project the caller owns.
app.delete("/v1/storage/buckets/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  const buckets = await cp.listBuckets(resolveAccountId(request));
  const owned = buckets.some((b) => b.id === id);
  if (!owned) {
    // Either truly missing or owned by another account — same 404 from the
    // caller's perspective so we don't leak the existence of other accounts.
    return reply.code(404).send({ error: "bucket not found" });
  }
  const ok = await cp.deleteBucket(id);
  if (!ok) return reply.code(404).send({ error: "bucket not found" });
  return reply.code(204).send();
});

/* ----- hosted mailboxes (plan §4.4 — Cantila Mail) ----- */

const createHostedMailboxSchema = z.object({
  address: z.string().min(3),
  displayName: z.string().optional(),
  kind: z.enum(["personal", "shared"]).optional(),
  quotaMb: z.number().int().positive().optional(),
});

// Hosted mailboxes on one project.
app.get("/v1/projects/:id/mailboxes", async (request, reply) => {
  const { id } = request.params as { id: string };
  if (!(await assertProjectAccess(request, reply, id))) return;
  return { mailboxes: await cp.listHostedMailboxes(id) };
});

// Account-wide list of every project's hosted mailboxes.
app.get("/v1/mailboxes", async (request) => {
  return {
    mailboxes: await cp.listAccountHostedMailboxes(resolveAccountId(request)),
  };
});

// Create a hosted mailbox on a project.
app.post("/v1/projects/:id/mailboxes", async (request, reply) => {
  const { id } = request.params as { id: string };
  if (!(await assertProjectAccess(request, reply, id))) return;
  const parsed = createHostedMailboxSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }
  const result = await cp.createHostedMailbox({ projectId: id, ...parsed.data });
  if ("error" in result) {
    const code = result.error === "project not found" ? 404 : 400;
    return reply.code(code).send({ error: result.error });
  }
  return reply.code(201).send(result);
});

// Delete a hosted mailbox — scoped to the project the caller owns.
app.delete(
  "/v1/projects/:id/mailboxes/:mailboxId",
  async (request, reply) => {
    const { id, mailboxId } = request.params as {
      id: string;
      mailboxId: string;
    };
    if (!(await assertProjectAccess(request, reply, id))) return;
    const ok = await cp.deleteHostedMailbox(id, mailboxId);
    if (!ok) return reply.code(404).send({ error: "mailbox not found" });
    return reply.code(204).send();
  },
);

/* ----- mail aliases (plan §4.4 — routing rules) -----
 *
 * CRUD over `MailAlias` — the rule a future MTA will honor. Per-project
 * routes are scope-gated by `assertProjectAccess`; the account-wide
 * `GET /v1/mail/aliases` mirrors `GET /v1/mailboxes`.
 */

const createMailAliasSchema = z.object({
  address: z.string().min(3),
  target: z.string().min(1),
  kind: z.enum(["alias", "forward", "catch-all", "parse"]).optional(),
  description: z.string().optional(),
});

const updateMailAliasSchema = z.object({
  target: z.string().min(1).optional(),
  kind: z.enum(["alias", "forward", "catch-all", "parse"]).optional(),
  active: z.boolean().optional(),
  description: z.string().optional(),
});

// Aliases on one project.
app.get("/v1/projects/:id/aliases", async (request, reply) => {
  const { id } = request.params as { id: string };
  if (!(await assertProjectAccess(request, reply, id))) return;
  return { aliases: await cp.listMailAliases(id) };
});

// Account-wide list of every project's aliases.
app.get("/v1/mail/aliases", async (request) => {
  return {
    aliases: await cp.listAccountMailAliases(resolveAccountId(request)),
  };
});

// Create an alias on a project.
app.post("/v1/projects/:id/aliases", async (request, reply) => {
  const { id } = request.params as { id: string };
  if (!(await assertProjectAccess(request, reply, id))) return;
  const parsed = createMailAliasSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }
  const result = await cp.createMailAlias({ projectId: id, ...parsed.data });
  if ("error" in result) {
    const code = result.error === "project not found" ? 404 : 400;
    return reply.code(code).send({ error: result.error });
  }
  return reply.code(201).send(result);
});

// Patch an alias — target / kind / active / description. Address is
// immutable; rename via delete + recreate.
app.patch(
  "/v1/projects/:id/aliases/:aliasId",
  async (request, reply) => {
    const { id, aliasId } = request.params as {
      id: string;
      aliasId: string;
    };
    if (!(await assertProjectAccess(request, reply, id))) return;
    const parsed = updateMailAliasSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const result = await cp.updateMailAlias(id, aliasId, parsed.data);
    if ("error" in result) {
      const code = result.error === "alias not found" ? 404 : 400;
      return reply.code(code).send({ error: result.error });
    }
    return result;
  },
);

// Delete an alias — scoped to the project the caller owns.
app.delete(
  "/v1/projects/:id/aliases/:aliasId",
  async (request, reply) => {
    const { id, aliasId } = request.params as {
      id: string;
      aliasId: string;
    };
    if (!(await assertProjectAccess(request, reply, id))) return;
    const ok = await cp.deleteMailAlias(id, aliasId);
    if (!ok) return reply.code(404).send({ error: "alias not found" });
    return reply.code(204).send();
  },
);

/* ----- mail sending-IP pools (plan §4.4 — IP-pool rotation) -----
 *
 * Account-scoped CRUD over `MailIpPool`. The future MTA reads from
 * this table to decide which sending IP an outbound message rides
 * through. The CP enforces a single-default pool per account at write
 * time (see `createMailIpPool` / `updateMailIpPool`). */

const POOL_KIND_VALUES = [
  "warmup",
  "main",
  "transactional",
  "marketing",
] as const;

const createMailIpPoolSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(POOL_KIND_VALUES).optional(),
  ips: z.array(z.string()).optional(),
  description: z.string().optional(),
  setDefault: z.boolean().optional(),
});

const updateMailIpPoolSchema = z.object({
  name: z.string().min(1).optional(),
  kind: z.enum(POOL_KIND_VALUES).optional(),
  ips: z.array(z.string()).optional(),
  reputation: z.number().int().min(0).max(100).optional(),
  active: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  description: z.string().optional(),
});

app.get("/v1/mail/pools", async (request) => {
  return { pools: await cp.listMailIpPools(resolveAccountId(request)) };
});

app.post("/v1/mail/pools", async (request, reply) => {
  const parsed = createMailIpPoolSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }
  const result = await cp.createMailIpPool({
    accountId: resolveAccountId(request),
    ...parsed.data,
  });
  if ("error" in result) return reply.code(400).send(result);
  return reply.code(201).send(result);
});

app.get("/v1/mail/pools/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  const pool = await cp.getMailIpPool(id);
  if (!pool || pool.accountId !== resolveAccountId(request)) {
    return reply.code(404).send({ error: "pool not found" });
  }
  return pool;
});

app.patch("/v1/mail/pools/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  const parsed = updateMailIpPoolSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }
  const result = await cp.updateMailIpPool(
    resolveAccountId(request),
    id,
    parsed.data,
  );
  if ("error" in result) {
    const code = result.error === "pool not found" ? 404 : 400;
    return reply.code(code).send(result);
  }
  return result;
});

app.delete("/v1/mail/pools/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  const ok = await cp.deleteMailIpPool(resolveAccountId(request), id);
  if (!ok) return reply.code(404).send({ error: "pool not found" });
  return reply.code(204).send();
});

/* ----- per-user auth: login, SSO, session (plan §5.4) -----
 *
 *  Additive to the scoped-API-key model — these routes are exempt from
 *  the API-key enforcement hook (you can't authenticate to obtain a
 *  credential with a credential). Sessions gate the Console; keys gate
 *  the API. Nothing here touches the existing request-auth path.
 * ----- */

const loginSchema = z.object({
  email: z.string().min(3),
  password: z.string().min(1),
  name: z.string().optional(),
});

const registerSchema = z.object({
  email: z.string().min(3),
  password: z.string().min(8),
  name: z.string().optional(),
});

const ssoStartSchema = z.object({
  provider: z.enum(["google", "github"]),
  redirectUri: z.string().url(),
});

const ssoLoginSchema = z.object({
  provider: z.enum(["google", "github"]),
  code: z.string().optional(),
  email: z.string().optional(),
  codeVerifier: z.string().optional(),
  // OAuth state — binds the callback to the server-side login flight so the
  // control plane (not just the Console) enforces single-use CSRF protection.
  state: z.string().optional(),
});

const sessionTokenSchema = z.object({
  token: z.string().min(1),
});

// Email + password sign-in. Unknown emails are rejected (no auto-register)
// — new users sign up explicitly via /v1/auth/register. See
// ControlPlane.loginWithPassword.
app.post("/v1/auth/login", async (request, reply) => {
  if (!authRateLimit(request.ip, Date.now())) {
    return reply.code(429).send({ error: "too many attempts, slow down" });
  }
  const parsed = loginSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }
  const result = await cp.loginWithPassword(parsed.data);
  if ("error" in result) return reply.code(401).send({ error: result.error });
  return reply.code(200).send(result);
});

// Explicit registration — fails when the email is already taken.
app.post("/v1/auth/register", async (request, reply) => {
  if (!authRateLimit(request.ip, Date.now())) {
    return reply.code(429).send({ error: "too many attempts, slow down" });
  }
  const parsed = registerSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }
  const result = await cp.registerUser(parsed.data);
  if ("error" in result) return reply.code(400).send({ error: result.error });
  return reply.code(201).send(result);
});

// Self-service password change for the currently signed-in user (plan
// §5.4). Session-only — an API key can't rotate the human's password,
// only the human can. Verifies the current password before writing the
// new hash.
app.post("/v1/account/me/change-password", async (request, reply) => {
  const session = getSessionAuth(request);
  if (!session) {
    return reply
      .code(401)
      .send({ error: "session required (Bearer cts_ token)" });
  }
  const body = (request.body ?? {}) as {
    currentPassword?: unknown;
    newPassword?: unknown;
  };
  if (
    typeof body.currentPassword !== "string" ||
    typeof body.newPassword !== "string"
  ) {
    return reply.code(400).send({
      error: "currentPassword and newPassword (string) required",
    });
  }
  const result = await cp.changePassword({
    userId: session.userId,
    currentPassword: body.currentPassword,
    newPassword: body.newPassword,
  });
  if ("error" in result) {
    return reply.code(400).send({ error: result.error });
  }
  return reply.code(200).send(result);
});

// Admin password reset — fills the gap until the real /forgot flow ships
// (deferred to once Cantila Mail can deliver reset emails). Gated by the
// `CANTILA_ADMIN_TOKEN` env var; returns 503 when the token is not set so
// dev environments can't accidentally hand out resets.
app.post("/v1/auth/admin/reset-password", async (request, reply) => {
  // Primary path (super-user management, slice 1): a superadmin session.
  const decision = authorizeSuperuser(getSessionAuth(request), ["superadmin"]);
  let actorUserId: string | null = decision.ok ? decision.session.userId : null;

  if (!decision.ok) {
    // Deprecated fallback — the shared CANTILA_ADMIN_TOKEN. Kept so prod
    // tooling does not break mid-migration; logs a deprecation warning.
    // TODO(slice-2): remove this fallback once no caller relies on it.
    const adminToken = process.env.CANTILA_ADMIN_TOKEN;
    const provided = request.headers["x-cantila-admin-token"];
    if (
      adminToken &&
      typeof provided === "string" &&
      provided === adminToken
    ) {
      request.log.warn(
        "DEPRECATED: x-cantila-admin-token used for admin reset — migrate to a superadmin session",
      );
    } else {
      // Neither a superadmin session nor a valid token → mirror the guard's
      // decision (401 when no session at all, 403 otherwise).
      return reply.code(decision.status).send({ error: decision.error });
    }
  }

  const body = (request.body ?? {}) as { email?: unknown; newPassword?: unknown };
  if (typeof body.email !== "string" || typeof body.newPassword !== "string") {
    return reply.code(400).send({ error: "email and newPassword (string) required" });
  }
  try {
    const result = await cp.adminResetPassword({
      email: body.email,
      newPassword: body.newPassword,
    });
    if (!result) {
      return reply.code(404).send({ error: "no user with that email" });
    }
    await cp.recordAdminAudit({
      actorUserId: actorUserId ?? "token:CANTILA_ADMIN_TOKEN",
      action: "admin.user.reset_password",
      targetType: "user",
      metadata: { email: body.email, viaToken: actorUserId === null },
      ip: request.ip,
    });
    return reply.code(200).send(result);
  } catch (err) {
    return reply
      .code(500)
      .send({ error: err instanceof Error ? err.message : "reset failed" });
  }
});

// Real /forgot flow (plan §5.4 / v1.18): mint a one-shot password-reset
// token, hand it to the MailProvider. Always returns `{ ok: true }` so
// the caller can't enumerate the user table. When the bundled stub MTA
// is wired (no live mail yet), the response also carries `debugLink` so
// the developer / smoke test can exercise the end-to-end flow without an
// inbox; the production live-MTA path never returns the link.
app.post("/v1/auth/forgot", async (request, reply) => {
  const body = (request.body ?? {}) as { email?: unknown };
  if (typeof body.email !== "string") {
    return reply.code(400).send({ error: "email (string) required" });
  }
  const result = await cp.requestPasswordReset({ email: body.email });
  return reply.code(200).send(result);
});

// Complete the /forgot flow — verify the token, swap the password.
// The Console renders `/reset/[token]` and POSTs here. We collapse all
// error shapes into a uniform 400 so a wrong-token / expired-token /
// weak-password response doesn't leak which one a guess hit.
app.post("/v1/auth/reset-password", async (request, reply) => {
  const body = (request.body ?? {}) as {
    token?: unknown;
    newPassword?: unknown;
  };
  if (typeof body.token !== "string" || typeof body.newPassword !== "string") {
    return reply
      .code(400)
      .send({ error: "token and newPassword (string) required" });
  }
  const result = await cp.completePasswordReset({
    token: body.token,
    newPassword: body.newPassword,
  });
  if ("error" in result) {
    return reply.code(400).send({ error: result.error });
  }
  return reply.code(200).send(result);
});

// Email verification — request a fresh verify link for the currently
// signed-in user. Session-gated because the endpoint touches a known
// account; the click-through completion endpoint is exempt (the link
// itself is the credential).
app.post("/v1/auth/verify-email/request", async (request, reply) => {
  const session = await getSessionAuth(request);
  if (!session) {
    return reply
      .code(401)
      .send({ error: "session required (Bearer cts_ token)" });
  }
  const result = await cp.requestEmailVerification({ userId: session.userId });
  if ("error" in result) {
    return reply.code(400).send({ error: result.error });
  }
  return reply.code(200).send(result);
});

// Complete the email-verify flow — exempt from auth so the click-through
// works from a signed-out device.
app.post("/v1/auth/verify-email/confirm", async (request, reply) => {
  const body = (request.body ?? {}) as { token?: unknown };
  if (typeof body.token !== "string") {
    return reply.code(400).send({ error: "token (string) required" });
  }
  const result = await cp.completeEmailVerification({ token: body.token });
  if ("error" in result) {
    return reply.code(400).send({ error: result.error });
  }
  return reply.code(200).send(result);
});

// Which SSO providers are wired (real Google/GitHub vs the bundled stub)
// — the Console login/signup pages render a button per provider.
app.get("/v1/auth/sso/info", async () => {
  return cp.ssoInfo();
});

// Begin an SSO login — returns the IdP authorize URL.
app.post("/v1/auth/sso/start", async (request, reply) => {
  const parsed = ssoStartSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }
  return reply
    .code(200)
    .send(cp.beginSsoLogin(parsed.data.provider, parsed.data.redirectUri));
});

// Complete an SSO login from the IdP callback.
app.post("/v1/auth/sso/login", async (request, reply) => {
  if (!authRateLimit(request.ip, Date.now())) {
    return reply.code(429).send({ error: "too many attempts, slow down" });
  }
  const parsed = ssoLoginSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }
  const result = await cp.loginWithSso(parsed.data);
  if ("error" in result) return reply.code(401).send({ error: result.error });
  return reply.code(200).send(result);
});

// Resolve a session token → the signed-in user.
app.post("/v1/auth/session", async (request, reply) => {
  const parsed = sessionTokenSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }
  const resolved = await cp.resolveSession(parsed.data.token);
  if (!resolved) return reply.code(200).send({ authenticated: false });
  return reply.code(200).send({ authenticated: true, ...resolved });
});

// Invalidate a session.
app.post("/v1/auth/logout", async (request, reply) => {
  const parsed = sessionTokenSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }
  await cp.logout(parsed.data.token);
  return reply.code(204).send();
});

/* ----- registrar (plan §4.7 — Cantila Domains) ----- */

// Search the catalog. Pass ?q=foo to suggest TLDs, or ?q=foo.com for an
// exact-hostname quote. ?tlds=com,dev,io filters the suggestion list.
app.get("/v1/domains/search", async (request) => {
  const parsed = searchDomainsSchema.safeParse(request.query);
  if (!parsed.success) {
    return { results: [], error: parsed.error.flatten() };
  }
  const tlds = parsed.data.tlds
    ? parsed.data.tlds.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;
  const results = await cp.searchDomains({ label: parsed.data.q, tlds });
  return { results };
});

// Quote a single hostname.
app.get("/v1/domains/quote", async (request, reply) => {
  const q = request.query as { hostname?: string };
  if (!q.hostname) return reply.code(400).send({ error: "hostname required" });
  const result = await cp.quoteDomain(q.hostname);
  if ("error" in result) return reply.code(400).send({ error: result.error });
  return result;
});

// List the account's registrations.
app.get("/v1/domains/registrations", async (request) => {
  return {
    registrations: await cp.listRegistrations(resolveAccountId(request)),
  };
});

// Register a domain. accountId on the body is overridden by the caller's
// account, and the optional projectId must belong to that account.
app.post("/v1/domains/registrations", async (request, reply) => {
  const parsed = registerDomainSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }
  if (
    parsed.data.projectId &&
    !(await assertProjectAccess(request, reply, parsed.data.projectId))
  ) {
    return;
  }
  const result = await cp.registerDomain({
    ...parsed.data,
    accountId: resolveAccountId(request),
  });
  if ("error" in result) {
    const code = result.error === "project not found" ? 404 : 400;
    return reply.code(code).send({ error: result.error });
  }
  return reply.code(201).send(result);
});

// Attach a previously-registered domain to a project. The target project
// must be owned by the caller; cross-account attachment is rejected.
app.post(
  "/v1/domains/registrations/:id/attach",
  async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = attachRegistrationSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    if (!(await assertProjectAccess(request, reply, parsed.data.projectId))) {
      return;
    }
    const result = await cp.attachRegistration(id, parsed.data.projectId);
    if ("error" in result) {
      const code = result.error.includes("not found") ? 404 : 400;
      return reply.code(code).send({ error: result.error });
    }
    return reply.code(201).send(result);
  },
);

// Aggregate metrics for the account dashboard (plan §4.8).
app.get("/v1/metrics/account", async (request) => {
  return cp.getAccountMetrics(resolveAccountId(request));
});

/* ----- Cantila Automations + Connections — plan §4.10 + §4.11 ----- */

registerAutomationRoutes(app, {
  cp,
  store,
  registry: engineRegistry,
  resolveAccountId,
});

registerConnectionRoutes(app, {
  store,
  cp,
  resolveAccountId,
  writeSecret: writeConnectionSecret,
});

/* ----- Cantila Agents — plan §4.9 ----- */

// Brain snapshot: memory, pending proposals, recent actions. ?fresh=1 forces
// a synchronous tick first so the response always carries this-second state.
app.get("/v1/agents/status", async (request) => {
  const q = request.query as { fresh?: string };
  if (q.fresh === "1") await cp.tickAgents();
  return cp.agentsStatus();
});

// Force one tick — useful when a human just made a change and wants the
// brain to react immediately.
app.post("/v1/agents/tick", async () => {
  await cp.tickAgents();
  return cp.agentsStatus();
});

app.post("/v1/agents/pause", async () => {
  cp.pauseAgents();
  return { paused: true };
});

app.post("/v1/agents/resume", async () => {
  cp.resumeAgents();
  return { paused: false };
});

app.get("/v1/agents/org", async () => {
  const { buildAgentOrg } = await import("./fleet/org");
  return buildAgentOrg(projectOrchestrator.sessionRegistry);
});

/* ----- Owner-queued agent proposals (admin-only, in-memory v1).
 *  These let the founder add new agent ideas from the Console chat;
 *  they appear as dimmed satellites on the agents canvas until a real
 *  TS class lands under cantila-control-plane/src/agents/. Storage is
 *  in-memory here on purpose — promoting to a Prisma model is a
 *  follow-up so the agent registry can survive restarts and gain
 *  status transitions (proposed → implemented → rejected). ----- */

interface AgentProposalRow {
  id: string;
  name: string;
  blurb: string;
  scope?: string;
  status: "proposed" | "implemented" | "rejected";
  createdByEmail: string;
  createdAt: string;
}

const agentProposals = new Map<string, AgentProposalRow>();

const OWNER_EMAIL = (process.env.CANTILA_OWNER_EMAIL ?? "jjcantila0728@gmail.com")
  .trim()
  .toLowerCase();

async function sessionEmail(req: FastifyRequest): Promise<string | null> {
  const session = getSessionAuth(req);
  if (!session) return null;
  const user = await cp.getAuthUser(session.userId);
  return user?.email?.trim().toLowerCase() ?? null;
}

const createAgentProposalSchema = z.object({
  name: z.string().min(1).max(80),
  blurb: z.string().min(1).max(280),
  scope: z.string().max(80).optional(),
});

app.post("/v1/agents/proposals", async (request, reply) => {
  const email = await sessionEmail(request);
  if (email !== OWNER_EMAIL) {
    return reply.code(403).send({ error: "owner only" });
  }
  const parsed = createAgentProposalSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.message });
  }
  const id = `apl_${Math.random().toString(36).slice(2, 12)}`;
  const row: AgentProposalRow = {
    id,
    name: parsed.data.name,
    blurb: parsed.data.blurb,
    scope: parsed.data.scope,
    status: "proposed",
    createdByEmail: email,
    createdAt: new Date().toISOString(),
  };
  agentProposals.set(id, row);
  return row;
});

app.get("/v1/agents/proposals", async () => {
  return {
    proposals: Array.from(agentProposals.values()).sort((a, b) =>
      a.createdAt < b.createdAt ? 1 : -1,
    ),
  };
});

/* ----- SeoAgent — plan §4.9 extension (10th brain swarm agent).
 *  Filters the brain snapshot to just the SEO slice so the Console
 *  can render a dedicated SEO panel without paging through every
 *  other agent's actions. Includes the active fixer mode so the
 *  operator can see at a glance whether auto-apply is wired up. ----- */
app.get("/v1/seo/audit", async (request) => {
  const q = request.query as { fresh?: string };
  if (q.fresh === "1") await cp.tickAgents();
  const snap = cp.agentsStatus();
  return {
    at: snap.at,
    pendingProposals: snap.pendingProposals.filter((p) => p.agent === "seo"),
    recentActions: snap.recentActions.filter((a) => a.agent === "seo"),
    learnings: snap.learnings.filter((l) => l.agent === "seo"),
    stats: snap.agentStats.seo,
    fixer: {
      autoApply: config.seoAgentAutoApply,
      live:
        config.seoAgentAutoApply &&
        Boolean(config.githubToken) &&
        Boolean(config.githubRepo),
      repo: config.githubRepo || null,
    },
    origin: config.seoOrigin,
  };
});

// Dev-only debug seam — push a synthetic action into the brain's journal
// so the learning loop can be exercised end-to-end. Disabled in
// production. Used by the learning-loop smoke test.
const injectActionSchema = z.object({
  agent: z.enum([
    "uptime",
    "deploy",
    "cost",
    "scale",
    "security",
    "capacity",
    "mail",
    "sms",
    "automation",
    "seo",
  ]),
  kind: z.string().min(1),
  outcome: z.enum(["ok", "failed"]),
  verified: z.enum(["n/a", "pending", "ok", "failed"]).optional(),
  title: z.string().optional(),
  detail: z.string().optional(),
  count: z.number().int().min(1).max(50).default(1),
});
app.post("/v1/agents/_test/inject-action", async (request, reply) => {
  if (config.nodeEnv === "production") {
    return reply.code(404).send({ error: "not found" });
  }
  const parsed = injectActionSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.message });
  }
  const { count, ...rest } = parsed.data;
  for (let i = 0; i < count; i++) cp._injectAgentAction(rest);
  return { ok: true, injected: count };
});

// Dev-only — simulate a process restart for the brain's action journal.
// Wipes the in-memory ring then rehydrates from the durable store. The
// snapshot's learnings should be identical before and after.
app.post("/v1/agents/_test/reload", async (request, reply) => {
  if (config.nodeEnv === "production") {
    return reply.code(404).send({ error: "not found" });
  }
  await cp._reloadAgentJournalFromDurable();
  return { ok: true };
});

/* ----- Remote MCP server (plan §4.3.2 — "Cantila publishes a remote MCP
 *  server. A user adds it once to Claude. From then on, any app built
 *  inside Claude can be deployed to Cantila by simply asking.")
 *
 *  Wire format is JSON-RPC 2.0, the same the stdio transport speaks. A
 *  client `POST`s one message (initialize / tools/list / tools/call) and
 *  gets one response — or 204 for notifications. `GET /v1/mcp` returns
 *  metadata (server info, protocol version, tool catalog) for operators
 *  inspecting the endpoint without speaking JSON-RPC.
 * ----- */

app.get("/v1/mcp", async () => {
  return mcpServer.describe();
});

app.post("/v1/mcp", async (request, reply) => {
  const body = request.body as
    | { id?: number | string; method?: string; params?: unknown }
    | null
    | undefined;
  if (!body || typeof body !== "object") {
    return reply.code(400).send({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "invalid request" },
    });
  }
  // Thread the authenticated principal so every tool is confined to the
  // caller's account (tenant isolation). For a remote HTTP caller this is
  // always set when CANTILA_REQUIRE_AUTH is on (the onRequest gate above
  // already rejected anonymous calls); `null` falls back to legacy
  // owner-default behavior only when auth is off.
  const mcpActAs = getActAs(request);
  const mcpKey = getApiKey(request);
  const mcpSession = getSessionAuth(request);
  const mcpAccountId =
    mcpActAs ?? mcpKey?.accountId ?? mcpSession?.accountId ?? null;
  const response = await mcpServer.handleRpc(body, {
    accountId: mcpAccountId,
  });
  if (!response) {
    // notification — no reply body, just an empty 204
    return reply.code(204).send();
  }
  return reply.code(200).send(response);
});

// Fleet capacity rollup (plan §5.2 + §15.1 — CapacityAgent surface). The
// same data CapacityAgent ticks on; exposed here so the operator can see
// the picture the agent is reasoning over. Account-scoped — passing
// `?accountId=` (or relying on the auth-resolved account) returns only
// the caller's tenant's instances.
app.get("/v1/capacity", async (request) => {
  return cp.getFleetCapacity(resolveAccountId(request));
});

// Activity feed — newest first. ?limit=N caps the response (default 100).
app.get("/v1/activity", async (request) => {
  const q = request.query as { limit?: string };
  const limit = q.limit ? Math.max(1, Math.min(500, Number(q.limit))) : 100;
  return {
    events: await cp.listEvents(resolveAccountId(request), { limit }),
  };
});

// Billing summary (plan §8) — plan tier, usage meters, recent charges.
app.get("/v1/billing/summary", async (request) => {
  return cp.getBillingSummary(resolveAccountId(request));
});

// Real Stripe invoice history (plan §8.5 — Phase B) — finalised invoices
// from `stripe.invoices.list`, each with Stripe's hosted-page + PDF links.
// A GET read, account-scoped via `resolveAccountId` like the summary.
app.get("/v1/billing/invoices", async (request) => {
  const invoices = await cp.listBillingInvoices(resolveAccountId(request), {
    limit: 24,
  });
  return { invoices };
});

/* ----- AI adapter info (plan §5.6 / §15.1) ----- */

/** Which AI analyser is wired (rule-based stub vs an LLM-backed one).
 *  The Console can render a "(stub)" badge on the troubleshoot panel
 *  when `live: false`. */
app.get("/v1/ai/info", async () => {
  return cp.aiInfo();
});

/** Which MailProvider is wired — stub today, Mailcow when the
 *  carrier env vars are set. Plan §4.4 / §17.2. */
app.get("/v1/mail/info", async () => {
  return cp.mailInfo();
});

/* ----- Stripe rail (plan §8 / §15.1) ----- */

/** Which Stripe adapter is wired (stub vs live). Mirrors `/v1/ai/info`
 *  so the Console can render a "(stub)" badge on the Billing page when
 *  STRIPE_SECRET_KEY isn't set. Also carries the public marketing
 *  pricing catalog (plan §4.7 / §8.2) so the apex /pricing page reads
 *  from the same source as the control plane's `TLD_CATALOG`. */
app.get("/v1/billing/info", async () => {
  const catalog = cp.getPublicBillingCatalog();
  return {
    label: stripe.label,
    live: stripe.live,
    // Publishable key (`pk_…`) — safe to expose; the Console uses it to
    // mount embedded Checkout (plan §8.5 — Phase D). Absent on the stub.
    publishableKey: stripe.publishableKey,
    // Marketing catalogs — both shapes the apex /pricing page needs.
    tldPrices: catalog.tldPrices,
    planTiers: catalog.planTiers,
  };
});

const checkoutSessionSchema = z.object({
  tier: z.enum(["hobby", "starter", "pro", "agency"]),
  // `hosted` → a redirect URL; `embedded` → an in-page client secret
  // (plan §8.5 — Phase D).
  uiMode: z.enum(["hosted", "embedded"]).default("hosted"),
  successUrl: z
    .string()
    .url()
    .default("https://app.cantila.cloud/billing?checkout=success"),
  cancelUrl: z
    .string()
    .url()
    .default("https://app.cantila.cloud/billing?checkout=cancelled"),
  returnUrl: z
    .string()
    .url()
    .default("https://app.cantila.cloud/billing?checkout=success"),
});

/** Create a hosted checkout session for upgrading the caller's account
 *  to a higher tier. Returns `{url}` — Console / CLI redirects the
 *  buyer to it; the Stripe webhook flips the plan once payment lands. */
app.post("/v1/billing/checkout-session", async (request, reply) => {
  const accountId = requireBillingPrincipal(request, reply);
  if (accountId === null) return reply;
  const parsed = checkoutSessionSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.message });
  }
  const result = await cp.createCheckoutSession({
    accountId,
    tier: parsed.data.tier,
    uiMode: parsed.data.uiMode,
    successUrl: parsed.data.successUrl,
    cancelUrl: parsed.data.cancelUrl,
    returnUrl: parsed.data.returnUrl,
  });
  if ("error" in result) return reply.code(400).send(result);
  return reply.code(201).send(result);
});

const billingPortalSessionSchema = z.object({
  returnUrl: z.string().url().default("https://app.cantila.cloud/billing"),
});

/** Create a Stripe billing-portal session for the caller's account — the
 *  hosted page where they manage payment method, plan and invoice
 *  history. Returns `{url}`; the Console / CLI redirects the customer. */
app.post("/v1/billing/portal-session", async (request, reply) => {
  const accountId = requireBillingPrincipal(request, reply);
  if (accountId === null) return reply;
  const parsed = billingPortalSessionSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.message });
  }
  const result = await cp.createBillingPortalSession({
    accountId,
    returnUrl: parsed.data.returnUrl,
  });
  if ("error" in result) return reply.code(400).send(result);
  return reply.code(201).send(result);
});

/* ----- mid-period proration (plan §8 / §15.2 — plan changes) ----- */

const planChangeSchema = z.object({
  tier: z.enum(["hobby", "starter", "pro", "agency"]),
  prorationBehavior: z
    .enum(["create_prorations", "always_invoice", "none"])
    .optional(),
});

/** Preview the proration for a mid-period plan change — what switching
 *  to `tier` costs (or credits) right now, without committing it. */
app.post("/v1/billing/plan-change/preview", async (request, reply) => {
  const accountId = requireBillingPrincipal(request, reply);
  if (accountId === null) return reply;
  const parsed = planChangeSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.message });
  }
  const result = await cp.previewPlanChange({
    accountId,
    toTier: parsed.data.tier,
  });
  if ("error" in result) return reply.code(400).send(result);
  return reply.code(200).send(result);
});

/** Commit a mid-period plan change with proration. `prorationBehavior`
 *  defaults to `create_prorations` (the proration rolls onto the next
 *  invoice). The owning account is moved onto the new tier on success. */
app.post("/v1/billing/plan-change", async (request, reply) => {
  const accountId = requireBillingPrincipal(request, reply);
  if (accountId === null) return reply;
  const parsed = planChangeSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.message });
  }
  const result = await cp.changePlan({
    accountId,
    toTier: parsed.data.tier,
    prorationBehavior: parsed.data.prorationBehavior,
  });
  if ("error" in result) return reply.code(400).send(result);
  return reply.code(200).send(result);
});

/** Stripe webhook receiver. The raw body is needed for signature
 *  verification — we already capture it for git webhooks (same
 *  reason). Always returns 200 once parsed so Stripe doesn't retry on
 *  events for accounts we don't know about. Signature failures land
 *  as 400 so the operator notices a misconfigured webhook secret. */
app.post("/v1/stripe/webhook", async (request, reply) => {
  const signature =
    typeof request.headers["stripe-signature"] === "string"
      ? (request.headers["stripe-signature"] as string)
      : undefined;
  const result = await cp.handleStripeWebhook({
    rawBody: rawBodyOf(request),
    signature,
  });
  if ("error" in result) return reply.code(result.code).send(result);
  return reply.code(200).send(result);
});

/* ----- dunning (plan §8 / §15.2 — failed-payment handling) ----- */

/** Billing-health readout for the caller's account — billing status,
 *  dunning attempts, the grace clock, and the rendered dunning emails.
 *  Powers the Console billing banner and `cantila billing dunning`. */
app.get("/v1/billing/dunning", async (request) => {
  return cp.getDunningStatus(resolveAccountId(request));
});

/** Run the dunning grace-expiry sweep on demand — escalates `past_due`
 *  accounts past their grace window to `suspended`. The same sweep runs
 *  on a timer; this is for ops / cron. */
app.post("/v1/billing/dunning/sweep", async () => {
  return cp.runDunningSweep();
});

const dunningTestEventSchema = z.object({
  accountId: z.string().min(1),
  kind: z.enum(["failed", "succeeded", "grace-expiry"]),
});

/** Dev/test seam — drive the dunning state machine without a real
 *  Stripe webhook. 404 in production, mirroring the agent test seams. */
app.post("/v1/billing/_test/payment-event", async (request, reply) => {
  if (config.nodeEnv === "production") {
    return reply.code(404).send({ error: "not found" });
  }
  const parsed = dunningTestEventSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.message });
  }
  const result = await cp._simulateDunningEvent(
    parsed.data.accountId,
    parsed.data.kind,
  );
  if ("error" in result) return reply.code(404).send(result);
  return reply.code(200).send(result);
});

// Cost optimisation report (plan §5.6 — AI cost optimiser).
app.get("/v1/cost/optimise", async (request) => {
  return cp.getCostOptimisation(resolveAccountId(request));
});

// Monitoring (plan §5.3) — uptime monitors + active alerts + summary.
// ?fresh=1 forces a sweep right now (slower but the snapshot is current to
// the millisecond). Without it, the snapshot is whatever the periodic
// background sweep last produced.
app.get("/v1/monitoring", async (request) => {
  const q = request.query as { fresh?: string };
  if (q.fresh === "1") await cp.refreshMonitoring();
  return cp.getMonitoring(resolveAccountId(request));
});

/* ----- team (plan §5.5) ----- */

app.get("/v1/team/members", async (request) => {
  return { members: await cp.listMembers(resolveAccountId(request)) };
});

app.post("/v1/team/members", async (request, reply) => {
  const parsed = addMemberSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }
  const result = await cp.addMember({
    ...parsed.data,
    accountId: resolveAccountId(request),
  });
  if ("error" in result) return reply.code(400).send({ error: result.error });
  return reply.code(201).send(result);
});

app.patch("/v1/team/members/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  const parsed = updateMemberRoleSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }
  const accountId = resolveAccountId(request);
  // Membership rows are looked up by id but ownership matters: a caller
  // for account A must not be able to mutate a member of account B.
  const members = await cp.listMembers(accountId);
  if (!members.some((m) => m.id === id)) {
    return reply.code(404).send({ error: "member not found" });
  }
  const result = await cp.updateMemberRole(accountId, id, parsed.data.role);
  if ("error" in result) {
    return reply.code(404).send({ error: result.error });
  }
  return result;
});

app.delete("/v1/team/members/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  const accountId = resolveAccountId(request);
  const members = await cp.listMembers(accountId);
  if (!members.some((m) => m.id === id)) {
    return reply.code(404).send({ error: "member not found" });
  }
  const ok = await cp.removeMember(accountId, id);
  if (!ok) return reply.code(404).send({ error: "member not found" });
  return reply.code(204).send();
});

/* ----- invites (plan §5.4 — per-user invite flow) -----
 *
 * Two of these routes are public — the lookup-by-token reads the invite
 * for the accept page, and the accept POST takes the token in the body.
 * They are exempt from the API-key/session auth gate in the onRequest
 * hook above; the token itself is the credential. The three management
 * routes (list / create / revoke) require a real principal and scope
 * to the caller's account via `resolveAccountId`. */

app.get("/v1/invites", async (request) => {
  return { invites: await cp.listInvites(resolveAccountId(request)) };
});

app.post("/v1/invites", async (request, reply) => {
  const parsed = createInviteSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }
  const accountId = resolveAccountId(request);
  // Best-effort attribution: pull the inviting user id off the session
  // if one is present. API-key callers leave it undefined.
  const session = (request as { session?: { userId: string } }).session;
  const result = await cp.createInvite({
    accountId,
    email: parsed.data.email,
    role: parsed.data.role,
    invitedByUserId: session?.userId,
  });
  if ("error" in result) return reply.code(400).send({ error: result.error });
  return reply.code(201).send(result);
});

app.delete("/v1/invites/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  const accountId = resolveAccountId(request);
  const result = await cp.revokeInvite(accountId, id);
  if ("error" in result) {
    const code = result.error === "invite not found" ? 404 : 400;
    return reply.code(code).send({ error: result.error });
  }
  return result;
});

app.get("/v1/invites/by-token/:token", async (request, reply) => {
  const { token } = request.params as { token: string };
  const result = await cp.lookupInviteByToken(token);
  if ("error" in result) return reply.code(404).send({ error: result.error });
  return result;
});

app.post("/v1/invites/accept", async (request, reply) => {
  const parsed = acceptInviteSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }
  const result = await cp.acceptInvite(parsed.data);
  if ("error" in result) return reply.code(400).send({ error: result.error });
  return reply.code(201).send(result);
});

/* ----- API keys (plan §5.4 — scoped API keys) ----- */

// Strip the on-disk hash from the wire payload — we never return it via HTTP.
function publicKey(k: import("./domain/types").ApiKey) {
  const { hash: _hash, ...safe } = k;
  return safe;
}

app.get("/v1/api-keys", async (request) => {
  const keys = await cp.listApiKeys(resolveAccountId(request));
  return { keys: keys.map(publicKey) };
});

app.post("/v1/api-keys", async (request, reply) => {
  const callerKey = getApiKey(request);

  // Bootstrap window: no caller key + no Account rows yet → the body must
  // describe the *account* being created, not just the key. We provision
  // the Account + first admin key atomically. After this call the window
  // closes and future POSTs follow the normal "add a key to your own
  // account" path below.
  if (!callerKey) {
    const accountCount = await cp.countAccounts();
    if (accountCount === 0) {
      const parsed = bootstrapAccountSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: parsed.error.flatten(),
          hint:
            "First call must include accountName + accountHandle to provision the tenant.",
        });
      }
      const result = await cp.bootstrapAccountAndKey(parsed.data);
      if ("error" in result) {
        return reply.code(400).send({ error: result.error });
      }
      return reply.code(201).send({
        account: result.account,
        key: publicKey(result.key),
        rawKey: result.rawKey,
      });
    }
  }

  const parsed = createApiKeySchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }
  // Past the bootstrap window the authenticated caller's account wins;
  // the body's `accountId` is ignored. This prevents an admin on account
  // A from minting keys for account B — to onboard a new tenant, the
  // operator must use `POST /v1/accounts` instead. When neither a caller
  // key nor a body accountId is present we resolve from the request
  // principal/session — `resolveAccountId` throws (→ 401) if there is none.
  const accountId =
    callerKey?.accountId ?? parsed.data.accountId ?? resolveAccountId(request);
  const result = await cp.createApiKey({ ...parsed.data, accountId });
  if ("error" in result) {
    return reply.code(400).send({ error: result.error });
  }
  return reply.code(201).send({
    key: publicKey(result.key),
    rawKey: result.rawKey, // shown exactly once to the caller
  });
});

/* ----- accounts (plan §5.4 — tenant onboarding) ----- */

// Read the caller's account. Authenticated callers see their own row;
// without auth the demo account record is returned if it exists.
app.get("/v1/accounts/me", async (request, reply) => {
  const accountId = resolveAccountId(request);
  const account = await cp.getAccount(accountId);
  if (!account) {
    return reply.code(404).send({ error: "account not found", accountId });
  }
  return account;
});

/* ----- white-label / reseller — sub-accounts (plan §5.5) ----- */

const createSubAccountSchema = z.object({
  name: z.string().min(1),
  handle: z.string().min(3).max(40),
  plan: z.enum(["hobby", "starter", "pro", "agency", "dedicated"]).optional(),
  keyName: z.string().min(1).optional(),
  keyScope: z.enum(["read", "deploy", "admin"]).optional(),
});

/** Mint a sub-account under the caller's parent (plan §5.5 — white-label).
 *  The caller's account must be on a reseller-eligible plan (agency /
 *  dedicated); see `cp.RESELLER_PLANS`. Returns the new account + its
 *  first admin key + the raw key (one-time reveal). */
app.post("/v1/accounts/sub", async (request, reply) => {
  const parentAccountId = resolveAccountId(request);
  const parsed = createSubAccountSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.message });
  }
  const result = await cp.createSubAccount({
    parentAccountId,
    ...parsed.data,
  });
  if ("error" in result) return reply.code(400).send(result);
  return reply.code(201).send({
    account: result.account,
    key: result.key,
    rawKey: result.rawKey, // shown exactly once
  });
});

/** List sub-accounts under the caller (plan §5.5). Returns `[]` for a
 *  top-level account with no children. */
app.get("/v1/accounts/sub", async (request) => {
  const parentAccountId = resolveAccountId(request);
  return { accounts: await cp.listSubAccounts(parentAccountId) };
});

/* ----- Per-account Anthropic API key (plan §4.3.1) ----- */

const setAnthropicKeySchema = z.object({
  apiKey: z.string().min(20),
});

/** Set / rotate the per-tenant Anthropic API key. Spend on AI analyses
 *  for this account is then billed to the tenant's Anthropic account,
 *  not Cantila's. The key is stored plaintext on the Account row today
 *  (production swap-in: KMS-backed envelope encryption). */
app.post("/v1/accounts/me/anthropic-key", async (request, reply) => {
  const accountId = resolveAccountId(request);
  const parsed = setAnthropicKeySchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.message });
  }
  const result = await cp.setAnthropicApiKey(accountId, parsed.data.apiKey);
  if (result && "error" in result) return reply.code(404).send(result);
  return reply.code(200).send(result);
});

/** Clear the per-tenant key — revert to the platform-default analyser. */
app.delete("/v1/accounts/me/anthropic-key", async (request, reply) => {
  const accountId = resolveAccountId(request);
  const result = await cp.clearAnthropicApiKey(accountId);
  if (result && "error" in result) return reply.code(404).send(result);
  return reply.code(200).send(result);
});

/* ----- White-label branding (plan §5.5).
 *
 *   Two routes for one operation: `/v1/accounts/me/branding` patches
 *   the active account (which itself respects X-Cantila-Act-As — so a
 *   parent acting as a sub-account hits this same path to edit that
 *   sub-account's branding); `/v1/accounts/:id/branding` is the
 *   explicit form for editing a NAMED child without flipping the
 *   act-as scope first. Both call into `cp.updateAccountBranding`
 *   which enforces `canActOnAccount` and validates colour / URL
 *   shape. Empty-string in any field clears that field.
 * ----- */

const brandingPatchSchema = z.object({
  brandPrimaryColor: z.string().max(7).optional(),
  brandAccentColor: z.string().max(7).optional(),
  brandLogoUrl: z.string().max(500).optional(),
  brandDisplayName: z.string().max(64).optional(),
});

app.patch("/v1/accounts/me/branding", async (request, reply) => {
  const parsed = brandingPatchSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }
  const targetAccountId = resolveAccountId(request);
  const callerAccountId = resolveActorAccountId(request);
  const result = await cp.updateAccountBranding({
    callerAccountId,
    targetAccountId,
    patch: parsed.data,
  });
  if ("error" in result) return reply.code(400).send(result);
  return result;
});

app.patch("/v1/accounts/:id/branding", async (request, reply) => {
  const { id: targetAccountId } = request.params as { id: string };
  const parsed = brandingPatchSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }
  const callerAccountId = resolveActorAccountId(request);
  const result = await cp.updateAccountBranding({
    callerAccountId,
    targetAccountId,
    patch: parsed.data,
  });
  if ("error" in result) return reply.code(403).send(result);
  return result;
});

/* ----- White-label billing-rollup (plan §5.5).
 *
 *   POST /v1/accounts/:id/billing-rollup       — enrol a sub-account
 *   DELETE /v1/accounts/:id/billing-rollup     — leave the rollup
 *
 *   Both gate at the ControlPlane layer on "caller is the parent",
 *   so a sub-account can't enrol another sub or take itself off the
 *   bill. The :id is the SUB-ACCOUNT to operate on; the caller's
 *   resolved account is the parent. (Act-as is intentionally
 *   ignored here — `resolveActorAccountId` returns the caller's true
 *   account so a parent can't accidentally enrol a sub onto a child
 *   account by having flipped their act-as scope first.)
 * ----- */
app.post("/v1/accounts/:id/billing-rollup", async (request, reply) => {
  const { id: targetAccountId } = request.params as { id: string };
  const callerAccountId = resolveActorAccountId(request);
  const result = await cp.enrollInBillingRollup({
    callerAccountId,
    targetAccountId,
  });
  if ("error" in result) return reply.code(400).send(result);
  return result;
});

app.delete("/v1/accounts/:id/billing-rollup", async (request, reply) => {
  const { id: targetAccountId } = request.params as { id: string };
  const callerAccountId = resolveActorAccountId(request);
  const result = await cp.leaveBillingRollup({
    callerAccountId,
    targetAccountId,
  });
  if ("error" in result) return reply.code(400).send(result);
  return result;
});

// Provision a new tenant. The auth-resolve + enforcement hooks handle
// "is the caller allowed to hit this URL":
//   - Bootstrap window (zero Account rows): unauthenticated POST allowed.
//   - Auth on, key present: hook lets it through; the scope guard below
//     enforces admin (so a deploy-scope key can't spawn sibling tenants).
//   - Auth on, no key, accounts exist: hook returns 401 before we run.
//   - Auth off: dev mode, no gate at all.
app.post("/v1/accounts", async (request, reply) => {
  const caller = getApiKey(request);
  if (caller && caller.scope !== "admin") {
    return reply
      .code(403)
      .send({ error: "creating accounts requires an admin-scope key" });
  }
  const parsed = bootstrapAccountSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }
  const result = await cp.bootstrapAccountAndKey(parsed.data);
  if ("error" in result) {
    return reply.code(400).send({ error: result.error });
  }
  return reply.code(201).send({
    account: result.account,
    key: publicKey(result.key),
    rawKey: result.rawKey, // shown exactly once
  });
});

app.delete("/v1/api-keys/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  // Pass the caller's accountId when authed so we can't drop a key
  // belonging to another account.
  const callerKey = getApiKey(request);
  const result = await cp.revokeApiKey(id, callerKey?.accountId);
  if ("error" in result) {
    const code = result.code === "not_found" ? 404 : 403;
    return reply.code(code).send({ error: result.error });
  }
  return reply.code(204).send();
});

// Identify the caller. Used by both the Console "who am I" panel and the
// CLI's `cantila whoami`. Reads the key the auth-resolve hook attached
// and joins it with the Account row so callers see their tenant name,
// handle and plan in a single response.
app.get("/v1/me", async (request) => {
  const key = getApiKey(request);
  if (!key) {
    // Session-only callers: surface the user row so the Console can
    // render verify-email banners + `Hi <name>` chrome (plan §5.4 /
    // v1.18). Same `authenticated: true` shape — the Console reads
    // `user?` defensively.
    const session = await getSessionAuth(request);
    if (session) {
      const user = await cp.getAuthUser(session.userId);
      // A session may carry no account (no current/legacy org). The /v1/me
      // surface still answers — it just reports a null account so the
      // Console can render the "no org yet" state instead of 401-ing here.
      const account = session.accountId
        ? await cp.getAccount(session.accountId)
        : null;
      return {
        authenticated: true,
        accountId: session.accountId ?? null,
        keyName: "session",
        scope: "admin" as const,
        prefix: "cts_",
        account: account ?? null,
        user: user
          ? {
              id: user.id,
              email: user.email,
              name: user.name,
              emailVerifiedAt: user.emailVerifiedAt ?? null,
              avatarUrl: user.avatarUrl ?? null,
            }
          : null,
      };
    }
    return { authenticated: false };
  }
  const account = await cp.getAccount(key.accountId);
  return {
    authenticated: true,
    accountId: key.accountId,
    keyName: key.name,
    scope: key.scope,
    prefix: key.prefix,
    account: account ?? null,
  };
});

/* ----- multi-org tenancy (plan §18 — Option B) -----
 *  These routes are session-only (a Bearer `cts_…` is required); they
 *  let a logged-in user see every org they belong to, switch active org,
 *  and leave an org. API keys are scoped to one account by construction,
 *  so they never need these surfaces. */

// List every account the caller belongs to. Used by the Console
// org-switcher dropdown.
app.get("/v1/me/orgs", async (request, reply) => {
  const session = getSessionAuth(request);
  if (!session) {
    return reply.code(401).send({
      error: "session required (Bearer cts_ token)",
    });
  }
  const orgs = await cp.listMyOrgs(session.userId);
  return { orgs, currentAccountId: session.accountId };
});

// Switch active org. Body: { accountId }. The control plane verifies
// membership before flipping the session's `currentAccountId`.
const switchOrgSchema = z.object({ accountId: z.string().min(1) });
app.post("/v1/me/orgs/switch", async (request, reply) => {
  const session = getSessionAuth(request);
  if (!session) {
    return reply.code(401).send({
      error: "session required (Bearer cts_ token)",
    });
  }
  const parsed = switchOrgSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }
  const result = await cp.switchOrg({
    sessionId: session.sessionId,
    userId: session.userId,
    accountId: parsed.data.accountId,
  });
  if ("error" in result) {
    return reply.code(403).send({ error: result.error });
  }
  return result;
});

// Leave an org. Body: { accountId }. The last owner cannot leave;
// promote someone first.
const leaveOrgSchema = z.object({ accountId: z.string().min(1) });
app.post("/v1/me/orgs/leave", async (request, reply) => {
  const session = getSessionAuth(request);
  if (!session) {
    return reply.code(401).send({
      error: "session required (Bearer cts_ token)",
    });
  }
  const parsed = leaveOrgSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }
  const result = await cp.leaveOrg({
    sessionId: session.sessionId,
    userId: session.userId,
    accountId: parsed.data.accountId,
  });
  if ("error" in result) {
    return reply.code(400).send({ error: result.error });
  }
  return result;
});

/* ============================================================
   Platform super-user back-office — read-only (super-user
   management, slice 1). All under /v1/admin/*, all behind
   requireSuper. Every cross-tenant read writes an AuditLog row,
   EXCEPT GET /v1/admin/audit (reading the log is not itself logged).
   ============================================================ */

const ADMIN_READ: PlatformRole[] = ["superadmin", "support"];

app.get("/v1/admin/accounts", async (request, reply) => {
  const session = requireSuper(request, reply, ADMIN_READ);
  if (!session) return;
  const q = request.query as { q?: string; plan?: string; billingStatus?: string };
  const accounts = await cp.adminListAccounts({
    q: q.q,
    plan: q.plan,
    billingStatus: q.billingStatus,
  });
  await cp.recordAdminAudit({
    actorUserId: session.userId,
    action: "admin.account.list",
    targetType: "account",
    metadata: { q: q.q, plan: q.plan, billingStatus: q.billingStatus },
    ip: request.ip,
  });
  return { accounts };
});

app.get("/v1/admin/accounts/:id", async (request, reply) => {
  const session = requireSuper(request, reply, ADMIN_READ);
  if (!session) return;
  const { id: accountId } = request.params as { id: string };
  const account = await cp.getAccount(accountId);
  if (!account) return reply.code(404).send({ error: "account not found" });
  const [projects, members] = await Promise.all([
    cp.listProjects(accountId),
    cp.listMembershipsByAccount(accountId),
  ]);
  await cp.recordAdminAudit({
    actorUserId: session.userId,
    action: "admin.account.read",
    targetType: "account",
    targetId: accountId,
    accountId,
    ip: request.ip,
  });
  return { account, projects, members };
});

app.get("/v1/admin/users", async (request, reply) => {
  const session = requireSuper(request, reply, ADMIN_READ);
  if (!session) return;
  const q = request.query as { q?: string };
  const users = await cp.adminListUsers({ q: q.q });
  await cp.recordAdminAudit({
    actorUserId: session.userId,
    action: "admin.user.list",
    targetType: "user",
    metadata: { q: q.q },
    ip: request.ip,
  });
  return { users };
});

app.get("/v1/admin/projects", async (request, reply) => {
  const session = requireSuper(request, reply, ADMIN_READ);
  if (!session) return;
  const q = request.query as { accountId?: string; status?: string };
  const projects = await cp.adminListProjects({ accountId: q.accountId, status: q.status });
  await cp.recordAdminAudit({
    actorUserId: session.userId,
    action: "admin.project.list",
    targetType: "project",
    metadata: { accountId: q.accountId, status: q.status },
    ip: request.ip,
  });
  return { projects };
});

app.get("/v1/admin/audit", async (request, reply) => {
  const session = requireSuper(request, reply, ADMIN_READ);
  if (!session) return;
  const q = request.query as {
    actorUserId?: string;
    action?: string;
    targetType?: string;
    targetId?: string;
    limit?: string;
  };
  const rawLimit = Number.parseInt(String(q.limit ?? ""), 10);
  const limit = Number.isNaN(rawLimit) ? 100 : Math.max(1, Math.min(500, rawLimit));
  const events = await cp.listAdminAudit({
    actorUserId: q.actorUserId,
    action: q.action,
    targetType: q.targetType,
    targetId: q.targetId,
    limit,
  });
  // Deliberately NOT audited — reading the log must not generate log noise.
  return { events };
});

// Connect a git repository (plan §5.1 — git-based deploys). Response
// carries the per-project HMAC `webhookSecret` exactly once; future
// `GET /v1/projects/:id` calls never include it (it's not persisted in
// the read path) so the caller must capture it now.
app.post("/v1/projects/:id/git", async (request, reply) => {
  const { id } = request.params as { id: string };
  const parsed = connectGitSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }
  if (!(await assertProjectAccess(request, reply, id))) return;
  const result = await cp.connectGit(id, parsed.data);
  if ("error" in result) {
    const code = result.error === "project not found" ? 404 : 400;
    return reply.code(code).send({ error: result.error });
  }
  return reply.code(201).send(result);
});

// Rotate the per-project webhook HMAC secret. Use this when a secret
// leaks or as a routine credential-rotation. The previous secret stops
// working immediately.
app.post("/v1/projects/:id/git/rotate-secret", async (request, reply) => {
  const { id } = request.params as { id: string };
  if (!(await assertProjectAccess(request, reply, id))) return;
  const result = await cp.rotateWebhookSecret(id);
  if ("error" in result) {
    const code = result.error === "project not found" ? 404 : 400;
    return reply.code(code).send({ error: result.error });
  }
  return reply.code(201).send(result);
});

/* ----- backups (plan §5.5) ----- */

const createBackupSchema = z.object({
  note: z.string().max(280).optional(),
});

// List a project's backups, newest first.
app.get("/v1/projects/:id/backups", async (request, reply) => {
  const { id } = request.params as { id: string };
  if (!(await assertProjectAccess(request, reply, id))) return;
  return { backups: await cp.listBackups(id) };
});

// Take a backup of the current live deployment + env vars.
app.post("/v1/projects/:id/backups", async (request, reply) => {
  const { id } = request.params as { id: string };
  const parsed = createBackupSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }
  if (!(await assertProjectAccess(request, reply, id))) return;
  const result = await cp.createBackup(id, {
    note: parsed.data.note,
    trigger: "manual",
  });
  if ("error" in result) {
    const code = result.error === "project not found" ? 404 : 400;
    return reply.code(code).send({ error: result.error });
  }
  return reply.code(201).send(result);
});

// Restore from a backup — re-applies env vars + rolls back deployment.
app.post(
  "/v1/projects/:id/backups/:backupId/restore",
  async (request, reply) => {
    const { id, backupId } = request.params as {
      id: string;
      backupId: string;
    };
    if (!(await assertProjectAccess(request, reply, id))) return;
    const result = await cp.restoreBackup(id, backupId);
    if ("error" in result) {
      const code = result.error.includes("not found") ? 404 : 400;
      return reply.code(code).send({ error: result.error });
    }
    return reply.code(201).send(result);
  },
);

// Drop a backup.
app.delete(
  "/v1/projects/:id/backups/:backupId",
  async (request, reply) => {
    const { id, backupId } = request.params as {
      id: string;
      backupId: string;
    };
    if (!(await assertProjectAccess(request, reply, id))) return;
    // Cross-check the backup actually belongs to this project before the
    // CP layer's delete fires — the CP method doesn't take a projectId so
    // the guard lives here.
    const backup = await cp.getBackup(backupId);
    if (!backup || backup.projectId !== id) {
      return reply.code(404).send({ error: "backup not found" });
    }
    const result = await cp.deleteBackup(backupId);
    if ("error" in result) {
      return reply.code(404).send({ error: result.error });
    }
    return reply.code(204).send();
  },
);

/* ----- preview environments (plan §5.1) ----- */

// List a project's live preview deployments. Each preview lives at its
// own subdomain — see `Deployment.url`.
app.get("/v1/projects/:id/previews", async (request, reply) => {
  const { id } = request.params as { id: string };
  if (!(await assertProjectAccess(request, reply, id))) return;
  return { previews: await cp.listPreviews(id) };
});

const deployPreviewSchema = z.object({
  branch: z.string().min(1),
  commit: z
    .object({
      hash: z.string().optional(),
      message: z.string().optional(),
    })
    .optional(),
});

// Manually spin up a preview environment from a branch. The webhook
// receiver does this automatically for non-tracked branches; this route
// is for testing without setting up a real git host.
app.post("/v1/projects/:id/previews", async (request, reply) => {
  const { id } = request.params as { id: string };
  const parsed = deployPreviewSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }
  if (!(await assertProjectAccess(request, reply, id))) return;
  const result = await cp.deployPreview(id, parsed.data.branch, {
    trigger: "cli",
    commit: parsed.data.commit,
  });
  if ("error" in result) {
    return reply.code(404).send({ error: result.error });
  }
  return reply.code(201).send(result);
});

// Tear down a preview environment by its deployment id.
app.delete(
  "/v1/projects/:id/previews/:deploymentId",
  async (request, reply) => {
    const { id, deploymentId } = request.params as {
      id: string;
      deploymentId: string;
    };
    if (!(await assertProjectAccess(request, reply, id))) return;
    const result = await cp.destroyPreview(id, deploymentId);
    if ("error" in result) {
      const code = result.error.includes("not found") ? 404 : 400;
      return reply.code(code).send({ error: result.error });
    }
    return reply.code(200).send(result);
  },
);

// Detach the connected repo.
app.delete("/v1/projects/:id/git", async (request, reply) => {
  const { id } = request.params as { id: string };
  if (!(await assertProjectAccess(request, reply, id))) return;
  const result = await cp.disconnectGit(id);
  if (!result) return reply.code(404).send({ error: "project not found" });
  return result;
});

// Git push webhook receiver. The body shape is a small, provider-neutral
// envelope; a real adapter for GitHub / GitLab / Bitbucket would translate
// the provider payload to this shape on the way in.
//
// Auth: this route is NOT gated by `assertProjectAccess` — external git
// providers don't carry Cantila API keys. Instead, every project that
// goes through `POST /v1/projects/:id/git` is issued a `webhookSecret`,
// and the sender must HMAC-SHA256 the raw body and pass it as either
// `X-Hub-Signature-256: sha256=<hex>` (GitHub's convention) or
// `X-Cantila-Signature: <hex>`. Without a valid signature the receiver
// returns 401, so knowing a project id alone is not enough to fire
// deploys.
app.post("/v1/projects/:id/git/webhook", async (request, reply) => {
  const { id } = request.params as { id: string };
  const parsed = pushWebhookSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }
  const headers = request.headers;
  const sigHeader =
    (Array.isArray(headers["x-hub-signature-256"])
      ? headers["x-hub-signature-256"][0]
      : headers["x-hub-signature-256"]) ??
    (Array.isArray(headers["x-cantila-signature"])
      ? headers["x-cantila-signature"][0]
      : headers["x-cantila-signature"]);
  const result = await cp.handlePushWebhook(id, parsed.data, {
    rawBody: rawBodyOf(request),
    signature: typeof sigHeader === "string" ? sigHeader : undefined,
  });
  if ("error" in result) {
    // Signature-related rejections are 401 (authentication problem);
    // everything else stays 400 / 202 as before.
    const isSig =
      result.code === "rejected" &&
      (result.error.includes("signature") || result.error.includes("Bearer"));
    const code = isSig ? 401 : result.code === "rejected" ? 400 : 202;
    return reply.code(code).send({ skipped: result.code === "skipped", error: result.error });
  }
  return reply.code(201).send(result);
});

// Provision the bundled managed database (idempotent — returns existing if present).
app.post("/v1/projects/:id/database", async (request, reply) => {
  const { id } = request.params as { id: string };
  const parsed = provisionDbSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }
  if (!(await assertProjectAccess(request, reply, id))) return;
  const result = await cp.provisionDb(id, parsed.data.engine);
  if ("error" in result) {
    return reply.code(404).send({ error: result.error });
  }
  return reply.code(201).send(result);
});

// Delete a project's managed database — tears down the Coolify Postgres,
// removes the row, and strips the injected DATABASE_URL.
app.delete("/v1/projects/:id/database", async (request, reply) => {
  const { id } = request.params as { id: string };
  if (!(await assertProjectAccess(request, reply, id))) return;
  const result = await cp.deleteProjectDatabase(id);
  if ("error" in result) {
    return reply
      .code(result.error === "project not found" ? 404 : 400)
      .send({ error: result.error });
  }
  return reply.code(200).send(result);
});

// Delete a project entirely — tears down its app + database on the data
// plane, then removes the project and every FK-related row.
app.delete("/v1/projects/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  if (!(await assertProjectAccess(request, reply, id))) return;
  const result = await cp.deleteProject(id);
  if ("error" in result) {
    return reply.code(404).send({ error: result.error });
  }
  return reply.code(200).send(result);
});

/* ----- boot ----- */

// ----- cantilapay (plan §25 — the 12th product surface) -----
//
// Phase 0 wires the foundation: tenant API keys, idempotency,
// webhook framework (in + out), audit log, sub-merchant skeleton.
// Selects Adyen for Platforms when ADYEN_* env is configured;
// stub otherwise — same env-gated discipline as every other
// Cantila adapter. The Console-managed surface (`/enable`,
// `/api_keys`, …) gates on the existing Cantila Account
// credential (admin key or Console session); the tenant API
// surface gates on the cantilapay `csk_…` secret key.

const cantilapaySelection = selectPaymentProcessor(process.env);
console.log(
  `[cantilapay] ${cantilapaySelection.label} (${cantilapaySelection.live ? "live" : "stub"})`,
);

registerCantilapayRoutes(app, {
  prisma: getPrisma(),
  selection: cantilapaySelection,
  // Source of truth for "which Cantila tenant is on the request" for
  // Console-managed cantilapay routes. Returns null when no credentialed
  // principal — the Console-managed routes treat that as 401 (no
  // fallback to a demo account, by design).
  resolveConsoleAccountId: (req) => {
    const key = getApiKey(req);
    if (key) return key.accountId;
    const session = getSessionAuth(req);
    if (session?.accountId) return session.accountId;
    return null;
  },
});

const stopCantilapayWorker = startCantilapayDeliveryWorker(getPrisma());
// Phase 2 — recurring billing tick. Same in-process posture as the
// delivery worker: setInterval + unref, single-process, no external
// scheduler. Cadence is 60s; the smoke test invokes the engine's `tick`
// directly with an injected `now` to fast-forward across periods.
const stopCantilapayBillingWorker = startCantilapayBillingEngineWorker(
  getPrisma(),
  cantilapaySelection.processor,
);
process.on("SIGINT", () => {
  stopCantilapayWorker();
  stopCantilapayBillingWorker();
});
process.on("SIGTERM", () => {
  stopCantilapayWorker();
  stopCantilapayBillingWorker();
});

// Map the typed "no account context" error thrown by resolveAccountId /
// resolveActorAccountId to a 401. Any other error falls through to
// Fastify's default handling (which logs + sends a 500).
app.setErrorHandler((err, _req, reply) => {
  if (err instanceof NoAccountContextError) {
    return reply.code(401).send({ error: err.message });
  }
  throw err; // fall through to Fastify's default handling
});

/* ----- boot ----- */

app
  .listen({ port: config.port, host: "0.0.0.0" })
  .then(async () => {
    app.log.info(
      `cantila-control-plane listening on :${config.port} · store=${config.store}`,
    );
    // Owner-account seed (plan §18). When CANTILA_OWNER_PASSWORD is set,
    // ensure the owner email is a real OWNER of a real account so the
    // Console scopes to it instead of falling back to the demo account.
    // Idempotent — safe on every boot. The in-memory store wipes on
    // restart, so this is what makes the owner durable across restarts.
    const ownerPassword = process.env.CANTILA_OWNER_PASSWORD;
    if (ownerPassword) {
      const result = await seedOwnerAccount(store, {
        email: process.env.CANTILA_OWNER_EMAIL ?? "jjcantila0728@gmail.com",
        password: ownerPassword,
        name: process.env.CANTILA_OWNER_NAME ?? "JJ Cantila",
        accountId: process.env.CANTILA_OWNER_ACCOUNT_ID ?? "acc_cantila",
        accountName: process.env.CANTILA_OWNER_ACCOUNT_NAME ?? "Cantila",
        handle: process.env.CANTILA_OWNER_ACCOUNT_HANDLE ?? "cantila",
        plan: (process.env.CANTILA_OWNER_ACCOUNT_PLAN as AccountPlan) ?? "dedicated",
      });
      app.log.info(
        `owner seed: account=${result.accountId} created=${JSON.stringify(result.created)}`,
      );
    }
    // Hidden Platform project that owns cantila.app hosted mailboxes
    // (info@, etc.). Idempotent; runs after the owner-account seed so
    // the owning account exists. (plan §4.4)
    const platformSeed = await seedPlatformProject(store);
    app.log.info(
      `platform seed: account=${platformSeed.accountId} created=${platformSeed.created}`,
    );
    // Migrate any legacy auto-wired mailbox addresses to the canonical
    // info@<slug>.cantila.app scheme (plan §4.4). Idempotent.
    const mbxReco = await reconcileProjectMailboxes(store);
    app.log.info(
      `mailbox reconcile: updated=${mbxReco.updated}/${mbxReco.scanned}`,
    );
    cp.startBackgroundJobs();
    app.log.info("background jobs started (uptime sweeps every 30s)");
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
