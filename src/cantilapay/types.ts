/* ============================================================
   Cantilapay — shared TypeScript types (plan §25, Phase 0).

   These types are independent of the Prisma client — they
   describe the WIRE shape of cantilapay (what the tenant sees
   when they hit /v1/cantilapay/*). The Prisma layer translates
   between this shape and the on-disk rows.

   Keeping the wire types decoupled from Prisma rows lets the
   adapter port (`PaymentProcessor`) speak in PSP-agnostic terms
   that match the Cantilapay-shaped API tenants integrate against.
   ============================================================ */

/** Cantilapay test vs live mode. Same key cannot read both. */
export type CantilapayMode = "test" | "live";

/** Sub-merchant onboarding state, as exposed on `/v1/cantilapay/accounts`. */
export type CantilapayAccountStatus =
  | "created"
  | "onboarding"
  | "active"
  | "rejected"
  | "disabled";

/** Tenant API key kind. Publishable is safe in the browser; secret is server-only. */
export type CantilapayApiKeyKind = "publishable" | "secret";

/** A Cantilapay sub-merchant account — one per Cantila tenant that has
 *  enabled cantilapay. The `accountId` field is the owning Cantila tenant
 *  Account.id; the `id` is the cantilapay-side handle the tenant sees. */
export interface CantilapayAccountView {
  id: string;
  accountId: string;
  status: CantilapayAccountStatus;
  /** Per-transaction platform fee Cantila collects, in basis points
   *  (10000 = 100%). Default 50 = 0.5%. */
  platformFeeBps: number;
  /** ISO-3 country, null until onboarding begins. */
  country: string | null;
  /** True once Adyen has approved the sub-merchant on either side; the
   *  per-mode booleans tell the tenant which mode is live. Mirrors the
   *  Stripe Connect Account `charges_enabled` / `payouts_enabled` flags. */
  testReady: boolean;
  liveReady: boolean;
  createdAt: string;
  updatedAt: string;
}

/** A tenant API key, as returned by `GET /v1/cantilapay/api_keys`. The
 *  raw key is returned exactly once on creation, never echoed afterwards. */
export interface CantilapayApiKeyView {
  id: string;
  name: string;
  kind: CantilapayApiKeyKind;
  mode: CantilapayMode;
  /** First ~16 chars of the key, e.g. "cpk_test_AbCdEf12". Safe to show. */
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** Returned exactly once on `POST /v1/cantilapay/api_keys`. The raw key
 *  is not persisted — only its SHA-256 hash. */
export interface CantilapayApiKeyIssued extends CantilapayApiKeyView {
  /** The full key the tenant copies into their server config. Shown once. */
  rawKey: string;
}

/** A tenant webhook subscription. Tenants register HTTPS endpoints to
 *  receive cantilapay events; the platform signs each delivery with the
 *  endpoint's `signingSecret`. */
export interface CantilapayWebhookEndpointView {
  id: string;
  url: string;
  mode: CantilapayMode;
  /** Comma-separated event-type subscriptions; "*" = all. */
  enabledEvents: string;
  /** First ~16 chars of the signing secret, e.g. "whsec_AbCdEf12". */
  signingSecretPrefix: string;
  status: "active" | "disabled";
  createdAt: string;
  lastDeliveryAt: string | null;
}

/** Returned exactly once on `POST /v1/cantilapay/webhook_endpoints`. */
export interface CantilapayWebhookEndpointIssued
  extends CantilapayWebhookEndpointView {
  /** The full signing secret, shown once. */
  signingSecret: string;
}

/** A cantilapay event the platform emits. Mirrors the cantilapay's Event shape.
 *  Event types in Phase 0 are limited to lifecycle events; Phases 1-3
 *  add `payment_intent.*`, `invoice.*`, `subscription.*`, `payout.*`. */
export interface CantilapayEventView {
  id: string;
  type: string;
  mode: CantilapayMode;
  /** Arbitrary JSON payload; shape per event type. */
  data: Record<string, unknown>;
  createdAt: string;
}

/** Constants the rest of the module pins so renames are catchable. */
export const CANTILAPAY_API_KEY_PREFIX = {
  publishableTest: "cpk_test_",
  publishableLive: "cpk_live_",
  secretTest: "csk_test_",
  secretLive: "csk_live_",
} as const;

export const CANTILAPAY_WEBHOOK_SECRET_PREFIX = "whsec_";

/** Lookup table to derive `(kind, mode)` from a key's prefix in O(1). */
export const CANTILAPAY_KEY_PREFIX_TO_SHAPE: ReadonlyArray<{
  prefix: string;
  kind: CantilapayApiKeyKind;
  mode: CantilapayMode;
}> = [
  { prefix: CANTILAPAY_API_KEY_PREFIX.publishableTest, kind: "publishable", mode: "test" },
  { prefix: CANTILAPAY_API_KEY_PREFIX.publishableLive, kind: "publishable", mode: "live" },
  { prefix: CANTILAPAY_API_KEY_PREFIX.secretTest, kind: "secret", mode: "test" },
  { prefix: CANTILAPAY_API_KEY_PREFIX.secretLive, kind: "secret", mode: "live" },
];

/** Inferred from the leading prefix bytes. Returns null when the token
 *  shape is unrecognised — caller treats that as `invalid_key`. */
export function inferKeyShape(
  raw: string,
): { kind: CantilapayApiKeyKind; mode: CantilapayMode } | null {
  for (const entry of CANTILAPAY_KEY_PREFIX_TO_SHAPE) {
    if (raw.startsWith(entry.prefix)) {
      return { kind: entry.kind, mode: entry.mode };
    }
  }
  return null;
}

/* ===========================================================
   Phase 1 — Charges (Customer, PaymentMethod, PaymentIntent,
   Refund) wire shapes.
   =========================================================== */

export type CantilapayPaymentIntentStatus =
  | "requires_payment_method"
  | "requires_confirmation"
  | "requires_action"
  | "processing"
  | "requires_capture"
  | "succeeded"
  | "canceled"
  | "failed";

export type CantilapayCaptureMode = "automatic" | "manual";

export type CantilapayPaymentMethodStatus = "chargeable" | "detached";

export type CantilapayRefundStatus = "pending" | "succeeded" | "failed";

export interface CantilapayCustomerView {
  id: string;
  mode: CantilapayMode;
  /** Optional tenant-side reference (their own customer id). */
  externalRef: string | null;
  email: string | null;
  name: string | null;
  description: string | null;
  /** Tenant metadata bag. */
  metadata: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface CantilapayPaymentMethodView {
  id: string;
  mode: CantilapayMode;
  customerId: string | null;
  /** "card" in Phase 1; future kinds in Phase 4+. */
  type: string;
  /** Display fields — present for cards. */
  card: {
    brand: string | null;
    last4: string | null;
    expMonth: number | null;
    expYear: number | null;
  } | null;
  status: CantilapayPaymentMethodStatus;
  metadata: Record<string, string>;
  createdAt: string;
}

export interface CantilapayPaymentIntentView {
  id: string;
  mode: CantilapayMode;
  customerId: string | null;
  paymentMethodId: string | null;
  amount: number;
  amountCaptured: number;
  amountRefunded: number;
  currency: string;
  captureMode: CantilapayCaptureMode;
  status: CantilapayPaymentIntentStatus;
  /** Cantila platform fee in minor units, captured at create time. */
  platformFeeAmount: number;
  description: string | null;
  metadata: Record<string, string>;
  /** Tenant-side SDK uses this blob to mount the payment UI (Drop-in,
   *  Components, stub). Null after a terminal state. */
  clientSecret: string | null;
  /** Last error info when status is `failed`. */
  lastError: {
    code: string;
    message: string;
    declineCode?: string;
  } | null;
  createdAt: string;
  updatedAt: string;
}

export interface CantilapayRefundView {
  id: string;
  mode: CantilapayMode;
  paymentIntentId: string;
  amount: number;
  currency: string;
  status: CantilapayRefundStatus;
  reason: string | null;
  lastError: {
    code: string;
    message: string;
  } | null;
  createdAt: string;
}

/* ===========================================================
   Phase 2 — Subscriptions (Product, Price, Subscription,
   Invoice, InvoiceItem) wire shapes.
   =========================================================== */

export type CantilapayPriceInterval = "day" | "week" | "month" | "year";

export type CantilapaySubscriptionStatus =
  | "incomplete"
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "unpaid";

export type CantilapayInvoiceStatus =
  | "draft"
  | "open"
  | "paid"
  | "uncollectible"
  | "void";

export interface CantilapayProductView {
  id: string;
  mode: CantilapayMode;
  name: string;
  description: string | null;
  active: boolean;
  metadata: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface CantilapayPriceView {
  id: string;
  mode: CantilapayMode;
  productId: string;
  unitAmount: number;
  currency: string;
  recurring: {
    interval: CantilapayPriceInterval;
    intervalCount: number;
    trialPeriodDays: number;
  };
  active: boolean;
  metadata: Record<string, string>;
  createdAt: string;
}

export interface CantilapaySubscriptionView {
  id: string;
  mode: CantilapayMode;
  customerId: string;
  priceId: string;
  defaultPaymentMethodId: string | null;
  status: CantilapaySubscriptionStatus;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  trialStart: string | null;
  trialEnd: string | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: string | null;
  endedAt: string | null;
  metadata: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface CantilapayInvoiceItemView {
  id: string;
  amount: number;
  currency: string;
  description: string;
  priceId: string | null;
  periodStart: string | null;
  periodEnd: string | null;
}

export interface CantilapayInvoiceView {
  id: string;
  mode: CantilapayMode;
  subscriptionId: string | null;
  customerId: string;
  periodStart: string;
  periodEnd: string;
  amountDue: number;
  amountPaid: number;
  currency: string;
  status: CantilapayInvoiceStatus;
  finalizedAt: string | null;
  paidAt: string | null;
  paymentIntentId: string | null;
  attempts: number;
  lastError: { code: string; message: string } | null;
  items: CantilapayInvoiceItemView[];
  createdAt: string;
  updatedAt: string;
}

/* ===========================================================
   Phase 3 — Connect-equivalent (payouts + balance) wire shapes.
   =========================================================== */

export type CantilapayPayoutStatus =
  | "pending"
  | "in_transit"
  | "paid"
  | "failed"
  | "canceled";

export type CantilapayBalanceTransactionType =
  | "charge"
  | "refund"
  | "payout"
  | "platform_fee"
  | "adjustment";

export interface CantilapayBalanceView {
  /** Funds settled and available for payout (signed sum of ledger,
   *  net of pending payouts). */
  available: number;
  /** Funds in transit out of the merchant account toward a tenant
   *  bank — sum of pending+in_transit payouts. */
  pending: number;
  currency: string;
}

export interface CantilapayBalanceTransactionView {
  id: string;
  mode: CantilapayMode;
  amount: number;
  currency: string;
  type: CantilapayBalanceTransactionType;
  description: string | null;
  source: {
    paymentIntentId?: string;
    refundId?: string;
    payoutId?: string;
  };
  createdAt: string;
}

export interface CantilapayPayoutView {
  id: string;
  mode: CantilapayMode;
  amount: number;
  currency: string;
  status: CantilapayPayoutStatus;
  arrivalDate: string;
  periodStart: string;
  periodEnd: string;
  lastError: { code: string; message: string } | null;
  createdAt: string;
  updatedAt: string;
}

/* ===========================================================
   Phase 4 — Hosted Checkout + Billing Portal wire shapes.
   =========================================================== */

export type CantilapayCheckoutSessionMode = "payment" | "subscription" | "setup";
export type CantilapayCheckoutSessionStatus = "open" | "complete" | "expired";
export type CantilapayCheckoutUiMode = "hosted" | "embedded";
export type CantilapayBillingPortalSessionStatus = "open" | "used" | "expired";

/** Payment-mode line item: an inline amount + display name. */
export interface CantilapayCheckoutPaymentItem {
  name: string;
  amount: number;
  currency: string;
  quantity?: number;
}

/** Subscription-mode line item: a Price + quantity. */
export interface CantilapayCheckoutSubscriptionItem {
  priceId: string;
  quantity?: number;
}

export interface CantilapayCheckoutSessionView {
  id: string;
  mode: CantilapayMode;
  sessionMode: CantilapayCheckoutSessionMode;
  status: CantilapayCheckoutSessionStatus;
  uiMode: CantilapayCheckoutUiMode;
  customerId: string | null;
  lineItems: Array<
    CantilapayCheckoutPaymentItem | CantilapayCheckoutSubscriptionItem
  >;
  currency: string;
  amountTotal: number;
  successUrl: string;
  cancelUrl: string | null;
  returnUrl: string | null;
  paymentIntentId: string | null;
  subscriptionId: string | null;
  /** Hosted mode only — the URL the tenant frontend redirects to. */
  url: string | null;
  /** Embedded mode only — mount Adyen Drop-in with this. */
  clientSecret: string | null;
  expiresAt: string;
  completedAt: string | null;
  metadata: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface CantilapayBillingPortalSessionView {
  id: string;
  mode: CantilapayMode;
  customerId: string;
  returnUrl: string | null;
  status: CantilapayBillingPortalSessionStatus;
  url: string | null;
  expiresAt: string;
  createdAt: string;
}

/* ===========================================================
   Phase 5 — Tax calculation wire shape.
   =========================================================== */

export interface CantilapayTaxCalculationBreakdownLine {
  jurisdiction: string;
  type: string;
  rateBps: number;
  amount: number;
}

export interface CantilapayTaxCalculationView {
  id: string;
  mode: CantilapayMode;
  amount: number;
  currency: string;
  customerCountry: string;
  customerState: string | null;
  customerPostalCode: string | null;
  taxAmount: number;
  taxRateBps: number;
  breakdown: CantilapayTaxCalculationBreakdownLine[];
  provider: string;
  productCategory: string | null;
  createdAt: string;
}
