import { test } from "node:test";
import assert from "node:assert/strict";

import { defaultProjectMailbox } from "./default-mailbox";

test("default mailbox points at the real MTA host", () => {
  const mb = defaultProjectMailbox("acme");
  assert.equal(mb.address, "info@acme.cantila.app");
  assert.equal(mb.sendingDomain, "acme.cantila.app");
  assert.equal(mb.smtpUser, "info@acme.cantila.app");
  // smtp.cantila.app resolves to the APP server, not the MTA — must be mail.cantila.app.
  assert.equal(mb.smtpHost, "mail.cantila.app");
});
