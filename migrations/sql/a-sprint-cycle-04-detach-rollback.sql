-- Rollback of a-sprint-cycle-04-detach.sql. Re-adds the four sprint_id columns and restores every
-- value from build.sprint_binding_archive, then reinstates the foreign keys under the declaration
-- names and the indexes. Requires build.sprints to still exist, so run this before
-- a-sprint-cycle-05-drop-rollback.sql has been needed, or after it has completed.
-- The backfill UPDATE precedes every VALIDATE so the file cannot abort on a partially restored table.

SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE "build"."tickets" ADD COLUMN IF NOT EXISTS "sprint_id" integer;
--> statement-breakpoint
ALTER TABLE "build"."project_meetings" ADD COLUMN IF NOT EXISTS "sprint_id" integer;
--> statement-breakpoint
ALTER TABLE "build"."test_runs" ADD COLUMN IF NOT EXISTS "sprint_id" integer;
--> statement-breakpoint
ALTER TABLE "build_events"."sprint_scope_events" ADD COLUMN IF NOT EXISTS "sprint_id" integer;
--> statement-breakpoint

UPDATE "build"."tickets" t
   SET "sprint_id" = a."sprint_id"
  FROM "build"."sprint_binding_archive" a
 WHERE a."source_table" = 'build.tickets'
   AND a."org_id" = t."org_id" AND a."source_id" = t."id"
   AND t."sprint_id" IS DISTINCT FROM a."sprint_id";
--> statement-breakpoint
UPDATE "build"."project_meetings" pm
   SET "sprint_id" = a."sprint_id"
  FROM "build"."sprint_binding_archive" a
 WHERE a."source_table" = 'build.project_meetings'
   AND a."org_id" = pm."org_id" AND a."source_id" = pm."id"
   AND pm."sprint_id" IS DISTINCT FROM a."sprint_id";
--> statement-breakpoint
UPDATE "build"."test_runs" tr
   SET "sprint_id" = a."sprint_id"
  FROM "build"."sprint_binding_archive" a
 WHERE a."source_table" = 'build.test_runs'
   AND a."org_id" = tr."org_id" AND a."source_id" = tr."id"
   AND tr."sprint_id" IS DISTINCT FROM a."sprint_id";
--> statement-breakpoint
UPDATE "build_events"."sprint_scope_events" e
   SET "sprint_id" = a."sprint_id"
  FROM "build"."sprint_binding_archive" a
 WHERE a."source_table" = 'build_events.sprint_scope_events'
   AND a."org_id" = e."org_id" AND a."source_id" = e."id"
   AND e."sprint_id" IS DISTINCT FROM a."sprint_id";
--> statement-breakpoint

ALTER TABLE "build"."tickets" DROP CONSTRAINT IF EXISTS "fk_tickets_org_sprint";
--> statement-breakpoint
ALTER TABLE "build"."tickets" ADD CONSTRAINT "fk_tickets_org_sprint"
  FOREIGN KEY ("org_id", "sprint_id") REFERENCES "build"."sprints" ("org_id", "id")
  ON DELETE SET NULL ("sprint_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."tickets" VALIDATE CONSTRAINT "fk_tickets_org_sprint";
--> statement-breakpoint

ALTER TABLE "build"."project_meetings" DROP CONSTRAINT IF EXISTS "fk_project_meetings_org_sprint";
--> statement-breakpoint
ALTER TABLE "build"."project_meetings" ADD CONSTRAINT "fk_project_meetings_org_sprint"
  FOREIGN KEY ("org_id", "sprint_id") REFERENCES "build"."sprints" ("org_id", "id")
  ON DELETE SET NULL ("sprint_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."project_meetings" VALIDATE CONSTRAINT "fk_project_meetings_org_sprint";
--> statement-breakpoint

ALTER TABLE "build"."test_runs" DROP CONSTRAINT IF EXISTS "fk_test_runs_org_sprint";
--> statement-breakpoint
ALTER TABLE "build"."test_runs" ADD CONSTRAINT "fk_test_runs_org_sprint"
  FOREIGN KEY ("org_id", "sprint_id") REFERENCES "build"."sprints" ("org_id", "id")
  ON DELETE SET NULL ("sprint_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."test_runs" VALIDATE CONSTRAINT "fk_test_runs_org_sprint";
--> statement-breakpoint

ALTER TABLE "build_events"."sprint_scope_events" DROP CONSTRAINT IF EXISTS "fk_sprint_scope_events_org_sprint";
--> statement-breakpoint
ALTER TABLE "build_events"."sprint_scope_events" ADD CONSTRAINT "fk_sprint_scope_events_org_sprint"
  FOREIGN KEY ("org_id", "sprint_id") REFERENCES "build"."sprints" ("org_id", "id")
  ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "build_events"."sprint_scope_events" VALIDATE CONSTRAINT "fk_sprint_scope_events_org_sprint";
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_tickets_sprint" ON "build"."tickets" ("sprint_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_test_runs_sprint" ON "build"."test_runs" ("sprint_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sprint_scope_events_org_sprint_created"
  ON "build_events"."sprint_scope_events" ("org_id", "sprint_id", "created_at");
