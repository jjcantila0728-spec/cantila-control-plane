/* The MCP OAuth connector mints its access token via the existing session
 * layer. This verifies the public delegator returns a real, resolvable
 * `cts_` session for the consenting user. */
import { test } from "node:test";
import assert from "node:assert/strict";

import { ControlPlane } from "../core/control-plane";
import { InMemoryStore } from "../domain/store";
import { stubProvisioner, stubDataPlane } from "../dataplane/stub";
import { StubStripeAdapter } from "../billing/stripe";
import { RuleBasedAiAnalyser } from "../ai/analyser";

function makeCp(): ControlPlane {
  return new ControlPlane({
    store: new InMemoryStore(),
    provisioner: stubProvisioner,
    dataPlane: stubDataPlane,
    stripe: new StubStripeAdapter(),
    aiAnalyser: new RuleBasedAiAnalyser(),
  });
}

test("mintSessionForOAuth returns a resolvable cts_ session for the user", async () => {
  const cp = makeCp();
  const reg = await cp.registerUser({
    email: "o@example.com",
    password: "password-123",
    name: "O",
  });
  assert.ok("user" in reg, JSON.stringify(reg));

  const { token } = await cp.mintSessionForOAuth(reg.user.id);
  assert.match(token, /^cts_/);

  const resolved = await cp.resolveSession(token);
  assert.ok(resolved, "session should resolve");
  assert.equal(resolved.user.id, reg.user.id);
});
