/* ============================================================
   Cantilapay — Phase 3 smoke test (plan §25).

   PART A — pure adapter / no-DB checks.
   PART B — end-to-end ledger + payout flow (requires DATABASE_URL).

   Run: `npx tsx scripts/smoke-cantilapay-phase-3.ts`

   Part A:
     1. Stub adapter still handles `account.updated` inbound shape
        when fed via `signInboundForTest`.

   Part B:
     1. Enable account + customer + payment method + product/price.
     2. Charge $10 (auto-capture) → expect balance:
          +1000 charge, -5 platform_fee (50 bps default), net 995.
     3. Refund $4 → expect: -400 refund. Net 595.
     4. Mark account active manually (Phase 0 stub) so the payout
        engine considers it.
     5. Engine tick → schedules a pending payout for $5.95.
     6. Fast-forward to arrivalDate → engine tick → payout paid,
        balance debited by -595 (net 0).
     7. Account status drift via account.updated inbound webhook
        (status='rejected') → CantilapayAccount.status flips.
   ============================================================ */

import { StubPaymentProcessor } from "../src/cantilapay/adapters/stub";

let failed = 0;
function check(condition: unknown, label: string, detail?: unknown): void {
  if (condition) {
    console.log(`✓ ${label}`);
  } else {
    failed += 1;
    console.error(`✗ ${label}`);
    if (detail !== undefined) console.error("   ", detail);
  }
}

function partA(): void {
  console.log("--- PART A — adapter no-DB ---");
  const stub = new StubPaymentProcessor();
  const event = {
    id: "evt_account_1",
    type: "account.updated" as const,
    subMerchantId: "le_stub_xyz",
    raw: { status: "active" },
  };
  const signed = stub.signInboundForTest(event);
  const parsed = stub.parseInboundWebhook({
    rawBody: signed.rawBody,
    headers: { [signed.header.name]: signed.header.value },
  });
  check(parsed[0].type === "account.updated", "stub passes through account.updated type");
  check(
    (parsed[0].raw as { status?: string })?.status === "active",
    "stub preserves status in payload",
  );
}

async function partB(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.log("--- PART B — skipped (no DATABASE_URL) ---");
    return;
  }
  console.log("--- PART B — end-to-end balance + payouts ---");

  const { PrismaClient } = await import("@prisma/client");
  const { enableForTenant } = await import("../src/cantilapay/services/accounts");
  const { createCustomer } = await import("../src/cantilapay/services/customers");
  const { createPaymentMethod } = await import(
    "../src/cantilapay/services/payment-methods"
  );
  const {
    createPaymentIntent,
    confirmPaymentIntent,
  } = await import("../src/cantilapay/services/payment-intents");
  const { createRefund } = await import("../src/cantilapay/services/refunds");
  const { getBalance, listBalanceTransactions } = await import(
    "../src/cantilapay/services/balance"
  );
  const { tick } = await import("../src/cantilapay/services/billing-engine");
  const { handleInboundWebhook } = await import("../src/cantilapay/services/webhooks-in");

  const prisma = new PrismaClient();
  const stub = new StubPaymentProcessor();
  const testAccountId = `acc_smoke_phase_3_${Date.now()}`;

  await prisma.cantilapayAccount.deleteMany({
    where: { accountId: { startsWith: "acc_smoke_phase_3_" } },
  });

  try {
    const account = await enableForTenant(prisma, {
      accountId: testAccountId,
      country: "USA",
    });
    // Flip to active manually so the payout engine considers it.
    await prisma.cantilapayAccount.update({
      where: { id: account.id },
      data: { status: "active", adyenAccountHolderIdTest: "le_stub_smoke_3" },
    });

    const customer = await createCustomer(prisma, {
      cantilapayAccountId: account.id,
      mode: "test",
      email: "buyer3@example.com",
    });
    const method = await createPaymentMethod(prisma, {
      cantilapayAccountId: account.id,
      mode: "test",
      pspToken: "tok_stub_visa_4242",
      customerId: customer.id,
    });
    const intent = await createPaymentIntent(prisma, {
      cantilapayAccountId: account.id,
      mode: "test",
      amount: 1000,
      currency: "usd",
      customerId: customer.id,
      paymentMethodId: method.id,
    });
    const confirmed = await confirmPaymentIntent(prisma, stub, {
      cantilapayAccountId: account.id,
      mode: "test",
      id: intent.id,
    });
    check(confirmed.status === "succeeded", "charge succeeded");

    let balance = await getBalance(prisma, {
      cantilapayAccountId: account.id,
      mode: "test",
    });
    check(balance.available === 995, "balance is 995 after $10 - 0.5% fee", balance);

    const refund = await createRefund(prisma, stub, {
      cantilapayAccountId: account.id,
      mode: "test",
      paymentIntentId: confirmed.id,
      amount: 400,
    });
    check(refund.status === "succeeded", "refund succeeded");
    balance = await getBalance(prisma, {
      cantilapayAccountId: account.id,
      mode: "test",
    });
    check(balance.available === 595, "balance is 595 after $4 refund", balance);

    const txns = await listBalanceTransactions(prisma, {
      cantilapayAccountId: account.id,
      mode: "test",
    });
    const types = txns.map((t) => t.type).sort();
    check(
      JSON.stringify(types) ===
        JSON.stringify(["charge", "platform_fee", "refund"].sort()),
      "balance transactions: charge + platform_fee + refund",
      types,
    );

    // Engine tick: schedule a payout.
    const baseNow = new Date();
    const tick1 = await tick(prisma, stub, { now: baseNow });
    check(tick1.payouts.scheduled === 1, "payout scheduled for $5.95", tick1.payouts);
    check(tick1.payouts.settled === 0, "payout not yet settled (arrival in 24h)");

    let payouts = await prisma.cantilapayPayout.findMany({
      where: { cantilapayAccountId: account.id, mode: "test" },
    });
    check(payouts.length === 1, "1 payout row");
    check(payouts[0].amount === 595, "payout amount = available balance");
    check(payouts[0].status === "pending", "payout in pending state");

    // Available is unchanged (payout hasn't settled); pending now == 595.
    balance = await getBalance(prisma, {
      cantilapayAccountId: account.id,
      mode: "test",
    });
    check(balance.pending === 595, "balance.pending reflects scheduled payout");

    // Fast-forward past arrivalDate.
    const future = new Date(payouts[0].arrivalDate.getTime() + 1000);
    const tick2 = await tick(prisma, stub, { now: future });
    check(tick2.payouts.settled === 1, "payout settled on next tick", tick2.payouts);

    payouts = await prisma.cantilapayPayout.findMany({
      where: { cantilapayAccountId: account.id, mode: "test" },
    });
    check(payouts[0].status === "paid", "payout marked paid");
    balance = await getBalance(prisma, {
      cantilapayAccountId: account.id,
      mode: "test",
    });
    check(balance.available === 0, "available balance is 0 post-payout", balance);
    check(balance.pending === 0, "pending is 0 post-payout");

    // KYC reconciliation: send account.updated with status=rejected.
    const event = {
      id: "evt_reject_1",
      type: "account.updated" as const,
      subMerchantId: "le_stub_smoke_3",
      raw: { status: "rejected" },
    };
    const signed = stub.signInboundForTest(event);
    const outcome = await handleInboundWebhook({
      prisma,
      processor: stub,
      rawBody: signed.rawBody,
      headers: { [signed.header.name]: signed.header.value },
      mode: "test",
    });
    check(outcome.accepted, "inbound account.updated accepted");
    const afterReject = await prisma.cantilapayAccount.findUnique({
      where: { id: account.id },
    });
    check(afterReject?.status === "rejected", "cantilapay account flipped to rejected");
  } finally {
    const found = await prisma.cantilapayAccount.findUnique({
      where: { accountId: testAccountId },
    });
    if (found) {
      await prisma.cantilapayAccount.delete({ where: { id: found.id } }).catch(() => {});
    }
    await prisma.$disconnect();
  }
}

async function main(): Promise<void> {
  console.log("=== Cantilapay Phase 3 smoke test ===");
  partA();
  await partB();
  console.log("=== Phase 3 smoke test ===");
  if (failed === 0) {
    console.log("PASS — all checks green");
    process.exit(0);
  } else {
    console.error(`FAIL — ${failed} check(s) failed`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("smoke test threw:", err);
  process.exit(1);
});
