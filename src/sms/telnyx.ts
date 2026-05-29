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
    return text ? (JSON.parse(text) as unknown) : {};
  }
}

export class TelnyxError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly bodyText: string,
  ) {
    super(`Telnyx ${status} on ${path}: ${bodyText.slice(0, 300)}`);
    this.name = "TelnyxError";
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
  try {
    const rawKey = Buffer.from(publicKeyB64, "base64");
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
