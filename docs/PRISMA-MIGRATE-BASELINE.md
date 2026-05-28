# Promoting `prisma db push` → `prisma migrate deploy`

**Status:** drafted in v1.18, NOT yet applied to live Postgres.

This is the operational cutover documented in plan §15.7 / v1.18 — F.
It is a one-shot operator action that flips the canonical schema
path from `prisma db push` (the bootstrap) to baselined
`prisma migrate deploy` (the production discipline).

## Why this matters

Today (v1.17) the live `cantila-control-plane` Postgres is schema-
managed by `prisma db push`, run once at v1.12 against the empty
database. Every subsequent additive column rides through the boot-
migration runner (`src/domain/boot-migrations.ts`) on control-plane
startup. That worked for v1.12 → v1.17, but it has two known
weaknesses:

1. **Destructive changes can't ride.** The boot-runner is restricted
   to additive `IF NOT EXISTS` ALTERs by design. A column rename or
   a NOT NULL backfill needs an operator-supervised step today.
2. **No bookkeeping = no rollback.** The empty `_prisma_migrations`
   table means there's no audit trail of which schema-version the
   live DB is at, so a regression has nothing to anchor against.

Switching to `prisma migrate deploy` solves both — destructive
migrations are first-class, and every applied migration becomes an
auditable row.

## The cutover steps

### 1. Verify the live schema is in sync with `prisma/schema.prisma`

The boot-migration runner has applied every nullable-column add in
v1.17 (`Project.coolifyAppUuid`) and v1.18 (`User.emailVerifiedAt`),
so by the time the v1.18 control-plane is deployed the live schema
should match `schema.prisma`.

Run a dry compare:

```bash
DATABASE_URL=postgres://… npx prisma db push --skip-generate --print
```

This prints the SQL `db push` would run against the live DB. The
expected output is empty (`The database is in sync with the schema`).
If anything is listed, the boot-migration runner hasn't caught up
yet — redeploy the control-plane and confirm the log shows every
boot-migration ran ok, then re-check.

### 2. Run the baseline script

```bash
DATABASE_URL=postgres://… npm run prisma:baseline
```

The script walks `prisma/migrations/` in chronological order and
runs `npx prisma migrate resolve --applied <name>` for each. This
inserts a row into `_prisma_migrations` for every existing
migration WITHOUT touching schema, so the resolved state is "every
migration is recorded as already applied".

The script is idempotent — re-running surfaces "already applied"
per row and exits 0.

### 3. Verify `prisma migrate status` is clean

```bash
DATABASE_URL=postgres://… npx prisma migrate status
```

Expected output: `Database schema is up to date!` — every
migration directory appears under "Following migrations have been
applied".

### 4. Retire the boot-migration runner (next deploy)

Once the baseline holds, the boot-migration runner becomes a
safety net. Two options:

- **Leave it in place.** It's idempotent and the only cost is the
  per-boot SQL — a handful of `IF NOT EXISTS` runs. This is the
  recommended path for a few weeks while operator muscle memory
  catches up.
- **Switch to running `prisma migrate deploy` at boot.** Add to
  the Nixpacks start command (`prisma migrate deploy && node dist/
  index.js`) or to a separate release-phase step. The boot-runner
  can then be removed from `src/index.ts` and the file deleted.

### 5. Author future schema changes as Prisma migrations

After the baseline, every schema change rides through:

```bash
# Authoring (locally, against a dev DB)
DATABASE_URL=postgres://localhost/cantila npx prisma migrate dev --name <change>

# Deploying (CI, against prod)
DATABASE_URL=$PROD_DATABASE_URL npx prisma migrate deploy
```

The boot-migration runner is no longer used for new changes.

## Rollback

If a baseline migration fails partway through, the database is
unchanged — `migrate resolve --applied` is a single INSERT per
migration and there's no DDL. Re-run the script after fixing the
cause; the rows already inserted are recognised as "already
applied" on the second pass.

If `_prisma_migrations` itself is in a bad state after the
baseline, the manual rescue is:

```sql
TRUNCATE "_prisma_migrations";
```

…and re-run `npm run prisma:baseline`. This is a no-data-loss
operation — only the bookkeeping table is touched.
