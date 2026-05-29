/* ============================================================
   Cantilapay — `AdyenForPlatformsAdapter` (plan §25, Phase 0).

   Skeleton for the live Adyen-for-Platforms-backed implementation
   of `PaymentProcessor`. Phase 0 lays out the env shape and the
   call surface; Phase 1+ fills in the actual HTTP calls (or
   switches to `@adyen/api-library` once that dependency lands).

   Why a skeleton now: the selector (`selectPaymentProcessor`)
   needs SOMETHING to construct when the live env is present, and
   keeping the live and stub paths in lockstep prevents drift.

   Env (only used when the operator opts into live mode):
     ADYEN_API_KEY               — Management + Checkout API key.
     ADYEN_HMAC_KEY              — Webhook HMAC verification key.
     ADYEN_MERCHANT_ACCOUNT      — Cantila's platform-level merchant id.
     ADYEN_BASE_URL              — Defaults to https://management-test.adyen.com
                                   (test) or https://management-live.adyen.com.
     ADYEN_LEM_BASE_URL          — Defaults to https://kyc-test.adyen.com
                                   (Legal Entity Management).
     CANTILAPAY_LIVE_ACK         — Required in NODE_ENV=production to
                                   actually mount the live adapter.

   Phase 0 contract for unimplemented calls: throw a clear error
   pointing at the phase that will implement it. Better to fail
   loud than to silently degrade.
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

export interface AdyenForPlatformsConfig {
  apiKey: string;
  hmacKey: string;
  merchantAccount: string;
  /** When the API base URL is unset, defaults are chosen per mode. */
  managementBaseUrl?: string;
  legalEntityBaseUrl?: string;
  /** Which Adyen environment the API key is for. The Cantilapay mode
   *  (test/live) flows through the adapter call signature; this is the
   *  default the adapter falls back to when the call doesn't specify. */
  defaultEnvironment: "test" | "live";
}

export class AdyenForPlatformsAdapter implements PaymentProcessor {
  readonly live = true;
  readonly label: string;

  private readonly cfg: AdyenForPlatformsConfig;

  constructor(cfg: AdyenForPlatformsConfig) {
    this.cfg = cfg;
    this.label = `Adyen for Platforms (${cfg.defaultEnvironment})`;
  }

  // ----- sub-merchant lifecycle -----

  async createSubMerchant(_input: {
    country: string;
    externalRef: string;
    mode: CantilapayMode;
  }): Promise<PspSubMerchant> {
    throw new Error(
      "AdyenForPlatformsAdapter.createSubMerchant — Phase 3 (Connect-equivalent) wires this against Adyen Legal Entity Management.",
    );
  }

  async getSubMerchant(_input: {
    id: string;
    mode: CantilapayMode;
  }): Promise<PspSubMerchant> {
    throw new Error(
      "AdyenForPlatformsAdapter.getSubMerchant — Phase 3 wires this against Adyen Legal Entity Management.",
    );
  }

  async createOnboardingLink(_input: {
    subMerchantId: string;
    mode: CantilapayMode;
    returnUrl: string;
  }): Promise<{ url: string; expiresAt: string }> {
    throw new Error(
      "AdyenForPlatformsAdapter.createOnboardingLink — Phase 3 wires this against Adyen Hosted Onboarding.",
    );
  }

  // ----- inbound webhook verification (Phase 0 wires this; Phase 1
  //       starts dispatching real PAYMENT events to cantilapay state). -----

  /** Adyen sends webhook payloads with an `additionalData.hmacSignature`
   *  field — HMAC-SHA256 over a concatenation of selected fields. For
   *  Phase 0 we accept the *envelope* signature only (an `hmac-signature`
   *  header). The full per-notification HMAC matrix lands in Phase 1
   *  alongside the AUTHORISATION event handler that needs it.
   *
   *  This Phase 0 implementation rejects every inbound notification it
   *  receives unless `ADYEN_HMAC_KEY` is configured AND the envelope
   *  signature matches — which is the right default for a skeleton that
   *  shouldn't accept real money events yet. The dispatcher routes these
   *  to a no-op handler in Phase 0.
   *
   *  We accept the `ping` event type for connectivity tests Adyen
   *  fires during Test Notification → Send Test setup. */
  parseInboundWebhook(input: {
    rawBody: string;
    headers: Record<string, string | string[] | undefined>;
  }): PspInboundEvent {
    const sigRaw = pickHeader(input.headers, "hmac-signature");
    if (!sigRaw) throw new Error("missing hmac-signature header");
    if (!this.cfg.hmacKey) {
      throw new Error("ADYEN_HMAC_KEY not configured");
    }
    const expected = createHmac("sha256", Buffer.from(this.cfg.hmacKey, "hex"))
      .update(input.rawBody)
      .digest("hex");
    const a = Buffer.from(sigRaw, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new Error("invalid hmac-signature");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.rawBody);
    } catch {
      throw new Error("inbound webhook body is not valid JSON");
    }
    // Phase 0 only recognises the `ping` / connectivity test from
    // Adyen's Test Notification panel. Everything else is rejected
    // until Phase 1 wires the AUTHORISATION / CAPTURE / REFUND
    // dispatch.
    const obj = parsed as { eventCode?: string; pspReference?: string };
    if (obj.eventCode === "PING" || obj.eventCode === "TEST") {
      return {
        id: obj.pspReference ?? `evt_test_${Date.now()}`,
        type: "ping",
        subMerchantId: null,
        raw: parsed,
      };
    }
    throw new Error(
      `Adyen event '${obj.eventCode}' is not handled in Phase 0 — Phases 1-3 wire payment / sub-merchant events.`,
    );
  }

  // ----- Phase 1: charges (skeleton — real Adyen wiring lands when
  //       @adyen/api-library + a sandbox account are configured). -----

  async confirmPayment(_input: {
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
    throw new Error(
      "AdyenForPlatformsAdapter.confirmPayment — Phase 1 wires this against Adyen Checkout API /payments.",
    );
  }

  async capturePayment(_input: {
    pspPaymentRef: string;
    amount: number;
    currency: string;
    mode: CantilapayMode;
  }): Promise<PspCaptureResult> {
    throw new Error(
      "AdyenForPlatformsAdapter.capturePayment — Phase 1 wires this against Adyen Checkout API /payments/{psp}/captures.",
    );
  }

  async refundPayment(_input: {
    pspPaymentRef: string;
    amount: number;
    currency: string;
    mode: CantilapayMode;
    reason?: string;
  }): Promise<PspRefundResult> {
    throw new Error(
      "AdyenForPlatformsAdapter.refundPayment — Phase 1 wires this against Adyen Checkout API /payments/{psp}/refunds.",
    );
  }

  async cancelPayment(_input: {
    pspPaymentRef: string;
    mode: CantilapayMode;
  }): Promise<PspCancelResult> {
    throw new Error(
      "AdyenForPlatformsAdapter.cancelPayment — Phase 1 wires this against Adyen Checkout API /payments/{psp}/cancels.",
    );
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
