import { test } from "node:test";
import assert from "node:assert/strict";
import { workspaceDir, resolveInWorkspace } from "./workspace";
import path from "node:path";

test("workspaceDir nests under the root by project id", () => {
  const dir = workspaceDir("/tmp/projroot", "proj_123");
  assert.equal(dir, path.resolve("/tmp/projroot", "proj_123", "workspace"));
});

test("resolveInWorkspace allows a normal relative path", () => {
  const ws = workspaceDir("/tmp/projroot", "p1");
  const abs = resolveInWorkspace(ws, "src/app/page.tsx");
  assert.equal(abs, path.join(ws, "src/app/page.tsx"));
});

test("resolveInWorkspace rejects traversal and absolute paths", () => {
  const ws = workspaceDir("/tmp/projroot", "p1");
  assert.throws(() => resolveInWorkspace(ws, "../../etc/passwd"), /outside workspace/);
  assert.throws(() => resolveInWorkspace(ws, "/etc/passwd"), /outside workspace/);
});

test("workspaceDir rejects a projectId that escapes the root", () => {
  assert.throws(() => workspaceDir("/tmp/projroot", "../escape"), /invalid projectId/);
  assert.throws(() => workspaceDir("/tmp/projroot", "C:\\evil"), /invalid projectId/);
});

test("resolveInWorkspace allows an empty-segment edge and rejects bare workspace", () => {
  const ws = workspaceDir("/tmp/projroot", "p1");
  assert.throws(() => resolveInWorkspace(ws, ""), /outside workspace/);
  assert.throws(() => resolveInWorkspace(ws, "."), /outside workspace/);
});

test("resolveInWorkspace allows a file whose name starts with ..", () => {
  const ws = workspaceDir("/tmp/projroot", "p1");
  const abs = resolveInWorkspace(ws, "..foo");
  assert.equal(abs, path.join(ws, "..foo"));
});
