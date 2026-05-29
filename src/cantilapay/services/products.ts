/* ============================================================
   Cantilapay — Product service (plan §25, Phase 2).

   A Product is "a thing you sell" — e.g. "Cantila Hobby Plan".
   Prices attach to it. Same Stripe shape so SDK consumers can
   port between Stripe and Cantilapay without rethinking the
   resource graph.
   ============================================================ */

import type { PrismaClient } from "@prisma/client";

import type {
  CantilapayMode,
  CantilapayProductView,
} from "../types";
import { CantilapayError } from "../errors";
import { emitCantilapayEvent } from "./events";

function toView(row: {
  id: string;
  mode: CantilapayMode;
  name: string;
  description: string | null;
  active: boolean;
  metadata: string;
  createdAt: Date;
  updatedAt: Date;
}): CantilapayProductView {
  return {
    id: row.id,
    mode: row.mode,
    name: row.name,
    description: row.description,
    active: row.active,
    metadata: parseMetadata(row.metadata),
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

export interface CreateProductInput {
  cantilapayAccountId: string;
  mode: CantilapayMode;
  name: string;
  description?: string;
  active?: boolean;
  metadata?: Record<string, string>;
}

export async function createProduct(
  prisma: PrismaClient,
  input: CreateProductInput,
): Promise<CantilapayProductView> {
  const row = await prisma.cantilapayProduct.create({
    data: {
      cantilapayAccountId: input.cantilapayAccountId,
      mode: input.mode,
      name: input.name,
      description: input.description ?? null,
      active: input.active ?? true,
      metadata: JSON.stringify(input.metadata ?? {}),
    },
  });
  await emitCantilapayEvent({
    prisma,
    cantilapayAccountId: input.cantilapayAccountId,
    mode: input.mode,
    type: "product.created",
    data: { id: row.id, name: row.name },
  });
  return toView(row);
}

export async function getProduct(
  prisma: PrismaClient,
  input: { cantilapayAccountId: string; mode: CantilapayMode; id: string },
): Promise<CantilapayProductView | null> {
  const row = await prisma.cantilapayProduct.findUnique({ where: { id: input.id } });
  if (
    !row ||
    row.cantilapayAccountId !== input.cantilapayAccountId ||
    row.mode !== input.mode
  ) {
    return null;
  }
  return toView(row);
}

export async function listProducts(
  prisma: PrismaClient,
  input: {
    cantilapayAccountId: string;
    mode: CantilapayMode;
    activeOnly?: boolean;
    limit?: number;
  },
): Promise<CantilapayProductView[]> {
  const take = Math.max(1, Math.min(input.limit ?? 50, 100));
  const rows = await prisma.cantilapayProduct.findMany({
    where: {
      cantilapayAccountId: input.cantilapayAccountId,
      mode: input.mode,
      active: input.activeOnly ? true : undefined,
    },
    orderBy: { createdAt: "desc" },
    take,
  });
  return rows.map(toView);
}

export async function updateProduct(
  prisma: PrismaClient,
  input: {
    cantilapayAccountId: string;
    mode: CantilapayMode;
    id: string;
    name?: string;
    description?: string | null;
    active?: boolean;
    metadata?: Record<string, string>;
  },
): Promise<CantilapayProductView> {
  const existing = await prisma.cantilapayProduct.findUnique({ where: { id: input.id } });
  if (
    !existing ||
    existing.cantilapayAccountId !== input.cantilapayAccountId ||
    existing.mode !== input.mode
  ) {
    throw CantilapayError.notFound("product");
  }
  const row = await prisma.cantilapayProduct.update({
    where: { id: input.id },
    data: {
      name: input.name ?? existing.name,
      description:
        input.description !== undefined ? input.description : existing.description,
      active: input.active !== undefined ? input.active : existing.active,
      metadata:
        input.metadata !== undefined
          ? JSON.stringify(input.metadata)
          : existing.metadata,
    },
  });
  await emitCantilapayEvent({
    prisma,
    cantilapayAccountId: input.cantilapayAccountId,
    mode: input.mode,
    type: "product.updated",
    data: { id: row.id },
  });
  return toView(row);
}
