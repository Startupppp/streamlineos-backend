-- Phase 2 / Workstream A / P0 #6 -- Sprint-Cycle consolidation, phase 05 (DROP).
-- Satisfies docs/build-module/02-schemas.md line 39, "no Sprint table after migration", and step 8 of
-- its migration order, "remove duplicate tables/columns only after parity reports and rollback windows
-- close". A physical copy of build.sprints is taken first so a-sprint-cycle-05-drop-rollback.sql can
-- recreate it. The copy is intentionally retained: it is the only remaining record of sprint row values
-- once this phase commits.
-- The two cosmetic renames this file used to carry moved to a-sprint-cycle-06-rename-scope-events.sql:
-- a RENAME has no overlap window, so it breaks every deployed reader at the instant it commits, while
-- dropping build.sprints is safe the moment no source file queries it.

SET lock_timeout = '5s';
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "build"."sprints_archive" (LIKE "build"."sprints" INCLUDING DEFAULTS);
--> statement-breakpoint

INSERT INTO "build"."sprints_archive"
SELECT * FROM "build"."sprints"
 WHERE NOT EXISTS (
   SELECT 1 FROM "build"."sprints_archive" a
    WHERE a."org_id" = "build"."sprints"."org_id" AND a."id" = "build"."sprints"."id"
 );
--> statement-breakpoint

ALTER TABLE "build"."sprints_archive" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "build"."sprints_archive";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "build"."sprints_archive"
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
GRANT SELECT ON "build"."sprints_archive" TO streamline_app;
--> statement-breakpoint

DO $$
DECLARE
  live_rows bigint;
  archived_rows bigint;
BEGIN
  SELECT count(*) INTO live_rows FROM "build"."sprints";
  SELECT count(*) INTO archived_rows FROM "build"."sprints_archive";
  IF archived_rows < live_rows THEN
    RAISE EXCEPTION 'refusing to drop build.sprints: archive holds % of % rows', archived_rows, live_rows;
  END IF;
END $$;
--> statement-breakpoint

DROP TABLE "build"."sprints";
--> statement-breakpoint

