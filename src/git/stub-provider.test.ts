import { test } from "node:test";
import assert from "node:assert/strict";
import { StubGitProvider } from "./stub-provider";

const repo = { owner: "acme", repo: "site" };

test("createRepo is idempotent and seeds default branch", async () => {
  const p = new StubGitProvider();
  const a = await p.createRepo({ owner: "acme", name: "site" });
  const b = await p.createRepo({ owner: "acme", name: "site" });
  assert.equal(a.defaultBranch, "main");
  assert.equal(b.cloneUrl, a.cloneUrl);
});

test("write then read round-trips and lists in the tree", async () => {
  const p = new StubGitProvider();
  await p.createRepo({ owner: "acme", name: "site" });
  const w = await p.writeFile(repo, { path: "src/a.ts", content: "hi", branch: "main" });
  assert.ok(w.sha);
  const r = await p.readFile(repo, "src/a.ts", "main");
  assert.equal(r.content, "hi");
  const tree = await p.listTree(repo, "main");
  assert.ok(tree.find((n) => n.path === "src/a.ts" && n.type === "blob"));
});

test("archive produces a real zip containing the written files", async () => {
  const { unzipSync, strFromU8 } = await import("fflate");
  const p = new StubGitProvider();
  await p.createRepo({ owner: "acme", name: "site" });
  await p.writeFile(repo, { path: "src/a.ts", content: "hi", branch: "main" });
  await p.writeFile(repo, { path: "readme.md", content: "# yo", branch: "main" });
  const { data, filename } = await p.archive(repo);
  assert.equal(filename, "site.zip");
  // PK zip magic
  assert.equal(data[0], 0x50);
  assert.equal(data[1], 0x4b);
  const files = unzipSync(data);
  assert.equal(strFromU8(files["src/a.ts"]), "hi");
  assert.equal(strFromU8(files["readme.md"]), "# yo");
});

test("delete removes the file", async () => {
  const p = new StubGitProvider();
  await p.createRepo({ owner: "acme", name: "site" });
  const w = await p.writeFile(repo, { path: "x.txt", content: "y", branch: "main" });
  await p.deleteFile(repo, { path: "x.txt", sha: w.sha, branch: "main" });
  await assert.rejects(() => p.readFile(repo, "x.txt", "main"));
});
