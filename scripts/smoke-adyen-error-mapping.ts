import { mapAdyenRefusalReason } from "../src/cantilapay/adapters/adyen-impl/error-mapping";

let failed = 0;
function check(condition: unknown, label: string): void {
  if (condition) console.log(`✓ ${label}`);
  else { failed++; console.error(`✗ ${label}`); }
}

const insufficient = mapAdyenRefusalReason({ refusalReasonCode: "12" });
check(insufficient.declineCode === "insufficient_funds", "code 12 → insufficient_funds");

const byReason = mapAdyenRefusalReason({ refusalReason: "Expired Card" });
check(byReason.declineCode === "expired_card", "reason 'Expired Card' → expired_card");

const unknown = mapAdyenRefusalReason({ refusalReason: "Weird reason" });
check(unknown.declineCode === "generic_decline", "unknown → generic_decline fallback");
check(unknown.message === "Weird reason", "unknown carries Adyen message through");

process.exit(failed === 0 ? 0 : 1);
