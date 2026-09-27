SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'projects' AND column_name = 'intake_token'
  ) THEN
    RAISE EXCEPTION '1416-rollback precondition: intake_token column does not exist — cannot roll back';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'projects'
      AND column_name = 'intake_token' AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION '1416-rollback precondition: intake_token is still NOT NULL — roll back 1417 first';
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "build"."projects" ALTER COLUMN "intake_token" DROP DEFAULT;
--> statement-breakpoint

UPDATE "build"."projects" SET intake_token = NULL WHERE intake_token IS NOT NULL;
--> statement-breakpoint

DO $$
BEGIN
  ASSERT NOT EXISTS (
    SELECT 1 FROM "build"."projects" WHERE intake_token IS NOT NULL LIMIT 1
  ), '1416-rollback post-check: build.projects still has non-null intake_token values';

  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'projects'
      AND column_name = 'intake_token' AND column_default IS NOT NULL
  ), '1416-rollback post-check: the intake_token column default was not dropped';
END $$;
