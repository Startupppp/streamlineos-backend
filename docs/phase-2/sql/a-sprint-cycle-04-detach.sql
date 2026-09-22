-- Phase 2 / Workstream A / P0 #6 -- Sprint-Cycle consolidation, phase 04 (DETACH).
-- Removes the sprint_id pointers from the four referencing tables. Every value being dropped was
-- written to build.sprint_binding_archive in phase 02, so a-sprint-cycle-04-detach-rollback.sql
-- restores them exactly. Apply only after the parity report in the design doc passes.
-- Both constraint-name families are dropped: the Drizzle declaration names fk_*_org_sprint and the
-- names the applied migrations actually created, fk_*_sprint_id_org and *_sprint_id_sprints_id_fk.

SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
DECLARE
  unarchived bigint;
BEGIN
  SELECT count(*) INTO unarchived
    FROM "build"."tickets" t
   WHERE t."sprint_id" IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM "build"."sprint_binding_archive" a
        WHERE a."source_table" = 'build.tickets'
          AND a."org_id" = t."org_id" AND a."source_id" = t."id"
     );
  IF unarchived > 0 THEN
    RAISE EXCEPTION 'refusing to detach: % ticket sprint binding(s) are not in the archive', unarchived;
  END IF;
END $$;
--> statement-breakpoint

DROP INDEX IF EXISTS "build_events"."idx_sprint_scope_events_org_sprint_created";
--> statement-breakpoint
DROP INDEX IF EXISTS "build"."idx_test_runs_sprint";
--> statement-breakpoint
DROP INDEX IF EXISTS "build"."idx_tickets_sprint";
--> statement-breakpoint

ALTER TABLE "build"."tickets" DROP CONSTRAINT IF EXISTS "fk_tickets_org_sprint";
--> statement-breakpoint
ALTER TABLE "build"."tickets" DROP CONSTRAINT IF EXISTS "fk_tickets_sprint_id_org";
--> statement-breakpoint
ALTER TABLE "build"."tickets" DROP CONSTRAINT IF EXISTS "tickets_sprint_id_sprints_id_fk";
--> statement-breakpoint
ALTER TABLE "build"."project_meetings" DROP CONSTRAINT IF EXISTS "fk_project_meetings_org_sprint";
--> statement-breakpoint
ALTER TABLE "build"."project_meetings" DROP CONSTRAINT IF EXISTS "fk_project_meetings_sprint_id_org";
--> statement-breakpoint
ALTER TABLE "build"."project_meetings" DROP CONSTRAINT IF EXISTS "project_meetings_sprint_id_sprints_id_fk";
--> statement-breakpoint
ALTER TABLE "build"."test_runs" DROP CONSTRAINT IF EXISTS "fk_test_runs_org_sprint";
--> statement-breakpoint
ALTER TABLE "build"."test_runs" DROP CONSTRAINT IF EXISTS "fk_test_runs_sprint_id_org";
--> statement-breakpoint
ALTER TABLE "build"."test_runs" DROP CONSTRAINT IF EXISTS "test_runs_sprint_id_sprints_id_fk";
--> statement-breakpoint
ALTER TABLE "build_events"."sprint_scope_events" DROP CONSTRAINT IF EXISTS "fk_sprint_scope_events_org_sprint";
--> statement-breakpoint
ALTER TABLE "build_events"."sprint_scope_events" DROP CONSTRAINT IF EXISTS "sprint_scope_events_sprint_id_sprints_id_fk";
--> statement-breakpoint

ALTER TABLE "build"."tickets" DROP COLUMN IF EXISTS "sprint_id";
--> statement-breakpoint
ALTER TABLE "build"."project_meetings" DROP COLUMN IF EXISTS "sprint_id";
--> statement-breakpoint
ALTER TABLE "build"."test_runs" DROP COLUMN IF EXISTS "sprint_id";
--> statement-breakpoint
ALTER TABLE "build_events"."sprint_scope_events" DROP COLUMN IF EXISTS "sprint_id";
--> statement-breakpoint

ANALYZE "build"."tickets";
