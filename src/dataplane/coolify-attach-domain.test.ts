/* ============================================================
   CoolifyDataPlane.attachDomain — wire a custom hostname onto the
   tenant's Coolify application so its bundled Traefik starts routing
   the host and requests a Let's Encrypt cert for it.

   The flow:
     1. GET  /applications/{uuid}        — read the current fqdn list
     2. PATCH /applications/{uuid}        — domains = existing + new host
     3. POST /deploy?uuid={uuid}          — regenerate the proxy config
        so Traefik learns the new router + issues the cert.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";

import { CoolifyDataPlane } from "./coolify";
import type { Project } from "../domain/types";

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "prj_test123",
    accountId: "acc_test",
    slug: "demo",
    name: "demo",
    runtime: "node",
    region: "fsn1",
    status: "live",
    vcpu: 1,
    memoryMb: 1024,
    diskGb: 5,
    alwaysOn: false,
    autoSleep: true,
    desiredInstances: 1,
    minInstances: 1,
    maxInstances: 1,
    autoDeploy: false,
    platform: false,
    coolifyAppUuid: "app_uuid_1",
    createdAt: new Date().toISOString(),
    ...overrides,
  } as Project;
}

/** Fake fetch that returns the app's current fqdn on GET and echoes 200
 *  on everything else, recording every call for assertions. */
function withFakeFetch(fqdn: string): {
  calls: { url: string; method: string; body: unknown }[];
  restore: () => void;
} {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const method = String(init?.method ?? "GET");
    calls.push({
      url: String(url),
      method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const isAppGet = method === "GET" && /\/applications\/app_uuid_1$/.test(String(url));
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => (isAppGet ? { uuid: "app_uuid_1", fqdn } : { uuid: "app_uuid_1" }),
      text: async () => "{}",
    } as Response;
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

function makeDataPlane(): CoolifyDataPlane {
  return new CoolifyDataPlane({
    apiUrl: "http://coolify.test/api/v1",
    apiToken: "tok",
    serverUuid: "srv1",
    projectUuid: "proj1",
  });
}

test("attachDomain patches the app domains preserving the existing fqdn", async () => {
  const fake = withFakeFetch("https://demo.cantila.app");
  try {
    const dp = makeDataPlane();
    await dp.attachDomain(makeProject(), "app.example.com");

    const patch = fake.calls.find(
      (c) => c.method === "PATCH" && /\/applications\/app_uuid_1$/.test(c.url),
    );
    assert.ok(patch, "expected a PATCH to /applications/app_uuid_1");
    const domains = String((patch!.body as { domains?: string }).domains ?? "");
    assert.ok(
      domains.includes("https://app.example.com"),
      `new host missing from domains: ${domains}`,
    );
    assert.ok(
      domains.includes("https://demo.cantila.app"),
      `existing fqdn dropped from domains: ${domains}`,
    );
  } finally {
    fake.restore();
  }
});

test("attachDomain triggers a redeploy so Traefik issues the cert", async () => {
  const fake = withFakeFetch("https://demo.cantila.app");
  try {
    const dp = makeDataPlane();
    await dp.attachDomain(makeProject(), "app.example.com");

    const deploy = fake.calls.find(
      (c) => c.method === "POST" && /\/deploy\?uuid=app_uuid_1$/.test(c.url),
    );
    assert.ok(deploy, "expected a POST /deploy?uuid=app_uuid_1");
  } finally {
    fake.restore();
  }
});

test("attachDomain is idempotent when the host is already attached", async () => {
  const fake = withFakeFetch("https://demo.cantila.app,https://app.example.com");
  try {
    const dp = makeDataPlane();
    await dp.attachDomain(makeProject(), "app.example.com");

    const patch = fake.calls.find(
      (c) => c.method === "PATCH" && /\/applications\/app_uuid_1$/.test(c.url),
    );
    const domains = String((patch!.body as { domains?: string }).domains ?? "");
    const occurrences = domains.split(",").filter((d) => d.trim() === "https://app.example.com").length;
    assert.equal(occurrences, 1, `host duplicated: ${domains}`);
  } finally {
    fake.restore();
  }
});
