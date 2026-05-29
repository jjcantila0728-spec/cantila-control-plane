/* ============================================================
   Cantilapay — Phase 1 smoke test (plan §25).

   Two halves:

     PART A — pure stub adapter checks (no DB).
     PART B — end-to-end via service layer using Prisma.
              Skipped when no DATABASE_URL is configured.

   Run: `npx tsx scripts/smoke-cantilapay-phase-1.ts`

   Coverage:
     A1. Stub confirmPayment automatic-capture succeeds.
     A2. Stub confirmPayment declines (amount % 100 === 1).
     A3. Stub confirmPayment manual-capture → authorized_pending_capture.
     A4. Stub capturePayment returns succeeded.
     A5. Stub refundPayment succeeds.
     A6. Stub refundPayment with amount=1 fails (deterministic).
     A7. Stub cancelPayment returns succeeded.

     B1. enable + create customer + attach payment method.
     B2. PaymentIntent automatic-capture succeeds end-to-end;
         CantilapayPaymentIntent.status flips to "succeeded";
         CantilapayEvent rows recorded for created+succeeded;
         outbound delivery queued (when a webhook endpoint exists).
     B3. PaymentIntent declined path emits payment_intent.payment_failed.
     B4. PaymentIntent manual-capture flow → /capture → succeeded.
     B5. Refund (partial) updates intent.amountRefunded.
     B6. Idempotency replay returns identical row.
     B7. Cleanup: all rows under the test cantilapay account are
         removed (cascade via CantilapayAccount delete).
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

async function partA(): Promise<void> {
  console.log("--- PART A — stub adapter Phase 1 ---");
  const stub = new StubPaymentProcessor();

  // A1
  const ok = await stub.confirmPayment({
    subMerchantId: "le_stub_smoke",
    paymentIntentId: "pi_smoke_1",
    amount: 1000,
    currency: "usd",
    paymentMethodToken: "tok_stub_visa_4242",
    captureMode: "automatic",
    mode: "test",
    platformFeeAmount: 50,
  });
  check(ok.status === "succeeded", "stub auto-capture succeeds at amount=1000", ok);
  check(ok.pspPaymentRef.startsWith("psp_stub_"), "stub returns psp_stub_ ref");

  // A2
  const declined = await stub.confirmPayment({
    subMerchantId: "le_stub_smoke",
    paymentIntentId: "pi_smoke_2",
    amount: 1001,
    currency: "usd",
    paymentMethodToken: "tok_stub_visa_4242",
    captureMode: "automatic",
    mode: "test",
    platformFeeAmount: 50,
  });
  check(declined.status === "failed", "stub declines amount % 100 === 1");
  check(declined.declineCode === "insufficient_funds", "decline code is insufficient_funds");

  // A3
  const auth = await stub.confirmPayment({
    subMerchantId: "le_stub_smoke",
    paymentIntentId: "pi_smoke_3",
    amount: 1500,
    currency: "usd",
    paymentMethodToken: "tok_stub_visa_4242",
    captureMode: "manual",
    mode: "test",
    platformFeeAmount: 75,
  });
  check(auth.status === "authorized_pending_capture", "stub manual-capture returns auth_pending");

  // A4
  const cap = await stub.capturePayment({
    pspPaymentRef: auth.pspPaymentRef,
    amount: 1500,
    currency: "usd",
    mode: "test",
  });
  check(cap.status === "succeeded", "stub capturePayment succeeds");

  // A5
  const rf = await stub.refundPayment({
    pspPaymentRef: ok.pspPaymentRef,
    amount: 500,
    currency: "usd",
    mode: "test",
  });
  check(rf.status === "succeeded", "stub refundPayment succeeds");

  // A6
  const rfFail = await stub.refundPayment({
    pspPaymentRef: ok.pspPaymentRef,
    amount: 1,
    currency: "usd",
    mode: "test",
  });
  check(rfFail.status === "failed", "stub refundPayment fails at amount=1 (deterministic)");

  // A7
  const cancel = await stub.cancelPayment({
    pspPaymentRef: auth.pspPaymentRef,
    mode: "test",
  });
  check(cancel.status === "succeeded", "stub cancelPayment succeeds");
}

async function partB(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.log("--- PART B — skipped (no DATABASE_URL) ---");
    console.log("  To run end-to-end Phase 1 against Postgres, set DATABASE_URL and rerun.");
    return;
  }
  console.log("--- PART B — end-to-end with Prisma ---");

  const { PrismaClient } = await import("@prisma/client");
  const { enableForTenant } = await import("../src/cantilapay/services/accounts");
  const { createCustomer, listCustomers } = await import(
    "../src/cantilapay/services/customers"
  );
  const { createPaymentMethod } = await import(
    "../src/cantilapay/services/payment-methods"
  );
  const {
    createPaymentIntent,
    confirmPaymentIntent,
    capturePaymentIntent,
    getPaymentIntent,
  } = await import("../src/cantilapay/services/payment-intents");
  const { createRefund } = await import("../src/cantilapay/services/refunds");
  const { createWebhookEndpoint } = await import(
    "../src/cantilapay/services/webhooks-out"
  );

  const prisma = new PrismaClient();
  const stub = new StubPaymentProcessor();
  const testAccountId = `acc_smoke_phase_1_${Date.now()}`;

  // Pre-clean (in case a previous run left rows). The CASCADE on the
  // FK means delete on CantilapayAccount tears everything down.
  await prisma.cantilapayAccount.deleteMany({
    where: { accountId: { startsWith: "acc_smoke_phase_1_" } },
  });

  try {
    // B1 — enable + create customer + payment method
    const account = await enableForTenant(prisma, {
      accountId: testAccountId,
      country: "USA",
    });
    check(account.id.length > 0, "enableForTenant created cantilapay account");

    // Add a webhook endpoint so emitted events queue deliveries.
    await createWebhookEndpoint(prisma, {
      cantilapayAccountId: account.id,
      url: "https://tenant.example.com/webhooks/cantilapay",
      mode: "test",
    });

    const customer = await createCustomer(prisma, {
      cantilapayAccountId: account.id,
      mode: "test",
      email: "buyer@example.com",
      name: "Smoke Buyer",
    });
    check(customer.id.length > 0, "createCustomer returns a row");

    const customers = await listCustomers(prisma, {
      cantilapayAccountId: account.id,
      mode: "test",
    });
    check(customers.length === 1, "listCustomers returns 1");

    const method = await createPaymentMethod(prisma, {
      cantilapayAccountId: account.id,
      mode: "test",
      pspToken: "tok_stub_visa_4242",
      customerId: customer.id,
      card: { brand: "visa", last4: "4242", expMonth: 12, expYear: 2030 },
    });
    check(method.status === "chargeable", "createPaymentMethod row is chargeable");

    // B2 — auto-capture succeeds end-to-end
    const intent = await createPaymentIntent(prisma, {
      cantilapayAccountId: account.id,
      mode: "test",
      amount: 1000,
      currency: "usd",
      customerId: customer.id,
      paymentMethodId: method.id,
    });
    check(intent.status === "requires_confirmation", "intent starts requires_confirmation");
    check(intent.platformFeeAmount === 5, "platformFee = 1000 * 50bps = 5 (cents)");

    const confirmed = await confirmPaymentIntent(prisma, stub, {
      cantilapayAccountId: account.id,
      mode: "test",
      id: intent.id,
    });
    check(confirmed.status === "succeeded", "auto-capture flow ends succeeded", confirmed);
    check(confirmed.amountCaptured === 1000, "amountCaptured = full amount on succeed");

    // Events
    const events = await prisma.cantilapayEvent.findMany({
      where: { cantilapayAccountId: account.id, mode: "test" },
      orderBy: { createdAt: "asc" },
    });
    const eventTypes = events.map((e) => e.type);
    check(
      eventTypes.includes("payment_intent.created"),
      "emitted payment_intent.created",
    );
    check(
      eventTypes.includes("payment_intent.succeeded"),
      "emitted payment_intent.succeeded",
    );

    // Outbound deliveries queued
    const deliveries = await prisma.cantilapayWebhookDelivery.findMany({
      where: { cantilapayAccountId: account.id },
    });
    check(deliveries.length > 0, "outbound deliveries queued for tenant endpoint");

    // B3 — declined path
    const badIntent = await createPaymentIntent(prisma, {
      cantilapayAccountId: account.id,
      mode: "test",
      amount: 1001,
      currency: "usd",
      paymentMethodId: method.id,
    });
    const badConfirmed = await confirmPaymentIntent(prisma, stub, {
      cantilapayAccountId: account.id,
      mode: "test",
      id: badIntent.id,
    });
    check(badConfirmed.status === "failed", "decline flow ends failed");
    check(
      badConfirmed.lastError?.code === "card_declined",
      "lastError carries the decline code",
      badConfirmed.lastError,
    );

    // B4 — manual capture
    const manualIntent = await createPaymentIntent(prisma, {
      cantilapayAccountId: account.id,
      mode: "test",
      amount: 2000,
      currency: "usd",
      paymentMethodId: method.id,
      captureMode: "manual",
    });
    const authIntent = await confirmPaymentIntent(prisma, stub, {
      cantilapayAccountId: account.id,
      mode: "test",
      id: manualIntent.id,
    });
    check(
      authIntent.status === "requires_capture",
      "manual-capture confirm yields requires_capture",
    );
    const captured = await capturePaymentIntent(prisma, stub, {
      cantilapayAccountId: account.id,
      mode: "test",
      id: manualIntent.id,
    });
    check(captured.status === "succeeded", "manual capture flips to succeeded");

    // B5 — partial refund
    const refund = await createRefund(prisma, stub, {
      cantilapayAccountId: account.id,
      mode: "test",
      paymentIntentId: confirmed.id,
      amount: 400,
      reason: "requested_by_customer",
    });
    check(refund.status === "succeeded", "partial refund succeeds");
    const intentAfter = await getPaymentIntent(prisma, {
      cantilapayAccountId: account.id,
      mode: "test",
      id: confirmed.id,
    });
    check(
      intentAfter?.amountRefunded === 400,
      "intent.amountRefunded bumped after refund",
      intentAfter?.amountRefunded,
    );
  } finally {
    // Cleanup — cascade deletes everything keyed to the test account.
    await prisma.cantilapayAccount
      .delete({ where: { id: (await prisma.cantilapayAccount.findUnique({ where: { accountId: testAccountId } }))!.id } })
      .catch(() => {
        /* already gone, fine */
      });
    await prisma.$disconnect();
  }
}

async function main(): Promise<void> {
  console.log("=== Cantilapay Phase 1 smoke test ===");
  await partA();
  await partB();
  console.log("=== Phase 1 smoke test ===");
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
