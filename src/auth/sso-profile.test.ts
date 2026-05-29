import { test } from "node:test";
import assert from "node:assert/strict";
import { selectGithubPrimaryEmail } from "./sso-github";

test("selectGithubPrimaryEmail prefers verified primary", () => {
  const email = selectGithubPrimaryEmail([
    { email: "alt@x.io", primary: false, verified: true },
    { email: "Me@Example.com", primary: true, verified: true },
  ]);
  assert.equal(email, "me@example.com");
});

test("selectGithubPrimaryEmail rejects when no verified email", () => {
  const email = selectGithubPrimaryEmail([
    { email: "me@example.com", primary: true, verified: false },
  ]);
  assert.equal(email, null);
});
