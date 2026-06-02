/* ============================================================
   MailcowMailProvider — the live `MailProvider` (plan §4.4 / §17.2).

   The one-file swap the port (`provider.ts`) was designed for:
   replaces `StubMailProvider` when the SMTP-submission env is set.

   - sendMail  → SMTP submission to Mailcow (Postfix) on 587/465 via
     nodemailer. Returns only the queued ack (`accepted: true`); the
     terminal outcome (delivered / bounced / …) arrives later via a
     status-webhook call to `cp.receiveMailStatusUpdate`, NOT inline.
     That's why no `stubTerminal` is set — `cp.sendMail` records the
     `sent` event and defers the terminal (control-plane.ts:1524).
   - parseInbound / parseStatusUpdate → parse the JSON the MTA's
     receive / bounce webhook posts to the inbound + status routes.
     Mirrors the stub's documented contract so the existing routes
     work unchanged once Mailcow is wired to POST to them.

   NOTE: the submission account (MAILCOW_SMTP_USER) must be permitted
   to send as each project's `from` address — either disable Mailcow's
   per-mailbox sender check on that account or grant it allowed-from
   entries for the sending domains. The port hands one credential per
   process, not per-mailbox creds.
   ============================================================ */

import { createTransport } from "nodemailer";

import type {
  InboundMailMessage,
  MailProvider,
  OutboundMailResult,
  OutboundMailStatusUpdate,
  SendMailInput,
} from "./provider";

/** Minimal SMTP seam so tests inject a fake and never touch the
 *  network. nodemailer's `Transporter.sendMail` satisfies it once
 *  wrapped (see `makeNodemailerTransport`). */
export interface MailcowSmtpTransport {
  sendMail(msg: {
    from: string;
    to: string;
    subject?: string;
    text?: string;
  }): Promise<{ messageId?: string }>;
}

type SendResult = OutboundMailResult & {
  stubTerminal?: OutboundMailStatusUpdate["kind"];
};

export class MailcowMailProvider implements MailProvider {
  readonly label = "Mailcow";
  readonly live = true;
  private readonly transport: MailcowSmtpTransport;
  private seq = 9000;

  constructor(opts: { transport: MailcowSmtpTransport }) {
    this.transport = opts.transport;
  }

  private nextId(): string {
    this.seq += 1;
    return `mmsg_${this.seq.toString(36)}`;
  }

  async sendMail(input: SendMailInput): Promise<SendResult> {
    try {
      const info = await this.transport.sendMail({
        from: input.from,
        to: input.to,
        subject: input.subject,
        text: input.body,
      });
      // Live MTA: queued ack only. The terminal kind is driven by the
      // status webhook, so we intentionally omit `stubTerminal`.
      return { providerMessageId: info.messageId || this.nextId(), accepted: true };
    } catch {
      // Submission failed (connection / auth / rejected RCPT). Surface
      // as a non-acceptance — `cp.sendMail` maps this to an error.
      return { providerMessageId: "", accepted: false };
    }
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
      receivedAt: typeof v.receivedAt === "string" ? v.receivedAt : undefined,
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
      diagnostic: typeof v.diagnostic === "string" ? v.diagnostic : undefined,
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

/** Wrap a real nodemailer transporter behind the `MailcowSmtpTransport`
 *  seam. `createTransport` does no I/O until `sendMail` fires, so
 *  building this at module load (via the factory) is safe offline. */
function makeNodemailerTransport(o: {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}): MailcowSmtpTransport {
  const t = createTransport({
    host: o.host,
    port: o.port,
    secure: o.secure,
    auth: { user: o.user, pass: o.pass },
  });
  return {
    sendMail: (m) => t.sendMail(m).then((info) => ({ messageId: info.messageId })),
  };
}

/** Env-gated factory — returns a live provider only when SMTP
 *  submission is fully configured, else `null` so `createMailProvider`
 *  falls back to the stub. Mirrors `createMailboxProvisioner`.
 *
 *    MAILCOW_SMTP_HOST   e.g. mail.cantila.app
 *    MAILCOW_SMTP_USER   submission login (e.g. info@cantila.app)
 *    MAILCOW_SMTP_PASS   submission password
 *    MAILCOW_SMTP_PORT   optional, default 587
 *    MAILCOW_SMTP_SECURE optional "true"/"false"; defaults to port===465
 */
export function createMailcowMailProvider(
  env: NodeJS.ProcessEnv = process.env,
): MailcowMailProvider | null {
  const host = env.MAILCOW_SMTP_HOST;
  const user = env.MAILCOW_SMTP_USER;
  const pass = env.MAILCOW_SMTP_PASS;
  if (!host || !user || !pass) return null;
  const port = Number(env.MAILCOW_SMTP_PORT ?? "587") || 587;
  const secure =
    (env.MAILCOW_SMTP_SECURE ?? (port === 465 ? "true" : "false")) === "true";
  return new MailcowMailProvider({
    transport: makeNodemailerTransport({ host, port, secure, user, pass }),
  });
}
