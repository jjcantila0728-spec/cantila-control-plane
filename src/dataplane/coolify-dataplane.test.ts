/* ============================================================
   CoolifyDataPlane — deploy-time schema migration hook.
   Every deploy must (re)assert a `pre_deployment_command` on the
   Coolify app so the tenant's Prisma schema is applied to its
   freshly-provisioned Postgres BEFORE the new container serves
   traffic. Without it the app boots against an empty DB and every
   query throws P2021 ("table does not exist") — the crash this fixes.
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
    status: "provisioning",
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
    // Pre-known app uuid so startContainer skips the /applications scan
    // and the create path — we only exercise the deploy-time hook.
    coolifyAppUuid: "app_uuid_1",
    createdAt: new Date().toISOString(),
  } as Project;
}

function withFakeFetch(): {
  calls: { url: string; method: string; body: unknown }[];
  restore: () => void;
} {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({
      url: String(url),
      method: String(init?.method ?? "GET"),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ uuid: "app_uuid_1" }),
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

test("startContainer asserts a prisma-migrate pre_deployment_command on the app", async () => {
  const fake = withFakeFetch();
  try {
    const dp = makeDataPlane();
    await dp.startContainer(
      makeProject(),
      "coolify:pending",
      "srv1",
      { DATABASE_URL: "postgres://x" },
    );

    // A PATCH to the application itself (not /envs/bulk) carrying the
    // migrate command must be sent.
    const patch = fake.calls.find(
      (c) =>
        c.method === "PATCH" &&
        /\/applications\/app_uuid_1$/.test(c.url),
    );
    assert.ok(patch, "expected a PATCH to /applications/app_uuid_1");
    const cmd = String(
      (patch!.body as { pre_deployment_command?: string })
        .pre_deployment_command ?? "",
    );
    assert.match(cmd, /prisma/, "pre_deployment_command should run prisma");
    assert.match(cmd, /migrate deploy|db push/);
  } finally {
    fake.restore();
  }
});

test("the migrate hook is asserted before the deploy is triggered", async () => {
  const fake = withFakeFetch();
  try {
    const dp = makeDataPlane();
    await dp.startContainer(makeProject(), "coolify:pending", "srv1", {
      DATABASE_URL: "postgres://x",
    });
    const patchIdx = fake.calls.findIndex(
      (c) => c.method === "PATCH" && /\/applications\/app_uuid_1$/.test(c.url),
    );
    const deployIdx = fake.calls.findIndex((c) => c.url.includes("/deploy?"));
    assert.ok(patchIdx >= 0 && deployIdx >= 0);
    assert.ok(
      patchIdx < deployIdx,
      "migrate hook must be set before the deploy POST",
    );
  } finally {
    fake.restore();
  }
});
