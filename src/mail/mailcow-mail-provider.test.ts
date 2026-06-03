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

test("sendMail uses a per-mailbox transport when auth is provided", async () => {
  const seen: Array<{ user: string; msgFrom: string }> = [];
  const p = new MailcowMailProvider({
    transport: { sendMail: async () => ({ messageId: "env" }) },
    makeTransport: (auth) => ({
      sendMail: async (m) => {
        seen.push({ user: auth.user, msgFrom: m.from });
        return { messageId: `per:${auth.user}` };
      },
    }),
  });
  const res = await p.sendMail({
    from: "info@acme.cantila.app",
    to: "x@y.com",
    subject: "S",
    body: "B",
    auth: { host: "mail.cantila.app", user: "info@acme.cantila.app", pass: "pw" },
  });
  assert.equal(res.accepted, true);
  assert.equal(res.providerMessageId, "per:info@acme.cantila.app");
  assert.deepEqual(seen, [
    { user: "info@acme.cantila.app", msgFrom: "info@acme.cantila.app" },
  ]);
});

test("sendMail falls back to the env transport when no auth is given", async () => {
  let used = "";
  const p = new MailcowMailProvider({
    transport: {
      sendMail: async () => {
        used = "env";
        return { messageId: "env" };
      },
    },
    makeTransport: () => ({
      sendMail: async () => {
        used = "per";
        return { messageId: "per" };
      },
    }),
  });
  await p.sendMail({ from: "noreply@cantila.app", to: "x@y.com" });
  assert.equal(used, "env");
});

test("per-mailbox transports are cached by user", async () => {
  let builds = 0;
  const p = new MailcowMailProvider({
    transport: { sendMail: async () => ({ messageId: "env" }) },
    makeTransport: () => {
      builds++;
      return { sendMail: async () => ({ messageId: "m" }) };
    },
  });
  const auth = { host: "mail.cantila.app", user: "info@acme.cantila.app", pass: "pw" };
  await p.sendMail({ from: "info@acme.cantila.app", to: "a@b.com", auth });
  await p.sendMail({ from: "info@acme.cantila.app", to: "c@d.com", auth });
  assert.equal(builds, 1);
  const auth2 = { host: "mail.cantila.app", user: "other@acme.cantila.app", pass: "pw2" };
  await p.sendMail({ from: "other@acme.cantila.app", to: "e@f.com", auth: auth2 });
  assert.equal(builds, 2); // a different user triggers a fresh transport build
});
