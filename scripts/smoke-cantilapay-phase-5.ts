/* ============================================================
   Cantilapay — Phase 5 smoke test (plan §25).

   PART A — tax-provider selector + stub (no DB).
   PART B — end-to-end calc + persist + retrieve (requires DATABASE_URL).
   ============================================================ */

import {
  StubTaxProvider,
  selectTaxProvider,
} from "../src/cantilapay/adapters/tax-port";

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
  console.log("--- PART A — tax-provider selector + stub ---");
  const stub = new StubTaxProvider();
  const r = await stub.calculate({
    amount: 1000,
    currency: "usd",
    customerCountry: "USA",
    customerState: "CA",
    customerPostalCode: "94110",
    mode: "test",
  });
  check(r.taxAmount === 0, "stub returns 0 tax");
  check(r.taxRateBps === 0, "stub rate is 0 bps");
  check(r.breakdown.length === 0, "stub breakdown is empty");

  const def = selectTaxProvider({});
  check(def.label === "stub", "empty env selects stub");
  check(def.live === false, "stub is not live");

  const live = selectTaxProvider({ ANROK_API_KEY: "k_test_anrok" });
  check(live.label === "Anrok", "ANROK_API_KEY selects Anrok adapter");
  check(live.live === true, "Anrok adapter is live");

  // Anrok skeleton throws on calculate
  let threw = false;
  try {
    await live.provider.calculate({
      amount: 1000,
      currency: "usd",
      customerCountry: "USA",
      mode: "test",
    });
  } catch {
    threw = true;
  }
  check(threw, "Anrok adapter skeleton throws (real wiring is future drop)");
}

async function partB(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.log("--- PART B — skipped (no DATABASE_URL) ---");
    return;
  }
  console.log("--- PART B — end-to-end Phase 5 ---");
  const { PrismaClient } = await import("@prisma/client");
  const { enableForTenant } = await import("../src/cantilapay/services/accounts");
  const { calculateTax, getTaxCalculation } = await import(
    "../src/cantilapay/services/tax"
  );

  const prisma = new PrismaClient();
  const stub = new StubTaxProvider();
  const testAccountId = `acc_smoke_phase_5_${Date.now()}`;

  await prisma.cantilapayAccount.deleteMany({
    where: { accountId: { startsWith: "acc_smoke_phase_5_" } },
  });

  try {
    const account = await enableForTenant(prisma, {
      accountId: testAccountId,
      country: "USA",
    });
    const calc = await calculateTax(prisma, stub, {
      cantilapayAccountId: account.id,
      mode: "test",
      amount: 5000,
      currency: "usd",
      customerCountry: "USA",
      customerState: "CA",
      customerPostalCode: "94110",
      productCategory: "saas",
    });
    check(calc.taxAmount === 0, "calc persists stub tax = 0");
    check(calc.provider === "stub", "calc carries provider label");
    check(calc.customerCountry === "USA", "calc echoes customer country");
    const fetched = await getTaxCalculation(prisma, {
      cantilapayAccountId: account.id,
      mode: "test",
      id: calc.id,
    });
    check(fetched?.id === calc.id, "calc round-trips by id");
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
  console.log("=== Cantilapay Phase 5 smoke test ===");
  await partA();
  await partB();
  console.log("=== Phase 5 smoke test ===");
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
