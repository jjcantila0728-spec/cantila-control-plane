/* ============================================================
   Cantilapay — Checkout Session service (plan §25, Phase 4).

   A checkout session is the tenant's entry point for hosted /
   embedded payment flows. The tenant calls
   `POST /v1/cantilapay/checkout/sessions` server-side, gets back
   a session id + URL (hosted) or clientSecret (embedded), and
   hands the redirect / SDK mount to their end-customer.

   On completion the session's `complete` action provisions the
   underlying resource:

     sessionMode='payment'      → CantilapayPaymentIntent (confirmed)
     sessionMode='subscription' → CantilapaySubscription (incomplete →
                                   active via the billing-engine tick)

   The Cantila-served hosted page itself lives in
   `cantila-console` and is wired in Phase 6.
   ============================================================ */

import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

import type { PaymentProcessor } from "../adapters/port";
import type {
  CantilapayCheckoutPaymentItem,
  CantilapayCheckoutSessionMode,
  CantilapayCheckoutSessionStatus,
  CantilapayCheckoutSessionView,
  CantilapayCheckoutSubscriptionItem,
  CantilapayCheckoutUiMode,
  CantilapayMode,
} from "../types";
import { CantilapayError } from "../errors";
import { emitCantilapayEvent } from "./events";
import {
  confirmPaymentIntent,
  createPaymentIntent,
} from "./payment-intents";
import { createSubscription } from "./subscriptions";

const TTL_MS = 24 * 60 * 60 * 1000;

interface CheckoutSessionRow {
  id: string;
  mode: CantilapayMode;
  sessionMode: CantilapayCheckoutSessionMode;
  status: CantilapayCheckoutSessionStatus;
  uiMode: CantilapayCheckoutUiMode;
  customerId: string | null;
  lineItems: string;
  currency: string;
  amountTotal: number;
  successUrl: string;
  cancelUrl: string | null;
  returnUrl: string | null;
  paymentIntentId: string | null;
  subscriptionId: string | null;
  url: string | null;
  clientSecret: string | null;
  expiresAt: Date;
  completedAt: Date | null;
  metadata: string;
  createdAt: Date;
  updatedAt: Date;
}

function parseItems(
  raw: string,
): Array<CantilapayCheckoutPaymentItem | CantilapayCheckoutSubscriptionItem> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed as Array<
        CantilapayCheckoutPaymentItem | CantilapayCheckoutSubscriptionItem
      >;
    }
  } catch {
    /* fall through */
  }
  return [];
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

function toView(row: CheckoutSessionRow): CantilapayCheckoutSessionView {
  return {
    id: row.id,
    mode: row.mode,
    sessionMode: row.sessionMode,
    status: row.status,
    uiMode: row.uiMode,
    customerId: row.customerId,
    lineItems: parseItems(row.lineItems),
    currency: row.currency,
    amountTotal: row.amountTotal,
    successUrl: row.successUrl,
    cancelUrl: row.cancelUrl,
    returnUrl: row.returnUrl,
    paymentIntentId: row.paymentIntentId,
    subscriptionId: row.subscriptionId,
    url: row.url,
    clientSecret: row.clientSecret,
    expiresAt: row.expiresAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    metadata: parseMetadata(row.metadata),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function checkoutUrlFor(sessionId: string, env = process.env): string {
  const base = env.CANTILAPAY_CHECKOUT_BASE_URL?.trim() || "https://pay.cantila.com";
  return `${base.replace(/\/$/, "")}/c/${sessionId}`;
}

function newClientSecret(sessionId: string): string {
  return `${sessionId}_secret_${randomBytes(16).toString("hex")}`;
}

export interface CreateCheckoutSessionInput {
  cantilapayAccountId: string;
  mode: CantilapayMode;
  sessionMode: CantilapayCheckoutSessionMode;
  uiMode?: CantilapayCheckoutUiMode;
  customerId?: string;
  successUrl: string;
  cancelUrl?: string;
  returnUrl?: string;
  currency: string;
  paymentItems?: CantilapayCheckoutPaymentItem[];
  subscriptionItems?: CantilapayCheckoutSubscriptionItem[];
  metadata?: Record<string, string>;
}

export async function createCheckoutSession(
  prisma: PrismaClient,
  input: CreateCheckoutSessionInput,
): Promise<CantilapayCheckoutSessionView> {
  if (!/^[a-z]{3}$/.test(input.currency)) {
    throw CantilapayError.invalidField("currency must be ISO-4217 lowercase", "currency");
  }
  let lineItems: Array<
    CantilapayCheckoutPaymentItem | CantilapayCheckoutSubscriptionItem
  > = [];
  let amountTotal = 0;
  if (input.sessionMode === "payment") {
    const items = input.paymentItems ?? [];
    if (items.length === 0) {
      throw CantilapayError.invalidField(
        "payment-mode sessions require at least one paymentItem",
        "paymentItems",
      );
    }
    for (const it of items) {
      if (!Number.isInteger(it.amount) || it.amount <= 0) {
        throw CantilapayError.invalidField(
          "paymentItem.amount must be a positive integer in minor units",
          "paymentItems",
        );
      }
      if (it.currency !== input.currency) {
        throw CantilapayError.invalidField(
          `paymentItem.currency '${it.currency}' must match session currency '${input.currency}'`,
          "paymentItems",
        );
      }
      const qty = it.quantity ?? 1;
      amountTotal += it.amount * qty;
    }
    lineItems = items;
  } else if (input.sessionMode === "subscription") {
    const items = input.subscriptionItems ?? [];
    if (items.length === 0) {
      throw CantilapayError.invalidField(
        "subscription-mode sessions require at least one subscriptionItem",
        "subscriptionItems",
      );
    }
    for (const it of items) {
      const price = await prisma.cantilapayPrice.findUnique({
        where: { id: it.priceId },
      });
      if (
        !price ||
        price.cantilapayAccountId !== input.cantilapayAccountId ||
        price.mode !== input.mode ||
        !price.active
      ) {
        throw CantilapayError.notFound(`price ${it.priceId}`);
      }
      if (price.currency !== input.currency) {
        throw CantilapayError.invalidField(
          `price '${it.priceId}' has currency '${price.currency}' but session currency is '${input.currency}'`,
          "subscriptionItems",
        );
      }
      const qty = it.quantity ?? 1;
      amountTotal += price.unitAmount * qty;
    }
    lineItems = items;
  } else if (input.sessionMode === "setup") {
    // setup-mode is reserved for save-card-for-future-use; Phase 4
    // skeletons it but leaves the create path with an empty line
    // items array.
    lineItems = [];
  }

  if (input.customerId) {
    const c = await prisma.cantilapayCustomer.findUnique({
      where: { id: input.customerId },
    });
    if (
      !c ||
      c.cantilapayAccountId !== input.cantilapayAccountId ||
      c.mode !== input.mode
    ) {
      throw CantilapayError.notFound("customer");
    }
  }

  const uiMode = input.uiMode ?? "hosted";
  const expiresAt = new Date(Date.now() + TTL_MS);

  const row = await prisma.cantilapayCheckoutSession.create({
    data: {
      cantilapayAccountId: input.cantilapayAccountId,
      mode: input.mode,
      sessionMode: input.sessionMode,
      uiMode,
      customerId: input.customerId ?? null,
      lineItems: JSON.stringify(lineItems),
      currency: input.currency,
      amountTotal,
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl ?? null,
      returnUrl: input.returnUrl ?? null,
      expiresAt,
      metadata: JSON.stringify(input.metadata ?? {}),
    },
  });
  const url = uiMode === "hosted" ? checkoutUrlFor(row.id) : null;
  const clientSecret = uiMode === "embedded" ? newClientSecret(row.id) : null;
  const finalised = await prisma.cantilapayCheckoutSession.update({
    where: { id: row.id },
    data: { url, clientSecret },
  });
  await emitCantilapayEvent({
    prisma,
    cantilapayAccountId: input.cantilapayAccountId,
    mode: input.mode,
    type: "checkout.session.created",
    data: {
      id: row.id,
      sessionMode: input.sessionMode,
      uiMode,
      amountTotal,
      currency: input.currency,
    },
  });
  return toView(finalised);
}

export async function getCheckoutSession(
  prisma: PrismaClient,
  input: { cantilapayAccountId: string; mode: CantilapayMode; id: string },
): Promise<CantilapayCheckoutSessionView | null> {
  const row = await prisma.cantilapayCheckoutSession.findUnique({
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

export async function listCheckoutSessions(
  prisma: PrismaClient,
  input: {
    cantilapayAccountId: string;
    mode: CantilapayMode;
    status?: CantilapayCheckoutSessionStatus;
    limit?: number;
  },
): Promise<CantilapayCheckoutSessionView[]> {
  const take = Math.max(1, Math.min(input.limit ?? 50, 100));
  const rows = await prisma.cantilapayCheckoutSession.findMany({
    where: {
      cantilapayAccountId: input.cantilapayAccountId,
      mode: input.mode,
      status: input.status ?? undefined,
    },
    orderBy: { createdAt: "desc" },
    take,
  });
  return rows.map(toView);
}

/** Complete a checkout session. Called by the hosted page (or
 *  the tenant's embedded-checkout success callback) after the
 *  end-customer authorises the payment. Provisions the underlying
 *  PaymentIntent or Subscription and links it back to the session. */
export interface CompleteCheckoutSessionInput {
  cantilapayAccountId: string;
  mode: CantilapayMode;
  id: string;
  /** Required for payment-mode: the PSP-tokenised payment method
   *  the end-customer chose in the Drop-in. For subscription mode
   *  the same method becomes the subscription's default. */
  paymentMethodId: string;
}

export async function completeCheckoutSession(
  prisma: PrismaClient,
  processor: PaymentProcessor,
  input: CompleteCheckoutSessionInput,
): Promise<CantilapayCheckoutSessionView> {
  const row = await prisma.cantilapayCheckoutSession.findUnique({
    where: { id: input.id },
  });
  if (
    !row ||
    row.cantilapayAccountId !== input.cantilapayAccountId ||
    row.mode !== input.mode
  ) {
    throw CantilapayError.notFound("checkout session");
  }
  if (row.status === "complete") {
    return toView(row);
  }
  if (row.status === "expired" || row.expiresAt.getTime() < Date.now()) {
    throw CantilapayError.invalidField("checkout session has expired");
  }
  const method = await prisma.cantilapayPaymentMethod.findUnique({
    where: { id: input.paymentMethodId },
  });
  if (
    !method ||
    method.cantilapayAccountId !== input.cantilapayAccountId ||
    method.mode !== input.mode ||
    method.status !== "chargeable"
  ) {
    throw CantilapayError.notFound("payment method");
  }

  let paymentIntentId: string | null = null;
  let subscriptionId: string | null = null;

  if (row.sessionMode === "payment") {
    const intent = await createPaymentIntent(prisma, {
      cantilapayAccountId: input.cantilapayAccountId,
      mode: input.mode,
      amount: row.amountTotal,
      currency: row.currency,
      customerId: row.customerId ?? undefined,
      paymentMethodId: input.paymentMethodId,
      description: `Checkout session ${row.id}`,
    });
    const confirmed = await confirmPaymentIntent(prisma, processor, {
      cantilapayAccountId: input.cantilapayAccountId,
      mode: input.mode,
      id: intent.id,
    });
    paymentIntentId = confirmed.id;
  } else if (row.sessionMode === "subscription") {
    const items = parseItems(row.lineItems) as CantilapayCheckoutSubscriptionItem[];
    if (items.length === 0) {
      throw CantilapayError.internal("subscription session has no items");
    }
    if (!row.customerId) {
      throw CantilapayError.invalidField(
        "subscription-mode sessions require a customer",
        "customer",
      );
    }
    const sub = await createSubscription(prisma, {
      cantilapayAccountId: input.cantilapayAccountId,
      mode: input.mode,
      customerId: row.customerId,
      priceId: items[0].priceId,
      defaultPaymentMethodId: input.paymentMethodId,
    });
    subscriptionId = sub.id;
  }
  // sessionMode='setup' — nothing to provision; tenant uses the
  // attached payment method for future flows.

  const finalised = await prisma.cantilapayCheckoutSession.update({
    where: { id: row.id },
    data: {
      status: "complete",
      completedAt: new Date(),
      paymentIntentId,
      subscriptionId,
    },
  });
  await emitCantilapayEvent({
    prisma,
    cantilapayAccountId: input.cantilapayAccountId,
    mode: input.mode,
    type: "checkout.session.completed",
    data: {
      id: row.id,
      sessionMode: row.sessionMode,
      paymentIntentId,
      subscriptionId,
    },
  });
  return toView(finalised);
}

/** Sweep expired sessions. Called from the billing-engine tick. */
export async function expireCheckoutSessions(
  prisma: PrismaClient,
  opts: { now?: Date } = {},
): Promise<{ expired: number }> {
  const now = opts.now ?? new Date();
  const due = await prisma.cantilapayCheckoutSession.findMany({
    where: { status: "open", expiresAt: { lte: now } },
    select: { id: true },
  });
  if (due.length === 0) return { expired: 0 };
  await prisma.cantilapayCheckoutSession.updateMany({
    where: { id: { in: due.map((d) => d.id) } },
    data: { status: "expired" },
  });
  return { expired: due.length };
}
