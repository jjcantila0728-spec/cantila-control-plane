/* ============================================================
   Stripe rail (plan §8, §15.2 — Stripe charges).

   This file is the *adapter port*. The control plane talks to the
   `StripeAdapter` interface and never to the Stripe SDK directly,
   so swapping the stub for a real Stripe-SDK-backed implementation
   is a one-file change behind the same shape.

   The bundled `StubStripeAdapter` is the default — it returns
   deterministic fake ids (`cus_stub_…`, `cs_stub_…`, `sub_stub_…`),
   accepts any webhook signature, and produces realistic
   `checkout.session.completed` events from `simulateCheckoutCompleted`
   so the rail is testable end-to-end without an internet connection.

   When `STRIPE_SECRET_KEY` is set in env, the control plane should
   dynamically import `./stripe-real` (added in a follow-up drop) and
   construct that adapter instead. Until then, every install gets the
   stub — same shape, no surprises.
   ============================================================ */

import { createHmac, timingSafeEqual } from "node:crypto";
import {
  computeProration,
  type PlanChangeInput,
  type PlanChangeResult,
  type ProrationInput,
  type ProrationPreview,
} from "./proration";

export type StripePriceTier = "hobby" | "starter" | "pro" | "agency";

/** Mapping of Cantila plan tiers to Stripe Price ids. The real ids land
 *  on the Stripe dashboard; the stub uses placeholders so the rail can
 *  validate without a Stripe account. */
export const STRIPE_PRICE_IDS: Record<StripePriceTier, string> = {
  hobby: "price_stub_hobby",
  starter: "price_stub_starter",
  pro: "price_stub_pro",
  agency: "price_stub_agency",
};

export interface StripeCustomer {
  id: string;
  email: string;
  name: string;
  metadata: Record<string, string>;
}

export interface StripeCheckoutSession {
  /** `cs_…` id — never used to charge, only to redirect / mount checkout. */
  id: string;
  /** Which surface this session is for (plan §8.5 — Phase D). */
  uiMode: "hosted" | "embedded";
  /** Hosted checkout URL the Console / CLI redirects the buyer to — set in
   *  `hosted` mode, empty string in `embedded` mode. */
  url: string;
  /** Embedded-checkout client secret — set in `embedded` mode only. The
   *  Console mounts the in-page checkout form with this plus the
   *  publishable key. */
  clientSecret?: string;
  /** Customer the session is attached to. */
  customerId: string;
  /** Stripe Price id being purchased. */
  priceId: string;
  /** Cantila plan tier this Price represents (mirrors STRIPE_PRICE_IDS). */
  tier: StripePriceTier;
}

export interface StripeBillingPortalSession {
  /** `bps_…` id. */
  id: string;
  /** Hosted billing-portal URL where the customer manages their
   *  subscription, payment method and invoice history. */
  url: string;
  /** Customer the session is attached to. */
  customerId: string;
}

/** A recurring line on a subscription — e.g. a leased phone number billed
 *  monthly alongside the account's plan. Created via `addSubscriptionItem`. */
export interface StripeSubscriptionItem {
  /** `si_…` id. Persist this so the item can later be removed or moved. */
  id: string;
  /** The subscription this item belongs to. */
  subscriptionId: string;
  /** Recurring amount in cents, charged per month. */
  amountCents: number;
  /** Human-readable description — becomes the inline Stripe Product name. */
  description: string;
}

/** A one-time charge pending on a customer's next invoice — e.g. a phone
 *  number's setup fee. Created via `addInvoiceItem`. */
export interface StripeInvoiceItem {
  /** `ii_…` id. */
  id: string;
  /** The customer the charge is pending against. */
  customerId: string;
  /** One-time amount in cents. */
  amountCents: number;
  /** Human-readable description — appears on the invoice line. */
  description: string;
}

/** A finalised (or finalising) Stripe invoice — the real billing record
 *  for a period. Surfaced read-only to the Console invoice list via
 *  `listInvoices` (plan §8.5 — Phase B). */
export interface StripeInvoice {
  /** `in_…` id. */
  id: string;
  /** Human-facing invoice number (e.g. "CANTILA-0001"); null on a draft. */
  number: string | null;
  /** Lifecycle status. */
  status: "draft" | "open" | "paid" | "uncollectible" | "void";
  /** Invoice total in cents. */
  amountCents: number;
  /** Amount actually paid in cents (0 on an unpaid invoice). */
  amountPaidCents: number;
  /** ISO-4217 currency, lower-case (Stripe convention), e.g. "usd". */
  currency: string;
  /** When the invoice was created, ISO 8601. */
  createdAt: string;
  /** Stripe-hosted invoice page (view / pay); null until finalised. */
  hostedInvoiceUrl: string | null;
  /** Direct PDF download link; null until finalised. */
  invoicePdfUrl: string | null;
}

/** Subset of Stripe Event we care about. The full event type is large; we
 *  only model the fields the webhook receiver dispatches on. */
export interface StripeEvent {
  id: string;
  type:
    | "checkout.session.completed"
    | "customer.subscription.updated"
    | "customer.subscription.deleted"
    | "invoice.paid"
    | "invoice.payment_failed";
  data: {
    object: {
      id: string;
      customer?: string;
      subscription?: string;
      /** On checkout sessions, the Price id the buyer purchased. */
      price_id?: string;
      /** On checkout sessions, the Cantila plan tier (set as metadata). */
      tier?: StripePriceTier;
      /** On subscriptions, the current Price id. */
      items?: { price_id: string; tier?: StripePriceTier }[];
      /** On invoices, amount in cents. */
      amount_paid?: number;
    };
  };
}

export interface StripeAdapter {
  /** Stripe-side display label. The Console uses this to render which
   *  rail is wired ("Stripe stub" vs "Stripe live"). */
  readonly label: string;
  /** Whether this adapter talks to the real Stripe API. The Console
   *  hides the "Pay" button when false and shows a "(stub)" badge. */
  readonly live: boolean;
  /** Stripe publishable key (`pk_…`), when one is configured. Safe to
   *  expose to the browser by design — surfaced via `/v1/billing/info` so
   *  the Console can mount embedded Checkout (plan §8.5 — Phase D). Absent
   *  on the stub and whenever no key is configured. */
  readonly publishableKey?: string;

  createCustomer(input: {
    name: string;
    email?: string;
    metadata?: Record<string, string>;
  }): Promise<StripeCustomer>;

  /** Create a Stripe Checkout session. `uiMode` (default `hosted`) selects
   *  the surface: `hosted` returns a redirect `url`; `embedded` returns a
   *  `clientSecret` the Console mounts in-page (plan §8.5 — Phase D).
   *  Hosted mode uses `successUrl` / `cancelUrl`; embedded uses
   *  `returnUrl`. */
  createCheckoutSession(input: {
    customerId: string;
    tier: StripePriceTier;
    uiMode?: "hosted" | "embedded";
    successUrl?: string;
    cancelUrl?: string;
    returnUrl?: string;
  }): Promise<StripeCheckoutSession>;

  /** Create a Stripe billing-portal session — the hosted page where a
   *  customer manages their payment method, sees invoice history, and
   *  cancels or switches their plan. Requires an existing customer. */
  createBillingPortalSession(input: {
    customerId: string;
    returnUrl: string;
  }): Promise<StripeBillingPortalSession>;

  /** Verify that the request was signed by Stripe. The real adapter calls
   *  `stripe.webhooks.constructEvent(rawBody, signature, secret)`; the
   *  stub mimics the same wire shape with our own HMAC-SHA256.
   *
   *  Throws on invalid signature; returns the parsed event on success. */
  parseWebhook(rawBody: string, signatureHeader: string | undefined): StripeEvent;

  /** Preview the proration for a mid-period plan change without
   *  committing it. The stub computes it deterministically
   *  (`source: "estimate"`); the real adapter pulls Stripe's authoritative
   *  cent-exact figure via `invoices.createPreview` (`source: "stripe"`),
   *  falling back to the deterministic estimate on error (plan §8.5 —
   *  Phase C). */
  previewProration(input: ProrationInput): Promise<ProrationPreview>;

  /** Commit a mid-period plan change. The real adapter calls
   *  `stripe.subscriptions.update` with the chosen `proration_behavior`;
   *  the stub returns a deterministic result with no network call. */
  changeSubscriptionPlan(input: PlanChangeInput): Promise<PlanChangeResult>;

  /** Add a recurring `SubscriptionItem` to an existing subscription — the
   *  full-Stripe-API way to bill a per-unit add-on (e.g. a leased phone
   *  number) on the account's monthly invoice. The real adapter creates an
   *  inline recurring `Price` (via `product_data`, so no per-type price id
   *  needs configuring) and attaches it; the stub returns a deterministic
   *  `si_stub_…` id. `currency` defaults to `usd`. */
  addSubscriptionItem(input: {
    subscriptionId: string;
    amountCents: number;
    description: string;
    currency?: string;
    metadata?: Record<string, string>;
  }): Promise<StripeSubscriptionItem>;

  /** Remove a `SubscriptionItem` from its subscription — stops the
   *  recurring charge. The real adapter calls `stripe.subscriptionItems.del`
   *  (with `create_prorations` so a mid-cycle removal is credited back);
   *  the stub is a no-op. */
  removeSubscriptionItem(input: { subscriptionItemId: string }): Promise<void>;

  /** Add a one-time `InvoiceItem` to a customer — a pending charge that
   *  lands on their next Stripe invoice (e.g. a number's setup fee). The
   *  real adapter calls `stripe.invoiceItems.create`; the stub returns a
   *  deterministic `ii_stub_…` id. `currency` defaults to `usd`. */
  addInvoiceItem(input: {
    customerId: string;
    amountCents: number;
    description: string;
    currency?: string;
    metadata?: Record<string, string>;
  }): Promise<StripeInvoiceItem>;

  /** List a customer's Stripe invoices, newest first — the real billing
   *  history behind the Console invoice list (plan §8.5 — Phase B). The
   *  real adapter calls `stripe.invoices.list`; the stub returns a
   *  deterministic synthetic history so the list renders offline. */
  listInvoices(input: {
    customerId: string;
    limit?: number;
  }): Promise<StripeInvoice[]>;
}

/* ---------- the stub ---------- */

const STUB_WEBHOOK_SECRET = "whsec_stub_cantila_demo_only";

/** Deterministic, in-process Stripe stub. Designed so that the smoke
 *  test path (Console → checkout → webhook → plan upgrade) can be
 *  exercised end-to-end with no network calls. */
export class StubStripeAdapter implements StripeAdapter {
  readonly label = "Stripe stub";
  readonly live = false;

  private idSeq = 1000;

  private nextId(prefix: string): string {
    this.idSeq += 1;
    return `${prefix}_stub_${this.idSeq.toString(36)}`;
  }

  async createCustomer(input: {
    name: string;
    email?: string;
    metadata?: Record<string, string>;
  }): Promise<StripeCustomer> {
    return {
      id: this.nextId("cus"),
      email: input.email ?? "noreply@cantila.cloud",
      name: input.name,
      metadata: input.metadata ?? {},
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
    const id = this.nextId("cs");
    const uiMode = input.uiMode ?? "hosted";
    if (uiMode === "embedded") {
      // Deterministic stub client secret. The Console only mounts a real
      // embedded form when a real publishable key is wired (the stub has
      // none), so offline this secret is never handed to Stripe.js.
      return {
        id,
        uiMode,
        url: "",
        clientSecret: `${id}_secret_stub`,
        customerId: input.customerId,
        priceId: STRIPE_PRICE_IDS[input.tier],
        tier: input.tier,
      };
    }
    return {
      id,
      uiMode,
      // The stub URL points to a fake Stripe-hosted checkout page. In dev
      // it lets the Console show "click to pay" without actually charging.
      url: `https://checkout.stripe.com/c/pay/${id}?stub=1&tier=${input.tier}`,
      customerId: input.customerId,
      priceId: STRIPE_PRICE_IDS[input.tier],
      tier: input.tier,
    };
  }

  async createBillingPortalSession(input: {
    customerId: string;
    returnUrl: string;
  }): Promise<StripeBillingPortalSession> {
    const id = this.nextId("bps");
    return {
      id,
      // Stub portal URL — in dev it lets the Console open a "manage
      // billing" tab without a real Stripe account behind it.
      url: `https://billing.stripe.com/p/session/${id}?stub=1`,
      customerId: input.customerId,
    };
  }

  /** Deterministic proration preview — the pure `computeProration`
   *  engine, no network. Exact to the cent against Stripe's formula. */
  async previewProration(input: ProrationInput): Promise<ProrationPreview> {
    return computeProration(input);
  }

  /** Commit a plan change. With no real Stripe behind it, the stub just
   *  reports the deterministic proration; the control plane is what
   *  actually moves the account onto the new tier. */
  async changeSubscriptionPlan(
    input: PlanChangeInput,
  ): Promise<PlanChangeResult> {
    const preview = computeProration(input);
    return {
      subscriptionId: input.subscriptionId,
      fromTier: input.fromTier,
      toTier: input.toTier,
      amountDueCents:
        input.prorationBehavior === "none" ? 0 : preview.amountDueCents,
      invoicedNow: input.prorationBehavior === "always_invoice",
      prorationBehavior: input.prorationBehavior,
    };
  }

  /** Deterministic stand-in for `stripe.subscriptionItems.create`. Returns
   *  an `si_stub_…` id; keeps no state — the offline rail never reads a
   *  subscription back, so the id only needs to be unique and recognisable. */
  async addSubscriptionItem(input: {
    subscriptionId: string;
    amountCents: number;
    description: string;
    currency?: string;
    metadata?: Record<string, string>;
  }): Promise<StripeSubscriptionItem> {
    return {
      id: this.nextId("si"),
      subscriptionId: input.subscriptionId,
      amountCents: input.amountCents,
      description: input.description,
    };
  }

  /** No-op stand-in for `stripe.subscriptionItems.del`. The stub holds no
   *  subscription state, so a deterministic id was never registered
   *  anywhere — there is nothing to tear down. */
  async removeSubscriptionItem(_input: {
    subscriptionItemId: string;
  }): Promise<void> {
    // intentionally empty — see doc comment.
  }

  /** Deterministic stand-in for `stripe.invoiceItems.create`. Returns an
   *  `ii_stub_…` id for the one-time charge. */
  async addInvoiceItem(input: {
    customerId: string;
    amountCents: number;
    description: string;
    currency?: string;
    metadata?: Record<string, string>;
  }): Promise<StripeInvoiceItem> {
    return {
      id: this.nextId("ii"),
      customerId: input.customerId,
      amountCents: input.amountCents,
      description: input.description,
    };
  }

  /** Deterministic synthetic invoice history — the last three monthly
   *  invoices, all paid, so the Console invoice list renders with no
   *  Stripe account. The real adapter pulls the customer's actual
   *  invoices from `stripe.invoices.list`. The hosted / PDF links are
   *  placeholders offline — there is no real Stripe-hosted page. */
  async listInvoices(input: {
    customerId: string;
    limit?: number;
  }): Promise<StripeInvoice[]> {
    const want = Math.max(1, Math.min(input.limit ?? 12, 24));
    const count = Math.min(want, 3);
    const now = new Date();
    const out: StripeInvoice[] = [];
    for (let i = 0; i < count; i++) {
      const issued = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1),
      );
      const id = this.nextId("in");
      const seq = (count - i).toString().padStart(4, "0");
      out.push({
        id,
        number: `CANTILA-STUB-${seq}`,
        status: "paid",
        amountCents: 3500,
        amountPaidCents: 3500,
        currency: "usd",
        createdAt: issued.toISOString(),
        hostedInvoiceUrl: `https://invoice.stripe.com/i/stub/${id}?stub=1`,
        invoicePdfUrl: `https://invoice.stripe.com/i/stub/${id}/pdf?stub=1`,
      });
    }
    return out;
  }

  /** Same wire format the real Stripe webhook receiver uses:
   *
   *    Stripe-Signature: t=<ts>,v1=<hex>
   *
   *  where `v1 = HMAC-SHA256(secret, "<ts>.<rawBody>")`. The stub uses a
   *  fixed secret for the in-process smoke test (`whsec_stub_…`); the
   *  real adapter pulls the secret from env. */
  parseWebhook(rawBody: string, signatureHeader: string | undefined): StripeEvent {
    if (!signatureHeader) throw new Error("missing Stripe-Signature header");
    const parts = signatureHeader.split(",").reduce<Record<string, string>>(
      (acc, part) => {
        const [k, v] = part.split("=");
        if (k && v) acc[k.trim()] = v.trim();
        return acc;
      },
      {},
    );
    const ts = parts.t;
    const sig = parts.v1;
    if (!ts || !sig) throw new Error("malformed Stripe-Signature");
    const expected = createHmac("sha256", STUB_WEBHOOK_SECRET)
      .update(`${ts}.${rawBody}`)
      .digest("hex");
    const a = Buffer.from(sig, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new Error("invalid Stripe-Signature");
    }
    try {
      return JSON.parse(rawBody) as StripeEvent;
    } catch {
      throw new Error("webhook body is not valid JSON");
    }
  }

  /** Test-only helper: produce a properly-signed webhook payload + header
   *  for one event. The smoke test uses this to drive the receiver
   *  without needing a real Stripe dashboard. */
  signWebhookForTest(event: StripeEvent): {
    rawBody: string;
    header: string;
  } {
    const rawBody = JSON.stringify(event);
    const ts = Math.floor(Date.now() / 1000).toString();
    const sig = createHmac("sha256", STUB_WEBHOOK_SECRET)
      .update(`${ts}.${rawBody}`)
      .digest("hex");
    return { rawBody, header: `t=${ts},v1=${sig}` };
  }
}
