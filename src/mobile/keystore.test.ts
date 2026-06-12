/* Keystore management — unit tests. Uses the InMemoryStore and a forced
   placeholder keystore (no JDK dependency in CI). */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { InMemoryStore } from "../domain/store";
import type { Project } from "../domain/types";
import { defaultApplicationId, ensureKeystore } from "./keystore";
import { isEncryptedSecret } from "../lib/secrets";

before(() => {
  process.env.CANTILA_SECRET_KEY = "test-master-key-please-32chars-x";
});
after(() => {
  delete process.env.CANTILA_SECRET_KEY;
});

const makeProject = (over: Partial<Project> = {}): Project => ({
  id: "prj_test",
  accountId: "acc_test",
  slug: "my-cool-app",
  name: "My Cool App",
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
  ...over,
});

test("defaultApplicationId sanitizes the slug into a valid package name", () => {
  assert.equal(defaultApplicationId("my-cool-app"), "app.cantila.my_cool_app");
  assert.equal(defaultApplicationId("3d-shop"), "app.cantila.a3d_shop");
  assert.equal(defaultApplicationId("UPPER.case"), "app.cantila.upper_case");
});

test("ensureKeystore generates, persists encrypted, and is stable", async () => {
  const store = new InMemoryStore();
  const project = await store.createProject(makeProject());

  const first = await ensureKeystore(project, store, { allowKeytool: false });
  assert.ok(first.keystoreB64.length > 0);
  assert.ok(first.storePassword.length >= 16);
  assert.equal(first.alias, "cantila");
  assert.equal(first.generated, false); // placeholder path (keytool disabled)

  // persisted encrypted at rest
  const persisted = await store.getProject(project.id);
  assert.ok(persisted?.androidKeystore);
  assert.ok(isEncryptedSecret(persisted!.androidKeystore!));
  assert.ok(isEncryptedSecret(persisted!.androidKeystoreSecret!));

  // second call returns identical material (no regeneration)
  const second = await ensureKeystore(persisted!, store, { allowKeytool: false });
  assert.equal(second.keystoreB64, first.keystoreB64);
  assert.equal(second.storePassword, first.storePassword);
  assert.equal(second.keyPassword, first.keyPassword);
});
