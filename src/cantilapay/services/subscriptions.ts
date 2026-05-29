/* ============================================================
   Cantilapay — Subscription service (plan §25, Phase 2).

   Creates subscriptions and exposes the read/lifecycle surface.
   The recurring-charge engine itself lives in
   `services/billing-engine.ts` — this file only handles synchronous
   request-time changes: create, cancel, update_default_payment_method.

   On create:
     - With a trial: status='trialing', currentPeriodStart/End = trial
       window, trialStart/End set; first paid invoice generates when
       the engine tick crosses trialEnd.
     - Without a trial: status='incomplete', currentPeriodStart=now,
       currentPeriodEnd=now+interval. The engine tick immediately
       generates + charges the first invoice; on success status moves
       to 'active'.
   ============================================================ */

import type { PrismaClient } from "@prisma/client";

import type {
  CantilapayMode,
  CantilapayPriceInterval,
  CantilapaySubscriptionStatus,
  CantilapaySubscriptionView,
} from "../types";
import { CantilapayError } from "../errors";
import { emitCantilapayEvent } from "./events";

function toView(row: {
  id: string;
  mode: CantilapayMode;
  customerId: string;
  priceId: string;
  defaultPaymentMethodId: string | null;
  status: CantilapaySubscriptionStatus;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  trialStart: Date | null;
  trialEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: Date | null;
  endedAt: Date | null;
  metadata: string;
  createdAt: Date;
  updatedAt: Date;
}): CantilapaySubscriptionView {
  return {
    id: row.id,
    mode: row.mode,
    customerId: row.customerId,
    priceId: row.priceId,
    defaultPaymentMethodId: row.defaultPaymentMethodId,
    status: row.status,
    currentPeriodStart: row.currentPeriodStart.toISOString(),
    currentPeriodEnd: row.currentPeriodEnd.toISOString(),
    trialStart: row.trialStart ? row.trialStart.toISOString() : null,
    trialEnd: row.trialEnd ? row.trialEnd.toISOString() : null,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    canceledAt: row.canceledAt ? row.canceledAt.toISOString() : null,
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
    metadata: parseMetadata(row.metadata),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function parseMetadata(s: string): Record<string, string> {
  try {
    const parsed = JSON.parse(s) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        out[k] = typeof v === "string" ? v : String(v);
      }
      return out;
    }
  } catch {
    /* fall through */
  }
  return {};
}

/** Advance a date by N intervals. Phase 2 uses calendar-naive math:
 *  +1 month uses JS Date.setMonth which handles end-of-month correctly. */
export function addPeriod(
  d: Date,
  interval: CantilapayPriceInterval,
  count: number,
): Date {
  const out = new Date(d.getTime());
  switch (interval) {
    case "day":
      out.setUTCDate(out.getUTCDate() + count);
      break;
    case "week":
      out.setUTCDate(out.getUTCDate() + 7 * count);
      break;
    case "month":
      out.setUTCMonth(out.getUTCMonth() + count);
      break;
    case "year":
      out.setUTCFullYear(out.getUTCFullYear() + count);
      break;
  }
  return out;
}

export interface CreateSubscriptionInput {
  cantilapayAccountId: string;
  mode: CantilapayMode;
  customerId: string;
  priceId: string;
  defaultPaymentMethodId?: string;
  /** Overrides the price's default trial. 0 disables trial entirely. */
  trialPeriodDays?: number;
  metadata?: Record<string, string>;
  /** Optional "fixed start" — defaults to now. The smoke test uses
   *  this to seed deterministic period boundaries. */
  now?: Date;
}

export async function createSubscription(
  prisma: PrismaClient,
  input: CreateSubscriptionInput,
): Promise<CantilapaySubscriptionView> {
  const customer = await prisma.cantilapayCustomer.findUnique({
    where: { id: input.customerId },
  });
  if (
    !customer ||
    customer.cantilapayAccountId !== input.cantilapayAccountId ||
    customer.mode !== input.mode
  ) {
    throw CantilapayError.notFound("customer");
  }
  const price = await prisma.cantilapayPrice.findUnique({
    where: { id: input.priceId },
  });
  if (
    !price ||
    price.cantilapayAccountId !== input.cantilapayAccountId ||
    price.mode !== input.mode ||
    !price.active
  ) {
    throw CantilapayError.notFound("price");
  }
  if (input.defaultPaymentMethodId) {
    const pm = await prisma.cantilapayPaymentMethod.findUnique({
      where: { id: input.defaultPaymentMethodId },
    });
    if (
      !pm ||
      pm.cantilapayAccountId !== input.cantilapayAccountId ||
      pm.mode !== input.mode ||
      pm.status !== "chargeable"
    ) {
      throw CantilapayError.notFound("payment method");
    }
  }
  const now = input.now ?? new Date();
  const trialDays = input.trialPeriodDays ?? price.trialPeriodDays;
  let status: CantilapaySubscriptionStatus;
  let currentPeriodStart: Date;
  let currentPeriodEnd: Date;
  let trialStart: Date | null = null;
  let trialEnd: Date | null = null;
  if (trialDays > 0) {
    status = "trialing";
    trialStart = now;
    trialEnd = addPeriod(now, "day", trialDays);
    currentPeriodStart = now;
    currentPeriodEnd = trialEnd;
  } else {
    status = "incomplete";
    currentPeriodStart = now;
    currentPeriodEnd = addPeriod(
      now,
      price.recurringInterval,
      price.recurringIntervalCount,
    );
  }
  const row = await prisma.cantilapaySubscription.create({
    data: {
      cantilapayAccountId: input.cantilapayAccountId,
      mode: input.mode,
      customerId: input.customerId,
      priceId: input.priceId,
      defaultPaymentMethodId: input.defaultPaymentMethodId ?? null,
      status,
      currentPeriodStart,
      currentPeriodEnd,
      trialStart,
      trialEnd,
      metadata: JSON.stringify(input.metadata ?? {}),
    },
  });
  await emitCantilapayEvent({
    prisma,
    cantilapayAccountId: input.cantilapayAccountId,
    mode: input.mode,
    type: "subscription.created",
    data: {
      id: row.id,
      customerId: row.customerId,
      priceId: row.priceId,
      status: row.status,
    },
  });
  return toView(row);
}

export async function getSubscription(
  prisma: PrismaClient,
  input: { cantilapayAccountId: string; mode: CantilapayMode; id: string },
): Promise<CantilapaySubscriptionView | null> {
  const row = await prisma.cantilapaySubscription.findUnique({
    where: { id: input.id },
  });
  if (
    !row ||
    row.cantilapayAccountId !== input.cantilapayAccountId ||
    row.mode !== input.mode
  ) {
    return null;
  }
  return toView(row);
}

export async function listSubscriptions(
  prisma: PrismaClient,
  input: {
    cantilapayAccountId: string;
    mode: CantilapayMode;
    customerId?: string;
    status?: CantilapaySubscriptionStatus;
    limit?: number;
  },
): Promise<CantilapaySubscriptionView[]> {
  const take = Math.max(1, Math.min(input.limit ?? 50, 100));
  const rows = await prisma.cantilapaySubscription.findMany({
    where: {
      cantilapayAccountId: input.cantilapayAccountId,
      mode: input.mode,
      customerId: input.customerId ?? undefined,
      status: input.status ?? undefined,
    },
    orderBy: { createdAt: "desc" },
    take,
  });
  return rows.map(toView);
}

export async function updateSubscription(
  prisma: PrismaClient,
  input: {
    cantilapayAccountId: string;
    mode: CantilapayMode;
    id: string;
    cancelAtPeriodEnd?: boolean;
    defaultPaymentMethodId?: string | null;
    metadata?: Record<string, string>;
  },
): Promise<CantilapaySubscriptionView> {
  const existing = await prisma.cantilapaySubscription.findUnique({
    where: { id: input.id },
  });
  if (
    !existing ||
    existing.cantilapayAccountId !== input.cantilapayAccountId ||
    existing.mode !== input.mode
  ) {
    throw CantilapayError.notFound("subscription");
  }
  const row = await prisma.cantilapaySubscription.update({
    where: { id: input.id },
    data: {
      cancelAtPeriodEnd:
        input.cancelAtPeriodEnd !== undefined
          ? input.cancelAtPeriodEnd
          : existing.cancelAtPeriodEnd,
      defaultPaymentMethodId:
        input.defaultPaymentMethodId !== undefined
          ? input.defaultPaymentMethodId
          : existing.defaultPaymentMethodId,
      metadata:
        input.metadata !== undefined
          ? JSON.stringify(input.metadata)
          : existing.metadata,
    },
  });
  await emitCantilapayEvent({
    prisma,
    cantilapayAccountId: input.cantilapayAccountId,
    mode: input.mode,
    type: "subscription.updated",
    data: { id: row.id, cancelAtPeriodEnd: row.cancelAtPeriodEnd },
  });
  return toView(row);
}

export async function cancelSubscription(
  prisma: PrismaClient,
  input: {
    cantilapayAccountId: string;
    mode: CantilapayMode;
    id: string;
    /** When true, mark cancelAtPeriodEnd and let the engine finalise.
     *  When false (default), immediately cancel. */
    atPeriodEnd?: boolean;
  },
): Promise<CantilapaySubscriptionView> {
  const existing = await prisma.cantilapaySubscription.findUnique({
    where: { id: input.id },
  });
  if (
    !existing ||
    existing.cantilapayAccountId !== input.cantilapayAccountId ||
    existing.mode !== input.mode
  ) {
    throw CantilapayError.notFound("subscription");
  }
  if (
    existing.status === "canceled" ||
    existing.status === "unpaid"
  ) {
    return toView(existing);
  }
  if (input.atPeriodEnd) {
    const row = await prisma.cantilapaySubscription.update({
      where: { id: input.id },
      data: { cancelAtPeriodEnd: true },
    });
    await emitCantilapayEvent({
      prisma,
      cantilapayAccountId: input.cantilapayAccountId,
      mode: input.mode,
      type: "subscription.updated",
      data: { id: row.id, cancelAtPeriodEnd: true },
    });
    return toView(row);
  }
  const now = new Date();
  const row = await prisma.cantilapaySubscription.update({
    where: { id: input.id },
    data: {
      status: "canceled",
      canceledAt: now,
      endedAt: now,
      cancelAtPeriodEnd: false,
    },
  });
  await emitCantilapayEvent({
    prisma,
    cantilapayAccountId: input.cantilapayAccountId,
    mode: input.mode,
    type: "subscription.deleted",
    data: { id: row.id },
  });
  return toView(row);
}
