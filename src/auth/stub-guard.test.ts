import { test } from "node:test";
import assert from "node:assert/strict";
import { StubSsoProvider } from "./sso";

test("stub refuses to complete a login in production", async () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const stub = new StubSsoProvider();
    await assert.rejects(() => stub.completeLogin({ email: "x@y.io" }));
  } finally {
    process.env.NODE_ENV = prev;
  }
});

test("stub still works outside production", async () => {
  const stub = new StubSsoProvider();
  const p = await stub.completeLogin({ email: "x@y.io" });
  assert.equal(p.email, "x@y.io");
});
