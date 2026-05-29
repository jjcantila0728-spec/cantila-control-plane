/* ============================================================
   Cantilapay — `StubPaymentProcessor` (plan §25, Phase 0).

   Deterministic in-process implementation of the `PaymentProcessor`
   port. Mints fake ids (`le_stub_…`, `evt_stub_…`), verifies an
   in-process HMAC-SHA256 webhook signature with a fixed secret,
   and fast-tracks KYC so smoke tests can exercise the full flow
   end-to-end with no Adyen account.

   Matches the `StubStripeAdapter` posture in `src/billing/stripe.ts`:
   auto-selected when the live env vars are absent; never the
   production path; provides a `signInboundForTest` helper the
   smoke test uses to drive the inbound webhook receiver.
   ============================================================ */

import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  PaymentProcessor,
  PspCancelResult,
  PspCaptureResult,
  PspConfirmResult,
  PspInboundEvent,
  PspRefundResult,
  PspSubMerchant,
} from "./port";
import type { CantilapayMode } from "../types";

const STUB_INBOUND_SECRET = "cpwh_stub_cantilapay_demo_only";
const STUB_HEADER = "cantilapay-stub-signature";

export class StubPaymentProcessor implements PaymentProcessor {
  readonly label = "stub";
  readonly live = false;

  private idSeq = 1000;

  private nextId(prefix: string): string {
    this.idSeq += 1;
    return `${prefix}_stub_${this.idSeq.toString(36)}`;
  }

  async createSubMerchant(input: {
    country: string;
    externalRef: string;
    mode: CantilapayMode;
  }): Promise<PspSubMerchant> {
    return {
      id: this.nextId("le"),
      status: "pending_kyc",
      onboardingLink: `https://cantilapay.dev/stub/onboarding/${input.externalRef}?mode=${input.mode}`,
    };
  }

  async getSubMerchant(input: {
    id: string;
    mode: CantilapayMode;
  }): Promise<PspSubMerchant> {
    // Stub fast-tracks KYC: any sub-merchant id ending in even hex is
    // reported active; odd is still pending. Deterministic; the smoke
    // test relies on this to assert both branches.
    const lastChar = input.id.slice(-1);
    const parsed = parseInt(lastChar, 16);
    const isActive = Number.isFinite(parsed) && parsed % 2 === 0;
    return {
      id: input.id,
      status: isActive ? "active" : "pending_kyc",
      onboardingLink: isActive
        ? null
        : `https://cantilapay.dev/stub/onboarding/${input.id}?mode=${input.mode}`,
    };
  }

  async createOnboardingLink(input: {
    subMerchantId: string;
    mode: CantilapayMode;
    returnUrl: string;
  }): Promise<{ url: string; expiresAt: string }> {
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const url = `https://cantilapay.dev/stub/onboarding/${input.subMerchantId}?mode=${input.mode}&return=${encodeURIComponent(input.returnUrl)}`;
    return { url, expiresAt };
  }

  /** Same wire format the real Adyen receiver verifies (HMAC-SHA256 of
   *  the raw body, hex-encoded in a header), simplified for the stub:
   *
   *    Cantilapay-Stub-Signature: <hex>
   *
   *  where `<hex> = HMAC-SHA256(STUB_INBOUND_SECRET, rawBody)`. The
   *  smoke test uses `signInboundForTest` to produce a payload + header
   *  pair the receiver accepts without a real Adyen dashboard. */
  parseInboundWebhook(input: {
    rawBody: string;
    headers: Record<string, string | string[] | undefined>;
  }): PspInboundEvent {
    const sigRaw = pickHeader(input.headers, STUB_HEADER);
    if (!sigRaw) throw new Error("missing Cantilapay-Stub-Signature header");
    const expected = createHmac("sha256", STUB_INBOUND_SECRET)
      .update(input.rawBody)
      .digest("hex");
    const a = Buffer.from(sigRaw, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new Error("invalid Cantilapay-Stub-Signature");
    }
    let payload: PspInboundEvent;
    try {
      payload = JSON.parse(input.rawBody) as PspInboundEvent;
    } catch {
      throw new Error("inbound webhook body is not valid JSON");
    }
    return payload;
  }

  /** Test-only helper: produce a properly-signed inbound payload +
   *  header for one event. The Phase 0 smoke test calls this to drive
   *  the receiver without a real Adyen connection. */
  signInboundForTest(event: PspInboundEvent): {
    rawBody: string;
    header: { name: string; value: string };
  } {
    const rawBody = JSON.stringify(event);
    const sig = createHmac("sha256", STUB_INBOUND_SECRET)
      .update(rawBody)
      .digest("hex");
    return { rawBody, header: { name: STUB_HEADER, value: sig } };
  }

  // ----- Phase 1: charges -----
  //
  // Deterministic behaviour:
  //   - amount % 100 === 1 → declined with `insufficient_funds`.
  //   - amount % 100 === 2 → declined with `card_declined`.
  //   - otherwise:
  //       captureMode === "automatic" → succeeded.
  //       captureMode === "manual"    → authorized_pending_capture.
  // This mirrors Stripe's test-card pattern (4242 succeeds, 0002
  // declines) and gives the smoke test deterministic outcomes
  // without a network call.

  async confirmPayment(input: {
    subMerchantId: string;
    paymentIntentId: string;
    amount: number;
    currency: string;
    paymentMethodToken: string;
    captureMode: "automatic" | "manual";
    mode: CantilapayMode;
    platformFeeAmount: number;
    metadata?: Record<string, string>;
  }): Promise<PspConfirmResult> {
    const pspPaymentRef = this.nextId("psp");
    const tail = input.amount % 100;
    if (tail === 1) {
      return {
        pspPaymentRef,
        status: "failed",
        errorCode: "card_declined",
        errorMessage: "Your card was declined (insufficient funds).",
        declineCode: "insufficient_funds",
      };
    }
    if (tail === 2) {
      return {
        pspPaymentRef,
        status: "failed",
        errorCode: "card_declined",
        errorMessage: "Your card was declined.",
        declineCode: "card_declined",
      };
    }
    if (input.captureMode === "manual") {
      return { pspPaymentRef, status: "authorized_pending_capture" };
    }
    return { pspPaymentRef, status: "succeeded" };
  }

  async capturePayment(input: {
    pspPaymentRef: string;
    amount: number;
    currency: string;
    mode: CantilapayMode;
  }): Promise<PspCaptureResult> {
    return {
      pspCaptureRef: this.nextId("cap"),
      status: "succeeded",
    };
  }

  async refundPayment(input: {
    pspPaymentRef: string;
    amount: number;
    currency: string;
    mode: CantilapayMode;
    reason?: string;
  }): Promise<PspRefundResult> {
    // Deterministic: a refund of 1 minor unit fails so the smoke test
    // can exercise the failed branch.
    if (input.amount === 1) {
      return {
        pspRefundRef: this.nextId("rf"),
        status: "failed",
        errorCode: "refund_failed",
        errorMessage: "Stub refund of amount=1 always fails.",
      };
    }
    return {
      pspRefundRef: this.nextId("rf"),
      status: "succeeded",
    };
  }

  async cancelPayment(input: {
    pspPaymentRef: string;
    mode: CantilapayMode;
  }): Promise<PspCancelResult> {
    return { status: "succeeded" };
  }
}

function pickHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const lc = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lc) {
      if (Array.isArray(v)) return v[0];
      return v;
    }
  }
  return undefined;
}
