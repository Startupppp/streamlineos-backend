SET statement_timeout = 0;
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
-- DB IS EMPTY — no row backfill required.
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 1: drop old value tables (children first)
-- ─────────────────────────────────────────────────────────────────────────────
DROP TABLE IF EXISTS "hr_custom_field_values";
--> statement-breakpoint
DROP TABLE IF EXISTS "ticket_custom_field_values";
--> statement-breakpoint
DROP TABLE IF EXISTS "support_ticket_custom_field_values";
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 2: drop old definition tables (parents after their children)
-- ─────────────────────────────────────────────────────────────────────────────
DROP TABLE IF EXISTS "hr_custom_field_definitions";
--> statement-breakpoint
DROP TABLE IF EXISTS "project_custom_fields";
--> statement-breakpoint
DROP TABLE IF EXISTS "support_custom_fields";
--> statement-breakpoint

-- The regenerated 0000 baseline snapshots a pre-consolidation
-- custom_field_definitions (no project_id, no key), so a cold replay reaches
-- Step 3 with the old shape already present. Dropping it here is the same
-- consolidation this migration already performs on its five siblings.
DROP TABLE IF EXISTS "custom_field_definitions" CASCADE;
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 3: unified definitions table
-- ─────────────────────────────────────────────────────────────────────────────
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
  "created_at"    TIMESTAMP   NOT NULL DEFAULT NOW(),
  "updated_at"    TIMESTAMP   NOT NULL DEFAULT NOW()
);
--> statement-breakpoint

CREATE UNIQUE INDEX "uniq_cfd_org_entity_project_key"
  ON "custom_field_definitions" ("org_id", "entity_type", "project_id", "key");
--> statement-breakpoint

CREATE INDEX "idx_cfd_org_entity_project_active"
  ON "custom_field_definitions" ("org_id", "entity_type", "project_id", "is_active");
--> statement-breakpoint

CREATE UNIQUE INDEX "uniq_cfd_org_id"
  ON "custom_field_definitions" ("org_id", "id");
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 4: typed HR value table (replaces polymorphic hr_custom_field_values)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "hr_employment_custom_field_values" (
  "id"                   SERIAL PRIMARY KEY,
  "org_id"               TEXT    NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "employment_id"        INTEGER NOT NULL REFERENCES "hr_employments"("id") ON DELETE CASCADE,
  "field_definition_id"  INTEGER NOT NULL REFERENCES "custom_field_definitions"("id") ON DELETE CASCADE,
  "value"                JSONB,
  "created_at"           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at"           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
--> statement-breakpoint

CREATE UNIQUE INDEX "uniq_hr_ecfv_employment_field"
  ON "hr_employment_custom_field_values" ("employment_id", "field_definition_id");
--> statement-breakpoint

CREATE INDEX "idx_hr_ecfv_org_employment"
  ON "hr_employment_custom_field_values" ("org_id", "employment_id");
--> statement-breakpoint

CREATE UNIQUE INDEX "uniq_hr_ecfv_org_id"
  ON "hr_employment_custom_field_values" ("org_id", "id");
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 5: Build ticket value table (FK now points to custom_field_definitions)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "ticket_custom_field_values" (
  "id"                   SERIAL PRIMARY KEY,
  "org_id"               TEXT    NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "ticket_id"            INTEGER NOT NULL REFERENCES "tickets"("id") ON DELETE CASCADE,
  "field_definition_id"  INTEGER NOT NULL REFERENCES "custom_field_definitions"("id") ON DELETE CASCADE,
  "value"                TEXT,
  "created_at"           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at"           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
--> statement-breakpoint

CREATE UNIQUE INDEX "uniq_ticket_custom_field_values"
  ON "ticket_custom_field_values" ("ticket_id", "field_definition_id");
--> statement-breakpoint

CREATE INDEX "idx_ticket_custom_field_values_ticket"
  ON "ticket_custom_field_values" ("ticket_id");
--> statement-breakpoint

CREATE UNIQUE INDEX "uniq_tcfv_org_id"
  ON "ticket_custom_field_values" ("org_id", "id");
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 6: Support ticket value table (FK now points to custom_field_definitions)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "support_ticket_custom_field_values" (
  "id"                   SERIAL PRIMARY KEY,
  "org_id"               TEXT    NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "ticket_id"            INTEGER NOT NULL REFERENCES "support_tickets"("id") ON DELETE CASCADE,
  "field_definition_id"  INTEGER NOT NULL REFERENCES "custom_field_definitions"("id") ON DELETE CASCADE,
  "value"                TEXT,
  "created_at"           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at"           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
--> statement-breakpoint

CREATE UNIQUE INDEX "uniq_support_ticket_custom_field_values_ticket_field"
  ON "support_ticket_custom_field_values" ("ticket_id", "field_definition_id");
--> statement-breakpoint

CREATE INDEX "idx_support_ticket_custom_field_values_org_ticket"
  ON "support_ticket_custom_field_values" ("org_id", "ticket_id");
--> statement-breakpoint

CREATE UNIQUE INDEX "uniq_stcfv_org_id"
  ON "support_ticket_custom_field_values" ("org_id", "id");
