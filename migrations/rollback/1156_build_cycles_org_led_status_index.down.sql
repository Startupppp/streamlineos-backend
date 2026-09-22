-- Rollback for migration 1156.
--
-- Restores the project-led index a-sprint-cycle-03-constrain.sql created and 1155 journalled,
-- then drops the org-led replacement. Order matters: recreate before dropping, so the cycle
-- reads are never left with neither index.
--
-- Rolling back reinstates the BE-44 and BE-79 violation 1156 exists to fix. No data is lost.

SET lock_timeout = '5s';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_cycles_project_status_live"
  ON "build"."cycles" ("project_id", "status")
  WHERE "deleted_at" IS NULL;
--> statement-breakpoint

DROP INDEX IF EXISTS "build"."idx_cycles_org_project_status_live";
