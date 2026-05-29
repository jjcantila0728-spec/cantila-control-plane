/* ============================================================
   Cantilapay — tenant API key middleware (plan §25, Phase 0).

   Resolves a `Bearer <cpk_|csk_>…` token to a CantilapayApiKey
   row and attaches it to the Fastify request as
   `req.cantilapayKey`. The route handler then reads it via
   `requireCantilapayKey(req)` (mutations) or
   `requireCantilapayPublishableOrSecret(req)` (read-only).

   This auth layer is SEPARATE from the existing Cantila admin
   key chain (`ctk_…`) and Console session chain (`cts_…`). All
   three coexist; a request can present at most one bearer
   credential, so the cantilapay middleware only runs on routes
   under `/v1/cantilapay/*`.
   ============================================================ */

import type { FastifyReply, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";

import {
  authenticateCantilapayKey,
  type ResolvedCantilapayKey,
} from "../services/keys";
import { CantilapayError } from "../errors";
import type { CantilapayMode } from "../types";

declare module "fastify" {
  interface FastifyRequest {
    cantilapayKey?: ResolvedCantilapayKey;
  }
}

/** Resolve the cantilapay tenant key on a request (or null when
 *  absent). Never throws — the caller decides whether absence is
 *  okay (e.g. on a `webhook_endpoints` test ping). */
export async function resolveCantilapayKey(
  prisma: PrismaClient,
  req: FastifyRequest,
): Promise<ResolvedCantilapayKey | null> {
  const auth = typeof req.headers.authorization === "string"
    ? req.headers.authorization
    : undefined;
  if (!auth) return null;
  try {
    const resolved = await authenticateCantilapayKey(prisma, auth);
    req.cantilapayKey = resolved;
    return resolved;
  } catch {
    // Don't swallow — let the strict middleware below render the
    // CantilapayError. Returning null here just means "no resolved
    // key yet"; the strict caller re-runs the authenticate call.
    return null;
  }
}

/** Hard guard for routes that need a SECRET key (`csk_…`). The route
 *  handler calls this at the top; on failure we render the wire shape
 *  and return null so the handler can early-return. */
export async function requireCantilapaySecretKey(
  prisma: PrismaClient,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<ResolvedCantilapayKey | null> {
  try {
    const auth = typeof req.headers.authorization === "string"
      ? req.headers.authorization
      : undefined;
    const resolved = await authenticateCantilapayKey(prisma, auth);
    if (resolved.kind !== "secret") {
      throw CantilapayError.kindMismatch();
    }
    req.cantilapayKey = resolved;
    return resolved;
  } catch (err) {
    if (err instanceof CantilapayError) {
      reply.code(err.status).send({ error: err.body });
    } else {
      reply.code(500).send({
        error: CantilapayError.internal().body,
      });
    }
    return null;
  }
}

/** Hard guard for routes that accept either publishable or secret —
 *  e.g. `GET /v1/cantilapay/accounts/me` so the tenant's frontend
 *  can show their own status with the `cpk_` key. */
export async function requireCantilapayAnyKey(
  prisma: PrismaClient,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<ResolvedCantilapayKey | null> {
  try {
    const auth = typeof req.headers.authorization === "string"
      ? req.headers.authorization
      : undefined;
    const resolved = await authenticateCantilapayKey(prisma, auth);
    req.cantilapayKey = resolved;
    return resolved;
  } catch (err) {
    if (err instanceof CantilapayError) {
      reply.code(err.status).send({ error: err.body });
    } else {
      reply.code(500).send({
        error: CantilapayError.internal().body,
      });
    }
    return null;
  }
}

/** Read the resolved mode from the request after a successful
 *  require* call. */
export function modeOf(req: FastifyRequest): CantilapayMode {
  const key = req.cantilapayKey;
  if (!key) throw CantilapayError.missingKey();
  return key.mode;
}
