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
import type { Store } from "./store";
import { InMemoryStore } from "./store";
import { PrismaStore } from "./prisma-store";

export function createStore(): Store {
  if (config.store === "prisma") {
    if (!config.databaseUrl) {
      throw new Error("STORE=prisma requires DATABASE_URL — set it in .env");
    }
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
