-- Rollback for 0371 — drop the five Build status CHECK constraints.
-- Non-destructive: constraints only, no data or column is touched.

SET statement_timeout = 0;

--> statement-breakpoint
ALTER TABLE "sprints"             DROP CONSTRAINT IF EXISTS "chk_sprints_status";
--> statement-breakpoint
ALTER TABLE "project_releases"    DROP CONSTRAINT IF EXISTS "chk_project_releases_status";
--> statement-breakpoint
ALTER TABLE "project_milestones"  DROP CONSTRAINT IF EXISTS "chk_project_milestones_status";
--> statement-breakpoint
ALTER TABLE "pm_workspaces"       DROP CONSTRAINT IF EXISTS "chk_pm_workspaces_status";
--> statement-breakpoint
ALTER TABLE "webhook_deliveries"  DROP CONSTRAINT IF EXISTS "chk_webhook_deliveries_status";
