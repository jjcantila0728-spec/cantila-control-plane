/* ============================================================
   /v1/connections/* — HTTP surface for Cantila Connections.

   Phase A: API-key + basic auth only. Phase C lands the OAuth
   start/callback pair on `/v1/connections/oauth/*` and the
   provider catalog grows; nothing else here changes.

   Secrets never leave the secrets manager. The wire shape
   carries `secretRef` (an opaque pointer) — never the credential
   itself.
   ============================================================ */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import crypto from "node:crypto";

import type { Store } from "../domain/store";
import type { ControlPlane } from "../core/control-plane";
import type { Connection } from "../domain/types";
import { id as mkId, now, secret as mkSecret } from "../lib/ids";
import {
  PROVIDER_CATALOG,
  getProvider,
  type ProviderDescriptor,
} from "./providers";

const createConnectionSchema = z.object({
  provider: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  /** Field values keyed by the provider manifest's `field.key`.
   *  Secret values land in the secrets manager; non-secret values join
   *  the `metadata` bag on the row. */
  fields: z.record(z.string()),
});

interface RouteDeps {
  store: Store;
  /** Optional — when present, the audit-list route is mounted. The
   *  audit log itself is written by the credential broker on the
   *  ControlPlane (plan §15.5 Phase F); the read route lives here so
   *  the audit feed sits alongside its connection. */
  cp?: ControlPlane;
  resolveAccountId: (req: FastifyRequest) => string;
  /** Pluggable secret writer — when absent, an in-memory map backs the
   *  scaffold so it has no external dependency. The real impl writes
   *  through the persistent secret store (Postgres, encrypted at rest). */
  writeSecret?: (ref: string, payload: Record<string, string>) => Promise<void>;
  /** Pluggable secret deleter, paired with `writeSecret`. When absent,
   *  deletes fall back to the in-memory map. Provided in prod so a
   *  deleted connection doesn't orphan its row in the secret store. */
  deleteSecret?: (ref: string) => Promise<void>;
}

/** Project the row over the wire — never leaks `secretRef` consumers
 *  shouldn't see (only the id is useful in the Console). */
function serializeConnection(c: Connection) {
  return {
    id: c.id,
    provider: c.provider,
    name: c.name,
    authKind: c.authKind,
    status: c.status,
    metadata: c.metadata,
    createdAt: c.createdAt,
    lastUsedAt: c.lastUsedAt,
    expiresAt: c.expiresAt,
  };
}

export function registerConnectionRoutes(
  app: FastifyInstance,
  deps: RouteDeps,
): void {
  const { store, cp, resolveAccountId, writeSecret, deleteSecret } = deps;

  // Fallback secret store, used only when no real `writeSecret` is wired
  // (scaffold / tests). Prod passes a persistent, encrypted writer.
  const inMemorySecrets = new Map<string, Record<string, string>>();
  const persist = writeSecret
    ? writeSecret
    : async (ref: string, payload: Record<string, string>) => {
        inMemorySecrets.set(ref, payload);
      };
  const forget = deleteSecret
    ? deleteSecret
    : async (ref: string) => {
        inMemorySecrets.delete(ref);
      };

  /* ----- catalog ----- */

  app.get("/v1/connections/providers", async () => {
    // Strip OAuth client envs — the browser never needs the server-side
    // env-var name.
    const safe = PROVIDER_CATALOG.map((p) => {
      const { oauth: _omit, ...rest } = p;
      const oauth = p.oauth
        ? {
            scopes: p.oauth.scopes,
            // The Console only needs to know OAuth exists for the provider
            // and which scopes will be requested; the start URL is minted
            // server-side at `/oauth/start`.
            requiresRedirect: true as const,
          }
        : undefined;
      return { ...rest, oauth };
    });
    return { providers: safe };
  });

  /* ----- list / get / create / delete ----- */

  app.get("/v1/connections", async (request) => {
    const accountId = resolveAccountId(request);
    const rows = await store.listConnections(accountId);
    return { connections: rows.map(serializeConnection) };
  });

  app.get("/v1/connections/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const conn = await store.getConnection(id);
    if (!conn || conn.accountId !== resolveAccountId(request)) {
      return reply.code(404).send({ error: "connection not found" });
    }
    return { connection: serializeConnection(conn) };
  });

  app.post("/v1/connections", async (request, reply) => {
    const parsed = createConnectionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const provider = getProvider(parsed.data.provider);
    if (!provider) {
      return reply.code(404).send({ error: "provider not found" });
    }
    if (!provider.apiKey) {
      // Phase A: only API-key / basic providers are creatable through
      // POST. OAuth providers land in Phase C with their own start /
      // callback pair.
      return reply
        .code(400)
        .send({ error: "OAuth providers are not yet supported" });
    }
    const validationError = validateFields(provider, parsed.data.fields);
    if (validationError) {
      return reply.code(400).send({ error: validationError });
    }

    const accountId = resolveAccountId(request);
    const id = mkId("conn");
    const secretRef = mkSecret();
    const { metadata, secretPayload } = splitFields(
      provider,
      parsed.data.fields,
    );
    await persist(secretRef, secretPayload);

    const conn: Connection = {
      id,
      accountId,
      provider: provider.id,
      name: parsed.data.name,
      authKind: provider.authKinds.includes("basic") ? "basic" : "api_key",
      status: "active",
      metadata,
      secretRef,
      createdAt: now(),
    };
    await store.createConnection(conn);
    return reply.code(201).send({ connection: serializeConnection(conn) });
  });

  /* ----- credential-binding audit log (plan §15.5 Phase F) -----
   *  Returns the recent bind/unbind history for a connection — pushed
   *  flag, engine label, TTL, errors. Powers the Console's per-
   *  connection "Audit" tab and the CLI's `connections audit`. */

  app.get("/v1/connections/:id/audit", async (request, reply) => {
    const { id } = request.params as { id: string };
    const conn = await store.getConnection(id);
    if (!conn || conn.accountId !== resolveAccountId(request)) {
      return reply.code(404).send({ error: "connection not found" });
    }
    if (!cp) {
      // Audit log lives on the ControlPlane (which owns the writer); a
      // ControlPlane-less wiring degrades to an empty list rather than
      // a 500.
      return { events: [] };
    }
    const events = await cp.listConnectionAudits({
      accountId: conn.accountId,
      connectionId: id,
      limit: 200,
    });
    return { events };
  });

  /** Account-wide connection audit feed — caller-account-scoped. */
  app.get("/v1/connections/audit", async (request) => {
    const accountId = resolveAccountId(request);
    if (!cp) return { events: [] };
    const events = await cp.listConnectionAudits({
      accountId,
      limit: 200,
    });
    return { events };
  });

  app.delete("/v1/connections/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const conn = await store.getConnection(id);
    if (!conn || conn.accountId !== resolveAccountId(request)) {
      return reply.code(404).send({ error: "connection not found" });
    }
    await store.deleteConnection(id);
    await forget(conn.secretRef);
    return reply.code(204).send();
  });

  /* ----- OAuth start / callback (Phase C — plan §4.11) ----- */

  // Each pending state is held in memory for 10 min. Replay protection:
  // once a state is consumed (the callback redeems it for a token), the
  // row is deleted so a duplicate callback hits "expired state". The
  // state value itself is HMAC-signed with `CANTILA_SECRET_KEY` (or a
  // per-process fallback) so a tampered state fails before lookup.
  const pendingStates = new Map<
    string,
    {
      provider: string;
      accountId: string;
      returnTo?: string;
      connectionName?: string;
      createdAt: number;
    }
  >();
  const STATE_TTL_MS = 10 * 60 * 1000;
  setInterval(() => {
    const cutoff = Date.now() - STATE_TTL_MS;
    for (const [k, v] of pendingStates) {
      if (v.createdAt < cutoff) pendingStates.delete(k);
    }
  }, 60 * 1000).unref?.();

  const STATE_SIGNING_KEY =
    process.env.CANTILA_OAUTH_STATE_KEY ??
    process.env.CANTILA_SECRET_KEY ??
    "cantila-default-oauth-state-key-do-not-use-in-production";

  function mintState(): { raw: string; signed: string } {
    const raw = crypto.randomBytes(24).toString("hex");
    const sig = crypto
      .createHmac("sha256", STATE_SIGNING_KEY)
      .update(raw)
      .digest("hex")
      .slice(0, 32);
    return { raw, signed: `${raw}.${sig}` };
  }

  function verifyStateSignature(signed: string): string | null {
    const parts = signed.split(".");
    if (parts.length !== 2) return null;
    const [raw, sig] = parts;
    const expected = crypto
      .createHmac("sha256", STATE_SIGNING_KEY)
      .update(raw)
      .digest("hex")
      .slice(0, 32);
    if (sig.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      return null;
    }
    return raw;
  }

  app.get("/v1/connections/oauth/start", async (request, reply) => {
    const q = request.query as {
      provider?: string;
      returnTo?: string;
      name?: string;
    };
    const providerId = q.provider;
    if (!providerId) {
      return reply.code(400).send({ error: "missing ?provider" });
    }
    const provider = getProvider(providerId);
    if (!provider) {
      return reply.code(404).send({ error: "provider not found" });
    }
    if (!provider.oauth) {
      return reply.code(400).send({ error: "provider does not support OAuth" });
    }
    const clientId = process.env[provider.oauth.clientIdEnv];
    if (!clientId) {
      return reply.code(503).send({
        error: `OAuth not configured — set ${provider.oauth.clientIdEnv}`,
      });
    }
    const { signed, raw } = mintState();
    const accountId = resolveAccountId(request);
    pendingStates.set(raw, {
      provider: provider.id,
      accountId,
      returnTo: q.returnTo,
      connectionName: q.name,
      createdAt: Date.now(),
    });
    const redirectUri = oauthRedirectUri(request, provider.id);
    const url = new URL(provider.oauth.authUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    if (provider.oauth.scopes.length > 0) {
      url.searchParams.set("scope", provider.oauth.scopes.join(" "));
    }
    url.searchParams.set("state", signed);
    // Most providers default to offline access only when the client asks
    // for it. The flow still works without these, but token refresh later
    // needs them on Google et al.
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    return { authorizeUrl: url.toString() };
  });

  app.get("/v1/connections/oauth/callback", async (request, reply) => {
    const q = request.query as {
      provider?: string;
      code?: string;
      state?: string;
      error?: string;
    };
    if (q.error) {
      return reply
        .code(400)
        .send({ error: `provider returned error: ${q.error}` });
    }
    if (!q.code || !q.state || !q.provider) {
      return reply
        .code(400)
        .send({ error: "missing ?code / ?state / ?provider" });
    }
    const raw = verifyStateSignature(q.state);
    if (!raw) {
      return reply.code(400).send({ error: "invalid state signature" });
    }
    const pending = pendingStates.get(raw);
    if (!pending) {
      return reply.code(400).send({ error: "state expired or already used" });
    }
    pendingStates.delete(raw); // replay protection — single use.
    if (pending.provider !== q.provider) {
      return reply
        .code(400)
        .send({ error: "state/provider mismatch" });
    }
    const provider = getProvider(q.provider);
    if (!provider?.oauth) {
      return reply.code(404).send({ error: "provider not found" });
    }
    const clientId = process.env[provider.oauth.clientIdEnv];
    const clientSecret = process.env[provider.oauth.clientSecretEnv];
    if (!clientId || !clientSecret) {
      return reply
        .code(503)
        .send({ error: "OAuth client credentials not configured" });
    }

    // Exchange code → tokens. We POST application/x-www-form-urlencoded
    // because most providers (Google / Slack / GitHub / Notion / Airtable)
    // accept that uniformly; providers that prefer JSON still accept the
    // form-encoded body.
    const redirectUri = oauthRedirectUri(request, provider.id);
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: q.code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
    });
    let tokenResponse: {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
      token_type?: string;
    };
    try {
      const res = await fetch(provider.oauth.tokenUrl, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return reply.code(502).send({
          error: `token exchange failed: ${res.status} ${text.slice(0, 200)}`,
        });
      }
      tokenResponse = (await res.json()) as typeof tokenResponse;
    } catch (err) {
      return reply.code(502).send({
        error:
          err instanceof Error
            ? `token exchange failed: ${err.message}`
            : "token exchange failed",
      });
    }
    if (!tokenResponse.access_token) {
      return reply.code(502).send({ error: "provider returned no access_token" });
    }
    const expiresAt = tokenResponse.expires_in
      ? new Date(Date.now() + tokenResponse.expires_in * 1000).toISOString()
      : undefined;
    const secretRef = mkSecret();
    await persist(secretRef, {
      access_token: tokenResponse.access_token,
      refresh_token: tokenResponse.refresh_token ?? "",
      token_type: tokenResponse.token_type ?? "",
    });
    const conn: Connection = {
      id: mkId("conn"),
      accountId: pending.accountId,
      provider: provider.id,
      name: pending.connectionName?.trim() || `${provider.name} connection`,
      authKind: "oauth",
      status: "active",
      metadata: {
        scope: tokenResponse.scope ?? provider.oauth.scopes.join(" "),
      },
      secretRef,
      createdAt: now(),
      expiresAt,
    };
    await store.createConnection(conn);

    // If the caller asked us to redirect back to the Console afterwards,
    // honour it; otherwise return JSON the API consumer can read.
    if (pending.returnTo && isSafeReturnTo(pending.returnTo)) {
      const sep = pending.returnTo.includes("?") ? "&" : "?";
      reply.header(
        "location",
        `${pending.returnTo}${sep}connection=${encodeURIComponent(conn.id)}`,
      );
      return reply.code(302).send();
    }
    return { connection: serializeConnection(conn) };
  });
}

function oauthRedirectUri(
  req: FastifyRequest,
  providerId: string,
): string {
  const override = process.env.CANTILA_OAUTH_REDIRECT_BASE_URL;
  if (override) {
    return `${override.replace(/\/$/, "")}/v1/connections/oauth/callback?provider=${encodeURIComponent(providerId)}`;
  }
  const proto =
    (req.headers["x-forwarded-proto"] as string) ?? (req.protocol ?? "http");
  const host =
    (req.headers["x-forwarded-host"] as string) ??
    req.headers.host ??
    "localhost:8080";
  return `${proto}://${host}/v1/connections/oauth/callback?provider=${encodeURIComponent(providerId)}`;
}

function isSafeReturnTo(returnTo: string): boolean {
  // Only allow same-origin relative paths so the redirect can't be
  // weaponised to send users off to an attacker's site.
  return returnTo.startsWith("/") && !returnTo.startsWith("//");
}

function validateFields(
  provider: ProviderDescriptor,
  fields: Record<string, string>,
): string | null {
  if (!provider.apiKey) return "provider does not support form fields";
  for (const f of provider.apiKey.fields) {
    const v = fields[f.key];
    if (v === undefined || v.trim() === "") {
      return `missing required field: ${f.key}`;
    }
  }
  return null;
}

function splitFields(
  provider: ProviderDescriptor,
  fields: Record<string, string>,
): {
  metadata: Record<string, unknown>;
  secretPayload: Record<string, string>;
} {
  const metadata: Record<string, unknown> = {};
  const secretPayload: Record<string, string> = {};
  if (!provider.apiKey) return { metadata, secretPayload };
  for (const f of provider.apiKey.fields) {
    const v = fields[f.key];
    if (v === undefined) continue;
    if (f.secret) secretPayload[f.key] = v;
    else metadata[f.key] = v;
  }
  return { metadata, secretPayload };
}
