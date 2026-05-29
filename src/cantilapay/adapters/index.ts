/* ============================================================
   Cantilapay — adapter selector (plan §25, v1.1).

   Mirrors `selectDataPlane` / the StripeAdapter selection in
   `src/index.ts`. Returns the live Adyen-for-Platforms adapter
   when its env vars are all set; otherwise returns the stub.

   Prod-safety guard (matches the v1.18 STORE prod guard):
   refuses to mount the live adapter when NODE_ENV=production
   unless CANTILAPAY_LIVE_ACK=1 — protects against sandbox env
   accidentally being merged with NODE_ENV=production.
   ============================================================ */

import type { PaymentProcessor } from "./port";
import { StubPaymentProcessor } from "./stub";
import { AdyenForPlatformsAdapter } from "./adyen";
import { CantilapayError } from "../errors";

export interface PaymentProcessorSelection {
  processor: PaymentProcessor;
  label: string;
  live: boolean;
}

/** Read the underlying PSP from env and construct it. Returns the stub
 *  as a fallback so the cantilapay routes always have a processor to
 *  call — same shape as every other Cantila adapter selector. */
export function selectPaymentProcessor(
  env: NodeJS.ProcessEnv = process.env,
): PaymentProcessorSelection {
  const checkoutApiKey = env.ADYEN_API_KEY?.trim();
  const managementApiKey = env.ADYEN_MANAGEMENT_API_KEY?.trim() ?? checkoutApiKey;
  const balancePlatformApiKey = env.ADYEN_BALANCE_PLATFORM_API_KEY?.trim() ?? checkoutApiKey;
  const lemApiKey = env.ADYEN_LEM_API_KEY?.trim() ?? checkoutApiKey;
  const hmacKey = env.ADYEN_HMAC_KEY?.trim();
  const merchantAccount = env.ADYEN_MERCHANT_ACCOUNT?.trim();
  const balancePlatformName = env.ADYEN_BALANCE_PLATFORM?.trim() ?? "";
  const liableBalanceAccountId = env.ADYEN_LIABLE_BALANCE_ACCOUNT_ID?.trim() ?? "";
  const onboardingThemeId = env.ADYEN_ONBOARDING_THEME_ID?.trim() ?? "";
  const envFlag = (env.ADYEN_ENVIRONMENT?.trim().toLowerCase() ?? "test") as "test" | "live";

  const hasLiveEnv = !!checkoutApiKey && !!hmacKey && !!merchantAccount;
  if (!hasLiveEnv) {
    return { processor: new StubPaymentProcessor(), label: "stub", live: false };
  }

  if (
    env.NODE_ENV === "production" &&
    envFlag === "live" &&
    env.CANTILAPAY_LIVE_ACK !== "1"
  ) {
    throw CantilapayError.liveModeNotAcknowledged();
  }

  const adapter = new AdyenForPlatformsAdapter({
    checkoutApiKey: checkoutApiKey!,
    managementApiKey: managementApiKey!,
    balancePlatformApiKey: balancePlatformApiKey!,
    lemApiKey: lemApiKey!,
    hmacKey: hmacKey!,
    merchantAccount: merchantAccount!,
    balancePlatformName,
    liableBalanceAccountId,
    onboardingThemeId,
    environment: envFlag === "live" ? "LIVE" : "TEST",
    liveEndpointUrlPrefix: env.ADYEN_LIVE_ENDPOINT_URL_PREFIX?.trim(),
  });
  return { processor: adapter, label: adapter.label, live: true };
}

export { StubPaymentProcessor } from "./stub";
export { AdyenForPlatformsAdapter } from "./adyen";
export type {
  PaymentProcessor,
  PspInboundEvent,
  PspSubMerchant,
} from "./port";
