/* ============================================================
   Adyen SDK client wiring. Each operation family (Checkout,
   Legal Entity Management, Balance Platform, Management) needs
   its own API key per Adyen's auth model. We build one set of
   clients per `mode` (test/live) and cache them so request-time
   doesn't allocate.
   ============================================================ */

import {
  Client,
  CheckoutAPI,
  LegalEntityManagementAPI,
  BalancePlatformAPI,
  ManagementAPI,
} from "@adyen/api-library";

import type { CantilapayMode } from "../../types";

export interface AdyenClients {
  checkout: CheckoutAPI;
  lem: LegalEntityManagementAPI;
  balancePlatform: BalancePlatformAPI;
  management: ManagementAPI;
  /** Echo back for callers that need to pass it to API arguments
   *  (e.g. balance-account selection per merchant account). */
  merchantAccount: string;
  balancePlatformName: string;
  liableBalanceAccountId: string;
  onboardingThemeId: string;
}

export interface AdyenClientConfig {
  checkoutApiKey: string;
  managementApiKey: string;
  balancePlatformApiKey: string;
  lemApiKey: string;
  merchantAccount: string;
  balancePlatformName: string;
  liableBalanceAccountId: string;
  onboardingThemeId: string;
  /** "TEST" or "LIVE" — Adyen SDK convention. */
  environment: "TEST" | "LIVE";
  /** Live URL prefix from Adyen Customer Area, e.g.
   *  "1797a841fbb37ca7-CantilaplatformTEST". Required for LIVE; ignored
   *  for TEST. */
  liveEndpointUrlPrefix?: string;
}

function buildClient(apiKey: string, cfg: AdyenClientConfig): Client {
  const client = new Client({
    apiKey,
    environment: cfg.environment,
  });
  if (cfg.environment === "LIVE" && cfg.liveEndpointUrlPrefix) {
    client.setEnvironment("LIVE", cfg.liveEndpointUrlPrefix);
  }
  return client;
}

const cache = new Map<string, AdyenClients>();

/** Build (or fetch from cache) the per-mode Adyen clients. The cache
 *  key includes mode + the first 8 chars of the checkout key so a
 *  hot-reloaded config doesn't return a stale client. */
export function buildAdyenClients(
  mode: CantilapayMode,
  cfg: AdyenClientConfig,
): AdyenClients {
  const key = `${mode}::${cfg.checkoutApiKey.slice(0, 8)}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const clients: AdyenClients = {
    checkout: new CheckoutAPI(buildClient(cfg.checkoutApiKey, cfg)),
    lem: new LegalEntityManagementAPI(buildClient(cfg.lemApiKey, cfg)),
    balancePlatform: new BalancePlatformAPI(buildClient(cfg.balancePlatformApiKey, cfg)),
    management: new ManagementAPI(buildClient(cfg.managementApiKey, cfg)),
    merchantAccount: cfg.merchantAccount,
    balancePlatformName: cfg.balancePlatformName,
    liableBalanceAccountId: cfg.liableBalanceAccountId,
    onboardingThemeId: cfg.onboardingThemeId,
  };
  cache.set(key, clients);
  return clients;
}

/** Test-only — drop the cache so a smoke test that rotates keys
 *  doesn't pick up a stale client. */
export function _resetAdyenClientCacheForTest(): void {
  cache.clear();
}
