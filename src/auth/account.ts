import type { FastifyRequest } from "fastify";
import type { ApiKey, PlatformRole } from "../domain/types";

/** The resolved Console session on a request. Set by the onRequest auth
 *  hook when a `cts_` Bearer token is presented. `accountId` is the
 *  session's current active org (plan §18 — Option B), with a legacy
 *  fallback to `AuthUser.accountId`. It is optional because a freshly
 *  resolved session may carry no current/legacy account at all — callers
 *  that need a definite account go through `resolveAccountId`, which
 *  throws `NoAccountContextError` rather than inventing one. `sessionId`
 *  is exposed so the org-switcher route knows which session row to update. */
export interface SessionAuth {
  userId: string;
  accountId?: string;
  sessionId: string;
  /** Platform super-user role for the signed-in user (super-user
   *  management, slice 1). Undefined for ordinary tenant users. Set by the
   *  onRequest auth hook from the resolved user row. */
  platformRole?: PlatformRole;
}

/** Thrown by `resolveAccountId` / `resolveActorAccountId` when no
 *  authenticated principal (API key or Console session) is present and no
 *  explicit `?accountId=` query was supplied. The Fastify error handler
 *  maps this to a 401 — there is no demo-account fallback. */
export class NoAccountContextError extends Error {
  constructor() {
    super("no account context — authentication required");
    this.name = "NoAccountContextError";
  }
}

/** The authenticated API key on this request, if a `ctk_` Bearer token authed it. */
export function getApiKey(req: FastifyRequest): ApiKey | undefined {
  return (req as unknown as { apiKey?: ApiKey }).apiKey;
}

/** The resolved Console session on this request, if a `cts_` token authed it. */
export function getSessionAuth(req: FastifyRequest): SessionAuth | undefined {
  return (req as unknown as { session?: SessionAuth }).session;
}

/** The act-as target on this request, if `X-Cantila-Act-As` was supplied
 *  AND the auth-resolution hook accepted it via `canActOnAccount`. */
export function getActAs(req: FastifyRequest): string | undefined {
  return (req as unknown as { actAs?: string }).actAs;
}

/** The authoritative account id for this request. The resolution order
 *  is:
 *   1. An accepted `X-Cantila-Act-As` target (plan §5.5 — white-label
 *      parent acting as a sub-account). The auth-resolution hook has
 *      already validated this via `canActOnAccount`.
 *   2. An authenticated API key.
 *   3. A Console session.
 *   4. `?accountId=` query param (only honoured when no credential is
 *      present, i.e. CANTILA_REQUIRE_AUTH=off and the dev flow).
 *
 *  When none of these is present the request has no account context and
 *  we throw `NoAccountContextError` (→ 401). There is no fake-account
 *  fallback — multi-tenant isolation is enforced by construction. */
export function resolveAccountId(req: FastifyRequest): string {
  const actAs = getActAs(req);
  if (actAs) return actAs;
  const key = getApiKey(req);
  if (key) return key.accountId;
  const session = getSessionAuth(req);
  if (session?.accountId) return session.accountId;
  const q = (req.query ?? {}) as { accountId?: string };
  if (q.accountId) return q.accountId;
  throw new NoAccountContextError();
}

/** The original caller's account id, ignoring any `X-Cantila-Act-As`
 *  override. Used for audit fields ("done by acc_agency1 acting as
 *  acc_sub1") and for safety checks that must always speak in the
 *  caller's own name. Throws `NoAccountContextError` (→ 401) when there
 *  is no authenticated principal or explicit query account. */
export function resolveActorAccountId(req: FastifyRequest): string {
  const key = getApiKey(req);
  if (key) return key.accountId;
  const session = getSessionAuth(req);
  if (session?.accountId) return session.accountId;
  const q = (req.query ?? {}) as { accountId?: string };
  if (q.accountId) return q.accountId;
  throw new NoAccountContextError();
}
