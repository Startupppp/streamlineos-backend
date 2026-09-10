-- organization_placement is control-plane routing metadata, read and written
-- OUTSIDE any tenant transaction (placement-lookup.ts runOutsideTenantContext):
-- the lookup runs BEFORE a tenant context exists, precisely to discover which
-- cell owns an org. The prior "tenant_isolation" policy used app.current_org_id()
-- (the throwing variant), so every out-of-tenant control-plane read/write raised
-- 42501 "no tenant context" — breaking placement resolution for every request.
--
-- Replace it with a policy that permits the out-of-tenant control-plane path
-- (GUC unset) full access, while still scoping in-tenant access to the caller's
-- own org via the non-throwing app.current_org_id_or_null().
SET lock_timeout = '5s';
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "organization_placement";
--> statement-breakpoint
CREATE POLICY "control_plane_access" ON "organization_placement"
  FOR ALL
  TO PUBLIC
  USING (app.current_org_id_or_null() IS NULL OR "organization_id" = app.current_org_id_or_null())
  WITH CHECK (app.current_org_id_or_null() IS NULL OR "organization_id" = app.current_org_id_or_null());
