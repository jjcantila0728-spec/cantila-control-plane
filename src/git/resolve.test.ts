import { test } from "node:test";
import assert from "node:assert/strict";
import { orgNameForAccount, repoRefFor } from "./resolve";

test("orgNameForAccount uses handle when present", () => {
  assert.equal(orgNameForAccount({ handle: "cantila", id: "acc_1" }), "cantila");
});
test("orgNameForAccount falls back to acct-<id>", () => {
  assert.equal(orgNameForAccount({ handle: "", id: "acc_1" }), "acct-acc_1");
});
test("repoRefFor derives cantila owner/repo from handle+slug", () => {
  const ref = repoRefFor(
    { repoHost: "cantila", repoUrl: "stub://git/cantila/homes.git", slug: "homes" },
    { handle: "cantila", id: "acc_1" },
  );
  assert.deepEqual(ref, { owner: "cantila", repo: "homes" });
});
test("repoRefFor parses github repoUrl", () => {
  const ref = repoRefFor(
    { repoHost: "github", repoUrl: "https://github.com/acme/site.git", slug: "site" },
    { handle: "acme", id: "acc_2" },
  );
  assert.deepEqual(ref, { owner: "acme", repo: "site" });
});
