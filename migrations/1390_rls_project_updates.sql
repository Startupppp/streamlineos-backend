SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('build.project_updates') IS NULL THEN
    RAISE EXCEPTION '1390 precondition: build.project_updates does not exist';
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "build"."project_updates" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "build"."project_updates";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "build"."project_updates"
  FOR ALL
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "build"."project_updates" TO streamline_app;
--> statement-breakpoint

DO $$
BEGIN
  ASSERT (
    SELECT relrowsecurity FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'build' AND c.relname = 'project_updates'
  ), '1390 post-check: RLS was not enabled on build.project_updates';
  ASSERT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'build'
      AND tablename = 'project_updates'
      AND policyname = 'tenant_isolation'
  ), '1390 post-check: tenant_isolation policy not found on build.project_updates';
END $$;
