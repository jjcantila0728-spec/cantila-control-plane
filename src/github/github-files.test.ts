import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRepo } from "./github-files";

test("parseRepo handles https URL with .git suffix", () => {
  assert.deepEqual(parseRepo("https://github.com/acme/site.git"), { owner: "acme", repo: "site" });
});
test("parseRepo handles https URL without .git", () => {
  assert.deepEqual(parseRepo("https://github.com/acme/site"), { owner: "acme", repo: "site" });
});
test("parseRepo handles trailing slash", () => {
  assert.deepEqual(parseRepo("https://github.com/acme/site/"), { owner: "acme", repo: "site" });
});
test("parseRepo returns null for non-github or empty", () => {
  assert.equal(parseRepo(""), null);
  assert.equal(parseRepo("not a url"), null);
});
