import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { derivePkceChallenge, verifyPkceS256 } from "./pkce";

test("derivePkceChallenge is base64url sha256 of the verifier", () => {
  const verifier = "abc123";
  const expected = createHash("sha256").update(verifier).digest("base64url");
  assert.equal(derivePkceChallenge(verifier), expected);
});

test("verifyPkceS256 accepts a correct verifier and rejects mismatches", () => {
  const verifier = "the-verifier-value-" + "x".repeat(40);
  const challenge = derivePkceChallenge(verifier);
  assert.equal(verifyPkceS256(verifier, challenge), true);
  assert.equal(verifyPkceS256("a-different-verifier", challenge), false);
  // A challenge of a different length must not throw — just be false.
  assert.equal(verifyPkceS256(verifier, "short"), false);
});
