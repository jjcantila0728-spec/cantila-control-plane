import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveAccountId,
  resolveActorAccountId,
  NoAccountContextError,
} from "./account";

test("resolveAccountId throws when no principal or query account", () => {
  const req = { query: {} } as Parameters<typeof resolveAccountId>[0];
  assert.throws(() => resolveAccountId(req), NoAccountContextError);
});

test("resolveAccountId returns the api-key account when present", () => {
  const req = {
    query: {},
    apiKey: { accountId: "acc_real" },
  } as unknown as Parameters<typeof resolveAccountId>[0];
  assert.equal(resolveAccountId(req), "acc_real");
});

test("resolveAccountId prefers act-as over the api-key account", () => {
  const req = {
    query: {},
    actAs: "acc_sub",
    apiKey: { accountId: "acc_parent" },
  } as unknown as Parameters<typeof resolveAccountId>[0];
  assert.equal(resolveAccountId(req), "acc_sub");
});

test("resolveAccountId falls back to the session account", () => {
  const req = {
    query: {},
    session: { accountId: "acc_sess" },
  } as unknown as Parameters<typeof resolveAccountId>[0];
  assert.equal(resolveAccountId(req), "acc_sess");
});

test("resolveAccountId honours an explicit ?accountId= query", () => {
  const req = { query: { accountId: "acc_q" } } as unknown as Parameters<
    typeof resolveAccountId
  >[0];
  assert.equal(resolveAccountId(req), "acc_q");
});

test("resolveActorAccountId throws when no principal or query account", () => {
  const req = { query: {} } as Parameters<typeof resolveActorAccountId>[0];
  assert.throws(() => resolveActorAccountId(req), NoAccountContextError);
});

test("resolveActorAccountId ignores act-as (speaks in the caller's own name)", () => {
  const req = {
    query: {},
    actAs: "acc_sub",
    apiKey: { accountId: "acc_parent" },
  } as unknown as Parameters<typeof resolveActorAccountId>[0];
  assert.equal(resolveActorAccountId(req), "acc_parent");
});

test("resolveAccountId throws when a session has no accountId", () => {
  const req = {
    query: {},
    session: { userId: "usr_1", sessionId: "sess_1" },
  } as unknown as Parameters<typeof resolveAccountId>[0];
  assert.throws(() => resolveAccountId(req), NoAccountContextError);
});
