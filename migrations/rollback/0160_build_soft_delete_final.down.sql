-- Rollback for 0160_build_soft_delete_final
-- Drops the four deleted_at columns and restores the original non-partial indexes.
--
-- Migration 0432 moved project_milestones, project_releases, project_templates,
-- and project_whiteboards from public to the build schema.
-- All table references and index qualifiers use build. accordingly.

SET lock_timeout = '5s';
--> statement-breakpoint
-- project_milestones
ALTER TABLE "build"."project_milestones" DROP COLUMN IF EXISTS "deleted_at";
--> statement-breakpoint
DROP INDEX IF EXISTS "build"."idx_project_milestones_project";
--> statement-breakpoint
CREATE INDEX "idx_project_milestones_project" ON "build"."project_milestones" ("project_id");
--> statement-breakpoint
DROP INDEX IF EXISTS "build"."idx_project_milestones_org";
--> statement-breakpoint
CREATE INDEX "idx_project_milestones_org" ON "build"."project_milestones" ("org_id");
--> statement-breakpoint
-- project_releases
ALTER TABLE "build"."project_releases" DROP COLUMN IF EXISTS "deleted_at";
--> statement-breakpoint
DROP INDEX IF EXISTS "build"."idx_project_releases_project";
--> statement-breakpoint
CREATE INDEX "idx_project_releases_project" ON "build"."project_releases" ("project_id");
--> statement-breakpoint
DROP INDEX IF EXISTS "build"."idx_project_releases_org_status";
--> statement-breakpoint
CREATE INDEX "idx_project_releases_org_status" ON "build"."project_releases" ("org_id", "status");
--> statement-breakpoint
-- project_templates
ALTER TABLE "build"."project_templates" DROP COLUMN IF EXISTS "deleted_at";
--> statement-breakpoint
DROP INDEX IF EXISTS "build"."idx_project_templates_org";
--> statement-breakpoint
CREATE INDEX "idx_project_templates_org" ON "build"."project_templates" ("org_id");
--> statement-breakpoint
-- project_whiteboards
ALTER TABLE "build"."project_whiteboards" DROP COLUMN IF EXISTS "deleted_at";
--> statement-breakpoint
DROP INDEX IF EXISTS "build"."idx_project_whiteboards_org_project";
--> statement-breakpoint
CREATE INDEX "idx_project_whiteboards_org_project" ON "build"."project_whiteboards" ("org_id", "project_id");
