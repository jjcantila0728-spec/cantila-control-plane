import { test } from "node:test";
import assert from "node:assert/strict";
import { loadQuery } from "./sdk";

test("loadQuery returns a function (SDK installed) or null", () => {
  const q = loadQuery();
  assert.ok(q === null || typeof q === "function");
});
