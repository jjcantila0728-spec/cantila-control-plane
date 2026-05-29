/* ============================================================
   Cantilapay — Invoice service (plan §25, Phase 2).

   Read-side surface for invoices. The billing engine produces
   invoices (`drafts → open → paid`); tenants typically read them
   and download. `voidInvoice` and `markUncollectible` give the
   tenant manual control over what to do with stuck invoices.

   The Cantilapay-shaped `payInvoice` (retry-now) lives here too —
   the tenant calls it from the Console "Try again" button on a
   past-due banner.
   ============================================================ */

import type { PrismaClient } from "@prisma/client";

import type { PaymentProcessor } from "../adapters/port";
import type {
  CantilapayInvoiceItemView,
  CantilapayInvoiceStatus,
  CantilapayInvoiceView,
  CantilapayMode,
} from "../types";
import { CantilapayError } from "../errors";
import { emitCantilapayEvent } from "./events";

function toItem(row: {
  id: string;
  amount: number;
  currency: string;
  description: string;
  priceId: string | null;
  periodStart: Date | null;
  periodEnd: Date | null;
}): CantilapayInvoiceItemView {
  return {
    id: row.id,
    amount: row.amount,
    currency: row.currency,
    description: row.description,
    priceId: row.priceId,
    periodStart: row.periodStart ? row.periodStart.toISOString() : null,
    periodEnd: row.periodEnd ? row.periodEnd.toISOString() : null,
  };
}

interface InvoiceRow {
  id: string;
  mode: CantilapayMode;
  subscriptionId: string | null;
  customerId: string;
  periodStart: Date;
  periodEnd: Date;
  amountDue: number;
  amountPaid: number;
  currency: string;
  status: CantilapayInvoiceStatus;
  finalizedAt: Date | null;
  paidAt: Date | null;
  paymentIntentId: string | null;
  attempts: number;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
  items: Array<{
    id: string;
    amount: number;
    currency: string;
    description: string;
    priceId: string | null;
    periodStart: Date | null;
    periodEnd: Date | null;
  }>;
}

export function toInvoiceView(row: InvoiceRow): CantilapayInvoiceView {
  let lastError: { code: string; message: string } | null = null;
  if (row.lastError) {
    try {
      const parsed = JSON.parse(row.lastError) as Record<string, unknown>;
      lastError = {
        code: typeof parsed.code === "string" ? parsed.code : "invoice_charge_failed",
        message:
          typeof parsed.message === "string"
            ? parsed.message
            : "Invoice charge failed.",
      };
    } catch {
      lastError = { code: "invoice_charge_failed", message: row.lastError };
    }
  }
  return {
    id: row.id,
    mode: row.mode,
    subscriptionId: row.subscriptionId,
    customerId: row.customerId,
    periodStart: row.periodStart.toISOString(),
    periodEnd: row.periodEnd.toISOString(),
    amountDue: row.amountDue,
    amountPaid: row.amountPaid,
    currency: row.currency,
    status: row.status,
    finalizedAt: row.finalizedAt ? row.finalizedAt.toISOString() : null,
    paidAt: row.paidAt ? row.paidAt.toISOString() : null,
    paymentIntentId: row.paymentIntentId,
    attempts: row.attempts,
    lastError,
    items: row.items.map(toItem),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function getInvoice(
  prisma: PrismaClient,
  input: { cantilapayAccountId: string; mode: CantilapayMode; id: string },
): Promise<CantilapayInvoiceView | null> {
  const row = await prisma.cantilapayInvoice.findUnique({
    where: { id: input.id },
    include: { items: { orderBy: { createdAt: "asc" } } },
  });
  if (
    !row ||
    row.cantilapayAccountId !== input.cantilapayAccountId ||
    row.mode !== input.mode
  ) {
    return null;
  }
  return toInvoiceView(row);
}

export async function listInvoices(
  prisma: PrismaClient,
  input: {
    cantilapayAccountId: string;
    mode: CantilapayMode;
    customerId?: string;
    subscriptionId?: string;
    status?: CantilapayInvoiceStatus;
    limit?: number;
  },
): Promise<CantilapayInvoiceView[]> {
  const take = Math.max(1, Math.min(input.limit ?? 50, 100));
  const rows = await prisma.cantilapayInvoice.findMany({
    where: {
      cantilapayAccountId: input.cantilapayAccountId,
      mode: input.mode,
      customerId: input.customerId ?? undefined,
      subscriptionId: input.subscriptionId ?? undefined,
      status: input.status ?? undefined,
    },
    orderBy: { createdAt: "desc" },
    take,
    include: { items: { orderBy: { createdAt: "asc" } } },
  });
  return rows.map(toInvoiceView);
}

/** Void a draft or open invoice. Cannot void a paid invoice. */
export async function voidInvoice(
  prisma: PrismaClient,
  input: { cantilapayAccountId: string; mode: CantilapayMode; id: string },
): Promise<CantilapayInvoiceView> {
  const existing = await prisma.cantilapayInvoice.findUnique({
    where: { id: input.id },
  });
  if (
    !existing ||
    existing.cantilapayAccountId !== input.cantilapayAccountId ||
    existing.mode !== input.mode
  ) {
    throw CantilapayError.notFound("invoice");
  }
  if (existing.status === "paid") {
    throw CantilapayError.invalidField("paid invoices cannot be voided");
  }
  if (existing.status === "void") {
    // already voided; idempotent return
  } else {
    await prisma.cantilapayInvoice.update({
      where: { id: input.id },
      data: { status: "void" },
    });
    await emitCantilapayEvent({
      prisma,
      cantilapayAccountId: input.cantilapayAccountId,
      mode: input.mode,
      type: "invoice.voided",
      data: { id: input.id },
    });
  }
  const refreshed = await prisma.cantilapayInvoice.findUnique({
    where: { id: input.id },
    include: { items: true },
  });
  return toInvoiceView(refreshed!);
}

/** Mark an open invoice as uncollectible. Tenant policy decision. */
export async function markInvoiceUncollectible(
  prisma: PrismaClient,
  input: { cantilapayAccountId: string; mode: CantilapayMode; id: string },
): Promise<CantilapayInvoiceView> {
  const existing = await prisma.cantilapayInvoice.findUnique({
    where: { id: input.id },
  });
  if (
    !existing ||
    existing.cantilapayAccountId !== input.cantilapayAccountId ||
    existing.mode !== input.mode
  ) {
    throw CantilapayError.notFound("invoice");
  }
  if (existing.status === "paid") {
    throw CantilapayError.invalidField("paid invoices cannot be marked uncollectible");
  }
  if (existing.status !== "uncollectible") {
    await prisma.cantilapayInvoice.update({
      where: { id: input.id },
      data: { status: "uncollectible" },
    });
    await emitCantilapayEvent({
      prisma,
      cantilapayAccountId: input.cantilapayAccountId,
      mode: input.mode,
      type: "invoice.marked_uncollectible",
      data: { id: input.id },
    });
  }
  const refreshed = await prisma.cantilapayInvoice.findUnique({
    where: { id: input.id },
    include: { items: true },
  });
  return toInvoiceView(refreshed!);
}
