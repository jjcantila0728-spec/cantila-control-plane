/* MobileBuildProvider — unit tests. Stub provider writes real files into a
   temp dir; the Docker provider is covered via its pure command planner. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMobileBuildProvider,
  dockerBuildPlan,
  IosBuildUnavailableError,
  StubMobileBuildProvider,
  type AndroidBuildInput,
} from "./build-provider";
import type { KeystoreMaterial } from "./keystore";

const keystore: KeystoreMaterial = {
  keystoreB64: Buffer.from("ks").toString("base64"),
  storePassword: "sp",
  keyPassword: "kp",
  alias: "cantila",
  generated: false,
};

const input = (outDir: string, over: Partial<AndroidBuildInput> = {}): AndroidBuildInput => ({
  projectId: "prj_1",
  workDir: join(outDir, "src"),
  mobileStack: "expo",
  applicationId: "app.cantila.demo",
  versionCode: 1,
  versionName: "1.0.0",
  artifactKind: "aab",
  keystore,
  outDir,
  ...over,
});

test("factory returns the stub by default and docker when MOBILE_BUILDER=docker", () => {
  assert.equal(createMobileBuildProvider({}).label, "stub");
  assert.equal(createMobileBuildProvider({}).live, false);
  const docker = createMobileBuildProvider({ MOBILE_BUILDER: "docker" });
  assert.equal(docker.label, "docker");
  assert.equal(docker.live, true);
});

test("stub build writes a deterministic artifact and reports its size", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cantila-mobile-"));
  try {
    const provider = new StubMobileBuildProvider();
    const result = await provider.buildAndroid(input(dir, { versionCode: 7 }));
    assert.ok(result.artifactPath.endsWith("prj_1-7.aab"));
    const s = await stat(result.artifactPath);
    assert.equal(result.sizeBytes, s.size);
    assert.ok(s.size > 0);
    assert.match(result.log, /stub/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("iOS builds throw IosBuildUnavailableError on every provider", async () => {
  const stub = new StubMobileBuildProvider();
  assert.throws(() => stub.buildIos(), IosBuildUnavailableError);
  assert.throws(() => createMobileBuildProvider({ MOBILE_BUILDER: "docker" }).buildIos(), IosBuildUnavailableError);
});

test("dockerBuildPlan maps each stack to the right image and command", () => {
  const dir = "/tmp/x";
  const expo = dockerBuildPlan(input(dir, { mobileStack: "expo" }));
  assert.match(expo.image, /react-native-android/);
  assert.match(expo.script, /expo prebuild/);
  assert.match(expo.script, /bundleRelease/);

  const rn = dockerBuildPlan(input(dir, { mobileStack: "react-native" }));
  assert.ok(!/expo prebuild/.test(rn.script));
  assert.match(rn.script, /bundleRelease/);

  const flutter = dockerBuildPlan(input(dir, { mobileStack: "flutter" }));
  assert.match(flutter.image, /flutter/);
  assert.match(flutter.script, /flutter build appbundle/);

  const cap = dockerBuildPlan(input(dir, { mobileStack: "capacitor" }));
  assert.match(cap.script, /cap sync android/);

  const native = dockerBuildPlan(input(dir, { mobileStack: "android-native" }));
  assert.match(native.script, /bundleRelease/);

  // apk artifact swaps the gradle task
  const apk = dockerBuildPlan(input(dir, { mobileStack: "react-native", artifactKind: "apk" }));
  assert.match(apk.script, /assembleRelease/);
});
