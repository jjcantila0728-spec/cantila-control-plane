/* ============================================================
   Cantilapay — Customer service (plan §25, Phase 1).

   Cantilapay-shaped Customer CRUD, scoped to (cantilapayAccount, mode).
   `externalRef` lets a tenant upsert-by-their-own-id (Stripe calls
   this `idempotency_key`-by-side-effect; here we make it explicit).
   ============================================================ */

import type { PrismaClient } from "@prisma/client";

import type {
  CantilapayCustomerView,
  CantilapayMode,
} from "../types";
import { CantilapayError } from "../errors";
import { emitCantilapayEvent } from "./events";

function toView(row: {
  id: string;
  mode: CantilapayMode;
  externalRef: string | null;
  email: string | null;
  name: string | null;
  description: string | null;
  metadata: string;
  createdAt: Date;
  updatedAt: Date;
}): CantilapayCustomerView {
  return {
    id: row.id,
    mode: row.mode,
    externalRef: row.externalRef,
    email: row.email,
    name: row.name,
    description: row.description,
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

export interface CreateCustomerInput {
  cantilapayAccountId: string;
  mode: CantilapayMode;
  externalRef?: string;
  email?: string;
  name?: string;
  description?: string;
  metadata?: Record<string, string>;
}

export async function createCustomer(
  prisma: PrismaClient,
  input: CreateCustomerInput,
): Promise<CantilapayCustomerView> {
  // Upsert-by-externalRef when set so the tenant gets idempotent
  // create-by-their-own-id.
  if (input.externalRef) {
    const existing = await prisma.cantilapayCustomer.findUnique({
      where: {
        cantilapayAccountId_mode_externalRef: {
          cantilapayAccountId: input.cantilapayAccountId,
          mode: input.mode,
          externalRef: input.externalRef,
        },
      },
    });
    if (existing) return toView(existing);
  }
  const row = await prisma.cantilapayCustomer.create({
    data: {
      cantilapayAccountId: input.cantilapayAccountId,
      mode: input.mode,
      externalRef: input.externalRef ?? null,
      email: input.email ?? null,
      name: input.name ?? null,
      description: input.description ?? null,
      metadata: JSON.stringify(input.metadata ?? {}),
    },
  });
  await emitCantilapayEvent({
    prisma,
    cantilapayAccountId: input.cantilapayAccountId,
    mode: input.mode,
    type: "customer.created",
    data: { id: row.id, externalRef: row.externalRef ?? null },
  });
  return toView(row);
}

export async function getCustomer(
  prisma: PrismaClient,
  input: { cantilapayAccountId: string; mode: CantilapayMode; id: string },
): Promise<CantilapayCustomerView | null> {
  const row = await prisma.cantilapayCustomer.findUnique({
    where: { id: input.id },
  });
  if (!row || row.cantilapayAccountId !== input.cantilapayAccountId || row.mode !== input.mode) {
    return null;
  }
  return toView(row);
}

export async function listCustomers(
  prisma: PrismaClient,
  input: {
    cantilapayAccountId: string;
    mode: CantilapayMode;
    limit?: number;
  },
): Promise<CantilapayCustomerView[]> {
  const take = Math.max(1, Math.min(input.limit ?? 50, 100));
  const rows = await prisma.cantilapayCustomer.findMany({
    where: { cantilapayAccountId: input.cantilapayAccountId, mode: input.mode },
    orderBy: { createdAt: "desc" },
    take,
  });
  return rows.map(toView);
}

export async function updateCustomer(
  prisma: PrismaClient,
  input: {
    cantilapayAccountId: string;
    mode: CantilapayMode;
    id: string;
    email?: string | null;
    name?: string | null;
    description?: string | null;
    metadata?: Record<string, string>;
  },
): Promise<CantilapayCustomerView> {
  const existing = await prisma.cantilapayCustomer.findUnique({
    where: { id: input.id },
  });
  if (
    !existing ||
    existing.cantilapayAccountId !== input.cantilapayAccountId ||
    existing.mode !== input.mode
  ) {
    throw CantilapayError.notFound("customer");
  }
  const row = await prisma.cantilapayCustomer.update({
    where: { id: input.id },
    data: {
      email: input.email !== undefined ? input.email : existing.email,
      name: input.name !== undefined ? input.name : existing.name,
      description:
        input.description !== undefined ? input.description : existing.description,
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
    type: "customer.updated",
    data: { id: row.id },
  });
  return toView(row);
}

export async function deleteCustomer(
  prisma: PrismaClient,
  input: { cantilapayAccountId: string; mode: CantilapayMode; id: string },
): Promise<{ id: string; deleted: true } | null> {
  const existing = await prisma.cantilapayCustomer.findUnique({
    where: { id: input.id },
  });
  if (
    !existing ||
    existing.cantilapayAccountId !== input.cantilapayAccountId ||
    existing.mode !== input.mode
  ) {
    return null;
  }
  await prisma.cantilapayCustomer.delete({ where: { id: input.id } });
  await emitCantilapayEvent({
    prisma,
    cantilapayAccountId: input.cantilapayAccountId,
    mode: input.mode,
    type: "customer.deleted",
    data: { id: input.id },
  });
  return { id: input.id, deleted: true };
}
