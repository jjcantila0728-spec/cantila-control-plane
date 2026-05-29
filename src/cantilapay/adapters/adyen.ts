/* ============================================================
   Cantilapay — AdyenForPlatformsAdapter (plan §25, v1.1).

   The live PaymentProcessor implementation. Delegates each
   method to a focused module under ./adyen-impl/. The cache for
   per-mode Adyen SDK clients lives in adyen-impl/client.ts.

   Env vars consumed (passed through from selectPaymentProcessor):
     ADYEN_ENVIRONMENT, ADYEN_API_KEY, ADYEN_MANAGEMENT_API_KEY,
     ADYEN_BALANCE_PLATFORM_API_KEY, ADYEN_LEM_API_KEY,
     ADYEN_HMAC_KEY, ADYEN_MERCHANT_ACCOUNT, ADYEN_BALANCE_PLATFORM,
     ADYEN_LIABLE_BALANCE_ACCOUNT_ID, ADYEN_ONBOARDING_THEME_ID,
     ADYEN_LIVE_ENDPOINT_URL_PREFIX (live only).
   ============================================================ */

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
import { buildAdyenClients, type AdyenClientConfig } from "./adyen-impl/client";
import {
  confirmPayment as confirmImpl,
  capturePayment as captureImpl,
  refundPayment as refundImpl,
  cancelPayment as cancelImpl,
} from "./adyen-impl/payments";
import {
  createSubMerchant as createSubMerchantImpl,
  getSubMerchant as getSubMerchantImpl,
  createOnboardingLink as createOnboardingLinkImpl,
} from "./adyen-impl/submerchants";
import { parseAdyenNotification } from "./adyen-impl/webhooks";

export interface AdyenForPlatformsConfig {
  checkoutApiKey: string;
  managementApiKey: string;
  balancePlatformApiKey: string;
  lemApiKey: string;
  hmacKey: string;
  merchantAccount: string;
  balancePlatformName: string;
  liableBalanceAccountId: string;
  onboardingThemeId: string;
  environment: "TEST" | "LIVE";
  liveEndpointUrlPrefix?: string;
}

export class AdyenForPlatformsAdapter implements PaymentProcessor {
  readonly live = true;
  readonly label: string;
  private readonly cfg: AdyenForPlatformsConfig;
  private readonly clientCfg: AdyenClientConfig;

  constructor(cfg: AdyenForPlatformsConfig) {
    this.cfg = cfg;
    this.label = `Adyen for Platforms (${cfg.environment.toLowerCase()})`;
    this.clientCfg = {
      checkoutApiKey: cfg.checkoutApiKey,
      managementApiKey: cfg.managementApiKey,
      balancePlatformApiKey: cfg.balancePlatformApiKey,
      lemApiKey: cfg.lemApiKey,
      merchantAccount: cfg.merchantAccount,
      balancePlatformName: cfg.balancePlatformName,
      liableBalanceAccountId: cfg.liableBalanceAccountId,
      onboardingThemeId: cfg.onboardingThemeId,
      environment: cfg.environment,
      liveEndpointUrlPrefix: cfg.liveEndpointUrlPrefix,
    };
  }

  private clients(mode: CantilapayMode) {
    return buildAdyenClients(mode, this.clientCfg);
  }

  // ----- payments (v1.1.0) -----

  confirmPayment(input: {
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
    return confirmImpl(this.clients(input.mode), input);
  }

  capturePayment(input: {
    pspPaymentRef: string;
    amount: number;
    currency: string;
    mode: CantilapayMode;
  }): Promise<PspCaptureResult> {
    return captureImpl(this.clients(input.mode), input);
  }

  refundPayment(input: {
    pspPaymentRef: string;
    amount: number;
    currency: string;
    mode: CantilapayMode;
    reason?: string;
  }): Promise<PspRefundResult> {
    return refundImpl(this.clients(input.mode), input);
  }

  cancelPayment(input: {
    pspPaymentRef: string;
    mode: CantilapayMode;
  }): Promise<PspCancelResult> {
    return cancelImpl(this.clients(input.mode), input);
  }

  // ----- inbound webhook -----

  parseInboundWebhook(input: {
    rawBody: string;
    headers: Record<string, string | string[] | undefined>;
  }): PspInboundEvent[] {
    // An Adyen webhook envelope batches `notificationItems[]`; each item
    // carries its own HMAC and is verified independently inside
    // parseAdyenNotification. We return ALL valid items so the dispatcher
    // projects every one — nothing is dropped.
    const events = parseAdyenNotification({
      rawBody: input.rawBody,
      hmacKeyHex: this.cfg.hmacKey,
    });
    if (events.length === 0) {
      throw new Error("Adyen notification yielded no valid items");
    }
    return events;
  }

  // ----- sub-merchants (v1.1.1 — LEM + Balance Platform + Hosted Onboarding) -----

  createSubMerchant(input: {
    country: string;
    externalRef: string;
    mode: CantilapayMode;
  }): Promise<PspSubMerchant> {
    return createSubMerchantImpl(this.clients(input.mode), input);
  }

  getSubMerchant(input: {
    id: string;
    mode: CantilapayMode;
  }): Promise<PspSubMerchant> {
    return getSubMerchantImpl(this.clients(input.mode), input);
  }

  createOnboardingLink(input: {
    subMerchantId: string;
    mode: CantilapayMode;
    returnUrl: string;
  }): Promise<{ url: string; expiresAt: string }> {
    return createOnboardingLinkImpl(this.clients(input.mode), input);
  }
}
