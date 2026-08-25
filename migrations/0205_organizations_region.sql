-- Custom SQL migration file, put your code below! --

-- Places every organisation in a region.
--
-- Authored by hand via `generate --custom` because `db:generate` cannot run
-- non-interactively in this repo: it stops on a pre-existing table-rename prompt
-- unrelated to this change. The Drizzle snapshot therefore does not yet carry
-- this column, and should be reconciled when that prompt is resolved.
--
-- The column is nullable on purpose. An unplaced organisation has to be
-- representable so that resolution fails closed instead of guessing a region and
-- writing a tenant's rows into the wrong database.

SET lock_timeout = '5s';

-- Catalog-only in modern Postgres: no default, no table rewrite, no long lock.
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "region" text;

-- Existing rows predate regions, so they belong to the deployment that already
-- serves them. 'primary' is the documented default and matches PRIMARY_REGION's
-- own default; a deployment that sets PRIMARY_REGION to something else must
-- update these rows to match, or resolution will fail closed for them.
--
-- Written as one statement rather than batched: organizations holds one row per
-- customer, so this is orders of magnitude smaller than the tables the batching
-- rule exists for.
UPDATE "organizations" SET "region" = 'primary' WHERE "region" IS NULL;
