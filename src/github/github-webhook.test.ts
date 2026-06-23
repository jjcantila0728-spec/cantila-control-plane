/* ============================================================
   registerPushWebhook — idempotently install a "push" webhook on a
   GitHub repo so pushes hit Cantila's receiver and auto-deploy fires.
   Network is stubbed; we assert the GitHub REST calls + idempotency.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";

import { registerPushWebhook } from "./github-files";

type Call = { url: string; method: string; body: unknown };

/** Stub global fetch with a scripted router; record every call. */
function withFetch(
  route: (call: Call) => { status: number; json: unknown },
): { calls: Call[]; restore: () => void } {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const call: Call = {
      url: String(url),
      method: String(init?.method ?? "GET"),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const { status, json } = route(call);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(json),
    } as Response;
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

test("registerPushWebhook creates a push hook when none exists", async () => {
  const { calls, restore } = withFetch((c) => {
    if (c.method === "GET") return { status: 200, json: [] };
    return { status: 201, json: { id: 123 } };
  });
  try {
    const result = await registerPushWebhook(
      { owner: "acme", repo: "site" },
      "ghp_token",
      { url: "https://api.cantila.app/v1/projects/prj_1/git/webhook", secret: "s3cr3t" },
    );
    assert.deepEqual(result, { hookId: 123, created: true });

    const post = calls.find((c) => c.method === "POST");
    assert.ok(post, "expected a POST to create the hook");
    assert.match(post.url, /\/repos\/acme\/site\/hooks$/);
    const body = post.body as {
      events: string[];
      active: boolean;
      config: { url: string; secret: string; content_type: string };
    };
    assert.deepEqual(body.events, ["push"]);
    assert.equal(body.active, true);
    assert.equal(body.config.url, "https://api.cantila.app/v1/projects/prj_1/git/webhook");
    assert.equal(body.config.secret, "s3cr3t");
    assert.equal(body.config.content_type, "json");
  } finally {
    restore();
  }
});

test("registerPushWebhook updates the existing hook instead of duplicating", async () => {
  const existingUrl = "https://api.cantila.app/v1/projects/prj_1/git/webhook";
  const { calls, restore } = withFetch((c) => {
    if (c.method === "GET")
      return { status: 200, json: [{ id: 99, config: { url: existingUrl } }] };
    return { status: 200, json: { id: 99 } };
  });
  try {
    const result = await registerPushWebhook(
      { owner: "acme", repo: "site" },
      "ghp_token",
      { url: existingUrl, secret: "rotated" },
    );
    assert.deepEqual(result, { hookId: 99, created: false });

    const patch = calls.find((c) => c.method === "PATCH");
    assert.ok(patch, "expected a PATCH to update the existing hook");
    assert.match(patch.url, /\/repos\/acme\/site\/hooks\/99$/);
    assert.equal(calls.filter((c) => c.method === "POST").length, 0, "must not POST a duplicate");
  } finally {
    restore();
  }
});

test("registerPushWebhook throws GithubError on a non-github repo URL it cannot parse", async () => {
  await assert.rejects(
    registerPushWebhook(
      { owner: "", repo: "" },
      "ghp_token",
      { url: "https://x/webhook", secret: "s" },
    ),
  );
});
