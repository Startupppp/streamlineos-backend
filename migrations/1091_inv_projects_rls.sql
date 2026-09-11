-- inv_projects and inv_project_requirements are tenant tables with a NOT NULL
-- org_id, and they were the only two of the 101 inv_* tables with row-level
-- security switched off. Grants arrive through ALTER DEFAULT PRIVILEGES, so the
-- gap is silent: the application role could read and write every organisation's
-- projects and every requirement line on them, and nothing said so.
--
-- Found by inventory-schema-parity.db.spec.ts, which asserts exactly this and
-- had never been run: it was gated on INV_DB_TESTS, a variable set nowhere.
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "inv_projects" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "inv_projects";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "inv_projects"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "inv_projects" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "inv_projects" TO streamline_app;
--> statement-breakpoint
ALTER TABLE "inv_project_requirements" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "inv_project_requirements";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "inv_project_requirements"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "inv_project_requirements" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "inv_project_requirements" TO streamline_app;
--> statement-breakpoint

DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO missing
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname IN ('inv_projects', 'inv_project_requirements')
    AND (NOT c.relrowsecurity
         OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid));
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '0911: % still lacks RLS or a policy', missing;
  END IF;
END $$;
