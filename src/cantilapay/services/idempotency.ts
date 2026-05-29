/* ============================================================
   Cantilapay — idempotency-key service (plan §25, Phase 0).

   Stripe-shaped idempotency: a caller passes a
   `Cantilapay-Idempotency-Key` header on any mutating request;
   the platform persists `(account, mode, key) -> (requestHash,
   responseStatus, responseBody)` so a retry within the TTL
   returns the original response byte-for-byte. Reusing the same
   key with a different body is a 400 (matches Stripe behaviour).

   TTL is 24h — same as Stripe's documented retention.

   Phase 0 implements both a Prisma-backed store (live path) and a
   pure in-process Map fallback used by the smoke test when no
   DATABASE_URL is configured. The routes call the same surface.
   ============================================================ */

import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

import type { CantilapayMode } from "../types";

const TTL_MS = 24 * 60 * 60 * 1000;

export interface IdempotentResult {
  status: number;
  body: unknown;
}

export interface IdempotencyOutcome {
  /** Whether this call replayed an existing response. */
  replayed: boolean;
  /** The cached or freshly computed result. */
  result: IdempotentResult;
}

/** A storage backend for idempotency entries. The route layer picks one
 *  via `selectIdempotencyStore` based on whether Prisma is configured. */
export interface IdempotencyStore {
  find(input: {
    cantilapayAccountId: string;
    mode: CantilapayMode;
    key: string;
  }): Promise<
    | {
        requestHash: string;
        responseStatus: number;
        responseBody: string;
        expiresAt: Date;
      }
    | null
  >;
  put(input: {
    cantilapayAccountId: string;
    mode: CantilapayMode;
    key: string;
    requestHash: string;
    responseStatus: number;
    responseBody: string;
    expiresAt: Date;
  }): Promise<void>;
}

/** Run a mutating operation through the idempotency layer. When the
 *  caller didn't provide a key, `compute` runs and its result returns
 *  directly. When a key is present, we look it up; replay on hit;
 *  reject on body mismatch; otherwise compute and persist.
 *
 *  `bodyForHash` is the canonical request body the caller wants the
 *  idempotency comparison to run against (usually the parsed +
 *  re-stringified JSON body, so insignificant whitespace doesn't
 *  trigger a 400). */
export async function withIdempotency<T>(args: {
  store: IdempotencyStore;
  cantilapayAccountId: string;
  mode: CantilapayMode;
  key: string | null;
  bodyForHash: string;
  compute: () => Promise<{ status: number; body: T }>;
}): Promise<IdempotencyOutcome> {
  if (!args.key) {
    const result = await args.compute();
    return {
      replayed: false,
      result: { status: result.status, body: result.body },
    };
  }
  const requestHash = sha256(args.bodyForHash);
  const existing = await args.store.find({
    cantilapayAccountId: args.cantilapayAccountId,
    mode: args.mode,
    key: args.key,
  });
  if (existing) {
    if (existing.expiresAt.getTime() > Date.now()) {
      if (existing.requestHash !== requestHash) {
        // Same key, different body — Stripe behaviour is 400.
        throw new IdempotencyBodyMismatchError();
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(existing.responseBody);
      } catch {
        parsed = existing.responseBody;
      }
      return {
        replayed: true,
        result: { status: existing.responseStatus, body: parsed },
      };
    }
    // Expired entry; fall through to compute and overwrite.
  }
  const result = await args.compute();
  const responseBody = JSON.stringify(result.body);
  await args.store.put({
    cantilapayAccountId: args.cantilapayAccountId,
    mode: args.mode,
    key: args.key,
    requestHash,
    responseStatus: result.status,
    responseBody,
    expiresAt: new Date(Date.now() + TTL_MS),
  });
  return {
    replayed: false,
    result: { status: result.status, body: result.body },
  };
}

/** Sentinel error the route layer rethrows as the right 400 wire shape. */
export class IdempotencyBodyMismatchError extends Error {
  constructor() {
    super("idempotency body mismatch");
    this.name = "IdempotencyBodyMismatchError";
  }
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Prisma-backed implementation. Used when DATABASE_URL is configured. */
export class PrismaIdempotencyStore implements IdempotencyStore {
  constructor(private readonly prisma: PrismaClient) {}

  async find(input: {
    cantilapayAccountId: string;
    mode: CantilapayMode;
    key: string;
  }): Promise<
    | {
        requestHash: string;
        responseStatus: number;
        responseBody: string;
        expiresAt: Date;
      }
    | null
  > {
    const row = await this.prisma.cantilapayIdempotencyKey.findUnique({
      where: {
        cantilapayAccountId_mode_key: {
          cantilapayAccountId: input.cantilapayAccountId,
          mode: input.mode,
          key: input.key,
        },
      },
    });
    if (!row) return null;
    return {
      requestHash: row.requestHash,
      responseStatus: row.responseStatus,
      responseBody: row.responseBody,
      expiresAt: row.expiresAt,
    };
  }

  async put(input: {
    cantilapayAccountId: string;
    mode: CantilapayMode;
    key: string;
    requestHash: string;
    responseStatus: number;
    responseBody: string;
    expiresAt: Date;
  }): Promise<void> {
    await this.prisma.cantilapayIdempotencyKey.upsert({
      where: {
        cantilapayAccountId_mode_key: {
          cantilapayAccountId: input.cantilapayAccountId,
          mode: input.mode,
          key: input.key,
        },
      },
      create: {
        cantilapayAccountId: input.cantilapayAccountId,
        mode: input.mode,
        key: input.key,
        requestHash: input.requestHash,
        responseStatus: input.responseStatus,
        responseBody: input.responseBody,
        expiresAt: input.expiresAt,
      },
      update: {
        requestHash: input.requestHash,
        responseStatus: input.responseStatus,
        responseBody: input.responseBody,
        expiresAt: input.expiresAt,
      },
    });
  }
}

/** In-process fallback. Lets the Phase 0 smoke test run without a
 *  real Postgres. NEVER used when Prisma is wired. */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private map = new Map<
    string,
    {
      requestHash: string;
      responseStatus: number;
      responseBody: string;
      expiresAt: Date;
    }
  >();

  private k(a: string, m: string, key: string): string {
    return `${a}::${m}::${key}`;
  }

  async find(input: {
    cantilapayAccountId: string;
    mode: CantilapayMode;
    key: string;
  }): Promise<
    | {
        requestHash: string;
        responseStatus: number;
        responseBody: string;
        expiresAt: Date;
      }
    | null
  > {
    return this.map.get(this.k(input.cantilapayAccountId, input.mode, input.key)) ?? null;
  }

  async put(input: {
    cantilapayAccountId: string;
    mode: CantilapayMode;
    key: string;
    requestHash: string;
    responseStatus: number;
    responseBody: string;
    expiresAt: Date;
  }): Promise<void> {
    this.map.set(this.k(input.cantilapayAccountId, input.mode, input.key), {
      requestHash: input.requestHash,
      responseStatus: input.responseStatus,
      responseBody: input.responseBody,
      expiresAt: input.expiresAt,
    });
  }
}
