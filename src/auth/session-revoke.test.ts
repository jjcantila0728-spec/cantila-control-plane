import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryStore } from "../domain/store";

test("deleteSessionsByUser removes every session for that user", async () => {
  const store = new InMemoryStore();
  await store.createSession({
    id: "s1", userId: "u1", tokenHash: "h1",
    expiresAt: new Date(Date.now() + 1e6).toISOString(),
    createdAt: new Date().toISOString(),
  });
  await store.createSession({
    id: "s2", userId: "u1", tokenHash: "h2",
    expiresAt: new Date(Date.now() + 1e6).toISOString(),
    createdAt: new Date().toISOString(),
  });
  await store.createSession({
    id: "s3", userId: "u2", tokenHash: "h3",
    expiresAt: new Date(Date.now() + 1e6).toISOString(),
    createdAt: new Date().toISOString(),
  });
  const removed = await store.deleteSessionsByUser("u1");
  assert.equal(removed, 2);
  assert.equal(await store.findSessionByTokenHash("h1"), null);
  assert.ok(await store.findSessionByTokenHash("h3"));
});
