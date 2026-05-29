/* ============================================================
   Cantilapay — `PaymentProcessor` adapter port (plan §25, Phase 0).

   The cantilapay module never talks to a PSP SDK directly — it
   talks to this interface. That keeps the wire-shape contract
   (what tenants see on /v1/cantilapay/*) decoupled from any one
   PSP and lets us swap stub → Adyen for Platforms → multi-PSP
   routing in the future as one-file changes.

   Phase 0 deliberately defines ONLY the operations the foundation
   needs:

     - createSubMerchant + getSubMerchant — for the sub-merchant
       onboarding skeleton (real KYC flow lands in Phase 3).
     - parseInboundWebhook — Adyen calls us; we verify the HMAC
       and dispatch.

   Phase 1 extends this port with createPaymentIntent, capture,
   refund, etc. — that change ripples to both `stub.ts` and
   `adyen.ts` together. Keeping the port minimal in Phase 0 means
   the typecheck doesn't drift while Phase 1 is in flight.

   Conventions:
     - All amounts are in MINOR currency units (cents, ören).
     - Currencies are ISO-4217 lowercase ("usd", "eur").
     - Mode (`test` / `live`) is a hard partition — operations
       in one mode never touch the other.
   ============================================================ */

import type { CantilapayMode } from "../types";

/** A sub-merchant on the underlying PSP — Adyen Account Holder /
 *  Legal Entity, Stripe Connect Account, etc. Cantila tenants ARE the
 *  sub-merchants (they sell to their end users via cantilapay; cantila
 *  is the platform). */
export interface PspSubMerchant {
  /** The PSP-side id (e.g. Adyen LegalEntity id, format `LE…`). */
  id: string;
  /** Lifecycle, mapped onto cantilapay's narrower state space. */
  status: "pending_kyc" | "active" | "rejected" | "disabled";
  /** Hosted KYC URL the tenant follows to complete onboarding. Null
   *  before onboarding starts or after completion. */
  onboardingLink: string | null;
}

/** An inbound notification from the PSP — Adyen webhook event or stub
 *  simulation. The dispatcher in `services/webhooks-in.ts` reads `type`
 *  and updates cantilapay state accordingly. */
export interface PspInboundEvent {
  /** PSP-side event id; used for dedupe in the inbound dispatcher. */
  id: string;
  /** Cantilapay-side namespaced event type. The adapter maps PSP-native
   *  shape ("AUTHORISATION", "ACCOUNT_HOLDER_STATUS_CHANGE", …) onto
   *  these cantilapay names. */
  type:
    | "account.updated"
    | "ping"
    // Phase 1: charge lifecycle. The dispatcher uses `pspPaymentRef`
    // to find the owning CantilapayPaymentIntent and updates state.
    | "payment_intent.captured"
    | "payment_intent.refunded"
    | "payment_intent.failed";
  /** Which sub-merchant the event belongs to. Null for platform-level
   *  events like `ping`. */
  subMerchantId: string | null;
  /** PSP payment reference, when this event relates to a payment.
   *  Indexed-find for owning CantilapayPaymentIntent in webhooks-in. */
  pspPaymentRef?: string;
  /** Raw PSP payload, for the audit log and event projection. */
  raw: unknown;
}

/** Result of a synchronous payment confirmation. The service layer
 *  writes the corresponding CantilapayPaymentIntent state from this. */
export interface PspConfirmResult {
  /** PSP-side reference. Persist on the intent so async webhooks
   *  reconcile against the right row. */
  pspPaymentRef: string;
  /** What the PSP says about the outcome:
   *   - `succeeded`               — captured (automatic capture).
   *   - `authorized_pending_capture` — authorised; tenant must /capture.
   *   - `requires_action`         — 3DS challenge or similar; SDK handles
   *                                 the redirect. (Phase 4 surface.)
   *   - `failed`                  — declined or PSP error. */
  status:
    | "succeeded"
    | "authorized_pending_capture"
    | "requires_action"
    | "failed";
  /** Set when `status === "failed"`. */
  errorCode?: string;
  /** Set when `status === "failed"`. */
  errorMessage?: string;
  /** Set when `status === "failed"` and PSP returned a card decline code. */
  declineCode?: string;
  /** Payload for the SDK to handle a `requires_action`. Stays opaque
   *  in cantilapay — the SDK on the tenant side uses it. (Phase 4.) */
  actionPayload?: unknown;
}

/** Result of capturing a previously-authorised payment. */
export interface PspCaptureResult {
  pspCaptureRef: string;
  status: "succeeded" | "pending" | "failed";
  errorCode?: string;
  errorMessage?: string;
}

/** Result of refunding a captured payment. */
export interface PspRefundResult {
  pspRefundRef: string;
  status: "succeeded" | "pending" | "failed";
  errorCode?: string;
  errorMessage?: string;
}

/** Result of cancelling an authorised-but-uncaptured payment. */
export interface PspCancelResult {
  status: "succeeded" | "failed";
  errorCode?: string;
  errorMessage?: string;
}

/** Optional — Adyen Drop-in session. The stub returns a deterministic
 *  payload; the real adapter calls `/sessions` on Checkout API. Phase 1
 *  is the route layer's preferred entry point for tenant frontends. */
export interface PspPaymentSession {
  pspSessionId: string;
  /** Opaque blob the tenant SDK passes to Drop-in. */
  sessionData: string;
}

/** The contract every cantilapay PSP adapter implements. */
export interface PaymentProcessor {
  /** Stable label for the Console / logs — "stub" or e.g.
   *  "Adyen for Platforms (test)". */
  readonly label: string;

  /** True when this adapter talks to a real PSP. The Console hides
   *  "Accept live payment" buttons when false. */
  readonly live: boolean;

  /** Create a sub-merchant at the PSP. Called when a Cantila tenant
   *  first enables cantilapay. The returned `id` is persisted on
   *  `CantilapayAccount.adyenAccountHolderId(Test|Live)` and threaded
   *  through every subsequent call. Idempotent on the adapter side
   *  by `(country, mode, externalRef)` — the route layer also gates
   *  on the persisted column to avoid double creation. */
  createSubMerchant(input: {
    /** ISO-3 country code, e.g. "USA", "NLD", "GBR". Drives the
     *  Adyen Legal Entity shape (sole prop vs LLC vs individual). */
    country: string;
    /** Cantilapay-side handle so the PSP-side row can be traced back. */
    externalRef: string;
    /** Test or live — Adyen treats them as fully separate sub-merchants. */
    mode: CantilapayMode;
  }): Promise<PspSubMerchant>;

  /** Read the current sub-merchant status. The route layer calls this
   *  to reconcile drift between Adyen's view and our projection. */
  getSubMerchant(input: {
    id: string;
    mode: CantilapayMode;
  }): Promise<PspSubMerchant>;

  /** Generate the hosted KYC URL the tenant follows to complete
   *  onboarding. Adyen for Platforms returns a one-shot URL valid for
   *  ~24h that lifts the sub-merchant from `pending_kyc` → `active`
   *  on completion. */
  createOnboardingLink(input: {
    subMerchantId: string;
    mode: CantilapayMode;
    /** Where the PSP redirects after the tenant completes KYC. */
    returnUrl: string;
  }): Promise<{ url: string; expiresAt: string }>;

  /** Verify the PSP webhook signature and return the parsed event.
   *  The real Adyen adapter uses Basic Auth + HMAC; the stub uses
   *  HMAC-SHA256 with a fixed secret. Throws on invalid signature. */
  parseInboundWebhook(input: {
    rawBody: string;
    headers: Record<string, string | string[] | undefined>;
  }): PspInboundEvent;

  // ----- Phase 1: charges -----

  /** Synchronously authorise (and capture, if `captureMode === "automatic"`)
   *  a payment via the PSP. Returns a `PspConfirmResult` carrying the
   *  outcome.
   *
   *  The cantilapay service layer writes the resulting
   *  CantilapayPaymentIntent state from the `status` field; async
   *  events that follow (final capture clearing, refunds, chargebacks)
   *  arrive via inbound webhook and reconcile against `pspPaymentRef`. */
  confirmPayment(input: {
    /** PSP-side sub-merchant id the funds settle to (tenant). */
    subMerchantId: string;
    /** Cantilapay PaymentIntent id, surfaced as the PSP `reference`
     *  so support traces resolve through the cantilapay id. */
    paymentIntentId: string;
    amount: number;
    currency: string;
    /** PSP-side token of the payment method to charge. */
    paymentMethodToken: string;
    captureMode: "automatic" | "manual";
    mode: CantilapayMode;
    /** Cantila platform fee in minor units, split off at the PSP. */
    platformFeeAmount: number;
    /** Stripe-style metadata bag — Adyen surfaces these as additional
     *  data on the transaction. */
    metadata?: Record<string, string>;
  }): Promise<PspConfirmResult>;

  /** Capture a previously authorised (manual-capture) payment. */
  capturePayment(input: {
    pspPaymentRef: string;
    amount: number;
    currency: string;
    mode: CantilapayMode;
  }): Promise<PspCaptureResult>;

  /** Refund a captured payment, fully or partially. */
  refundPayment(input: {
    pspPaymentRef: string;
    amount: number;
    currency: string;
    mode: CantilapayMode;
    reason?: string;
  }): Promise<PspRefundResult>;

  /** Cancel an authorised-but-uncaptured payment (releases the hold). */
  cancelPayment(input: {
    pspPaymentRef: string;
    mode: CantilapayMode;
  }): Promise<PspCancelResult>;
}
