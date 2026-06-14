/* ============================================================
   Deploy-pipeline fixes that un-break crashing products and make
   crash reasons visible to the deploying agent:

     A. docker-compose apps must set their domain via
        `docker_compose_domains` — Coolify 422s on `domains` for
        compose apps ("The domains field cannot be used for
        dockercompose applications").
     B. Nixpacks Node builds must keep devDependencies — Nixpacks'
        default NODE_ENV=production drops typescript/webpack/vite and
        the build fails.
     C. A failed health check records WHY (container status + log tail)
        instead of a bare "verify-failed".
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CoolifyDataPlane,
  domainCreateFields,
  firstComposeService,
  nixpacksBuildEnv,
} from "./coolify";
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
    createdAt: new Date().toISOString(),
    ...overrides,
  } as Project;
}

// --- A: domain field selection (pure) --------------------------------

test("domainCreateFields: single-container apps use the `domains` field", () => {
  const f = domainCreateFields({
    buildPack: "nixpacks",
    fqdn: "https://demo.cantila.app",
    composeService: null,
  });
  assert.deepEqual(f, { domains: "https://demo.cantila.app" });
});

test("domainCreateFields: compose apps map the fqdn to a service, never send `domains`", () => {
  const f = domainCreateFields({
    buildPack: "dockercompose",
    fqdn: "https://demo.cantila.app",
    composeService: "web",
  });
  assert.ok(!("domains" in f), "compose apps must not send `domains` (Coolify 422s)");
  assert.deepEqual(f.docker_compose_domains, [
    { name: "web", domain: "https://demo.cantila.app" },
  ]);
});

test("domainCreateFields: compose app with unknown service omits domains (still avoids the 422)", () => {
  const f = domainCreateFields({
    buildPack: "dockercompose",
    fqdn: "https://demo.cantila.app",
    composeService: null,
  });
  assert.deepEqual(f, {});
});

// --- A: compose service discovery (pure) -----------------------------

test("firstComposeService prefers the service that publishes ports", () => {
  const yaml = [
    "services:",
    "  db:",
    "    image: postgres:16",
    "  web:",
    "    build: .",
    "    ports:",
    '      - "3000:3000"',
    "",
  ].join("\n");
  assert.equal(firstComposeService(yaml), "web");
});

test("firstComposeService falls back to the first service when none publish ports", () => {
  const yaml = "services:\n  app:\n    image: x\n  worker:\n    image: y\n";
  assert.equal(firstComposeService(yaml), "app");
});

test("firstComposeService tolerates comments and blank lines", () => {
  const yaml = [
    "# my stack",
    "version: '3.9'",
    "",
    "services:",
    "  # the api",
    "  api:",
    "    ports: ['8080:8080']",
    "networks:",
    "  default:",
  ].join("\n");
  assert.equal(firstComposeService(yaml), "api");
});

test("firstComposeService returns null when there is no services block", () => {
  assert.equal(firstComposeService("version: '3'\n"), null);
});

// --- B: Nixpacks build env (pure) ------------------------------------

test("nixpacksBuildEnv forces devDependencies for nixpacks builds", () => {
  const e = nixpacksBuildEnv("nixpacks");
  assert.equal(e.NPM_CONFIG_PRODUCTION, "false");
});

test("nixpacksBuildEnv is empty for Dockerfile / compose builds (they own their install)", () => {
  assert.deepEqual(nixpacksBuildEnv("dockerfile"), {});
  assert.deepEqual(nixpacksBuildEnv("dockercompose"), {});
});

// --- C: crash diagnosis ----------------------------------------------

test("diagnoseCrash returns a human reason naming the unreachable URL", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => [],
      text: async () => "",
    }) as Response) as typeof fetch;
  try {
    const dp = new CoolifyDataPlane({
      apiUrl: "http://coolify.test/api/v1",
      apiToken: "t",
      serverUuid: "s",
      projectUuid: "p",
    });
    const reason = await dp.diagnoseCrash(makeProject(), "https://demo.cantila.app");
    assert.ok(
      reason && reason.includes("https://demo.cantila.app"),
      `expected the URL in the reason, got: ${reason}`,
    );
  } finally {
    globalThis.fetch = original;
  }
});

// --- A: end-to-end create body for a compose Gitea project -----------

test("startContainer creates a compose app with docker_compose_domains and never `domains`", async () => {
  const calls: { url: string; method: string; body: any }[] = [];
  const compose = "services:\n  web:\n    build: .\n    ports: ['3000:3000']\n";
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const u = String(url);
    const method = String(init?.method ?? "GET");
    calls.push({
      url: u,
      method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    // Gitea raw compose file
    if (/\/raw\/docker-compose\.yml/.test(u)) {
      return { ok: true, status: 200, text: async () => compose } as Response;
    }
    // App lookup → none exist yet (force a create)
    if (method === "GET" && /\/applications$/.test(u)) {
      return { ok: true, status: 200, json: async () => [], text: async () => "[]" } as Response;
    }
    // Deployment poll → finished
    if (method === "GET" && /\/deployments\//.test(u)) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: "finished" }),
        text: async () => "{}",
      } as Response;
    }
    // Everything else (POST /security/keys, POST create, PATCHes, POST /deploy)
    return {
      ok: true,
      status: 200,
      json: async () => ({ uuid: "app_new", deployment_uuid: "dep_1" }),
      text: async () => "{}",
    } as Response;
  }) as typeof fetch;

  try {
    const dp = new CoolifyDataPlane({
      apiUrl: "http://coolify.test/api/v1",
      apiToken: "t",
      serverUuid: "s",
      projectUuid: "p",
      giteaApiUrl: "https://git.cantila.test",
      giteaToken: "gtok",
    });
    const project = makeProject({
      slug: "gritsync",
      buildPack: "dockercompose",
      repoHost: "cantila",
      repoUrl: "https://git.cantila.test/cantila/gritsync.git",
      branch: "main",
    });
    await dp.startContainer(project, "coolify:pending", "s", {});

    const create = calls.find(
      (c) => c.method === "POST" && /\/applications\/private-deploy-key$/.test(c.url),
    );
    assert.ok(create, "expected a create via /applications/private-deploy-key");
    assert.ok(
      !("domains" in (create!.body ?? {})),
      `compose create must not send 'domains' — got ${JSON.stringify(create!.body)}`,
    );
    assert.deepEqual(create!.body.docker_compose_domains, [
      { name: "web", domain: "https://gritsync.cantila.app" },
    ]);
  } finally {
    globalThis.fetch = original;
  }
});

// --- D: migration hook is a gate, not best-effort --------------------
// If Coolify rejects installing the `pre_deployment_command` that applies
// the tenant's schema, the migration never runs and the app boots against
// an empty database (P2021). Swallowing that PATCH failure makes the deploy
// report "live" while broken. startContainer must fail loudly instead.

test("startContainer fails the deploy when the migration hook can't be installed", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const u = String(url);
    const method = String(init?.method ?? "GET");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    // App lookup → none exist yet (force a create).
    if (method === "GET" && /\/applications$/.test(u)) {
      return { ok: true, status: 200, json: async () => [], text: async () => "[]" } as Response;
    }
    // The migrate-hook PATCH is rejected by Coolify.
    if (method === "PATCH" && body && "pre_deployment_command" in body) {
      return {
        ok: false,
        status: 500,
        json: async () => ({ message: "cannot set pre_deployment_command" }),
        text: async () => '{"message":"cannot set pre_deployment_command"}',
      } as Response;
    }
    // Deployment poll → finished (so the ONLY failure path is the hook).
    if (method === "GET" && /\/deployments\//.test(u)) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: "finished" }),
        text: async () => "{}",
      } as Response;
    }
    // Everything else succeeds (create, other PATCHes, POST /deploy).
    return {
      ok: true,
      status: 200,
      json: async () => ({ uuid: "app_new", deployment_uuid: "dep_1" }),
      text: async () => "{}",
    } as Response;
  }) as typeof fetch;

  try {
    const dp = new CoolifyDataPlane({
      apiUrl: "http://coolify.test/api/v1",
      apiToken: "t",
      serverUuid: "s",
      projectUuid: "p",
    });
    const project = makeProject({
      slug: "demo",
      repoUrl: "https://github.com/owner/demo",
      branch: "main",
    });
    await assert.rejects(
      () =>
        dp.startContainer(project, "coolify:pending", "s", {
          DATABASE_URL: "postgres://app:pw@db:5432/demo",
        }),
      /migrat|pre_deployment_command/i,
      "a failed migration-hook install must fail the deploy, not be swallowed",
    );
  } finally {
    globalThis.fetch = original;
  }
});
