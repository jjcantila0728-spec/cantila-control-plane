/* ============================================================
   selectImageBuilder — env-gated fast-build selection
   (plan 2026-06-18 §Stage 1). Noop unless CANTILA_BUILDER=buildx
   AND a registry is resolvable.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { selectImageBuilder } from "./factory";
import { noopImageBuilder } from "../deploy/image-builder";

test("off by default → noop builder", () => {
  const { builder, label } = selectImageBuilder({});
  assert.equal(builder, noopImageBuilder);
  assert.equal(label, undefined);
});

test("CANTILA_BUILDER=buildx without a registry → noop (declines safely)", () => {
  const { builder } = selectImageBuilder({ CANTILA_BUILDER: "buildx" });
  assert.equal(builder, noopImageBuilder);
});

test("CANTILA_BUILDER=buildx + explicit registry → real builder, labelled", () => {
  const { builder, label } = selectImageBuilder({
    CANTILA_BUILDER: "buildx",
    CANTILA_REGISTRY_URL: "registry.local",
  });
  assert.notEqual(builder, noopImageBuilder);
  assert.equal(label, "buildx");
});

test("registry derived from GITEA_URL host when CANTILA_REGISTRY_URL unset", () => {
  const { builder, label } = selectImageBuilder({
    CANTILA_BUILDER: "buildx",
    GITEA_URL: "https://git.cantila.app",
    GITEA_TOKEN: "t",
    GITEA_USER: "u",
  });
  assert.notEqual(builder, noopImageBuilder);
  assert.equal(label, "buildx");
});

test("CANTILA_BUILD_SSH_HOST → remote build host, label 'buildx (ssh)'", () => {
  const { builder, label } = selectImageBuilder({
    CANTILA_BUILDER: "buildx",
    CANTILA_REGISTRY_URL: "git.cantila.app",
    CANTILA_BUILD_SSH_HOST: "168.119.97.112",
    CANTILA_BUILD_SSH_USER: "root",
  });
  assert.notEqual(builder, noopImageBuilder);
  assert.equal(label, "buildx (ssh)");
});

test("no build SSH host → local builder, label 'buildx'", () => {
  const { label } = selectImageBuilder({
    CANTILA_BUILDER: "buildx",
    CANTILA_REGISTRY_URL: "git.cantila.app",
  });
  assert.equal(label, "buildx");
});
