/* ============================================================
   Cantilapay — tenant API key service (plan §25, Phase 0).

   Issues, verifies, and revokes the tenant-facing API keys
   (`cpk_test_…`, `cpk_live_…`, `csk_test_…`, `csk_live_…`).

   Same one-time-reveal posture as `ApiKey` in src/auth/*: the raw
   key is returned exactly once; only its SHA-256 hash is persisted.
   ============================================================ */

import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

import {
  CANTILAPAY_API_KEY_PREFIX,
  inferKeyShape,
  type CantilapayApiKeyIssued,
  type CantilapayApiKeyKind,
  type CantilapayApiKeyView,
  type CantilapayMode,
} from "../types";
import { CantilapayError } from "../errors";

const RAW_SUFFIX_BYTES = 24; // 48 hex chars

/** Build the raw key string for the given shape. */
function buildRawKey(kind: CantilapayApiKeyKind, mode: CantilapayMode): string {
  const prefix =
    kind === "publishable" && mode === "test" ? CANTILAPAY_API_KEY_PREFIX.publishableTest
    : kind === "publishable" && mode === "live" ? CANTILAPAY_API_KEY_PREFIX.publishableLive
    : kind === "secret" && mode === "test" ? CANTILAPAY_API_KEY_PREFIX.secretTest
    : CANTILAPAY_API_KEY_PREFIX.secretLive;
  const suffix = randomBytes(RAW_SUFFIX_BYTES).toString("hex");
  return `${prefix}${suffix}`;
}

/** SHA-256 hex — same as the existing Cantila API-key auth path. */
function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** First 16 chars of the raw key — enough to identify a key in lists
 *  without giving up the secret part. */
function prefixOf(raw: string): string {
  return raw.slice(0, 16);
}

/** Issue a new key. Returns the raw key in `rawKey` — caller MUST hand
 *  it to the tenant immediately and never log or persist it. */
export async function issueCantilapayKey(
  prisma: PrismaClient,
  input: {
    cantilapayAccountId: string;
    name: string;
    kind: CantilapayApiKeyKind;
    mode: CantilapayMode;
  },
): Promise<CantilapayApiKeyIssued> {
  const raw = buildRawKey(input.kind, input.mode);
  const row = await prisma.cantilapayApiKey.create({
    data: {
      cantilapayAccountId: input.cantilapayAccountId,
      name: input.name,
      kind: input.kind,
      mode: input.mode,
      prefix: prefixOf(raw),
      hashedKey: sha256(raw),
    },
  });
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    mode: row.mode,
    prefix: row.prefix,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    rawKey: raw,
  };
}

/** List keys for an account, masked. The raw key is unrecoverable
 *  by design — only the prefix is shown. */
export async function listCantilapayKeys(
  prisma: PrismaClient,
  input: { cantilapayAccountId: string },
): Promise<CantilapayApiKeyView[]> {
  const rows = await prisma.cantilapayApiKey.findMany({
    where: { cantilapayAccountId: input.cantilapayAccountId },
    orderBy: { createdAt: "desc" },
  });
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    kind: row.kind,
    mode: row.mode,
    prefix: row.prefix,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
  }));
}

/** Resolved tenant key — what the auth middleware attaches to the
 *  Fastify request after a successful Bearer lookup. */
export interface ResolvedCantilapayKey {
  apiKeyId: string;
  cantilapayAccountId: string;
  /** Owning Cantila tenant Account.id (from the join). */
  accountId: string;
  kind: CantilapayApiKeyKind;
  mode: CantilapayMode;
  prefix: string;
}

/** Resolve a presented Bearer token. Throws a CantilapayError on any
 *  failure so the route layer can render the right wire shape. */
export async function authenticateCantilapayKey(
  prisma: PrismaClient,
  authHeader: string | undefined,
): Promise<ResolvedCantilapayKey> {
  if (!authHeader) throw CantilapayError.missingKey();
  const m = /^Bearer\s+(\S+)$/i.exec(authHeader);
  const raw = m ? m[1] : undefined;
  if (!raw) throw CantilapayError.missingKey();
  // Fail fast on a shape-unrecognised token — saves a DB read on
  // garbage bearer tokens (e.g. someone presenting a Cantila admin
  // ctk_ here by mistake).
  if (!inferKeyShape(raw)) throw CantilapayError.invalidKey();
  const found = await prisma.cantilapayApiKey.findUnique({
    where: { hashedKey: sha256(raw) },
    include: { cantilapayAccount: { select: { accountId: true } } },
  });
  if (!found) throw CantilapayError.invalidKey();
  if (found.revokedAt) throw CantilapayError.revokedKey();
  // Touch lastUsedAt out of band — don't block the request.
  void prisma.cantilapayApiKey
    .update({
      where: { id: found.id },
      data: { lastUsedAt: new Date() },
    })
    .catch(() => {
      /* best-effort — a failed touch shouldn't break the request */
    });
  return {
    apiKeyId: found.id,
    cantilapayAccountId: found.cantilapayAccountId,
    accountId: found.cantilapayAccount.accountId,
    kind: found.kind,
    mode: found.mode,
    prefix: found.prefix,
  };
}

/** Revoke a key (soft delete). Same key prefix can never be re-issued. */
export async function revokeCantilapayKey(
  prisma: PrismaClient,
  input: { cantilapayAccountId: string; apiKeyId: string },
): Promise<CantilapayApiKeyView | null> {
  const found = await prisma.cantilapayApiKey.findUnique({
    where: { id: input.apiKeyId },
  });
  if (!found || found.cantilapayAccountId !== input.cantilapayAccountId) {
    return null;
  }
  if (found.revokedAt) {
    return {
      id: found.id,
      name: found.name,
      kind: found.kind,
      mode: found.mode,
      prefix: found.prefix,
      createdAt: found.createdAt.toISOString(),
      lastUsedAt: found.lastUsedAt ? found.lastUsedAt.toISOString() : null,
      revokedAt: found.revokedAt.toISOString(),
    };
  }
  const row = await prisma.cantilapayApiKey.update({
    where: { id: input.apiKeyId },
    data: { revokedAt: new Date() },
  });
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    mode: row.mode,
    prefix: row.prefix,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
  };
}
