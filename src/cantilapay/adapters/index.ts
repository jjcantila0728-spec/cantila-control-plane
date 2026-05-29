/* ============================================================
   Cantilapay — adapter selector (plan §25, Phase 0).

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
  const apiKey = env.ADYEN_API_KEY?.trim();
  const hmacKey = env.ADYEN_HMAC_KEY?.trim();
  const merchantAccount = env.ADYEN_MERCHANT_ACCOUNT?.trim();
  const envFlag = (env.ADYEN_ENVIRONMENT?.trim().toLowerCase() ?? "test") as
    | "test"
    | "live";

  const hasLiveEnv = !!apiKey && !!hmacKey && !!merchantAccount;
  if (!hasLiveEnv) {
    return { processor: new StubPaymentProcessor(), label: "stub", live: false };
  }

  // Prod guard — refuse to attach the live processor in production
  // unless the operator has explicitly acknowledged the live rail.
  // Same posture as the v1.17 STORE prod guard.
  if (
    env.NODE_ENV === "production" &&
    envFlag === "live" &&
    env.CANTILAPAY_LIVE_ACK !== "1"
  ) {
    throw CantilapayError.liveModeNotAcknowledged();
  }

  const adapter = new AdyenForPlatformsAdapter({
    apiKey,
    hmacKey,
    merchantAccount,
    managementBaseUrl: env.ADYEN_BASE_URL?.trim() || undefined,
    legalEntityBaseUrl: env.ADYEN_LEM_BASE_URL?.trim() || undefined,
    defaultEnvironment: envFlag,
  });
  return {
    processor: adapter,
    label: adapter.label,
    live: true,
  };
}

export { StubPaymentProcessor } from "./stub";
export { AdyenForPlatformsAdapter } from "./adyen";
export type {
  PaymentProcessor,
  PspInboundEvent,
  PspSubMerchant,
} from "./port";
