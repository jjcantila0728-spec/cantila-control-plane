/* ============================================================
   Cantilapay — PaymentMethod service (plan §25, Phase 1).

   Tenants attach payment methods via the PSP Drop-in / SDK
   (Adyen Drop-in tokenises the card client-side; Cantila never
   sees PAN). The result is a PSP token; this service persists
   the cantilapay-side handle the tenant references in subsequent
   PaymentIntent calls.

   In test mode the route layer also accepts a manually-supplied
   `pspToken` (typically `tok_stub_visa_4242`) so a CLI-only test
   can wire end-to-end without a browser SDK round-trip.
   ============================================================ */

import type { PrismaClient } from "@prisma/client";

import type {
  CantilapayMode,
  CantilapayPaymentMethodView,
} from "../types";
import { CantilapayError } from "../errors";
import { emitCantilapayEvent } from "./events";

function toView(row: {
  id: string;
  mode: CantilapayMode;
  customerId: string | null;
  type: string;
  cardBrand: string | null;
  cardLast4: string | null;
  cardExpMonth: number | null;
  cardExpYear: number | null;
  status: "chargeable" | "detached";
  metadata: string;
  createdAt: Date;
}): CantilapayPaymentMethodView {
  return {
    id: row.id,
    mode: row.mode,
    customerId: row.customerId,
    type: row.type,
    card:
      row.type === "card"
        ? {
            brand: row.cardBrand,
            last4: row.cardLast4,
            expMonth: row.cardExpMonth,
            expYear: row.cardExpYear,
          }
        : null,
    status: row.status,
    metadata: parseMetadata(row.metadata),
    createdAt: row.createdAt.toISOString(),
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

export interface CreatePaymentMethodInput {
  cantilapayAccountId: string;
  mode: CantilapayMode;
  pspToken: string;
  customerId?: string;
  type?: string;
  card?: {
    brand?: string;
    last4?: string;
    expMonth?: number;
    expYear?: number;
  };
  metadata?: Record<string, string>;
}

export async function createPaymentMethod(
  prisma: PrismaClient,
  input: CreatePaymentMethodInput,
): Promise<CantilapayPaymentMethodView> {
  if (input.customerId) {
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
  }
  const row = await prisma.cantilapayPaymentMethod.create({
    data: {
      cantilapayAccountId: input.cantilapayAccountId,
      mode: input.mode,
      pspToken: input.pspToken,
      customerId: input.customerId ?? null,
      type: input.type ?? "card",
      cardBrand: input.card?.brand ?? null,
      cardLast4: input.card?.last4 ?? null,
      cardExpMonth: input.card?.expMonth ?? null,
      cardExpYear: input.card?.expYear ?? null,
      metadata: JSON.stringify(input.metadata ?? {}),
    },
  });
  await emitCantilapayEvent({
    prisma,
    cantilapayAccountId: input.cantilapayAccountId,
    mode: input.mode,
    type: "payment_method.attached",
    data: {
      id: row.id,
      customerId: row.customerId,
      type: row.type,
      cardLast4: row.cardLast4,
    },
  });
  return toView(row);
}

export async function getPaymentMethod(
  prisma: PrismaClient,
  input: { cantilapayAccountId: string; mode: CantilapayMode; id: string },
): Promise<CantilapayPaymentMethodView | null> {
  const row = await prisma.cantilapayPaymentMethod.findUnique({
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

export async function listPaymentMethods(
  prisma: PrismaClient,
  input: {
    cantilapayAccountId: string;
    mode: CantilapayMode;
    customerId?: string;
    limit?: number;
  },
): Promise<CantilapayPaymentMethodView[]> {
  const take = Math.max(1, Math.min(input.limit ?? 50, 100));
  const rows = await prisma.cantilapayPaymentMethod.findMany({
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

export async function detachPaymentMethod(
  prisma: PrismaClient,
  input: { cantilapayAccountId: string; mode: CantilapayMode; id: string },
): Promise<CantilapayPaymentMethodView | null> {
  const existing = await prisma.cantilapayPaymentMethod.findUnique({
    where: { id: input.id },
  });
  if (
    !existing ||
    existing.cantilapayAccountId !== input.cantilapayAccountId ||
    existing.mode !== input.mode
  ) {
    return null;
  }
  if (existing.status === "detached") return toView(existing);
  const row = await prisma.cantilapayPaymentMethod.update({
    where: { id: input.id },
    data: { status: "detached", detachedAt: new Date(), customerId: null },
  });
  await emitCantilapayEvent({
    prisma,
    cantilapayAccountId: input.cantilapayAccountId,
    mode: input.mode,
    type: "payment_method.detached",
    data: { id: row.id },
  });
  return toView(row);
}
