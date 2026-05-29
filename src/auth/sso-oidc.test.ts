import { test } from "node:test";
import assert from "node:assert/strict";
import { emailFromVerifiedClaims } from "./sso-oidc";

test("accepts a verified email", () => {
  assert.equal(
    emailFromVerifiedClaims({ email: "A@X.com", email_verified: true }),
    "a@x.com",
  );
});

test("rejects an unverified email", () => {
  assert.throws(() =>
    emailFromVerifiedClaims({ email: "a@x.com", email_verified: false }),
  );
});

test("rejects a missing email", () => {
  assert.throws(() => emailFromVerifiedClaims({ email_verified: true }));
});
