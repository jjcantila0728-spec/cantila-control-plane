/* ============================================================
   Cantilapay — Phase 2 smoke test (plan §25).

   Two halves:

     PART A — pure subscription-period math (no DB).
     PART B — end-to-end via service layer + billing engine.
              Skipped when no DATABASE_URL is configured.

   Run: `npx tsx scripts/smoke-cantilapay-phase-2.ts`

   Part A:
     1. addPeriod day / week / month / year semantics.

   Part B (requires DATABASE_URL):
     1. Create product + monthly price.
     2. Create customer + payment method.
     3. Create subscription (no trial) → status='incomplete'.
     4. Run engine tick → first invoice charged → status='active',
        invoice paid, payment_intent succeeded; emitted events
        include invoice.created, invoice.payment_succeeded,
        subscription.renewed.
     5. Fast-forward to next renewal (now + 31d) → engine tick
        generates next invoice + charges → still active, period
        advances.
     6. Create a second subscription on amount=1001 (deterministic
        stub decline) → tick → status='past_due', dunningAttempts=1.
     7. Fast-forward to nextDunningAt and re-tick repeatedly → after
        3 failed attempts, subscription status='canceled'.
     8. Cleanup: cascade-delete the test cantilapay account.
   ============================================================ */

import { addPeriod } from "../src/cantilapay/services/subscriptions";
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
  console.log("--- PART A — period math ---");
  const base = new Date(Date.UTC(2026, 5, 15));
  check(
    addPeriod(base, "day", 7).toISOString().startsWith("2026-06-22"),
    "addPeriod(day, 7) → +7 days",
  );
  check(
    addPeriod(base, "week", 2).toISOString().startsWith("2026-06-29"),
    "addPeriod(week, 2) → +14 days",
  );
  check(
    addPeriod(base, "month", 1).toISOString().startsWith("2026-07-15"),
    "addPeriod(month, 1) → next month same DOM",
  );
  check(
    addPeriod(base, "year", 1).toISOString().startsWith("2027-06-15"),
    "addPeriod(year, 1) → next year",
  );
}

async function partB(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.log("--- PART B — skipped (no DATABASE_URL) ---");
    console.log("  To run end-to-end Phase 2 against Postgres, set DATABASE_URL and rerun.");
    return;
  }
  console.log("--- PART B — billing engine end-to-end ---");

  const { PrismaClient } = await import("@prisma/client");
  const { enableForTenant } = await import("../src/cantilapay/services/accounts");
  const { createCustomer } = await import("../src/cantilapay/services/customers");
  const { createPaymentMethod } = await import(
    "../src/cantilapay/services/payment-methods"
  );
  const { createProduct } = await import("../src/cantilapay/services/products");
  const { createPrice } = await import("../src/cantilapay/services/prices");
  const { createSubscription, getSubscription } = await import(
    "../src/cantilapay/services/subscriptions"
  );
  const { listInvoices } = await import("../src/cantilapay/services/invoices");
  const { tick } = await import("../src/cantilapay/services/billing-engine");

  const prisma = new PrismaClient();
  const stub = new StubPaymentProcessor();
  const testAccountId = `acc_smoke_phase_2_${Date.now()}`;

  // Pre-clean
  await prisma.cantilapayAccount.deleteMany({
    where: { accountId: { startsWith: "acc_smoke_phase_2_" } },
  });

  const baseNow = new Date();

  try {
    // B1 — setup
    const account = await enableForTenant(prisma, {
      accountId: testAccountId,
      country: "USA",
    });
    const customer = await createCustomer(prisma, {
      cantilapayAccountId: account.id,
      mode: "test",
      email: "subscriber@example.com",
    });
    const okMethod = await createPaymentMethod(prisma, {
      cantilapayAccountId: account.id,
      mode: "test",
      pspToken: "tok_stub_visa_4242",
      customerId: customer.id,
      card: { brand: "visa", last4: "4242", expMonth: 12, expYear: 2030 },
    });
    const product = await createProduct(prisma, {
      cantilapayAccountId: account.id,
      mode: "test",
      name: "Cantila Hobby",
    });
    const price = await createPrice(prisma, {
      cantilapayAccountId: account.id,
      mode: "test",
      productId: product.id,
      unitAmount: 1000,
      currency: "usd",
      recurring: { interval: "month" },
    });
    check(price.unitAmount === 1000, "price created at $10.00/month");

    // B2 — first charge via initial tick
    const sub = await createSubscription(prisma, {
      cantilapayAccountId: account.id,
      mode: "test",
      customerId: customer.id,
      priceId: price.id,
      defaultPaymentMethodId: okMethod.id,
      now: baseNow,
    });
    check(sub.status === "incomplete", "new subscription starts incomplete");
    const initialPeriodEnd = new Date(sub.currentPeriodEnd);

    const tickResult1 = await tick(prisma, stub, { now: baseNow });
    check(
      tickResult1.initialCharges.ok >= 1,
      "engine tick charged the initial invoice",
      tickResult1,
    );
    const subAfter1 = await getSubscription(prisma, {
      cantilapayAccountId: account.id,
      mode: "test",
      id: sub.id,
    });
    check(subAfter1?.status === "active", "subscription is active after initial charge");

    const invoices1 = await listInvoices(prisma, {
      cantilapayAccountId: account.id,
      mode: "test",
      subscriptionId: sub.id,
    });
    check(invoices1.length === 1, "1 invoice exists");
    check(invoices1[0].status === "paid", "first invoice is paid");
    check(invoices1[0].amountPaid === 1000, "amountPaid = unitAmount");

    // Events
    const events = await prisma.cantilapayEvent.findMany({
      where: { cantilapayAccountId: account.id, mode: "test" },
      select: { type: true },
    });
    const types = new Set(events.map((e) => e.type));
    check(types.has("invoice.created"), "emitted invoice.created");
    check(types.has("invoice.payment_succeeded"), "emitted invoice.payment_succeeded");
    check(types.has("subscription.renewed"), "emitted subscription.renewed");

    // B3 — fast-forward to renewal
    const future1 = new Date(initialPeriodEnd.getTime() + 1000);
    const tickResult2 = await tick(prisma, stub, { now: future1 });
    check(
      tickResult2.rollovers.ok >= 1,
      "engine rolled over and charged next period",
      tickResult2,
    );
    const subAfter2 = await getSubscription(prisma, {
      cantilapayAccountId: account.id,
      mode: "test",
      id: sub.id,
    });
    check(subAfter2?.status === "active", "still active after renewal");
    const newPeriodEnd = new Date(subAfter2!.currentPeriodEnd);
    check(
      newPeriodEnd.getTime() > initialPeriodEnd.getTime(),
      "period advanced after renewal",
    );
    const invoices2 = await listInvoices(prisma, {
      cantilapayAccountId: account.id,
      mode: "test",
      subscriptionId: sub.id,
    });
    check(invoices2.length === 2, "2 invoices after one renewal");

    // B4 — dunning path: a subscription on a "decline-always" price.
    const declinePrice = await createPrice(prisma, {
      cantilapayAccountId: account.id,
      mode: "test",
      productId: product.id,
      unitAmount: 1001, // stub: amount % 100 === 1 → declined
      currency: "usd",
      recurring: { interval: "month" },
    });
    const dunningSub = await createSubscription(prisma, {
      cantilapayAccountId: account.id,
      mode: "test",
      customerId: customer.id,
      priceId: declinePrice.id,
      defaultPaymentMethodId: okMethod.id,
      now: baseNow,
    });
    const tickResult3 = await tick(prisma, stub, { now: baseNow });
    check(
      tickResult3.initialCharges.failed >= 1,
      "decline-always subscription fails first charge",
      tickResult3,
    );
    const dunningAfter1 = await getSubscription(prisma, {
      cantilapayAccountId: account.id,
      mode: "test",
      id: dunningSub.id,
    });
    check(dunningAfter1?.status === "past_due", "subscription entered past_due", dunningAfter1?.status);

    // Step forward through the dunning retries (24h, 72h, 168h).
    // After 3 total failures (initial + 2 retries) the cap triggers cancel.
    let dunningRow = await prisma.cantilapaySubscription.findUnique({
      where: { id: dunningSub.id },
    });
    let stepNow = baseNow;
    let retries = 0;
    while (dunningRow && dunningRow.status === "past_due" && retries < 5) {
      stepNow = new Date(dunningRow.nextDunningAt!.getTime() + 1000);
      await tick(prisma, stub, { now: stepNow });
      dunningRow = await prisma.cantilapaySubscription.findUnique({
        where: { id: dunningSub.id },
      });
      retries += 1;
    }
    check(
      dunningRow?.status === "canceled",
      "subscription canceled after MAX_DUNNING_ATTEMPTS",
      { status: dunningRow?.status, attempts: dunningRow?.dunningAttempts },
    );
    const dunningEvents = await prisma.cantilapayEvent.findMany({
      where: {
        cantilapayAccountId: account.id,
        mode: "test",
        type: "subscription.deleted",
      },
    });
    check(dunningEvents.length >= 1, "emitted subscription.deleted on dunning cancel");
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
  console.log("=== Cantilapay Phase 2 smoke test ===");
  partA();
  await partB();
  console.log("=== Phase 2 smoke test ===");
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
