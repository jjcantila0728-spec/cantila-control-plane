/* End-to-end mobile pipeline at the service layer: detect → build (stub) →
   artifact → publish. InMemoryStore + stub providers; no network/docker. */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryStore } from "../domain/store";
import type { Project } from "../domain/types";
import { StubMobileBuildProvider } from "./build-provider";
import {
  createStorePublishers,
  type PublishResult,
  type StorePublisher,
} from "./store-publisher";
import { MobileError, MobileService } from "./service";

before(() => {
  process.env.CANTILA_SECRET_KEY = "test-master-key-please-32chars-x";
});
after(() => {
  delete process.env.CANTILA_SECRET_KEY;
});

const expoFiles: Record<string, string> = {
  "package.json": JSON.stringify({ dependencies: { expo: "~51.0.0", "react-native": "0.74.0" } }),
  "App.tsx": "export default function App() { return null; }",
  "app.json": "{}",
};

function makeService(opts: {
  store: InMemoryStore;
  artifactDir: string;
  files?: Record<string, string> | null;
  publishers?: Map<"google_play" | "app_store", StorePublisher>;
}) {
  const files = opts.files === undefined ? expoFiles : opts.files;
  return new MobileService({
    store: opts.store,
    builder: new StubMobileBuildProvider(),
    publishers: opts.publishers ?? createStorePublishers({}),
    listFiles: async () => (files ? Object.keys(files) : null),
    readFile: async (_id, path) => files?.[path] ?? null,
    artifactDir: opts.artifactDir,
    autoRun: false,
  });
}

async function makeProject(store: InMemoryStore, slug = "demo-app"): Promise<Project> {
  return store.createProject({
    id: `prj_${slug}`,
    accountId: "acc_1",
    slug,
    name: slug,
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
    createdAt: new Date().toISOString(),
  });
}

test("android build: detects stack, persists it, builds, increments versionCode", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cantila-mflow-"));
  try {
    const store = new InMemoryStore();
    const project = await makeProject(store);
    const service = makeService({ store, artifactDir: dir });

    const queued = await service.buildMobileApp(project.id, { platform: "android" });
    assert.equal(queued.status, "queued");
    assert.equal(queued.versionCode, 1);
    assert.equal(queued.applicationId, "app.cantila.demo_app");
    assert.equal(queued.mobileStack, "expo");

    const done = await service.runBuild(queued.id);
    assert.equal(done.status, "succeeded");
    assert.ok(done.artifactPath?.endsWith(".aab"));
    assert.ok((done.artifactSize ?? 0) > 0);

    // stack persisted on the project; next build bumps the versionCode
    assert.equal((await store.getProject(project.id))?.mobileStack, "expo");
    const second = await service.buildMobileApp(project.id, { platform: "android", artifactKind: "apk" });
    assert.equal(second.versionCode, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("non-mobile project is rejected with not_a_mobile_app", async () => {
  const store = new InMemoryStore();
  const project = await makeProject(store, "web-only");
  const service = makeService({
    store,
    artifactDir: "unused",
    files: { "package.json": JSON.stringify({ dependencies: { next: "^15" } }) },
  });
  await assert.rejects(
    service.buildMobileApp(project.id, { platform: "android" }),
    (err: MobileError) => err.code === "not_a_mobile_app" && err.statusCode === 422,
  );
});

test("iOS build and App Store publish are coming-soon", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cantila-mflow-"));
  try {
    const store = new InMemoryStore();
    const project = await makeProject(store, "ios-ask");
    const service = makeService({ store, artifactDir: dir });

    await assert.rejects(
      service.buildMobileApp(project.id, { platform: "ios" }),
      (err: MobileError) => err.code === "ios_coming_soon" && err.statusCode === 409,
    );

    const build = await service.buildMobileApp(project.id, { platform: "android" });
    await service.runBuild(build.id);
    await assert.rejects(
      service.publishRelease(project.id, { buildId: build.id, store: "app_store" }),
      (err: MobileError) => err.code === "app_store_coming_soon",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("publish records a stubbed release offline and published with a live publisher", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cantila-mflow-"));
  try {
    const store = new InMemoryStore();
    const project = await makeProject(store, "ship-it");
    const service = makeService({ store, artifactDir: dir });

    const build = await service.buildMobileApp(project.id, { platform: "android" });
    await service.runBuild(build.id);

    // publisher offline → stubbed
    const stubbed = await service.publishRelease(project.id, {
      buildId: build.id,
      store: "google_play",
    });
    assert.equal(stubbed.status, "stubbed");
    assert.equal(stubbed.track, "internal");

    // live publisher → published with externalRef
    const fakeLive: StorePublisher = {
      store: "google_play",
      label: "fake-live",
      live: true,
      async publish(): Promise<PublishResult> {
        return { status: "published", externalRef: "edit_99", message: "ok" };
      },
    };
    const liveService = makeService({
      store,
      artifactDir: dir,
      publishers: new Map([
        ["google_play", fakeLive],
        ["app_store", createStorePublishers({}).get("app_store")!],
      ]),
    });
    const published = await liveService.publishRelease(project.id, {
      buildId: build.id,
      store: "google_play",
      track: "production",
    });
    assert.equal(published.status, "published");
    assert.equal(published.externalRef, "edit_99");

    // publishing a queued build is rejected
    const queued = await service.buildMobileApp(project.id, { platform: "android" });
    await assert.rejects(
      service.publishRelease(project.id, { buildId: queued.id, store: "google_play" }),
      (err: MobileError) => err.code === "build_not_ready",
    );

    // bad track is rejected
    await assert.rejects(
      service.publishRelease(project.id, { buildId: build.id, store: "google_play", track: "vip" }),
      (err: MobileError) => err.code === "invalid_track",
    );

    const releases = await service.listReleases(project.id);
    assert.equal(releases.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
