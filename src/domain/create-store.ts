/* ============================================================
   Store factory — selects the persistence backend (config.store):
     "memory"  (default) — InMemoryStore, zero infrastructure
     "prisma"            — PrismaStore, backed by PostgreSQL

   Refuses `STORE=memory` when `NODE_ENV=production`. The in-memory
   store wipes itself on every restart; running it in prod means
   every user, project, deployment and Stripe id is lost the next
   time the container rolls. Fail-fast at boot beats discovering
   the loss after a redeploy. Override the guard explicitly with
   `CANTILA_ALLOW_MEMORY_IN_PROD=true` for the rare cases when an
   ephemeral prod-shaped process is genuinely the right call.
   ============================================================ */

import { config } from "../config";
import { getPrisma } from "../lib/prisma";
import type { Store } from "./store";
import { InMemoryStore } from "./store";
import { PrismaStore } from "./prisma-store";
import { applyBootMigrations } from "./boot-migrations";

/** Resolves when the additive boot migrations have finished. Boot code that
 *  queries columns those migrations add (e.g. the platform/owner seeds) MUST
 *  `await` this first — otherwise it races the ALTERs and a still-missing
 *  column surfaces as Prisma P2022. Defaults to resolved for the in-memory
 *  store (no migrations to run). */
export let bootMigrationsReady: Promise<{ applied: number; failed: number }> =
  Promise.resolve({ applied: 0, failed: 0 });

export function createStore(): Store {
  if (config.store === "prisma") {
    if (!config.databaseUrl) {
      throw new Error("STORE=prisma requires DATABASE_URL — set it in .env");
    }
    // Apply additive nullable-column migrations before the rest of the
    // process opens a Prisma session — see `boot-migrations.ts` for the
    // why. `applyBootMigrations` never throws (it logs per-statement
    // failures and continues), so awaiting `bootMigrationsReady` is safe:
    // a permissions failure on one ALTER won't take the control plane down,
    // but seeds still wait for the ALTERs to finish before querying.
    bootMigrationsReady = applyBootMigrations(getPrisma());
    void bootMigrationsReady.then(({ applied, failed }) => {
      if (failed > 0) {
        console.warn(`[boot-migrate] completed with ${failed} failure(s); ${applied} succeeded`);
      } else if (applied > 0) {
        console.log(`[boot-migrate] ${applied} additive migration(s) applied`);
      }
    });
    return new PrismaStore();
  }
  if (config.nodeEnv === "production" && !config.allowMemoryInProd) {
    throw new Error(
      "STORE=memory is unsafe in production — the in-memory store wipes on every restart. " +
        "Set STORE=prisma (and DATABASE_URL), or override with CANTILA_ALLOW_MEMORY_IN_PROD=true.",
    );
  }
  return new InMemoryStore();
}
