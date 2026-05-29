/* ============================================================
   Cantilapay — billing engine (plan §25, Phase 2).

   The single in-process tick that drives subscription lifecycle:

     1. Charge the first invoice for newly-created subscriptions
        (status='incomplete').
     2. Transition trialing subscriptions at `trialEnd` → active +
        first paid invoice.
     3. Roll over active subscriptions at `currentPeriodEnd`:
        generate the next invoice, charge it.
     4. Retry past_due subscriptions at `nextDunningAt`.
     5. After `MAX_DUNNING_ATTEMPTS` consecutive failures, cancel.

   Each transition emits the Stripe-shaped events:
     - invoice.created
     - invoice.payment_succeeded / invoice.payment_failed
     - invoice.paid
     - customer.subscription.updated
     - customer.subscription.deleted

   `tick(now?)` is the single entry. `startBillingEngineWorker`
   wires a setInterval; the smoke test calls `tick` directly with
   an injected `now` to fast-forward through periods.
   ============================================================ */

import type { PrismaClient } from "@prisma/client";

import type { PaymentProcessor } from "../adapters/port";
import type {
  CantilapayMode,
  CantilapayPriceInterval,
} from "../types";
import { emitCantilapayEvent } from "./events";
import { addPeriod } from "./subscriptions";
import { processPayouts } from "./payouts";
import { expireCheckoutSessions } from "./checkout-sessions";
import { expireBillingPortalSessions } from "./billing-portal-sessions";

const MAX_DUNNING_ATTEMPTS = 3;
const DUNNING_DELAYS_HOURS = [24, 72, 168]; // 1d, 3d, 7d

interface SubscriptionRow {
  id: string;
  cantilapayAccountId: string;
  mode: CantilapayMode;
  customerId: string;
  priceId: string;
  defaultPaymentMethodId: string | null;
  status: "incomplete" | "trialing" | "active" | "past_due" | "canceled" | "unpaid";
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  trialEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  dunningAttempts: number;
  nextDunningAt: Date | null;
}

interface PriceRow {
  id: string;
  unitAmount: number;
  currency: string;
  recurringInterval: CantilapayPriceInterval;
  recurringIntervalCount: number;
  productId: string;
}

export interface TickResult {
  initialCharges: { ok: number; failed: number };
  trialEnds: number;
  rollovers: { ok: number; failed: number };
  dunningRetries: { ok: number; failed: number };
  dunningCancels: number;
  /** Phase 3 — payouts scheduled and settled on this tick. */
  payouts: { scheduled: number; settled: number };
}

/** Run one billing tick. `now` defaults to wall-clock. */
export async function tick(
  prisma: PrismaClient,
  processor: PaymentProcessor,
  opts: { now?: Date; batchSize?: number } = {},
): Promise<TickResult> {
  const now = opts.now ?? new Date();
  const batchSize = Math.max(1, Math.min(opts.batchSize ?? 50, 200));
  const result: TickResult = {
    initialCharges: { ok: 0, failed: 0 },
    trialEnds: 0,
    rollovers: { ok: 0, failed: 0 },
    dunningRetries: { ok: 0, failed: 0 },
    dunningCancels: 0,
    payouts: { scheduled: 0, settled: 0 },
  };

  // 1) Initial charge for `incomplete` subs (no trial).
  const incompletes = await prisma.cantilapaySubscription.findMany({
    where: { status: "incomplete" },
    take: batchSize,
  });
  for (const sub of incompletes) {
    const outcome = await processSubscriptionCharge(prisma, processor, {
      subscription: sub,
      now,
      periodStart: sub.currentPeriodStart,
      periodEnd: sub.currentPeriodEnd,
    });
    if (outcome === "succeeded") result.initialCharges.ok += 1;
    else result.initialCharges.failed += 1;
  }

  // 2) Trial-end transition. Generate first paid invoice for the
  //    next period starting at trialEnd.
  const trialEnding = await prisma.cantilapaySubscription.findMany({
    where: {
      status: "trialing",
      trialEnd: { lte: now },
    },
    take: batchSize,
  });
  for (const sub of trialEnding) {
    result.trialEnds += 1;
    const price = await prisma.cantilapayPrice.findUnique({
      where: { id: sub.priceId },
    });
    if (!price) continue;
    const periodStart = sub.trialEnd ?? now;
    const periodEnd = addPeriod(
      periodStart,
      price.recurringInterval,
      price.recurringIntervalCount,
    );
    await prisma.cantilapaySubscription.update({
      where: { id: sub.id },
      data: {
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
      },
    });
    const updatedSub = (await prisma.cantilapaySubscription.findUnique({
      where: { id: sub.id },
    }))!;
    const outcome = await processSubscriptionCharge(prisma, processor, {
      subscription: updatedSub,
      now,
      periodStart,
      periodEnd,
    });
    if (outcome === "succeeded") result.rollovers.ok += 1;
    else result.rollovers.failed += 1;
  }

  // 3) Roll over active subs whose period is up.
  const renewals = await prisma.cantilapaySubscription.findMany({
    where: {
      status: "active",
      currentPeriodEnd: { lte: now },
    },
    take: batchSize,
  });
  for (const sub of renewals) {
    if (sub.cancelAtPeriodEnd) {
      await prisma.cantilapaySubscription.update({
        where: { id: sub.id },
        data: {
          status: "canceled",
          canceledAt: now,
          endedAt: now,
        },
      });
      await emitCantilapayEvent({
        prisma,
        cantilapayAccountId: sub.cantilapayAccountId,
        mode: sub.mode,
        type: "subscription.deleted",
        data: { id: sub.id, reason: "cancel_at_period_end" },
      });
      result.dunningCancels += 1;
      continue;
    }
    const price = await prisma.cantilapayPrice.findUnique({
      where: { id: sub.priceId },
    });
    if (!price) continue;
    const periodStart = sub.currentPeriodEnd;
    const periodEnd = addPeriod(
      periodStart,
      price.recurringInterval,
      price.recurringIntervalCount,
    );
    await prisma.cantilapaySubscription.update({
      where: { id: sub.id },
      data: {
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
      },
    });
    const updatedSub = (await prisma.cantilapaySubscription.findUnique({
      where: { id: sub.id },
    }))!;
    const outcome = await processSubscriptionCharge(prisma, processor, {
      subscription: updatedSub,
      now,
      periodStart,
      periodEnd,
    });
    if (outcome === "succeeded") result.rollovers.ok += 1;
    else result.rollovers.failed += 1;
  }

  // 4) Retry past_due. Find their unpaid invoice and recharge.
  const pastDue = await prisma.cantilapaySubscription.findMany({
    where: {
      status: "past_due",
      nextDunningAt: { lte: now },
    },
    take: batchSize,
  });
  for (const sub of pastDue) {
    const unpaid = await prisma.cantilapayInvoice.findFirst({
      where: {
        subscriptionId: sub.id,
        status: "open",
      },
      orderBy: { createdAt: "desc" },
    });
    if (!unpaid) {
      // No unpaid invoice — treat as recovered.
      await prisma.cantilapaySubscription.update({
        where: { id: sub.id },
        data: {
          status: "active",
          dunningAttempts: 0,
          nextDunningAt: null,
        },
      });
      continue;
    }
    const outcome = await retryInvoiceCharge(prisma, processor, {
      subscription: sub,
      invoice: unpaid,
      now,
    });
    if (outcome === "succeeded") {
      result.dunningRetries.ok += 1;
    } else if (outcome === "cancelled") {
      result.dunningCancels += 1;
    } else {
      result.dunningRetries.failed += 1;
    }
  }

  // Phase 3 — payouts. After all subscription billing has settled
  // for this tick, sweep available balances into payouts and settle
  // any that have reached their arrival date.
  result.payouts = await processPayouts(prisma, { now });

  // Phase 4 — session expiry sweep. Cheap; runs on every tick to
  // keep open-session counts tight.
  await expireCheckoutSessions(prisma, { now });
  await expireBillingPortalSessions(prisma, { now });

  return result;
}

/** Generate an invoice + invoice item for the given period, then
 *  attempt to charge it. Returns terminal outcome of the charge. */
async function processSubscriptionCharge(
  prisma: PrismaClient,
  processor: PaymentProcessor,
  args: {
    subscription: SubscriptionRow;
    periodStart: Date;
    periodEnd: Date;
    now: Date;
  },
): Promise<"succeeded" | "failed"> {
  const sub = args.subscription;
  const price = await prisma.cantilapayPrice.findUnique({
    where: { id: sub.priceId },
  });
  if (!price) return "failed";

  const invoice = await createOpenInvoice(prisma, {
    subscription: sub,
    price,
    periodStart: args.periodStart,
    periodEnd: args.periodEnd,
  });

  return chargeOpenInvoice(prisma, processor, {
    subscription: sub,
    invoice,
    price,
    now: args.now,
  });
}

/** Generate an Invoice + InvoiceItem in `open` status, ready to be
 *  charged. Emits `invoice.created`. */
async function createOpenInvoice(
  prisma: PrismaClient,
  args: {
    subscription: SubscriptionRow;
    price: PriceRow;
    periodStart: Date;
    periodEnd: Date;
  },
): Promise<{
  id: string;
  amountDue: number;
  currency: string;
  cantilapayAccountId: string;
  mode: CantilapayMode;
  customerId: string;
}> {
  const inv = await prisma.cantilapayInvoice.create({
    data: {
      cantilapayAccountId: args.subscription.cantilapayAccountId,
      mode: args.subscription.mode,
      subscriptionId: args.subscription.id,
      customerId: args.subscription.customerId,
      periodStart: args.periodStart,
      periodEnd: args.periodEnd,
      amountDue: args.price.unitAmount,
      currency: args.price.currency,
      status: "open",
      finalizedAt: new Date(),
      items: {
        create: [
          {
            amount: args.price.unitAmount,
            currency: args.price.currency,
            description: `Subscription ${args.subscription.id}`,
            priceId: args.price.id,
            periodStart: args.periodStart,
            periodEnd: args.periodEnd,
          },
        ],
      },
    },
  });
  await emitCantilapayEvent({
    prisma,
    cantilapayAccountId: args.subscription.cantilapayAccountId,
    mode: args.subscription.mode,
    type: "invoice.created",
    data: {
      id: inv.id,
      subscriptionId: args.subscription.id,
      amountDue: inv.amountDue,
      currency: inv.currency,
    },
  });
  return {
    id: inv.id,
    amountDue: inv.amountDue,
    currency: inv.currency,
    cantilapayAccountId: inv.cantilapayAccountId,
    mode: inv.mode,
    customerId: inv.customerId,
  };
}

/** Create a PaymentIntent + try to charge an open invoice. */
async function chargeOpenInvoice(
  prisma: PrismaClient,
  processor: PaymentProcessor,
  args: {
    subscription: SubscriptionRow;
    invoice: {
      id: string;
      amountDue: number;
      currency: string;
      cantilapayAccountId: string;
      mode: CantilapayMode;
      customerId: string;
    };
    price: PriceRow;
    now: Date;
  },
): Promise<"succeeded" | "failed"> {
  const sub = args.subscription;
  if (!sub.defaultPaymentMethodId) {
    return await markInvoiceFailureAndEnterDunning(prisma, {
      subscription: sub,
      invoice: args.invoice,
      now: args.now,
      errorCode: "no_payment_method",
      errorMessage: "Subscription has no default payment method.",
    });
  }
  const method = await prisma.cantilapayPaymentMethod.findUnique({
    where: { id: sub.defaultPaymentMethodId },
  });
  if (!method || method.status !== "chargeable") {
    return await markInvoiceFailureAndEnterDunning(prisma, {
      subscription: sub,
      invoice: args.invoice,
      now: args.now,
      errorCode: "payment_method_unavailable",
      errorMessage: "Default payment method is not chargeable.",
    });
  }
  const account = await prisma.cantilapayAccount.findUnique({
    where: { id: sub.cantilapayAccountId },
  });
  if (!account) return "failed";
  const subMerchantId =
    sub.mode === "test"
      ? account.adyenAccountHolderIdTest
      : account.adyenAccountHolderIdLive;
  const platformFee = Math.floor((args.invoice.amountDue * account.platformFeeBps) / 10000);

  // Create the PaymentIntent row that backs this charge.
  const intent = await prisma.cantilapayPaymentIntent.create({
    data: {
      cantilapayAccountId: sub.cantilapayAccountId,
      mode: sub.mode,
      customerId: sub.customerId,
      paymentMethodId: method.id,
      amount: args.invoice.amountDue,
      currency: args.invoice.currency,
      captureMode: "automatic",
      status: "processing",
      platformFeeAmount: platformFee,
      description: `Subscription ${sub.id} renewal`,
      metadata: JSON.stringify({ subscriptionId: sub.id, invoiceId: args.invoice.id }),
    },
  });
  await prisma.cantilapayInvoice.update({
    where: { id: args.invoice.id },
    data: { paymentIntentId: intent.id },
  });

  const psp = await processor.confirmPayment({
    subMerchantId: subMerchantId ?? "",
    paymentIntentId: intent.id,
    amount: args.invoice.amountDue,
    currency: args.invoice.currency,
    paymentMethodToken: method.pspToken,
    captureMode: "automatic",
    mode: sub.mode,
    platformFeeAmount: platformFee,
  });

  if (psp.status === "succeeded") {
    await prisma.cantilapayPaymentIntent.update({
      where: { id: intent.id },
      data: {
        status: "succeeded",
        amountCaptured: args.invoice.amountDue,
        pspPaymentRef: psp.pspPaymentRef,
        confirmedAt: args.now,
        capturedAt: args.now,
        succeededAt: args.now,
      },
    });
    await prisma.cantilapayInvoice.update({
      where: { id: args.invoice.id },
      data: {
        status: "paid",
        amountPaid: args.invoice.amountDue,
        paidAt: args.now,
        attempts: { increment: 1 },
      },
    });
    await prisma.cantilapaySubscription.update({
      where: { id: sub.id },
      data: {
        status: "active",
        dunningAttempts: 0,
        nextDunningAt: null,
      },
    });
    await emitCantilapayEvent({
      prisma,
      cantilapayAccountId: sub.cantilapayAccountId,
      mode: sub.mode,
      type: "invoice.payment_succeeded",
      data: { id: args.invoice.id, amount: args.invoice.amountDue },
    });
    await emitCantilapayEvent({
      prisma,
      cantilapayAccountId: sub.cantilapayAccountId,
      mode: sub.mode,
      type: "subscription.renewed",
      data: { id: sub.id },
    });
    return "succeeded";
  }

  // psp.status === "failed" (other states aren't reachable from
  // automatic-capture in Phase 1; treated as failure here).
  await prisma.cantilapayPaymentIntent.update({
    where: { id: intent.id },
    data: {
      status: "failed",
      failedAt: args.now,
      pspPaymentRef: psp.pspPaymentRef,
      lastError: JSON.stringify({
        code: psp.errorCode ?? "card_declined",
        message: psp.errorMessage ?? "Renewal charge failed.",
        declineCode: psp.declineCode,
      }),
    },
  });
  return await markInvoiceFailureAndEnterDunning(prisma, {
    subscription: sub,
    invoice: args.invoice,
    now: args.now,
    errorCode: psp.errorCode ?? "card_declined",
    errorMessage: psp.errorMessage ?? "Renewal charge failed.",
  });
}

/** Update invoice + subscription state on a failed charge; schedule
 *  the next dunning retry or cancel after the cap. */
async function markInvoiceFailureAndEnterDunning(
  prisma: PrismaClient,
  args: {
    subscription: SubscriptionRow;
    invoice: { id: string; cantilapayAccountId: string; mode: CantilapayMode };
    now: Date;
    errorCode: string;
    errorMessage: string;
  },
): Promise<"failed"> {
  const sub = args.subscription;
  const nextAttempt = sub.dunningAttempts + 1;
  await prisma.cantilapayInvoice.update({
    where: { id: args.invoice.id },
    data: {
      attempts: { increment: 1 },
      lastError: JSON.stringify({
        code: args.errorCode,
        message: args.errorMessage,
      }),
    },
  });
  await emitCantilapayEvent({
    prisma,
    cantilapayAccountId: args.invoice.cantilapayAccountId,
    mode: args.invoice.mode,
    type: "invoice.payment_failed",
    data: { id: args.invoice.id, errorCode: args.errorCode },
  });
  if (nextAttempt >= MAX_DUNNING_ATTEMPTS) {
    await prisma.cantilapaySubscription.update({
      where: { id: sub.id },
      data: {
        status: "canceled",
        canceledAt: args.now,
        endedAt: args.now,
        dunningAttempts: nextAttempt,
        nextDunningAt: null,
      },
    });
    await emitCantilapayEvent({
      prisma,
      cantilapayAccountId: sub.cantilapayAccountId,
      mode: sub.mode,
      type: "subscription.deleted",
      data: { id: sub.id, reason: "dunning_exhausted" },
    });
    return "failed";
  }
  const delayHours = DUNNING_DELAYS_HOURS[Math.min(nextAttempt - 1, DUNNING_DELAYS_HOURS.length - 1)];
  await prisma.cantilapaySubscription.update({
    where: { id: sub.id },
    data: {
      status: "past_due",
      dunningAttempts: nextAttempt,
      nextDunningAt: new Date(args.now.getTime() + delayHours * 3600 * 1000),
    },
  });
  await emitCantilapayEvent({
    prisma,
    cantilapayAccountId: sub.cantilapayAccountId,
    mode: sub.mode,
    type: "subscription.updated",
    data: { id: sub.id, status: "past_due", dunningAttempts: nextAttempt },
  });
  return "failed";
}

/** Recharge an open invoice that's already in dunning. */
async function retryInvoiceCharge(
  prisma: PrismaClient,
  processor: PaymentProcessor,
  args: {
    subscription: SubscriptionRow;
    invoice: { id: string; amountDue: number; currency: string; cantilapayAccountId: string; mode: CantilapayMode; customerId: string };
    now: Date;
  },
): Promise<"succeeded" | "failed" | "cancelled"> {
  const sub = args.subscription;
  const price = await prisma.cantilapayPrice.findUnique({
    where: { id: sub.priceId },
  });
  if (!price) return "failed";
  const outcome = await chargeOpenInvoice(prisma, processor, {
    subscription: sub,
    invoice: args.invoice,
    price,
    now: args.now,
  });
  // chargeOpenInvoice's failure branch already incremented dunningAttempts.
  // Re-read the sub to see if it's been cancelled by the cap.
  const after = await prisma.cantilapaySubscription.findUnique({
    where: { id: sub.id },
  });
  if (outcome === "succeeded") return "succeeded";
  if (after?.status === "canceled") return "cancelled";
  return "failed";
}

/** Wire a polling worker that runs `tick` on an interval. Returns a
 *  stop function. Defaults to a 60-second cadence. */
export function startBillingEngineWorker(
  prisma: PrismaClient,
  processor: PaymentProcessor,
  opts: { intervalMs?: number; batchSize?: number } = {},
): () => void {
  const intervalMs = Math.max(10_000, opts.intervalMs ?? 60_000);
  let stopped = false;
  let running = false;
  const run = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await tick(prisma, processor, { batchSize: opts.batchSize });
    } catch (err) {
      console.error("[cantilapay] billing engine tick failed", err);
    } finally {
      running = false;
    }
  };
  const handle = setInterval(run, intervalMs);
  handle.unref?.();
  return () => {
    stopped = true;
    clearInterval(handle);
  };
}
