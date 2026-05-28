/* Cantila control plane — environment configuration. */

/** Persistence backend. "memory" needs no infrastructure; "prisma" uses Postgres. */
export type StoreKind = "memory" | "prisma";

function storeKind(): StoreKind {
  return process.env.STORE === "prisma" ? "prisma" : "memory";
}

function flag(env: string | undefined): boolean {
  if (!env) return false;
  const v = env.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export const config = {
  port: Number(process.env.PORT ?? 8080),
  nodeEnv: process.env.NODE_ENV ?? "development",
  /** Persistence backend — see StoreKind. Defaults to the in-memory store. */
  store: storeKind(),
  /** Platform database URL — required when store is "prisma". */
  databaseUrl: process.env.DATABASE_URL ?? "",
  /** When true, write routes (POST/PUT/PATCH/DELETE) require a valid bearer
   *  token with sufficient scope (plan §5.4). Defaults to false so the
   *  in-process demo flow needs no setup. Recommended for any deployment
   *  that is reachable from the public internet. */
  requireAuth: flag(process.env.CANTILA_REQUIRE_AUTH),
} as const;
