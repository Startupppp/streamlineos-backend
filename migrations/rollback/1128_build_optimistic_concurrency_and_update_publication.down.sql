-- Rollback for migration 1128.
--
-- Drops four indexes, two CHECK constraints, one FK constraint, all feature
-- columns (audience, status, published_at on project_updates; review_date and
-- category on project_risks; superseded_by_id on project_decisions), all nine
-- version columns, and the two publication enums.
--
-- Dropping the version columns destroys the optimistic-concurrency tokens.
-- Any in-flight client holding a version value will be unable to detect a
-- write conflict after the rollback — last-write-wins silently resumes.
--
-- Dependency order: indexes first (reference columns), then constraints that
-- guard columns, then the columns themselves, then the enum types whose
-- columns are now gone.

SET lock_timeout = '5s';
--> statement-breakpoint
DROP INDEX IF EXISTS "build"."idx_test_run_results_org_run_id";
--> statement-breakpoint
DROP INDEX IF EXISTS "build"."idx_project_decisions_org_superseded_by";
--> statement-breakpoint
DROP INDEX IF EXISTS "build"."idx_project_risks_org_project_review_date";
--> statement-breakpoint
DROP INDEX IF EXISTS "build"."idx_project_updates_org_project_audience_cursor";
--> statement-breakpoint
ALTER TABLE "build"."project_decisions" DROP CONSTRAINT IF EXISTS "chk_project_decisions_not_self_superseded";
--> statement-breakpoint
ALTER TABLE "build"."project_decisions" DROP CONSTRAINT IF EXISTS "fk_project_decisions_org_superseded_by";
--> statement-breakpoint
ALTER TABLE "build"."project_updates" DROP CONSTRAINT IF EXISTS "chk_project_updates_published_at";
--> statement-breakpoint
ALTER TABLE "build"."project_decisions" DROP COLUMN IF EXISTS "superseded_by_id";
--> statement-breakpoint
ALTER TABLE "build"."project_risks" DROP COLUMN IF EXISTS "category";
--> statement-breakpoint
ALTER TABLE "build"."project_risks" DROP COLUMN IF EXISTS "review_date";
--> statement-breakpoint
ALTER TABLE "build"."project_updates" DROP COLUMN IF EXISTS "published_at";
--> statement-breakpoint
ALTER TABLE "build"."project_updates" DROP COLUMN IF EXISTS "status";
--> statement-breakpoint
ALTER TABLE "build"."project_updates" DROP COLUMN IF EXISTS "audience";
--> statement-breakpoint
ALTER TABLE "build"."project_decisions" DROP COLUMN IF EXISTS "version";
--> statement-breakpoint
ALTER TABLE "build"."project_risks" DROP COLUMN IF EXISTS "version";
--> statement-breakpoint
ALTER TABLE "build"."project_incidents" DROP COLUMN IF EXISTS "version";
--> statement-breakpoint
ALTER TABLE "build"."test_run_results" DROP COLUMN IF EXISTS "version";
--> statement-breakpoint
ALTER TABLE "build"."test_runs" DROP COLUMN IF EXISTS "version";
--> statement-breakpoint
ALTER TABLE "build"."test_cases" DROP COLUMN IF EXISTS "version";
--> statement-breakpoint
ALTER TABLE "build"."test_suites" DROP COLUMN IF EXISTS "version";
--> statement-breakpoint
ALTER TABLE "build"."project_updates" DROP COLUMN IF EXISTS "version";
--> statement-breakpoint
ALTER TABLE "build"."pm_workspaces" DROP COLUMN IF EXISTS "version";
--> statement-breakpoint
DROP TYPE IF EXISTS "public"."project_update_audience";
--> statement-breakpoint
DROP TYPE IF EXISTS "public"."project_update_status";
