/* detectMobileStack — unit tests. Pure function, no network. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { detectMobileStack } from "./detect-stack";

const pkg = (deps: Record<string, string>) =>
  JSON.stringify({ dependencies: deps });

const reader =
  (files: Record<string, string>) =>
  async (path: string): Promise<string | null> =>
    files[path] ?? null;

test("detects Expo from the expo dependency", async () => {
  const info = await detectMobileStack(
    ["package.json", "app.json", "App.tsx"],
    reader({ "package.json": pkg({ expo: "~51.0.0", "react-native": "0.74.0" }) }),
  );
  assert.equal(info?.mobileStack, "expo");
  assert.equal(info?.label, "Expo (React Native)");
});

test("detects bare React Native when expo is absent", async () => {
  const info = await detectMobileStack(
    ["package.json", "android/build.gradle", "ios/Podfile"],
    reader({ "package.json": pkg({ "react-native": "0.74.0" }) }),
  );
  assert.equal(info?.mobileStack, "react-native");
});

test("detects Flutter from pubspec.yaml with a flutter dependency", async () => {
  const info = await detectMobileStack(
    ["pubspec.yaml", "lib/main.dart"],
    reader({ "pubspec.yaml": "name: demo\ndependencies:\n  flutter:\n    sdk: flutter\n" }),
  );
  assert.equal(info?.mobileStack, "flutter");
});

test("detects Capacitor from @capacitor/core", async () => {
  const info = await detectMobileStack(
    ["package.json", "capacitor.config.ts"],
    reader({ "package.json": pkg({ "@capacitor/core": "^6.0.0", react: "^18" }) }),
  );
  assert.equal(info?.mobileStack, "capacitor");
});

test("detects Capacitor from capacitor.config.json without a reader", async () => {
  const info = await detectMobileStack(["package.json", "capacitor.config.json"]);
  assert.equal(info?.mobileStack, "capacitor");
});

test("detects native Android from gradle + manifest", async () => {
  const info = await detectMobileStack([
    "build.gradle",
    "settings.gradle",
    "app/build.gradle",
    "app/src/main/AndroidManifest.xml",
  ]);
  assert.equal(info?.mobileStack, "android-native");
});

test("detects native Android from android/ subproject", async () => {
  const info = await detectMobileStack([
    "android/build.gradle.kts",
    "android/app/src/main/AndroidManifest.xml",
  ]);
  assert.equal(info?.mobileStack, "android-native");
});

test("returns null for a plain Next.js web app", async () => {
  const info = await detectMobileStack(
    ["package.json", "next.config.js", "app/page.tsx"],
    reader({ "package.json": pkg({ next: "^15", react: "^18" }) }),
  );
  assert.equal(info, null);
});

test("returns null for pubspec.yaml without flutter (pure Dart)", async () => {
  const info = await detectMobileStack(
    ["pubspec.yaml"],
    reader({ "pubspec.yaml": "name: cli_tool\ndependencies:\n  args: ^2.0.0\n" }),
  );
  assert.equal(info, null);
});
