import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DeployBridge, defaultWalk } from "./deploy-bridge";
import { StubGitProvider } from "../git/stub-provider";

function fakeCp(project: any) {
  const calls: any = { deploy: 0, deployArg: null };
  return {
    calls,
    ensureProjectRepo: async () => project,
    getAccount: async () => ({ id: project?.accountId ?? "acc", handle: "shop" }),
    deploy: async (_id: string, opts: any) => { calls.deploy++; calls.deployArg = opts; return { ok: true }; },
  };
}
const deps = (cp: any, files: { path: string; content: string }[]) => ({
  cp,
  providerFor: () => new StubGitProvider(),
  repoRef: (p: any) => ({ owner: "shop", repo: p.slug }),
  walk: async () => files,
});

test("publish provisions repo, writes files, deploys, returns liveUrl", async () => {
  const project = { id: "p1", accountId: "acc", slug: "coffee", repoUrl: "https://git.cantila.app/shop/coffee.git", repoHost: "cantila", branch: "main" };
  const cp = fakeCp(project);
  const bridge = new DeployBridge(deps(cp, [{ path: "index.html", content: "<h1>hi</h1>" }, { path: "app.js", content: "1" }]) as any);
  const events: any[] = [];
  const res = await bridge.publish({ projectId: "p1", workspaceDir: "/ws", onEvent: (e: any) => events.push(e) });
  assert.equal(res.deployed, true);
  assert.equal(cp.calls.deploy, 1);
  assert.equal(cp.calls.deployArg.source.kind, "git");
  assert.match(res.liveUrl ?? "", /coffee\.cantila\.app/);
});

test("repo-less project (git backend offline) does NOT deploy", async () => {
  const cp = fakeCp({ id: "p1", accountId: "acc", slug: "coffee", repoUrl: undefined });
  const bridge = new DeployBridge(deps(cp, [{ path: "index.html", content: "x" }]) as any);
  const res = await bridge.publish({ projectId: "p1", workspaceDir: "/ws", onEvent: () => {} });
  assert.equal(res.deployed, false);
  assert.equal(cp.calls.deploy, 0);
  assert.match(res.detail, /offline|repo-less|no repo/i);
});

test("null project (not found) does not deploy", async () => {
  const cp = fakeCp(null);
  const bridge = new DeployBridge(deps(cp, []) as any);
  const res = await bridge.publish({ projectId: "missing", workspaceDir: "/ws", onEvent: () => {} });
  assert.equal(res.deployed, false);
  assert.equal(cp.calls.deploy, 0);
});

test("empty workspace refuses to deploy an empty tree (no silent ship)", async () => {
  const project = { id: "p1", accountId: "acc", slug: "coffee", repoUrl: "https://git.cantila.app/shop/coffee.git", repoHost: "cantila", branch: "main" };
  const cp = fakeCp(project);
  const bridge = new DeployBridge(deps(cp, []) as any);
  const res = await bridge.publish({ projectId: "p1", workspaceDir: "/ws", onEvent: () => {} });
  assert.equal(res.deployed, false);
  assert.equal(cp.calls.deploy, 0);
  assert.match(res.detail, /empty tree|no files/i);
});

test("defaultWalk pushes text/large files but skips binary (utf-8-only push)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "dw-"));
  await mkdir(path.join(dir, "lib"), { recursive: true });
  await writeFile(path.join(dir, "index.ts"), "export const x = 1;\n", "utf8");
  // A 700KB lib file — the old 512KB cap would have silently dropped this.
  await writeFile(path.join(dir, "lib", "big.ts"), "// big\n" + "a".repeat(700 * 1024), "utf8");
  // A binary file (contains NUL) — must be skipped, not corrupted.
  await writeFile(path.join(dir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
  const files = await defaultWalk(dir);
  const paths = files.map((f) => f.path).sort();
  assert.deepEqual(paths, ["index.ts", "lib/big.ts"]);
  assert.equal(files.find((f) => f.path === "lib/big.ts")?.content.length, 7 + 700 * 1024);
});
