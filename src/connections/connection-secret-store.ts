/* ============================================================
   Connection secret store (plan §4.11 / §15.5 Phase F).

   Backs Cantila Connections' credential payloads — the API-key
   field values and OAuth access/refresh tokens a tenant saves when
   they connect a provider. Before this module those payloads lived
   in a process-memory Map (index.ts `connectionSecrets`), so a
   control-plane redeploy or a second instance lost every tenant's
   saved connection credentials — the broker would then fail to push
   bytes into engines until the user re-authorized.

   This persists them to Postgres, encrypted at rest with the same
   enc.v1 envelope used elsewhere (lib/secrets), and falls back to an
   in-memory Map when there is no database (tests / STORE=memory in
   dev). The store holds opaque key→payload pairs; the connection row
   itself only ever carries the `secretRef` pointer (domain/types).
   ============================================================ */

import { encryptSecret, decryptSecret } from "../lib/secrets";

export interface ConnectionSecretStore {
  /** Upsert the payload behind `ref`. */
  write(ref: string, payload: Record<string, string>): Promise<void>;
  /** Read the payload behind `ref`, or null when absent. */
  read(ref: string): Promise<Record<string, string> | null>;
  /** Delete the payload behind `ref` (idempotent). */
  remove(ref: string): Promise<void>;
}

/** The minimal slice of PrismaClient this module needs. Declaring it
 *  here (rather than importing PrismaClient) lets tests inject a fake
 *  without a database, and keeps the dependency surface honest. */
export interface RawSqlClient {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
  $queryRawUnsafe<T = unknown>(
    query: string,
    ...values: unknown[]
  ): Promise<T[]>;
}

/** Serialize + encrypt a payload for storage. The JSON is wrapped in
 *  one enc.v1 envelope when CANTILA_SECRET_KEY is set; otherwise it is
 *  stored as plaintext JSON (encryption is opt-in — see lib/secrets).
 *  Exported for direct testing. */
export function serializeSecret(payload: Record<string, string>): string {
  return encryptSecret(JSON.stringify(payload));
}

/** Decrypt + parse a stored value. A null/blank input (missing row)
 *  reads as null rather than throwing. */
export function deserializeSecret(
  stored: string | null | undefined,
): Record<string, string> | null {
  if (stored == null || stored === "") return null;
  return JSON.parse(decryptSecret(stored)) as Record<string, string>;
}

/** Process-memory store — the pre-existing behavior, kept for tests
 *  and STORE=memory (non-prod) where there is no database. */
export function createInMemoryConnectionSecretStore(): ConnectionSecretStore {
  const map = new Map<string, Record<string, string>>();
  return {
    async write(ref, payload) {
      map.set(ref, payload);
    },
    async read(ref) {
      return map.get(ref) ?? null;
    },
    async remove(ref) {
      map.delete(ref);
    },
  };
}

/** Postgres-backed store. Reads/writes the ConnectionSecret table
 *  (created by boot-migrations) with parameterized raw SQL, encrypting
 *  the payload at rest. Parameterized ($1/$2) so `ref`/payload are
 *  bound, never interpolated. */
export function createPrismaConnectionSecretStore(
  prisma: RawSqlClient,
): ConnectionSecretStore {
  return {
    async write(ref, payload) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "ConnectionSecret" ("ref", "payload", "createdAt", "updatedAt")
         VALUES ($1, $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT ("ref") DO UPDATE
           SET "payload" = EXCLUDED."payload", "updatedAt" = CURRENT_TIMESTAMP`,
        ref,
        serializeSecret(payload),
      );
    },
    async read(ref) {
      const rows = await prisma.$queryRawUnsafe<{ payload: string }>(
        `SELECT "payload" FROM "ConnectionSecret" WHERE "ref" = $1 LIMIT 1`,
        ref,
      );
      return deserializeSecret(rows[0]?.payload);
    },
    async remove(ref) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM "ConnectionSecret" WHERE "ref" = $1`,
        ref,
      );
    },
  };
}
