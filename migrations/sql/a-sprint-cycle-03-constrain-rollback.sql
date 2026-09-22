-- Rollback of a-sprint-cycle-03-constrain.sql. Drops the NOT NULL and the indexes this phase added
-- and returns the three foreign keys to NOT VALID, which is the state phase 01 leaves them in.
-- A validated constraint cannot be un-validated in place, so each one is dropped and re-added NOT VALID.

SET lock_timeout = '5s';
--> statement-breakpoint

DROP INDEX IF EXISTS "build"."idx_tickets_org_cycle_live";
--> statement-breakpoint
DROP INDEX IF EXISTS "build"."idx_cycles_org_project_velocity_cursor";
--> statement-breakpoint
DROP INDEX IF EXISTS "build"."idx_cycles_project_status_live";
--> statement-breakpoint

ALTER TABLE "build_events"."sprint_scope_events" ALTER COLUMN "cycle_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "build_events"."sprint_scope_events"
  DROP CONSTRAINT IF EXISTS "chk_sprint_scope_events_cycle_id_present";
--> statement-breakpoint

ALTER TABLE "build_events"."sprint_scope_events" DROP CONSTRAINT IF EXISTS "fk_sprint_scope_events_org_cycle";
--> statement-breakpoint
ALTER TABLE "build_events"."sprint_scope_events" ADD CONSTRAINT "fk_sprint_scope_events_org_cycle"
  FOREIGN KEY ("org_id", "cycle_id") REFERENCES "build"."cycles" ("org_id", "id")
  ON DELETE CASCADE NOT VALID;
--> statement-breakpoint

ALTER TABLE "build"."test_runs" DROP CONSTRAINT IF EXISTS "fk_test_runs_org_cycle";
--> statement-breakpoint
ALTER TABLE "build"."test_runs" ADD CONSTRAINT "fk_test_runs_org_cycle"
  FOREIGN KEY ("org_id", "cycle_id") REFERENCES "build"."cycles" ("org_id", "id")
  ON DELETE SET NULL ("cycle_id") NOT VALID;
--> statement-breakpoint

ALTER TABLE "build"."project_meetings" DROP CONSTRAINT IF EXISTS "fk_project_meetings_org_cycle";
--> statement-breakpoint
ALTER TABLE "build"."project_meetings" ADD CONSTRAINT "fk_project_meetings_org_cycle"
  FOREIGN KEY ("org_id", "cycle_id") REFERENCES "build"."cycles" ("org_id", "id")
  ON DELETE SET NULL ("cycle_id") NOT VALID;
