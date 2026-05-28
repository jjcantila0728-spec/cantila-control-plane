/* ============================================================
   PrismaClient singleton.
   Lazily constructed so the default in-memory store path never
   spins up a client — only PrismaStore calls getPrisma().
   ============================================================ */

import { PrismaClient } from "@prisma/client";

let client: PrismaClient | undefined;

/** The process-wide PrismaClient, created on first use. */
export function getPrisma(): PrismaClient {
  if (!client) {
    client = new PrismaClient();
  }
  return client;
}
