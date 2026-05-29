import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { derivePkceChallenge } from "./pkce";

test("derivePkceChallenge is base64url sha256 of the verifier", () => {
  const verifier = "abc123";
  const expected = createHash("sha256").update(verifier).digest("base64url");
  assert.equal(derivePkceChallenge(verifier), expected);
});
