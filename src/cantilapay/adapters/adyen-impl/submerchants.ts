/* ============================================================
   Adyen Legal Entity Management + Balance Platform —
   sub-merchant lifecycle.

   On createSubMerchant we provision:
     LegalEntity (type=individual, country=USA)
       → AccountHolder (linked to LE)
         → BalanceAccount (currency=USD)
   The BalanceAccount id is what we return as `subMerchantId` — it
   is what the payments confirm() routes funds to via splits.

   Phase B (Hosted Onboarding) returns a URL that walks the tenant
   through KYC verification; on success an
   ACCOUNT_HOLDER_VERIFICATION webhook fires and our
   reconcileAccountFromPsp flips status → 'active'.
   ============================================================ */

import { randomUUID } from "node:crypto";
import type { PspSubMerchant } from "../port";
import type { CantilapayMode } from "../../types";
import type { AdyenClients } from "./client";
import { LegalEntityInfoRequiredType } from "@adyen/api-library/lib/src/typings/legalEntityManagement/legalEntityInfoRequiredType";

export async function createSubMerchant(
  clients: AdyenClients,
  input: { country: string; externalRef: string; mode: CantilapayMode },
): Promise<PspSubMerchant> {
  // 1. Legal Entity (individual sole-prop by default; v1.1.2 will
  //    add an `entityType` arg for organisations).
  const legalEntity = await clients.lem.LegalEntitiesApi.createLegalEntity({
    type: LegalEntityInfoRequiredType.TypeEnum.Individual,
    individual: {
      residentialAddress: { country: input.country.toUpperCase().slice(0, 2) },
      name: { firstName: "Pending", lastName: "Onboarding" },
    },
    reference: input.externalRef,
  }, { idempotencyKey: randomUUID() });

  // 2. Account Holder wrapping the legal entity
  const accountHolder = await clients.balancePlatform.AccountHoldersApi.createAccountHolder({
    legalEntityId: legalEntity.id,
    balancePlatform: clients.balancePlatformName,
    description: `Cantilapay sub-merchant ${input.externalRef}`,
    reference: input.externalRef,
  }, { idempotencyKey: randomUUID() });

  // 3. Balance Account — where settled funds land
  const balanceAccount = await clients.balancePlatform.BalanceAccountsApi.createBalanceAccount({
    accountHolderId: accountHolder.id,
    defaultCurrencyCode: "USD",
    description: `Default balance for ${input.externalRef}`,
    reference: input.externalRef,
  }, { idempotencyKey: randomUUID() });

  return {
    id: balanceAccount.id,
    status: "pending_kyc",
    onboardingLink: null, // call createOnboardingLink to mint
  };
}

export async function getSubMerchant(
  clients: AdyenClients,
  input: { id: string; mode: CantilapayMode },
): Promise<PspSubMerchant> {
  // We persist the BalanceAccount id; walk back: BA → AH → LE → status
  const ba = await clients.balancePlatform.BalanceAccountsApi.getBalanceAccount(input.id);
  if (!ba.accountHolderId) {
    return { id: input.id, status: "disabled", onboardingLink: null };
  }
  const ah = await clients.balancePlatform.AccountHoldersApi.getAccountHolder(ba.accountHolderId);
  // status: 'active' | 'suspended' | 'closed'
  let status: PspSubMerchant["status"];
  switch (ah.status) {
    case "active":
      // Check verification on the legal entity
      if (ah.legalEntityId) {
        const le = await clients.lem.LegalEntitiesApi.getLegalEntity(ah.legalEntityId);
        const capabilities = le.capabilities ?? {};
        const allowed = Object.values(capabilities).every(
          (c) => c.allowed === true,
        );
        status = allowed ? "active" : "pending_kyc";
      } else {
        status = "pending_kyc";
      }
      break;
    case "suspended":
    case "closed":
      status = "disabled";
      break;
    default:
      status = "pending_kyc";
  }
  return { id: input.id, status, onboardingLink: null };
}

export async function createOnboardingLink(
  clients: AdyenClients,
  input: {
    subMerchantId: string;
    mode: CantilapayMode;
    returnUrl: string;
  },
): Promise<{ url: string; expiresAt: string }> {
  // Walk BA → AH → LE
  const ba = await clients.balancePlatform.BalanceAccountsApi.getBalanceAccount(input.subMerchantId);
  if (!ba.accountHolderId) {
    throw new Error(`balance account ${input.subMerchantId} has no account holder`);
  }
  const ah = await clients.balancePlatform.AccountHoldersApi.getAccountHolder(ba.accountHolderId);
  if (!ah.legalEntityId) {
    throw new Error(`account holder ${ba.accountHolderId} has no legal entity`);
  }
  const link = await clients.lem.HostedOnboardingApi.getLinkToAdyenhostedOnboardingPage(
    ah.legalEntityId,
    {
      themeId: clients.onboardingThemeId,
      locale: "en-US",
      redirectUrl: input.returnUrl,
    },
  );
  // Adyen OnboardingLink only returns `url`; default expiresAt to +24h
  const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  if (!link.url) {
    throw new Error("Adyen Hosted Onboarding returned no URL");
  }
  return { url: link.url, expiresAt };
}
