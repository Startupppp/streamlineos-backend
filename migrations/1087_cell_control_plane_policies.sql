-- The remaining cell/placement/relocation tables are control plane: placement_decisions is
-- written by decideRegion() while an organisation is still being created, and relocation,
-- cell-traffic and noisy-neighbour rows are written by platform operations that move or measure
-- an organisation from outside it. None of these paths hold app.organization_id, and every one
-- of these tables used app.current_org_id(), the throwing variant — placement_decisions alone
-- 42501'd every organisation creation once the saga tables (1085) stopped doing so first.
--
-- Same shape as 1082 and 1085: full access on the out-of-tenant control-plane path, scoped to the
-- caller's own organisation once a tenant is known.
SET lock_timeout = '5s';
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "placement_decisions";
--> statement-breakpoint
DROP POLICY IF EXISTS "control_plane_access" ON "placement_decisions";
--> statement-breakpoint
CREATE POLICY "control_plane_access" ON "placement_decisions"
  FOR ALL TO PUBLIC
  USING (app.current_org_id_or_null() IS NULL OR "organization_id" = app.current_org_id_or_null())
  WITH CHECK (app.current_org_id_or_null() IS NULL OR "organization_id" = app.current_org_id_or_null());
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "organization_relocations";
--> statement-breakpoint
DROP POLICY IF EXISTS "control_plane_access" ON "organization_relocations";
--> statement-breakpoint
CREATE POLICY "control_plane_access" ON "organization_relocations"
  FOR ALL TO PUBLIC
  USING (app.current_org_id_or_null() IS NULL OR "organization_id" = app.current_org_id_or_null())
  WITH CHECK (app.current_org_id_or_null() IS NULL OR "organization_id" = app.current_org_id_or_null());
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "organization_relocation_checksums";
--> statement-breakpoint
DROP POLICY IF EXISTS "control_plane_access" ON "organization_relocation_checksums";
--> statement-breakpoint
-- This child carries no tenant column of its own in any journalled migration or table definition;
-- its tenancy is the parent relocation's, reached through relocation_id.
CREATE POLICY "control_plane_access" ON "organization_relocation_checksums"
  FOR ALL TO PUBLIC
  USING (
    app.current_org_id_or_null() IS NULL
    OR EXISTS (
      SELECT 1 FROM "organization_relocations" r
      WHERE r."relocation_id" = "organization_relocation_checksums"."relocation_id"
        AND r."organization_id" = app.current_org_id_or_null()
    )
  )
  WITH CHECK (
    app.current_org_id_or_null() IS NULL
    OR EXISTS (
      SELECT 1 FROM "organization_relocations" r
      WHERE r."relocation_id" = "organization_relocation_checksums"."relocation_id"
        AND r."organization_id" = app.current_org_id_or_null()
    )
  );
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "organization_cell_traffic";
--> statement-breakpoint
DROP POLICY IF EXISTS "control_plane_access" ON "organization_cell_traffic";
--> statement-breakpoint
CREATE POLICY "control_plane_access" ON "organization_cell_traffic"
  FOR ALL TO PUBLIC
  USING (app.current_org_id_or_null() IS NULL OR "org_id" = app.current_org_id_or_null())
  WITH CHECK (app.current_org_id_or_null() IS NULL OR "org_id" = app.current_org_id_or_null());
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "noisy_neighbour_reviews";
--> statement-breakpoint
DROP POLICY IF EXISTS "control_plane_access" ON "noisy_neighbour_reviews";
--> statement-breakpoint
CREATE POLICY "control_plane_access" ON "noisy_neighbour_reviews"
  FOR ALL TO PUBLIC
  USING (app.current_org_id_or_null() IS NULL OR "organization_id" = app.current_org_id_or_null())
  WITH CHECK (app.current_org_id_or_null() IS NULL OR "organization_id" = app.current_org_id_or_null());
