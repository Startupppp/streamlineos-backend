-- Rollback of a-sprint-cycle-01-expand.sql. Fully reversible: phase 01 added objects and changed no existing row.
-- Safe to run only while phase 02 has not been applied; run a-sprint-cycle-02-backfill-rollback.sql first otherwise.

SET lock_timeout = '5s';
--> statement-breakpoint

DROP INDEX IF EXISTS "build_events"."idx_sprint_scope_events_org_cycle_created";
--> statement-breakpoint
DROP INDEX IF EXISTS "build"."idx_test_runs_cycle";
--> statement-breakpoint
DROP INDEX IF EXISTS "build"."idx_project_meetings_cycle";
--> statement-breakpoint

ALTER TABLE "build_events"."sprint_scope_events" DROP CONSTRAINT IF EXISTS "fk_sprint_scope_events_org_cycle";
--> statement-breakpoint
ALTER TABLE "build"."test_runs" DROP CONSTRAINT IF EXISTS "fk_test_runs_org_cycle";
--> statement-breakpoint
ALTER TABLE "build"."project_meetings" DROP CONSTRAINT IF EXISTS "fk_project_meetings_org_cycle";
--> statement-breakpoint

ALTER TABLE "build_events"."sprint_scope_events" DROP COLUMN IF EXISTS "cycle_id";
--> statement-breakpoint
ALTER TABLE "build"."test_runs" DROP COLUMN IF EXISTS "cycle_id";
--> statement-breakpoint
ALTER TABLE "build"."project_meetings" DROP COLUMN IF EXISTS "cycle_id";
--> statement-breakpoint

DROP INDEX IF EXISTS "build"."uniq_cycles_org_legacy_sprint";
--> statement-breakpoint
ALTER TABLE "build"."cycles" DROP COLUMN IF EXISTS "deleted_at";
--> statement-breakpoint
ALTER TABLE "build"."cycles" DROP COLUMN IF EXISTS "goal";
--> statement-breakpoint
ALTER TABLE "build"."cycles" DROP COLUMN IF EXISTS "legacy_sprint_id";
--> statement-breakpoint

DROP TABLE IF EXISTS "build"."sprint_binding_archive";
--> statement-breakpoint
DROP TABLE IF EXISTS "build"."sprint_cycle_migration_map";
