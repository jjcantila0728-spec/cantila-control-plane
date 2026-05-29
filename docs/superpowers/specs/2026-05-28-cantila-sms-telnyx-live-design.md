# Cantila SMS — Telnyx live adapter (1st-level infrastructure)

**Date:** 2026-05-28
**Status:** Design — pending user review
**Plan refs:** §4.5 (first-party telephony), §17.3 (Telnyx verdict), §21 (build spec)

## Goal

Make Cantila SMS actually deliver. Today the `TelephonyProvider` port
resolves to `StubTelephonyProvider` — an in-process fake that accepts every
send and rolls outcomes with `Math.random()`; nothing leaves the box. This
design adds the real carrier path so that the moment a Telnyx API key is
present, outbound SMS and number provisioning work against live carriers,
with **Philippines (+63) and USA (+1)** as the primary enabled markets.

Cantila stays a Twilio/Telnyx-style **product** provider: it owns the API,
number inventory, OTP engine, conversation threading, rate limiting,
billing, and activity log. Telnyx owns the regulated carrier path. The
control plane never speaks SMPP/SS7/SIP — every op goes through the
`TelephonyProvider` port.

## Scope

**In scope (1st level):**
- Live Telnyx adapter for: number search / provision / release / port-in,
  outbound `sendSms`, inbound SMS parsing + SMS status parsing (with
  webhook signature verification), and A2P/10DLC campaign registration.
- Env-gated factory so the port auto-selects Telnyx when credentials exist
  and falls back to the stub otherwise (same pattern as Mail / Stripe / AI).
- A **soft compliance gate**: registration-blocked sends fail gracefully
  with `sms_compliance_required`, never a crash and never a silent drop.
- E.164 validation with PH (+63) and US (+1) primary-enabled.

**Out of scope (deferred, not faked):**
- Voice (`placeCall`, inbound-call / call-status parsing). The live adapter
  throws a clear "voice not enabled in the live adapter yet" error rather
  than returning fake success, so a caller never believes a call placed.
- Bulk/scheduled send orchestration, templates, business-hours routing,
  per-number inbound-rule tables — these are existing/future control-plane
  concerns, untouched here.
- Carrier-reputation nightly scraping (plan §21.9 — Phase 3+).

## Why Telnyx behind the existing port

Alternatives considered:

1. **Telnyx behind the `TelephonyProvider` port (chosen).** Matches plan
   §17.3/§21. One adapter covers both PH and US, plus numbers and A2P. The
   port is already wired through the entire control plane (`cp.sendSms`,
   inbound/status webhooks, marketplace, OTP), so this is purely a new
   adapter + factory — no call-site churn.
2. **Cantila as its own carrier (own SMPP/SS7).** Multi-quarter telco build.
   Not 1st-level infrastructure. Rejected.
3. **Local PH aggregator (Semaphore/Movider).** Cheapest for PH-only OTP,
   but no number leasing / US path / unified surface — doesn't match the
   "full-service like Twilio/Telnyx, all countries" goal. Rejected as the
   primary, kept available as a future port adapter if PH economics demand.

The port boundary keeps Twilio or Bandwidth a later one-file swap.

## Architecture

```
control plane ──> TelephonyProvider port ──> TelnyxTelephonyProvider
   (unchanged)        (unchanged)               src/sms/telnyx.ts   (NEW)
                          │                          │ HTTPS REST
                          │                          ▼  api.telnyx.com/v2
                          └── createTelephonyProvider()  ── Telnyx
                              TELNYX_API_KEY present? ──┘   (carrier path)
                                  no → StubTelephonyProvider
```

### New: `src/sms/telnyx.ts`

`TelnyxTelephonyProvider implements TelephonyProvider`. `label = "Telnyx"`,
`live = true`. A thin REST client (Bearer `TELNYX_API_KEY`) maps each port
method to Telnyx v2 endpoints:

| Port method                | Telnyx endpoint                                   |
|----------------------------|---------------------------------------------------|
| `searchAvailableNumbers`   | `GET /available_phone_numbers`                    |
| `provisionNumber`          | `POST /number_orders` (+ messaging-profile assign)|
| `releaseNumber`            | `DELETE /phone_numbers/{id}`                       |
| `portInNumber`             | `POST /porting_orders`                            |
| `sendSms`                  | `POST /messages`                                  |
| `parseInboundSms`          | verify `Telnyx-Signature-Ed25519` + normalize     |
| `parseSmsStatus`           | verify signature + normalize                       |
| `registerA2pCampaign`      | `POST /10dlc/campaigns` (brand first)             |
| `placeCall` / call parsers | throw `voice_not_enabled` (deferred)              |

Webhook verification uses `TELNYX_PUBLIC_KEY` (Ed25519) over
`Telnyx-Timestamp` + raw body; a bad signature throws, exactly as the port
contract requires. Number-search results return Telnyx wholesale prices;
the control plane re-prices through the existing pricebook, unchanged.

### Changed: `src/sms/provider.ts`

Replace the hardcoded `export const telephonyProvider = new
StubTelephonyProvider()` with a factory mirroring `createMailProvider()`:

```ts
export function createTelephonyProvider(): TelephonyProvider {
  if (process.env.TELNYX_API_KEY) {
    return new TelnyxTelephonyProvider({
      apiKey: process.env.TELNYX_API_KEY,
      publicKey: process.env.TELNYX_PUBLIC_KEY,
      messagingProfileId: process.env.TELNYX_MESSAGING_PROFILE_ID,
    });
  }
  return new StubTelephonyProvider();
}
export const telephonyProvider: TelephonyProvider = createTelephonyProvider();
```

The stub stays the offline default, so all existing tests pass unchanged.

## Compliance — the "soft gate"

There is no code-level way to bypass carrier compliance: A2P/10DLC (US) and
sender-ID/SIM rules (PH) are enforced downstream by carriers, not inside
Cantila. Unregistered US A2P traffic is filtered by US carriers regardless
of our code. So instead of pretending, we make the gate soft:

- **Stub/dev:** everything flows. No carrier, no regulator.
- **Live, allowed paths:** US toll-free/P2P and the PH routes the carrier
  permits send normally.
- **Live, blocked paths:** when Telnyx rejects for missing registration, the
  control plane returns `code: "sms_compliance_required"` with a deeplink to
  the Console compliance page — a clean error, surfaced to the caller, never
  an exception or a silent drop.

A `SMS_COMPLIANCE_MODE` env setting (`enforce` default) lets non-production
environments relax this for testing. The existing `cp.sendSms` already
returns `{ error }` shapes, so this slots into the current contract.

## Data flow (outbound send, live)

1. `POST /v1/projects/:id/sms/send` → `cp.sendSms(projectId, {to, body})`.
2. `cp.sendSms` resolves the project's number, validates `to` is E.164,
   enforces the per-project rate cap (existing), records a `sent` event.
3. `telephonyProvider.sendSms` → Telnyx `POST /messages`. Returns
   `{providerMessageId, accepted}`.
4. Because `telephonyProvider.live === true`, the outcome stays `sent` — the
   terminal state (delivered/failed/undelivered) arrives later via the
   status webhook (`cp.receiveSmsStatus`, already wired).
5. Telnyx hard-reject or compliance-block → mapped to `accepted: false` /
   `sms_compliance_required`; recorded as `failed`, returned as an error.

Inbound SMS and status webhooks already route through the port's `parse*`
methods (`index.ts` routes exist); the Telnyx adapter just makes those
parsers real (signature verify + normalize).

## Error handling

- **Missing/invalid credentials at startup:** factory falls back to stub
  only when `TELNYX_API_KEY` is absent. If the key is present but Telnyx
  rejects auth at call time, the call returns a typed error — no crash.
- **Network/5xx from Telnyx:** surfaced as `accepted: false` with the
  Telnyx error code attached; the send is recorded `failed`.
- **Bad webhook signature:** `parse*` throws (port contract); the route
  returns 400.
- **Voice methods:** throw `voice_not_enabled` — explicit, never fake
  success.

## Testing

- **Stub path unchanged:** all existing SMS tests run against the stub with
  no env vars — must stay green.
- **Telnyx adapter unit tests:** mock the REST client; assert each port
  method builds the right request and normalizes the response. Assert
  signature verification rejects a tampered body and accepts a valid one
  (fixture key pair). Assert voice methods throw `voice_not_enabled`.
- **Factory test:** `TELNYX_API_KEY` set → instance is `TelnyxTelephonyProvider`
  / `live === true`; unset → stub.
- **Compliance test:** a simulated registration-block response maps to
  `sms_compliance_required`, not an exception.
- No live Telnyx calls in the test suite; real delivery is verified manually
  once a key is set.

## Cutover (what makes it actually send)

Landing this code needs **no carrier account**. To go live you (the user)
provide:
1. A Telnyx account + `TELNYX_API_KEY`, `TELNYX_PUBLIC_KEY`,
   `TELNYX_MESSAGING_PROFILE_ID`.
2. For US A2P at scale: brand + campaign registration via the Console flow
   the adapter drives. PH/US-toll-free/P2P paths work without it.

No code change at cutover — the factory flips on env var presence.
