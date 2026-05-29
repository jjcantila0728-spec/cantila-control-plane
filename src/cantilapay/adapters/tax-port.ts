/* ============================================================
   Cantilapay — Tax provider port (plan §25, Phase 5).

   Cantilapay computes tax via an external provider. Phase 5
   ships:
     - the port (this file)
     - StubTaxProvider — returns 0 tax, so non-US dev/test works
     - AnrokTaxProvider — skeleton (real wiring needs Anrok account)
     - selectTaxProvider — env-gated selection

   Calc-only: cantilapay does NOT file. The tenant is the
   Merchant of Record and remains responsible for filing in
   their jurisdictions.
   ============================================================ */

import type { CantilapayMode } from "../types";

export interface TaxBreakdownLine {
  /** Jurisdiction name, e.g. "California state tax", "GST (Australia)". */
  jurisdiction: string;
  /** Tax type, e.g. "state", "county", "city", "vat", "gst". */
  type: string;
  /** Rate in basis points (10000 = 100%). */
  rateBps: number;
  /** Tax amount in minor units. */
  amount: number;
}

export interface TaxCalculationInput {
  amount: number;
  currency: string;
  customerCountry: string;
  customerState?: string;
  customerPostalCode?: string;
  productCategory?: string;
  mode: CantilapayMode;
}

export interface TaxCalculationResult {
  taxAmount: number;
  /** Effective combined rate in basis points. */
  taxRateBps: number;
  breakdown: TaxBreakdownLine[];
}

export interface TaxProvider {
  readonly label: string;
  readonly live: boolean;
  calculate(input: TaxCalculationInput): Promise<TaxCalculationResult>;
}

export class StubTaxProvider implements TaxProvider {
  readonly label = "stub";
  readonly live = false;
  async calculate(_input: TaxCalculationInput): Promise<TaxCalculationResult> {
    return { taxAmount: 0, taxRateBps: 0, breakdown: [] };
  }
}

export class AnrokTaxProvider implements TaxProvider {
  readonly label = "Anrok";
  readonly live = true;
  constructor(private readonly cfg: { apiKey: string }) {}
  async calculate(_input: TaxCalculationInput): Promise<TaxCalculationResult> {
    throw new Error(
      "AnrokTaxProvider.calculate — wires against Anrok's /transactions API once the live key + jurisdiction setup are configured. Phase 5 ships the skeleton.",
    );
  }
}

export interface TaxProviderSelection {
  provider: TaxProvider;
  label: string;
  live: boolean;
}

export function selectTaxProvider(
  env: NodeJS.ProcessEnv = process.env,
): TaxProviderSelection {
  const apiKey = env.ANROK_API_KEY?.trim();
  if (apiKey) {
    const p = new AnrokTaxProvider({ apiKey });
    return { provider: p, label: p.label, live: true };
  }
  const p = new StubTaxProvider();
  return { provider: p, label: p.label, live: false };
}
