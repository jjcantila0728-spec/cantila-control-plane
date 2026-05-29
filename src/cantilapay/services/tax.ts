/* ============================================================
   Cantilapay — Tax service (plan §25, Phase 5).

   Wraps the tax-provider port + persistence in
   CantilapayTaxCalculation. Calc-only — cantilapay does not
   file; tenant remains MoR.
   ============================================================ */

import type { PrismaClient } from "@prisma/client";

import type { TaxProvider } from "../adapters/tax-port";
import type {
  CantilapayMode,
  CantilapayTaxCalculationView,
} from "../types";
import { CantilapayError } from "../errors";
import { emitCantilapayEvent } from "./events";

function toView(row: {
  id: string;
  mode: CantilapayMode;
  amount: number;
  currency: string;
  customerCountry: string;
  customerState: string | null;
  customerPostalCode: string | null;
  taxAmount: number;
  taxRateBps: number;
  breakdown: string;
  provider: string;
  productCategory: string | null;
  createdAt: Date;
}): CantilapayTaxCalculationView {
  let breakdown: CantilapayTaxCalculationView["breakdown"] = [];
  try {
    const parsed = JSON.parse(row.breakdown) as unknown;
    if (Array.isArray(parsed)) {
      breakdown = parsed as CantilapayTaxCalculationView["breakdown"];
    }
  } catch {
    /* fall through */
  }
  return {
    id: row.id,
    mode: row.mode,
    amount: row.amount,
    currency: row.currency,
    customerCountry: row.customerCountry,
    customerState: row.customerState,
    customerPostalCode: row.customerPostalCode,
    taxAmount: row.taxAmount,
    taxRateBps: row.taxRateBps,
    breakdown,
    provider: row.provider,
    productCategory: row.productCategory,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface CalculateTaxInput {
  cantilapayAccountId: string;
  mode: CantilapayMode;
  amount: number;
  currency: string;
  customerCountry: string;
  customerState?: string;
  customerPostalCode?: string;
  productCategory?: string;
}

export async function calculateTax(
  prisma: PrismaClient,
  provider: TaxProvider,
  input: CalculateTaxInput,
): Promise<CantilapayTaxCalculationView> {
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    throw CantilapayError.invalidField(
      "amount must be a positive integer in minor units",
      "amount",
    );
  }
  if (!/^[a-z]{3}$/.test(input.currency)) {
    throw CantilapayError.invalidField(
      "currency must be ISO-4217 lowercase",
      "currency",
    );
  }
  const result = await provider.calculate({
    amount: input.amount,
    currency: input.currency,
    customerCountry: input.customerCountry,
    customerState: input.customerState,
    customerPostalCode: input.customerPostalCode,
    productCategory: input.productCategory,
    mode: input.mode,
  });
  const row = await prisma.cantilapayTaxCalculation.create({
    data: {
      cantilapayAccountId: input.cantilapayAccountId,
      mode: input.mode,
      amount: input.amount,
      currency: input.currency,
      customerCountry: input.customerCountry,
      customerState: input.customerState ?? null,
      customerPostalCode: input.customerPostalCode ?? null,
      taxAmount: result.taxAmount,
      taxRateBps: result.taxRateBps,
      breakdown: JSON.stringify(result.breakdown),
      provider: provider.label,
      productCategory: input.productCategory ?? null,
    },
  });
  await emitCantilapayEvent({
    prisma,
    cantilapayAccountId: input.cantilapayAccountId,
    mode: input.mode,
    type: "tax.calculation.created",
    data: {
      id: row.id,
      amount: row.amount,
      taxAmount: row.taxAmount,
      provider: provider.label,
    },
  });
  return toView(row);
}

export async function getTaxCalculation(
  prisma: PrismaClient,
  input: { cantilapayAccountId: string; mode: CantilapayMode; id: string },
): Promise<CantilapayTaxCalculationView | null> {
  const row = await prisma.cantilapayTaxCalculation.findUnique({
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
