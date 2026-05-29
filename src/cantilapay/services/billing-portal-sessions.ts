/* ============================================================
   Cantilapay — Billing Portal Session service (plan §25, Phase 4).

   A billing portal session is the end-customer's self-service
   entry point: update payment method, see invoices, cancel
   subscription. The tenant calls
   `POST /v1/cantilapay/billing_portal/sessions`, gets back a URL,
   and redirects the customer.

   The hosted portal page itself lives in `cantila-console` and is
   wired in Phase 6. Phase 4 ships the session minter + view.
   ============================================================ */

import type { PrismaClient } from "@prisma/client";

import type {
  CantilapayBillingPortalSessionStatus,
  CantilapayBillingPortalSessionView,
  CantilapayMode,
} from "../types";
import { CantilapayError } from "../errors";
import { emitCantilapayEvent } from "./events";

const TTL_MS = 60 * 60 * 1000; // 1 hour — matches Stripe Portal

function toView(row: {
  id: string;
  mode: CantilapayMode;
  customerId: string;
  returnUrl: string | null;
  status: CantilapayBillingPortalSessionStatus;
  url: string | null;
  expiresAt: Date;
  createdAt: Date;
}): CantilapayBillingPortalSessionView {
  return {
    id: row.id,
    mode: row.mode,
    customerId: row.customerId,
    returnUrl: row.returnUrl,
    status: row.status,
    url: row.url,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

function portalUrlFor(sessionId: string, env = process.env): string {
  const base =
    env.CANTILAPAY_BILLING_PORTAL_BASE_URL?.trim() ||
    "https://billing.cantila.com";
  return `${base.replace(/\/$/, "")}/p/${sessionId}`;
}

export interface CreateBillingPortalSessionInput {
  cantilapayAccountId: string;
  mode: CantilapayMode;
  customerId: string;
  returnUrl?: string;
}

export async function createBillingPortalSession(
  prisma: PrismaClient,
  input: CreateBillingPortalSessionInput,
): Promise<CantilapayBillingPortalSessionView> {
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
  const expiresAt = new Date(Date.now() + TTL_MS);
  const row = await prisma.cantilapayBillingPortalSession.create({
    data: {
      cantilapayAccountId: input.cantilapayAccountId,
      mode: input.mode,
      customerId: input.customerId,
      returnUrl: input.returnUrl ?? null,
      expiresAt,
    },
  });
  const url = portalUrlFor(row.id);
  const finalised = await prisma.cantilapayBillingPortalSession.update({
    where: { id: row.id },
    data: { url },
  });
  await emitCantilapayEvent({
    prisma,
    cantilapayAccountId: input.cantilapayAccountId,
    mode: input.mode,
    type: "billing_portal.session.created",
    data: { id: row.id, customerId: input.customerId },
  });
  return toView(finalised);
}

export async function getBillingPortalSession(
  prisma: PrismaClient,
  input: { cantilapayAccountId: string; mode: CantilapayMode; id: string },
): Promise<CantilapayBillingPortalSessionView | null> {
  const row = await prisma.cantilapayBillingPortalSession.findUnique({
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

/** Sweep expired portal sessions. Called from the billing-engine tick. */
export async function expireBillingPortalSessions(
  prisma: PrismaClient,
  opts: { now?: Date } = {},
): Promise<{ expired: number }> {
  const now = opts.now ?? new Date();
  const due = await prisma.cantilapayBillingPortalSession.findMany({
    where: { status: "open", expiresAt: { lte: now } },
    select: { id: true },
  });
  if (due.length === 0) return { expired: 0 };
  await prisma.cantilapayBillingPortalSession.updateMany({
    where: { id: { in: due.map((d) => d.id) } },
    data: { status: "expired" },
  });
  return { expired: due.length };
}
