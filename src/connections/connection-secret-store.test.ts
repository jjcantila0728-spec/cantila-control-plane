import { test } from "node:test";
import assert from "node:assert/strict";

import {
  serializeSecret,
  deserializeSecret,
  createInMemoryConnectionSecretStore,
  createPrismaConnectionSecretStore,
  type RawSqlClient,
} from "./connection-secret-store";
import { isEncryptedSecret } from "../lib/secrets";

/** A tiny fake of the Postgres slice we use: a Map keyed by `ref` that
 *  understands our three exact statements (INSERT upsert / SELECT /
 *  DELETE). Mirrors the parameter binding the real client gets. */
function fakePrisma(): RawSqlClient & { rows: Map<string, string> } {
  const rows = new Map<string, string>();
  return {
    rows,
    async $executeRawUnsafe(query: string, ...values: unknown[]) {
      if (query.includes("INSERT")) {
        rows.set(values[0] as string, values[1] as string);
        return 1;
      }
      if (query.includes("DELETE")) {
        return rows.delete(values[0] as string) ? 1 : 0;
      }
      return 0;
    },
    async $queryRawUnsafe<T = unknown>(_query: string, ...values: unknown[]) {
      const v = rows.get(values[0] as string);
      return (v === undefined ? [] : [{ payload: v }]) as T[];
    },
  };
}

test("serializeSecret/deserializeSecret round-trips a payload", () => {
  const payload = { access_token: "at_123", refresh_token: "rt_456" };
  assert.deepEqual(deserializeSecret(serializeSecret(payload)), payload);
});

test("deserializeSecret returns null for missing/blank input", () => {
  assert.equal(deserializeSecret(null), null);
  assert.equal(deserializeSecret(undefined), null);
  assert.equal(deserializeSecret(""), null);
});

test("in-memory store: write / read / remove round-trip", async () => {
  const s = createInMemoryConnectionSecretStore();
  assert.equal(await s.read("sec_x"), null);
  await s.write("sec_x", { api_key: "k1" });
  assert.deepEqual(await s.read("sec_x"), { api_key: "k1" });
  await s.remove("sec_x");
  assert.equal(await s.read("sec_x"), null);
});

test("prisma store: persists encrypted-at-rest and reads back decrypted", async (t) => {
  process.env.CANTILA_SECRET_KEY = "test-master-key-aaaaaaaaaaaaaaaaaaaa";
  t.after(() => {
    delete process.env.CANTILA_SECRET_KEY;
  });
  const db = fakePrisma();
  const s = createPrismaConnectionSecretStore(db);

  await s.write("sec_oauth", {
    access_token: "PLAINTEXT_NEEDLE_123",
    refresh_token: "rt",
  });

  // What lands in storage is an enc.v1 envelope, not the plaintext token.
  const raw = db.rows.get("sec_oauth");
  assert.ok(raw, "row must exist");
  assert.ok(isEncryptedSecret(raw!), "payload must be encrypted at rest");
  assert.ok(
    !raw!.includes("PLAINTEXT_NEEDLE_123"),
    "plaintext token must not appear in stored bytes",
  );

  // Read decrypts back to the original payload.
  assert.deepEqual(await s.read("sec_oauth"), {
    access_token: "PLAINTEXT_NEEDLE_123",
    refresh_token: "rt",
  });

  // Remove deletes it.
  await s.remove("sec_oauth");
  assert.equal(await s.read("sec_oauth"), null);
});

test("prisma store: read of an unknown ref is null", async () => {
  const s = createPrismaConnectionSecretStore(fakePrisma());
  assert.equal(await s.read("nope"), null);
});
