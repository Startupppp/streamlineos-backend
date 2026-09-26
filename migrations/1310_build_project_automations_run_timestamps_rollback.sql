SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('build.project_automations') IS NULL THEN
    RAISE EXCEPTION '1310-rollback precondition: build.project_automations does not exist — cannot roll back';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build'
      AND table_name = 'project_automations'
      AND column_name = 'last_run_at'
  ) THEN
    RAISE EXCEPTION '1310-rollback precondition: last_run_at does not exist on build.project_automations — migration was never applied';
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "build"."project_automations"
  DROP COLUMN IF EXISTS "last_run_at";
--> statement-breakpoint

ALTER TABLE "build"."project_automations"
  DROP COLUMN IF EXISTS "last_failure_at";
