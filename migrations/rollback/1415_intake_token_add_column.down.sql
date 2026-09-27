SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'projects' AND column_name = 'intake_token'
  ) THEN
    RAISE EXCEPTION '1415-rollback precondition: intake_token column does not exist — cannot roll back';
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "build"."projects" DROP COLUMN IF EXISTS "intake_token";
--> statement-breakpoint

DO $$
BEGIN
  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'projects' AND column_name = 'intake_token'
  ), '1415-rollback post-check: intake_token column still exists on build.projects';
END $$;
