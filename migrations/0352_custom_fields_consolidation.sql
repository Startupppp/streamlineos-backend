-- 0352 — consolidate three duplicate custom-field implementations
-- =============================================================================
-- Three independent custom-field engine implementations are collapsed into one:
--
--   hr_custom_field_definitions + hr_custom_field_values  (hr/core-org.ts)
--   project_custom_fields + ticket_custom_field_values    (build/tasks.ts)
--   support_custom_fields + support_ticket_custom_field_values (support/custom-fields.ts)
--
-- DEFECT FIXED
--   hr_custom_field_values.entity_id was TEXT with no FK — polymorphic and
--   un-verifiable. Replaced by hr_employment_custom_field_values.employment_id
--   → hr_employments.id (typed FK).
--
-- NEW SCHEMA
--   custom_field_definitions          — one unified definitions table
--                                       keyed (org_id, entity_type, project_id, key)
--                                       project_id = 0 means org-wide (HR, Support)
--                                       project_id > 0 scopes to a Build project
--   hr_employment_custom_field_values — typed HR values (FK → hr_employments.id)
--   ticket_custom_field_values        — recreated (FK now → custom_field_definitions)
--   support_ticket_custom_field_values— recreated (FK now → custom_field_definitions)
--
-- =============================================================================
-- PEND-DB — why this file is now one guarded block
-- =============================================================================
-- This migration was the first failure of a cold build and the reason
-- `pnpm db:bootstrap` could not reach head: `FAILED at 0352 (72/355 ok)`,
-- `relation "custom_field_definitions" already exists`. On a database that
-- already had it, 0352 was skipped as applied and nobody saw it; on an empty
-- one it was reached and refused. That is 91 migrations' worth of work behind a
-- table name.
--
-- ## It is not a duplicate table. It is two different tables with one name.
--
-- `0000_light_vance_astro.sql:6074` creates a `custom_field_definitions` with
-- `name`, `sort_order` and `created_by`. This file creates one with `key`,
-- `project_id`, `settings`, `is_sensitive`, `category` and `display_order`. So
-- the obvious fix — `CREATE TABLE IF NOT EXISTS` — is the worst available
-- outcome: the statement succeeds, the *old* shape survives, every index and
-- foreign key below it fails on columns that are not there, and if any of them
-- had succeeded the application would be running against a table that does not
-- match `src/db/schema/custom-field-engine.ts` at all. A green migration and a
-- schema nobody declared.
--
-- The old table is therefore **reshaped in place** rather than skipped or
-- dropped: renamed columns keep whatever rows are in them, and the four columns
-- the unified engine adds arrive with defaults. On the cold build this is an
-- empty table and the effect is identical to creating it; on any database that
-- somehow carries rows from the pre-0352 engine, they survive.
--
-- ## The whole file is guarded, because editing it makes it re-run
--
-- `db-bootstrap.mjs` skips a migration by the **sha256 of its contents**. Editing
-- this file changes that hash, so on every database where the old 0352 was
-- applied, this one runs again. The original would have been catastrophic that
-- second time: step 1 drops `ticket_custom_field_values` and
-- `support_ticket_custom_field_values`, and steps 5 and 6 recreate them empty —
-- somebody's custom field values, deleted by a migration marked "DB IS EMPTY".
--
-- So the first thing the block does is ask whether the consolidation has already
-- happened, by looking for the one column that only the new shape has, and
-- returns without touching anything if it has. Three cases, all safe:
--
--   * nothing exists yet          → create the unified table and its children
--   * 0000's table exists         → reshape it, then create the children
--   * already consolidated        → do nothing at all
--
-- `IF NOT EXISTS` on the children rather than `DROP`+`CREATE` for the same
-- reason: this file may run on a database that has data in them.
--
-- ## One state this file cannot repair, and why that is correct
--
-- The `tickets` reference in step 5 is unqualified. That resolves at *this*
-- position in the journal, where `tickets` is still in `public`; `0432` later
-- moves it to the `build` schema. So running this file by hand against a
-- database that is past 0432 and has NOT consolidated will fail on `tickets`.
--
-- That state is unreachable by any supported path: `db-bootstrap.mjs` exits on
-- the first failure, so a database cannot get to 0432 having skipped 0352. It
-- exists only where somebody applied migrations file by file continuing past
-- errors — which is how the throwaway database NEO-16 was verified on came to
-- carry 0000's shape of this table while running everything after it. On every
-- database an in-order migration can produce, either the guard returns early or
-- `tickets` is where step 5 expects it.
-- =============================================================================

SET statement_timeout = 0;
SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  -- `key` exists only on the unified shape. Its presence is the migration's
  -- own record that it has run, independent of the bookkeeping table.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'custom_field_definitions'
       AND column_name = 'key'
  ) THEN
    RAISE NOTICE '0352: custom fields are already consolidated; nothing to do.';
    RETURN;
  END IF;

  -- ───────────────────────────────────────────────────────────────────────────
  -- Step 1: drop old value tables (children first)
  -- ───────────────────────────────────────────────────────────────────────────
  DROP TABLE IF EXISTS "hr_custom_field_values";
  DROP TABLE IF EXISTS "ticket_custom_field_values";
  DROP TABLE IF EXISTS "support_ticket_custom_field_values";

  -- ───────────────────────────────────────────────────────────────────────────
  -- Step 2: drop old definition tables (parents after their children)
  -- ───────────────────────────────────────────────────────────────────────────
  DROP TABLE IF EXISTS "hr_custom_field_definitions";
  DROP TABLE IF EXISTS "project_custom_fields";
  DROP TABLE IF EXISTS "support_custom_fields";

  -- ───────────────────────────────────────────────────────────────────────────
  -- Step 3: unified definitions table
  -- ───────────────────────────────────────────────────────────────────────────
  IF to_regclass('public.custom_field_definitions') IS NULL THEN
    CREATE TABLE "custom_field_definitions" (
      "id"            SERIAL PRIMARY KEY,
      "org_id"        TEXT    NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
      "entity_type"   TEXT    NOT NULL,
      "project_id"    INTEGER NOT NULL DEFAULT 0,
      "key"           TEXT    NOT NULL,
      "label"         TEXT    NOT NULL,
      "field_type"    TEXT    NOT NULL,
      "options"       JSONB,
      "settings"      JSONB,
      "is_sensitive"  BOOLEAN NOT NULL DEFAULT FALSE,
      "is_required"   BOOLEAN NOT NULL DEFAULT FALSE,
      "category"      TEXT,
      "is_active"     BOOLEAN NOT NULL DEFAULT TRUE,
      "display_order" INTEGER NOT NULL DEFAULT 0,
      "created_at"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updated_at"    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  ELSE
    -- 0000's shape, reshaped rather than replaced. The renames carry the rows;
    -- `created_by` goes with its foreign key, which `DROP COLUMN` removes.
    ALTER TABLE "custom_field_definitions" RENAME COLUMN "name" TO "key";
    ALTER TABLE "custom_field_definitions" RENAME COLUMN "sort_order" TO "display_order";
    ALTER TABLE "custom_field_definitions" DROP COLUMN IF EXISTS "created_by";
    ALTER TABLE "custom_field_definitions" ADD COLUMN "project_id" INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE "custom_field_definitions" ADD COLUMN "settings" JSONB;
    ALTER TABLE "custom_field_definitions" ADD COLUMN "is_sensitive" BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE "custom_field_definitions" ADD COLUMN "category" TEXT;
    -- The unified engine states the type on every definition; 0000 defaulted it
    -- to 'text', which let a caller omit the one field that says what a field is.
    ALTER TABLE "custom_field_definitions" ALTER COLUMN "field_type" DROP DEFAULT;
    -- Superseded by `uniq_cfd_org_entity_project_key` below, and it followed the
    -- rename, so it is now an index on `key` under a name that says `name`.
    DROP INDEX IF EXISTS "cfd_org_entity_name_idx";
  END IF;

  CREATE UNIQUE INDEX IF NOT EXISTS "uniq_cfd_org_entity_project_key"
    ON "custom_field_definitions" ("org_id", "entity_type", "project_id", "key");
  CREATE INDEX IF NOT EXISTS "idx_cfd_org_entity_project_active"
    ON "custom_field_definitions" ("org_id", "entity_type", "project_id", "is_active");
  CREATE UNIQUE INDEX IF NOT EXISTS "uniq_cfd_org_id"
    ON "custom_field_definitions" ("org_id", "id");

  -- ───────────────────────────────────────────────────────────────────────────
  -- Step 4: typed HR value table (replaces polymorphic hr_custom_field_values)
  -- ───────────────────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS "hr_employment_custom_field_values" (
    "id"                   SERIAL PRIMARY KEY,
    "org_id"               TEXT    NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
    "employment_id"        INTEGER NOT NULL REFERENCES "hr_employments"("id") ON DELETE CASCADE,
    "field_definition_id"  INTEGER NOT NULL REFERENCES "custom_field_definitions"("id") ON DELETE CASCADE,
    "value"                JSONB,
    "created_at"           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updated_at"           TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE UNIQUE INDEX IF NOT EXISTS "uniq_hr_ecfv_employment_field"
    ON "hr_employment_custom_field_values" ("employment_id", "field_definition_id");
  CREATE INDEX IF NOT EXISTS "idx_hr_ecfv_org_employment"
    ON "hr_employment_custom_field_values" ("org_id", "employment_id");
  CREATE UNIQUE INDEX IF NOT EXISTS "uniq_hr_ecfv_org_id"
    ON "hr_employment_custom_field_values" ("org_id", "id");

  -- ───────────────────────────────────────────────────────────────────────────
  -- Step 5: Build ticket value table (FK now points to custom_field_definitions)
  -- ───────────────────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS "ticket_custom_field_values" (
    "id"                   SERIAL PRIMARY KEY,
    "org_id"               TEXT    NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
    "ticket_id"            INTEGER NOT NULL REFERENCES "tickets"("id") ON DELETE CASCADE,
    "field_definition_id"  INTEGER NOT NULL REFERENCES "custom_field_definitions"("id") ON DELETE CASCADE,
    "value"                TEXT,
    "created_at"           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updated_at"           TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE UNIQUE INDEX IF NOT EXISTS "uniq_ticket_custom_field_values"
    ON "ticket_custom_field_values" ("ticket_id", "field_definition_id");
  CREATE INDEX IF NOT EXISTS "idx_ticket_custom_field_values_ticket"
    ON "ticket_custom_field_values" ("ticket_id");
  CREATE UNIQUE INDEX IF NOT EXISTS "uniq_tcfv_org_id"
    ON "ticket_custom_field_values" ("org_id", "id");

  -- ───────────────────────────────────────────────────────────────────────────
  -- Step 6: Support ticket value table (FK now points to custom_field_definitions)
  -- ───────────────────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS "support_ticket_custom_field_values" (
    "id"                   SERIAL PRIMARY KEY,
    "org_id"               TEXT    NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
    "ticket_id"            INTEGER NOT NULL REFERENCES "support_tickets"("id") ON DELETE CASCADE,
    "field_definition_id"  INTEGER NOT NULL REFERENCES "custom_field_definitions"("id") ON DELETE CASCADE,
    "value"                TEXT,
    "created_at"           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updated_at"           TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE UNIQUE INDEX IF NOT EXISTS "uniq_support_ticket_custom_field_values_ticket_field"
    ON "support_ticket_custom_field_values" ("ticket_id", "field_definition_id");
  CREATE INDEX IF NOT EXISTS "idx_support_ticket_custom_field_values_org_ticket"
    ON "support_ticket_custom_field_values" ("org_id", "ticket_id");
  CREATE UNIQUE INDEX IF NOT EXISTS "uniq_stcfv_org_id"
    ON "support_ticket_custom_field_values" ("org_id", "id");

  RAISE NOTICE '0352: custom fields consolidated.';
END $$;
