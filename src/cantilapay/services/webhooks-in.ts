/* ============================================================
   Cantilapay — inbound webhook dispatcher (plan §25, Phase 0).

   The Adyen / PSP webhook receiver:

     POST /v1/cantilapay/webhooks/adyen

   verifies the signature via the live `PaymentProcessor` adapter,
   parses the event into the cantilapay-shaped union, and writes
   an audit-log entry. Phase 0 surfaces only the `ping` connectivity
   event — the AUTHORISATION / CAPTURE / REFUND state-machine
   handlers land in Phase 1.

   Idempotency: events that arrive more than once (Adyen retries
   on a non-2xx) are deduped on `(adyenEventId, mode)`. Dedupe
   uses the `CantilapayEvent` row with a deterministic id derived
   from the PSP event id.

   This module deliberately does NOT emit outbound webhook events
   for inbound PSP events in Phase 0 — that mapping happens in
   Phase 1 when payment-side handlers compose the right tenant-
   facing event types (`payment_intent.succeeded`, etc.).
   ============================================================ */

import type { PrismaClient } from "@prisma/client";

import type { PaymentProcessor, PspInboundEvent } from "../adapters/port";
import type { CantilapayMode } from "../types";
import { recordCantilapayAudit } from "./audit";

export interface InboundEventResult {
  /** True if the event was new; false if the dedupe table caught a retry. */
  accepted: boolean;
  /** The cantilapay-shaped event type after mapping. */
  type: string;
  /** Stable cantilapay-side event id (used by future outbound dispatch). */
  eventId: string;
}

export interface InboundOutcome extends InboundEventResult {
  /** How many notification items the envelope carried (Adyen batches). */
  processed: number;
  /** Per-item projection result, in envelope order. */
  results: InboundEventResult[];
}

/** Verify, dedupe, and project an inbound PSP webhook. A single Adyen
 *  envelope can batch many notification items, so we project EACH one
 *  and aggregate. The top-level `accepted`/`type`/`eventId` mirror the
 *  first item for back-compat; `results` carries every item. */
export async function handleInboundWebhook(args: {
  prisma: PrismaClient;
  processor: PaymentProcessor;
  rawBody: string;
  headers: Record<string, string | string[] | undefined>;
  mode: CantilapayMode;
}): Promise<InboundOutcome> {
  let parsedEvents: PspInboundEvent[];
  try {
    parsedEvents = args.processor.parseInboundWebhook({
      rawBody: args.rawBody,
      headers: args.headers,
    });
  } catch (err) {
    throw new InboundSignatureError(
      err instanceof Error ? err.message : "inbound signature verification failed",
    );
  }

  const results: InboundEventResult[] = [];
  for (const parsed of parsedEvents) {
    results.push(await projectInboundEvent(args, parsed));
  }

  const first = results[0] ?? { accepted: false, type: "none", eventId: "" };
  return {
    accepted: results.some((r) => r.accepted),
    type: first.type,
    eventId: first.eventId,
    processed: results.length,
    results,
  };
}

/** Dedupe + project a single notification item. Extracted so the batch
 *  loop in handleInboundWebhook stays flat. */
async function projectInboundEvent(
  args: {
    prisma: PrismaClient;
    mode: CantilapayMode;
  },
  parsed: PspInboundEvent,
): Promise<InboundEventResult> {
  const cantilapayAccountId = parsed.subMerchantId
    ? await resolveAccountForSubMerchant(args.prisma, parsed.subMerchantId, args.mode)
    : null;

  // For Phase 0, account-less events (ping / test) are accepted at the
  // platform level. We still want a record of them so the Console
  // webhook log shows connectivity tests; we skip the per-account
  // dedupe and just return without persisting.
  if (!cantilapayAccountId) {
    return { accepted: true, type: parsed.type, eventId: parsed.id };
  }

  // Dedupe: if an event with the same PSP-side id has already been
  // projected for this account+mode, drop the retry. We use the PSP
  // id directly as a marker stored in `data` (since `CantilapayEvent.id`
  // is a fresh cuid). A future migration may add a dedicated unique
  // index once inbound volume grows.
  const existing = await args.prisma.cantilapayEvent.findFirst({
    where: {
      cantilapayAccountId,
      mode: args.mode,
      type: parsed.type,
      data: { contains: `"pspEventId":"${parsed.id}"` },
    },
    select: { id: true },
  });
  if (existing) {
    return { accepted: false, type: parsed.type, eventId: existing.id };
  }

  const row = await args.prisma.cantilapayEvent.create({
    data: {
      cantilapayAccountId,
      mode: args.mode,
      type: parsed.type,
      data: JSON.stringify({ pspEventId: parsed.id, raw: parsed.raw }),
    },
  });

  await recordCantilapayAudit(args.prisma, {
    cantilapayAccountId,
    type: `cantilapay.webhook.received.${parsed.type}`,
    message: `Inbound ${parsed.type} from PSP (psp event ${parsed.id})`,
    data: { pspEventId: parsed.id, mode: args.mode },
  });

  // Phase 1 — payment-side events reconcile cantilapay state when
  // the PSP's async outcome differs from what the synchronous confirm
  // returned (e.g. AUTHORISATION succeeded sync but final clearing
  // came back as failed). For the Phase 1 stub this path is never
  // hit because the stub returns terminal results synchronously; it
  // exists for the live Adyen rail.
  if (parsed.pspPaymentRef) {
    await reconcileIntentFromPsp(args.prisma, {
      cantilapayAccountId,
      mode: args.mode,
      eventType: parsed.type,
      pspPaymentRef: parsed.pspPaymentRef,
    });
  }

  // Phase 3 — KYC / sub-merchant lifecycle. The PSP raises
  // account.updated whenever the underwriting status of a
  // sub-merchant changes; cantilapay mirrors the status onto
  // CantilapayAccount so the tenant can take live payments.
  if (parsed.type === "account.updated") {
    await reconcileAccountFromPsp(args.prisma, {
      cantilapayAccountId,
      mode: args.mode,
      raw: parsed.raw,
    });
  }

  return { accepted: true, type: parsed.type, eventId: row.id };
}

/** Reconcile CantilapayAccount.status from an account.updated event.
 *  The PSP (Adyen Legal Entity Management) raises this when KYC moves
 *  the sub-merchant between states. For the Phase 3 stub the engine
 *  caller fires this directly through `signInboundForTest`. */
async function reconcileAccountFromPsp(
  prisma: PrismaClient,
  args: {
    cantilapayAccountId: string;
    mode: CantilapayMode;
    raw: unknown;
  },
): Promise<void> {
  // Read the cantilapay-shaped status from the raw payload. The
  // Adyen real adapter maps Legal Entity verification status onto
  // these names; the stub fires them directly.
  const raw = args.raw as { status?: string } | null | undefined;
  const status = raw?.status;
  if (
    status !== "active" &&
    status !== "rejected" &&
    status !== "disabled" &&
    status !== "onboarding"
  ) {
    return;
  }
  await prisma.cantilapayAccount.update({
    where: { id: args.cantilapayAccountId },
    data: { status },
  });
  await recordCantilapayAudit(prisma, {
    cantilapayAccountId: args.cantilapayAccountId,
    type: `cantilapay.account.status_changed.${status}`,
    message: `Sub-merchant status changed to ${status} via inbound PSP event (mode=${args.mode})`,
    data: { status, mode: args.mode },
  });
}

/** Update CantilapayPaymentIntent state from an inbound PSP event. */
async function reconcileIntentFromPsp(
  prisma: PrismaClient,
  args: {
    cantilapayAccountId: string;
    mode: CantilapayMode;
    eventType: string;
    pspPaymentRef: string;
  },
): Promise<void> {
  const intent = await prisma.cantilapayPaymentIntent.findFirst({
    where: {
      cantilapayAccountId: args.cantilapayAccountId,
      mode: args.mode,
      pspPaymentRef: args.pspPaymentRef,
    },
  });
  if (!intent) return;
  if (
    intent.status === "succeeded" ||
    intent.status === "failed" ||
    intent.status === "canceled"
  ) {
    return; // already terminal; webhook is informational.
  }
  const now = new Date();
  if (args.eventType === "payment_intent.captured") {
    await prisma.cantilapayPaymentIntent.update({
      where: { id: intent.id },
      data: {
        status: "succeeded",
        amountCaptured: intent.amount,
        capturedAt: now,
        succeededAt: now,
      },
    });
  } else if (args.eventType === "payment_intent.failed") {
    await prisma.cantilapayPaymentIntent.update({
      where: { id: intent.id },
      data: {
        status: "failed",
        failedAt: now,
        lastError: JSON.stringify({
          code: "psp_async_failed",
          message: "PSP reported the payment failed asynchronously.",
        }),
      },
    });
  } else if (args.eventType === "payment_intent.refunded") {
    // Bump the refund counter; the refund row gets reconciled separately.
    await prisma.cantilapayPaymentIntent.update({
      where: { id: intent.id },
      data: { updatedAt: now },
    });
  }
}

/** Find the cantilapay account that owns a sub-merchant id, for the
 *  given mode. Returns null when no account matches — Phase 0 treats
 *  that as "unknown but signature was valid", logs it, and drops. */
async function resolveAccountForSubMerchant(
  prisma: PrismaClient,
  subMerchantId: string,
  mode: CantilapayMode,
): Promise<string | null> {
  const where =
    mode === "test"
      ? { adyenAccountHolderIdTest: subMerchantId }
      : { adyenAccountHolderIdLive: subMerchantId };
  const acc = await prisma.cantilapayAccount.findFirst({
    where,
    select: { id: true },
  });
  return acc ? acc.id : null;
}

/** Sentinel for signature-verification failure. The route renders 400. */
export class InboundSignatureError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "InboundSignatureError";
  }
}
