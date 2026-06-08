/* ============================================================
   Store.listPendingCustomDomains — cross-project query the domain
   verify sweep uses to find custom hostnames whose TLS cert has not
   yet been confirmed live (kind === "custom" && !sslActive).

   Free *.cantila.app subdomains (kind === "subdomain") are
   wildcard-covered and never pending, so they must be excluded.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";

import { InMemoryStore } from "./store";
import type { Domain } from "./types";

function domain(overrides: Partial<Domain>): Domain {
  return {
    id: "dom_x",
    projectId: "prj_x",
    hostname: "x.example.com",
    kind: "custom",
    sslActive: false,
    primary: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

test("listPendingCustomDomains returns only custom domains awaiting SSL", async () => {
  const store = new InMemoryStore();
  await store.createDomain(
    domain({ id: "dom_pending", hostname: "app.acme.com", kind: "custom", sslActive: false }),
  );
  await store.createDomain(
    domain({ id: "dom_done", hostname: "shop.acme.com", kind: "custom", sslActive: true }),
  );
  await store.createDomain(
    domain({ id: "dom_sub", hostname: "demo.cantila.app", kind: "subdomain", sslActive: false }),
  );

  const pending = await store.listPendingCustomDomains();

  assert.deepEqual(
    pending.map((d) => d.id).sort(),
    ["dom_pending"],
    "only the unverified custom domain should be pending",
  );
});

test("listPendingCustomDomains spans projects", async () => {
  const store = new InMemoryStore();
  await store.createDomain(
    domain({ id: "dom_a", projectId: "prj_a", hostname: "a.example.com" }),
  );
  await store.createDomain(
    domain({ id: "dom_b", projectId: "prj_b", hostname: "b.example.com" }),
  );

  const pending = await store.listPendingCustomDomains();

  assert.deepEqual(pending.map((d) => d.id).sort(), ["dom_a", "dom_b"]);
});
