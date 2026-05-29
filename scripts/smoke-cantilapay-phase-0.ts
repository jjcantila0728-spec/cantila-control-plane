/* ============================================================
   Cantilapay — Phase 0 smoke test (plan §25).

   Exercises every PURE-LOGIC primitive Phase 0 ships, end-to-end,
   against the stub adapter. No database, no Adyen, no network —
   the goal is to prove the foundation works offline before we
   wire Postgres in CI / staging.

   Run: `npx tsx scripts/smoke-cantilapay-phase-0.ts`

   What it covers:
     1. StubPaymentProcessor: create + get sub-merchant, mint
        onboarding link.
     2. Inbound-webhook signature roundtrip (sign for test → parse).
     3. selectPaymentProcessor: env-gated picks stub by default.
     4. inferKeyShape: parses each of the 4 valid prefixes + rejects
        garbage.
     5. signOutbound / verifyOutbound: HMAC roundtrip + tolerance.
     6. CantilapayError factories carry the right (status, type, code).
     7. Idempotency (InMemoryStore): first call computes; replay
        returns cached body; same-key-different-body errors.

   Exits 0 on success, 1 on first failure (with the assertion path).
   ============================================================ */

import { StubPaymentProcessor } from "../src/cantilapay/adapters/stub";
import type { PaymentProcessor } from "../src/cantilapay/adapters/port";
import { selectPaymentProcessor } from "../src/cantilapay/adapters";
import { inferKeyShape } from "../src/cantilapay/types";
import {
  signOutbound,
  verifyOutbound,
} from "../src/cantilapay/services/webhooks-out";
import {
  InMemoryIdempotencyStore,
  withIdempotency,
  IdempotencyBodyMismatchError,
} from "../src/cantilapay/services/idempotency";
import { CantilapayError } from "../src/cantilapay/errors";

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

async function main(): Promise<void> {
  console.log("--- Cantilapay Phase 0 smoke test ---");

  // 1. StubPaymentProcessor — sub-merchant + onboarding link.
  const stub = new StubPaymentProcessor();
  const sub = await stub.createSubMerchant({
    country: "USA",
    externalRef: "cpa_smoke_1",
    mode: "test",
  });
  check(sub.id.startsWith("le_stub_"), "stub createSubMerchant mints le_stub_ id", sub);
  check(sub.status === "pending_kyc", "new sub-merchant starts pending_kyc");
  check(!!sub.onboardingLink, "new sub-merchant has an onboarding link");

  const fetched = await stub.getSubMerchant({ id: sub.id, mode: "test" });
  check(
    fetched.status === "pending_kyc" || fetched.status === "active",
    "getSubMerchant returns deterministic status (pending or active)",
    fetched,
  );

  const link = await stub.createOnboardingLink({
    subMerchantId: sub.id,
    mode: "test",
    returnUrl: "https://tenant.example.com/cantilapay/done",
  });
  check(link.url.startsWith("https://"), "onboarding link is an https URL");
  check(!!Date.parse(link.expiresAt), "onboarding link has parseable expiresAt");

  // 2. Inbound webhook roundtrip — sign for test, then parse.
  const event = {
    id: "evt_smoke_1",
    type: "ping" as const,
    subMerchantId: null,
    raw: { hello: "world" },
  };
  const signed = stub.signInboundForTest(event);
  const parsed = stub.parseInboundWebhook({
    rawBody: signed.rawBody,
    headers: { [signed.header.name]: signed.header.value },
  });
  check(parsed.length === 1, "stub inbound returns a one-element batch");
  check(parsed[0].id === event.id, "stub inbound roundtrip preserves event id");
  check(parsed[0].type === "ping", "stub inbound roundtrip preserves event type");

  // Tampered body → throws.
  let tamperedThrew = false;
  try {
    stub.parseInboundWebhook({
      rawBody: signed.rawBody + "tamper",
      headers: { [signed.header.name]: signed.header.value },
    });
  } catch {
    tamperedThrew = true;
  }
  check(tamperedThrew, "stub inbound rejects a tampered body");

  // 2b. Multi-item batch — an Adyen envelope can carry many
  // notificationItems. handleInboundWebhook must project EVERY one,
  // not just the first. Account-less (subMerchantId: null) events take
  // the no-DB path, so we can prove the loop without Postgres.
  const { handleInboundWebhook } = await import(
    "../src/cantilapay/services/webhooks-in"
  );
  const batchProcessor: PaymentProcessor = {
    ...stub,
    parseInboundWebhook: () => [
      { id: "evt_batch_a", type: "ping", subMerchantId: null, raw: {} },
      { id: "evt_batch_b", type: "ping", subMerchantId: null, raw: {} },
    ],
  };
  const batchOutcome = await handleInboundWebhook({
    prisma: {} as never,
    processor: batchProcessor,
    rawBody: "{}",
    headers: {},
    mode: "test",
  });
  check(batchOutcome.processed === 2, "batch envelope projects both items");
  check(batchOutcome.results.length === 2, "batch outcome carries per-item results");
  check(
    batchOutcome.results.every((r) => r.accepted),
    "every batched item is accepted",
  );

  // 3. selectPaymentProcessor — defaults to stub, picks Adyen when env present.
  const def = selectPaymentProcessor({});
  check(def.live === false, "selector with empty env returns the stub");
  check(def.label === "stub", "stub label is 'stub'");

  const live = selectPaymentProcessor({
    ADYEN_API_KEY: "k",
    ADYEN_HMAC_KEY: "deadbeef",
    ADYEN_MERCHANT_ACCOUNT: "cantilaplatform",
    ADYEN_ENVIRONMENT: "test",
  });
  check(live.live === true, "selector with Adyen env returns the live adapter");
  check(live.label.includes("Adyen for Platforms"), "live adapter labels as Adyen", live.label);

  // Prod guard — NODE_ENV=production + live without LIVE_ACK throws.
  let prodGuardTripped = false;
  try {
    selectPaymentProcessor({
      ADYEN_API_KEY: "k",
      ADYEN_HMAC_KEY: "deadbeef",
      ADYEN_MERCHANT_ACCOUNT: "cantilaplatform",
      ADYEN_ENVIRONMENT: "live",
      NODE_ENV: "production",
    });
  } catch (err) {
    prodGuardTripped =
      err instanceof CantilapayError &&
      err.body.code === "live_mode_not_acknowledged";
  }
  check(prodGuardTripped, "prod guard rejects live without CANTILAPAY_LIVE_ACK");

  // 4. inferKeyShape — recognises each valid prefix.
  const shapes = [
    { raw: "cpk_test_abc", kind: "publishable", mode: "test" },
    { raw: "cpk_live_abc", kind: "publishable", mode: "live" },
    { raw: "csk_test_abc", kind: "secret", mode: "test" },
    { raw: "csk_live_abc", kind: "secret", mode: "live" },
  ] as const;
  for (const sh of shapes) {
    const got = inferKeyShape(sh.raw);
    check(
      got?.kind === sh.kind && got?.mode === sh.mode,
      `inferKeyShape: ${sh.raw} → (${sh.kind}, ${sh.mode})`,
      got,
    );
  }
  check(inferKeyShape("ctk_admin_abc") === null, "inferKeyShape rejects ctk_ (Cantila admin key)");
  check(inferKeyShape("garbage") === null, "inferKeyShape rejects malformed token");

  // 5. signOutbound + verifyOutbound roundtrip.
  const secret = "whsec_smoke_outbound";
  const body = JSON.stringify({ id: "evt_out_1", type: "test.event" });
  const sigHeader = signOutbound(body, secret);
  check(
    verifyOutbound({ rawBody: body, signatureHeader: sigHeader, secret }),
    "verifyOutbound accepts a correctly signed body",
  );
  check(
    !verifyOutbound({
      rawBody: body + "tamper",
      signatureHeader: sigHeader,
      secret,
    }),
    "verifyOutbound rejects a tampered body",
  );
  check(
    !verifyOutbound({
      rawBody: body,
      signatureHeader: sigHeader,
      secret: "wrong",
    }),
    "verifyOutbound rejects a wrong secret",
  );

  // 6. CantilapayError factories.
  check(CantilapayError.missingKey().status === 401, "missingKey is 401");
  check(CantilapayError.invalidKey().body.type === "authentication_error", "invalidKey is authentication_error");
  check(CantilapayError.kindMismatch().status === 403, "kindMismatch is 403");
  check(CantilapayError.notFound("x").status === 404, "notFound is 404");
  check(CantilapayError.invalidField("nope").status === 400, "invalidField is 400");
  check(CantilapayError.idempotencyBodyMismatch().body.code === "idempotency_body_mismatch", "idempotency code");

  // 7. Idempotency replay + body-mismatch.
  const store = new InMemoryIdempotencyStore();
  let computeCount = 0;
  const compute = async () => {
    computeCount += 1;
    return { status: 201, body: { ok: true, id: `pi_${computeCount}` } };
  };
  const first = await withIdempotency({
    store,
    cantilapayAccountId: "cpa_1",
    mode: "test",
    key: "idem-1",
    bodyForHash: JSON.stringify({ amount: 100 }),
    compute,
  });
  check(first.replayed === false && computeCount === 1, "first call computes");
  check(first.result.status === 201, "first call returns 201");

  const second = await withIdempotency({
    store,
    cantilapayAccountId: "cpa_1",
    mode: "test",
    key: "idem-1",
    bodyForHash: JSON.stringify({ amount: 100 }),
    compute,
  });
  check(second.replayed === true && computeCount === 1, "retry replays cached body");
  check(
    JSON.stringify(second.result.body) === JSON.stringify(first.result.body),
    "replayed body matches original",
  );

  let mismatchedThrew = false;
  try {
    await withIdempotency({
      store,
      cantilapayAccountId: "cpa_1",
      mode: "test",
      key: "idem-1",
      bodyForHash: JSON.stringify({ amount: 999 }),
      compute,
    });
  } catch (err) {
    mismatchedThrew = err instanceof IdempotencyBodyMismatchError;
  }
  check(mismatchedThrew, "same key + different body throws IdempotencyBodyMismatchError");

  // Mode partition — same key in live mode is independent.
  const liveCall = await withIdempotency({
    store,
    cantilapayAccountId: "cpa_1",
    mode: "live",
    key: "idem-1",
    bodyForHash: JSON.stringify({ amount: 200 }),
    compute,
  });
  check(liveCall.replayed === false, "test and live idempotency keyspaces are separate");

  console.log("--- Phase 0 smoke test ---");
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
