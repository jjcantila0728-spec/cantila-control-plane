/* ============================================================
   Cantilapay — event emission helper (plan §25, Phase 1).

   Every state change in the payment-intent / subscription / payout
   lifecycle ends with `emitCantilapayEvent`: it writes a
   `CantilapayEvent` row (the canonical record) and enqueues an
   outbound delivery for every subscribed tenant webhook in one
   atomic-ish call.

   `enqueueDelivery` from `webhooks-out.ts` is the lower-level
   primitive; this helper is the one-call surface the service
   layer (payment-intents.ts, refunds.ts, etc.) uses.
   ============================================================ */

import type { PrismaClient } from "@prisma/client";

import type { CantilapayMode } from "../types";
import { enqueueDelivery } from "./webhooks-out";

export interface EmitEventOptions {
  prisma: PrismaClient;
  cantilapayAccountId: string;
  mode: CantilapayMode;
  /** Cantilapay-shaped dotted event type, e.g. "payment_intent.succeeded". */
  type: string;
  /** Free-form payload. Serialised + persisted as the event body and
   *  delivered to subscribed tenant webhooks. */
  data: Record<string, unknown>;
}

export interface EmitEventResult {
  eventId: string;
  /** How many tenant webhook endpoints got a queued delivery. */
  scheduled: number;
}

/** Persist a Cantilapay event and enqueue outbound deliveries. */
export async function emitCantilapayEvent(
  opts: EmitEventOptions,
): Promise<EmitEventResult> {
  const row = await opts.prisma.cantilapayEvent.create({
    data: {
      cantilapayAccountId: opts.cantilapayAccountId,
      mode: opts.mode,
      type: opts.type,
      data: JSON.stringify(opts.data),
    },
  });
  const enq = await enqueueDelivery(opts.prisma, {
    cantilapayAccountId: opts.cantilapayAccountId,
    eventId: row.id,
    eventType: opts.type,
    mode: opts.mode,
  });
  return { eventId: row.id, scheduled: enq.scheduled };
}
