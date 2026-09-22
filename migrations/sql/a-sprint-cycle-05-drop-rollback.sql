-- Rollback of a-sprint-cycle-05-drop.sql. Recreates build.sprints from build.sprints_archive with the
-- identity column, unique key, check constraint, indexes, policy and grants the declaration in
-- backend/src/db/schema/build/core.ts lines 98-130 specifies, then restarts the identity sequence above
-- the highest restored id so new inserts cannot collide with a restored row.
-- Reverses the two renames as well. Run a-sprint-cycle-04-detach-rollback.sql after this file, not before,
-- because the sprint foreign keys it reinstates reference this table.

SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TYPE "cycle_scope_event_type" RENAME TO "sprint_scope_event_type";
--> statement-breakpoint
ALTER TABLE "build_events"."cycle_scope_events" RENAME TO "sprint_scope_events";
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "build"."sprints" (
  "id" integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "org_id" text NOT NULL,
  "project_id" integer NOT NULL,
  "name" text NOT NULL,
  "start_date" timestamp NOT NULL,
  "end_date" timestamp NOT NULL,
  "goal" text,
  "status" text NOT NULL DEFAULT 'PLANNED',
  "deleted_at" timestamp with time zone,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "uniq_sprints_org_id" UNIQUE ("org_id", "id"),
  CONSTRAINT "chk_sprints_status" CHECK ("status" IN ('PLANNED', 'ACTIVE', 'COMPLETED'))
);
--> statement-breakpoint

INSERT INTO "build"."sprints" (
  "id", "org_id", "project_id", "name", "start_date", "end_date",
  "goal", "status", "deleted_at", "created_at", "updated_at"
) OVERRIDING SYSTEM VALUE
SELECT
  a."id", a."org_id", a."project_id", a."name", a."start_date", a."end_date",
  a."goal", a."status", a."deleted_at", a."created_at", a."updated_at"
FROM "build"."sprints_archive" a
WHERE NOT EXISTS (SELECT 1 FROM "build"."sprints" s WHERE s."id" = a."id");
--> statement-breakpoint

SELECT setval(
  pg_get_serial_sequence('build.sprints', 'id'),
  GREATEST((SELECT coalesce(max("id"), 0) FROM "build"."sprints"), 1),
  true
);
--> statement-breakpoint

ALTER TABLE "build"."sprints" DROP CONSTRAINT IF EXISTS "sprints_org_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "build"."sprints" ADD CONSTRAINT "sprints_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "organizations" ("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."sprints" VALIDATE CONSTRAINT "sprints_org_id_organizations_id_fk";
--> statement-breakpoint

ALTER TABLE "build"."sprints" DROP CONSTRAINT IF EXISTS "fk_sprints_org_project";
--> statement-breakpoint
ALTER TABLE "build"."sprints" ADD CONSTRAINT "fk_sprints_org_project"
  FOREIGN KEY ("org_id", "project_id") REFERENCES "build"."projects" ("org_id", "id")
  ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."sprints" VALIDATE CONSTRAINT "fk_sprints_org_project";
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_sprints_project_status"
  ON "build"."sprints" ("project_id", "status") WHERE "deleted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sprints_org_project_velocity_cursor"
  ON "build"."sprints" ("org_id", "project_id", "start_date" DESC, "id" DESC)
  WHERE "deleted_at" IS NULL AND "status" IN ('ACTIVE', 'COMPLETED');
--> statement-breakpoint

ALTER TABLE "build"."sprints" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "build"."sprints";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "build"."sprints"
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "build"."sprints" TO streamline_app;
--> statement-breakpoint

ANALYZE "build"."sprints";
