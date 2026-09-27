SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('build.project_retention_settings') IS NULL THEN
    RAISE EXCEPTION '1295-rollback precondition: build.project_retention_settings does not exist — cannot roll back';
  END IF;
END $$;
--> statement-breakpoint

DROP TABLE IF EXISTS "build"."project_retention_settings";
