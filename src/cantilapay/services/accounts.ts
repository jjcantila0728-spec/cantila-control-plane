/* ============================================================
   Cantilapay — sub-merchant account service (plan §25, Phase 0).

   Lifecycle:
     POST /v1/cantilapay/accounts          → enableForTenant
     GET  /v1/cantilapay/accounts/me       → getForTenant
     POST /v1/cantilapay/accounts/me/onboarding_link?mode=test
                                           → createOnboardingLink

   Phase 0 ships:
     - Tenant-owned `CantilapayAccount` row creation (idempotent).
     - Hosted-onboarding link minting via the PSP adapter.
     - View projection (`toView`) that hides PSP-side ids.

   Phase 3 fleshes out the on-completion flow (Adyen "account
   holder status changed" webhook flips status → active).
   ============================================================ */

import type { PrismaClient } from "@prisma/client";

import type { PaymentProcessor } from "../adapters/port";
import type {
  CantilapayAccountStatus,
  CantilapayAccountView,
  CantilapayMode,
} from "../types";
import { recordCantilapayAudit } from "./audit";

function toView(row: {
  id: string;
  accountId: string;
  status: CantilapayAccountStatus;
  platformFeeBps: number;
  country: string | null;
  adyenAccountHolderIdTest: string | null;
  adyenAccountHolderIdLive: string | null;
  createdAt: Date;
  updatedAt: Date;
}): CantilapayAccountView {
  return {
    id: row.id,
    accountId: row.accountId,
    status: row.status,
    platformFeeBps: row.platformFeeBps,
    country: row.country,
    testReady: row.adyenAccountHolderIdTest != null && row.status === "active",
    liveReady: row.adyenAccountHolderIdLive != null && row.status === "active",
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Enable cantilapay for a tenant. Idempotent: if a row already exists
 *  for the account, return the existing view. */
export async function enableForTenant(
  prisma: PrismaClient,
  input: { accountId: string; country?: string },
): Promise<CantilapayAccountView> {
  const existing = await prisma.cantilapayAccount.findUnique({
    where: { accountId: input.accountId },
  });
  if (existing) return toView(existing);

  const row = await prisma.cantilapayAccount.create({
    data: {
      accountId: input.accountId,
      country: input.country ?? null,
    },
  });

  await recordCantilapayAudit(prisma, {
    cantilapayAccountId: row.id,
    type: "cantilapay.account.created",
    message: `Cantilapay enabled for account ${input.accountId}`,
    data: { country: input.country ?? null },
  });

  return toView(row);
}

/** Read the cantilapay account row for a tenant. Returns null when
 *  the tenant has not enabled cantilapay yet. */
export async function getForTenant(
  prisma: PrismaClient,
  input: { accountId: string },
): Promise<CantilapayAccountView | null> {
  const row = await prisma.cantilapayAccount.findUnique({
    where: { accountId: input.accountId },
  });
  return row ? toView(row) : null;
}

/** Read by cantilapay id (used internally after auth resolves a key). */
export async function getById(
  prisma: PrismaClient,
  id: string,
): Promise<CantilapayAccountView | null> {
  const row = await prisma.cantilapayAccount.findUnique({ where: { id } });
  return row ? toView(row) : null;
}

/** Generate a hosted KYC URL for the tenant, minting the PSP-side
 *  sub-merchant if it hasn't been created yet in this mode. */
export async function createOnboardingLink(
  prisma: PrismaClient,
  processor: PaymentProcessor,
  input: {
    cantilapayAccountId: string;
    mode: CantilapayMode;
    country: string;
    returnUrl: string;
  },
): Promise<{ url: string; expiresAt: string }> {
  const row = await prisma.cantilapayAccount.findUnique({
    where: { id: input.cantilapayAccountId },
  });
  if (!row) throw new Error(`cantilapay account ${input.cantilapayAccountId} not found`);

  const existingId =
    input.mode === "test" ? row.adyenAccountHolderIdTest : row.adyenAccountHolderIdLive;
  let subMerchantId = existingId;
  if (!subMerchantId) {
    const sub = await processor.createSubMerchant({
      country: input.country,
      externalRef: row.id,
      mode: input.mode,
    });
    subMerchantId = sub.id;
    await prisma.cantilapayAccount.update({
      where: { id: row.id },
      data:
        input.mode === "test"
          ? {
              adyenAccountHolderIdTest: subMerchantId,
              status: row.status === "created" ? "onboarding" : row.status,
              country: row.country ?? input.country,
            }
          : {
              adyenAccountHolderIdLive: subMerchantId,
              status: row.status === "created" ? "onboarding" : row.status,
              country: row.country ?? input.country,
            },
    });
    await recordCantilapayAudit(prisma, {
      cantilapayAccountId: row.id,
      type: "cantilapay.account.submerchant_created",
      message: `Created ${input.mode} sub-merchant`,
      data: { mode: input.mode, subMerchantId },
    });
  }

  const link = await processor.createOnboardingLink({
    subMerchantId,
    mode: input.mode,
    returnUrl: input.returnUrl,
  });

  await recordCantilapayAudit(prisma, {
    cantilapayAccountId: row.id,
    type: "cantilapay.account.onboarding_link_issued",
    message: `Hosted onboarding link issued (${input.mode})`,
    data: { mode: input.mode, expiresAt: link.expiresAt },
  });

  return link;
}
