-- Tenant isolation for the three tables db:verify-rls reported with no policy.
--
-- All three carry a NOT NULL org_id and all three already grant SELECT/INSERT/UPDATE/DELETE to
-- streamline_app -- grants arrive through ALTER DEFAULT PRIVILEGES, so a table created without a
-- policy is readable org-wide and nothing complains. Verified before writing this: pg_policies
-- returns zero rows for each, relrowsecurity is false, and the app role already holds all four
-- privileges on inv_carton_types.
--
-- All three are empty today, so nothing has leaked; the hole is structural, not yet exploited.
--
--   inv_carton_types             created outside this PRD's scope (Inventory), no owning session
--   inv_shipment_status_events   same
--   organization_cell_traffic    created by 0627_org_cell_traffic
--
-- Pattern follows 0591_tenant_isolation_for_unprotected_tables exactly, and the statement order
-- matters: ENABLE, then DROP IF EXISTS so a re-run is clean, then CREATE, then REVOKE the PUBLIC
-- grant, then GRANT to the application role. Reversing the last two would leave PUBLIC holding
-- rights on a table whose policy is already live.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "inv_carton_types" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "inv_carton_types";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "inv_carton_types"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "inv_carton_types" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "inv_carton_types" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "inv_shipment_status_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "inv_shipment_status_events";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "inv_shipment_status_events"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "inv_shipment_status_events" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "inv_shipment_status_events" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "organization_cell_traffic" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "organization_cell_traffic";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "organization_cell_traffic"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "organization_cell_traffic" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "organization_cell_traffic" TO streamline_app;
