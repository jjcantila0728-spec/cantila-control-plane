#!/usr/bin/env node
/* ============================================================
   One-shot baseline: mark every existing `prisma/migrations/<dir>`
   as applied against the live database (plan §15.7 / v1.18 — F).

   Why this exists:
   - Cantila's prod Postgres was provisioned via `prisma db push`,
     so the `_prisma_migrations` bookkeeping table is empty.
   - `prisma migrate deploy` therefore can't run against this DB —
     it would try to apply every existing migration on top of
     already-present tables and fail at the first CREATE.
   - This script walks the migrations dir and runs
     `prisma migrate resolve --applied <name>` for each, which
     inserts the bookkeeping row WITHOUT touching schema.
   - After this runs once, `migrate deploy` becomes the canonical
     schema-change path and the boot-migration runner retires.

   Run ONCE per environment, against the target `DATABASE_URL`:
     DATABASE_URL=postgres://… node scripts/baseline-prisma-migrations.mjs

   Idempotent — Prisma's resolve command is a no-op on rows that
   are already marked applied, so re-running is safe.
   ============================================================ */

import { readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const MIGRATIONS_DIR = resolve(process.cwd(), "prisma", "migrations");

function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

const names = readdirSync(MIGRATIONS_DIR)
  .filter((n) => isDir(resolve(MIGRATIONS_DIR, n)))
  .sort();

if (names.length === 0) {
  console.error("no migrations found under prisma/migrations/ — nothing to baseline");
  process.exit(1);
}

console.log(`▸ baselining ${names.length} migration(s) against ${process.env.DATABASE_URL ?? "<DATABASE_URL unset>"}`);

let ok = 0;
let fail = 0;
for (const name of names) {
  process.stdout.write(`  • ${name} … `);
  // `shell: true` is required on Windows where `npx` is a `.cmd`
  // shim; on POSIX it's a harmless extra `sh -c`. Prisma's success
  // message goes to stdout, errors to stderr.
  const r = spawnSync(
    "npx",
    ["--yes", "prisma", "migrate", "resolve", "--applied", name],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      shell: true,
    },
  );
  const stdout = (r.stdout ?? Buffer.from("")).toString("utf8");
  const stderr = (r.stderr ?? Buffer.from("")).toString("utf8");
  if (r.status === 0) {
    // Prisma prints "marked as applied" on first apply; subsequent
    // calls go through without that line and still exit 0.
    console.log(/marked as applied/i.test(stdout) ? "ok" : "already applied");
    ok++;
  } else {
    // Some Prisma versions report "is already recorded as applied"
    // via stderr + non-zero exit on re-run — treat that as success
    // since the desired state is reached.
    if (/already recorded/i.test(stderr) || /already recorded/i.test(stdout)) {
      console.log("already applied");
      ok++;
    } else {
      console.log("FAILED");
      const combined = (stderr + stdout).split("\n").filter(Boolean);
      console.error(combined.map((l) => `      ${l}`).join("\n"));
      fail++;
    }
  }
}

console.log("");
console.log(`▸ done · ${ok} ok · ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
