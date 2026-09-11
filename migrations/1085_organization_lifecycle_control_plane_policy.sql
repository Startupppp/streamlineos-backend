-- The organization-creation saga runs BEFORE the organisation it is creating can be a tenant:
-- OrganizationSagaService.begin/findByRequestKey/claim execute under @NoTenantTransaction() on
-- POST /organization and POST /org/setup/complete, so app.organization_id is never set. The three
-- lifecycle tables nonetheless carried USING (<org col> = app.current_org_id()), the throwing
-- variant, so every organisation creation raised 42501 and answered 500 — the wizard's Launch step
-- could never complete.
--
-- Same control-plane shape migration 1082 applied to organization_placement: full access on the
-- out-of-tenant path where the GUC is unset, scoped to the caller's own org once one is known.
SET lock_timeout = '5s';
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "organization_lifecycle_sagas";
--> statement-breakpoint
DROP POLICY IF EXISTS "control_plane_access" ON "organization_lifecycle_sagas";
--> statement-breakpoint
CREATE POLICY "control_plane_access" ON "organization_lifecycle_sagas"
  FOR ALL
  TO PUBLIC
  USING (app.current_org_id_or_null() IS NULL OR "organization_id" = app.current_org_id_or_null())
  WITH CHECK (app.current_org_id_or_null() IS NULL OR "organization_id" = app.current_org_id_or_null());
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "organization_saga_steps";
--> statement-breakpoint
DROP POLICY IF EXISTS "control_plane_access" ON "organization_saga_steps";
--> statement-breakpoint
CREATE POLICY "control_plane_access" ON "organization_saga_steps"
  FOR ALL
  TO PUBLIC
  USING (app.current_org_id_or_null() IS NULL OR "org_id" = app.current_org_id_or_null())
  WITH CHECK (app.current_org_id_or_null() IS NULL OR "org_id" = app.current_org_id_or_null());
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "organization_reservations";
--> statement-breakpoint
DROP POLICY IF EXISTS "control_plane_access" ON "organization_reservations";
--> statement-breakpoint
CREATE POLICY "control_plane_access" ON "organization_reservations"
  FOR ALL
  TO PUBLIC
  USING (app.current_org_id_or_null() IS NULL OR "organization_id" = app.current_org_id_or_null())
  WITH CHECK (app.current_org_id_or_null() IS NULL OR "organization_id" = app.current_org_id_or_null());
