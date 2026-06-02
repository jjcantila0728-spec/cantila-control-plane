import { test } from "node:test";
import assert from "node:assert/strict";

import { authorizeSuperuser } from "./superuser";
import type { SessionAuth } from "./account";

const base: SessionAuth = { userId: "usr_a", accountId: "acc_1", sessionId: "ses_1" };

test("no session → 401", () => {
  const d = authorizeSuperuser(undefined);
  assert.deepEqual(d, { ok: false, status: 401, error: "session required (Bearer cts_ token)" });
});

test("session without platformRole → 403", () => {
  const d = authorizeSuperuser(base);
  assert.equal(d.ok, false);
  assert.equal((d as { status: number }).status, 403);
});

test("tenant owner (no platformRole) is still rejected — platform scope != tenant scope", () => {
  // A tenant 'owner' has no platformRole; the guard must reject them.
  const d = authorizeSuperuser({ ...base });
  assert.equal(d.ok, false);
});

test("superadmin → ok", () => {
  const d = authorizeSuperuser({ ...base, platformRole: "superadmin" });
  assert.equal(d.ok, true);
  assert.equal((d as { ok: true; session: SessionAuth }).session.userId, "usr_a");
});

test("support is rejected by default (superadmin-only)", () => {
  const d = authorizeSuperuser({ ...base, platformRole: "support" });
  assert.equal(d.ok, false);
  assert.equal((d as { status: number }).status, 403);
});

test("support is allowed when explicitly in the allow-list (read routes)", () => {
  const d = authorizeSuperuser({ ...base, platformRole: "support" }, ["superadmin", "support"]);
  assert.equal(d.ok, true);
});
