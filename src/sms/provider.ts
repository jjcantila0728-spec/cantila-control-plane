/* ============================================================
   Telephony provider port (plan §4.5 — complete SMS & voice provider).

   Cantila SMS is a complete two-way telephony provider: it sends and
   receives both SMS and voice calls, provisions numbers, and handles
   carrier/regulatory onboarding. The control plane talks to the
   `TelephonyProvider` interface and never to a carrier API directly —
   the same adapter-port pattern `StripeAdapter`, `AiAnalyser` and
   `SsoProvider` use.

   Per plan §4.5: building an SMSC and a voice switch from scratch is a
   multi-quarter effort, so the recommended path is to stand the live
   provider on a carrier-grade messaging/voice aggregator (CPaaS
   interconnect) behind this port — Cantila owns the product surface
   (API, OTP engine, number inventory, conversation threading, webhooks,
   billing); the aggregator owns the regulated carrier path. The port
   boundary keeps the option open to bring more of the carrier stack
   in-house later with no call-site changes.

   STATUS — live adapter shipped (plan §21). `TelnyxTelephonyProvider`
   (in `./telnyx`) implements the full surface against the Telnyx v2 API
   — numbers, SMS, voice, A2P/10DLC, and AI voice agents (Telnyx AI
   Assistants). `createTelephonyProvider()` env-gates the selection:
   `TELNYX_API_KEY` present → Telnyx; absent → `StubTelephonyProvider`,
   which keeps the whole surface (including inbound-webhook shapes)
   testable offline and is the default for dev/test. The control plane,
   OTP engine, and the inbound SMS/voice/agent webhook routes are all
   wired through this port. Going live needs only the Telnyx credentials
   (`TELNYX_API_KEY`, `TELNYX_PUBLIC_KEY`, messaging-profile / voice-
   connection ids) — no code change. Compliance (A2P/10DLC, PH sender-id)
   is enforced by the carrier downstream; the control plane surfaces a
   graceful `sms_compliance_required` rather than bypassing it.
   ============================================================ */

import { TelnyxTelephonyProvider } from "./telnyx";

/* ---------- numbers ---------- */

// The number-type / capability vocabulary is shared with the number
// marketplace, so it lives in the domain layer; re-exported here so the
// port's consumers have a single import site.
export type { NumberType, NumberCapability } from "../domain/types";
import type { NumberType, NumberCapability } from "../domain/types";

/** A number a search turned up as available to lease. */
export interface AvailableNumber {
  e164: string;
  country: string;
  type: NumberType;
  capabilities: NumberCapability[];
  /** One-time setup fee in cents. */
  setupPriceCents: number;
  /** Monthly lease price in cents. */
  monthlyPriceCents: number;
}

/** A number leased to an account. */
export interface ProvisionedNumber {
  e164: string;
  country: string;
  type: NumberType;
  capabilities: NumberCapability[];
  /** Carrier-side id for the leased number — the handle for release,
   *  inbound-routing config and status callbacks. */
  providerId: string;
}

/* ---------- outbound ---------- */

/** Carrier hand-off result for an outbound SMS. `accepted` means the
 *  carrier queued it — the terminal delivery state arrives later as an
 *  `SmsStatusUpdate` webhook. */
export interface OutboundSmsResult {
  providerMessageId: string;
  accepted: boolean;
}

/** Carrier hand-off result for an outbound voice call. */
export interface OutboundCallResult {
  providerCallId: string;
  accepted: boolean;
}

/** What Cantila tells the carrier to do with a call — the routing
 *  decision returned for an inbound call, or set on an outbound one. */
export interface CallRouting {
  action: "forward" | "voicemail" | "reject" | "app_webhook";
  /** `forward` — destination E.164 or SIP URI. */
  destination?: string;
  /** `app_webhook` — the hosted-app endpoint that scripts the call
   *  (programmable voice / IVR). */
  webhookUrl?: string;
}

/* ---------- normalized inbound webhook shapes ----------
 *
 *  A real provider's `parse*` methods verify the carrier's webhook
 *  signature and translate its carrier-specific payload into these
 *  normalized shapes; every Cantila call site downstream sees only
 *  these, never a carrier's wire format. */

/** An inbound SMS, normalized from a carrier webhook. */
export interface InboundSmsMessage {
  providerMessageId: string;
  /** Sender, E.164. */
  from: string;
  /** The provisioned Cantila number it was sent to, E.164. */
  to: string;
  body: string;
  receivedAt: string;
  /** A recognised compliance keyword, when the body is one. */
  keyword?: "stop" | "start" | "help";
}

/** An inbound voice call, normalized from a carrier webhook. */
export interface InboundCall {
  providerCallId: string;
  from: string;
  to: string;
  receivedAt: string;
}

/** A delivery-status update for a previously-sent SMS. */
export interface SmsStatusUpdate {
  providerMessageId: string;
  status: "queued" | "sent" | "delivered" | "failed" | "undelivered";
  at: string;
}

/** A status update for a voice call, including voicemail. */
export interface CallStatusUpdate {
  providerCallId: string;
  status:
    | "ringing"
    | "in_progress"
    | "completed"
    | "busy"
    | "no_answer"
    | "voicemail"
    | "failed";
  /** Call duration in seconds, once completed. */
  durationSec?: number;
  /** Voicemail recording URL, when `status` is `voicemail`. */
  voicemailUrl?: string;
  at: string;
}

/* ---------- A2P / 10DLC registration ---------- */

/** The outcome of an A2P / 10DLC brand + campaign registration. */
export interface A2pRegistration {
  campaignId: string;
  status: "pending" | "approved" | "rejected";
}

/* ---------- AI voice agents ---------- */

/** A webhook tool the voice agent may invoke during a call. The agent
 *  calls out to the tenant app; the control plane signs the request with
 *  the project's HMAC secret. */
export interface VoiceAgentTool {
  name: string;
  description: string;
  webhookUrl: string;
}

/** Config for a deployable AI voice agent. */
export interface VoiceAgentConfig {
  name: string;
  /** System prompt that steers the agent. */
  instructions: string;
  /** TTS voice id; the provider default is used when unset. */
  voice?: string;
  /** Spoken when the agent answers. */
  greeting?: string;
  tools?: VoiceAgentTool[];
}

/** A provisioned voice agent the carrier now hosts. */
export interface ProvisionedVoiceAgent {
  agentId: string;
  name: string;
}

/** A normalized agent/tool webhook event. */
export interface VoiceAgentEvent {
  agentId: string;
  callId: string;
  kind: "tool_call" | "transcript" | "ended";
  toolName?: string;
  payload?: Record<string, unknown>;
  at: string;
}

/* ---------- the port ---------- */

export interface TelephonyProvider {
  /** Display label — "Stub telephony", "Carrier: <vendor>", … */
  readonly label: string;
  /** Whether this adapter talks to a real carrier/aggregator. */
  readonly live: boolean;

  /* --- number inventory --- */

  /** Search the carrier's inventory for leasable numbers. */
  searchAvailableNumbers(input: {
    country: string;
    type?: NumberType;
    capability?: NumberCapability;
    areaCode?: string;
  }): Promise<AvailableNumber[]>;

  /** Lease a number to the account. Auto-configures whatever Cantila
   *  controls — inbound routing, status callbacks, opt-out handling. */
  provisionNumber(input: {
    e164: string;
    country: string;
    type: NumberType;
    capabilities: NumberCapability[];
  }): Promise<ProvisionedNumber>;

  /** Release a leased number back to the carrier. */
  releaseNumber(input: { providerId: string }): Promise<void>;

  /** Initiate a port-in — move a number the account already owns at
   *  another carrier into Cantila. Returns the carrier-side port-order
   *  id. A real port completes asynchronously (days); the control plane
   *  tracks `porting` status until the carrier confirms. */
  portInNumber(input: {
    e164: string;
    country: string;
    type: NumberType;
    capabilities: NumberCapability[];
  }): Promise<{ providerId: string }>;

  /* --- outbound SMS --- */

  /** Hand one SMS to the carrier for delivery. Bulk / scheduled /
   *  templated sends are a control-plane concern that fan out into
   *  individual calls to this method. */
  sendSms(input: {
    from: string;
    to: string;
    body: string;
  }): Promise<OutboundSmsResult>;

  /* --- outbound voice --- */

  /** Place an outbound call from a provisioned number. */
  placeCall(input: {
    from: string;
    to: string;
    routing: CallRouting;
  }): Promise<OutboundCallResult>;

  /* --- inbound webhook parsing ---
   *  Each verifies the carrier's signature and normalizes the payload;
   *  throws on an invalid signature or unparseable body. */

  parseInboundSms(
    rawBody: string,
    headers: Record<string, string>,
  ): InboundSmsMessage;

  parseInboundCall(
    rawBody: string,
    headers: Record<string, string>,
  ): InboundCall;

  parseSmsStatus(
    rawBody: string,
    headers: Record<string, string>,
  ): SmsStatusUpdate;

  parseCallStatus(
    rawBody: string,
    headers: Record<string, string>,
  ): CallStatusUpdate;

  /* --- carrier / regulatory onboarding --- */

  /** Register an A2P / 10DLC brand + campaign (or toll-free
   *  verification) for a sending number. Required before a number can
   *  send application-to-person SMS in many jurisdictions. */
  registerA2pCampaign(input: {
    brandName: string;
    useCase: string;
    sampleMessages: string[];
  }): Promise<A2pRegistration>;

  /* --- AI voice agents --- */

  /** Create a hosted AI voice agent. */
  createVoiceAgent(input: VoiceAgentConfig): Promise<ProvisionedVoiceAgent>;

  /** Update an existing agent's config. */
  updateVoiceAgent(
    input: { agentId: string } & Partial<VoiceAgentConfig>,
  ): Promise<ProvisionedVoiceAgent>;

  /** Delete an agent. */
  deleteVoiceAgent(input: { agentId: string }): Promise<void>;

  /** Bind an agent to a provisioned number so inbound calls reach it. */
  attachAgentToNumber(input: { agentId: string; e164: string }): Promise<void>;

  /** Verify + normalize an agent/tool webhook into `VoiceAgentEvent`;
   *  throws on an invalid signature or unparseable body. */
  parseAgentEvent(
    rawBody: string,
    headers: Record<string, string>,
  ): VoiceAgentEvent;
}

/* ---------- the stub ---------- */

/** Deterministic, in-process telephony stub. No carrier, no network —
 *  it makes the whole SMS + voice surface, including the inbound-webhook
 *  shapes, exercisable offline. The `parse*` methods assume `rawBody` is
 *  already the normalized JSON (a real provider translates a carrier's
 *  wire format); this is enough to drive inbound handlers in tests. */
export class StubTelephonyProvider implements TelephonyProvider {
  readonly label = "Stub telephony";
  readonly live = false;

  private seq = 7000;
  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}_stub_${this.seq.toString(36)}`;
  }

  async searchAvailableNumbers(input: {
    country: string;
    type?: NumberType;
    capability?: NumberCapability;
    areaCode?: string;
  }): Promise<AvailableNumber[]> {
    const type: NumberType = input.type ?? "local";
    const area = input.areaCode ?? "555";
    return [0, 1, 2].map((n) => ({
      e164: `+1${area}010${(1000 + n).toString()}`,
      country: input.country,
      type,
      capabilities:
        type === "short_code" ? ["sms"] : ["sms", "mms", "voice"],
      // Carrier-side indicative cost — the control plane re-prices these
      // through the marketplace pricebook before they reach a customer.
      setupPriceCents: type === "short_code" ? 50000 : 100,
      monthlyPriceCents: type === "toll_free" ? 200 : 100,
    }));
  }

  async provisionNumber(input: {
    e164: string;
    country: string;
    type: NumberType;
    capabilities: NumberCapability[];
  }): Promise<ProvisionedNumber> {
    return {
      e164: input.e164,
      country: input.country,
      type: input.type,
      capabilities: input.capabilities,
      providerId: this.nextId("num"),
    };
  }

  async releaseNumber(_input: { providerId: string }): Promise<void> {
    // No-op — the stub leases nothing real.
  }

  async portInNumber(input: {
    e164: string;
    country: string;
    type: NumberType;
    capabilities: NumberCapability[];
  }): Promise<{ providerId: string }> {
    void input;
    // The stub "accepts" the port instantly; the control plane still
    // holds the number in `porting` until `completePortIn` is called.
    return { providerId: this.nextId("port") };
  }

  async sendSms(input: {
    from: string;
    to: string;
    body: string;
  }): Promise<OutboundSmsResult> {
    void input;
    return { providerMessageId: this.nextId("sm"), accepted: true };
  }

  async placeCall(input: {
    from: string;
    to: string;
    routing: CallRouting;
  }): Promise<OutboundCallResult> {
    void input;
    return { providerCallId: this.nextId("call"), accepted: true };
  }

  parseInboundSms(
    rawBody: string,
    _headers: Record<string, string>,
  ): InboundSmsMessage {
    const p = parseJson(rawBody);
    const body = String(p.body ?? "");
    const upper = body.trim().toUpperCase();
    const keyword =
      upper === "STOP"
        ? "stop"
        : upper === "START"
          ? "start"
          : upper === "HELP"
            ? "help"
            : undefined;
    return {
      providerMessageId: String(p.providerMessageId ?? this.nextId("sm")),
      from: String(p.from ?? ""),
      to: String(p.to ?? ""),
      body,
      receivedAt: String(p.receivedAt ?? new Date().toISOString()),
      keyword,
    };
  }

  parseInboundCall(
    rawBody: string,
    _headers: Record<string, string>,
  ): InboundCall {
    const p = parseJson(rawBody);
    return {
      providerCallId: String(p.providerCallId ?? this.nextId("call")),
      from: String(p.from ?? ""),
      to: String(p.to ?? ""),
      receivedAt: String(p.receivedAt ?? new Date().toISOString()),
    };
  }

  parseSmsStatus(
    rawBody: string,
    _headers: Record<string, string>,
  ): SmsStatusUpdate {
    const p = parseJson(rawBody);
    return {
      providerMessageId: String(p.providerMessageId ?? ""),
      status: (p.status as SmsStatusUpdate["status"]) ?? "sent",
      at: String(p.at ?? new Date().toISOString()),
    };
  }

  parseCallStatus(
    rawBody: string,
    _headers: Record<string, string>,
  ): CallStatusUpdate {
    const p = parseJson(rawBody);
    return {
      providerCallId: String(p.providerCallId ?? ""),
      status: (p.status as CallStatusUpdate["status"]) ?? "completed",
      durationSec:
        typeof p.durationSec === "number" ? p.durationSec : undefined,
      voicemailUrl:
        typeof p.voicemailUrl === "string" ? p.voicemailUrl : undefined,
      at: String(p.at ?? new Date().toISOString()),
    };
  }

  async registerA2pCampaign(input: {
    brandName: string;
    useCase: string;
    sampleMessages: string[];
  }): Promise<A2pRegistration> {
    void input;
    // The stub auto-approves; a real carrier returns `pending` and the
    // outcome arrives later out-of-band.
    return { campaignId: this.nextId("a2p"), status: "approved" };
  }

  private agents = new Map<string, ProvisionedVoiceAgent>();

  async createVoiceAgent(input: VoiceAgentConfig): Promise<ProvisionedVoiceAgent> {
    const agent: ProvisionedVoiceAgent = {
      agentId: this.nextId("agent"),
      name: input.name,
    };
    this.agents.set(agent.agentId, agent);
    return agent;
  }

  async updateVoiceAgent(
    input: { agentId: string } & Partial<VoiceAgentConfig>,
  ): Promise<ProvisionedVoiceAgent> {
    const existing = this.agents.get(input.agentId);
    if (!existing) throw new Error(`VoiceAgent not found: ${input.agentId}`);
    const updated: ProvisionedVoiceAgent = {
      agentId: input.agentId,
      name: input.name ?? existing.name,
    };
    this.agents.set(input.agentId, updated);
    return updated;
  }

  async deleteVoiceAgent(input: { agentId: string }): Promise<void> {
    this.agents.delete(input.agentId);
  }

  async attachAgentToNumber(_input: { agentId: string; e164: string }): Promise<void> {
    // No-op — the stub binds nothing real.
  }

  parseAgentEvent(
    rawBody: string,
    _headers: Record<string, string>,
  ): VoiceAgentEvent {
    const p = parseJson(rawBody);
    const kind = p.kind;
    const k: VoiceAgentEvent["kind"] =
      kind === "tool_call" || kind === "transcript" || kind === "ended"
        ? kind
        : "transcript";
    return {
      agentId: String(p.agentId ?? ""),
      callId: String(p.callId ?? ""),
      kind: k,
      toolName: typeof p.toolName === "string" ? p.toolName : undefined,
      payload:
        p.payload != null && typeof p.payload === "object" && !Array.isArray(p.payload)
          ? (p.payload as Record<string, unknown>)
          : undefined,
      at: String(p.at ?? new Date().toISOString()),
    };
  }
}

/** Parse a JSON webhook body, throwing a clear error on malformed input. */
function parseJson(rawBody: string): Record<string, unknown> {
  try {
    const v = JSON.parse(rawBody) as unknown;
    if (v && typeof v === "object") return v as Record<string, unknown>;
    throw new Error("not an object");
  } catch {
    throw new Error("telephony webhook body is not valid JSON");
  }
}

/** The telephony provider the control plane uses. Auto-selects on env:
 *  `TELNYX_API_KEY` present → `TelnyxTelephonyProvider`; absent → the
 *  stub. Same one-file-swap pattern as `createMailProvider`. */
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
