-- Rollback of a-sprint-cycle-02-backfill.sql. Restores every rebound pointer from
-- build.sprint_binding_archive and deletes only the cycle rows this phase created
-- (identified by legacy_sprint_id, never by id range or timestamp).
-- Cycle rows that predate the migration carry legacy_sprint_id IS NULL and are untouched.

SET lock_timeout = '5s';
--> statement-breakpoint

UPDATE "build"."tickets" t
   SET "cycle_id" = a."cycle_id"
  FROM "build"."sprint_binding_archive" a
 WHERE a."source_table" = 'build.tickets'
   AND a."org_id" = t."org_id"
   AND a."source_id" = t."id"
   AND t."cycle_id" IS DISTINCT FROM a."cycle_id";
--> statement-breakpoint

UPDATE "build"."project_meetings" pm
   SET "cycle_id" = a."cycle_id"
  FROM "build"."sprint_binding_archive" a
 WHERE a."source_table" = 'build.project_meetings'
   AND a."org_id" = pm."org_id"
   AND a."source_id" = pm."id"
   AND pm."cycle_id" IS DISTINCT FROM a."cycle_id";
--> statement-breakpoint

UPDATE "build"."test_runs" tr
   SET "cycle_id" = a."cycle_id"
  FROM "build"."sprint_binding_archive" a
 WHERE a."source_table" = 'build.test_runs'
   AND a."org_id" = tr."org_id"
   AND a."source_id" = tr."id"
   AND tr."cycle_id" IS DISTINCT FROM a."cycle_id";
--> statement-breakpoint

UPDATE "build_events"."sprint_scope_events" e
   SET "cycle_id" = a."cycle_id"
  FROM "build"."sprint_binding_archive" a
 WHERE a."source_table" = 'build_events.sprint_scope_events'
   AND a."org_id" = e."org_id"
   AND a."source_id" = e."id"
   AND e."cycle_id" IS DISTINCT FROM a."cycle_id";
--> statement-breakpoint

DELETE FROM "build"."cycles" c WHERE c."legacy_sprint_id" IS NOT NULL;
--> statement-breakpoint

DELETE FROM "build"."sprint_cycle_migration_map";
--> statement-breakpoint

DELETE FROM "build"."sprint_binding_archive";
