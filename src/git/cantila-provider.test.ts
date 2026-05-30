import { test } from "node:test";
import assert from "node:assert/strict";
import { mapTree, mapContent } from "./cantila-provider";

test("mapTree filters to blob/tree and keeps path+sha", () => {
  const out = mapTree({
    tree: [
      { path: "a.ts", type: "blob", sha: "s1" },
      { path: "dir", type: "tree", sha: "s2" },
      { path: "weird", type: "commit", sha: "s3" },
    ],
  });
  assert.deepEqual(out, [
    { path: "a.ts", type: "blob", sha: "s1" },
    { path: "dir", type: "tree", sha: "s2" },
  ]);
});

test("mapContent base64-decodes to UTF-8", () => {
  const c = mapContent({ content: Buffer.from("hi", "utf-8").toString("base64"), encoding: "base64", sha: "x" });
  assert.equal(c.content, "hi");
  assert.equal(c.sha, "x");
  assert.equal(c.encoding, "utf-8");
});
