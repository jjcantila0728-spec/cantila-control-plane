/* ============================================================
   MailInboundPoller — orchestration over injected seams. Asserts
   normalize → resolve → deliver → markSeen, and the unseen-on-failure
   contract. No network, no imapflow.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MailInboundPoller,
  createMailInboundPoller,
  parseImapConfig,
  type ImapClient,
  type RawInboundEmail,
} from "./imap-inbound";
import type { InboundMailMessage } from "./provider";

interface Harness {
  client: ImapClient;
  seen: number[];
  closed: { n: number };
  delivered: { projectId: string; msg: InboundMailMessage }[];
}

function harness(
  messages: RawInboundEmail[],
  opts: {
    resolve?: (to: string) => string | null;
    deliverOk?: (projectId: string) => boolean;
    deliverThrows?: boolean;
  } = {},
): { poller: MailInboundPoller } & Harness {
  const seen: number[] = [];
  const closed = { n: 0 };
  const delivered: Harness["delivered"] = [];
  const client: ImapClient = {
    async fetchUnseen() {
      return messages.filter((m) => !seen.includes(m.uid));
    },
    async markSeen(uid) {
      seen.push(uid);
    },
    async close() {
      closed.n += 1;
    },
  };
  const poller = new MailInboundPoller({
    openClient: async () => client,
    resolveProject: async (to) =>
      opts.resolve ? opts.resolve(to) : "prj_1",
    deliver: async (projectId, msg) => {
      if (opts.deliverThrows) throw new Error("boom");
      delivered.push({ projectId, msg });
      return { ok: opts.deliverOk ? opts.deliverOk(projectId) : true };
    },
  });
  return { poller, client, seen, closed, delivered };
}

const email = (over: Partial<RawInboundEmail> = {}): RawInboundEmail => ({
  uid: 1,
  to: "info@acme.cantila.app",
  from: "sender@example.com",
  subject: "hi",
  body: "hello there",
  messageId: "<abc@x>",
  receivedAt: "2026-06-18T00:00:00.000Z",
  ...over,
});

test("delivers a routable message, normalizes it, then marks it seen", async () => {
  const h = harness([email()]);
  const r = await h.poller.pollOnce();
  assert.deepEqual(r, { fetched: 1, delivered: 1, skipped: 0, failed: 0 });
  assert.deepEqual(h.seen, [1]);
  assert.equal(h.closed.n, 1);
  assert.equal(h.delivered.length, 1);
  assert.deepEqual(h.delivered[0]!.msg, {
    to: "info@acme.cantila.app",
    from: "sender@example.com",
    subject: "hi",
    body: "hello there",
    providerMessageId: "<abc@x>",
    receivedAt: "2026-06-18T00:00:00.000Z",
  });
});

test("unroutable message → skipped, left UNSEEN for retry", async () => {
  const h = harness([email()], { resolve: () => null });
  const r = await h.poller.pollOnce();
  assert.deepEqual(r, { fetched: 1, delivered: 0, skipped: 1, failed: 0 });
  assert.deepEqual(h.seen, [], "must not mark an unrouted message seen");
});

test("delivery rejected by control plane → failed, left UNSEEN", async () => {
  const h = harness([email()], { deliverOk: () => false });
  const r = await h.poller.pollOnce();
  assert.deepEqual(r, { fetched: 1, delivered: 0, skipped: 0, failed: 1 });
  assert.deepEqual(h.seen, []);
});

test("a thrown deliver doesn't abort the batch; other messages still flow", async () => {
  // First message throws, second delivers fine.
  const msgs = [email({ uid: 1 }), email({ uid: 2 })];
  const seen: number[] = [];
  const delivered: string[] = [];
  const poller = new MailInboundPoller({
    openClient: async () => ({
      async fetchUnseen() {
        return msgs;
      },
      async markSeen(uid) {
        seen.push(uid);
      },
      async close() {},
    }),
    resolveProject: async () => "prj_1",
    deliver: async (_p, msg) => {
      if (msg.to === "u1@x") throw new Error("boom");
      delivered.push(msg.from);
      return { ok: true };
    },
  });
  // Make uid 1 the thrower via its `to`.
  msgs[0]!.to = "u1@x";
  const r = await poller.pollOnce();
  assert.equal(r.fetched, 2);
  assert.equal(r.failed, 1);
  assert.equal(r.delivered, 1);
  assert.deepEqual(seen, [2], "only the delivered message is marked seen");
});

test("client is always closed, even when fetch throws", async () => {
  let closed = 0;
  const poller = new MailInboundPoller({
    openClient: async () => ({
      async fetchUnseen(): Promise<RawInboundEmail[]> {
        throw new Error("imap down");
      },
      async markSeen() {},
      async close() {
        closed += 1;
      },
    }),
    resolveProject: async () => "prj_1",
    deliver: async () => ({ ok: true }),
  });
  await assert.rejects(() => poller.pollOnce(), /imap down/);
  assert.equal(closed, 1);
});

test("parseImapConfig: off when unset, parses defaults when host/user/pass set", () => {
  assert.equal(parseImapConfig({}), null);
  const cfg = parseImapConfig({
    MAILCOW_IMAP_HOST: "mail.cantila.app",
    MAILCOW_IMAP_USER: "info@cantila.app",
    MAILCOW_IMAP_PASS: "secret",
  });
  assert.deepEqual(cfg, {
    host: "mail.cantila.app",
    port: 993,
    secure: true,
    user: "info@cantila.app",
    pass: "secret",
    mailbox: "INBOX",
  });
});

test("createMailInboundPoller: null when not configured, poller when openClient injected", () => {
  const deps = {
    resolveProject: async () => null,
    deliver: async () => ({ ok: true }),
  };
  assert.equal(createMailInboundPoller(deps, {}), null);
  const injected = createMailInboundPoller(
    { ...deps, openClient: async () => ({ fetchUnseen: async () => [], markSeen: async () => {}, close: async () => {} }) },
    {},
  );
  assert.ok(injected instanceof MailInboundPoller);
});
