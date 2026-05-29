/* ============================================================
   Cantilapay — Refund service (plan §25, Phase 1).

   Refund a captured PaymentIntent, fully or partially. The
   refund follows the PSP's path: cantilapay records the intent
   to refund, calls the PSP synchronously, and (for Adyen) reads
   the final outcome via the inbound REFUND_FAILED / REFUND
   webhook to set the row to succeeded / failed.

   The stub returns the terminal result synchronously, so the
   smoke test sees `succeeded` (or `failed` for amount=1) on the
   POST response.
   ============================================================ */

import type { PrismaClient } from "@prisma/client";

import type { PaymentProcessor } from "../adapters/port";
import type {
  CantilapayMode,
  CantilapayRefundStatus,
  CantilapayRefundView,
} from "../types";
import { CantilapayError } from "../errors";
import { emitCantilapayEvent } from "./events";
import { recordBalanceTransaction } from "./balance";

function toView(row: {
  id: string;
  mode: CantilapayMode;
  paymentIntentId: string;
  amount: number;
  currency: string;
  status: CantilapayRefundStatus;
  reason: string | null;
  lastError: string | null;
  createdAt: Date;
}): CantilapayRefundView {
  let lastError: { code: string; message: string } | null = null;
  if (row.lastError) {
    try {
      const parsed = JSON.parse(row.lastError) as Record<string, unknown>;
      lastError = {
        code: typeof parsed.code === "string" ? parsed.code : "refund_failed",
        message:
          typeof parsed.message === "string" ? parsed.message : "Refund failed.",
      };
    } catch {
      lastError = { code: "refund_failed", message: row.lastError };
    }
  }
  return {
    id: row.id,
    mode: row.mode,
    paymentIntentId: row.paymentIntentId,
    amount: row.amount,
    currency: row.currency,
    status: row.status,
    reason: row.reason,
    lastError,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface CreateRefundInput {
  cantilapayAccountId: string;
  mode: CantilapayMode;
  paymentIntentId: string;
  /** Defaults to the unrefunded balance on the intent. */
  amount?: number;
  reason?: string;
}

export async function createRefund(
  prisma: PrismaClient,
  processor: PaymentProcessor,
  input: CreateRefundInput,
): Promise<CantilapayRefundView> {
  const intent = await prisma.cantilapayPaymentIntent.findUnique({
    where: { id: input.paymentIntentId },
  });
  if (
    !intent ||
    intent.cantilapayAccountId !== input.cantilapayAccountId ||
    intent.mode !== input.mode
  ) {
    throw CantilapayError.notFound("payment intent");
  }
  if (intent.status !== "succeeded") {
    throw CantilapayError.invalidField(
      `payment intent is in state '${intent.status}' — only 'succeeded' can be refunded`,
    );
  }
  const refundable = intent.amountCaptured - intent.amountRefunded;
  const amount = input.amount ?? refundable;
  if (!Number.isInteger(amount) || amount <= 0) {
    throw CantilapayError.invalidField(
      "refund amount must be a positive integer",
      "amount",
    );
  }
  if (amount > refundable) {
    throw CantilapayError.invalidField(
      `refund amount ${amount} exceeds refundable balance ${refundable}`,
      "amount",
    );
  }
  if (!intent.pspPaymentRef) {
    throw CantilapayError.internal(
      "payment intent has no pspPaymentRef — cannot refund",
    );
  }

  // Create pending row first; update with PSP outcome.
  const pending = await prisma.cantilapayRefund.create({
    data: {
      cantilapayAccountId: input.cantilapayAccountId,
      mode: input.mode,
      paymentIntentId: intent.id,
      amount,
      currency: intent.currency,
      reason: input.reason ?? null,
    },
  });
  await emitCantilapayEvent({
    prisma,
    cantilapayAccountId: input.cantilapayAccountId,
    mode: input.mode,
    type: "refund.created",
    data: { id: pending.id, paymentIntentId: intent.id, amount, currency: intent.currency },
  });

  const result = await processor.refundPayment({
    pspPaymentRef: intent.pspPaymentRef,
    amount,
    currency: intent.currency,
    mode: input.mode,
    reason: input.reason,
  });

  if (result.status === "failed") {
    const failed = await prisma.cantilapayRefund.update({
      where: { id: pending.id },
      data: {
        status: "failed",
        failedAt: new Date(),
        pspRefundRef: result.pspRefundRef,
        lastError: JSON.stringify({
          code: result.errorCode ?? "refund_failed",
          message: result.errorMessage ?? "Refund failed at PSP.",
        }),
      },
    });
    await emitCantilapayEvent({
      prisma,
      cantilapayAccountId: input.cantilapayAccountId,
      mode: input.mode,
      type: "refund.failed",
      data: { id: failed.id, paymentIntentId: intent.id },
    });
    return toView(failed);
  }

  // succeeded (the stub) or pending (Adyen — final state arrives via
  // inbound REFUND webhook). For Phase 1 stub the synchronous result
  // is terminal.
  const finalStatus: CantilapayRefundStatus =
    result.status === "succeeded" ? "succeeded" : "pending";
  const updated = await prisma.cantilapayRefund.update({
    where: { id: pending.id },
    data: {
      status: finalStatus,
      pspRefundRef: result.pspRefundRef,
      succeededAt: finalStatus === "succeeded" ? new Date() : null,
    },
  });
  if (finalStatus === "succeeded") {
    await prisma.cantilapayPaymentIntent.update({
      where: { id: intent.id },
      data: { amountRefunded: intent.amountRefunded + amount },
    });
    // Phase 3: post negative balance transaction. The funds leave
    // the tenant's available balance.
    await recordBalanceTransaction(prisma, {
      cantilapayAccountId: input.cantilapayAccountId,
      mode: input.mode,
      amount: -amount,
      currency: intent.currency,
      type: "refund",
      description: `Refund ${updated.id} of ${intent.id}`,
      sourceRefundId: updated.id,
    });
    await emitCantilapayEvent({
      prisma,
      cantilapayAccountId: input.cantilapayAccountId,
      mode: input.mode,
      type: "refund.succeeded",
      data: { id: updated.id, paymentIntentId: intent.id, amount },
    });
  }
  return toView(updated);
}

export async function getRefund(
  prisma: PrismaClient,
  input: { cantilapayAccountId: string; mode: CantilapayMode; id: string },
): Promise<CantilapayRefundView | null> {
  const row = await prisma.cantilapayRefund.findUnique({ where: { id: input.id } });
  if (
    !row ||
    row.cantilapayAccountId !== input.cantilapayAccountId ||
    row.mode !== input.mode
  ) {
    return null;
  }
  return toView(row);
}

export async function listRefunds(
  prisma: PrismaClient,
  input: {
    cantilapayAccountId: string;
    mode: CantilapayMode;
    paymentIntentId?: string;
    limit?: number;
  },
): Promise<CantilapayRefundView[]> {
  const take = Math.max(1, Math.min(input.limit ?? 50, 100));
  const rows = await prisma.cantilapayRefund.findMany({
    where: {
      cantilapayAccountId: input.cantilapayAccountId,
      mode: input.mode,
      paymentIntentId: input.paymentIntentId ?? undefined,
    },
    orderBy: { createdAt: "desc" },
    take,
  });
  return rows.map(toView);
}
