SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'build' AND tablename = 'projects' AND indexname = 'uniq_projects_org_intake_token'
  ) THEN
    RAISE EXCEPTION '1417-rollback precondition: uniq_projects_org_intake_token index does not exist — cannot roll back';
  END IF;
END $$;
--> statement-breakpoint

DROP INDEX IF EXISTS "build"."uniq_projects_org_intake_token";
--> statement-breakpoint

DROP INDEX IF EXISTS "build"."uniq_projects_intake_token";
--> statement-breakpoint

DROP FUNCTION IF EXISTS app.resolve_project_org_id_by_intake_token(text);
--> statement-breakpoint

ALTER TABLE "build"."projects" ALTER COLUMN "intake_token" DROP NOT NULL;
--> statement-breakpoint

ALTER TABLE "build"."projects"
  DROP CONSTRAINT IF EXISTS "chk_projects_intake_token_not_null";
--> statement-breakpoint

DO $$
BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'projects'
      AND column_name = 'intake_token' AND is_nullable = 'YES'
  ), '1417-rollback post-check: intake_token is still NOT NULL on build.projects';

  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'app' AND p.proname = 'resolve_project_org_id_by_intake_token'
  ), '1417-rollback post-check: the intake token resolver function still exists';
END $$;
