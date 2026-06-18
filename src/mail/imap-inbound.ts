/* ============================================================
   MailInboundPoller — the Mailcow → control-plane inbound bridge
   (plan §20.11 step 1, "make the provider real" — inbound half).

   Outbound submission to Mailcow is already wired
   (mailcow-mail-provider.ts). The documented gap was the *receive*
   path: the control plane had the `/mail/inbound` webhook + parse +
   `receiveInboundMail`, but nothing pulled mail OFF box 2 into it.
   This is the IMAP-poll bridge the port comment called for ("IMAP
   poll or Mailcow forward to POST normalized messages to
   /mail/inbound").

   Shape mirrors the rest of the adapter-port codebase: all I/O lives
   behind injected seams (`ImapClient`, `resolveProject`, `deliver`),
   so the poller is pure orchestration and fully unit-testable with no
   network and no new dependency. The concrete IMAP client is loaded
   optionally at runtime (see `createMailInboundPoller`) so the build
   stays dependency-free until an operator actually turns inbound on.

   Delivery contract (at-least-once, no double-delivery on the happy
   path): a message is marked SEEN only after it is successfully
   handed to the control plane. A message that can't be routed to a
   project, or that the control plane rejects, is left UNSEEN so a
   later poll (after the routing gap is fixed) can retry it. One bad
   message never aborts the batch.
   ============================================================ */

import type { InboundMailMessage } from "./provider";

/** A raw message as the IMAP client surfaces it — envelope fields the
 *  poller normalizes into `InboundMailMessage`. */
export interface RawInboundEmail {
  /** IMAP UID — opaque handle the poller passes back to `markSeen`. */
  uid: number;
  to: string;
  from: string;
  subject?: string;
  body?: string;
  /** RFC `Message-ID` header, used as the provider message id. */
  messageId?: string;
  /** Envelope date, ISO string when the client can supply it. */
  receivedAt?: string;
}

/** The IMAP seam. The concrete implementation (imapflow) connects to
 *  box 2's Dovecot; tests pass a recording fake. */
export interface ImapClient {
  /** Fetch messages not yet marked `\Seen`. */
  fetchUnseen(): Promise<RawInboundEmail[]>;
  /** Mark a message `\Seen` so the next poll skips it. */
  markSeen(uid: number): Promise<void>;
  /** Release the connection. Always called, even on error. */
  close(): Promise<void>;
}

export interface MailInboundPollerDeps {
  /** Opens a fresh IMAP session for one poll. Returning a factory (not a
   *  long-lived client) keeps each poll self-contained and lets a dropped
   *  connection heal on the next tick. */
  openClient: () => Promise<ImapClient>;
  /** Resolve a recipient address to the owning project id, or null when no
   *  project owns it (unroutable — left unseen for a later retry). */
  resolveProject: (toAddress: string) => Promise<string | null>;
  /** Hand a normalized message to the control plane. `ok:false` leaves the
   *  message unseen for retry. */
  deliver: (
    projectId: string,
    msg: InboundMailMessage,
  ) => Promise<{ ok: boolean }>;
  log?: (msg: string) => void;
}

export interface PollResult {
  fetched: number;
  delivered: number;
  /** Unroutable (no owning project) — left unseen. */
  skipped: number;
  /** Routed but delivery failed / threw — left unseen for retry. */
  failed: number;
}

export class MailInboundPoller {
  constructor(private readonly deps: MailInboundPollerDeps) {}

  /** Drain the inbox once. Never throws on a per-message error; only a
   *  connection-level failure (openClient / fetchUnseen) propagates. */
  async pollOnce(): Promise<PollResult> {
    const result: PollResult = { fetched: 0, delivered: 0, skipped: 0, failed: 0 };
    const client = await this.deps.openClient();
    try {
      const messages = await client.fetchUnseen();
      result.fetched = messages.length;
      for (const raw of messages) {
        try {
          const projectId = await this.deps.resolveProject(raw.to);
          if (!projectId) {
            result.skipped += 1;
            this.deps.log?.(`[mail-inbound] no project for ${raw.to} — leaving unseen`);
            continue;
          }
          const msg: InboundMailMessage = {
            to: raw.to,
            from: raw.from,
            subject: raw.subject,
            body: raw.body,
            providerMessageId: raw.messageId,
            receivedAt: raw.receivedAt,
          };
          const { ok } = await this.deps.deliver(projectId, msg);
          if (!ok) {
            result.failed += 1;
            continue;
          }
          await client.markSeen(raw.uid);
          result.delivered += 1;
        } catch (err) {
          // One poisoned message must not stop the batch — leave it unseen.
          result.failed += 1;
          this.deps.log?.(
            `[mail-inbound] message uid=${raw.uid} failed: ${String(err)}`,
          );
        }
      }
      return result;
    } finally {
      await client.close().catch(() => {});
    }
  }

  /** Poll on an interval. Returns a stop handle. The first poll runs after
   *  `intervalMs` (not immediately) so boot isn't blocked on a mail node. A
   *  poll that throws is swallowed (logged) so a transient IMAP outage
   *  doesn't kill the loop. */
  start(intervalMs: number): { stop: () => void } {
    let running = false;
    const tick = async () => {
      if (running) return; // never overlap polls
      running = true;
      try {
        await this.pollOnce();
      } catch (err) {
        this.deps.log?.(`[mail-inbound] poll failed: ${String(err)}`);
      } finally {
        running = false;
      }
    };
    const timer = setInterval(() => void tick(), intervalMs);
    // Don't let the poll loop hold the event loop open on shutdown.
    if (typeof timer.unref === "function") timer.unref();
    return { stop: () => clearInterval(timer) };
  }
}

/* ---------- env-gated factory ---------- */

export interface InboundFactoryDeps {
  /** Reverse address → project lookup. Wired to
   *  `store.findHostedMailboxByAddress` in production. */
  resolveProject: (toAddress: string) => Promise<string | null>;
  /** Control-plane receive seam — wired to `cp.receiveInboundMail`. */
  deliver: (
    projectId: string,
    msg: InboundMailMessage,
  ) => Promise<{ ok: boolean }>;
  /** Override the IMAP client opener — tests inject a fake; production
   *  leaves it unset and the concrete imapflow client is loaded. */
  openClient?: () => Promise<ImapClient>;
  log?: (msg: string) => void;
}

export interface ImapConnectionConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  mailbox: string;
}

/** Parse IMAP connection env, or null when inbound polling is not configured.
 *
 *    MAILCOW_IMAP_HOST    e.g. mail.cantila.app
 *    MAILCOW_IMAP_USER    mailbox login that receives tenant mail
 *    MAILCOW_IMAP_PASS    its password
 *    MAILCOW_IMAP_PORT    optional, default 993
 *    MAILCOW_IMAP_SECURE  optional "true"/"false"; defaults to port===993
 *    MAILCOW_IMAP_MAILBOX optional, default "INBOX"
 */
export function parseImapConfig(
  env: NodeJS.ProcessEnv,
): ImapConnectionConfig | null {
  const host = env.MAILCOW_IMAP_HOST?.trim();
  const user = env.MAILCOW_IMAP_USER?.trim();
  const pass = env.MAILCOW_IMAP_PASS?.trim();
  if (!host || !user || !pass) return null;
  const port = Number(env.MAILCOW_IMAP_PORT ?? "993") || 993;
  const secure =
    (env.MAILCOW_IMAP_SECURE ?? (port === 993 ? "true" : "false")) === "true";
  return {
    host,
    port,
    secure,
    user,
    pass,
    mailbox: env.MAILCOW_IMAP_MAILBOX?.trim() || "INBOX",
  };
}

/** Build the poller, or null when inbound IMAP polling is not configured —
 *  the same env-gated, dormant-by-default pattern as
 *  `createMailcowMailProvider`. When `deps.openClient` is supplied (tests),
 *  it is used verbatim and no IMAP config is required. */
export function createMailInboundPoller(
  deps: InboundFactoryDeps,
  env: NodeJS.ProcessEnv = process.env,
): MailInboundPoller | null {
  let openClient = deps.openClient;
  if (!openClient) {
    const config = parseImapConfig(env);
    if (!config) return null;
    openClient = () => openImapflowClient(config);
  }
  return new MailInboundPoller({
    openClient,
    resolveProject: deps.resolveProject,
    deliver: deps.deliver,
    log: deps.log,
  });
}

/* ---------- concrete IMAP client (optional dependency, untested I/O edge) ----------

   Loaded only when inbound polling is actually configured, via an
   indirected dynamic import so `imapflow` stays an OPTIONAL dependency:
   the control plane builds and runs without it until an operator turns
   inbound mail on (then `npm i imapflow` on the box). Mirrors how
   `makeNodemailerTransport` is the untested I/O edge behind the SMTP seam.
*/
async function openImapflowClient(
  config: ImapConnectionConfig,
): Promise<ImapClient> {
  // Indirected specifier so tsc/bundlers don't hard-require the optional dep.
  const pkg = "imapflow";
  const mod: any = await import(/* @vite-ignore */ pkg);
  const ImapFlow = mod.ImapFlow;
  const flow = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.pass },
    logger: false,
  });
  await flow.connect();
  await flow.mailboxOpen(config.mailbox);

  return {
    async fetchUnseen() {
      const out: RawInboundEmail[] = [];
      for await (const m of flow.fetch(
        { seen: false },
        { uid: true, envelope: true, source: true },
      )) {
        const env = m.envelope ?? {};
        const to = env.to?.[0]?.address ?? "";
        const from = env.from?.[0]?.address ?? "";
        out.push({
          uid: m.uid,
          to,
          from,
          subject: env.subject ?? undefined,
          body: m.source ? m.source.toString("utf8") : undefined,
          messageId: env.messageId ?? undefined,
          receivedAt: env.date ? new Date(env.date).toISOString() : undefined,
        });
      }
      return out;
    },
    async markSeen(uid: number) {
      await flow.messageFlagsAdd({ uid: String(uid) }, ["\\Seen"], { uid: true });
    },
    async close() {
      await flow.logout();
    },
  };
}
