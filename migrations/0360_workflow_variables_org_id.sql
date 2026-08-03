SET statement_timeout = 0;
-- 0360 — workflow_versions + workflow_variables tenant isolation (idempotent)
-- =============================================================================
-- Gap: workflow_versions and workflow_variables carry no direct org_id.
-- Tenant scoping relied transitively through the workflow_id / workflow_version_id
-- FK chain ending at workflows.org_id. Every other tenant table in this schema
-- carries a direct org_id with a leading composite index and a composite FK (§19).
-- workflowSecrets (same file) already has org_id — an explicit inconsistency.
--
-- Part 1: workflow_versions
--   Chain: workflow_versions.workflow_id → workflows (has org_id).
--   Add org_id, backfill from workflows, NOT NULL, FK to organizations,
--   composite FK (org_id, workflow_id) → workflows(org_id, id),
--   leading composite index, UNIQUE(org_id, id) candidate key.
--
-- Part 2: workflow_variables
--   Chain: workflow_variables.workflow_version_id → workflow_versions → workflows.
--   Since Part 1 populates workflow_versions.org_id, backfill is a single hop.
--   Add org_id, backfill from workflow_versions.org_id, NOT NULL, FK to
--   organizations, composite FK (org_id, workflow_version_id) →
--   workflow_versions(org_id, id), leading composite index, UNIQUE(org_id, id).
-- =============================================================================

-- ============================================================
-- Part 1: workflow_versions
-- ============================================================

ALTER TABLE "workflow_versions" ADD COLUMN IF NOT EXISTS "org_id" text;
--> statement-breakpoint
UPDATE "workflow_versions" wv
SET    "org_id" = w."org_id"
FROM   "workflows" w
WHERE  wv."workflow_id" = w."id"
  AND  wv."org_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "workflow_versions" ALTER COLUMN "org_id" SET NOT NULL;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workflow_versions_org_id_organizations_id_fk'
      AND conrelid = 'workflow_versions'::regclass
  ) THEN
    ALTER TABLE "workflow_versions"
      ADD CONSTRAINT "workflow_versions_org_id_organizations_id_fk"
      FOREIGN KEY ("org_id")
      REFERENCES "organizations" ("id")
      ON DELETE CASCADE;
  END IF;
END;
$$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_workflow_versions_org_workflow'
      AND conrelid = 'workflow_versions'::regclass
  ) THEN
    ALTER TABLE "workflow_versions"
      ADD CONSTRAINT "fk_workflow_versions_org_workflow"
      FOREIGN KEY ("org_id", "workflow_id")
      REFERENCES "workflows" ("org_id", "id")
      ON DELETE CASCADE;
  END IF;
END;
$$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workflow_versions_org"
  ON "workflow_versions" ("org_id", "workflow_id");
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uniq_workflow_versions_org_id'
      AND conrelid = 'workflow_versions'::regclass
  ) THEN
    ALTER TABLE "workflow_versions"
      ADD CONSTRAINT "uniq_workflow_versions_org_id"
      UNIQUE ("org_id", "id");
  END IF;
END;
$$;

-- ============================================================
-- Part 2: workflow_variables
-- ============================================================

ALTER TABLE "workflow_variables" ADD COLUMN IF NOT EXISTS "org_id" text;
--> statement-breakpoint
UPDATE "workflow_variables" wvar
SET    "org_id" = wv."org_id"
FROM   "workflow_versions" wv
WHERE  wvar."workflow_version_id" = wv."id"
  AND  wvar."org_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "workflow_variables" ALTER COLUMN "org_id" SET NOT NULL;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workflow_variables_org_id_organizations_id_fk'
      AND conrelid = 'workflow_variables'::regclass
  ) THEN
    ALTER TABLE "workflow_variables"
      ADD CONSTRAINT "workflow_variables_org_id_organizations_id_fk"
      FOREIGN KEY ("org_id")
      REFERENCES "organizations" ("id")
      ON DELETE CASCADE;
  END IF;
END;
$$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_workflow_variables_org_version'
      AND conrelid = 'workflow_variables'::regclass
  ) THEN
    ALTER TABLE "workflow_variables"
      ADD CONSTRAINT "fk_workflow_variables_org_version"
      FOREIGN KEY ("org_id", "workflow_version_id")
      REFERENCES "workflow_versions" ("org_id", "id")
      ON DELETE CASCADE;
  END IF;
END;
$$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workflow_variables_org"
  ON "workflow_variables" ("org_id", "workflow_version_id");
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uniq_workflow_variables_org_id'
      AND conrelid = 'workflow_variables'::regclass
  ) THEN
    ALTER TABLE "workflow_variables"
      ADD CONSTRAINT "uniq_workflow_variables_org_id"
      UNIQUE ("org_id", "id");
  END IF;
END;
$$;
