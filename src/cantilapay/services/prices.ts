/* ============================================================
   Cantilapay — Price service (plan §25, Phase 2).

   A Price is a specific monetary configuration on a Product:
   "$9/month", "$90/year". Subscriptions reference a price; a
   plan change is "swap this subscription's priceId".
   ============================================================ */

import type { PrismaClient } from "@prisma/client";

import type {
  CantilapayMode,
  CantilapayPriceInterval,
  CantilapayPriceView,
} from "../types";
import { CantilapayError } from "../errors";
import { emitCantilapayEvent } from "./events";

function toView(row: {
  id: string;
  mode: CantilapayMode;
  productId: string;
  unitAmount: number;
  currency: string;
  recurringInterval: CantilapayPriceInterval;
  recurringIntervalCount: number;
  trialPeriodDays: number;
  active: boolean;
  metadata: string;
  createdAt: Date;
}): CantilapayPriceView {
  return {
    id: row.id,
    mode: row.mode,
    productId: row.productId,
    unitAmount: row.unitAmount,
    currency: row.currency,
    recurring: {
      interval: row.recurringInterval,
      intervalCount: row.recurringIntervalCount,
      trialPeriodDays: row.trialPeriodDays,
    },
    active: row.active,
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

export interface CreatePriceInput {
  cantilapayAccountId: string;
  mode: CantilapayMode;
  productId: string;
  unitAmount: number;
  currency: string;
  recurring: {
    interval: CantilapayPriceInterval;
    intervalCount?: number;
    trialPeriodDays?: number;
  };
  metadata?: Record<string, string>;
}

export async function createPrice(
  prisma: PrismaClient,
  input: CreatePriceInput,
): Promise<CantilapayPriceView> {
  const product = await prisma.cantilapayProduct.findUnique({
    where: { id: input.productId },
  });
  if (
    !product ||
    product.cantilapayAccountId !== input.cantilapayAccountId ||
    product.mode !== input.mode
  ) {
    throw CantilapayError.notFound("product");
  }
  if (!Number.isInteger(input.unitAmount) || input.unitAmount <= 0) {
    throw CantilapayError.invalidField(
      "unitAmount must be a positive integer in minor units",
      "unitAmount",
    );
  }
  if (!/^[a-z]{3}$/.test(input.currency)) {
    throw CantilapayError.invalidField(
      "currency must be ISO-4217 lowercase",
      "currency",
    );
  }
  const row = await prisma.cantilapayPrice.create({
    data: {
      cantilapayAccountId: input.cantilapayAccountId,
      mode: input.mode,
      productId: input.productId,
      unitAmount: input.unitAmount,
      currency: input.currency,
      recurringInterval: input.recurring.interval,
      recurringIntervalCount: input.recurring.intervalCount ?? 1,
      trialPeriodDays: input.recurring.trialPeriodDays ?? 0,
      metadata: JSON.stringify(input.metadata ?? {}),
    },
  });
  await emitCantilapayEvent({
    prisma,
    cantilapayAccountId: input.cantilapayAccountId,
    mode: input.mode,
    type: "price.created",
    data: { id: row.id, productId: row.productId, unitAmount: row.unitAmount },
  });
  return toView(row);
}

export async function getPrice(
  prisma: PrismaClient,
  input: { cantilapayAccountId: string; mode: CantilapayMode; id: string },
): Promise<CantilapayPriceView | null> {
  const row = await prisma.cantilapayPrice.findUnique({ where: { id: input.id } });
  if (
    !row ||
    row.cantilapayAccountId !== input.cantilapayAccountId ||
    row.mode !== input.mode
  ) {
    return null;
  }
  return toView(row);
}

export async function listPrices(
  prisma: PrismaClient,
  input: {
    cantilapayAccountId: string;
    mode: CantilapayMode;
    productId?: string;
    activeOnly?: boolean;
    limit?: number;
  },
): Promise<CantilapayPriceView[]> {
  const take = Math.max(1, Math.min(input.limit ?? 50, 100));
  const rows = await prisma.cantilapayPrice.findMany({
    where: {
      cantilapayAccountId: input.cantilapayAccountId,
      mode: input.mode,
      productId: input.productId ?? undefined,
      active: input.activeOnly ? true : undefined,
    },
    orderBy: { createdAt: "desc" },
    take,
  });
  return rows.map(toView);
}
