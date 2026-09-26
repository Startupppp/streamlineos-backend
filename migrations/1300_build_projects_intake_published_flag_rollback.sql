SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build'
      AND table_name = 'projects'
      AND column_name = 'intake_published_at'
  ) THEN
    RAISE EXCEPTION '1300-rollback precondition: intake_published_at does not exist on build.projects — cannot roll back';
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "build"."projects"
  DROP COLUMN IF EXISTS "intake_published_at";
