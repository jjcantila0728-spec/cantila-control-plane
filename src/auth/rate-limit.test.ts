import { test } from "node:test";
import assert from "node:assert/strict";
import { createRateLimiter } from "./rate-limit";

test("allows up to max within the window, then blocks", () => {
  const allow = createRateLimiter({ windowMs: 1000, max: 3 });
  assert.equal(allow("ip1", 0), true);
  assert.equal(allow("ip1", 100), true);
  assert.equal(allow("ip1", 200), true);
  assert.equal(allow("ip1", 300), false);
  assert.equal(allow("ip2", 300), true);
});

test("resets after the window elapses", () => {
  const allow = createRateLimiter({ windowMs: 1000, max: 1 });
  assert.equal(allow("ip1", 0), true);
  assert.equal(allow("ip1", 500), false);
  assert.equal(allow("ip1", 1000), true);
});
