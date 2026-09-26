SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('build.project_updates') IS NULL THEN
    RAISE EXCEPTION '1305 rollback precondition: build.project_updates is absent';
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "build"."project_updates"
  DROP COLUMN IF EXISTS "wins";
--> statement-breakpoint

ALTER TABLE "build"."project_updates"
  DROP COLUMN IF EXISTS "risks";
--> statement-breakpoint

ALTER TABLE "build"."project_updates"
  DROP COLUMN IF EXISTS "next";
--> statement-breakpoint

ALTER TABLE "build"."project_updates"
  DROP COLUMN IF EXISTS "citations";
