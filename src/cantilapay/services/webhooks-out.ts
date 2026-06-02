/* ============================================================
   Cantilapay — outbound webhook delivery (plan §25, Phase 0).

   Tenants register HTTPS endpoints via
   `POST /v1/cantilapay/webhook_endpoints`; the platform delivers
   each `CantilapayEvent` they subscribe to with a signed HTTP POST:

     POST <endpoint.url>
     Content-Type: application/json
     Cantilapay-Signature: t=<unix>,v1=<HMAC-SHA256(secret, "<t>.<rawBody>")>
     Cantilapay-Event-Type: <type>
     Cantilapay-Delivery-Attempt: <n>

   Phase 0 ships the issue-and-list surface plus the delivery
   primitive (`enqueueDelivery` + `deliverPending`). The actual
   retry worker that polls `nextAttemptAt` and reattempts on
   failure is a tight scheduler started by `startDeliveryWorker`
   below — single-process, no external queue, same posture as
   the in-process secrets store and engineRegistry used in Phase A
   of Automations.
   ============================================================ */

import { createHash, createHmac, randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

import type {
  CantilapayMode,
  CantilapayWebhookEndpointIssued,
  CantilapayWebhookEndpointView,
} from "../types";
import { CANTILAPAY_WEBHOOK_SECRET_PREFIX } from "../types";
import { assertUrlResolvesToPublic } from "./ssrf-guard";

const MAX_BODY_PREVIEW = 512;
const RETRY_SCHEDULE_SECONDS = [60, 300, 1800, 7200, 43200]; // 1m, 5m, 30m, 2h, 12h
const TERMINAL_AFTER_ATTEMPTS = RETRY_SCHEDULE_SECONDS.length;

function buildSecret(): string {
  return `${CANTILAPAY_WEBHOOK_SECRET_PREFIX}${randomBytes(24).toString("hex")}`;
}

/** Issue a new tenant webhook endpoint. Returns the full signing
 *  secret once; persists only the value (plaintext today, KMS-wrapped
 *  later — matching the discipline of `Account.anthropicApiKey`). */
export async function createWebhookEndpoint(
  prisma: PrismaClient,
  input: {
    cantilapayAccountId: string;
    url: string;
    mode: CantilapayMode;
    enabledEvents?: string;
  },
): Promise<CantilapayWebhookEndpointIssued> {
  const signingSecret = buildSecret();
  const signingSecretPrefix = signingSecret.slice(
    0,
    CANTILAPAY_WEBHOOK_SECRET_PREFIX.length + 8,
  );
  const row = await prisma.cantilapayWebhookEndpoint.create({
    data: {
      cantilapayAccountId: input.cantilapayAccountId,
      url: input.url,
      mode: input.mode,
      enabledEvents: input.enabledEvents ?? "*",
      signingSecret,
      signingSecretPrefix,
    },
  });
  return {
    id: row.id,
    url: row.url,
    mode: row.mode,
    enabledEvents: row.enabledEvents,
    signingSecretPrefix: row.signingSecretPrefix,
    status: row.status === "disabled" ? "disabled" : "active",
    createdAt: row.createdAt.toISOString(),
    lastDeliveryAt: row.lastDeliveryAt
      ? row.lastDeliveryAt.toISOString()
      : null,
    signingSecret,
  };
}

/** List tenant endpoints, masked. */
export async function listWebhookEndpoints(
  prisma: PrismaClient,
  input: { cantilapayAccountId: string },
): Promise<CantilapayWebhookEndpointView[]> {
  const rows = await prisma.cantilapayWebhookEndpoint.findMany({
    where: { cantilapayAccountId: input.cantilapayAccountId },
    orderBy: { createdAt: "desc" },
  });
  return rows.map((row) => ({
    id: row.id,
    url: row.url,
    mode: row.mode,
    enabledEvents: row.enabledEvents,
    signingSecretPrefix: row.signingSecretPrefix,
    status: row.status === "disabled" ? "disabled" : "active",
    createdAt: row.createdAt.toISOString(),
    lastDeliveryAt: row.lastDeliveryAt
      ? row.lastDeliveryAt.toISOString()
      : null,
  }));
}

/** Decide whether a given endpoint should receive a given event type.
 *  "*" matches everything; otherwise enabledEvents is a CSV exact match. */
function endpointMatches(enabledEvents: string, type: string): boolean {
  if (enabledEvents === "*") return true;
  const list = enabledEvents.split(",").map((s) => s.trim()).filter(Boolean);
  return list.includes(type) || list.includes("*");
}

/** Schedule deliveries for an event — one per matching endpoint. */
export async function enqueueDelivery(
  prisma: PrismaClient,
  input: {
    cantilapayAccountId: string;
    eventId: string;
    eventType: string;
    mode: CantilapayMode;
  },
): Promise<{ scheduled: number }> {
  const endpoints = await prisma.cantilapayWebhookEndpoint.findMany({
    where: {
      cantilapayAccountId: input.cantilapayAccountId,
      mode: input.mode,
      status: "active",
    },
    select: { id: true, enabledEvents: true },
  });
  const targets = endpoints.filter((e) =>
    endpointMatches(e.enabledEvents, input.eventType),
  );
  if (targets.length === 0) return { scheduled: 0 };

  const now = new Date();
  await prisma.cantilapayWebhookDelivery.createMany({
    data: targets.map((e) => ({
      cantilapayAccountId: input.cantilapayAccountId,
      endpointId: e.id,
      eventId: input.eventId,
      status: "pending",
      attempts: 0,
      nextAttemptAt: now,
    })),
  });
  return { scheduled: targets.length };
}

/** Compute the signature header value for a body delivered to a
 *  tenant. Same format the inbound Stripe webhook uses
 *  (`t=<ts>,v1=<hex>`), keyed with the endpoint's signing secret. */
export function signOutbound(rawBody: string, secret: string): string {
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex");
  return `t=${ts},v1=${sig}`;
}

/** Verify a signature emitted by `signOutbound`. The tenant's server
 *  uses this verbatim. Exported here so cantilapay's own SDK and
 *  smoke test can call the same code. */
export function verifyOutbound(args: {
  rawBody: string;
  signatureHeader: string;
  secret: string;
  /** Reject signatures older than this many seconds. Stripe uses 300. */
  toleranceSeconds?: number;
}): boolean {
  const tol = args.toleranceSeconds ?? 300;
  const parts = args.signatureHeader.split(",").reduce<Record<string, string>>(
    (acc, part) => {
      const [k, v] = part.split("=");
      if (k && v) acc[k.trim()] = v.trim();
      return acc;
    },
    {},
  );
  const ts = parts.t;
  const sig = parts.v1;
  if (!ts || !sig) return false;
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return false;
  if (Math.abs(Date.now() / 1000 - tsNum) > tol) return false;
  const expected = createHmac("sha256", args.secret)
    .update(`${ts}.${args.rawBody}`)
    .digest("hex");
  // constant-time compare
  const a = Buffer.from(sig, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a[i] ^ b[i];
  return mismatch === 0;
}

/** Pick up the next batch of pending deliveries (or due retries) and
 *  attempt each one. Idempotent; safe to call from a single-process
 *  setInterval. */
export async function deliverPending(
  prisma: PrismaClient,
  opts: { batchSize?: number } = {},
): Promise<{ delivered: number; failed: number; deferred: number }> {
  const take = Math.max(1, Math.min(opts.batchSize ?? 25, 100));
  const due = await prisma.cantilapayWebhookDelivery.findMany({
    where: {
      OR: [{ status: "pending" }, { status: "failed_temporary" }],
      nextAttemptAt: { lte: new Date() },
    },
    take,
    orderBy: { nextAttemptAt: "asc" },
    include: {
      endpoint: true,
      event: true,
    },
  });

  let delivered = 0;
  let failed = 0;
  let deferred = 0;

  for (const row of due) {
    if (row.endpoint.status !== "active") {
      await prisma.cantilapayWebhookDelivery.update({
        where: { id: row.id },
        data: { status: "failed_permanent", nextAttemptAt: null },
      });
      failed += 1;
      continue;
    }
    const rawBody = JSON.stringify({
      id: row.eventId,
      type: row.event.type,
      mode: row.event.mode,
      created_at: row.event.createdAt.toISOString(),
      data: safeParse(row.event.data),
    });
    const sigHeader = signOutbound(rawBody, row.endpoint.signingSecret);
    const attemptNo = row.attempts + 1;
    const attemptStartedAt = new Date();
    let responseStatus = 0;
    let responseBody = "";
    let success = false;
    try {
      // Re-validate at delivery time to defeat DNS rebinding — the host may
      // have resolved public when registered but private now.
      await assertUrlResolvesToPublic(new URL(row.endpoint.url));
      const res = await fetch(row.endpoint.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cantilapay-signature": sigHeader,
          "cantilapay-event-type": row.event.type,
          "cantilapay-delivery-attempt": String(attemptNo),
        },
        body: rawBody,
      });
      responseStatus = res.status;
      try {
        responseBody = (await res.text()).slice(0, MAX_BODY_PREVIEW);
      } catch {
        responseBody = "";
      }
      success = res.ok;
    } catch (err) {
      responseStatus = 0;
      responseBody = err instanceof Error ? err.message.slice(0, MAX_BODY_PREVIEW) : "network error";
    }

    if (success) {
      await prisma.cantilapayWebhookDelivery.update({
        where: { id: row.id },
        data: {
          status: "succeeded",
          attempts: attemptNo,
          lastAttemptAt: attemptStartedAt,
          nextAttemptAt: null,
          lastResponseCode: responseStatus,
          lastResponseBody: responseBody,
        },
      });
      await prisma.cantilapayWebhookEndpoint.update({
        where: { id: row.endpointId },
        data: { lastDeliveryAt: attemptStartedAt },
      });
      delivered += 1;
      continue;
    }

    if (attemptNo >= TERMINAL_AFTER_ATTEMPTS) {
      await prisma.cantilapayWebhookDelivery.update({
        where: { id: row.id },
        data: {
          status: "failed_permanent",
          attempts: attemptNo,
          lastAttemptAt: attemptStartedAt,
          nextAttemptAt: null,
          lastResponseCode: responseStatus,
          lastResponseBody: responseBody,
        },
      });
      failed += 1;
      continue;
    }

    const delaySec = RETRY_SCHEDULE_SECONDS[attemptNo - 1] ?? RETRY_SCHEDULE_SECONDS[RETRY_SCHEDULE_SECONDS.length - 1];
    await prisma.cantilapayWebhookDelivery.update({
      where: { id: row.id },
      data: {
        status: "failed_temporary",
        attempts: attemptNo,
        lastAttemptAt: attemptStartedAt,
        nextAttemptAt: new Date(Date.now() + delaySec * 1000),
        lastResponseCode: responseStatus,
        lastResponseBody: responseBody,
      },
    });
    deferred += 1;
  }

  return { delivered, failed, deferred };
}

/** Start a polling worker that runs `deliverPending` on an interval.
 *  Returns a stop function. The control plane calls this once at
 *  startup; the test suite calls it directly when verifying. */
export function startDeliveryWorker(
  prisma: PrismaClient,
  opts: { intervalMs?: number; batchSize?: number } = {},
): () => void {
  const intervalMs = Math.max(1_000, opts.intervalMs ?? 10_000);
  let stopped = false;
  let running = false;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await deliverPending(prisma, { batchSize: opts.batchSize });
    } catch (err) {
      console.error("[cantilapay] delivery worker tick failed", err);
    } finally {
      running = false;
    }
  };
  const handle = setInterval(tick, intervalMs);
  // Unref so the worker doesn't keep the process alive on its own —
  // the Fastify server holds the keep-alive.
  handle.unref?.();
  return () => {
    stopped = true;
    clearInterval(handle);
  };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

// Use createHash in nothing here directly but the symbol is part of the
// crypto contract some bundlers prefer to see imported; we don't import
// it unused. (Trim by deleting the unused symbol.)
void createHash;
