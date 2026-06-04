/* ============================================================
   Mail provider port (plan §4.4 — complete first-party email
   provider, §17.2 — Mailcow recommendation).

   Cantila Mail is a complete email provider — it both sends and
   receives mail for any domain in the account, with no
   third-party relay anywhere in the path. Per plan §17.2 the
   recommended live implementation is Mailcow (a battle-tested,
   open-source mail-server bundle: Postfix outbound MTA, Dovecot
   IMAP, Rspamd filtering, a webmail client) running on Cantila
   infrastructure with dedicated IP pools — owned end-to-end.

   The control plane talks to the `MailProvider` interface and
   never to an MTA directly — the same adapter-port pattern
   `TelephonyProvider` / `StripeAdapter` / `AiAnalyser` /
   `SsoProvider` use. The stub bundled here records what the live
   MTA would do (a `sent` hand-off, then a probability-rolled
   terminal outcome) so the control plane's mail-event ring,
   `MailAgent`, the deliverability rollup, the IP-pool reputation
   feedback loop and the per-pool deliverability view are all
   exercisable offline against deterministic numbers.

   STATUS — LIVE. The real `MailcowMailProvider` (mailcow-mail-provider.ts)
   ships and auto-selects when the SMTP-submission env is set; this stub is
   the offline fallback. Outbound submission to Mailcow (Postfix) is wired;
   the inbound receive path still needs a Mailcow→CP bridge (IMAP poll or
   Mailcow forward) to POST normalized messages to `/mail/inbound`. Full
   external deliverability also wants per-domain DKIM + DNS warmup. The port
   boundary kept the swap to one file with no call sites moving.
   ============================================================ */

import type { MailEventKind } from "../core/control-plane";
import { createMailcowMailProvider } from "./mailcow-mail-provider";

/* ---------- outbound ---------- */

/** Per-mailbox SMTP submission credentials (see SendMailInput.auth). */
export interface MailboxSmtpAuth {
  host: string;
  user: string;
  pass: string;
  port?: number;
  secure?: boolean;
}

/** Carrier hand-off for an outbound message. `accepted` means the
 *  MTA queued it for delivery; the terminal outcome (delivered /
 *  bounced / complained / deferred) arrives later as an
 *  `OutboundMailStatusUpdate` from the bounce / FBL / queue webhook. */
export interface OutboundMailResult {
  /** MTA-side id for the queued message — used to correlate the
   *  later status update with the original send. */
  providerMessageId: string;
  accepted: boolean;
}

export interface SendMailInput {
  /** RFC-5321 envelope sender (`MAIL FROM`). Must be in a verified
   *  sending domain on the tenant's account. */
  from: string;
  to: string;
  subject?: string;
  /** Plain-text body. Future drops add a structured
   *  `{ text, html, attachments }` shape — the stub doesn't need
   *  it yet. */
  body?: string;
  /** Sending-IP-pool id to ride through (plan §4.4 — IP-pool
   *  rotation). The control plane's `chooseSendingPool` picks
   *  this per-send and the live MTA reads it to route the bytes
   *  through the matching IP. Undefined for accounts with no
   *  pools configured — the MTA falls back to its default. */
  poolId?: string;
  /** Test-only outcome bias — lets the smoke test force a high
   *  bounce rate without running real bad mail through. The live
   *  MTA ignores this field; only the stub honours it. */
  outcomeBias?: {
    delivered?: number;
    bounced?: number;
    complained?: number;
  };
  /** Optional per-mailbox SMTP submission credentials. When set, a live
   *  provider authenticates as THIS mailbox (so `from` matches the login
   *  and passes the MTA's sender-check) instead of the shared platform
   *  submission account. The control plane passes the tenant project's
   *  own mailbox creds here (decrypted at call time). */
  auth?: MailboxSmtpAuth;
}

/* ---------- inbound (normalized) ---------- */

/** Normalized inbound-message shape the MTA's receive webhook
 *  delivers. A real `MailcowMailProvider`'s `parseInbound` takes
 *  the MTA's wire format and produces this; the control plane's
 *  `receiveInboundMail` reads it. Same pattern as the
 *  `InboundSmsMessage` / `InboundCall` shapes on the telephony
 *  port. */
export interface InboundMailMessage {
  to: string;
  from: string;
  subject?: string;
  body?: string;
  /** MTA-side id for the inbound. Optional — the carrier may not
   *  give one. */
  providerMessageId?: string;
  /** Optional — when the MTA's webhook timestamps the message,
   *  the receive handler honours it rather than `now()`. */
  receivedAt?: string;
}

/** Terminal status webhook payload for an outbound message. */
export interface OutboundMailStatusUpdate {
  providerMessageId: string;
  /** Terminal kind — mirrors the `MailEventKind` enum the control
   *  plane records on the event ring. */
  kind: Extract<MailEventKind, "delivered" | "bounced" | "complained" | "deferred">;
  /** Optional diagnostic ("4.4.1 mailbox temporarily disabled",
   *  "5.1.1 user unknown"). The MTA forwards what the receiving
   *  server returned. */
  diagnostic?: string;
}

/* ---------- the port ---------- */

export interface MailProvider {
  /** Display label — used in `cp.mailInfo()` and the Console
   *  badge so the operator knows whether they're talking to the
   *  stub or a real MTA. */
  readonly label: string;
  /** False for the stub; true for a real MTA adapter. */
  readonly live: boolean;

  /** Hand the message off to the MTA. The stub returns a
   *  deterministic outcome roll alongside the queued ack so
   *  callers can use it for the terminal event without waiting
   *  on a webhook; a real MTA returns `{accepted: true}` and the
   *  terminal kind arrives later via `parseStatusUpdate`. */
  sendMail(input: SendMailInput): Promise<
    OutboundMailResult & {
      /** Stub-only — when set, the caller uses this as the
       *  terminal outcome immediately. Real MTAs return
       *  undefined and let the webhook drive the terminal. */
      stubTerminal?: OutboundMailStatusUpdate["kind"];
    }
  >;

  /** Parse the MTA's inbound webhook payload into the normalized
   *  shape `cp.receiveInboundMail` reads. The stub assumes
   *  `rawBody` is already a JSON `InboundMailMessage` — enough
   *  for the existing inbound route to be exercisable offline. */
  parseInbound(rawBody: string): InboundMailMessage;

  /** Parse the MTA's status webhook into the normalized terminal
   *  update. The stub assumes JSON; a real provider translates
   *  Postfix queue logs / FBL reports / bounce categorisation. */
  parseStatusUpdate(rawBody: string): OutboundMailStatusUpdate;
}

/* ---------- the stub ---------- */

const STUB_DELIVERY_BASELINE = {
  delivered: 0.9,
  bounced: 0.07,
  complained: 0.01,
  // remaining (0.02) → deferred
} as const;

/** Deterministic, in-process MTA stub. No network — every send
 *  rolls a terminal outcome inline and returns it on
 *  `stubTerminal` so the existing inline `sendMail` behaviour is
 *  preserved exactly. The live `MailcowMailProvider` will return
 *  `{accepted: true}` only and let the status webhook drive the
 *  terminal — `cp.sendMail` already supports both paths because
 *  it reads `stubTerminal` defensively. */
export class StubMailProvider implements MailProvider {
  readonly label = "Stub MTA";
  readonly live = false;

  private seq = 7000;
  private nextId(): string {
    this.seq += 1;
    return `mmsg_stub_${this.seq.toString(36)}`;
  }

  async sendMail(input: SendMailInput): Promise<
    OutboundMailResult & { stubTerminal?: OutboundMailStatusUpdate["kind"] }
  > {
    const bias = input.outcomeBias ?? {};
    const pD = bias.delivered ?? STUB_DELIVERY_BASELINE.delivered;
    const pB = bias.bounced ?? STUB_DELIVERY_BASELINE.bounced;
    const pC = bias.complained ?? STUB_DELIVERY_BASELINE.complained;
    const roll = Math.random();
    let terminal: OutboundMailStatusUpdate["kind"];
    if (roll < pD) terminal = "delivered";
    else if (roll < pD + pB) terminal = "bounced";
    else if (roll < pD + pB + pC) terminal = "complained";
    else terminal = "deferred";
    return {
      providerMessageId: this.nextId(),
      accepted: true,
      stubTerminal: terminal,
    };
  }

  parseInbound(rawBody: string): InboundMailMessage {
    const v = parseJson(rawBody);
    const to = typeof v.to === "string" ? v.to : "";
    const from = typeof v.from === "string" ? v.from : "";
    if (!to || !from) {
      throw new Error("inbound mail webhook missing required `to` / `from`");
    }
    return {
      to,
      from,
      subject: typeof v.subject === "string" ? v.subject : undefined,
      body: typeof v.body === "string" ? v.body : undefined,
      providerMessageId:
        typeof v.providerMessageId === "string" ? v.providerMessageId : undefined,
      receivedAt:
        typeof v.receivedAt === "string" ? v.receivedAt : undefined,
    };
  }

  parseStatusUpdate(rawBody: string): OutboundMailStatusUpdate {
    const v = parseJson(rawBody);
    const id = typeof v.providerMessageId === "string" ? v.providerMessageId : "";
    if (!id) {
      throw new Error("mail status webhook missing `providerMessageId`");
    }
    const kind = v.kind;
    if (
      kind !== "delivered" &&
      kind !== "bounced" &&
      kind !== "complained" &&
      kind !== "deferred"
    ) {
      throw new Error(`mail status webhook unknown kind: ${String(kind)}`);
    }
    return {
      providerMessageId: id,
      kind,
      diagnostic:
        typeof v.diagnostic === "string" ? v.diagnostic : undefined,
    };
  }
}

function parseJson(rawBody: string): Record<string, unknown> {
  try {
    const v = JSON.parse(rawBody) as unknown;
    if (v && typeof v === "object") return v as Record<string, unknown>;
    throw new Error("not an object");
  } catch {
    throw new Error("mail webhook body is not valid JSON");
  }
}

/** The mail provider the control plane uses. Auto-selects on env
 *  var presence — the same pattern Stripe / AI / SSO use:
 *
 *    - `MAILCOW_SMTP_HOST` + `MAILCOW_SMTP_USER` + `MAILCOW_SMTP_PASS`
 *      set → `MailcowMailProvider` (SMTP submission via nodemailer);
 *      the stub falls through otherwise. Same one-file swap pattern
 *      `StripeRealAdapter` / `ClaudeAiAnalyser` / `OidcSsoProvider`
 *      use today. (Mailbox provisioning is a separate env gate —
 *      `MAILCOW_URL` + `MAILCOW_API_KEY` — see `createMailboxProvisioner`.)
 *
 *  Exported as a callable factory so tests can construct a fresh
 *  stub instance per case (preserves the seq counter's
 *  determinism). The control plane reads `mailProvider` (the
 *  singleton) at module load. */
export function createMailProvider(): MailProvider {
  // Live SMTP submission when MAILCOW_SMTP_* is set (same env-gated
  // one-file-swap pattern as createMailboxProvisioner / Stripe / SSO).
  // Falls through to the deterministic stub otherwise — so today's
  // offline behaviour and the reset/verify `debugLink` (suppressed only
  // when `mailProvider.live`) are unchanged until the env is wired.
  const live = createMailcowMailProvider();
  if (live) return live;
  return new StubMailProvider();
}

export const mailProvider: MailProvider = createMailProvider();
