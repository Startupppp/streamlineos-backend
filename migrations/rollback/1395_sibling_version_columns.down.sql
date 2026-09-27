SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_cycles_version_bump'
      AND tgrelid = 'build.cycles'::regclass
  ) THEN
    RAISE EXCEPTION '1395-rollback precondition: trg_cycles_version_bump does not exist — cannot roll back';
  END IF;
END $$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_cycles_version_bump              ON "build"."cycles";
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_project_milestones_version_bump  ON "build"."project_milestones";
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_modules_version_bump             ON "build"."modules";
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_roadmap_items_version_bump       ON "build"."roadmap_items";
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_project_releases_row_version_bump ON "build"."project_releases";
--> statement-breakpoint

DROP FUNCTION IF EXISTS build.bump_sibling_version();
--> statement-breakpoint
DROP FUNCTION IF EXISTS build.bump_release_row_version();
--> statement-breakpoint

ALTER TABLE "build"."cycles"             DROP COLUMN IF EXISTS "version";
--> statement-breakpoint
ALTER TABLE "build"."project_milestones" DROP COLUMN IF EXISTS "version";
--> statement-breakpoint
ALTER TABLE "build"."modules"            DROP COLUMN IF EXISTS "version";
--> statement-breakpoint
ALTER TABLE "build"."roadmap_items"      DROP COLUMN IF EXISTS "version";
--> statement-breakpoint
ALTER TABLE "build"."project_releases"   DROP COLUMN IF EXISTS "row_version";
