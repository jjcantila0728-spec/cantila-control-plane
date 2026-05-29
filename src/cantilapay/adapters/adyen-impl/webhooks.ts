/* ============================================================
   Adyen Notification webhook — per-item HMAC verification.

   Adyen posts a JSON envelope:

     {
       "live": "false",
       "notificationItems": [
         {
           "NotificationRequestItem": {
             "eventCode": "AUTHORISATION",
             "pspReference": "...",
             "merchantReference": "...",
             "amount": { "currency": "EUR", "value": 1000 },
             "success": "true",
             "additionalData": { "hmacSignature": "..." },
             ...
           }
         },
         ...
       ]
     }

   Each item's hmacSignature is HMAC-SHA256(hexKey, signedData) where
   signedData = "<pspReference>:<originalReference>:<merchantAccountCode>:<merchantReference>:<value>:<currency>:<eventCode>:<success>"

   We verify per item, drop items whose signature doesn't match, and
   emit one PspInboundEvent per valid item.
   ============================================================ */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { PspInboundEvent } from "../port";

interface AdyenNotificationItem {
  eventCode?: string;
  pspReference?: string;
  originalReference?: string;
  merchantAccountCode?: string;
  merchantReference?: string;
  amount?: { value?: number; currency?: string };
  success?: string;
  reason?: string;
  additionalData?: Record<string, string>;
  [k: string]: unknown;
}

interface AdyenNotificationEnvelope {
  live?: string;
  notificationItems?: Array<{ NotificationRequestItem?: AdyenNotificationItem }>;
}

function signedPayload(item: AdyenNotificationItem): string {
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
  // Escape colons and backslashes per Adyen spec
  return fields.map((f) => f.replace(/\\/g, "\\\\").replace(/:/g, "\\:")).join(":");
}

function verifyItemHmac(item: AdyenNotificationItem, hmacKeyHex: string): boolean {
  const presented = item.additionalData?.hmacSignature;
  if (!presented) return false;
  const expected = createHmac("sha256", Buffer.from(hmacKeyHex, "hex"))
    .update(signedPayload(item))
    .digest("base64");
  // Adyen sends base64; do a constant-time compare
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(presented), Buffer.from(expected));
}

function mapEventCode(item: AdyenNotificationItem): PspInboundEvent["type"] | null {
  const success = item.success === "true";
  switch (item.eventCode) {
    case "AUTHORISATION":
      // Synchronous /payments already settled the cantilapay state;
      // we mostly use AUTHORISATION webhook for async retries. Map
      // success → captured (when not delayed) or failed.
      return success ? "payment_intent.captured" : "payment_intent.failed";
    case "CAPTURE":
      return success ? "payment_intent.captured" : "payment_intent.failed";
    case "CAPTURE_FAILED":
      return "payment_intent.failed";
    case "REFUND":
      return success ? "payment_intent.refunded" : "payment_intent.failed";
    case "REFUND_FAILED":
      return "payment_intent.failed";
    case "ACCOUNT_HOLDER_VERIFICATION":
    case "ACCOUNT_HOLDER_STATUS_CHANGE":
    case "LEGAL_ENTITY_UPDATED":
      return "account.updated";
    case "REPORT_AVAILABLE":
    case "PING":
      return "ping";
    default:
      return null;
  }
}

/** Parse + verify an Adyen notification envelope. Returns one
 *  PspInboundEvent per valid item; drops items with bad HMAC or
 *  unhandled eventCode (with a console warn). */
export function parseAdyenNotification(args: {
  rawBody: string;
  hmacKeyHex: string;
}): PspInboundEvent[] {
  let parsed: AdyenNotificationEnvelope;
  try {
    parsed = JSON.parse(args.rawBody) as AdyenNotificationEnvelope;
  } catch {
    throw new Error("inbound webhook body is not valid JSON");
  }
  const items = parsed.notificationItems ?? [];
  const out: PspInboundEvent[] = [];
  for (const wrap of items) {
    const item = wrap.NotificationRequestItem;
    if (!item) continue;
    if (!verifyItemHmac(item, args.hmacKeyHex)) {
      console.warn("[cantilapay] dropped Adyen notification: bad HMAC", {
        eventCode: item.eventCode,
        pspReference: item.pspReference,
      });
      continue;
    }
    const type = mapEventCode(item);
    if (!type) continue;
    // Sub-merchant detection: for LEM events Adyen surfaces the
    // legal-entity id on additionalData.legalEntityId.
    const subMerchantId =
      type === "account.updated"
        ? item.additionalData?.legalEntityId ?? null
        : null;
    const pspPaymentRef =
      item.eventCode === "AUTHORISATION" ||
      item.eventCode === "CAPTURE" ||
      item.eventCode === "CAPTURE_FAILED"
        ? item.pspReference
        : item.originalReference;
    out.push({
      id: item.pspReference ?? `evt_${Date.now()}`,
      type,
      subMerchantId,
      pspPaymentRef,
      raw: item,
    });
  }
  return out;
}
