SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('build.project_attachments') IS NULL THEN
    RAISE EXCEPTION '1391-rollback precondition: build.project_attachments does not exist — cannot roll back';
  END IF;
END $$;
--> statement-breakpoint

DROP POLICY IF EXISTS tenant_isolation ON "build"."project_attachments";
--> statement-breakpoint
ALTER TABLE "build"."project_attachments" DISABLE ROW LEVEL SECURITY;
