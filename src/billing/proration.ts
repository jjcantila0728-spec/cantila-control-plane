/* ============================================================
   Mid-period proration (plan §8 / §15.2 — plan changes).

   When a customer changes plan partway through a billing period, the
   amount owed is not the full new price — it is prorated. Stripe's
   model, which this module mirrors exactly:

     • credit the unused portion of the OLD plan, and
     • charge the same time-slice of the NEW plan.

   `computeProration` is the deterministic engine. It is PURE — no
   Stripe, no I/O — so the `StubStripeAdapter` can return an exact
   proration preview offline, and the `StripeRealAdapter` uses it as a
   local estimate alongside the authoritative figure Stripe computes
   when the change is committed via `subscriptions.update`.

   Sign convention: a credit is NEGATIVE cents, a charge is POSITIVE.
   `amountDueCents` is their sum — positive means "invoiced now",
   negative means "credit carried to the next invoice" (a downgrade).
   ============================================================ */

import type { StripePriceTier } from "./stripe";

/** How Stripe should settle the proration when the change is committed.
 *  Mirrors Stripe's `proration_behavior` enum 1:1.
 *  - `create_prorations` — write proration line items onto the next
 *    invoice (Stripe's default; no immediate charge).
 *  - `always_invoice`    — invoice the proration immediately.
 *  - `none`              — change the plan with no proration at all. */
export type ProrationBehavior =
  | "create_prorations"
  | "always_invoice"
  | "none";

/** Everything `computeProration` (and the adapters) need to price a
 *  mid-period plan change. */
export interface ProrationInput {
  /** Stripe `Subscription.id` being modified. */
  subscriptionId: string;
  fromTier: StripePriceTier;
  toTier: StripePriceTier;
  /** Monthly list price of the current plan, in cents. */
  fromPriceCents: number;
  /** Monthly list price of the target plan, in cents. */
  toPriceCents: number;
  /** ISO timestamp — start of the current billing period. */
  periodStart: string;
  /** ISO timestamp — end of the current billing period. */
  periodEnd: string;
  /** ISO timestamp the proration is calculated against (usually now). */
  now: string;
}

/** A `ProrationInput` plus the chosen settlement behavior — the shape
 *  for committing a change. */
export interface PlanChangeInput extends ProrationInput {
  prorationBehavior: ProrationBehavior;
}

/** One line on a proration preview — a credit (negative) or charge. */
export interface ProrationLineItem {
  description: string;
  /** Cents — negative for a credit, positive for a charge. */
  amountCents: number;
}

/** What a mid-period plan change will cost, before committing it. */
export interface ProrationPreview {
  fromTier: StripePriceTier;
  toTier: StripePriceTier;
  /** Credit for the unused portion of the current plan (≤ 0). */
  creditCents: number;
  /** Prorated charge for the rest of the period on the new plan (≥ 0). */
  chargeCents: number;
  /** Net Stripe settles immediately — `chargeCents + creditCents`.
   *  Positive = charged now; negative = credited to the next invoice. */
  amountDueCents: number;
  /** Fraction of the billing period still remaining, 0..1. */
  remainingFraction: number;
  /** ISO timestamp the proration was calculated against. */
  prorationDate: string;
  /** ISO timestamp — end of the current billing period. */
  periodEnd: string;
  /** Whether this change costs money now (`true`) or yields a credit. */
  isUpgrade: boolean;
  lines: ProrationLineItem[];
  /** Where the figures came from: `"stripe"` when the live adapter pulled
   *  Stripe's authoritative upcoming-invoice preview
   *  (`invoices.createPreview`), `"estimate"` when they are the
   *  deterministic local computation — the stub, or the live adapter
   *  degrading on a Stripe error (plan §8.5 — Phase C). */
  source: "stripe" | "estimate";
}

/** The outcome of committing a plan change. */
export interface PlanChangeResult {
  subscriptionId: string;
  fromTier: StripePriceTier;
  toTier: StripePriceTier;
  /** Net proration amount, in cents (see `ProrationPreview.amountDueCents`). */
  amountDueCents: number;
  /** True when the proration was invoiced immediately (`always_invoice`);
   *  false when it was rolled onto the next invoice. */
  invoicedNow: boolean;
  /** Which behavior Stripe was asked to apply. */
  prorationBehavior: ProrationBehavior;
}

/** Compute the proration for a mid-period plan change. Pure and
 *  deterministic — the same inputs always yield the same preview, which
 *  is what makes the stub adapter testable offline. */
export function computeProration(input: ProrationInput): ProrationPreview {
  const periodStartMs = Date.parse(input.periodStart);
  const periodEndMs = Date.parse(input.periodEnd);
  const nowMs = Date.parse(input.now);

  // Guard against a zero/negative-length or malformed period.
  const periodMs = Math.max(1, periodEndMs - periodStartMs);
  // Fraction of the period still to run, clamped to [0, 1].
  const remainingFraction = Math.min(
    1,
    Math.max(0, (periodEndMs - nowMs) / periodMs),
  );

  // Credit the unused slice of the old plan; charge the same slice of
  // the new one. Round each leg independently — that is what Stripe
  // does, so the net matches its invoice to the cent.
  const creditCents = -Math.round(input.fromPriceCents * remainingFraction);
  const chargeCents = Math.round(input.toPriceCents * remainingFraction);
  const amountDueCents = chargeCents + creditCents;

  const lines: ProrationLineItem[] = [
    {
      description: `Unused time on ${input.fromTier} plan`,
      amountCents: creditCents,
    },
    {
      description: `Remaining time on ${input.toTier} plan`,
      amountCents: chargeCents,
    },
  ];

  return {
    fromTier: input.fromTier,
    toTier: input.toTier,
    creditCents,
    chargeCents,
    amountDueCents,
    remainingFraction,
    prorationDate: input.now,
    periodEnd: input.periodEnd,
    isUpgrade: amountDueCents > 0,
    lines,
    source: "estimate",
  };
}
