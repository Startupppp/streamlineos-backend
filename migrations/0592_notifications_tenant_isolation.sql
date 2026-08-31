-- Tenant isolation for notifications and its partitions.
--
-- notifications has never had an RLS policy -- it appears in no ENABLE ROW LEVEL SECURITY migration
-- -- and 0582 turned that one unprotected relation into fifty by partitioning it. The posture did
-- not change, but the surface did, and db:verify-rls counts each partition.
--
-- The policy on the parent covers rows reached through the parent, which is every application read.
-- The partitions carry their own because the retention sweep addresses them directly by name, and
-- because a verifier that checks relations rather than hierarchies is the honest check to satisfy.
--
-- Inert while the application connects as an owner carrying BYPASSRLS. Order per 0271.

SET lock_timeout = '5s';


--> statement-breakpoint
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "notifications";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notifications"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "notifications" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "notifications" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "notifications_default" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "notifications_default";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notifications_default"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "notifications_default" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "notifications_default" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "notifications_y2024_m01" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "notifications_y2024_m01";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notifications_y2024_m01"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "notifications_y2024_m01" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "notifications_y2024_m01" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "notifications_y2024_m02" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "notifications_y2024_m02";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notifications_y2024_m02"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "notifications_y2024_m02" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "notifications_y2024_m02" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "notifications_y2024_m03" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "notifications_y2024_m03";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notifications_y2024_m03"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "notifications_y2024_m03" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "notifications_y2024_m03" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "notifications_y2024_m04" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "notifications_y2024_m04";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notifications_y2024_m04"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "notifications_y2024_m04" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "notifications_y2024_m04" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "notifications_y2024_m05" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "notifications_y2024_m05";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notifications_y2024_m05"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "notifications_y2024_m05" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "notifications_y2024_m05" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "notifications_y2024_m06" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "notifications_y2024_m06";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notifications_y2024_m06"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "notifications_y2024_m06" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "notifications_y2024_m06" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "notifications_y2024_m07" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "notifications_y2024_m07";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notifications_y2024_m07"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "notifications_y2024_m07" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "notifications_y2024_m07" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "notifications_y2024_m08" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "notifications_y2024_m08";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notifications_y2024_m08"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "notifications_y2024_m08" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "notifications_y2024_m08" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "notifications_y2024_m09" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "notifications_y2024_m09";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notifications_y2024_m09"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "notifications_y2024_m09" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "notifications_y2024_m09" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "notifications_y2024_m10" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "notifications_y2024_m10";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notifications_y2024_m10"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "notifications_y2024_m10" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "notifications_y2024_m10" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "notifications_y2024_m11" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "notifications_y2024_m11";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notifications_y2024_m11"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "notifications_y2024_m11" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "notifications_y2024_m11" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "notifications_y2024_m12" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "notifications_y2024_m12";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notifications_y2024_m12"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "notifications_y2024_m12" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "notifications_y2024_m12" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "notifications_y2025_m01" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "notifications_y2025_m01";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notifications_y2025_m01"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "notifications_y2025_m01" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "notifications_y2025_m01" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "notifications_y2025_m02" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "notifications_y2025_m02";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notifications_y2025_m02"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "notifications_y2025_m02" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "notifications_y2025_m02" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "notifications_y2025_m03" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "notifications_y2025_m03";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notifications_y2025_m03"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "notifications_y2025_m03" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "notifications_y2025_m03" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "notifications_y2025_m04" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "notifications_y2025_m04";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notifications_y2025_m04"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "notifications_y2025_m04" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "notifications_y2025_m04" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "notifications_y2025_m05" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "notifications_y2025_m05";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notifications_y2025_m05"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "notifications_y2025_m05" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "notifications_y2025_m05" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "notifications_y2025_m06" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "notifications_y2025_m06";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notifications_y2025_m06"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "notifications_y2025_m06" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "notifications_y2025_m06" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "notifications_y2025_m07" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "notifications_y2025_m07";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notifications_y2025_m07"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "notifications_y2025_m07" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "notifications_y2025_m07" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "notifications_y2025_m08" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "notifications_y2025_m08";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notifications_y2025_m08"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "notifications_y2025_m08" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "notifications_y2025_m08" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "notifications_y2025_m09" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "notifications_y2025_m09";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notifications_y2025_m09"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "notifications_y2025_m09" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "notifications_y2025_m09" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "notifications_y2025_m10" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "notifications_y2025_m10";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notifications_y2025_m10"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "notifications_y2025_m10" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "notifications_y2025_m10" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "notifications_y2025_m11" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "notifications_y2025_m11";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notifications_y2025_m11"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "notifications_y2025_m11" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "notifications_y2025_m11" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "notifications_y2025_m12" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "notifications_y2025_m12";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notifications_y2025_m12"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "notifications_y2025_m12" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "notifications_y2025_m12" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "notifications_y2026_m01" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "notifications_y2026_m01";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notifications_y2026_m01"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "notifications_y2026_m01" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "notifications_y2026_m01" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "notifications_y2026_m02" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "notifications_y2026_m02";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notifications_y2026_m02"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "notifications_y2026_m02" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "notifications_y2026_m02" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "notifications_y2026_m03" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "notifications_y2026_m03";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notifications_y2026_m03"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "notifications_y2026_m03" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "notifications_y2026_m03" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "notifications_y2026_m04" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "notifications_y2026_m04";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notifications_y2026_m04"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "notifications_y2026_m04" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "notifications_y2026_m04" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "notifications_y2026_m05" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "notifications_y2026_m05";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notifications_y2026_m05"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "notifications_y2026_m05" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "notifications_y2026_m05" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "notifications_y2026_m06" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "notifications_y2026_m06";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notifications_y2026_m06"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "notifications_y2026_m06" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "notifications_y2026_m06" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "notifications_y2026_m07" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "notifications_y2026_m07";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notifications_y2026_m07"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "notifications_y2026_m07" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "notifications_y2026_m07" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "notifications_y2026_m08" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "notifications_y2026_m08";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notifications_y2026_m08"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "notifications_y2026_m08" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "notifications_y2026_m08" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "notifications_y2026_m09" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "notifications_y2026_m09";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notifications_y2026_m09"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "notifications_y2026_m09" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "notifications_y2026_m09" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "notifications_y2026_m10" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "notifications_y2026_m10";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notifications_y2026_m10"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "notifications_y2026_m10" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "notifications_y2026_m10" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "notifications_y2026_m11" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "notifications_y2026_m11";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notifications_y2026_m11"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "notifications_y2026_m11" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "notifications_y2026_m11" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "notifications_y2026_m12" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "notifications_y2026_m12";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notifications_y2026_m12"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "notifications_y2026_m12" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "notifications_y2026_m12" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "notifications_y2027_m01" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "notifications_y2027_m01";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notifications_y2027_m01"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "notifications_y2027_m01" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "notifications_y2027_m01" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "notifications_y2027_m02" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "notifications_y2027_m02";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notifications_y2027_m02"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "notifications_y2027_m02" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "notifications_y2027_m02" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "notifications_y2027_m03" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "notifications_y2027_m03";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notifications_y2027_m03"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "notifications_y2027_m03" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "notifications_y2027_m03" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "notifications_y2027_m04" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "notifications_y2027_m04";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notifications_y2027_m04"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "notifications_y2027_m04" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "notifications_y2027_m04" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "notifications_y2027_m05" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "notifications_y2027_m05";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notifications_y2027_m05"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "notifications_y2027_m05" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "notifications_y2027_m05" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "notifications_y2027_m06" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "notifications_y2027_m06";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notifications_y2027_m06"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "notifications_y2027_m06" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "notifications_y2027_m06" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "notifications_y2027_m07" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "notifications_y2027_m07";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notifications_y2027_m07"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "notifications_y2027_m07" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "notifications_y2027_m07" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "notifications_y2027_m08" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "notifications_y2027_m08";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notifications_y2027_m08"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "notifications_y2027_m08" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "notifications_y2027_m08" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "notifications_y2027_m09" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "notifications_y2027_m09";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notifications_y2027_m09"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "notifications_y2027_m09" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "notifications_y2027_m09" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "notifications_y2027_m10" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "notifications_y2027_m10";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notifications_y2027_m10"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "notifications_y2027_m10" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "notifications_y2027_m10" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "notifications_y2027_m11" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "notifications_y2027_m11";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notifications_y2027_m11"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "notifications_y2027_m11" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "notifications_y2027_m11" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "notifications_y2027_m12" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "notifications_y2027_m12";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notifications_y2027_m12"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "notifications_y2027_m12" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "notifications_y2027_m12" TO streamline_app;
