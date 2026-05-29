/* ============================================================
   Cantilapay — PaymentIntent service (plan §25, Phase 1).

   The heart of Phase 1. Cantilapay-shaped state machine:

     create  → requires_payment_method  (no method)
             → requires_confirmation    (method attached)
     confirm → succeeded                (automatic capture, no SCA)
             → requires_capture         (manual capture)
             → requires_action          (SCA / 3DS challenge — Phase 4)
             → failed                   (PSP decline)
     capture → succeeded                (only from requires_capture)
     cancel  → canceled                 (any pre-terminal)

   Every transition emits a Cantilapay-shaped event
   (`payment_intent.created`, `…succeeded`, `…payment_failed`, …) via
   `emitCantilapayEvent`, which both writes the canonical Event row
   and enqueues outbound deliveries to subscribed tenant webhooks.

   Platform fee: computed at create from the owning
   CantilapayAccount.platformFeeBps; persisted on the intent so a
   later fee change doesn't reshape past intents.
   ============================================================ */

import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

import type { PaymentProcessor } from "../adapters/port";
import type {
  CantilapayCaptureMode,
  CantilapayMode,
  CantilapayPaymentIntentStatus,
  CantilapayPaymentIntentView,
} from "../types";
import { CantilapayError } from "../errors";
import { emitCantilapayEvent } from "./events";
import { recordBalanceTransaction } from "./balance";

interface IntentRow {
  id: string;
  mode: CantilapayMode;
  customerId: string | null;
  paymentMethodId: string | null;
  amount: number;
  amountCaptured: number;
  amountRefunded: number;
  currency: string;
  captureMode: CantilapayCaptureMode;
  status: CantilapayPaymentIntentStatus;
  platformFeeAmount: number;
  description: string | null;
  metadata: string;
  pspPaymentRef: string | null;
  pspSessionData: string | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function toView(row: IntentRow): CantilapayPaymentIntentView {
  return {
    id: row.id,
    mode: row.mode,
    customerId: row.customerId,
    paymentMethodId: row.paymentMethodId,
    amount: row.amount,
    amountCaptured: row.amountCaptured,
    amountRefunded: row.amountRefunded,
    currency: row.currency,
    captureMode: row.captureMode,
    status: row.status,
    platformFeeAmount: row.platformFeeAmount,
    description: row.description,
    metadata: parseMetadata(row.metadata),
    clientSecret: row.pspSessionData,
    lastError: row.lastError ? parseLastError(row.lastError) : null,
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

function parseLastError(
  s: string,
): { code: string; message: string; declineCode?: string } {
  try {
    const parsed = JSON.parse(s) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      return {
        code: typeof obj.code === "string" ? obj.code : "unknown_error",
        message: typeof obj.message === "string" ? obj.message : "Unknown error.",
        declineCode:
          typeof obj.declineCode === "string" ? obj.declineCode : undefined,
      };
    }
  } catch {
    /* fall through */
  }
  return { code: "unknown_error", message: s };
}

function newClientSecret(intentId: string): string {
  return `${intentId}_secret_${randomBytes(16).toString("hex")}`;
}

/** Calc platform fee in minor units from bps. Floor so the tenant
 *  is never overcharged on rounding. */
function calcPlatformFee(amountMinor: number, bps: number): number {
  return Math.floor((amountMinor * bps) / 10000);
}

export interface CreatePaymentIntentInput {
  cantilapayAccountId: string;
  mode: CantilapayMode;
  amount: number;
  currency: string;
  customerId?: string;
  paymentMethodId?: string;
  captureMode?: CantilapayCaptureMode;
  description?: string;
  metadata?: Record<string, string>;
  clientIdempotencyKey?: string | null;
}

export async function createPaymentIntent(
  prisma: PrismaClient,
  input: CreatePaymentIntentInput,
): Promise<CantilapayPaymentIntentView> {
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    throw CantilapayError.invalidField(
      "amount must be a positive integer in minor units (e.g. cents)",
      "amount",
    );
  }
  if (!/^[a-z]{3}$/.test(input.currency)) {
    throw CantilapayError.invalidField(
      "currency must be ISO-4217 lowercase, e.g. 'usd'",
      "currency",
    );
  }
  const account = await prisma.cantilapayAccount.findUnique({
    where: { id: input.cantilapayAccountId },
  });
  if (!account) throw CantilapayError.notFound("cantilapay account");
  if (input.customerId) {
    const c = await prisma.cantilapayCustomer.findUnique({
      where: { id: input.customerId },
    });
    if (!c || c.cantilapayAccountId !== input.cantilapayAccountId || c.mode !== input.mode) {
      throw CantilapayError.notFound("customer");
    }
  }
  if (input.paymentMethodId) {
    const pm = await prisma.cantilapayPaymentMethod.findUnique({
      where: { id: input.paymentMethodId },
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
  const platformFeeAmount = calcPlatformFee(
    input.amount,
    account.platformFeeBps,
  );
  const status: CantilapayPaymentIntentStatus = input.paymentMethodId
    ? "requires_confirmation"
    : "requires_payment_method";
  const created = await prisma.cantilapayPaymentIntent.create({
    data: {
      cantilapayAccountId: input.cantilapayAccountId,
      mode: input.mode,
      customerId: input.customerId ?? null,
      paymentMethodId: input.paymentMethodId ?? null,
      amount: input.amount,
      currency: input.currency,
      captureMode: input.captureMode ?? "automatic",
      status,
      platformFeeAmount,
      description: input.description ?? null,
      metadata: JSON.stringify(input.metadata ?? {}),
      pspSessionData: "", // placeholder; overwritten with clientSecret below
      clientIdempotencyKey: input.clientIdempotencyKey ?? null,
    },
  });
  const clientSecret = newClientSecret(created.id);
  const row = await prisma.cantilapayPaymentIntent.update({
    where: { id: created.id },
    data: { pspSessionData: clientSecret },
  });
  await emitCantilapayEvent({
    prisma,
    cantilapayAccountId: input.cantilapayAccountId,
    mode: input.mode,
    type: "payment_intent.created",
    data: { id: row.id, amount: row.amount, currency: row.currency, status: row.status },
  });
  return toView(row);
}

export async function getPaymentIntent(
  prisma: PrismaClient,
  input: { cantilapayAccountId: string; mode: CantilapayMode; id: string },
): Promise<CantilapayPaymentIntentView | null> {
  const row = await prisma.cantilapayPaymentIntent.findUnique({
    where: { id: input.id },
  });
  if (!row || row.cantilapayAccountId !== input.cantilapayAccountId || row.mode !== input.mode) {
    return null;
  }
  return toView(row);
}

export async function listPaymentIntents(
  prisma: PrismaClient,
  input: {
    cantilapayAccountId: string;
    mode: CantilapayMode;
    customerId?: string;
    limit?: number;
  },
): Promise<CantilapayPaymentIntentView[]> {
  const take = Math.max(1, Math.min(input.limit ?? 50, 100));
  const rows = await prisma.cantilapayPaymentIntent.findMany({
    where: {
      cantilapayAccountId: input.cantilapayAccountId,
      mode: input.mode,
      customerId: input.customerId ?? undefined,
    },
    orderBy: { createdAt: "desc" },
    take,
  });
  return rows.map(toView);
}

export interface ConfirmPaymentIntentInput {
  cantilapayAccountId: string;
  mode: CantilapayMode;
  id: string;
  /** Optional override: when the intent was created without a method,
   *  the tenant supplies it on confirm. */
  paymentMethodId?: string;
}

export async function confirmPaymentIntent(
  prisma: PrismaClient,
  processor: PaymentProcessor,
  input: ConfirmPaymentIntentInput,
): Promise<CantilapayPaymentIntentView> {
  const row = await prisma.cantilapayPaymentIntent.findUnique({
    where: { id: input.id },
  });
  if (!row || row.cantilapayAccountId !== input.cantilapayAccountId || row.mode !== input.mode) {
    throw CantilapayError.notFound("payment intent");
  }
  if (row.status !== "requires_payment_method" && row.status !== "requires_confirmation") {
    throw CantilapayError.invalidField(
      `payment intent is in state '${row.status}' — cannot confirm`,
    );
  }
  const methodId = input.paymentMethodId ?? row.paymentMethodId;
  if (!methodId) {
    throw CantilapayError.invalidField(
      "payment_method is required to confirm",
      "payment_method",
    );
  }
  const method = await prisma.cantilapayPaymentMethod.findUnique({
    where: { id: methodId },
  });
  if (
    !method ||
    method.cantilapayAccountId !== input.cantilapayAccountId ||
    method.mode !== input.mode ||
    method.status !== "chargeable"
  ) {
    throw CantilapayError.notFound("payment method");
  }
  const account = await prisma.cantilapayAccount.findUnique({
    where: { id: input.cantilapayAccountId },
  });
  if (!account) throw CantilapayError.notFound("cantilapay account");
  const subMerchantId =
    input.mode === "test"
      ? account.adyenAccountHolderIdTest
      : account.adyenAccountHolderIdLive;
  if (!subMerchantId) {
    // Phase 0 / 3: stub fast-tracks KYC so any onboarded account
    // is "active enough" to take a stub payment. The PSP call gets
    // an empty string in that case and the stub ignores it.
    // For live mode this is a real blocker — surface it.
    if (processor.live && input.mode === "live") {
      throw CantilapayError.accountInactive();
    }
  }

  const result = await processor.confirmPayment({
    subMerchantId: subMerchantId ?? "",
    paymentIntentId: row.id,
    amount: row.amount,
    currency: row.currency,
    paymentMethodToken: method.pspToken,
    captureMode: row.captureMode,
    mode: input.mode,
    platformFeeAmount: row.platformFeeAmount,
    metadata: parseMetadata(row.metadata),
  });

  const now = new Date();
  let nextStatus: CantilapayPaymentIntentStatus;
  let lastError: string | null = null;
  let amountCaptured = row.amountCaptured;
  let succeededAt: Date | null = row.amountCaptured > 0 ? now : null;
  let failedAt: Date | null = null;

  switch (result.status) {
    case "succeeded":
      nextStatus = "succeeded";
      amountCaptured = row.amount;
      succeededAt = now;
      break;
    case "authorized_pending_capture":
      nextStatus = "requires_capture";
      succeededAt = null;
      break;
    case "requires_action":
      nextStatus = "requires_action";
      succeededAt = null;
      break;
    case "failed":
      nextStatus = "failed";
      failedAt = now;
      lastError = JSON.stringify({
        code: result.errorCode ?? "card_declined",
        message: result.errorMessage ?? "Card was declined.",
        declineCode: result.declineCode,
      });
      break;
  }

  const updated = await prisma.cantilapayPaymentIntent.update({
    where: { id: row.id },
    data: {
      status: nextStatus,
      paymentMethodId: methodId,
      pspPaymentRef: result.pspPaymentRef,
      amountCaptured,
      confirmedAt: row.amountCaptured > 0 ? row.updatedAt : now,
      succeededAt: succeededAt ?? row.succeededAt,
      failedAt: failedAt ?? row.failedAt,
      capturedAt: nextStatus === "succeeded" ? now : row.capturedAt,
      lastError,
    },
  });

  // Phase 3: post balance transactions for cleared funds. Charge
  // credits the full amount; the platform fee debits straight back
  // off so the tenant's available balance is amount - fee net.
  if (nextStatus === "succeeded") {
    await recordBalanceTransaction(prisma, {
      cantilapayAccountId: input.cantilapayAccountId,
      mode: input.mode,
      amount: row.amount,
      currency: row.currency,
      type: "charge",
      description: `Charge for ${row.id}`,
      sourcePaymentIntentId: row.id,
    });
    if (row.platformFeeAmount > 0) {
      await recordBalanceTransaction(prisma, {
        cantilapayAccountId: input.cantilapayAccountId,
        mode: input.mode,
        amount: -row.platformFeeAmount,
        currency: row.currency,
        type: "platform_fee",
        description: `Cantilapay platform fee on ${row.id}`,
        sourcePaymentIntentId: row.id,
      });
    }
  }

  // Emit Cantilapay-shaped events for each outcome.
  const eventBase = {
    id: updated.id,
    amount: updated.amount,
    currency: updated.currency,
    status: updated.status,
  };
  const eventType =
    nextStatus === "succeeded"
      ? "payment_intent.succeeded"
      : nextStatus === "requires_capture"
        ? "payment_intent.amount_capturable_updated"
        : nextStatus === "requires_action"
          ? "payment_intent.requires_action"
          : "payment_intent.payment_failed";
  await emitCantilapayEvent({
    prisma,
    cantilapayAccountId: input.cantilapayAccountId,
    mode: input.mode,
    type: eventType,
    data: { ...eventBase, lastError: lastError ? JSON.parse(lastError) : null },
  });

  return toView(updated);
}

export async function capturePaymentIntent(
  prisma: PrismaClient,
  processor: PaymentProcessor,
  input: { cantilapayAccountId: string; mode: CantilapayMode; id: string },
): Promise<CantilapayPaymentIntentView> {
  const row = await prisma.cantilapayPaymentIntent.findUnique({
    where: { id: input.id },
  });
  if (!row || row.cantilapayAccountId !== input.cantilapayAccountId || row.mode !== input.mode) {
    throw CantilapayError.notFound("payment intent");
  }
  if (row.status !== "requires_capture") {
    throw CantilapayError.invalidField(
      `payment intent is in state '${row.status}' — cannot capture`,
    );
  }
  if (!row.pspPaymentRef) {
    throw CantilapayError.internal(
      "payment intent has no pspPaymentRef — was it confirmed?",
    );
  }
  const capture = await processor.capturePayment({
    pspPaymentRef: row.pspPaymentRef,
    amount: row.amount,
    currency: row.currency,
    mode: input.mode,
  });
  if (capture.status === "failed") {
    const updated = await prisma.cantilapayPaymentIntent.update({
      where: { id: row.id },
      data: {
        status: "failed",
        failedAt: new Date(),
        lastError: JSON.stringify({
          code: capture.errorCode ?? "capture_failed",
          message: capture.errorMessage ?? "Capture failed at PSP.",
        }),
      },
    });
    await emitCantilapayEvent({
      prisma,
      cantilapayAccountId: input.cantilapayAccountId,
      mode: input.mode,
      type: "payment_intent.payment_failed",
      data: { id: updated.id, amount: updated.amount, currency: updated.currency },
    });
    return toView(updated);
  }
  const updated = await prisma.cantilapayPaymentIntent.update({
    where: { id: row.id },
    data: {
      status: "succeeded",
      amountCaptured: row.amount,
      capturedAt: new Date(),
      succeededAt: new Date(),
    },
  });
  // Phase 3: post balance transactions on capture-clear.
  await recordBalanceTransaction(prisma, {
    cantilapayAccountId: input.cantilapayAccountId,
    mode: input.mode,
    amount: row.amount,
    currency: row.currency,
    type: "charge",
    description: `Charge for ${row.id}`,
    sourcePaymentIntentId: row.id,
  });
  if (row.platformFeeAmount > 0) {
    await recordBalanceTransaction(prisma, {
      cantilapayAccountId: input.cantilapayAccountId,
      mode: input.mode,
      amount: -row.platformFeeAmount,
      currency: row.currency,
      type: "platform_fee",
      description: `Cantilapay platform fee on ${row.id}`,
      sourcePaymentIntentId: row.id,
    });
  }
  await emitCantilapayEvent({
    prisma,
    cantilapayAccountId: input.cantilapayAccountId,
    mode: input.mode,
    type: "payment_intent.succeeded",
    data: { id: updated.id, amount: updated.amount, currency: updated.currency },
  });
  return toView(updated);
}

export async function cancelPaymentIntent(
  prisma: PrismaClient,
  processor: PaymentProcessor,
  input: { cantilapayAccountId: string; mode: CantilapayMode; id: string },
): Promise<CantilapayPaymentIntentView> {
  const row = await prisma.cantilapayPaymentIntent.findUnique({
    where: { id: input.id },
  });
  if (!row || row.cantilapayAccountId !== input.cantilapayAccountId || row.mode !== input.mode) {
    throw CantilapayError.notFound("payment intent");
  }
  if (
    row.status === "succeeded" ||
    row.status === "failed" ||
    row.status === "canceled"
  ) {
    throw CantilapayError.invalidField(
      `payment intent is in terminal state '${row.status}'`,
    );
  }
  if (row.pspPaymentRef) {
    await processor
      .cancelPayment({ pspPaymentRef: row.pspPaymentRef, mode: input.mode })
      .catch(() => {
        /* best-effort — cantilapay still cancels the intent locally */
      });
  }
  const updated = await prisma.cantilapayPaymentIntent.update({
    where: { id: row.id },
    data: { status: "canceled", canceledAt: new Date() },
  });
  await emitCantilapayEvent({
    prisma,
    cantilapayAccountId: input.cantilapayAccountId,
    mode: input.mode,
    type: "payment_intent.canceled",
    data: { id: updated.id },
  });
  return toView(updated);
}
