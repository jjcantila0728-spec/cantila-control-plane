# Cantila telephony — Telnyx live adapter, full surface + AI voice agents

**Date:** 2026-05-28
**Status:** Design — pending user review
**Plan refs:** §4.5 (first-party telephony), §17.3 (Telnyx verdict), §21 (build spec)

## Goal

Make Cantila telephony actually work, maximizing Telnyx's capabilities.
Today the `TelephonyProvider` port resolves to `StubTelephonyProvider` — an
in-process fake that accepts every send/call and rolls outcomes with
`Math.random()`; nothing leaves the box. This design adds the real carrier
path so that the moment Telnyx credentials are present, Cantila can:

- send/receive **SMS** (MMS-ready),
- **provision and port numbers**,
- place/receive **voice calls** with programmable routing, and
- **deploy AI voice agents** that answer and place calls.

Primary enabled markets: **Philippines (+63) and USA (+1)**; other countries
allowed and flagged for later plan-gating.

Cantila stays a Twilio/Telnyx-style **product** provider: it owns the API,
number inventory, OTP engine, conversation threading, voice-agent config,
rate limiting, billing, and activity log. Telnyx owns the regulated carrier
path and the real-time voice-AI media pipeline. The control plane never
speaks SMPP/SS7/SIP — every op goes through the `TelephonyProvider` port.

## Scope

**In scope (maximized Telnyx surface):**
- **Messaging:** `sendSms`, inbound SMS parsing + SMS status parsing, with
  Ed25519 webhook signature verification.
- **Numbers:** search / provision / release / port-in.
- **Voice (Call Control):** `placeCall`, inbound-call parsing, call-status
  parsing, and the four `CallRouting` actions (forward / voicemail / reject /
  app_webhook) — un-deferred from the prior draft.
- **AI voice agents (new):** create / update / delete a voice agent, attach
  it to a Cantila number, and bind tool-webhooks into the tenant's app —
  running on **Telnyx AI Assistants** (real-time STT→LLM→TTS).
- **A2P/10DLC** campaign + brand registration.
- Env-gated factory: Telnyx when credentials exist, stub otherwise (same
  pattern as Mail / Stripe / AI).
- A **soft compliance gate**: registration-blocked sends fail gracefully
  with `sms_compliance_required`, never a crash, never a silent drop.

**Out of scope (deferred, not faked):**
- Cantila-Claude-powered voice runtime (Call Control + media streaming to
  the in-house brain). The port boundary keeps this a later swap; for now
  Telnyx AI Assistants is the agent runtime.
- Bulk/scheduled send orchestration, SMS templates, per-number business-hours
  / inbound-rule tables — existing/future control-plane concerns, untouched.
- Telnyx Verify (Cantila keeps its own OTP engine), Fax, SIP trunking,
  WhatsApp/RCS — YAGNI for this pass.
- Carrier-reputation nightly scraping (plan §21.9 — Phase 3+).

## Why Telnyx behind the existing port

1. **Telnyx behind the `TelephonyProvider` port (chosen).** Matches plan
   §17.3/§21. One adapter covers PH + US, numbers, voice, A2P, **and** voice
   AI. The port is already wired through the control plane (`cp.sendSms`,
   inbound/status webhooks, marketplace, OTP, the `app_webhook` voice
   routing), so this is a new adapter + factory + a `VoiceAgent` port
   extension — minimal call-site churn.
2. **Cantila as its own carrier (own SMPP/SS7/SIP).** Multi-quarter telco
   build. Not 1st-level. Rejected.
3. **Local PH aggregator (Semaphore/Movider).** No numbers/voice/voice-AI —
   doesn't match the full-service goal. Rejected as primary.

The port boundary keeps Twilio/Bandwidth a later one-file swap, and keeps a
Cantila-Claude voice runtime swappable behind the same `VoiceAgent` methods.

## Voice agents — runtime choice

**Chosen: Telnyx-managed AI Assistants.** Telnyx hosts the real-time agent
(speech recognition, the LLM turn, text-to-speech, barge-in) with sub-second
latency. Cantila owns the product surface: agent config, number binding,
tool/webhook wiring into the tenant app, transcript capture, billing.
"Deploy a voice agent" = a tenant creates an agent via Cantila's API and
binds it to a Cantila number; inbound calls to that number are answered by
the agent, and the agent can place outbound calls.

**Deferred alternative: Cantila-Claude via Call Control + Media Streaming.**
Bridges Telnyx audio over WebSocket to Cantila's own Claude brain — maximum
control, reuses the existing AI layer, but a heavy real-time audio build
(media streaming, STT, TTS, barge-in, latency tuning). The `VoiceAgent` port
methods are defined so this becomes a runtime swap, not a redesign.

## Architecture

```
control plane ──> TelephonyProvider port ──> TelnyxTelephonyProvider
   (unchanged)     (+ VoiceAgent ext.)          src/sms/telnyx.ts   (NEW)
                          │                          │ HTTPS REST
                          │                          ▼  api.telnyx.com/v2
                          └── createTelephonyProvider()  ── Telnyx
                              TELNYX_API_KEY present? ──┘   carrier path +
                                  no → StubTelephonyProvider  Voice AI
```

### New: `src/sms/telnyx.ts`

`TelnyxTelephonyProvider implements TelephonyProvider`. `label = "Telnyx"`,
`live = true`. A thin REST client (Bearer `TELNYX_API_KEY`) maps each port
method to Telnyx v2 endpoints:

| Port method                | Telnyx surface                                      |
|----------------------------|-----------------------------------------------------|
| `searchAvailableNumbers`   | `GET /available_phone_numbers`                      |
| `provisionNumber`          | `POST /number_orders` (+ messaging-profile assign)  |
| `releaseNumber`            | `DELETE /phone_numbers/{id}`                         |
| `portInNumber`             | `POST /porting_orders`                              |
| `sendSms`                  | `POST /messages`                                    |
| `placeCall`                | `POST /calls` (Call Control)                        |
| `parseInboundSms`          | verify `Telnyx-Signature-Ed25519` + normalize       |
| `parseSmsStatus`           | verify signature + normalize                         |
| `parseInboundCall`         | verify signature + normalize Call Control event      |
| `parseCallStatus`          | verify signature + normalize                         |
| `registerA2pCampaign`      | `POST /10dlc/campaigns` (brand first)               |
| **VoiceAgent extension**   |                                                     |
| `createVoiceAgent`         | `POST /ai/assistants`                               |
| `updateVoiceAgent`         | `POST /ai/assistants/{id}`                          |
| `deleteVoiceAgent`         | `DELETE /ai/assistants/{id}`                        |
| `attachAgentToNumber`      | assign assistant in the number's voice settings      |
| `parseAgentEvent`          | verify signature + normalize agent/tool webhook      |

Exact AI-Assistant request fields (instructions, voice, model, tools/webhooks,
greeting, transcription) are pinned against the live Telnyx schema during
implementation; the port shapes below stay carrier-neutral.

### Port extension: `VoiceAgent` (in `src/sms/provider.ts`)

New carrier-neutral shapes added to the port, all implemented by both the
stub (deterministic) and Telnyx:

```ts
export interface VoiceAgentConfig {
  name: string;
  instructions: string;     // system prompt for the agent
  voice?: string;           // TTS voice id; provider default if unset
  greeting?: string;        // spoken on answer
  tools?: VoiceAgentTool[]; // webhook tools the agent may call
}
export interface VoiceAgentTool {
  name: string;
  description: string;
  webhookUrl: string;       // tenant app endpoint, signed per-project HMAC
}
export interface ProvisionedVoiceAgent { agentId: string; name: string; }
export interface VoiceAgentEvent {       // normalized agent/tool webhook
  agentId: string;
  callId: string;
  kind: "tool_call" | "transcript" | "ended";
  toolName?: string;
  payload?: Record<string, unknown>;
  at: string;
}
```

Port methods: `createVoiceAgent`, `updateVoiceAgent`, `deleteVoiceAgent`,
`attachAgentToNumber({ agentId, e164 })`, `parseAgentEvent(rawBody, headers)`.

### Changed: `src/sms/provider.ts`

Replace the hardcoded singleton with a factory mirroring
`createMailProvider()`:

```ts
export function createTelephonyProvider(): TelephonyProvider {
  if (process.env.TELNYX_API_KEY) {
    return new TelnyxTelephonyProvider({
      apiKey: process.env.TELNYX_API_KEY,
      publicKey: process.env.TELNYX_PUBLIC_KEY,
      messagingProfileId: process.env.TELNYX_MESSAGING_PROFILE_ID,
      voiceConnectionId: process.env.TELNYX_VOICE_CONNECTION_ID,
    });
  }
  return new StubTelephonyProvider();
}
export const telephonyProvider: TelephonyProvider = createTelephonyProvider();
```

`StubTelephonyProvider` gains deterministic implementations of the new
`VoiceAgent` methods, so all existing tests pass unchanged and voice-agent
flows are exercisable offline.

### Control plane + routes

- `cp` gains thin wrappers: `createVoiceAgent`, `updateVoiceAgent`,
  `deleteVoiceAgent`, `attachVoiceAgent`, and `receiveAgentEvent` (records a
  transcript/tool-call event, forwards tool calls to the tenant webhook).
- New routes in `index.ts`: voice-agent CRUD under
  `/v1/projects/:id/voice/agents`, agent binding under
  `…/voice/agents/:agentId/attach`, and a carrier-called agent-event webhook
  `/v1/voice/webhook/telnyx/agent` (auth-exempt; signature verified in the
  port, mirroring the existing SMS/voice webhook routes).

## Compliance — the "soft gate"

There is no code-level way to bypass carrier compliance: A2P/10DLC (US) and
sender-ID/SIM rules (PH) are enforced downstream by carriers, not inside
Cantila. So we make the gate soft, not absent:

- **Stub/dev:** everything flows.
- **Live, allowed paths:** US toll-free/P2P and the PH routes the carrier
  permits send normally; voice and voice-AI are not subject to A2P.
- **Live, blocked paths:** Telnyx registration rejects map to
  `code: "sms_compliance_required"` with a Console deeplink — a clean error,
  never an exception or silent drop.

`SMS_COMPLIANCE_MODE` (`enforce` default) lets non-prod relax the gate for
testing. `cp.sendSms` already returns `{ error }` shapes, so this slots into
the current contract.

## Data flow

**Outbound SMS (live):** `POST /v1/projects/:id/sms/send` → `cp.sendSms` →
validate E.164 + rate cap (existing) → record `sent` → `telephonyProvider.
sendSms` → Telnyx `POST /messages`. Because `live === true` the outcome stays
`sent`; the terminal state arrives via the status webhook (already wired).

**Inbound call → voice agent (live):** Telnyx posts the Call Control event to
`/v1/projects/:id/voice/inbound` → `parseInboundCall` (signature verified) →
per-number rule resolves to the bound agent → Telnyx AI Assistant answers.
Agent tool-calls/transcripts post to `/v1/voice/webhook/telnyx/agent` →
`parseAgentEvent` → `cp.receiveAgentEvent` logs and forwards tool calls to the
tenant webhook (per-project HMAC-signed).

**Outbound agent call:** `cp.placeCall` with routing → Telnyx `POST /calls`
dialing out under the agent's assistant.

## Error handling

- **Missing credentials:** factory falls back to stub only when
  `TELNYX_API_KEY` is absent. Key present but auth rejected at call time →
  typed error, no crash.
- **Network/5xx from Telnyx:** surfaced as `accepted: false` / typed error
  with the Telnyx code attached; send/call recorded `failed`.
- **Bad webhook signature:** every `parse*` throws (port contract); route
  returns 400.
- **Voice-agent provider errors** (assistant create/attach fails): typed
  error returned to the caller; no partial state left bound to a number
  (attach is rolled back if the assistant create succeeded but bind failed).

## Testing

- **Stub path unchanged:** all existing SMS/voice tests run against the stub
  with no env vars — must stay green.
- **Telnyx adapter unit tests:** mock the REST client; assert each port
  method (incl. voice + `VoiceAgent`) builds the right request and normalizes
  the response. Assert signature verification rejects a tampered body and
  accepts a valid one (fixture key pair).
- **VoiceAgent lifecycle test:** create → attach → event-parse →
  delete, against the stub; assert `receiveAgentEvent` forwards a tool call to
  the tenant webhook with a valid HMAC.
- **Factory test:** `TELNYX_API_KEY` set → `TelnyxTelephonyProvider` /
  `live === true`; unset → stub.
- **Compliance test:** simulated registration-block maps to
  `sms_compliance_required`, not an exception.
- No live Telnyx calls in the suite; real delivery/voice verified manually
  once credentials are set.

## Cutover (what makes it actually run)

Landing this code needs **no carrier account**. To go live you (the user)
provide:
1. A Telnyx account + `TELNYX_API_KEY`, `TELNYX_PUBLIC_KEY`,
   `TELNYX_MESSAGING_PROFILE_ID`, `TELNYX_VOICE_CONNECTION_ID`.
2. AI Assistants enabled on the Telnyx account (for voice agents).
3. For US A2P at scale: brand + campaign registration via the Console flow
   the adapter drives. PH / US-toll-free / P2P / voice / voice-AI work
   without 10DLC.

No code change at cutover — the factory flips on env-var presence.
