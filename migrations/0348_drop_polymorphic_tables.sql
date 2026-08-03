SET statement_timeout = 0;
-- 0348 — retire polymorphic tables: group_roles and resource_grants
-- =============================================================================
-- Two polymorphic tables carried untyped integer/string identifiers with no FK
-- constraints, making cross-tenant safety unprovable and breaking cascade safety.
-- Typed replacements already exist; this migration completes the swap.
--
-- CHANGES
--   A. Create kb_space_grants (typed home for 'kb:space' resource grants)
--      • Backfill from resource_grants WHERE resource_type = 'kb:space'
--      • Drop resource_grants
--
--   B. Backfill group_role_assignments from group_roles (best-effort for
--      populated environments; no-op on the empty live DB)
--      • Drop group_roles
--      • Drop the now-unused principal_group_type enum
--
-- NOT DROPPED — reported as blocker
--   departments / department_members
--       Still referenced by schema files outside this migration's ownership:
--       hr/core-people.ts (hr_employments.department_id FK), hr/governance.ts
--       (hr_positions.department_id FK), hr/hiring.ts (job_postings,
--       headcount_requests), accounting/accounting.ts (journal_lines),
--       accounting/finance-planning.ts (fin_budget_lines), hr/documents.ts,
--       hr/enterprise-comp.ts, hr/workforce-planning.ts.
--       Schedule a separate migration to migrate those FK columns to org_units.id
--       (kind='DEPARTMENT') and then drop these two tables.
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- A-1. Create kb_space_grants
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "kb_space_grants" (
  "id"             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id"         TEXT        NOT NULL,
  "space_id"       INTEGER     NOT NULL,
  "principal_type" TEXT        NOT NULL DEFAULT 'user',
  "principal_id"   TEXT        NOT NULL,
  "permission_key" TEXT        NOT NULL,
  "granted_by"     TEXT,
  "created_at"     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_kb_space_grants"
  ON "kb_space_grants" ("org_id", "space_id", "principal_type", "principal_id", "permission_key");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_kb_space_grants_org_space"
  ON "kb_space_grants" ("org_id", "space_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_kb_space_grants_principal"
  ON "kb_space_grants" ("org_id", "principal_type", "principal_id");
--> statement-breakpoint

-- FK to organizations: org_id must belong to an existing org.
DO $$ BEGIN
  ALTER TABLE "kb_space_grants"
    ADD CONSTRAINT "fk_kb_space_grants_org"
    FOREIGN KEY ("org_id")
    REFERENCES "organizations"("id")
    ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

-- FK to kb_spaces: space_id must be a valid space within the same org.
-- SQL-only — common/access.ts must not import from kb/spaces.ts to avoid a
-- cross-module Drizzle circular dependency.
DO $$ BEGIN
  ALTER TABLE "kb_space_grants"
    ADD CONSTRAINT "fk_kb_space_grants_space"
    FOREIGN KEY ("space_id")
    REFERENCES "kb_spaces"("id")
    ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

-- FK to users: granted_by is nullable (SET NULL when granter leaves).
DO $$ BEGIN
  ALTER TABLE "kb_space_grants"
    ADD CONSTRAINT "fk_kb_space_grants_granted_by"
    FOREIGN KEY ("granted_by")
    REFERENCES "users"("id")
    ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- A-2. Backfill kb_space_grants from resource_grants (populated-env only)
--
-- resource_grants.resource_id is VARCHAR(36) but kb_spaces.id is INTEGER (serial).
-- Cast to INTEGER; non-integer values are skipped via the WHERE clause filter
-- (a malformed resource_id would cause a cast error — wrap in a try-block to
-- preserve idempotency on partially-migrated databases).
-- ─────────────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  INSERT INTO "kb_space_grants" (
    "id",
    "org_id",
    "space_id",
    "principal_type",
    "principal_id",
    "permission_key",
    "granted_by",
    "created_at"
  )
  SELECT
    gen_random_uuid(),
    rg."org_id",
    rg."resource_id"::integer,
    rg."principal_type",
    rg."principal_id",
    rg."permission_key",
    NULLIF(rg."granted_by", ''),
    rg."created_at"
  FROM "resource_grants" rg
  WHERE rg."resource_type" = 'kb:space'
    AND rg."resource_id" ~ '^\d+$'
  ON CONFLICT ("org_id", "space_id", "principal_type", "principal_id", "permission_key") DO NOTHING;
EXCEPTION WHEN undefined_table THEN NULL; END $$;
--> statement-breakpoint

-- Guard: warn on resource_grants rows with resource_type != 'kb:space'.
-- If any exist the migration raises and must be retried after those types
-- are migrated to their own typed tables.
DO $$
DECLARE
  v_count bigint;
BEGIN
  BEGIN
    SELECT COUNT(*) INTO v_count
    FROM "resource_grants"
    WHERE "resource_type" <> 'kb:space';
  EXCEPTION WHEN undefined_table THEN
    v_count := 0;
  END;

  IF v_count > 0 THEN
    RAISE EXCEPTION
      '% resource_grants row(s) have resource_type != ''kb:space'' and have no typed home. '
      'Migrate those types first, then re-run this migration.',
      v_count;
  END IF;
END $$;
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- A-3. Drop resource_grants
-- ─────────────────────────────────────────────────────────────────────────────
DROP TABLE IF EXISTS "resource_grants" CASCADE;
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- B-1. Backfill group_role_assignments from group_roles (populated-env only)
--
-- Mapping: group_roles.group_id (integer department id) → principal_groups.id
-- via departments.name → org_units (kind='DEPARTMENT') → principal_groups.
-- Silently skips rows where no matching principal_groups row exists (i.e. the
-- populated env has not yet run the principal_groups seeding step).
-- ─────────────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  INSERT INTO "group_role_assignments" (
    "id",
    "org_id",
    "principal_group_id",
    "role_id",
    "created_at"
  )
  SELECT
    gen_random_uuid(),
    gr."org_id",
    pg."id",
    gr."role_id",
    gr."created_at"
  FROM "group_roles" gr
  JOIN "departments" d
    ON d."id" = gr."group_id"
    AND d."org_id" = gr."org_id"
  JOIN "org_units" ou
    ON ou."org_id" = gr."org_id"
    AND ou."kind" = 'DEPARTMENT'
    AND ou."name" = d."name"
    AND ou."deleted_at" IS NULL
  JOIN "principal_groups" pg
    ON pg."org_unit_id" = ou."id"
    AND pg."org_id" = gr."org_id"
    AND pg."kind" = 'ORG_UNIT'
  WHERE gr."group_type" = 'department'
  ON CONFLICT ("org_id", "principal_group_id", "role_id") DO NOTHING;
EXCEPTION WHEN undefined_table THEN NULL; END $$;
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- B-2. Drop group_roles
-- ─────────────────────────────────────────────────────────────────────────────
DROP TABLE IF EXISTS "group_roles" CASCADE;
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- B-3. Drop the principal_group_type enum (only used by group_roles.group_type)
-- ─────────────────────────────────────────────────────────────────────────────
DROP TYPE IF EXISTS "principal_group_type";
