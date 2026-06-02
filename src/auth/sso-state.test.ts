/* SSO state-binding regression.
 *
 * The control plane mints the PKCE codeVerifier; it must keep it
 * server-side keyed by `state`, and when a login presents a `state`
 * it must (a) match a live server-side flight, (b) be single-use, and
 * (c) use the SERVER's verifier — never a client-supplied one. This
 * closes the login-CSRF / code-injection gap at the security boundary. */

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

test("a valid state from beginSsoLogin completes the login", async () => {
  const cp = makeCp();
  const begin = cp.beginSsoLogin("google", "https://app.cantila.app/cb");
  const res = await cp.loginWithSso({
    provider: "google",
    email: "x@y.io",
    state: begin.state,
  });
  assert.ok("token" in res, JSON.stringify(res));
});

test("a state is single-use — replay is rejected", async () => {
  const cp = makeCp();
  const begin = cp.beginSsoLogin("google", "https://app.cantila.app/cb");
  const first = await cp.loginWithSso({
    provider: "google",
    email: "x@y.io",
    state: begin.state,
  });
  assert.ok("token" in first);
  const replay = await cp.loginWithSso({
    provider: "google",
    email: "x@y.io",
    state: begin.state,
  });
  assert.ok("error" in replay, "replay of a consumed state must fail");
});

test("an unknown/forged state is rejected", async () => {
  const cp = makeCp();
  const res = await cp.loginWithSso({
    provider: "google",
    email: "x@y.io",
    state: "deadbeefdeadbeef",
  });
  assert.ok("error" in res, "forged state must fail");
});

test("a state minted for one provider cannot be used for another", async () => {
  const cp = makeCp();
  const begin = cp.beginSsoLogin("google", "https://app.cantila.app/cb");
  const res = await cp.loginWithSso({
    provider: "github",
    email: "x@y.io",
    state: begin.state,
  });
  assert.ok("error" in res, "provider mismatch must fail");
});
