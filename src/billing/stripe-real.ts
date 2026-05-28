/* ============================================================
   StripeRealAdapter — the live Stripe-SDK-backed implementation.

   Same `StripeAdapter` interface as `StubStripeAdapter`; same call
   sites; no architectural change. Selected at boot when
   `STRIPE_SECRET_KEY` is present (plan §15.1).

   Pricing: callers configure the per-tier Stripe `Price.id` via
   env vars or the constructor opts. `STRIPE_PRICE_ID_HOBBY` etc.
   default to the stub's placeholder ids so a misconfigured deploy
   fails loudly at Stripe instead of silently charging the wrong
   plan. Webhook signature verification uses
   `stripe.webhooks.constructEvent` — the real HMAC-SHA256 + 5-min
   replay window check, not our own.
   ============================================================ */

import Stripe from "stripe";
import {
  STRIPE_PRICE_IDS,
  type StripeAdapter,
  type StripeBillingPortalSession,
  type StripeCheckoutSession,
  type StripeCustomer,
  type StripeEvent,
  type StripeInvoice,
  type StripeInvoiceItem,
  type StripePriceTier,
  type StripeSubscriptionItem,
} from "./stripe";
import {
  computeProration,
  type PlanChangeInput,
  type PlanChangeResult,
  type ProrationInput,
  type ProrationLineItem,
  type ProrationPreview,
} from "./proration";

/* The official `stripe` package exposes its type namespace under the
 * constructor as `StripeConstructor.Stripe.*` rather than the more
 * intuitive `Stripe.*` namespace merging. Since we only read a small,
 * stable subset of fields off each event object, narrowing to local
 * types here keeps the adapter self-contained and avoids reaching into
 * the SDK's internal namespace layout. */
type StripeCheckoutSessionResource = {
  id: string;
  customer: string | { id: string } | null;
  subscription: string | { id: string } | null;
  metadata?: Record<string, string> | null;
};
type StripeSubscriptionResource = {
  id: string;
  customer: string | { id: string };
  items?: { data: Array<{ price: { id: string } }> };
};
type StripeInvoiceResource = {
  id?: string | null;
  customer: string | { id: string } | null;
  amount_paid: number;
};

export interface StripeRealAdapterOpts {
  /** Stripe secret key (`sk_live_…` or `sk_test_…`). Required. */
  secretKey: string;
  /** Webhook signing secret (`whsec_…`). Required for `parseWebhook`. */
  webhookSecret: string;
  /** Stripe publishable key (`pk_…`). Optional — falls back to env
   *  `STRIPE_PUBLISHABLE_KEY`. Surfaced to the Console for embedded
   *  Checkout (plan §8.5 — Phase D). */
  publishableKey?: string;
  /** Override the per-tier Stripe `Price.id` mapping. Falls back to
   *  env vars (`STRIPE_PRICE_ID_HOBBY` etc.), then to the stub's
   *  placeholder ids. */
  priceIds?: Partial<Record<StripePriceTier, string>>;
}

export class StripeRealAdapter implements StripeAdapter {
  readonly label = "Stripe live";
  readonly live = true;
  readonly publishableKey?: string;
  private stripe: InstanceType<typeof Stripe>;
  private webhookSecret: string;
  private priceIds: Record<StripePriceTier, string>;

  constructor(opts: StripeRealAdapterOpts) {
    this.stripe = new Stripe(opts.secretKey);
    this.webhookSecret = opts.webhookSecret;
    this.publishableKey =
      opts.publishableKey ?? process.env.STRIPE_PUBLISHABLE_KEY;
    this.priceIds = {
      hobby:
        opts.priceIds?.hobby ??
        process.env.STRIPE_PRICE_ID_HOBBY ??
        STRIPE_PRICE_IDS.hobby,
      starter:
        opts.priceIds?.starter ??
        process.env.STRIPE_PRICE_ID_STARTER ??
        STRIPE_PRICE_IDS.starter,
      pro:
        opts.priceIds?.pro ??
        process.env.STRIPE_PRICE_ID_PRO ??
        STRIPE_PRICE_IDS.pro,
      agency:
        opts.priceIds?.agency ??
        process.env.STRIPE_PRICE_ID_AGENCY ??
        STRIPE_PRICE_IDS.agency,
    };
  }

  async createCustomer(input: {
    name: string;
    email?: string;
    metadata?: Record<string, string>;
  }): Promise<StripeCustomer> {
    const customer = await this.stripe.customers.create({
      name: input.name,
      email: input.email,
      metadata: input.metadata,
    });
    return {
      id: customer.id,
      email: customer.email ?? input.email ?? "",
      name: customer.name ?? input.name,
      metadata: (customer.metadata as Record<string, string>) ?? {},
    };
  }

  async createCheckoutSession(input: {
    customerId: string;
    tier: StripePriceTier;
    uiMode?: "hosted" | "embedded";
    successUrl?: string;
    cancelUrl?: string;
    returnUrl?: string;
  }): Promise<StripeCheckoutSession> {
    const priceId = this.priceIds[input.tier];
    const uiMode = input.uiMode ?? "hosted";
    if (uiMode === "embedded") {
      // Embedded Checkout (plan §8.5 — Phase D): the session is mounted
      // in-page by the Console via the client secret; `return_url` is
      // where Stripe redirects the page once the embedded form completes.
      // The cast covers older `stripe` SDK type defs whose `UiMode` union
      // hasn't picked up the live API's `"embedded"` value yet.
      const session = await this.stripe.checkout.sessions.create({
        ui_mode: "embedded" as never,
        mode: "subscription",
        customer: input.customerId,
        line_items: [{ price: priceId, quantity: 1 }],
        return_url:
          input.returnUrl ??
          "https://app.cantila.cloud/billing?checkout=success",
        metadata: { tier: input.tier },
      });
      return {
        id: session.id,
        uiMode,
        url: "",
        clientSecret: session.client_secret ?? undefined,
        customerId: input.customerId,
        priceId,
        tier: input.tier,
      };
    }
    const session = await this.stripe.checkout.sessions.create({
      mode: "subscription",
      customer: input.customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url:
        input.successUrl ??
        "https://app.cantila.cloud/billing?checkout=success",
      cancel_url:
        input.cancelUrl ??
        "https://app.cantila.cloud/billing?checkout=cancelled",
      // Stash the tier so the webhook handler can read it off the
      // session payload — Stripe doesn't carry our taxonomy natively.
      metadata: { tier: input.tier },
    });
    return {
      id: session.id,
      uiMode,
      url: session.url ?? "",
      customerId: input.customerId,
      priceId,
      tier: input.tier,
    };
  }

  async createBillingPortalSession(input: {
    customerId: string;
    returnUrl: string;
  }): Promise<StripeBillingPortalSession> {
    const session = await this.stripe.billingPortal.sessions.create({
      customer: input.customerId,
      return_url: input.returnUrl,
    });
    return {
      id: session.id,
      url: session.url ?? "",
      customerId: input.customerId,
    };
  }

  /** Proration preview (plan §8.5 — Phase C). Calls
   *  `stripe.invoices.createPreview` to surface Stripe's *authoritative*,
   *  cent-exact upcoming-invoice proration — which accounts for tax, an
   *  existing customer credit balance, and any extra subscription items
   *  (e.g. the per-number leases added in §8.4) that the local formula
   *  cannot see. The deterministic `computeProration` estimate is the
   *  fallback: if the preview call fails — an older Stripe SDK without
   *  `createPreview`, a network error, or a subscription with no line
   *  item — the adapter degrades to the estimate rather than failing the
   *  preview outright. The returned `source` records which path produced
   *  the figures so the Console can label them. */
  async previewProration(input: ProrationInput): Promise<ProrationPreview> {
    const estimate = computeProration(input);
    try {
      const subscription = await this.stripe.subscriptions.retrieve(
        input.subscriptionId,
      );
      const itemId = subscription.items.data[0]?.id;
      if (!itemId) return estimate;
      const upcoming = await this.stripe.invoices.createPreview({
        subscription: input.subscriptionId,
        subscription_details: {
          items: [{ id: itemId, price: this.priceIds[input.toTier] }],
          proration_behavior: "create_prorations",
        },
      });
      // Keep only the proration lines — `createPreview` also returns the
      // next billing cycle's full-price line, which is not part of the
      // change's cost.
      // Newer `stripe` SDKs nest `proration` under `parent.*_item_details`;
      // older SDKs put it directly on the line. Read both so the filter
      // works across SDK versions without a hard pin.
      const prorationLines = upcoming.lines.data.filter((l) => {
        const line = l as unknown as {
          proration?: boolean;
          parent?: {
            invoice_item_details?: { proration?: boolean };
            subscription_item_details?: { proration?: boolean };
          };
        };
        return (
          line.proration === true ||
          line.parent?.invoice_item_details?.proration === true ||
          line.parent?.subscription_item_details?.proration === true
        );
      });
      if (prorationLines.length === 0) return estimate;
      const lines: ProrationLineItem[] = prorationLines.map((l) => ({
        description: l.description ?? "Proration adjustment",
        amountCents: l.amount,
      }));
      const creditCents = lines
        .filter((l) => l.amountCents < 0)
        .reduce((sum, l) => sum + l.amountCents, 0);
      const chargeCents = lines
        .filter((l) => l.amountCents >= 0)
        .reduce((sum, l) => sum + l.amountCents, 0);
      const amountDueCents = creditCents + chargeCents;
      return {
        ...estimate,
        creditCents,
        chargeCents,
        amountDueCents,
        isUpgrade: amountDueCents > 0,
        lines,
        source: "stripe",
      };
    } catch {
      // Any failure — old SDK, network, no subscription item — degrades
      // to the deterministic local estimate (`source: "estimate"`).
      return estimate;
    }
  }

  /** Commit a mid-period plan change against the live Stripe API:
   *  retrieve the subscription, then `subscriptions.update` its single
   *  line item onto the new tier's `Price` with the chosen
   *  `proration_behavior`. Stripe writes the proration line items —
   *  and, for `always_invoice`, an immediate invoice — itself; the
   *  `customer.subscription.updated` webhook then reconciles the tier
   *  back onto the Account. */
  async changeSubscriptionPlan(
    input: PlanChangeInput,
  ): Promise<PlanChangeResult> {
    const subscription = await this.stripe.subscriptions.retrieve(
      input.subscriptionId,
    );
    const itemId = subscription.items.data[0]?.id;
    if (!itemId) {
      throw new Error(
        `subscription ${input.subscriptionId} has no line items to reprice`,
      );
    }
    await this.stripe.subscriptions.update(input.subscriptionId, {
      items: [{ id: itemId, price: this.priceIds[input.toTier] }],
      proration_behavior: input.prorationBehavior,
    });
    // Stripe's invoice is the source of truth; we report the local
    // estimate (identical formula) for the immediate API response.
    const estimate = computeProration(input);
    return {
      subscriptionId: input.subscriptionId,
      fromTier: input.fromTier,
      toTier: input.toTier,
      amountDueCents:
        input.prorationBehavior === "none" ? 0 : estimate.amountDueCents,
      invoicedNow: input.prorationBehavior === "always_invoice",
      prorationBehavior: input.prorationBehavior,
    };
  }

  /** Bill a recurring add-on (plan §8 — per-number lease). `prices.create`
   *  accepts an inline `product_data`, so a per-number recurring `Price` is
   *  minted on the fly — no pre-configured Product or env price id — and
   *  then attached to the account's subscription with
   *  `subscriptionItems.create`. The returned `si_…` id is what the control
   *  plane persists on the `MarketplaceNumber`. */
  async addSubscriptionItem(input: {
    subscriptionId: string;
    amountCents: number;
    description: string;
    currency?: string;
    metadata?: Record<string, string>;
  }): Promise<StripeSubscriptionItem> {
    const price = await this.stripe.prices.create({
      currency: input.currency ?? "usd",
      unit_amount: input.amountCents,
      recurring: { interval: "month" },
      product_data: { name: input.description },
    });
    const item = await this.stripe.subscriptionItems.create({
      subscription: input.subscriptionId,
      price: price.id,
      quantity: 1,
      metadata: input.metadata,
    });
    return {
      id: item.id,
      subscriptionId: input.subscriptionId,
      amountCents: input.amountCents,
      description: input.description,
    };
  }

  /** Stop a recurring add-on. `create_prorations` credits the unused slice
   *  of the lease back to the customer when a number is released or
   *  transferred mid-cycle — Stripe writes the credit note itself. */
  async removeSubscriptionItem(input: {
    subscriptionItemId: string;
  }): Promise<void> {
    await this.stripe.subscriptionItems.del(input.subscriptionItemId, {
      proration_behavior: "create_prorations",
    });
  }

  /** Bill a one-time charge (plan §8 — a number's setup fee).
   *  `invoiceItems.create` leaves the charge pending on the customer; it is
   *  swept onto their next subscription invoice automatically. */
  async addInvoiceItem(input: {
    customerId: string;
    amountCents: number;
    description: string;
    currency?: string;
    metadata?: Record<string, string>;
  }): Promise<StripeInvoiceItem> {
    const item = await this.stripe.invoiceItems.create({
      customer: input.customerId,
      amount: input.amountCents,
      currency: input.currency ?? "usd",
      description: input.description,
      metadata: input.metadata,
    });
    return {
      id: item.id,
      customerId: input.customerId,
      amountCents: input.amountCents,
      description: input.description,
    };
  }

  /** Real billing history (plan §8.5 — Phase B): `stripe.invoices.list`
   *  for the customer, newest first, narrowed to the read-only fields the
   *  Console invoice list renders — including Stripe's own
   *  `hosted_invoice_url` (view / pay) and `invoice_pdf` (download). */
  async listInvoices(input: {
    customerId: string;
    limit?: number;
  }): Promise<StripeInvoice[]> {
    const page = await this.stripe.invoices.list({
      customer: input.customerId,
      limit: Math.max(1, Math.min(input.limit ?? 12, 100)),
    });
    return page.data.map((inv) => ({
      id: inv.id ?? "",
      number: inv.number ?? null,
      status: (inv.status ?? "open") as StripeInvoice["status"],
      amountCents: inv.total,
      amountPaidCents: inv.amount_paid,
      currency: inv.currency,
      createdAt: new Date(inv.created * 1000).toISOString(),
      hostedInvoiceUrl: inv.hosted_invoice_url ?? null,
      invoicePdfUrl: inv.invoice_pdf ?? null,
    }));
  }

  parseWebhook(rawBody: string, signatureHeader: string | undefined): StripeEvent {
    if (!signatureHeader) throw new Error("missing Stripe-Signature header");
    // `constructEvent` enforces HMAC-SHA256, the 5-minute replay window,
    // and throws on tampered payloads — the real thing, not our HMAC.
    const event = this.stripe.webhooks.constructEvent(
      rawBody,
      signatureHeader,
      this.webhookSecret,
    );

    // Translate the live Stripe event into the slim `StripeEvent` shape
    // the ControlPlane dispatch handler expects. Stripe's full event
    // type is huge; we narrow to the fields we actually read.
    const out: StripeEvent = {
      id: event.id,
      type: event.type as StripeEvent["type"],
      data: { object: { id: "" } },
    };
    // Each branch below uses `as` because Stripe's discriminated union
    // is wider than our narrow `StripeEvent["type"]` set — any other
    // event type would never reach the dispatch table.
    if (event.type === "checkout.session.completed") {
      const s = event.data.object as unknown as StripeCheckoutSessionResource;
      out.data.object = {
        id: s.id,
        customer: typeof s.customer === "string" ? s.customer : undefined,
        subscription:
          typeof s.subscription === "string" ? s.subscription : undefined,
        tier: (s.metadata?.tier as StripePriceTier) ?? "starter",
      };
    } else if (
      event.type === "customer.subscription.updated" ||
      event.type === "customer.subscription.deleted"
    ) {
      const s = event.data.object as unknown as StripeSubscriptionResource;
      const item = s.items?.data?.[0];
      const tier = this.tierForPriceId(
        typeof item?.price?.id === "string" ? item.price.id : undefined,
      );
      out.data.object = {
        id: s.id,
        customer: typeof s.customer === "string" ? s.customer : undefined,
        items: item ? [{ price_id: item.price.id, tier }] : undefined,
      };
    } else if (
      event.type === "invoice.paid" ||
      event.type === "invoice.payment_failed"
    ) {
      const inv = event.data.object as unknown as StripeInvoiceResource;
      out.data.object = {
        id: inv.id ?? "",
        customer: typeof inv.customer === "string" ? inv.customer : undefined,
        amount_paid: inv.amount_paid,
      };
    } else {
      // Some other event we don't care about — surface it through the
      // dispatch table as a no-op (handler doesn't switch on it).
      out.data.object = { id: "" };
    }
    return out;
  }

  /** Look up which tier a Stripe `Price.id` represents — used by
   *  subscription-update events to map the new price back to our tier
   *  taxonomy. Returns `undefined` when the price is not a configured
   *  Cantila tier (custom enterprise pricing, etc.). */
  private tierForPriceId(priceId: string | undefined): StripePriceTier | undefined {
    if (!priceId) return undefined;
    for (const tier of ["hobby", "starter", "pro", "agency"] as StripePriceTier[]) {
      if (this.priceIds[tier] === priceId) return tier;
    }
    return undefined;
  }
}
