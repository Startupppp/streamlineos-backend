-- Reverses 0911. Row-level security off and the policy removed; the grants to
-- streamline_app stay, because they predate 0911 by way of ALTER DEFAULT
-- PRIVILEGES and revoking them here would take the tables away from the
-- application entirely rather than restoring the prior state.
SET lock_timeout = '5s';
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "inv_project_requirements";
--> statement-breakpoint
ALTER TABLE "inv_project_requirements" DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "inv_projects";
--> statement-breakpoint
ALTER TABLE "inv_projects" DISABLE ROW LEVEL SECURITY;
