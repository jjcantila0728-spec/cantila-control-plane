/* ============================================================
   MailcowMailboxProvisioner.ensureDomain hardening (2026-06-01).

   Regression guard for the live send/receive break: the cantila.app
   domain had been added to Mailcow as a backup-MX / relay domain
   (`backupmx=1`, `relay_all_recipients=1`) with zero mailboxes, so
   inbound had no local delivery target and no mailbox could send.
   `ensureDomain` was idempotent-by-existence and never repaired it.

   These tests mock the global `fetch` the provisioner uses (no
   network) and assert:
     1. a fresh add pins `backupmx:"0"`,
     2. an existing backup-MX domain is repaired via `/edit/domain`,
     3. an already-primary domain is left untouched (no edit call).
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";

import { MailcowMailboxProvisioner } from "./mailcow-provisioner";

interface RecordedCall {
  url: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

/** Install a fake `fetch` that routes by path and records every call.
 *  `routes` maps a path-substring → the response text it should return.
 *  Returns the recorder + a restore fn. */
function mockFetch(routes: Array<{ match: string; status?: number; text: string }>) {
  const calls: RecordedCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = String(input);
    const body =
      typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    calls.push({ url, method: init?.method ?? "GET", body });
    const hit = routes.find((r) => url.includes(r.match));
    const status = hit?.status ?? 200;
    const text = hit?.text ?? "[]";
    return {
      ok: status < 400,
      status,
      text: async () => text,
    } as unknown as Response;
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

const PROV = () =>
  new MailcowMailboxProvisioner({ url: "https://mail.example.test", apiKey: "k" });

test("ensureDomain pins backupmx=0 when adding a fresh domain", async () => {
  // GET returns empty array → domain absent → add path.
  const { calls, restore } = mockFetch([
    { match: "/get/domain/", text: "[]" },
    { match: "/add/domain", text: '[{"type":"success","msg":["domain_added"]}]' },
  ]);
  try {
    const res = await PROV().ensureDomain("fresh.example");
    assert.deepEqual(res, { ok: true });
    const add = calls.find((c) => c.url.includes("/add/domain"));
    assert.ok(add, "expected an /add/domain call");
    assert.equal(add!.body?.backupmx, "0", "add must pin backupmx=0");
    assert.equal(add!.body?.domain, "fresh.example");
    // No repair edit on the add path.
    assert.ok(!calls.some((c) => c.url.includes("/edit/domain")));
  } finally {
    restore();
  }
});

test("ensureDomain repairs an existing backup-MX / relay domain", async () => {
  // GET returns a domain object flagged backupmx=1 + relay → must repair.
  const got =
    '[{"domain_name":"cantila.app","backupmx":1,"backupmx_int":1,"relay_all_recipients":1,"active":1}]';
  const { calls, restore } = mockFetch([
    { match: "/get/domain/", text: got },
    { match: "/edit/domain", text: '[{"type":"success","msg":["domain_modified"]}]' },
  ]);
  try {
    const res = await PROV().ensureDomain("cantila.app");
    assert.deepEqual(res, { ok: true });
    const edit = calls.find((c) => c.url.includes("/edit/domain"));
    assert.ok(edit, "expected an /edit/domain repair call");
    assert.deepEqual(edit!.body?.items, ["cantila.app"]);
    const attr = edit!.body?.attr as Record<string, unknown>;
    assert.equal(attr.backupmx, "0", "repair must clear backupmx");
    assert.equal(attr.relay_all_recipients, "0", "repair must clear relay");
    // Must NOT try to re-add an existing domain.
    assert.ok(!calls.some((c) => c.url.includes("/add/domain")));
  } finally {
    restore();
  }
});

test("ensureDomain leaves an already-primary domain untouched", async () => {
  const got =
    '[{"domain_name":"ok.example","backupmx":0,"backupmx_int":0,"relay_all_recipients":0,"active":1}]';
  const { calls, restore } = mockFetch([{ match: "/get/domain/", text: got }]);
  try {
    const res = await PROV().ensureDomain("ok.example");
    assert.deepEqual(res, { ok: true });
    assert.ok(!calls.some((c) => c.url.includes("/edit/domain")), "no repair needed");
    assert.ok(!calls.some((c) => c.url.includes("/add/domain")), "no add needed");
  } finally {
    restore();
  }
});
