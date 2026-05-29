/* ============================================================
   Cantilapay — Balance + ledger service (plan §25, Phase 3).

   Every money movement that touches the tenant's available
   balance leaves a `CantilapayBalanceTransaction` row — the
   Cantilapay-shaped ledger. `recordBalanceTransaction` is the single
   write surface used by payment-intents, refunds, and the
   payout engine. `getBalance` aggregates the ledger to compute
   `available` (settled, can be paid out) and `pending`
   (in-transit toward the tenant's bank).
   ============================================================ */

import type { PrismaClient } from "@prisma/client";

import type {
  CantilapayBalanceTransactionType,
  CantilapayBalanceTransactionView,
  CantilapayBalanceView,
  CantilapayMode,
} from "../types";

interface BalanceTxRow {
  id: string;
  mode: CantilapayMode;
  amount: number;
  currency: string;
  type: CantilapayBalanceTransactionType;
  description: string | null;
  sourcePaymentIntentId: string | null;
  sourceRefundId: string | null;
  sourcePayoutId: string | null;
  createdAt: Date;
}

function toView(row: BalanceTxRow): CantilapayBalanceTransactionView {
  const source: { paymentIntentId?: string; refundId?: string; payoutId?: string } = {};
  if (row.sourcePaymentIntentId) source.paymentIntentId = row.sourcePaymentIntentId;
  if (row.sourceRefundId) source.refundId = row.sourceRefundId;
  if (row.sourcePayoutId) source.payoutId = row.sourcePayoutId;
  return {
    id: row.id,
    mode: row.mode,
    amount: row.amount,
    currency: row.currency,
    type: row.type,
    description: row.description,
    source,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface RecordBalanceTransactionInput {
  cantilapayAccountId: string;
  mode: CantilapayMode;
  /** Signed amount in minor units (positive = credit; negative = debit). */
  amount: number;
  currency: string;
  type: CantilapayBalanceTransactionType;
  description?: string;
  sourcePaymentIntentId?: string;
  sourceRefundId?: string;
  sourcePayoutId?: string;
}

export async function recordBalanceTransaction(
  prisma: PrismaClient,
  input: RecordBalanceTransactionInput,
): Promise<void> {
  await prisma.cantilapayBalanceTransaction.create({
    data: {
      cantilapayAccountId: input.cantilapayAccountId,
      mode: input.mode,
      amount: input.amount,
      currency: input.currency,
      type: input.type,
      description: input.description ?? null,
      sourcePaymentIntentId: input.sourcePaymentIntentId ?? null,
      sourceRefundId: input.sourceRefundId ?? null,
      sourcePayoutId: input.sourcePayoutId ?? null,
    },
  });
}

export async function listBalanceTransactions(
  prisma: PrismaClient,
  input: {
    cantilapayAccountId: string;
    mode: CantilapayMode;
    limit?: number;
  },
): Promise<CantilapayBalanceTransactionView[]> {
  const take = Math.max(1, Math.min(input.limit ?? 100, 200));
  const rows = await prisma.cantilapayBalanceTransaction.findMany({
    where: { cantilapayAccountId: input.cantilapayAccountId, mode: input.mode },
    orderBy: { createdAt: "desc" },
    take,
  });
  return rows.map(toView);
}

/** Compute available + pending balance. */
export async function getBalance(
  prisma: PrismaClient,
  input: { cantilapayAccountId: string; mode: CantilapayMode; currency?: string },
): Promise<CantilapayBalanceView> {
  const currency = input.currency ?? "usd";

  // Sum ledger by currency. For Phase 3 we surface one currency at
  // a time; multi-currency surfaces an array in a future drop.
  const rows = await prisma.cantilapayBalanceTransaction.findMany({
    where: {
      cantilapayAccountId: input.cantilapayAccountId,
      mode: input.mode,
      currency,
    },
    select: { amount: true, type: true },
  });
  const settled = rows.reduce((sum, r) => sum + r.amount, 0);

  // Pending = sum of pending/in_transit payouts (these are negative
  // entries on the ledger via `type='payout'` — we want the absolute
  // value of payouts that have not yet cleared).
  const pendingPayouts = await prisma.cantilapayPayout.findMany({
    where: {
      cantilapayAccountId: input.cantilapayAccountId,
      mode: input.mode,
      currency,
      status: { in: ["pending", "in_transit"] },
    },
    select: { amount: true },
  });
  const pending = pendingPayouts.reduce((sum, p) => sum + p.amount, 0);

  return {
    // `settled` already includes the negative-payout entries; the
    // pending payouts haven't been credited as completed yet so they
    // live in `pending`. To match Stripe's available/pending split:
    available: settled,
    pending,
    currency,
  };
}
