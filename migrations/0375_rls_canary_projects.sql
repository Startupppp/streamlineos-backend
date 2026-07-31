SET statement_timeout = 0;

-- 0375 — first RLS policy, on `projects` alone.
-- ENABLE not FORCE: BYPASSRLS is checked before ownership, so the migration role
-- is unaffected either way and this is inert until the app connects as the
-- non-owner role. PERMISSIVE not RESTRICTIVE: Postgres shows a row only if a
-- permissive policy allows it, so a restrictive-only table denies everyone.

ALTER TABLE "projects" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

DROP POLICY IF EXISTS tenant_isolation ON "projects";
--> statement-breakpoint

CREATE POLICY tenant_isolation ON "projects"
  FOR ALL
  USING (org_id = app.current_org_id())
  WITH CHECK (org_id = app.current_org_id());
