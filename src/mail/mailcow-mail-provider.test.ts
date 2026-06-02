/* ============================================================
   MailcowMailProvider — real send/receive adapter for the
   `MailProvider` port (plan §4.4 / §17.2). Outbound is SMTP
   submission (nodemailer); inbound + status parse the JSON the
   MTA webhook delivers (same contract the stub honours).

   These tests inject a fake SMTP transport so nothing touches the
   network. The factory's env-gating is exercised with an injected
   env object.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MailcowMailProvider,
  createMailcowMailProvider,
} from "./mailcow-mail-provider";
import type { SendMailInput } from "./provider";

const SEND: SendMailInput = {
  from: "info@cantila.app",
  to: "someone@example.com",
  subject: "Hi",
  body: "hello world",
};

test("label/live mark it as a real MTA", () => {
  const p = new MailcowMailProvider({
    transport: { sendMail: async () => ({ messageId: "x" }) },
  });
  assert.equal(p.label, "Mailcow");
  assert.equal(p.live, true);
});

test("sendMail submits via the transport and returns the queued ack (no stubTerminal)", async () => {
  let seen: unknown;
  const p = new MailcowMailProvider({
    transport: {
      sendMail: async (m) => {
        seen = m;
        return { messageId: "<abc@mail.cantila.app>" };
      },
    },
  });
  const res = await p.sendMail(SEND);
  assert.equal(res.accepted, true);
  assert.equal(res.providerMessageId, "<abc@mail.cantila.app>");
  // Live MTA must NOT short-circuit the terminal — it arrives via webhook.
  assert.equal(res.stubTerminal, undefined);
  assert.deepEqual(seen, {
    from: "info@cantila.app",
    to: "someone@example.com",
    subject: "Hi",
    text: "hello world",
  });
});

test("sendMail returns accepted:false when the transport throws", async () => {
  const p = new MailcowMailProvider({
    transport: {
      sendMail: async () => {
        throw new Error("connection refused");
      },
    },
  });
  const res = await p.sendMail(SEND);
  assert.equal(res.accepted, false);
});

test("parseInbound normalizes a JSON webhook payload", () => {
  const p = new MailcowMailProvider({
    transport: { sendMail: async () => ({ messageId: "x" }) },
  });
  const msg = p.parseInbound(
    JSON.stringify({ to: "info@cantila.app", from: "a@b.com", subject: "S", body: "B" }),
  );
  assert.equal(msg.to, "info@cantila.app");
  assert.equal(msg.from, "a@b.com");
  assert.equal(msg.subject, "S");
  assert.throws(() => p.parseInbound(JSON.stringify({ to: "x@y.com" })), /to.*from|from/);
});

test("parseStatusUpdate normalizes a terminal webhook and rejects bad kinds", () => {
  const p = new MailcowMailProvider({
    transport: { sendMail: async () => ({ messageId: "x" }) },
  });
  const u = p.parseStatusUpdate(
    JSON.stringify({ providerMessageId: "m1", kind: "bounced", diagnostic: "5.1.1" }),
  );
  assert.equal(u.providerMessageId, "m1");
  assert.equal(u.kind, "bounced");
  assert.throws(() =>
    p.parseStatusUpdate(JSON.stringify({ providerMessageId: "m1", kind: "sent" })),
  );
});

test("createMailcowMailProvider is env-gated", () => {
  assert.equal(createMailcowMailProvider({}), null, "no env → null (falls back to stub)");
  const p = createMailcowMailProvider({
    MAILCOW_SMTP_HOST: "mail.cantila.app",
    MAILCOW_SMTP_USER: "info@cantila.app",
    MAILCOW_SMTP_PASS: "secret",
  } as NodeJS.ProcessEnv);
  assert.ok(p, "full env → instance");
  assert.equal(p!.live, true);
});
