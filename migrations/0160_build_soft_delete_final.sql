-- 0160: Soft delete for the last four Build entities without it.
--
-- project_milestones, project_releases, project_templates, project_whiteboards
-- each receive a nullable deleted_at column and partial indexes that exclude
-- deleted rows so list queries stay efficient.  Existing hot indexes (non-
-- partial) are replaced; unique/candidate-key indexes are unchanged.
--
-- Hard deletes that STAY hard (§19 exceptions):
--   release_tickets              — join/link table, not a business entity
--   project_whiteboard_shares    — join/link table
--   project_template_tickets     — cascade child of soft-deleted template;
--                                  template soft-delete already hides them
--
-- project_releases.affected_release_id / fixed_release_id (bugs table) carry
-- ON DELETE SET NULL so bugs retain their FK slots NULL-safe after a release
-- is soft-deleted.  Pickers and rollups filter deletedAt IS NULL at the app.
--
-- VACUUM ANALYZE must follow as an operator step after apply.  An ADD COLUMN
-- empties the visibility map; Index Only Scans stay degraded until VACUUM runs
-- (measured elsewhere: a COUNT went 37 -> 3 340 blocks, only VACUUM fixed it).

SET lock_timeout = '5s';

-- ─── project_milestones ───────────────────────────────────────────────────────

ALTER TABLE "project_milestones" ADD COLUMN "deleted_at" timestamp with time zone;
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_project_milestones_project";
--> statement-breakpoint
CREATE INDEX "idx_project_milestones_project" ON "project_milestones" ("project_id") WHERE deleted_at IS NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_project_milestones_org";
--> statement-breakpoint
CREATE INDEX "idx_project_milestones_org" ON "project_milestones" ("org_id") WHERE deleted_at IS NULL;
--> statement-breakpoint

-- ─── project_releases ─────────────────────────────────────────────────────────

ALTER TABLE "project_releases" ADD COLUMN "deleted_at" timestamp with time zone;
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_project_releases_project";
--> statement-breakpoint
CREATE INDEX "idx_project_releases_project" ON "project_releases" ("project_id") WHERE deleted_at IS NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_project_releases_org_status";
--> statement-breakpoint
CREATE INDEX "idx_project_releases_org_status" ON "project_releases" ("org_id", "status") WHERE deleted_at IS NULL;
--> statement-breakpoint

-- ─── project_templates ────────────────────────────────────────────────────────

ALTER TABLE "project_templates" ADD COLUMN "deleted_at" timestamp with time zone;
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_project_templates_org";
--> statement-breakpoint
CREATE INDEX "idx_project_templates_org" ON "project_templates" ("org_id") WHERE deleted_at IS NULL;
--> statement-breakpoint

-- ─── project_whiteboards ──────────────────────────────────────────────────────

ALTER TABLE "project_whiteboards" ADD COLUMN "deleted_at" timestamp with time zone;
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_project_whiteboards_org_project";
--> statement-breakpoint
CREATE INDEX "idx_project_whiteboards_org_project" ON "project_whiteboards" ("org_id", "project_id") WHERE deleted_at IS NULL;
--> statement-breakpoint

-- ─── update planner statistics ────────────────────────────────────────────────
-- VACUUM ANALYZE is required as a follow-up operator step (illegal inside a
-- transaction block that drizzle-kit wraps migrations in).

ANALYZE "project_milestones";
--> statement-breakpoint
ANALYZE "project_releases";
--> statement-breakpoint
ANALYZE "project_templates";
--> statement-breakpoint
ANALYZE "project_whiteboards";