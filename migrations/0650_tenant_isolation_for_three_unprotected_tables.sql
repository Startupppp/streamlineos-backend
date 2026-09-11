-- Guarded per table: some of the tables this names no longer exist.
--
-- The accounting rewrite replaced the pre-kernel finance tables and the party
-- migration replaced `leads`, and a statement against an absent table aborts the
-- whole migration. Each statement below now runs only if every table it names
-- exists — its target and anything it references. Where all of them are present
-- this is exactly the original file.

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
DO $g1$
BEGIN
  IF to_regclass('public."inv_carton_types"') IS NOT NULL THEN
    EXECUTE $s1$
ALTER TABLE "inv_carton_types" ENABLE ROW LEVEL SECURITY
$s1$;
  END IF;
END $g1$;
--> statement-breakpoint
DO $g2$
BEGIN
  IF to_regclass('public."inv_carton_types"') IS NOT NULL THEN
    EXECUTE $s2$
DROP POLICY IF EXISTS "tenant_isolation" ON "inv_carton_types"
$s2$;
  END IF;
END $g2$;
--> statement-breakpoint
DO $g3$
BEGIN
  IF to_regclass('public."inv_carton_types"') IS NOT NULL THEN
    EXECUTE $s3$
CREATE POLICY "tenant_isolation" ON "inv_carton_types"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s3$;
  END IF;
END $g3$;
--> statement-breakpoint
DO $g4$
BEGIN
  IF to_regclass('public."inv_carton_types"') IS NOT NULL THEN
    EXECUTE $s4$
REVOKE ALL ON "inv_carton_types" FROM PUBLIC
$s4$;
  END IF;
END $g4$;
--> statement-breakpoint
DO $g5$
BEGIN
  IF to_regclass('public."inv_carton_types"') IS NOT NULL THEN
    EXECUTE $s5$
GRANT SELECT, INSERT, UPDATE, DELETE ON "inv_carton_types" TO streamline_app
$s5$;
  END IF;
END $g5$;
--> statement-breakpoint
DO $g6$
BEGIN
  IF to_regclass('public."inv_shipment_status_events"') IS NOT NULL THEN
    EXECUTE $s6$
ALTER TABLE "inv_shipment_status_events" ENABLE ROW LEVEL SECURITY
$s6$;
  END IF;
END $g6$;
--> statement-breakpoint
DO $g7$
BEGIN
  IF to_regclass('public."inv_shipment_status_events"') IS NOT NULL THEN
    EXECUTE $s7$
DROP POLICY IF EXISTS "tenant_isolation" ON "inv_shipment_status_events"
$s7$;
  END IF;
END $g7$;
--> statement-breakpoint
DO $g8$
BEGIN
  IF to_regclass('public."inv_shipment_status_events"') IS NOT NULL THEN
    EXECUTE $s8$
CREATE POLICY "tenant_isolation" ON "inv_shipment_status_events"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s8$;
  END IF;
END $g8$;
--> statement-breakpoint
DO $g9$
BEGIN
  IF to_regclass('public."inv_shipment_status_events"') IS NOT NULL THEN
    EXECUTE $s9$
REVOKE ALL ON "inv_shipment_status_events" FROM PUBLIC
$s9$;
  END IF;
END $g9$;
--> statement-breakpoint
DO $g10$
BEGIN
  IF to_regclass('public."inv_shipment_status_events"') IS NOT NULL THEN
    EXECUTE $s10$
GRANT SELECT, INSERT, UPDATE, DELETE ON "inv_shipment_status_events" TO streamline_app
$s10$;
  END IF;
END $g10$;
--> statement-breakpoint
DO $g11$
BEGIN
  IF to_regclass('public."organization_cell_traffic"') IS NOT NULL THEN
    EXECUTE $s11$
ALTER TABLE "organization_cell_traffic" ENABLE ROW LEVEL SECURITY
$s11$;
  END IF;
END $g11$;
--> statement-breakpoint
DO $g12$
BEGIN
  IF to_regclass('public."organization_cell_traffic"') IS NOT NULL THEN
    EXECUTE $s12$
DROP POLICY IF EXISTS "tenant_isolation" ON "organization_cell_traffic"
$s12$;
  END IF;
END $g12$;
--> statement-breakpoint
DO $g13$
BEGIN
  IF to_regclass('public."organization_cell_traffic"') IS NOT NULL THEN
    EXECUTE $s13$
CREATE POLICY "tenant_isolation" ON "organization_cell_traffic"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s13$;
  END IF;
END $g13$;
--> statement-breakpoint
DO $g14$
BEGIN
  IF to_regclass('public."organization_cell_traffic"') IS NOT NULL THEN
    EXECUTE $s14$
REVOKE ALL ON "organization_cell_traffic" FROM PUBLIC
$s14$;
  END IF;
END $g14$;
--> statement-breakpoint
DO $g15$
BEGIN
  IF to_regclass('public."organization_cell_traffic"') IS NOT NULL THEN
    EXECUTE $s15$
GRANT SELECT, INSERT, UPDATE, DELETE ON "organization_cell_traffic" TO streamline_app
$s15$;
  END IF;
END $g15$;
