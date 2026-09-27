-- Rollback for 1390_rls_project_updates.sql
-- Disables RLS on build.project_updates and removes the tenant_isolation policy.

SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('build.project_updates') IS NULL THEN
    RAISE EXCEPTION '1390-rollback precondition: build.project_updates does not exist — cannot roll back';
  END IF;
END $$;
--> statement-breakpoint

DROP POLICY IF EXISTS tenant_isolation ON "build"."project_updates";
--> statement-breakpoint
ALTER TABLE "build"."project_updates" DISABLE ROW LEVEL SECURITY;
