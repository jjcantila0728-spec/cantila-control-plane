/* ============================================================
   Adyen real-impl barrel. Splits the live adapter across
   focused files so the Adyen contract stays scannable.

   Exports are appended incrementally as each sub-module lands
   in Tasks 2-5 (client, error-mapping, payments, webhooks) and
   Task 9 (submerchants).
   ============================================================ */

export {};

export { buildAdyenClients, _resetAdyenClientCacheForTest } from "./client";
export type { AdyenClients, AdyenClientConfig } from "./client";

export { mapAdyenRefusalReason, type MappedRefusal } from "./error-mapping";
