import { test } from "node:test";
import assert from "node:assert/strict";

import { verifyMailInboundSecret } from "./inbound-webhook-auth";

test("verifyMailInboundSecret accepts a matching secret", () => {
  assert.equal(verifyMailInboundSecret("s3cret", "s3cret"), true);
});

test("verifyMailInboundSecret rejects a mismatched secret", () => {
  assert.equal(verifyMailInboundSecret("nope", "s3cret"), false);
});

test("verifyMailInboundSecret rejects a missing presented header when one is configured", () => {
  assert.equal(verifyMailInboundSecret(undefined, "s3cret"), false);
  assert.equal(verifyMailInboundSecret("", "s3cret"), false);
});

test("verifyMailInboundSecret is open (returns true) when no secret is configured", () => {
  // Dev/test posture: with MAIL_INBOUND_WEBHOOK_SECRET unset the route stays
  // open so the offline flow and existing tests are unchanged.
  assert.equal(verifyMailInboundSecret(undefined, ""), true);
  assert.equal(verifyMailInboundSecret("anything", ""), true);
});

test("verifyMailInboundSecret is length-safe (no throw on differing lengths)", () => {
  assert.equal(verifyMailInboundSecret("short", "a-much-longer-secret"), false);
  assert.equal(verifyMailInboundSecret("a-much-longer-presented", "x"), false);
});
