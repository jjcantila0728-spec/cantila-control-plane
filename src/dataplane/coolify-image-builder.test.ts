/* ============================================================
   CoolifyDataPlane + off-box ImageBuilder (plan 2026-06-18 §Stage 1).

   - buildImage delegates to the injected builder and returns its
     registry ref; falls back to `coolify:pending` when the builder
     declines or throws.
   - startContainer, given a real registry ref, points the existing
     app at the built image (docker_registry_image_name/tag) and does
     NOT force a build pack (pull mode, not source build), then deploys.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";

import { CoolifyDataPlane } from "./coolify";
import type { ImageBuilder } from "../deploy/image-builder";
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
    repoUrl: "https://github.com/acme/demo",
    createdAt: new Date().toISOString(),
    ...overrides,
  } as Project;
}

const plane = (imageBuilder?: ImageBuilder) =>
  new CoolifyDataPlane({
    apiUrl: "http://coolify.test/api/v1",
    apiToken: "tok",
    serverUuid: "srv-1",
    projectUuid: "cool-proj-1",
    imageBuilder,
  });

const okBuilder = (imageRef: string): ImageBuilder => ({
  async build() {
    return { imageRef };
  },
});

// --- buildImage delegation ------------------------------------------

test("buildImage returns the builder's registry ref for a git source", async () => {
  const ref = "git.cantila.app/cantila/cantila-prj_test123:abc123";
  const out = await plane(okBuilder(ref)).buildImage(makeProject(), {
    kind: "git",
    ref: "abc123",
  });
  assert.equal(out.imageRef, ref);
});

test("buildImage falls back to coolify:pending when the builder declines", async () => {
  const decline: ImageBuilder = { async build() { return null; } };
  const out = await plane(decline).buildImage(makeProject(), { kind: "git" });
  assert.equal(out.imageRef, "coolify:pending");
});

test("buildImage falls back to source build when the builder throws", async () => {
  const boom: ImageBuilder = {
    async build() {
      throw new Error("buildx exploded");
    },
  };
  const out = await plane(boom).buildImage(makeProject(), { kind: "git" });
  assert.equal(out.imageRef, "coolify:pending");
});

test("buildImage without a builder keeps legacy behaviour", async () => {
  const out = await plane().buildImage(makeProject(), { kind: "git" });
  assert.equal(out.imageRef, "coolify:pending");
});

// --- startContainer pull path ---------------------------------------

test("startContainer points an existing app at the built image and skips build pack", async () => {
  const calls: { url: string; method: string; body: any }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const u = String(url);
    const method = String(init?.method ?? "GET");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: u, method, body });
    if (method === "POST" && u.includes("/deploy")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ deployments: [{ deployment_uuid: "dep-1" }] }),
      } as Response;
    }
    if (method === "GET" && u.includes("/deployments/")) {
      return { ok: true, status: 200, json: async () => ({ status: "finished" }) } as Response;
    }
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  }) as typeof fetch;

  try {
    const project = makeProject({ coolifyAppUuid: "app-uuid-1" });
    await plane(okBuilder("x")).startContainer(
      project,
      "git.cantila.app/cantila/cantila-prj_test123:abc123",
      "srv-1",
      { FOO: "bar" },
    );
  } finally {
    globalThis.fetch = original;
  }

  // Pointed the app at the registry image.
  const sourcePatch = calls.find(
    (c) => c.method === "PATCH" && c.body?.docker_registry_image_name,
  );
  assert.ok(sourcePatch, "expected a PATCH setting docker_registry_image_name");
  assert.equal(
    sourcePatch!.body.docker_registry_image_name,
    "git.cantila.app/cantila/cantila-prj_test123",
  );
  assert.equal(sourcePatch!.body.docker_registry_image_tag, "abc123");

  // Did NOT force a build pack — pull mode must not source-build.
  assert.ok(
    !calls.some((c) => c.method === "PATCH" && c.body && "build_pack" in c.body),
    "pull path must not PATCH build_pack",
  );

  // Still triggered a deploy.
  assert.ok(calls.some((c) => c.method === "POST" && c.url.includes("/deploy")));
});
