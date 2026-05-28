/* ============================================================
   Store factory — selects the persistence backend (config.store):
     "memory"  (default) — InMemoryStore, zero infrastructure
     "prisma"            — PrismaStore, backed by PostgreSQL
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
  return new InMemoryStore();
}
