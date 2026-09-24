-- Phase 2 / Workstream A / P0 #6 -- Sprint-Cycle consolidation, phase 01 (EXPAND).
-- Additive only. No row in an existing table changes value. Rollback: a-sprint-cycle-01-expand-rollback.sql
-- Design and rationale: docs/build-module/phase-2/06-sprint-cycle-consolidation.md (root repo).

SET lock_timeout = '5s';
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "build"."sprint_cycle_migration_map" (
  "org_id" text NOT NULL,
  "sprint_id" integer NOT NULL,
  "cycle_id" integer NOT NULL,
  "mapped_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "pk_sprint_cycle_migration_map" PRIMARY KEY ("org_id", "sprint_id"),
  CONSTRAINT "uniq_sprint_cycle_migration_map_cycle" UNIQUE ("org_id", "cycle_id")
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "build"."sprint_binding_archive" (
  "org_id" text NOT NULL,
  "source_table" text NOT NULL,
  "source_id" bigint NOT NULL,
  "sprint_id" integer NOT NULL,
  "cycle_id" integer,
  "resolution" text NOT NULL,
  CONSTRAINT "pk_sprint_binding_archive" PRIMARY KEY ("source_table", "org_id", "source_id"),
  CONSTRAINT "chk_sprint_binding_archive_resolution"
    CHECK ("resolution" IN ('mapped', 'agreed', 'cycle_wins', 'orphan_sprint'))
);
--> statement-breakpoint

ALTER TABLE "build"."sprint_cycle_migration_map" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "build"."sprint_cycle_migration_map";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "build"."sprint_cycle_migration_map"
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "build"."sprint_cycle_migration_map" TO streamline_app;
--> statement-breakpoint

ALTER TABLE "build"."sprint_binding_archive" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "build"."sprint_binding_archive";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "build"."sprint_binding_archive"
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "build"."sprint_binding_archive" TO streamline_app;
--> statement-breakpoint

ALTER TABLE "build"."cycles" ADD COLUMN IF NOT EXISTS "legacy_sprint_id" integer;
--> statement-breakpoint
ALTER TABLE "build"."cycles" ADD COLUMN IF NOT EXISTS "goal" text;
--> statement-breakpoint
ALTER TABLE "build"."cycles" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_cycles_org_legacy_sprint"
  ON "build"."cycles" ("org_id", "legacy_sprint_id")
  WHERE "legacy_sprint_id" IS NOT NULL;
--> statement-breakpoint

ALTER TABLE "build"."project_meetings" ADD COLUMN IF NOT EXISTS "cycle_id" integer;
--> statement-breakpoint
ALTER TABLE "build"."test_runs" ADD COLUMN IF NOT EXISTS "cycle_id" integer;
--> statement-breakpoint
ALTER TABLE "build_events"."sprint_scope_events" ADD COLUMN IF NOT EXISTS "cycle_id" integer;
--> statement-breakpoint

ALTER TABLE "build"."project_meetings" DROP CONSTRAINT IF EXISTS "fk_project_meetings_org_cycle";
--> statement-breakpoint
ALTER TABLE "build"."project_meetings" ADD CONSTRAINT "fk_project_meetings_org_cycle"
  FOREIGN KEY ("org_id", "cycle_id") REFERENCES "build"."cycles" ("org_id", "id")
  ON DELETE SET NULL ("cycle_id") NOT VALID;
--> statement-breakpoint

ALTER TABLE "build"."test_runs" DROP CONSTRAINT IF EXISTS "fk_test_runs_org_cycle";
--> statement-breakpoint
ALTER TABLE "build"."test_runs" ADD CONSTRAINT "fk_test_runs_org_cycle"
  FOREIGN KEY ("org_id", "cycle_id") REFERENCES "build"."cycles" ("org_id", "id")
  ON DELETE SET NULL ("cycle_id") NOT VALID;
--> statement-breakpoint

ALTER TABLE "build_events"."sprint_scope_events" DROP CONSTRAINT IF EXISTS "fk_sprint_scope_events_org_cycle";
--> statement-breakpoint
ALTER TABLE "build_events"."sprint_scope_events" ADD CONSTRAINT "fk_sprint_scope_events_org_cycle"
  FOREIGN KEY ("org_id", "cycle_id") REFERENCES "build"."cycles" ("org_id", "id")
  ON DELETE CASCADE NOT VALID;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_project_meetings_cycle" ON "build"."project_meetings" ("cycle_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_test_runs_cycle" ON "build"."test_runs" ("cycle_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sprint_scope_events_org_cycle_created"
  ON "build_events"."sprint_scope_events" ("org_id", "cycle_id", "created_at");
