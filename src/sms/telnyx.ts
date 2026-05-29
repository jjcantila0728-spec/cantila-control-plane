/* ============================================================
   Telnyx live telephony adapter (plan §21). Implements the
   `TelephonyProvider` port against the Telnyx v2 REST API.
   Type-only imports from ./provider keep this free of a runtime
   circular dependency.
   ============================================================ */

import { createPublicKey, verify as edVerify } from "node:crypto";

import type {
  TelephonyProvider,
  AvailableNumber,
  ProvisionedNumber,
  OutboundSmsResult,
  OutboundCallResult,
  CallRouting,
  InboundSmsMessage,
  InboundCall,
  SmsStatusUpdate,
  CallStatusUpdate,
  A2pRegistration,
  VoiceAgentConfig,
  ProvisionedVoiceAgent,
  VoiceAgentEvent,
} from "./provider";
import type { NumberType, NumberCapability } from "../domain/types";

const TELNYX_BASE = "https://api.telnyx.com/v2";

export interface TelnyxClientConfig {
  apiKey: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** Thin Telnyx v2 REST client. Throws `TelnyxError` on non-2xx. */
export class TelnyxClient {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: TelnyxClientConfig) {
    this.apiKey = cfg.apiKey;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
  }

  async post(path: string, body: unknown): Promise<unknown> {
    const res = await this.fetchImpl(`${TELNYX_BASE}${path}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    return this.handle(res, path);
  }

  async get(path: string): Promise<unknown> {
    const res = await this.fetchImpl(`${TELNYX_BASE}${path}`, {
      method: "GET",
      headers: this.headers(),
    });
    return this.handle(res, path);
  }

  async del(path: string): Promise<unknown> {
    const res = await this.fetchImpl(`${TELNYX_BASE}${path}`, {
      method: "DELETE",
      headers: this.headers(),
    });
    return this.handle(res, path);
  }

  private async handle(res: Response, path: string): Promise<unknown> {
    const text = await res.text();
    if (!res.ok) {
      throw new TelnyxError(res.status, path, text);
    }
    if (!text) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new TelnyxError(res.status, path, `Non-JSON response body: ${text.slice(0, 200)}`);
    }
  }
}

export class TelnyxError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    /** Full, untruncated response body — may be large on HTML error pages. */
    readonly bodyText: string,
  ) {
    super(`Telnyx ${status} on ${path}: ${bodyText.slice(0, 300)}`);
    this.name = "TelnyxError";
  }
}

export interface TelnyxProviderConfig {
  apiKey: string;
  publicKey?: string;
  messagingProfileId?: string;
  voiceConnectionId?: string;
  fetchImpl?: typeof fetch;
}

export class TelnyxTelephonyProvider implements TelephonyProvider {
  readonly label = "Telnyx";
  readonly live = true;

  private readonly client: TelnyxClient;
  private readonly publicKey: string;
  private readonly messagingProfileId?: string;
  private readonly voiceConnectionId?: string;

  constructor(cfg: TelnyxProviderConfig) {
    this.client = new TelnyxClient({ apiKey: cfg.apiKey, fetchImpl: cfg.fetchImpl });
    this.publicKey = cfg.publicKey ?? "";
    this.messagingProfileId = cfg.messagingProfileId;
    this.voiceConnectionId = cfg.voiceConnectionId;
  }

  /* --- numbers --- */

  async searchAvailableNumbers(input: {
    country: string;
    type?: NumberType;
    capability?: NumberCapability;
    areaCode?: string;
  }): Promise<AvailableNumber[]> {
    const params = new URLSearchParams();
    params.set("filter[country_code]", input.country);
    if (input.capability) params.append("filter[features][]", input.capability);
    if (input.areaCode) params.set("filter[national_destination_code]", input.areaCode);
    const res = (await this.client.get(`/available_phone_numbers?${params.toString()}`)) as {
      data?: Array<{
        phone_number: string;
        cost_information?: { monthly_cost?: string; upfront_cost?: string };
        features?: Array<{ name: string }>;
      }>;
    };
    const type: NumberType = input.type ?? "local";
    return (res.data ?? []).map((n) => ({
      e164: n.phone_number,
      country: input.country,
      type,
      capabilities: (n.features ?? [])
        .map((f) => f.name)
        .filter((x): x is NumberCapability => x === "sms" || x === "mms" || x === "voice"),
      setupPriceCents: Math.round(Number(n.cost_information?.upfront_cost ?? "0") * 100),
      monthlyPriceCents: Math.round(Number(n.cost_information?.monthly_cost ?? "0") * 100),
    }));
  }

  async provisionNumber(input: {
    e164: string;
    country: string;
    type: NumberType;
    capabilities: NumberCapability[];
  }): Promise<ProvisionedNumber> {
    const res = (await this.client.post("/number_orders", {
      phone_numbers: [{ phone_number: input.e164 }],
      ...(this.messagingProfileId ? { messaging_profile_id: this.messagingProfileId } : {}),
    })) as { data?: { phone_numbers?: Array<{ id: string; phone_number: string }> } };
    const pn = res.data?.phone_numbers?.[0];
    return {
      e164: input.e164,
      country: input.country,
      type: input.type,
      capabilities: input.capabilities,
      providerId: pn?.id ?? "",
    };
  }

  async releaseNumber(input: { providerId: string }): Promise<void> {
    await this.client.del(`/phone_numbers/${input.providerId}`);
  }

  async portInNumber(input: {
    e164: string;
    country: string;
    type: NumberType;
    capabilities: NumberCapability[];
  }): Promise<{ providerId: string }> {
    const res = (await this.client.post("/porting_orders", {
      phone_numbers: [{ phone_number: input.e164 }],
    })) as { data?: { id?: string } };
    return { providerId: res.data?.id ?? "" };
  }

  /* --- outbound SMS --- */

  async sendSms(input: { from: string; to: string; body: string }): Promise<OutboundSmsResult> {
    const res = (await this.client.post("/messages", {
      from: input.from,
      to: input.to,
      text: input.body,
      ...(this.messagingProfileId ? { messaging_profile_id: this.messagingProfileId } : {}),
    })) as { data?: { id?: string } };
    return { providerMessageId: res.data?.id ?? "", accepted: Boolean(res.data?.id) };
  }

  /* --- outbound voice --- */

  async placeCall(input: { from: string; to: string; routing: CallRouting }): Promise<OutboundCallResult> {
    void input.routing;
    const res = (await this.client.post("/calls", {
      to: input.to,
      from: input.from,
      ...(this.voiceConnectionId ? { connection_id: this.voiceConnectionId } : {}),
    })) as { data?: { call_control_id?: string } };
    return { providerCallId: res.data?.call_control_id ?? "", accepted: Boolean(res.data?.call_control_id) };
  }

  /* --- inbound webhook parsing --- */

  private requireVerified(rawBody: string, headers: Record<string, string>): Record<string, unknown> {
    const sig = headers["telnyx-signature-ed25519"] ?? headers["Telnyx-Signature-Ed25519"] ?? "";
    const ts = headers["telnyx-timestamp"] ?? headers["Telnyx-Timestamp"] ?? "";
    if (!verifyTelnyxSignature(this.publicKey, sig, ts, rawBody)) {
      throw new Error("invalid Telnyx webhook signature");
    }
    const parsed = JSON.parse(rawBody) as { data?: { payload?: Record<string, unknown> } };
    return parsed.data?.payload ?? {};
  }

  parseInboundSms(rawBody: string, headers: Record<string, string>): InboundSmsMessage {
    const p = this.requireVerified(rawBody, headers);
    const from = String((p.from as { phone_number?: string })?.phone_number ?? p.from ?? "");
    const toArr = p.to as Array<{ phone_number?: string }> | undefined;
    const to = String(toArr?.[0]?.phone_number ?? p.to ?? "");
    const body = String(p.text ?? "");
    const upper = body.trim().toUpperCase();
    const keyword =
      upper === "STOP" ? "stop" : upper === "START" ? "start" : upper === "HELP" ? "help" : undefined;
    return {
      providerMessageId: String(p.id ?? ""),
      from,
      to,
      body,
      receivedAt: String(p.received_at ?? new Date().toISOString()),
      keyword,
    };
  }

  parseInboundCall(rawBody: string, headers: Record<string, string>): InboundCall {
    const p = this.requireVerified(rawBody, headers);
    return {
      providerCallId: String(p.call_control_id ?? ""),
      from: String(p.from ?? ""),
      to: String(p.to ?? ""),
      receivedAt: String(p.start_time ?? new Date().toISOString()),
    };
  }

  parseSmsStatus(rawBody: string, headers: Record<string, string>): SmsStatusUpdate {
    const p = this.requireVerified(rawBody, headers);
    const toArr = p.to as Array<{ status?: string }> | undefined;
    const raw = String(toArr?.[0]?.status ?? "sent");
    const status: SmsStatusUpdate["status"] =
      raw === "delivered" ? "delivered"
      : raw === "sending_failed" || raw === "delivery_failed" ? "failed"
      : raw === "queued" ? "queued"
      : raw === "sent" ? "sent"
      : "undelivered";
    return { providerMessageId: String(p.id ?? ""), status, at: String(p.completed_at ?? new Date().toISOString()) };
  }

  parseCallStatus(rawBody: string, headers: Record<string, string>): CallStatusUpdate {
    const p = this.requireVerified(rawBody, headers);
    const raw = String(p.state ?? "completed");
    const status: CallStatusUpdate["status"] =
      raw === "ringing" ? "ringing"
      : raw === "answered" || raw === "bridged" ? "in_progress"
      : raw === "hangup" || raw === "completed" ? "completed"
      : raw === "busy" ? "busy"
      : raw === "no-answer" ? "no_answer"
      : "failed";
    return {
      providerCallId: String(p.call_control_id ?? ""),
      status,
      durationSec: typeof p.duration_secs === "number" ? p.duration_secs : undefined,
      at: String(p.occurred_at ?? new Date().toISOString()),
    };
  }

  /* --- A2P / 10DLC --- */

  async registerA2pCampaign(input: {
    brandName: string;
    useCase: string;
    sampleMessages: string[];
  }): Promise<A2pRegistration> {
    const res = (await this.client.post("/10dlc/campaigns", {
      brand_name: input.brandName,
      use_case: input.useCase,
      sample_messages: input.sampleMessages,
    })) as { data?: { campaignId?: string; id?: string; status?: string } };
    const status = res.data?.status;
    return {
      campaignId: String(res.data?.campaignId ?? res.data?.id ?? ""),
      status: status === "approved" ? "approved" : status === "rejected" ? "rejected" : "pending",
    };
  }

  /* --- AI voice agents --- */

  async createVoiceAgent(input: VoiceAgentConfig): Promise<ProvisionedVoiceAgent> {
    const res = (await this.client.post("/ai/assistants", {
      name: input.name,
      instructions: input.instructions,
      ...(input.voice ? { voice: input.voice } : {}),
      ...(input.greeting ? { greeting: input.greeting } : {}),
      ...(input.tools ? { tools: input.tools.map((t) => ({ type: "webhook", name: t.name, description: t.description, url: t.webhookUrl })) } : {}),
    })) as { data?: { id?: string; name?: string } };
    return { agentId: String(res.data?.id ?? ""), name: String(res.data?.name ?? input.name) };
  }

  async updateVoiceAgent(
    input: { agentId: string } & Partial<VoiceAgentConfig>,
  ): Promise<ProvisionedVoiceAgent> {
    const res = (await this.client.post(`/ai/assistants/${input.agentId}`, {
      ...(input.name ? { name: input.name } : {}),
      ...(input.instructions ? { instructions: input.instructions } : {}),
      ...(input.voice ? { voice: input.voice } : {}),
      ...(input.greeting ? { greeting: input.greeting } : {}),
    })) as { data?: { id?: string; name?: string } };
    return { agentId: input.agentId, name: String(res.data?.name ?? input.name ?? "") };
  }

  async deleteVoiceAgent(input: { agentId: string }): Promise<void> {
    await this.client.del(`/ai/assistants/${input.agentId}`);
  }

  async attachAgentToNumber(input: { agentId: string; e164: string }): Promise<void> {
    // Bind the assistant as the inbound handler for the number's voice settings.
    await this.client.post(`/ai/assistants/${input.agentId}/phone_numbers`, {
      phone_number: input.e164,
    });
  }

  parseAgentEvent(rawBody: string, headers: Record<string, string>): VoiceAgentEvent {
    const p = this.requireVerified(rawBody, headers);
    const rawKind = String(p.event_type ?? p.kind ?? "");
    const kind: VoiceAgentEvent["kind"] =
      rawKind.includes("tool") ? "tool_call"
      : rawKind.includes("end") || rawKind.includes("hangup") ? "ended"
      : "transcript";
    return {
      agentId: String(p.assistant_id ?? p.agentId ?? ""),
      callId: String(p.call_control_id ?? p.callId ?? ""),
      kind,
      toolName: typeof p.tool_name === "string" ? p.tool_name : undefined,
      payload: p.payload && typeof p.payload === "object" ? (p.payload as Record<string, unknown>) : undefined,
      at: String(p.occurred_at ?? new Date().toISOString()),
    };
  }
}

/** DER SPKI prefix for a raw 32-byte Ed25519 public key. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** Verify a Telnyx Ed25519 webhook signature. Telnyx signs
 *  `${timestamp}|${rawBody}` with its messaging-profile key; the public
 *  key (env `TELNYX_PUBLIC_KEY`) is the base64 of the raw 32-byte key. */
export function verifyTelnyxSignature(
  publicKeyB64: string,
  signatureB64: string,
  timestamp: string,
  rawBody: string,
): boolean {
  const rawKey = Buffer.from(publicKeyB64, "base64");
  if (rawKey.length !== 32) {
    throw new Error(
      "TELNYX_PUBLIC_KEY is missing or malformed (expected base64 of a 32-byte Ed25519 key)",
    );
  }
  try {
    const der = Buffer.concat([ED25519_SPKI_PREFIX, rawKey]);
    const keyObj = createPublicKey({ key: der, format: "der", type: "spki" });
    return edVerify(
      null,
      Buffer.from(`${timestamp}|${rawBody}`),
      keyObj,
      Buffer.from(signatureB64, "base64"),
    );
  } catch {
    return false;
  }
}
