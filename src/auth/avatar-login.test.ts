/* ============================================================
   Social-login avatar threading (refresh-if-empty) — smoke/regression.

   When tests run, `.env` is NOT loaded, so the SSO provider registry
   falls back to the bundled STUB provider, which trusts the passed
   `email` and returns NO avatar. So these tests are a smoke/regression
   guard that (a) social login still works end-to-end through the stub,
   and (b) a stored avatar is not clobbered by a later login. The real
   avatar-capture path is verified by a live smoke later.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";

import { ControlPlane } from "../core/control-plane";
import { InMemoryStore } from "../domain/store";
import { stubProvisioner, stubDataPlane } from "../dataplane/stub";
import { StubStripeAdapter } from "../billing/stripe";
import { RuleBasedAiAnalyser } from "../ai/analyser";

function makeCp(): { cp: ControlPlane; store: InMemoryStore } {
  const store = new InMemoryStore();
  const cp = new ControlPlane({
    store,
    provisioner: stubProvisioner,
    dataPlane: stubDataPlane,
    stripe: new StubStripeAdapter(),
    aiAnalyser: new RuleBasedAiAnalyser(),
  });
  return { cp, store };
}

test("social login still works through the stub and creates the user", async () => {
  const { cp, store } = makeCp();
  const res = await cp.loginWithSso({ provider: "google", email: "a@b.io" });
  assert.ok("token" in res, JSON.stringify(res));
  assert.ok(await store.findUserByEmail("a@b.io"));
});

test("a stored avatar is not overwritten by a later login (refresh-if-empty)", async () => {
  const { cp, store } = makeCp();
  await cp.loginWithSso({ provider: "google", email: "c@d.io" });
  const u = await store.findUserByEmail("c@d.io");
  assert.ok(u);
  await store.setUserAvatarUrl(u.id, "https://img/original.png");
  await cp.loginWithSso({ provider: "google", email: "c@d.io" });
  const after = await store.findUserByEmail("c@d.io");
  assert.equal(after?.avatarUrl, "https://img/original.png");
});
