/* ============================================================
   CoolifyServiceProvisioner — unit tests (offline, fetch mocked).
   Verifies the real-Postgres provisioning path: the right Coolify
   endpoint + body, that the returned `internal_db_url` becomes the
   connection URI, the no-url failure mode, mailbox delegation, and
   env-gated selection.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CoolifyServiceProvisioner,
  selectProvisioner,
} from "./coolify-provisioner";
import { stubProvisioner } from "./stub";
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
    createdAt: new Date().toISOString(),
    ...overrides,
  } as Project;
}

/** Install a fake global fetch that records calls and returns `body`. */
function withFakeFetch(
  body: unknown,
  status = 201,
): { calls: { url: string; init: RequestInit }[]; restore: () => void } {
  const calls: { url: string; init: RequestInit }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: "",
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response;
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

test("createDatabase posts to /databases/postgresql and returns internal_db_url", async () => {
  const internal =
    "postgres://postgres:secretpw@dbuuid123:5432/postgres";
  const fake = withFakeFetch({ uuid: "dbuuid123", internal_db_url: internal });
  try {
    const prov = new CoolifyServiceProvisioner({
      apiUrl: "http://coolify.test/api/v1",
      apiToken: "tok",
      serverUuid: "srv1",
      projectUuid: "proj1",
    });
    const result = await prov.createDatabase(makeProject());

    assert.equal(result.engine, "postgres");
    assert.equal(result.connectionUri, internal);
    assert.equal(fake.calls.length, 1);
    const call = fake.calls[0]!;
    assert.ok(call.url.endsWith("/databases/postgresql"), call.url);
    assert.equal(call.init.method, "POST");
    const sent = JSON.parse(String(call.init.body));
    assert.equal(sent.server_uuid, "srv1");
    assert.equal(sent.project_uuid, "proj1");
    assert.equal(sent.environment_name, "production");
    assert.equal(sent.instant_deploy, true);
    assert.equal(sent.name, "cantila-prj_test123-db");
  } finally {
    fake.restore();
  }
});

test("createDatabase throws when Coolify returns no internal_db_url", async () => {
  const fake = withFakeFetch({ uuid: "dbuuid123" });
  try {
    const prov = new CoolifyServiceProvisioner({
      apiUrl: "http://coolify.test/api/v1",
      apiToken: "tok",
      serverUuid: "srv1",
      projectUuid: "proj1",
    });
    await assert.rejects(
      () => prov.createDatabase(makeProject()),
      /no internal_db_url/,
    );
  } finally {
    fake.restore();
  }
});

test("createDatabase routes to a region's server/project when configured", async () => {
  const fake = withFakeFetch({
    uuid: "db2",
    internal_db_url: "postgres://postgres:pw@db2:5432/postgres",
  });
  try {
    const prov = new CoolifyServiceProvisioner({
      apiUrl: "http://coolify.test/api/v1",
      apiToken: "tok",
      serverUuid: "srv-default",
      projectUuid: "proj-default",
      regions: {
        ash: { serverUuid: "srv-ash", projectUuid: "proj-ash" },
      },
    });
    await prov.createDatabase(makeProject({ region: "ash" }));
    const sent = JSON.parse(String(fake.calls[0]!.init.body));
    assert.equal(sent.server_uuid, "srv-ash");
    assert.equal(sent.project_uuid, "proj-ash");
  } finally {
    fake.restore();
  }
});

test("createMailbox delegates to the mailbox provisioner (stub by default)", async () => {
  const prov = new CoolifyServiceProvisioner({
    apiUrl: "http://coolify.test/api/v1",
    apiToken: "tok",
    serverUuid: "srv1",
    projectUuid: "proj1",
  });
  const mailbox = await prov.createMailbox(makeProject());
  const stubbed = await stubProvisioner.createMailbox(makeProject());
  // Same shape/host as the stub — proves delegation rather than a real call.
  assert.equal(mailbox.smtpHost, stubbed.smtpHost);
  assert.ok(mailbox.address.includes("demo"));
});

test("selectProvisioner returns stub without Coolify env, live with it", () => {
  assert.equal(selectProvisioner({}).live, false);
  assert.equal(selectProvisioner({}).provisioner, stubProvisioner);

  const live = selectProvisioner({
    COOLIFY_API_URL: "http://coolify.test/api/v1",
    COOLIFY_API_TOKEN: "tok",
    COOLIFY_SERVER_UUID: "srv1",
    COOLIFY_PROJECT_UUID: "proj1",
  } as NodeJS.ProcessEnv);
  assert.equal(live.live, true);
  assert.ok(live.provisioner instanceof CoolifyServiceProvisioner);
});
