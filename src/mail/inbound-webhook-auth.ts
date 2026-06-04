/* ============================================================
   Inbound-mail webhook authentication.

   `POST /v1/projects/:id/mail/inbound` is the carrier-called seam the
   Mailcow→CP inbound bridge posts to. It's exempt from API-key auth (a
   mail bridge can't present a Cantila admin key — same posture as the
   Stripe / Adyen webhooks), so the credential is a shared secret the
   bridge presents in the `x-cantila-mail-secret` header. Without this
   check anyone who knows a project id could inject forged inbound mail
   (it gets routed to alias targets, persisted and recorded as events).

   Env-gated to preserve the offline flow: when MAIL_INBOUND_WEBHOOK_SECRET
   is unset the route stays open (dev/test), matching the rest of the
   platform's env-gated adapter pattern. Set the secret in any internet-
   reachable deployment and configure the Mailcow bridge to send it.
   ============================================================ */

import { timingSafeEqual } from "node:crypto";

/** Constant-time check that the presented webhook secret matches the
 *  configured one. Returns true (open) when no secret is configured, so
 *  the offline/dev flow is unchanged; otherwise requires an exact,
 *  length-safe, timing-safe match. */
export function verifyMailInboundSecret(
  presented: string | undefined,
  configured: string,
): boolean {
  if (!configured) return true; // not configured → open (dev/test)
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(configured);
  // timingSafeEqual throws on differing lengths — guard first so a
  // length difference is a normal "no match", not a 500.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
