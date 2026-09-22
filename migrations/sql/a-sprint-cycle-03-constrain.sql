-- Phase 2 / Workstream A / P0 #6 -- Sprint-Cycle consolidation, phase 03 (CONSTRAIN).
-- Validates the phase 01 foreign keys, promotes build_events.sprint_scope_events.cycle_id to NOT NULL
-- through the CHECK NOT VALID two-step, and adds the cycle-side replacements for the sprint indexes.
-- The leading UPDATE is a defensive re-run of the phase 02 backfill: it must precede every VALIDATE
-- so this file cannot abort on a database where phase 02 was interrupted.
-- Rollback: a-sprint-cycle-03-constrain-rollback.sql

SET lock_timeout = '5s';
--> statement-breakpoint

UPDATE "build_events"."sprint_scope_events" e
   SET "cycle_id" = m."cycle_id"
  FROM "build"."sprint_cycle_migration_map" m
 WHERE m."org_id" = e."org_id"
   AND m."sprint_id" = e."sprint_id"
   AND e."cycle_id" IS NULL;
--> statement-breakpoint

ALTER TABLE "build"."project_meetings" VALIDATE CONSTRAINT "fk_project_meetings_org_cycle";
--> statement-breakpoint
ALTER TABLE "build"."test_runs" VALIDATE CONSTRAINT "fk_test_runs_org_cycle";
--> statement-breakpoint
ALTER TABLE "build_events"."sprint_scope_events" VALIDATE CONSTRAINT "fk_sprint_scope_events_org_cycle";
--> statement-breakpoint

ALTER TABLE "build_events"."sprint_scope_events"
  DROP CONSTRAINT IF EXISTS "chk_sprint_scope_events_cycle_id_present";
--> statement-breakpoint
ALTER TABLE "build_events"."sprint_scope_events"
  ADD CONSTRAINT "chk_sprint_scope_events_cycle_id_present"
  CHECK ("cycle_id" IS NOT NULL) NOT VALID;
--> statement-breakpoint
ALTER TABLE "build_events"."sprint_scope_events"
  VALIDATE CONSTRAINT "chk_sprint_scope_events_cycle_id_present";
--> statement-breakpoint
ALTER TABLE "build_events"."sprint_scope_events" ALTER COLUMN "cycle_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "build_events"."sprint_scope_events"
  DROP CONSTRAINT IF EXISTS "chk_sprint_scope_events_cycle_id_present";
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_cycles_project_status_live"
  ON "build"."cycles" ("project_id", "status")
  WHERE "deleted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cycles_org_project_velocity_cursor"
  ON "build"."cycles" ("org_id", "project_id", "start_date" DESC, "id" DESC)
  WHERE "deleted_at" IS NULL AND "status" IN ('active', 'completed');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tickets_org_cycle_live"
  ON "build"."tickets" ("org_id", "cycle_id")
  WHERE "deleted_at" IS NULL AND "cycle_id" IS NOT NULL;
--> statement-breakpoint

ANALYZE "build"."cycles";
--> statement-breakpoint
ANALYZE "build"."tickets";
