import { test } from "node:test";
import assert from "node:assert/strict";
import { selectGithubPrimaryEmail } from "./sso-github";

test("prefers the verified primary email", () => {
  const got = selectGithubPrimaryEmail([
    { email: "alt@x.com", primary: false, verified: true },
    { email: "main@x.com", primary: true, verified: true },
  ]);
  assert.equal(got, "main@x.com");
});

test("falls back to any verified email when no verified primary", () => {
  const got = selectGithubPrimaryEmail([
    { email: "main@x.com", primary: true, verified: false },
    { email: "alt@x.com", primary: false, verified: true },
  ]);
  assert.equal(got, "alt@x.com");
});

test("returns null when nothing is verified", () => {
  const got = selectGithubPrimaryEmail([
    { email: "main@x.com", primary: true, verified: false },
  ]);
  assert.equal(got, null);
});
