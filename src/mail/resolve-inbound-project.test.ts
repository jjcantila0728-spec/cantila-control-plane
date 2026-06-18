/* ============================================================
   resolveInboundProject — routes an inbound recipient to its owning
   project. Asserts the two-tier lookup: explicit HostedMailbox row
   first, then the canonical platform-default scheme
   (`*@<slug>.cantila.app`) via the project's own domain row.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hostFromAddress,
  makeResolveInboundProject,
} from "./resolve-inbound-project";

test("hostFromAddress extracts the lowercased domain part", () => {
  assert.equal(hostFromAddress("info@acme.cantila.app"), "acme.cantila.app");
  assert.equal(hostFromAddress("  Info@ACME.Cantila.App  "), "acme.cantila.app");
  // local part may itself contain no @, only the last @ splits the host
  assert.equal(hostFromAddress('"a@b"@acme.cantila.app'), "acme.cantila.app");
});

test("hostFromAddress returns null for a malformed address", () => {
  assert.equal(hostFromAddress("not-an-address"), null);
  assert.equal(hostFromAddress("trailing@"), null);
  assert.equal(hostFromAddress(""), null);
});

function makeDeps(opts: {
  mailboxes?: Record<string, string>;
  domains?: Record<string, string>;
}) {
  const calls = { mailbox: [] as string[], domain: [] as string[] };
  const deps = {
    findHostedMailboxByAddress: async (address: string) => {
      calls.mailbox.push(address);
      const projectId = opts.mailboxes?.[address];
      return projectId ? { projectId } : null;
    },
    findDomainByHostname: async (hostname: string) => {
      calls.domain.push(hostname);
      const projectId = opts.domains?.[hostname];
      return projectId ? { projectId } : null;
    },
  };
  return { deps, calls };
}

test("an explicit hosted mailbox wins and short-circuits the domain lookup", async () => {
  const { deps, calls } = makeDeps({
    mailboxes: { "sales@acme.cantila.app": "proj_sales" },
    domains: { "acme.cantila.app": "proj_default" },
  });
  const resolve = makeResolveInboundProject(deps);
  assert.equal(await resolve("sales@acme.cantila.app"), "proj_sales");
  assert.deepEqual(calls.domain, []); // never consulted the domain index
});

test("the platform-default address falls back to the project's domain row", async () => {
  const { deps } = makeDeps({
    domains: { "acme.cantila.app": "proj_acme" },
  });
  const resolve = makeResolveInboundProject(deps);
  // info@<slug>.cantila.app has no HostedMailbox row — resolves via domain.
  assert.equal(await resolve("info@acme.cantila.app"), "proj_acme");
});

test("the wildcard model routes any local part at the project subdomain", async () => {
  const { deps } = makeDeps({
    domains: { "acme.cantila.app": "proj_acme" },
  });
  const resolve = makeResolveInboundProject(deps);
  assert.equal(await resolve("hello@acme.cantila.app"), "proj_acme");
  assert.equal(await resolve("noreply@acme.cantila.app"), "proj_acme");
});

test("input is trimmed and lowercased before both lookups", async () => {
  const { deps, calls } = makeDeps({
    domains: { "acme.cantila.app": "proj_acme" },
  });
  const resolve = makeResolveInboundProject(deps);
  assert.equal(await resolve("  Info@ACME.Cantila.App  "), "proj_acme");
  assert.deepEqual(calls.mailbox, ["info@acme.cantila.app"]);
  assert.deepEqual(calls.domain, ["acme.cantila.app"]);
});

test("an unowned domain stays unroutable (null → left unseen)", async () => {
  const { deps } = makeDeps({ domains: { "acme.cantila.app": "proj_acme" } });
  const resolve = makeResolveInboundProject(deps);
  assert.equal(await resolve("info@stranger.example.com"), null);
});

test("a malformed recipient is unroutable, not a crash", async () => {
  const { deps } = makeDeps({});
  const resolve = makeResolveInboundProject(deps);
  assert.equal(await resolve("garbage"), null);
});
