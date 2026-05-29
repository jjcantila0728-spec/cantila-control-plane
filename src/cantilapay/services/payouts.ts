/* ============================================================
   Cantilapay — Payout service (plan §25, Phase 3).

   Sweeps the tenant's available balance into a settlement to
   their bank account at the PSP. In Phase 3 we ship:

     - manual create: tenant calls POST /v1/cantilapay/payouts
       and gets a CantilapayPayout row in `pending` status.
     - automatic schedule: `schedulePayouts(prisma, now)` runs
       in the engine tick; when a tenant's available balance
       is > 0 AND no payout has been created in the last 24h,
       it creates a `pending` payout for the full balance and
       arrivalDate = now + 24h.
     - settlement: `settlePayouts(prisma, now)` advances
       payouts whose arrivalDate <= now from pending → paid,
       posts the `-amount` BalanceTransaction, and emits
       payout.paid.

   The real Adyen rail handles settlement asynchronously and
   reports outcomes via webhook; for the stub we settle the
   payout deterministically on the same engine tick once the
   arrivalDate has passed.
   ============================================================ */

import type { PrismaClient } from "@prisma/client";

import type {
  CantilapayMode,
  CantilapayPayoutStatus,
  CantilapayPayoutView,
} from "../types";
import { CantilapayError } from "../errors";
import { emitCantilapayEvent } from "./events";
import { getBalance, recordBalanceTransaction } from "./balance";

const MS_PER_HOUR = 3600 * 1000;
const AUTO_PAYOUT_COOLDOWN_HOURS = 24;
const SETTLEMENT_DELAY_HOURS = 24;

function toView(row: {
  id: string;
  mode: CantilapayMode;
  amount: number;
  currency: string;
  status: CantilapayPayoutStatus;
  arrivalDate: Date;
  periodStart: Date;
  periodEnd: Date;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}): CantilapayPayoutView {
  let lastError: { code: string; message: string } | null = null;
  if (row.lastError) {
    try {
      const parsed = JSON.parse(row.lastError) as Record<string, unknown>;
      lastError = {
        code: typeof parsed.code === "string" ? parsed.code : "payout_failed",
        message:
          typeof parsed.message === "string"
            ? parsed.message
            : "Payout failed.",
      };
    } catch {
      lastError = { code: "payout_failed", message: row.lastError };
    }
  }
  return {
    id: row.id,
    mode: row.mode,
    amount: row.amount,
    currency: row.currency,
    status: row.status,
    arrivalDate: row.arrivalDate.toISOString(),
    periodStart: row.periodStart.toISOString(),
    periodEnd: row.periodEnd.toISOString(),
    lastError,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface CreatePayoutInput {
  cantilapayAccountId: string;
  mode: CantilapayMode;
  amount?: number;
  currency?: string;
  now?: Date;
}

export async function createPayout(
  prisma: PrismaClient,
  input: CreatePayoutInput,
): Promise<CantilapayPayoutView> {
  const currency = input.currency ?? "usd";
  const now = input.now ?? new Date();
  const balance = await getBalance(prisma, {
    cantilapayAccountId: input.cantilapayAccountId,
    mode: input.mode,
    currency,
  });
  const amount = input.amount ?? balance.available;
  if (!Number.isInteger(amount) || amount <= 0) {
    throw CantilapayError.invalidField(
      "payout amount must be a positive integer (no available balance?)",
      "amount",
    );
  }
  if (amount > balance.available) {
    throw CantilapayError.invalidField(
      `payout amount ${amount} exceeds available balance ${balance.available}`,
      "amount",
    );
  }
  // The period this payout covers — for the Phase 3 stub it's
  // "everything from the last payout's periodEnd to now". A real
  // ledger reconciler will tighten this with a windowed query.
  const lastPayout = await prisma.cantilapayPayout.findFirst({
    where: {
      cantilapayAccountId: input.cantilapayAccountId,
      mode: input.mode,
      currency,
    },
    orderBy: { createdAt: "desc" },
    select: { periodEnd: true },
  });
  const periodStart = lastPayout?.periodEnd ?? new Date(0);
  const periodEnd = now;
  const arrivalDate = new Date(now.getTime() + SETTLEMENT_DELAY_HOURS * MS_PER_HOUR);

  const row = await prisma.cantilapayPayout.create({
    data: {
      cantilapayAccountId: input.cantilapayAccountId,
      mode: input.mode,
      amount,
      currency,
      arrivalDate,
      periodStart,
      periodEnd,
    },
  });
  await emitCantilapayEvent({
    prisma,
    cantilapayAccountId: input.cantilapayAccountId,
    mode: input.mode,
    type: "payout.created",
    data: { id: row.id, amount: row.amount, currency: row.currency, arrivalDate: arrivalDate.toISOString() },
  });
  return toView(row);
}

export async function getPayout(
  prisma: PrismaClient,
  input: { cantilapayAccountId: string; mode: CantilapayMode; id: string },
): Promise<CantilapayPayoutView | null> {
  const row = await prisma.cantilapayPayout.findUnique({ where: { id: input.id } });
  if (
    !row ||
    row.cantilapayAccountId !== input.cantilapayAccountId ||
    row.mode !== input.mode
  ) {
    return null;
  }
  return toView(row);
}

export async function listPayouts(
  prisma: PrismaClient,
  input: {
    cantilapayAccountId: string;
    mode: CantilapayMode;
    status?: CantilapayPayoutStatus;
    limit?: number;
  },
): Promise<CantilapayPayoutView[]> {
  const take = Math.max(1, Math.min(input.limit ?? 50, 100));
  const rows = await prisma.cantilapayPayout.findMany({
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

/** Engine tick component — schedule new automatic payouts and
 *  settle ones whose arrivalDate has passed. */
export async function processPayouts(
  prisma: PrismaClient,
  opts: { now?: Date } = {},
): Promise<{ scheduled: number; settled: number }> {
  const now = opts.now ?? new Date();
  let scheduled = 0;
  let settled = 0;

  // 1) Schedule: for each active account with available balance >
  //    0 and no payout in the cooldown window, create one.
  const activeAccounts = await prisma.cantilapayAccount.findMany({
    where: { status: "active" },
    select: { id: true },
  });
  for (const acc of activeAccounts) {
    for (const mode of ["test", "live"] as const) {
      const balance = await getBalance(prisma, {
        cantilapayAccountId: acc.id,
        mode,
      });
      if (balance.available <= 0) continue;
      const lastPayout = await prisma.cantilapayPayout.findFirst({
        where: { cantilapayAccountId: acc.id, mode },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      });
      if (
        lastPayout &&
        now.getTime() - lastPayout.createdAt.getTime() <
          AUTO_PAYOUT_COOLDOWN_HOURS * MS_PER_HOUR
      ) {
        continue;
      }
      await createPayout(prisma, {
        cantilapayAccountId: acc.id,
        mode,
        amount: balance.available,
        currency: balance.currency,
        now,
      });
      scheduled += 1;
    }
  }

  // 2) Settle: any pending payout whose arrival date has passed
  //    moves to paid. Real Adyen reports completion via webhook;
  //    the stub completes deterministically on tick.
  const due = await prisma.cantilapayPayout.findMany({
    where: { status: { in: ["pending", "in_transit"] }, arrivalDate: { lte: now } },
  });
  for (const row of due) {
    await prisma.cantilapayPayout.update({
      where: { id: row.id },
      data: { status: "paid", paidAt: now },
    });
    // Post the negative balance transaction — the funds left the
    // tenant's available balance and landed in their bank.
    await recordBalanceTransaction(prisma, {
      cantilapayAccountId: row.cantilapayAccountId,
      mode: row.mode,
      amount: -row.amount,
      currency: row.currency,
      type: "payout",
      description: `Payout ${row.id} settled`,
      sourcePayoutId: row.id,
    });
    await emitCantilapayEvent({
      prisma,
      cantilapayAccountId: row.cantilapayAccountId,
      mode: row.mode,
      type: "payout.paid",
      data: { id: row.id, amount: row.amount },
    });
    settled += 1;
  }

  return { scheduled, settled };
}
