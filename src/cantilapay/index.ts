/* ============================================================
   Cantilapay — module entry point (plan §25, Phase 0).

   Public surface — what src/index.ts imports. Everything else
   is an implementation detail of the module.
   ============================================================ */

export { registerCantilapayRoutes } from "./routes";
export { selectPaymentProcessor } from "./adapters";
export { startDeliveryWorker } from "./services/webhooks-out";
export { startBillingEngineWorker, tick as cantilapayBillingTick } from "./services/billing-engine";
export type { PaymentProcessor, PaymentProcessorSelection } from "./adapters";
export type {
  CantilapayMode,
  CantilapayAccountStatus,
  CantilapayApiKeyKind,
  CantilapayAccountView,
  CantilapayApiKeyView,
  CantilapayApiKeyIssued,
  CantilapayWebhookEndpointView,
  CantilapayWebhookEndpointIssued,
  CantilapayEventView,
} from "./types";
export { CantilapayError } from "./errors";
