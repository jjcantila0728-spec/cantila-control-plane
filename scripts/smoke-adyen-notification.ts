import { createHmac } from "node:crypto";
import { parseAdyenNotification } from "../src/cantilapay/adapters/adyen-impl/webhooks";

let failed = 0;
function check(c: unknown, label: string): void {
  if (c) console.log(`✓ ${label}`);
  else { failed++; console.error(`✗ ${label}`); }
}

const hmacKeyHex = "DEADBEEF".repeat(8); // 32 bytes
const buildItem = (overrides: Record<string, unknown> = {}) => ({
  eventCode: "AUTHORISATION",
  pspReference: "PSP1",
  originalReference: "",
  merchantAccountCode: "CantilaplatformTEST",
  merchantReference: "pi_test_1",
  amount: { value: 1000, currency: "USD" },
  success: "true",
  additionalData: {} as Record<string, string>,
  ...overrides,
});

function signItem(item: ReturnType<typeof buildItem>): typeof item {
  const fields = [
    item.pspReference ?? "",
    item.originalReference ?? "",
    item.merchantAccountCode ?? "",
    item.merchantReference ?? "",
    String(item.amount?.value ?? ""),
    item.amount?.currency ?? "",
    item.eventCode ?? "",
    item.success ?? "",
  ];
  const signed = fields.map((f) => f.replace(/\\/g, "\\\\").replace(/:/g, "\\:")).join(":");
  const sig = createHmac("sha256", Buffer.from(hmacKeyHex, "hex")).update(signed).digest("base64");
  item.additionalData!.hmacSignature = sig;
  return item;
}

const goodItem = signItem(buildItem());
const envelope = JSON.stringify({
  live: "false",
  notificationItems: [{ NotificationRequestItem: goodItem }],
});
const events = parseAdyenNotification({ rawBody: envelope, hmacKeyHex });
check(events.length === 1, "valid HMAC item emits one event");
check(events[0].type === "payment_intent.captured", "AUTHORISATION success → payment_intent.captured");
check(events[0].pspPaymentRef === "PSP1", "pspPaymentRef carries through");

// Bad HMAC
const badItem = buildItem();
badItem.additionalData!.hmacSignature = "wrongsig";
const badEnvelope = JSON.stringify({
  notificationItems: [{ NotificationRequestItem: badItem }],
});
const dropped = parseAdyenNotification({ rawBody: badEnvelope, hmacKeyHex });
check(dropped.length === 0, "bad HMAC item is dropped");

// Refused authorisation
const refused = signItem(buildItem({ success: "false", reason: "Refused" }));
const refusedEnvelope = JSON.stringify({
  notificationItems: [{ NotificationRequestItem: refused }],
});
const refusedEvents = parseAdyenNotification({ rawBody: refusedEnvelope, hmacKeyHex });
check(refusedEvents[0]?.type === "payment_intent.failed", "AUTHORISATION success=false → payment_intent.failed");

process.exit(failed === 0 ? 0 : 1);
