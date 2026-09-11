-- Guarded per table: some of the tables this names no longer exist.
--
-- The accounting rewrite replaced the pre-kernel finance tables and the party
-- migration replaced `leads`, and a statement against an absent table aborts the
-- whole migration. Each statement below now runs only if every table it names
-- exists — its target and anything it references. Where all of them are present
-- this is exactly the original file.

-- Tenant isolation for 80 tables that carry an org column and have no policy.
--
-- db:verify-rls, runnable for the first time now the database is migrated, reported 129 tenant
-- tables with no RLS policy. A missing policy is silent: ALTER DEFAULT PRIVILEGES grants SELECT to
-- the app role on every new table, so the table is readable org-wide and nothing complains.
--
-- Most of these are the accounting, finance, GL and tax model whose tables the 0000 baseline never
-- actually created -- the RLS migrations that would have covered them ran while they did not exist.
-- Recreating the tables without their policies would have left the hole open in a worse form:
-- present and readable rather than absent.
--
-- The notifications family (parent plus 49 partitions) is deliberately excluded. It has never had
-- RLS, that predates this work, and turning it on is a c25 decision rather than a repair.
--
-- Pattern follows 0271_crm_suppression_hashes_rls exactly, and the order matters: ENABLE, then
-- DROP IF EXISTS so a re-run is clean, then CREATE, then REVOKE the PUBLIC grant, then GRANT to the
-- application role. Reversing the last two leaves PUBLIC holding rights on a table whose policy is
-- already live.
--
-- Inert while the application connects as an owner carrying BYPASSRLS, which is exactly why these
-- were never noticed. They start mattering at the move to streamline_app.

SET lock_timeout = '5s';


--> statement-breakpoint
DO $g1$
BEGIN
  IF to_regclass('public."acc_asset_categories"') IS NOT NULL THEN
    EXECUTE $s1$
ALTER TABLE "acc_asset_categories" ENABLE ROW LEVEL SECURITY
$s1$;
  END IF;
END $g1$;
--> statement-breakpoint
DO $g2$
BEGIN
  IF to_regclass('public."acc_asset_categories"') IS NOT NULL THEN
    EXECUTE $s2$
DROP POLICY IF EXISTS "tenant_isolation" ON "acc_asset_categories"
$s2$;
  END IF;
END $g2$;
--> statement-breakpoint
DO $g3$
BEGIN
  IF to_regclass('public."acc_asset_categories"') IS NOT NULL THEN
    EXECUTE $s3$
CREATE POLICY "tenant_isolation" ON "acc_asset_categories"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s3$;
  END IF;
END $g3$;
--> statement-breakpoint
DO $g4$
BEGIN
  IF to_regclass('public."acc_asset_categories"') IS NOT NULL THEN
    EXECUTE $s4$
REVOKE ALL ON "acc_asset_categories" FROM PUBLIC
$s4$;
  END IF;
END $g4$;
--> statement-breakpoint
DO $g5$
BEGIN
  IF to_regclass('public."acc_asset_categories"') IS NOT NULL THEN
    EXECUTE $s5$
GRANT SELECT, INSERT, UPDATE, DELETE ON "acc_asset_categories" TO streamline_app
$s5$;
  END IF;
END $g5$;
--> statement-breakpoint
DO $g6$
BEGIN
  IF to_regclass('public."acc_depreciation_runs"') IS NOT NULL THEN
    EXECUTE $s6$
ALTER TABLE "acc_depreciation_runs" ENABLE ROW LEVEL SECURITY
$s6$;
  END IF;
END $g6$;
--> statement-breakpoint
DO $g7$
BEGIN
  IF to_regclass('public."acc_depreciation_runs"') IS NOT NULL THEN
    EXECUTE $s7$
DROP POLICY IF EXISTS "tenant_isolation" ON "acc_depreciation_runs"
$s7$;
  END IF;
END $g7$;
--> statement-breakpoint
DO $g8$
BEGIN
  IF to_regclass('public."acc_depreciation_runs"') IS NOT NULL THEN
    EXECUTE $s8$
CREATE POLICY "tenant_isolation" ON "acc_depreciation_runs"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s8$;
  END IF;
END $g8$;
--> statement-breakpoint
DO $g9$
BEGIN
  IF to_regclass('public."acc_depreciation_runs"') IS NOT NULL THEN
    EXECUTE $s9$
REVOKE ALL ON "acc_depreciation_runs" FROM PUBLIC
$s9$;
  END IF;
END $g9$;
--> statement-breakpoint
DO $g10$
BEGIN
  IF to_regclass('public."acc_depreciation_runs"') IS NOT NULL THEN
    EXECUTE $s10$
GRANT SELECT, INSERT, UPDATE, DELETE ON "acc_depreciation_runs" TO streamline_app
$s10$;
  END IF;
END $g10$;
--> statement-breakpoint
DO $g11$
BEGIN
  IF to_regclass('public."acc_depreciation_schedules"') IS NOT NULL THEN
    EXECUTE $s11$
ALTER TABLE "acc_depreciation_schedules" ENABLE ROW LEVEL SECURITY
$s11$;
  END IF;
END $g11$;
--> statement-breakpoint
DO $g12$
BEGIN
  IF to_regclass('public."acc_depreciation_schedules"') IS NOT NULL THEN
    EXECUTE $s12$
DROP POLICY IF EXISTS "tenant_isolation" ON "acc_depreciation_schedules"
$s12$;
  END IF;
END $g12$;
--> statement-breakpoint
DO $g13$
BEGIN
  IF to_regclass('public."acc_depreciation_schedules"') IS NOT NULL THEN
    EXECUTE $s13$
CREATE POLICY "tenant_isolation" ON "acc_depreciation_schedules"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s13$;
  END IF;
END $g13$;
--> statement-breakpoint
DO $g14$
BEGIN
  IF to_regclass('public."acc_depreciation_schedules"') IS NOT NULL THEN
    EXECUTE $s14$
REVOKE ALL ON "acc_depreciation_schedules" FROM PUBLIC
$s14$;
  END IF;
END $g14$;
--> statement-breakpoint
DO $g15$
BEGIN
  IF to_regclass('public."acc_depreciation_schedules"') IS NOT NULL THEN
    EXECUTE $s15$
GRANT SELECT, INSERT, UPDATE, DELETE ON "acc_depreciation_schedules" TO streamline_app
$s15$;
  END IF;
END $g15$;
--> statement-breakpoint
DO $g16$
BEGIN
  IF to_regclass('public."acc_fixed_assets"') IS NOT NULL THEN
    EXECUTE $s16$
ALTER TABLE "acc_fixed_assets" ENABLE ROW LEVEL SECURITY
$s16$;
  END IF;
END $g16$;
--> statement-breakpoint
DO $g17$
BEGIN
  IF to_regclass('public."acc_fixed_assets"') IS NOT NULL THEN
    EXECUTE $s17$
DROP POLICY IF EXISTS "tenant_isolation" ON "acc_fixed_assets"
$s17$;
  END IF;
END $g17$;
--> statement-breakpoint
DO $g18$
BEGIN
  IF to_regclass('public."acc_fixed_assets"') IS NOT NULL THEN
    EXECUTE $s18$
CREATE POLICY "tenant_isolation" ON "acc_fixed_assets"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s18$;
  END IF;
END $g18$;
--> statement-breakpoint
DO $g19$
BEGIN
  IF to_regclass('public."acc_fixed_assets"') IS NOT NULL THEN
    EXECUTE $s19$
REVOKE ALL ON "acc_fixed_assets" FROM PUBLIC
$s19$;
  END IF;
END $g19$;
--> statement-breakpoint
DO $g20$
BEGIN
  IF to_regclass('public."acc_fixed_assets"') IS NOT NULL THEN
    EXECUTE $s20$
GRANT SELECT, INSERT, UPDATE, DELETE ON "acc_fixed_assets" TO streamline_app
$s20$;
  END IF;
END $g20$;
--> statement-breakpoint
DO $g21$
BEGIN
  IF to_regclass('public."acc_number_sequences"') IS NOT NULL THEN
    EXECUTE $s21$
ALTER TABLE "acc_number_sequences" ENABLE ROW LEVEL SECURITY
$s21$;
  END IF;
END $g21$;
--> statement-breakpoint
DO $g22$
BEGIN
  IF to_regclass('public."acc_number_sequences"') IS NOT NULL THEN
    EXECUTE $s22$
DROP POLICY IF EXISTS "tenant_isolation" ON "acc_number_sequences"
$s22$;
  END IF;
END $g22$;
--> statement-breakpoint
DO $g23$
BEGIN
  IF to_regclass('public."acc_number_sequences"') IS NOT NULL THEN
    EXECUTE $s23$
CREATE POLICY "tenant_isolation" ON "acc_number_sequences"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s23$;
  END IF;
END $g23$;
--> statement-breakpoint
DO $g24$
BEGIN
  IF to_regclass('public."acc_number_sequences"') IS NOT NULL THEN
    EXECUTE $s24$
REVOKE ALL ON "acc_number_sequences" FROM PUBLIC
$s24$;
  END IF;
END $g24$;
--> statement-breakpoint
DO $g25$
BEGIN
  IF to_regclass('public."acc_number_sequences"') IS NOT NULL THEN
    EXECUTE $s25$
GRANT SELECT, INSERT, UPDATE, DELETE ON "acc_number_sequences" TO streamline_app
$s25$;
  END IF;
END $g25$;
--> statement-breakpoint
DO $g26$
BEGIN
  IF to_regclass('public."acc_system_account_map"') IS NOT NULL THEN
    EXECUTE $s26$
ALTER TABLE "acc_system_account_map" ENABLE ROW LEVEL SECURITY
$s26$;
  END IF;
END $g26$;
--> statement-breakpoint
DO $g27$
BEGIN
  IF to_regclass('public."acc_system_account_map"') IS NOT NULL THEN
    EXECUTE $s27$
DROP POLICY IF EXISTS "tenant_isolation" ON "acc_system_account_map"
$s27$;
  END IF;
END $g27$;
--> statement-breakpoint
DO $g28$
BEGIN
  IF to_regclass('public."acc_system_account_map"') IS NOT NULL THEN
    EXECUTE $s28$
CREATE POLICY "tenant_isolation" ON "acc_system_account_map"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s28$;
  END IF;
END $g28$;
--> statement-breakpoint
DO $g29$
BEGIN
  IF to_regclass('public."acc_system_account_map"') IS NOT NULL THEN
    EXECUTE $s29$
REVOKE ALL ON "acc_system_account_map" FROM PUBLIC
$s29$;
  END IF;
END $g29$;
--> statement-breakpoint
DO $g30$
BEGIN
  IF to_regclass('public."acc_system_account_map"') IS NOT NULL THEN
    EXECUTE $s30$
GRANT SELECT, INSERT, UPDATE, DELETE ON "acc_system_account_map" TO streamline_app
$s30$;
  END IF;
END $g30$;
--> statement-breakpoint
DO $g31$
BEGIN
  IF to_regclass('public."acc_tax_codes"') IS NOT NULL THEN
    EXECUTE $s31$
ALTER TABLE "acc_tax_codes" ENABLE ROW LEVEL SECURITY
$s31$;
  END IF;
END $g31$;
--> statement-breakpoint
DO $g32$
BEGIN
  IF to_regclass('public."acc_tax_codes"') IS NOT NULL THEN
    EXECUTE $s32$
DROP POLICY IF EXISTS "tenant_isolation" ON "acc_tax_codes"
$s32$;
  END IF;
END $g32$;
--> statement-breakpoint
DO $g33$
BEGIN
  IF to_regclass('public."acc_tax_codes"') IS NOT NULL THEN
    EXECUTE $s33$
CREATE POLICY "tenant_isolation" ON "acc_tax_codes"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s33$;
  END IF;
END $g33$;
--> statement-breakpoint
DO $g34$
BEGIN
  IF to_regclass('public."acc_tax_codes"') IS NOT NULL THEN
    EXECUTE $s34$
REVOKE ALL ON "acc_tax_codes" FROM PUBLIC
$s34$;
  END IF;
END $g34$;
--> statement-breakpoint
DO $g35$
BEGIN
  IF to_regclass('public."acc_tax_codes"') IS NOT NULL THEN
    EXECUTE $s35$
GRANT SELECT, INSERT, UPDATE, DELETE ON "acc_tax_codes" TO streamline_app
$s35$;
  END IF;
END $g35$;
--> statement-breakpoint
DO $g36$
BEGIN
  IF to_regclass('public."acc_tax_payments"') IS NOT NULL THEN
    EXECUTE $s36$
ALTER TABLE "acc_tax_payments" ENABLE ROW LEVEL SECURITY
$s36$;
  END IF;
END $g36$;
--> statement-breakpoint
DO $g37$
BEGIN
  IF to_regclass('public."acc_tax_payments"') IS NOT NULL THEN
    EXECUTE $s37$
DROP POLICY IF EXISTS "tenant_isolation" ON "acc_tax_payments"
$s37$;
  END IF;
END $g37$;
--> statement-breakpoint
DO $g38$
BEGIN
  IF to_regclass('public."acc_tax_payments"') IS NOT NULL THEN
    EXECUTE $s38$
CREATE POLICY "tenant_isolation" ON "acc_tax_payments"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s38$;
  END IF;
END $g38$;
--> statement-breakpoint
DO $g39$
BEGIN
  IF to_regclass('public."acc_tax_payments"') IS NOT NULL THEN
    EXECUTE $s39$
REVOKE ALL ON "acc_tax_payments" FROM PUBLIC
$s39$;
  END IF;
END $g39$;
--> statement-breakpoint
DO $g40$
BEGIN
  IF to_regclass('public."acc_tax_payments"') IS NOT NULL THEN
    EXECUTE $s40$
GRANT SELECT, INSERT, UPDATE, DELETE ON "acc_tax_payments" TO streamline_app
$s40$;
  END IF;
END $g40$;
--> statement-breakpoint
DO $g41$
BEGIN
  IF to_regclass('public."accounting_dimension_values"') IS NOT NULL THEN
    EXECUTE $s41$
ALTER TABLE "accounting_dimension_values" ENABLE ROW LEVEL SECURITY
$s41$;
  END IF;
END $g41$;
--> statement-breakpoint
DO $g42$
BEGIN
  IF to_regclass('public."accounting_dimension_values"') IS NOT NULL THEN
    EXECUTE $s42$
DROP POLICY IF EXISTS "tenant_isolation" ON "accounting_dimension_values"
$s42$;
  END IF;
END $g42$;
--> statement-breakpoint
DO $g43$
BEGIN
  IF to_regclass('public."accounting_dimension_values"') IS NOT NULL THEN
    EXECUTE $s43$
CREATE POLICY "tenant_isolation" ON "accounting_dimension_values"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s43$;
  END IF;
END $g43$;
--> statement-breakpoint
DO $g44$
BEGIN
  IF to_regclass('public."accounting_dimension_values"') IS NOT NULL THEN
    EXECUTE $s44$
REVOKE ALL ON "accounting_dimension_values" FROM PUBLIC
$s44$;
  END IF;
END $g44$;
--> statement-breakpoint
DO $g45$
BEGIN
  IF to_regclass('public."accounting_dimension_values"') IS NOT NULL THEN
    EXECUTE $s45$
GRANT SELECT, INSERT, UPDATE, DELETE ON "accounting_dimension_values" TO streamline_app
$s45$;
  END IF;
END $g45$;
--> statement-breakpoint
DO $g46$
BEGIN
  IF to_regclass('public."accounting_dimensions"') IS NOT NULL THEN
    EXECUTE $s46$
ALTER TABLE "accounting_dimensions" ENABLE ROW LEVEL SECURITY
$s46$;
  END IF;
END $g46$;
--> statement-breakpoint
DO $g47$
BEGIN
  IF to_regclass('public."accounting_dimensions"') IS NOT NULL THEN
    EXECUTE $s47$
DROP POLICY IF EXISTS "tenant_isolation" ON "accounting_dimensions"
$s47$;
  END IF;
END $g47$;
--> statement-breakpoint
DO $g48$
BEGIN
  IF to_regclass('public."accounting_dimensions"') IS NOT NULL THEN
    EXECUTE $s48$
CREATE POLICY "tenant_isolation" ON "accounting_dimensions"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s48$;
  END IF;
END $g48$;
--> statement-breakpoint
DO $g49$
BEGIN
  IF to_regclass('public."accounting_dimensions"') IS NOT NULL THEN
    EXECUTE $s49$
REVOKE ALL ON "accounting_dimensions" FROM PUBLIC
$s49$;
  END IF;
END $g49$;
--> statement-breakpoint
DO $g50$
BEGIN
  IF to_regclass('public."accounting_dimensions"') IS NOT NULL THEN
    EXECUTE $s50$
GRANT SELECT, INSERT, UPDATE, DELETE ON "accounting_dimensions" TO streamline_app
$s50$;
  END IF;
END $g50$;
--> statement-breakpoint
DO $g51$
BEGIN
  IF to_regclass('public."accounting_periods"') IS NOT NULL THEN
    EXECUTE $s51$
ALTER TABLE "accounting_periods" ENABLE ROW LEVEL SECURITY
$s51$;
  END IF;
END $g51$;
--> statement-breakpoint
DO $g52$
BEGIN
  IF to_regclass('public."accounting_periods"') IS NOT NULL THEN
    EXECUTE $s52$
DROP POLICY IF EXISTS "tenant_isolation" ON "accounting_periods"
$s52$;
  END IF;
END $g52$;
--> statement-breakpoint
DO $g53$
BEGIN
  IF to_regclass('public."accounting_periods"') IS NOT NULL THEN
    EXECUTE $s53$
CREATE POLICY "tenant_isolation" ON "accounting_periods"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s53$;
  END IF;
END $g53$;
--> statement-breakpoint
DO $g54$
BEGIN
  IF to_regclass('public."accounting_periods"') IS NOT NULL THEN
    EXECUTE $s54$
REVOKE ALL ON "accounting_periods" FROM PUBLIC
$s54$;
  END IF;
END $g54$;
--> statement-breakpoint
DO $g55$
BEGIN
  IF to_regclass('public."accounting_periods"') IS NOT NULL THEN
    EXECUTE $s55$
GRANT SELECT, INSERT, UPDATE, DELETE ON "accounting_periods" TO streamline_app
$s55$;
  END IF;
END $g55$;
--> statement-breakpoint
DO $g56$
BEGIN
  IF to_regclass('public."accounting_settings"') IS NOT NULL THEN
    EXECUTE $s56$
ALTER TABLE "accounting_settings" ENABLE ROW LEVEL SECURITY
$s56$;
  END IF;
END $g56$;
--> statement-breakpoint
DO $g57$
BEGIN
  IF to_regclass('public."accounting_settings"') IS NOT NULL THEN
    EXECUTE $s57$
DROP POLICY IF EXISTS "tenant_isolation" ON "accounting_settings"
$s57$;
  END IF;
END $g57$;
--> statement-breakpoint
DO $g58$
BEGIN
  IF to_regclass('public."accounting_settings"') IS NOT NULL THEN
    EXECUTE $s58$
CREATE POLICY "tenant_isolation" ON "accounting_settings"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s58$;
  END IF;
END $g58$;
--> statement-breakpoint
DO $g59$
BEGIN
  IF to_regclass('public."accounting_settings"') IS NOT NULL THEN
    EXECUTE $s59$
REVOKE ALL ON "accounting_settings" FROM PUBLIC
$s59$;
  END IF;
END $g59$;
--> statement-breakpoint
DO $g60$
BEGIN
  IF to_regclass('public."accounting_settings"') IS NOT NULL THEN
    EXECUTE $s60$
GRANT SELECT, INSERT, UPDATE, DELETE ON "accounting_settings" TO streamline_app
$s60$;
  END IF;
END $g60$;
--> statement-breakpoint
DO $g61$
BEGIN
  IF to_regclass('public."ap_allocations"') IS NOT NULL THEN
    EXECUTE $s61$
ALTER TABLE "ap_allocations" ENABLE ROW LEVEL SECURITY
$s61$;
  END IF;
END $g61$;
--> statement-breakpoint
DO $g62$
BEGIN
  IF to_regclass('public."ap_allocations"') IS NOT NULL THEN
    EXECUTE $s62$
DROP POLICY IF EXISTS "tenant_isolation" ON "ap_allocations"
$s62$;
  END IF;
END $g62$;
--> statement-breakpoint
DO $g63$
BEGIN
  IF to_regclass('public."ap_allocations"') IS NOT NULL THEN
    EXECUTE $s63$
CREATE POLICY "tenant_isolation" ON "ap_allocations"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s63$;
  END IF;
END $g63$;
--> statement-breakpoint
DO $g64$
BEGIN
  IF to_regclass('public."ap_allocations"') IS NOT NULL THEN
    EXECUTE $s64$
REVOKE ALL ON "ap_allocations" FROM PUBLIC
$s64$;
  END IF;
END $g64$;
--> statement-breakpoint
DO $g65$
BEGIN
  IF to_regclass('public."ap_allocations"') IS NOT NULL THEN
    EXECUTE $s65$
GRANT SELECT, INSERT, UPDATE, DELETE ON "ap_allocations" TO streamline_app
$s65$;
  END IF;
END $g65$;
--> statement-breakpoint
DO $g66$
BEGIN
  IF to_regclass('public."ap_document_lines"') IS NOT NULL THEN
    EXECUTE $s66$
ALTER TABLE "ap_document_lines" ENABLE ROW LEVEL SECURITY
$s66$;
  END IF;
END $g66$;
--> statement-breakpoint
DO $g67$
BEGIN
  IF to_regclass('public."ap_document_lines"') IS NOT NULL THEN
    EXECUTE $s67$
DROP POLICY IF EXISTS "tenant_isolation" ON "ap_document_lines"
$s67$;
  END IF;
END $g67$;
--> statement-breakpoint
DO $g68$
BEGIN
  IF to_regclass('public."ap_document_lines"') IS NOT NULL THEN
    EXECUTE $s68$
CREATE POLICY "tenant_isolation" ON "ap_document_lines"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s68$;
  END IF;
END $g68$;
--> statement-breakpoint
DO $g69$
BEGIN
  IF to_regclass('public."ap_document_lines"') IS NOT NULL THEN
    EXECUTE $s69$
REVOKE ALL ON "ap_document_lines" FROM PUBLIC
$s69$;
  END IF;
END $g69$;
--> statement-breakpoint
DO $g70$
BEGIN
  IF to_regclass('public."ap_document_lines"') IS NOT NULL THEN
    EXECUTE $s70$
GRANT SELECT, INSERT, UPDATE, DELETE ON "ap_document_lines" TO streamline_app
$s70$;
  END IF;
END $g70$;
--> statement-breakpoint
DO $g71$
BEGIN
  IF to_regclass('public."ap_documents"') IS NOT NULL THEN
    EXECUTE $s71$
ALTER TABLE "ap_documents" ENABLE ROW LEVEL SECURITY
$s71$;
  END IF;
END $g71$;
--> statement-breakpoint
DO $g72$
BEGIN
  IF to_regclass('public."ap_documents"') IS NOT NULL THEN
    EXECUTE $s72$
DROP POLICY IF EXISTS "tenant_isolation" ON "ap_documents"
$s72$;
  END IF;
END $g72$;
--> statement-breakpoint
DO $g73$
BEGIN
  IF to_regclass('public."ap_documents"') IS NOT NULL THEN
    EXECUTE $s73$
CREATE POLICY "tenant_isolation" ON "ap_documents"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s73$;
  END IF;
END $g73$;
--> statement-breakpoint
DO $g74$
BEGIN
  IF to_regclass('public."ap_documents"') IS NOT NULL THEN
    EXECUTE $s74$
REVOKE ALL ON "ap_documents" FROM PUBLIC
$s74$;
  END IF;
END $g74$;
--> statement-breakpoint
DO $g75$
BEGIN
  IF to_regclass('public."ap_documents"') IS NOT NULL THEN
    EXECUTE $s75$
GRANT SELECT, INSERT, UPDATE, DELETE ON "ap_documents" TO streamline_app
$s75$;
  END IF;
END $g75$;
--> statement-breakpoint
DO $g76$
BEGIN
  IF to_regclass('public."ap_payments"') IS NOT NULL THEN
    EXECUTE $s76$
ALTER TABLE "ap_payments" ENABLE ROW LEVEL SECURITY
$s76$;
  END IF;
END $g76$;
--> statement-breakpoint
DO $g77$
BEGIN
  IF to_regclass('public."ap_payments"') IS NOT NULL THEN
    EXECUTE $s77$
DROP POLICY IF EXISTS "tenant_isolation" ON "ap_payments"
$s77$;
  END IF;
END $g77$;
--> statement-breakpoint
DO $g78$
BEGIN
  IF to_regclass('public."ap_payments"') IS NOT NULL THEN
    EXECUTE $s78$
CREATE POLICY "tenant_isolation" ON "ap_payments"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s78$;
  END IF;
END $g78$;
--> statement-breakpoint
DO $g79$
BEGIN
  IF to_regclass('public."ap_payments"') IS NOT NULL THEN
    EXECUTE $s79$
REVOKE ALL ON "ap_payments" FROM PUBLIC
$s79$;
  END IF;
END $g79$;
--> statement-breakpoint
DO $g80$
BEGIN
  IF to_regclass('public."ap_payments"') IS NOT NULL THEN
    EXECUTE $s80$
GRANT SELECT, INSERT, UPDATE, DELETE ON "ap_payments" TO streamline_app
$s80$;
  END IF;
END $g80$;
--> statement-breakpoint
DO $g81$
BEGIN
  IF to_regclass('public."ap_withholding"') IS NOT NULL THEN
    EXECUTE $s81$
ALTER TABLE "ap_withholding" ENABLE ROW LEVEL SECURITY
$s81$;
  END IF;
END $g81$;
--> statement-breakpoint
DO $g82$
BEGIN
  IF to_regclass('public."ap_withholding"') IS NOT NULL THEN
    EXECUTE $s82$
DROP POLICY IF EXISTS "tenant_isolation" ON "ap_withholding"
$s82$;
  END IF;
END $g82$;
--> statement-breakpoint
DO $g83$
BEGIN
  IF to_regclass('public."ap_withholding"') IS NOT NULL THEN
    EXECUTE $s83$
CREATE POLICY "tenant_isolation" ON "ap_withholding"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s83$;
  END IF;
END $g83$;
--> statement-breakpoint
DO $g84$
BEGIN
  IF to_regclass('public."ap_withholding"') IS NOT NULL THEN
    EXECUTE $s84$
REVOKE ALL ON "ap_withholding" FROM PUBLIC
$s84$;
  END IF;
END $g84$;
--> statement-breakpoint
DO $g85$
BEGIN
  IF to_regclass('public."ap_withholding"') IS NOT NULL THEN
    EXECUTE $s85$
GRANT SELECT, INSERT, UPDATE, DELETE ON "ap_withholding" TO streamline_app
$s85$;
  END IF;
END $g85$;
--> statement-breakpoint
DO $g86$
BEGIN
  IF to_regclass('public."ar_allocations"') IS NOT NULL THEN
    EXECUTE $s86$
ALTER TABLE "ar_allocations" ENABLE ROW LEVEL SECURITY
$s86$;
  END IF;
END $g86$;
--> statement-breakpoint
DO $g87$
BEGIN
  IF to_regclass('public."ar_allocations"') IS NOT NULL THEN
    EXECUTE $s87$
DROP POLICY IF EXISTS "tenant_isolation" ON "ar_allocations"
$s87$;
  END IF;
END $g87$;
--> statement-breakpoint
DO $g88$
BEGIN
  IF to_regclass('public."ar_allocations"') IS NOT NULL THEN
    EXECUTE $s88$
CREATE POLICY "tenant_isolation" ON "ar_allocations"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s88$;
  END IF;
END $g88$;
--> statement-breakpoint
DO $g89$
BEGIN
  IF to_regclass('public."ar_allocations"') IS NOT NULL THEN
    EXECUTE $s89$
REVOKE ALL ON "ar_allocations" FROM PUBLIC
$s89$;
  END IF;
END $g89$;
--> statement-breakpoint
DO $g90$
BEGIN
  IF to_regclass('public."ar_allocations"') IS NOT NULL THEN
    EXECUTE $s90$
GRANT SELECT, INSERT, UPDATE, DELETE ON "ar_allocations" TO streamline_app
$s90$;
  END IF;
END $g90$;
--> statement-breakpoint
DO $g91$
BEGIN
  IF to_regclass('public."ar_document_lines"') IS NOT NULL THEN
    EXECUTE $s91$
ALTER TABLE "ar_document_lines" ENABLE ROW LEVEL SECURITY
$s91$;
  END IF;
END $g91$;
--> statement-breakpoint
DO $g92$
BEGIN
  IF to_regclass('public."ar_document_lines"') IS NOT NULL THEN
    EXECUTE $s92$
DROP POLICY IF EXISTS "tenant_isolation" ON "ar_document_lines"
$s92$;
  END IF;
END $g92$;
--> statement-breakpoint
DO $g93$
BEGIN
  IF to_regclass('public."ar_document_lines"') IS NOT NULL THEN
    EXECUTE $s93$
CREATE POLICY "tenant_isolation" ON "ar_document_lines"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s93$;
  END IF;
END $g93$;
--> statement-breakpoint
DO $g94$
BEGIN
  IF to_regclass('public."ar_document_lines"') IS NOT NULL THEN
    EXECUTE $s94$
REVOKE ALL ON "ar_document_lines" FROM PUBLIC
$s94$;
  END IF;
END $g94$;
--> statement-breakpoint
DO $g95$
BEGIN
  IF to_regclass('public."ar_document_lines"') IS NOT NULL THEN
    EXECUTE $s95$
GRANT SELECT, INSERT, UPDATE, DELETE ON "ar_document_lines" TO streamline_app
$s95$;
  END IF;
END $g95$;
--> statement-breakpoint
DO $g96$
BEGIN
  IF to_regclass('public."ar_documents"') IS NOT NULL THEN
    EXECUTE $s96$
ALTER TABLE "ar_documents" ENABLE ROW LEVEL SECURITY
$s96$;
  END IF;
END $g96$;
--> statement-breakpoint
DO $g97$
BEGIN
  IF to_regclass('public."ar_documents"') IS NOT NULL THEN
    EXECUTE $s97$
DROP POLICY IF EXISTS "tenant_isolation" ON "ar_documents"
$s97$;
  END IF;
END $g97$;
--> statement-breakpoint
DO $g98$
BEGIN
  IF to_regclass('public."ar_documents"') IS NOT NULL THEN
    EXECUTE $s98$
CREATE POLICY "tenant_isolation" ON "ar_documents"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s98$;
  END IF;
END $g98$;
--> statement-breakpoint
DO $g99$
BEGIN
  IF to_regclass('public."ar_documents"') IS NOT NULL THEN
    EXECUTE $s99$
REVOKE ALL ON "ar_documents" FROM PUBLIC
$s99$;
  END IF;
END $g99$;
--> statement-breakpoint
DO $g100$
BEGIN
  IF to_regclass('public."ar_documents"') IS NOT NULL THEN
    EXECUTE $s100$
GRANT SELECT, INSERT, UPDATE, DELETE ON "ar_documents" TO streamline_app
$s100$;
  END IF;
END $g100$;
--> statement-breakpoint
DO $g101$
BEGIN
  IF to_regclass('public."ar_receipts"') IS NOT NULL THEN
    EXECUTE $s101$
ALTER TABLE "ar_receipts" ENABLE ROW LEVEL SECURITY
$s101$;
  END IF;
END $g101$;
--> statement-breakpoint
DO $g102$
BEGIN
  IF to_regclass('public."ar_receipts"') IS NOT NULL THEN
    EXECUTE $s102$
DROP POLICY IF EXISTS "tenant_isolation" ON "ar_receipts"
$s102$;
  END IF;
END $g102$;
--> statement-breakpoint
DO $g103$
BEGIN
  IF to_regclass('public."ar_receipts"') IS NOT NULL THEN
    EXECUTE $s103$
CREATE POLICY "tenant_isolation" ON "ar_receipts"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s103$;
  END IF;
END $g103$;
--> statement-breakpoint
DO $g104$
BEGIN
  IF to_regclass('public."ar_receipts"') IS NOT NULL THEN
    EXECUTE $s104$
REVOKE ALL ON "ar_receipts" FROM PUBLIC
$s104$;
  END IF;
END $g104$;
--> statement-breakpoint
DO $g105$
BEGIN
  IF to_regclass('public."ar_receipts"') IS NOT NULL THEN
    EXECUTE $s105$
GRANT SELECT, INSERT, UPDATE, DELETE ON "ar_receipts" TO streamline_app
$s105$;
  END IF;
END $g105$;
--> statement-breakpoint
DO $g106$
BEGIN
  IF to_regclass('public."bank_matches"') IS NOT NULL THEN
    EXECUTE $s106$
ALTER TABLE "bank_matches" ENABLE ROW LEVEL SECURITY
$s106$;
  END IF;
END $g106$;
--> statement-breakpoint
DO $g107$
BEGIN
  IF to_regclass('public."bank_matches"') IS NOT NULL THEN
    EXECUTE $s107$
DROP POLICY IF EXISTS "tenant_isolation" ON "bank_matches"
$s107$;
  END IF;
END $g107$;
--> statement-breakpoint
DO $g108$
BEGIN
  IF to_regclass('public."bank_matches"') IS NOT NULL THEN
    EXECUTE $s108$
CREATE POLICY "tenant_isolation" ON "bank_matches"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s108$;
  END IF;
END $g108$;
--> statement-breakpoint
DO $g109$
BEGIN
  IF to_regclass('public."bank_matches"') IS NOT NULL THEN
    EXECUTE $s109$
REVOKE ALL ON "bank_matches" FROM PUBLIC
$s109$;
  END IF;
END $g109$;
--> statement-breakpoint
DO $g110$
BEGIN
  IF to_regclass('public."bank_matches"') IS NOT NULL THEN
    EXECUTE $s110$
GRANT SELECT, INSERT, UPDATE, DELETE ON "bank_matches" TO streamline_app
$s110$;
  END IF;
END $g110$;
--> statement-breakpoint
DO $g111$
BEGIN
  IF to_regclass('public."bank_profiles"') IS NOT NULL THEN
    EXECUTE $s111$
ALTER TABLE "bank_profiles" ENABLE ROW LEVEL SECURITY
$s111$;
  END IF;
END $g111$;
--> statement-breakpoint
DO $g112$
BEGIN
  IF to_regclass('public."bank_profiles"') IS NOT NULL THEN
    EXECUTE $s112$
DROP POLICY IF EXISTS "tenant_isolation" ON "bank_profiles"
$s112$;
  END IF;
END $g112$;
--> statement-breakpoint
DO $g113$
BEGIN
  IF to_regclass('public."bank_profiles"') IS NOT NULL THEN
    EXECUTE $s113$
CREATE POLICY "tenant_isolation" ON "bank_profiles"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s113$;
  END IF;
END $g113$;
--> statement-breakpoint
DO $g114$
BEGIN
  IF to_regclass('public."bank_profiles"') IS NOT NULL THEN
    EXECUTE $s114$
REVOKE ALL ON "bank_profiles" FROM PUBLIC
$s114$;
  END IF;
END $g114$;
--> statement-breakpoint
DO $g115$
BEGIN
  IF to_regclass('public."bank_profiles"') IS NOT NULL THEN
    EXECUTE $s115$
GRANT SELECT, INSERT, UPDATE, DELETE ON "bank_profiles" TO streamline_app
$s115$;
  END IF;
END $g115$;
--> statement-breakpoint
DO $g116$
BEGIN
  IF to_regclass('public."bank_statement_lines"') IS NOT NULL THEN
    EXECUTE $s116$
ALTER TABLE "bank_statement_lines" ENABLE ROW LEVEL SECURITY
$s116$;
  END IF;
END $g116$;
--> statement-breakpoint
DO $g117$
BEGIN
  IF to_regclass('public."bank_statement_lines"') IS NOT NULL THEN
    EXECUTE $s117$
DROP POLICY IF EXISTS "tenant_isolation" ON "bank_statement_lines"
$s117$;
  END IF;
END $g117$;
--> statement-breakpoint
DO $g118$
BEGIN
  IF to_regclass('public."bank_statement_lines"') IS NOT NULL THEN
    EXECUTE $s118$
CREATE POLICY "tenant_isolation" ON "bank_statement_lines"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s118$;
  END IF;
END $g118$;
--> statement-breakpoint
DO $g119$
BEGIN
  IF to_regclass('public."bank_statement_lines"') IS NOT NULL THEN
    EXECUTE $s119$
REVOKE ALL ON "bank_statement_lines" FROM PUBLIC
$s119$;
  END IF;
END $g119$;
--> statement-breakpoint
DO $g120$
BEGIN
  IF to_regclass('public."bank_statement_lines"') IS NOT NULL THEN
    EXECUTE $s120$
GRANT SELECT, INSERT, UPDATE, DELETE ON "bank_statement_lines" TO streamline_app
$s120$;
  END IF;
END $g120$;
--> statement-breakpoint
DO $g121$
BEGIN
  IF to_regclass('public."bank_statements"') IS NOT NULL THEN
    EXECUTE $s121$
ALTER TABLE "bank_statements" ENABLE ROW LEVEL SECURITY
$s121$;
  END IF;
END $g121$;
--> statement-breakpoint
DO $g122$
BEGIN
  IF to_regclass('public."bank_statements"') IS NOT NULL THEN
    EXECUTE $s122$
DROP POLICY IF EXISTS "tenant_isolation" ON "bank_statements"
$s122$;
  END IF;
END $g122$;
--> statement-breakpoint
DO $g123$
BEGIN
  IF to_regclass('public."bank_statements"') IS NOT NULL THEN
    EXECUTE $s123$
CREATE POLICY "tenant_isolation" ON "bank_statements"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s123$;
  END IF;
END $g123$;
--> statement-breakpoint
DO $g124$
BEGIN
  IF to_regclass('public."bank_statements"') IS NOT NULL THEN
    EXECUTE $s124$
REVOKE ALL ON "bank_statements" FROM PUBLIC
$s124$;
  END IF;
END $g124$;
--> statement-breakpoint
DO $g125$
BEGIN
  IF to_regclass('public."bank_statements"') IS NOT NULL THEN
    EXECUTE $s125$
GRANT SELECT, INSERT, UPDATE, DELETE ON "bank_statements" TO streamline_app
$s125$;
  END IF;
END $g125$;
--> statement-breakpoint
DO $g126$
BEGIN
  IF to_regclass('public."clients"') IS NOT NULL THEN
    EXECUTE $s126$
ALTER TABLE "clients" ENABLE ROW LEVEL SECURITY
$s126$;
  END IF;
END $g126$;
--> statement-breakpoint
DO $g127$
BEGIN
  IF to_regclass('public."clients"') IS NOT NULL THEN
    EXECUTE $s127$
DROP POLICY IF EXISTS "tenant_isolation" ON "clients"
$s127$;
  END IF;
END $g127$;
--> statement-breakpoint
DO $g128$
BEGIN
  IF to_regclass('public."clients"') IS NOT NULL THEN
    EXECUTE $s128$
CREATE POLICY "tenant_isolation" ON "clients"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s128$;
  END IF;
END $g128$;
--> statement-breakpoint
DO $g129$
BEGIN
  IF to_regclass('public."clients"') IS NOT NULL THEN
    EXECUTE $s129$
REVOKE ALL ON "clients" FROM PUBLIC
$s129$;
  END IF;
END $g129$;
--> statement-breakpoint
DO $g130$
BEGIN
  IF to_regclass('public."clients"') IS NOT NULL THEN
    EXECUTE $s130$
GRANT SELECT, INSERT, UPDATE, DELETE ON "clients" TO streamline_app
$s130$;
  END IF;
END $g130$;
--> statement-breakpoint
DO $g131$
BEGIN
  IF to_regclass('public."contacts"') IS NOT NULL THEN
    EXECUTE $s131$
ALTER TABLE "contacts" ENABLE ROW LEVEL SECURITY
$s131$;
  END IF;
END $g131$;
--> statement-breakpoint
DO $g132$
BEGIN
  IF to_regclass('public."contacts"') IS NOT NULL THEN
    EXECUTE $s132$
DROP POLICY IF EXISTS "tenant_isolation" ON "contacts"
$s132$;
  END IF;
END $g132$;
--> statement-breakpoint
DO $g133$
BEGIN
  IF to_regclass('public."contacts"') IS NOT NULL THEN
    EXECUTE $s133$
CREATE POLICY "tenant_isolation" ON "contacts"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s133$;
  END IF;
END $g133$;
--> statement-breakpoint
DO $g134$
BEGIN
  IF to_regclass('public."contacts"') IS NOT NULL THEN
    EXECUTE $s134$
REVOKE ALL ON "contacts" FROM PUBLIC
$s134$;
  END IF;
END $g134$;
--> statement-breakpoint
DO $g135$
BEGIN
  IF to_regclass('public."contacts"') IS NOT NULL THEN
    EXECUTE $s135$
GRANT SELECT, INSERT, UPDATE, DELETE ON "contacts" TO streamline_app
$s135$;
  END IF;
END $g135$;
--> statement-breakpoint
DO $g136$
BEGIN
  IF to_regclass('public."credit_notes"') IS NOT NULL THEN
    EXECUTE $s136$
ALTER TABLE "credit_notes" ENABLE ROW LEVEL SECURITY
$s136$;
  END IF;
END $g136$;
--> statement-breakpoint
DO $g137$
BEGIN
  IF to_regclass('public."credit_notes"') IS NOT NULL THEN
    EXECUTE $s137$
DROP POLICY IF EXISTS "tenant_isolation" ON "credit_notes"
$s137$;
  END IF;
END $g137$;
--> statement-breakpoint
DO $g138$
BEGIN
  IF to_regclass('public."credit_notes"') IS NOT NULL THEN
    EXECUTE $s138$
CREATE POLICY "tenant_isolation" ON "credit_notes"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s138$;
  END IF;
END $g138$;
--> statement-breakpoint
DO $g139$
BEGIN
  IF to_regclass('public."credit_notes"') IS NOT NULL THEN
    EXECUTE $s139$
REVOKE ALL ON "credit_notes" FROM PUBLIC
$s139$;
  END IF;
END $g139$;
--> statement-breakpoint
DO $g140$
BEGIN
  IF to_regclass('public."credit_notes"') IS NOT NULL THEN
    EXECUTE $s140$
GRANT SELECT, INSERT, UPDATE, DELETE ON "credit_notes" TO streamline_app
$s140$;
  END IF;
END $g140$;
--> statement-breakpoint
DO $g141$
BEGIN
  IF to_regclass('public."crm_organizations"') IS NOT NULL THEN
    EXECUTE $s141$
ALTER TABLE "crm_organizations" ENABLE ROW LEVEL SECURITY
$s141$;
  END IF;
END $g141$;
--> statement-breakpoint
DO $g142$
BEGIN
  IF to_regclass('public."crm_organizations"') IS NOT NULL THEN
    EXECUTE $s142$
DROP POLICY IF EXISTS "tenant_isolation" ON "crm_organizations"
$s142$;
  END IF;
END $g142$;
--> statement-breakpoint
DO $g143$
BEGIN
  IF to_regclass('public."crm_organizations"') IS NOT NULL THEN
    EXECUTE $s143$
CREATE POLICY "tenant_isolation" ON "crm_organizations"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s143$;
  END IF;
END $g143$;
--> statement-breakpoint
DO $g144$
BEGIN
  IF to_regclass('public."crm_organizations"') IS NOT NULL THEN
    EXECUTE $s144$
REVOKE ALL ON "crm_organizations" FROM PUBLIC
$s144$;
  END IF;
END $g144$;
--> statement-breakpoint
DO $g145$
BEGIN
  IF to_regclass('public."crm_organizations"') IS NOT NULL THEN
    EXECUTE $s145$
GRANT SELECT, INSERT, UPDATE, DELETE ON "crm_organizations" TO streamline_app
$s145$;
  END IF;
END $g145$;
--> statement-breakpoint
DO $g146$
BEGIN
  IF to_regclass('public."fin_approval_policies"') IS NOT NULL THEN
    EXECUTE $s146$
ALTER TABLE "fin_approval_policies" ENABLE ROW LEVEL SECURITY
$s146$;
  END IF;
END $g146$;
--> statement-breakpoint
DO $g147$
BEGIN
  IF to_regclass('public."fin_approval_policies"') IS NOT NULL THEN
    EXECUTE $s147$
DROP POLICY IF EXISTS "tenant_isolation" ON "fin_approval_policies"
$s147$;
  END IF;
END $g147$;
--> statement-breakpoint
DO $g148$
BEGIN
  IF to_regclass('public."fin_approval_policies"') IS NOT NULL THEN
    EXECUTE $s148$
CREATE POLICY "tenant_isolation" ON "fin_approval_policies"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s148$;
  END IF;
END $g148$;
--> statement-breakpoint
DO $g149$
BEGIN
  IF to_regclass('public."fin_approval_policies"') IS NOT NULL THEN
    EXECUTE $s149$
REVOKE ALL ON "fin_approval_policies" FROM PUBLIC
$s149$;
  END IF;
END $g149$;
--> statement-breakpoint
DO $g150$
BEGIN
  IF to_regclass('public."fin_approval_policies"') IS NOT NULL THEN
    EXECUTE $s150$
GRANT SELECT, INSERT, UPDATE, DELETE ON "fin_approval_policies" TO streamline_app
$s150$;
  END IF;
END $g150$;
--> statement-breakpoint
DO $g151$
BEGIN
  IF to_regclass('public."fin_approval_requests"') IS NOT NULL THEN
    EXECUTE $s151$
ALTER TABLE "fin_approval_requests" ENABLE ROW LEVEL SECURITY
$s151$;
  END IF;
END $g151$;
--> statement-breakpoint
DO $g152$
BEGIN
  IF to_regclass('public."fin_approval_requests"') IS NOT NULL THEN
    EXECUTE $s152$
DROP POLICY IF EXISTS "tenant_isolation" ON "fin_approval_requests"
$s152$;
  END IF;
END $g152$;
--> statement-breakpoint
DO $g153$
BEGIN
  IF to_regclass('public."fin_approval_requests"') IS NOT NULL THEN
    EXECUTE $s153$
CREATE POLICY "tenant_isolation" ON "fin_approval_requests"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s153$;
  END IF;
END $g153$;
--> statement-breakpoint
DO $g154$
BEGIN
  IF to_regclass('public."fin_approval_requests"') IS NOT NULL THEN
    EXECUTE $s154$
REVOKE ALL ON "fin_approval_requests" FROM PUBLIC
$s154$;
  END IF;
END $g154$;
--> statement-breakpoint
DO $g155$
BEGIN
  IF to_regclass('public."fin_approval_requests"') IS NOT NULL THEN
    EXECUTE $s155$
GRANT SELECT, INSERT, UPDATE, DELETE ON "fin_approval_requests" TO streamline_app
$s155$;
  END IF;
END $g155$;
--> statement-breakpoint
DO $g156$
BEGIN
  IF to_regclass('public."fin_bank_accounts"') IS NOT NULL THEN
    EXECUTE $s156$
ALTER TABLE "fin_bank_accounts" ENABLE ROW LEVEL SECURITY
$s156$;
  END IF;
END $g156$;
--> statement-breakpoint
DO $g157$
BEGIN
  IF to_regclass('public."fin_bank_accounts"') IS NOT NULL THEN
    EXECUTE $s157$
DROP POLICY IF EXISTS "tenant_isolation" ON "fin_bank_accounts"
$s157$;
  END IF;
END $g157$;
--> statement-breakpoint
DO $g158$
BEGIN
  IF to_regclass('public."fin_bank_accounts"') IS NOT NULL THEN
    EXECUTE $s158$
CREATE POLICY "tenant_isolation" ON "fin_bank_accounts"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s158$;
  END IF;
END $g158$;
--> statement-breakpoint
DO $g159$
BEGIN
  IF to_regclass('public."fin_bank_accounts"') IS NOT NULL THEN
    EXECUTE $s159$
REVOKE ALL ON "fin_bank_accounts" FROM PUBLIC
$s159$;
  END IF;
END $g159$;
--> statement-breakpoint
DO $g160$
BEGIN
  IF to_regclass('public."fin_bank_accounts"') IS NOT NULL THEN
    EXECUTE $s160$
GRANT SELECT, INSERT, UPDATE, DELETE ON "fin_bank_accounts" TO streamline_app
$s160$;
  END IF;
END $g160$;
--> statement-breakpoint
DO $g161$
BEGIN
  IF to_regclass('public."fin_bank_imports"') IS NOT NULL THEN
    EXECUTE $s161$
ALTER TABLE "fin_bank_imports" ENABLE ROW LEVEL SECURITY
$s161$;
  END IF;
END $g161$;
--> statement-breakpoint
DO $g162$
BEGIN
  IF to_regclass('public."fin_bank_imports"') IS NOT NULL THEN
    EXECUTE $s162$
DROP POLICY IF EXISTS "tenant_isolation" ON "fin_bank_imports"
$s162$;
  END IF;
END $g162$;
--> statement-breakpoint
DO $g163$
BEGIN
  IF to_regclass('public."fin_bank_imports"') IS NOT NULL THEN
    EXECUTE $s163$
CREATE POLICY "tenant_isolation" ON "fin_bank_imports"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s163$;
  END IF;
END $g163$;
--> statement-breakpoint
DO $g164$
BEGIN
  IF to_regclass('public."fin_bank_imports"') IS NOT NULL THEN
    EXECUTE $s164$
REVOKE ALL ON "fin_bank_imports" FROM PUBLIC
$s164$;
  END IF;
END $g164$;
--> statement-breakpoint
DO $g165$
BEGIN
  IF to_regclass('public."fin_bank_imports"') IS NOT NULL THEN
    EXECUTE $s165$
GRANT SELECT, INSERT, UPDATE, DELETE ON "fin_bank_imports" TO streamline_app
$s165$;
  END IF;
END $g165$;
--> statement-breakpoint
DO $g166$
BEGIN
  IF to_regclass('public."fin_bank_transactions"') IS NOT NULL THEN
    EXECUTE $s166$
ALTER TABLE "fin_bank_transactions" ENABLE ROW LEVEL SECURITY
$s166$;
  END IF;
END $g166$;
--> statement-breakpoint
DO $g167$
BEGIN
  IF to_regclass('public."fin_bank_transactions"') IS NOT NULL THEN
    EXECUTE $s167$
DROP POLICY IF EXISTS "tenant_isolation" ON "fin_bank_transactions"
$s167$;
  END IF;
END $g167$;
--> statement-breakpoint
DO $g168$
BEGIN
  IF to_regclass('public."fin_bank_transactions"') IS NOT NULL THEN
    EXECUTE $s168$
CREATE POLICY "tenant_isolation" ON "fin_bank_transactions"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s168$;
  END IF;
END $g168$;
--> statement-breakpoint
DO $g169$
BEGIN
  IF to_regclass('public."fin_bank_transactions"') IS NOT NULL THEN
    EXECUTE $s169$
REVOKE ALL ON "fin_bank_transactions" FROM PUBLIC
$s169$;
  END IF;
END $g169$;
--> statement-breakpoint
DO $g170$
BEGIN
  IF to_regclass('public."fin_bank_transactions"') IS NOT NULL THEN
    EXECUTE $s170$
GRANT SELECT, INSERT, UPDATE, DELETE ON "fin_bank_transactions" TO streamline_app
$s170$;
  END IF;
END $g170$;
--> statement-breakpoint
DO $g171$
BEGIN
  IF to_regclass('public."fin_bank_transfers"') IS NOT NULL THEN
    EXECUTE $s171$
ALTER TABLE "fin_bank_transfers" ENABLE ROW LEVEL SECURITY
$s171$;
  END IF;
END $g171$;
--> statement-breakpoint
DO $g172$
BEGIN
  IF to_regclass('public."fin_bank_transfers"') IS NOT NULL THEN
    EXECUTE $s172$
DROP POLICY IF EXISTS "tenant_isolation" ON "fin_bank_transfers"
$s172$;
  END IF;
END $g172$;
--> statement-breakpoint
DO $g173$
BEGIN
  IF to_regclass('public."fin_bank_transfers"') IS NOT NULL THEN
    EXECUTE $s173$
CREATE POLICY "tenant_isolation" ON "fin_bank_transfers"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s173$;
  END IF;
END $g173$;
--> statement-breakpoint
DO $g174$
BEGIN
  IF to_regclass('public."fin_bank_transfers"') IS NOT NULL THEN
    EXECUTE $s174$
REVOKE ALL ON "fin_bank_transfers" FROM PUBLIC
$s174$;
  END IF;
END $g174$;
--> statement-breakpoint
DO $g175$
BEGIN
  IF to_regclass('public."fin_bank_transfers"') IS NOT NULL THEN
    EXECUTE $s175$
GRANT SELECT, INSERT, UPDATE, DELETE ON "fin_bank_transfers" TO streamline_app
$s175$;
  END IF;
END $g175$;
--> statement-breakpoint
DO $g176$
BEGIN
  IF to_regclass('public."fin_budget_lines"') IS NOT NULL THEN
    EXECUTE $s176$
ALTER TABLE "fin_budget_lines" ENABLE ROW LEVEL SECURITY
$s176$;
  END IF;
END $g176$;
--> statement-breakpoint
DO $g177$
BEGIN
  IF to_regclass('public."fin_budget_lines"') IS NOT NULL THEN
    EXECUTE $s177$
DROP POLICY IF EXISTS "tenant_isolation" ON "fin_budget_lines"
$s177$;
  END IF;
END $g177$;
--> statement-breakpoint
DO $g178$
BEGIN
  IF to_regclass('public."fin_budget_lines"') IS NOT NULL THEN
    EXECUTE $s178$
CREATE POLICY "tenant_isolation" ON "fin_budget_lines"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s178$;
  END IF;
END $g178$;
--> statement-breakpoint
DO $g179$
BEGIN
  IF to_regclass('public."fin_budget_lines"') IS NOT NULL THEN
    EXECUTE $s179$
REVOKE ALL ON "fin_budget_lines" FROM PUBLIC
$s179$;
  END IF;
END $g179$;
--> statement-breakpoint
DO $g180$
BEGIN
  IF to_regclass('public."fin_budget_lines"') IS NOT NULL THEN
    EXECUTE $s180$
GRANT SELECT, INSERT, UPDATE, DELETE ON "fin_budget_lines" TO streamline_app
$s180$;
  END IF;
END $g180$;
--> statement-breakpoint
DO $g181$
BEGIN
  IF to_regclass('public."fin_budget_revisions"') IS NOT NULL THEN
    EXECUTE $s181$
ALTER TABLE "fin_budget_revisions" ENABLE ROW LEVEL SECURITY
$s181$;
  END IF;
END $g181$;
--> statement-breakpoint
DO $g182$
BEGIN
  IF to_regclass('public."fin_budget_revisions"') IS NOT NULL THEN
    EXECUTE $s182$
DROP POLICY IF EXISTS "tenant_isolation" ON "fin_budget_revisions"
$s182$;
  END IF;
END $g182$;
--> statement-breakpoint
DO $g183$
BEGIN
  IF to_regclass('public."fin_budget_revisions"') IS NOT NULL THEN
    EXECUTE $s183$
CREATE POLICY "tenant_isolation" ON "fin_budget_revisions"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s183$;
  END IF;
END $g183$;
--> statement-breakpoint
DO $g184$
BEGIN
  IF to_regclass('public."fin_budget_revisions"') IS NOT NULL THEN
    EXECUTE $s184$
REVOKE ALL ON "fin_budget_revisions" FROM PUBLIC
$s184$;
  END IF;
END $g184$;
--> statement-breakpoint
DO $g185$
BEGIN
  IF to_regclass('public."fin_budget_revisions"') IS NOT NULL THEN
    EXECUTE $s185$
GRANT SELECT, INSERT, UPDATE, DELETE ON "fin_budget_revisions" TO streamline_app
$s185$;
  END IF;
END $g185$;
--> statement-breakpoint
DO $g186$
BEGIN
  IF to_regclass('public."fin_budgets"') IS NOT NULL THEN
    EXECUTE $s186$
ALTER TABLE "fin_budgets" ENABLE ROW LEVEL SECURITY
$s186$;
  END IF;
END $g186$;
--> statement-breakpoint
DO $g187$
BEGIN
  IF to_regclass('public."fin_budgets"') IS NOT NULL THEN
    EXECUTE $s187$
DROP POLICY IF EXISTS "tenant_isolation" ON "fin_budgets"
$s187$;
  END IF;
END $g187$;
--> statement-breakpoint
DO $g188$
BEGIN
  IF to_regclass('public."fin_budgets"') IS NOT NULL THEN
    EXECUTE $s188$
CREATE POLICY "tenant_isolation" ON "fin_budgets"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s188$;
  END IF;
END $g188$;
--> statement-breakpoint
DO $g189$
BEGIN
  IF to_regclass('public."fin_budgets"') IS NOT NULL THEN
    EXECUTE $s189$
REVOKE ALL ON "fin_budgets" FROM PUBLIC
$s189$;
  END IF;
END $g189$;
--> statement-breakpoint
DO $g190$
BEGIN
  IF to_regclass('public."fin_budgets"') IS NOT NULL THEN
    EXECUTE $s190$
GRANT SELECT, INSERT, UPDATE, DELETE ON "fin_budgets" TO streamline_app
$s190$;
  END IF;
END $g190$;
--> statement-breakpoint
DO $g191$
BEGIN
  IF to_regclass('public."fin_cash_flow_scenarios"') IS NOT NULL THEN
    EXECUTE $s191$
ALTER TABLE "fin_cash_flow_scenarios" ENABLE ROW LEVEL SECURITY
$s191$;
  END IF;
END $g191$;
--> statement-breakpoint
DO $g192$
BEGIN
  IF to_regclass('public."fin_cash_flow_scenarios"') IS NOT NULL THEN
    EXECUTE $s192$
DROP POLICY IF EXISTS "tenant_isolation" ON "fin_cash_flow_scenarios"
$s192$;
  END IF;
END $g192$;
--> statement-breakpoint
DO $g193$
BEGIN
  IF to_regclass('public."fin_cash_flow_scenarios"') IS NOT NULL THEN
    EXECUTE $s193$
CREATE POLICY "tenant_isolation" ON "fin_cash_flow_scenarios"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s193$;
  END IF;
END $g193$;
--> statement-breakpoint
DO $g194$
BEGIN
  IF to_regclass('public."fin_cash_flow_scenarios"') IS NOT NULL THEN
    EXECUTE $s194$
REVOKE ALL ON "fin_cash_flow_scenarios" FROM PUBLIC
$s194$;
  END IF;
END $g194$;
--> statement-breakpoint
DO $g195$
BEGIN
  IF to_regclass('public."fin_cash_flow_scenarios"') IS NOT NULL THEN
    EXECUTE $s195$
GRANT SELECT, INSERT, UPDATE, DELETE ON "fin_cash_flow_scenarios" TO streamline_app
$s195$;
  END IF;
END $g195$;
--> statement-breakpoint
DO $g196$
BEGIN
  IF to_regclass('public."fin_collection_activities"') IS NOT NULL THEN
    EXECUTE $s196$
ALTER TABLE "fin_collection_activities" ENABLE ROW LEVEL SECURITY
$s196$;
  END IF;
END $g196$;
--> statement-breakpoint
DO $g197$
BEGIN
  IF to_regclass('public."fin_collection_activities"') IS NOT NULL THEN
    EXECUTE $s197$
DROP POLICY IF EXISTS "tenant_isolation" ON "fin_collection_activities"
$s197$;
  END IF;
END $g197$;
--> statement-breakpoint
DO $g198$
BEGIN
  IF to_regclass('public."fin_collection_activities"') IS NOT NULL THEN
    EXECUTE $s198$
CREATE POLICY "tenant_isolation" ON "fin_collection_activities"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s198$;
  END IF;
END $g198$;
--> statement-breakpoint
DO $g199$
BEGIN
  IF to_regclass('public."fin_collection_activities"') IS NOT NULL THEN
    EXECUTE $s199$
REVOKE ALL ON "fin_collection_activities" FROM PUBLIC
$s199$;
  END IF;
END $g199$;
--> statement-breakpoint
DO $g200$
BEGIN
  IF to_regclass('public."fin_collection_activities"') IS NOT NULL THEN
    EXECUTE $s200$
GRANT SELECT, INSERT, UPDATE, DELETE ON "fin_collection_activities" TO streamline_app
$s200$;
  END IF;
END $g200$;
--> statement-breakpoint
DO $g201$
BEGIN
  IF to_regclass('public."fin_exchange_rates"') IS NOT NULL THEN
    EXECUTE $s201$
ALTER TABLE "fin_exchange_rates" ENABLE ROW LEVEL SECURITY
$s201$;
  END IF;
END $g201$;
--> statement-breakpoint
DO $g202$
BEGIN
  IF to_regclass('public."fin_exchange_rates"') IS NOT NULL THEN
    EXECUTE $s202$
DROP POLICY IF EXISTS "tenant_isolation" ON "fin_exchange_rates"
$s202$;
  END IF;
END $g202$;
--> statement-breakpoint
DO $g203$
BEGIN
  IF to_regclass('public."fin_exchange_rates"') IS NOT NULL THEN
    EXECUTE $s203$
CREATE POLICY "tenant_isolation" ON "fin_exchange_rates"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s203$;
  END IF;
END $g203$;
--> statement-breakpoint
DO $g204$
BEGIN
  IF to_regclass('public."fin_exchange_rates"') IS NOT NULL THEN
    EXECUTE $s204$
REVOKE ALL ON "fin_exchange_rates" FROM PUBLIC
$s204$;
  END IF;
END $g204$;
--> statement-breakpoint
DO $g205$
BEGIN
  IF to_regclass('public."fin_exchange_rates"') IS NOT NULL THEN
    EXECUTE $s205$
GRANT SELECT, INSERT, UPDATE, DELETE ON "fin_exchange_rates" TO streamline_app
$s205$;
  END IF;
END $g205$;
--> statement-breakpoint
DO $g206$
BEGIN
  IF to_regclass('public."fin_expense_policies"') IS NOT NULL THEN
    EXECUTE $s206$
ALTER TABLE "fin_expense_policies" ENABLE ROW LEVEL SECURITY
$s206$;
  END IF;
END $g206$;
--> statement-breakpoint
DO $g207$
BEGIN
  IF to_regclass('public."fin_expense_policies"') IS NOT NULL THEN
    EXECUTE $s207$
DROP POLICY IF EXISTS "tenant_isolation" ON "fin_expense_policies"
$s207$;
  END IF;
END $g207$;
--> statement-breakpoint
DO $g208$
BEGIN
  IF to_regclass('public."fin_expense_policies"') IS NOT NULL THEN
    EXECUTE $s208$
CREATE POLICY "tenant_isolation" ON "fin_expense_policies"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s208$;
  END IF;
END $g208$;
--> statement-breakpoint
DO $g209$
BEGIN
  IF to_regclass('public."fin_expense_policies"') IS NOT NULL THEN
    EXECUTE $s209$
REVOKE ALL ON "fin_expense_policies" FROM PUBLIC
$s209$;
  END IF;
END $g209$;
--> statement-breakpoint
DO $g210$
BEGIN
  IF to_regclass('public."fin_expense_policies"') IS NOT NULL THEN
    EXECUTE $s210$
GRANT SELECT, INSERT, UPDATE, DELETE ON "fin_expense_policies" TO streamline_app
$s210$;
  END IF;
END $g210$;
--> statement-breakpoint
DO $g211$
BEGIN
  IF to_regclass('public."fin_payment_allocations"') IS NOT NULL THEN
    EXECUTE $s211$
ALTER TABLE "fin_payment_allocations" ENABLE ROW LEVEL SECURITY
$s211$;
  END IF;
END $g211$;
--> statement-breakpoint
DO $g212$
BEGIN
  IF to_regclass('public."fin_payment_allocations"') IS NOT NULL THEN
    EXECUTE $s212$
DROP POLICY IF EXISTS "tenant_isolation" ON "fin_payment_allocations"
$s212$;
  END IF;
END $g212$;
--> statement-breakpoint
DO $g213$
BEGIN
  IF to_regclass('public."fin_payment_allocations"') IS NOT NULL THEN
    EXECUTE $s213$
CREATE POLICY "tenant_isolation" ON "fin_payment_allocations"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s213$;
  END IF;
END $g213$;
--> statement-breakpoint
DO $g214$
BEGIN
  IF to_regclass('public."fin_payment_allocations"') IS NOT NULL THEN
    EXECUTE $s214$
REVOKE ALL ON "fin_payment_allocations" FROM PUBLIC
$s214$;
  END IF;
END $g214$;
--> statement-breakpoint
DO $g215$
BEGIN
  IF to_regclass('public."fin_payment_allocations"') IS NOT NULL THEN
    EXECUTE $s215$
GRANT SELECT, INSERT, UPDATE, DELETE ON "fin_payment_allocations" TO streamline_app
$s215$;
  END IF;
END $g215$;
--> statement-breakpoint
DO $g216$
BEGIN
  IF to_regclass('public."fin_payment_runs"') IS NOT NULL THEN
    EXECUTE $s216$
ALTER TABLE "fin_payment_runs" ENABLE ROW LEVEL SECURITY
$s216$;
  END IF;
END $g216$;
--> statement-breakpoint
DO $g217$
BEGIN
  IF to_regclass('public."fin_payment_runs"') IS NOT NULL THEN
    EXECUTE $s217$
DROP POLICY IF EXISTS "tenant_isolation" ON "fin_payment_runs"
$s217$;
  END IF;
END $g217$;
--> statement-breakpoint
DO $g218$
BEGIN
  IF to_regclass('public."fin_payment_runs"') IS NOT NULL THEN
    EXECUTE $s218$
CREATE POLICY "tenant_isolation" ON "fin_payment_runs"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s218$;
  END IF;
END $g218$;
--> statement-breakpoint
DO $g219$
BEGIN
  IF to_regclass('public."fin_payment_runs"') IS NOT NULL THEN
    EXECUTE $s219$
REVOKE ALL ON "fin_payment_runs" FROM PUBLIC
$s219$;
  END IF;
END $g219$;
--> statement-breakpoint
DO $g220$
BEGIN
  IF to_regclass('public."fin_payment_runs"') IS NOT NULL THEN
    EXECUTE $s220$
GRANT SELECT, INSERT, UPDATE, DELETE ON "fin_payment_runs" TO streamline_app
$s220$;
  END IF;
END $g220$;
--> statement-breakpoint
DO $g221$
BEGIN
  IF to_regclass('public."fin_reconciliation_matches"') IS NOT NULL THEN
    EXECUTE $s221$
ALTER TABLE "fin_reconciliation_matches" ENABLE ROW LEVEL SECURITY
$s221$;
  END IF;
END $g221$;
--> statement-breakpoint
DO $g222$
BEGIN
  IF to_regclass('public."fin_reconciliation_matches"') IS NOT NULL THEN
    EXECUTE $s222$
DROP POLICY IF EXISTS "tenant_isolation" ON "fin_reconciliation_matches"
$s222$;
  END IF;
END $g222$;
--> statement-breakpoint
DO $g223$
BEGIN
  IF to_regclass('public."fin_reconciliation_matches"') IS NOT NULL THEN
    EXECUTE $s223$
CREATE POLICY "tenant_isolation" ON "fin_reconciliation_matches"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s223$;
  END IF;
END $g223$;
--> statement-breakpoint
DO $g224$
BEGIN
  IF to_regclass('public."fin_reconciliation_matches"') IS NOT NULL THEN
    EXECUTE $s224$
REVOKE ALL ON "fin_reconciliation_matches" FROM PUBLIC
$s224$;
  END IF;
END $g224$;
--> statement-breakpoint
DO $g225$
BEGIN
  IF to_regclass('public."fin_reconciliation_matches"') IS NOT NULL THEN
    EXECUTE $s225$
GRANT SELECT, INSERT, UPDATE, DELETE ON "fin_reconciliation_matches" TO streamline_app
$s225$;
  END IF;
END $g225$;
--> statement-breakpoint
DO $g226$
BEGIN
  IF to_regclass('public."fin_reconciliation_rules"') IS NOT NULL THEN
    EXECUTE $s226$
ALTER TABLE "fin_reconciliation_rules" ENABLE ROW LEVEL SECURITY
$s226$;
  END IF;
END $g226$;
--> statement-breakpoint
DO $g227$
BEGIN
  IF to_regclass('public."fin_reconciliation_rules"') IS NOT NULL THEN
    EXECUTE $s227$
DROP POLICY IF EXISTS "tenant_isolation" ON "fin_reconciliation_rules"
$s227$;
  END IF;
END $g227$;
--> statement-breakpoint
DO $g228$
BEGIN
  IF to_regclass('public."fin_reconciliation_rules"') IS NOT NULL THEN
    EXECUTE $s228$
CREATE POLICY "tenant_isolation" ON "fin_reconciliation_rules"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s228$;
  END IF;
END $g228$;
--> statement-breakpoint
DO $g229$
BEGIN
  IF to_regclass('public."fin_reconciliation_rules"') IS NOT NULL THEN
    EXECUTE $s229$
REVOKE ALL ON "fin_reconciliation_rules" FROM PUBLIC
$s229$;
  END IF;
END $g229$;
--> statement-breakpoint
DO $g230$
BEGIN
  IF to_regclass('public."fin_reconciliation_rules"') IS NOT NULL THEN
    EXECUTE $s230$
GRANT SELECT, INSERT, UPDATE, DELETE ON "fin_reconciliation_rules" TO streamline_app
$s230$;
  END IF;
END $g230$;
--> statement-breakpoint
DO $g231$
BEGIN
  IF to_regclass('public."fin_recurring_bill_templates"') IS NOT NULL THEN
    EXECUTE $s231$
ALTER TABLE "fin_recurring_bill_templates" ENABLE ROW LEVEL SECURITY
$s231$;
  END IF;
END $g231$;
--> statement-breakpoint
DO $g232$
BEGIN
  IF to_regclass('public."fin_recurring_bill_templates"') IS NOT NULL THEN
    EXECUTE $s232$
DROP POLICY IF EXISTS "tenant_isolation" ON "fin_recurring_bill_templates"
$s232$;
  END IF;
END $g232$;
--> statement-breakpoint
DO $g233$
BEGIN
  IF to_regclass('public."fin_recurring_bill_templates"') IS NOT NULL THEN
    EXECUTE $s233$
CREATE POLICY "tenant_isolation" ON "fin_recurring_bill_templates"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s233$;
  END IF;
END $g233$;
--> statement-breakpoint
DO $g234$
BEGIN
  IF to_regclass('public."fin_recurring_bill_templates"') IS NOT NULL THEN
    EXECUTE $s234$
REVOKE ALL ON "fin_recurring_bill_templates" FROM PUBLIC
$s234$;
  END IF;
END $g234$;
--> statement-breakpoint
DO $g235$
BEGIN
  IF to_regclass('public."fin_recurring_bill_templates"') IS NOT NULL THEN
    EXECUTE $s235$
GRANT SELECT, INSERT, UPDATE, DELETE ON "fin_recurring_bill_templates" TO streamline_app
$s235$;
  END IF;
END $g235$;
--> statement-breakpoint
DO $g236$
BEGIN
  IF to_regclass('public."fin_recurring_invoice_templates"') IS NOT NULL THEN
    EXECUTE $s236$
ALTER TABLE "fin_recurring_invoice_templates" ENABLE ROW LEVEL SECURITY
$s236$;
  END IF;
END $g236$;
--> statement-breakpoint
DO $g237$
BEGIN
  IF to_regclass('public."fin_recurring_invoice_templates"') IS NOT NULL THEN
    EXECUTE $s237$
DROP POLICY IF EXISTS "tenant_isolation" ON "fin_recurring_invoice_templates"
$s237$;
  END IF;
END $g237$;
--> statement-breakpoint
DO $g238$
BEGIN
  IF to_regclass('public."fin_recurring_invoice_templates"') IS NOT NULL THEN
    EXECUTE $s238$
CREATE POLICY "tenant_isolation" ON "fin_recurring_invoice_templates"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s238$;
  END IF;
END $g238$;
--> statement-breakpoint
DO $g239$
BEGIN
  IF to_regclass('public."fin_recurring_invoice_templates"') IS NOT NULL THEN
    EXECUTE $s239$
REVOKE ALL ON "fin_recurring_invoice_templates" FROM PUBLIC
$s239$;
  END IF;
END $g239$;
--> statement-breakpoint
DO $g240$
BEGIN
  IF to_regclass('public."fin_recurring_invoice_templates"') IS NOT NULL THEN
    EXECUTE $s240$
GRANT SELECT, INSERT, UPDATE, DELETE ON "fin_recurring_invoice_templates" TO streamline_app
$s240$;
  END IF;
END $g240$;
--> statement-breakpoint
DO $g241$
BEGIN
  IF to_regclass('public."fin_recurring_journal_templates"') IS NOT NULL THEN
    EXECUTE $s241$
ALTER TABLE "fin_recurring_journal_templates" ENABLE ROW LEVEL SECURITY
$s241$;
  END IF;
END $g241$;
--> statement-breakpoint
DO $g242$
BEGIN
  IF to_regclass('public."fin_recurring_journal_templates"') IS NOT NULL THEN
    EXECUTE $s242$
DROP POLICY IF EXISTS "tenant_isolation" ON "fin_recurring_journal_templates"
$s242$;
  END IF;
END $g242$;
--> statement-breakpoint
DO $g243$
BEGIN
  IF to_regclass('public."fin_recurring_journal_templates"') IS NOT NULL THEN
    EXECUTE $s243$
CREATE POLICY "tenant_isolation" ON "fin_recurring_journal_templates"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s243$;
  END IF;
END $g243$;
--> statement-breakpoint
DO $g244$
BEGIN
  IF to_regclass('public."fin_recurring_journal_templates"') IS NOT NULL THEN
    EXECUTE $s244$
REVOKE ALL ON "fin_recurring_journal_templates" FROM PUBLIC
$s244$;
  END IF;
END $g244$;
--> statement-breakpoint
DO $g245$
BEGIN
  IF to_regclass('public."fin_recurring_journal_templates"') IS NOT NULL THEN
    EXECUTE $s245$
GRANT SELECT, INSERT, UPDATE, DELETE ON "fin_recurring_journal_templates" TO streamline_app
$s245$;
  END IF;
END $g245$;
--> statement-breakpoint
DO $g246$
BEGIN
  IF to_regclass('public."fin_reimbursement_batches"') IS NOT NULL THEN
    EXECUTE $s246$
ALTER TABLE "fin_reimbursement_batches" ENABLE ROW LEVEL SECURITY
$s246$;
  END IF;
END $g246$;
--> statement-breakpoint
DO $g247$
BEGIN
  IF to_regclass('public."fin_reimbursement_batches"') IS NOT NULL THEN
    EXECUTE $s247$
DROP POLICY IF EXISTS "tenant_isolation" ON "fin_reimbursement_batches"
$s247$;
  END IF;
END $g247$;
--> statement-breakpoint
DO $g248$
BEGIN
  IF to_regclass('public."fin_reimbursement_batches"') IS NOT NULL THEN
    EXECUTE $s248$
CREATE POLICY "tenant_isolation" ON "fin_reimbursement_batches"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s248$;
  END IF;
END $g248$;
--> statement-breakpoint
DO $g249$
BEGIN
  IF to_regclass('public."fin_reimbursement_batches"') IS NOT NULL THEN
    EXECUTE $s249$
REVOKE ALL ON "fin_reimbursement_batches" FROM PUBLIC
$s249$;
  END IF;
END $g249$;
--> statement-breakpoint
DO $g250$
BEGIN
  IF to_regclass('public."fin_reimbursement_batches"') IS NOT NULL THEN
    EXECUTE $s250$
GRANT SELECT, INSERT, UPDATE, DELETE ON "fin_reimbursement_batches" TO streamline_app
$s250$;
  END IF;
END $g250$;
--> statement-breakpoint
DO $g251$
BEGIN
  IF to_regclass('public."fin_reminder_log"') IS NOT NULL THEN
    EXECUTE $s251$
ALTER TABLE "fin_reminder_log" ENABLE ROW LEVEL SECURITY
$s251$;
  END IF;
END $g251$;
--> statement-breakpoint
DO $g252$
BEGIN
  IF to_regclass('public."fin_reminder_log"') IS NOT NULL THEN
    EXECUTE $s252$
DROP POLICY IF EXISTS "tenant_isolation" ON "fin_reminder_log"
$s252$;
  END IF;
END $g252$;
--> statement-breakpoint
DO $g253$
BEGIN
  IF to_regclass('public."fin_reminder_log"') IS NOT NULL THEN
    EXECUTE $s253$
CREATE POLICY "tenant_isolation" ON "fin_reminder_log"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s253$;
  END IF;
END $g253$;
--> statement-breakpoint
DO $g254$
BEGIN
  IF to_regclass('public."fin_reminder_log"') IS NOT NULL THEN
    EXECUTE $s254$
REVOKE ALL ON "fin_reminder_log" FROM PUBLIC
$s254$;
  END IF;
END $g254$;
--> statement-breakpoint
DO $g255$
BEGIN
  IF to_regclass('public."fin_reminder_log"') IS NOT NULL THEN
    EXECUTE $s255$
GRANT SELECT, INSERT, UPDATE, DELETE ON "fin_reminder_log" TO streamline_app
$s255$;
  END IF;
END $g255$;
--> statement-breakpoint
DO $g256$
BEGIN
  IF to_regclass('public."fin_reminder_policies"') IS NOT NULL THEN
    EXECUTE $s256$
ALTER TABLE "fin_reminder_policies" ENABLE ROW LEVEL SECURITY
$s256$;
  END IF;
END $g256$;
--> statement-breakpoint
DO $g257$
BEGIN
  IF to_regclass('public."fin_reminder_policies"') IS NOT NULL THEN
    EXECUTE $s257$
DROP POLICY IF EXISTS "tenant_isolation" ON "fin_reminder_policies"
$s257$;
  END IF;
END $g257$;
--> statement-breakpoint
DO $g258$
BEGIN
  IF to_regclass('public."fin_reminder_policies"') IS NOT NULL THEN
    EXECUTE $s258$
CREATE POLICY "tenant_isolation" ON "fin_reminder_policies"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s258$;
  END IF;
END $g258$;
--> statement-breakpoint
DO $g259$
BEGIN
  IF to_regclass('public."fin_reminder_policies"') IS NOT NULL THEN
    EXECUTE $s259$
REVOKE ALL ON "fin_reminder_policies" FROM PUBLIC
$s259$;
  END IF;
END $g259$;
--> statement-breakpoint
DO $g260$
BEGIN
  IF to_regclass('public."fin_reminder_policies"') IS NOT NULL THEN
    EXECUTE $s260$
GRANT SELECT, INSERT, UPDATE, DELETE ON "fin_reminder_policies" TO streamline_app
$s260$;
  END IF;
END $g260$;
--> statement-breakpoint
DO $g261$
BEGIN
  IF to_regclass('public."fin_vendor_payment_allocations"') IS NOT NULL THEN
    EXECUTE $s261$
ALTER TABLE "fin_vendor_payment_allocations" ENABLE ROW LEVEL SECURITY
$s261$;
  END IF;
END $g261$;
--> statement-breakpoint
DO $g262$
BEGIN
  IF to_regclass('public."fin_vendor_payment_allocations"') IS NOT NULL THEN
    EXECUTE $s262$
DROP POLICY IF EXISTS "tenant_isolation" ON "fin_vendor_payment_allocations"
$s262$;
  END IF;
END $g262$;
--> statement-breakpoint
DO $g263$
BEGIN
  IF to_regclass('public."fin_vendor_payment_allocations"') IS NOT NULL THEN
    EXECUTE $s263$
CREATE POLICY "tenant_isolation" ON "fin_vendor_payment_allocations"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s263$;
  END IF;
END $g263$;
--> statement-breakpoint
DO $g264$
BEGIN
  IF to_regclass('public."fin_vendor_payment_allocations"') IS NOT NULL THEN
    EXECUTE $s264$
REVOKE ALL ON "fin_vendor_payment_allocations" FROM PUBLIC
$s264$;
  END IF;
END $g264$;
--> statement-breakpoint
DO $g265$
BEGIN
  IF to_regclass('public."fin_vendor_payment_allocations"') IS NOT NULL THEN
    EXECUTE $s265$
GRANT SELECT, INSERT, UPDATE, DELETE ON "fin_vendor_payment_allocations" TO streamline_app
$s265$;
  END IF;
END $g265$;
--> statement-breakpoint
DO $g266$
BEGIN
  IF to_regclass('public."gl_accounts"') IS NOT NULL THEN
    EXECUTE $s266$
ALTER TABLE "gl_accounts" ENABLE ROW LEVEL SECURITY
$s266$;
  END IF;
END $g266$;
--> statement-breakpoint
DO $g267$
BEGIN
  IF to_regclass('public."gl_accounts"') IS NOT NULL THEN
    EXECUTE $s267$
DROP POLICY IF EXISTS "tenant_isolation" ON "gl_accounts"
$s267$;
  END IF;
END $g267$;
--> statement-breakpoint
DO $g268$
BEGIN
  IF to_regclass('public."gl_accounts"') IS NOT NULL THEN
    EXECUTE $s268$
CREATE POLICY "tenant_isolation" ON "gl_accounts"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s268$;
  END IF;
END $g268$;
--> statement-breakpoint
DO $g269$
BEGIN
  IF to_regclass('public."gl_accounts"') IS NOT NULL THEN
    EXECUTE $s269$
REVOKE ALL ON "gl_accounts" FROM PUBLIC
$s269$;
  END IF;
END $g269$;
--> statement-breakpoint
DO $g270$
BEGIN
  IF to_regclass('public."gl_accounts"') IS NOT NULL THEN
    EXECUTE $s270$
GRANT SELECT, INSERT, UPDATE, DELETE ON "gl_accounts" TO streamline_app
$s270$;
  END IF;
END $g270$;
--> statement-breakpoint
DO $g271$
BEGIN
  IF to_regclass('public."gl_book_currencies"') IS NOT NULL THEN
    EXECUTE $s271$
ALTER TABLE "gl_book_currencies" ENABLE ROW LEVEL SECURITY
$s271$;
  END IF;
END $g271$;
--> statement-breakpoint
DO $g272$
BEGIN
  IF to_regclass('public."gl_book_currencies"') IS NOT NULL THEN
    EXECUTE $s272$
DROP POLICY IF EXISTS "tenant_isolation" ON "gl_book_currencies"
$s272$;
  END IF;
END $g272$;
--> statement-breakpoint
DO $g273$
BEGIN
  IF to_regclass('public."gl_book_currencies"') IS NOT NULL THEN
    EXECUTE $s273$
CREATE POLICY "tenant_isolation" ON "gl_book_currencies"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s273$;
  END IF;
END $g273$;
--> statement-breakpoint
DO $g274$
BEGIN
  IF to_regclass('public."gl_book_currencies"') IS NOT NULL THEN
    EXECUTE $s274$
REVOKE ALL ON "gl_book_currencies" FROM PUBLIC
$s274$;
  END IF;
END $g274$;
--> statement-breakpoint
DO $g275$
BEGIN
  IF to_regclass('public."gl_book_currencies"') IS NOT NULL THEN
    EXECUTE $s275$
GRANT SELECT, INSERT, UPDATE, DELETE ON "gl_book_currencies" TO streamline_app
$s275$;
  END IF;
END $g275$;
--> statement-breakpoint
DO $g276$
BEGIN
  IF to_regclass('public."gl_books"') IS NOT NULL THEN
    EXECUTE $s276$
ALTER TABLE "gl_books" ENABLE ROW LEVEL SECURITY
$s276$;
  END IF;
END $g276$;
--> statement-breakpoint
DO $g277$
BEGIN
  IF to_regclass('public."gl_books"') IS NOT NULL THEN
    EXECUTE $s277$
DROP POLICY IF EXISTS "tenant_isolation" ON "gl_books"
$s277$;
  END IF;
END $g277$;
--> statement-breakpoint
DO $g278$
BEGIN
  IF to_regclass('public."gl_books"') IS NOT NULL THEN
    EXECUTE $s278$
CREATE POLICY "tenant_isolation" ON "gl_books"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s278$;
  END IF;
END $g278$;
--> statement-breakpoint
DO $g279$
BEGIN
  IF to_regclass('public."gl_books"') IS NOT NULL THEN
    EXECUTE $s279$
REVOKE ALL ON "gl_books" FROM PUBLIC
$s279$;
  END IF;
END $g279$;
--> statement-breakpoint
DO $g280$
BEGIN
  IF to_regclass('public."gl_books"') IS NOT NULL THEN
    EXECUTE $s280$
GRANT SELECT, INSERT, UPDATE, DELETE ON "gl_books" TO streamline_app
$s280$;
  END IF;
END $g280$;
--> statement-breakpoint
DO $g281$
BEGIN
  IF to_regclass('public."gl_document_attachments"') IS NOT NULL THEN
    EXECUTE $s281$
ALTER TABLE "gl_document_attachments" ENABLE ROW LEVEL SECURITY
$s281$;
  END IF;
END $g281$;
--> statement-breakpoint
DO $g282$
BEGIN
  IF to_regclass('public."gl_document_attachments"') IS NOT NULL THEN
    EXECUTE $s282$
DROP POLICY IF EXISTS "tenant_isolation" ON "gl_document_attachments"
$s282$;
  END IF;
END $g282$;
--> statement-breakpoint
DO $g283$
BEGIN
  IF to_regclass('public."gl_document_attachments"') IS NOT NULL THEN
    EXECUTE $s283$
CREATE POLICY "tenant_isolation" ON "gl_document_attachments"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s283$;
  END IF;
END $g283$;
--> statement-breakpoint
DO $g284$
BEGIN
  IF to_regclass('public."gl_document_attachments"') IS NOT NULL THEN
    EXECUTE $s284$
REVOKE ALL ON "gl_document_attachments" FROM PUBLIC
$s284$;
  END IF;
END $g284$;
--> statement-breakpoint
DO $g285$
BEGIN
  IF to_regclass('public."gl_document_attachments"') IS NOT NULL THEN
    EXECUTE $s285$
GRANT SELECT, INSERT, UPDATE, DELETE ON "gl_document_attachments" TO streamline_app
$s285$;
  END IF;
END $g285$;
--> statement-breakpoint
DO $g286$
BEGIN
  IF to_regclass('public."gl_document_compliance"') IS NOT NULL THEN
    EXECUTE $s286$
ALTER TABLE "gl_document_compliance" ENABLE ROW LEVEL SECURITY
$s286$;
  END IF;
END $g286$;
--> statement-breakpoint
DO $g287$
BEGIN
  IF to_regclass('public."gl_document_compliance"') IS NOT NULL THEN
    EXECUTE $s287$
DROP POLICY IF EXISTS "tenant_isolation" ON "gl_document_compliance"
$s287$;
  END IF;
END $g287$;
--> statement-breakpoint
DO $g288$
BEGIN
  IF to_regclass('public."gl_document_compliance"') IS NOT NULL THEN
    EXECUTE $s288$
CREATE POLICY "tenant_isolation" ON "gl_document_compliance"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s288$;
  END IF;
END $g288$;
--> statement-breakpoint
DO $g289$
BEGIN
  IF to_regclass('public."gl_document_compliance"') IS NOT NULL THEN
    EXECUTE $s289$
REVOKE ALL ON "gl_document_compliance" FROM PUBLIC
$s289$;
  END IF;
END $g289$;
--> statement-breakpoint
DO $g290$
BEGIN
  IF to_regclass('public."gl_document_compliance"') IS NOT NULL THEN
    EXECUTE $s290$
GRANT SELECT, INSERT, UPDATE, DELETE ON "gl_document_compliance" TO streamline_app
$s290$;
  END IF;
END $g290$;
--> statement-breakpoint
DO $g291$
BEGIN
  IF to_regclass('public."gl_document_sequences"') IS NOT NULL THEN
    EXECUTE $s291$
ALTER TABLE "gl_document_sequences" ENABLE ROW LEVEL SECURITY
$s291$;
  END IF;
END $g291$;
--> statement-breakpoint
DO $g292$
BEGIN
  IF to_regclass('public."gl_document_sequences"') IS NOT NULL THEN
    EXECUTE $s292$
DROP POLICY IF EXISTS "tenant_isolation" ON "gl_document_sequences"
$s292$;
  END IF;
END $g292$;
--> statement-breakpoint
DO $g293$
BEGIN
  IF to_regclass('public."gl_document_sequences"') IS NOT NULL THEN
    EXECUTE $s293$
CREATE POLICY "tenant_isolation" ON "gl_document_sequences"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s293$;
  END IF;
END $g293$;
--> statement-breakpoint
DO $g294$
BEGIN
  IF to_regclass('public."gl_document_sequences"') IS NOT NULL THEN
    EXECUTE $s294$
REVOKE ALL ON "gl_document_sequences" FROM PUBLIC
$s294$;
  END IF;
END $g294$;
--> statement-breakpoint
DO $g295$
BEGIN
  IF to_regclass('public."gl_document_sequences"') IS NOT NULL THEN
    EXECUTE $s295$
GRANT SELECT, INSERT, UPDATE, DELETE ON "gl_document_sequences" TO streamline_app
$s295$;
  END IF;
END $g295$;
--> statement-breakpoint
DO $g296$
BEGIN
  IF to_regclass('public."gl_fiscal_years"') IS NOT NULL THEN
    EXECUTE $s296$
ALTER TABLE "gl_fiscal_years" ENABLE ROW LEVEL SECURITY
$s296$;
  END IF;
END $g296$;
--> statement-breakpoint
DO $g297$
BEGIN
  IF to_regclass('public."gl_fiscal_years"') IS NOT NULL THEN
    EXECUTE $s297$
DROP POLICY IF EXISTS "tenant_isolation" ON "gl_fiscal_years"
$s297$;
  END IF;
END $g297$;
--> statement-breakpoint
DO $g298$
BEGIN
  IF to_regclass('public."gl_fiscal_years"') IS NOT NULL THEN
    EXECUTE $s298$
CREATE POLICY "tenant_isolation" ON "gl_fiscal_years"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s298$;
  END IF;
END $g298$;
--> statement-breakpoint
DO $g299$
BEGIN
  IF to_regclass('public."gl_fiscal_years"') IS NOT NULL THEN
    EXECUTE $s299$
REVOKE ALL ON "gl_fiscal_years" FROM PUBLIC
$s299$;
  END IF;
END $g299$;
--> statement-breakpoint
DO $g300$
BEGIN
  IF to_regclass('public."gl_fiscal_years"') IS NOT NULL THEN
    EXECUTE $s300$
GRANT SELECT, INSERT, UPDATE, DELETE ON "gl_fiscal_years" TO streamline_app
$s300$;
  END IF;
END $g300$;
--> statement-breakpoint
DO $g301$
BEGIN
  IF to_regclass('public."gl_fx_rates"') IS NOT NULL THEN
    EXECUTE $s301$
ALTER TABLE "gl_fx_rates" ENABLE ROW LEVEL SECURITY
$s301$;
  END IF;
END $g301$;
--> statement-breakpoint
DO $g302$
BEGIN
  IF to_regclass('public."gl_fx_rates"') IS NOT NULL THEN
    EXECUTE $s302$
DROP POLICY IF EXISTS "tenant_isolation" ON "gl_fx_rates"
$s302$;
  END IF;
END $g302$;
--> statement-breakpoint
DO $g303$
BEGIN
  IF to_regclass('public."gl_fx_rates"') IS NOT NULL THEN
    EXECUTE $s303$
CREATE POLICY "tenant_isolation" ON "gl_fx_rates"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s303$;
  END IF;
END $g303$;
--> statement-breakpoint
DO $g304$
BEGIN
  IF to_regclass('public."gl_fx_rates"') IS NOT NULL THEN
    EXECUTE $s304$
REVOKE ALL ON "gl_fx_rates" FROM PUBLIC
$s304$;
  END IF;
END $g304$;
--> statement-breakpoint
DO $g305$
BEGIN
  IF to_regclass('public."gl_fx_rates"') IS NOT NULL THEN
    EXECUTE $s305$
GRANT SELECT, INSERT, UPDATE, DELETE ON "gl_fx_rates" TO streamline_app
$s305$;
  END IF;
END $g305$;
--> statement-breakpoint
DO $g306$
BEGIN
  IF to_regclass('public."gl_journal_lines"') IS NOT NULL THEN
    EXECUTE $s306$
ALTER TABLE "gl_journal_lines" ENABLE ROW LEVEL SECURITY
$s306$;
  END IF;
END $g306$;
--> statement-breakpoint
DO $g307$
BEGIN
  IF to_regclass('public."gl_journal_lines"') IS NOT NULL THEN
    EXECUTE $s307$
DROP POLICY IF EXISTS "tenant_isolation" ON "gl_journal_lines"
$s307$;
  END IF;
END $g307$;
--> statement-breakpoint
DO $g308$
BEGIN
  IF to_regclass('public."gl_journal_lines"') IS NOT NULL THEN
    EXECUTE $s308$
CREATE POLICY "tenant_isolation" ON "gl_journal_lines"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s308$;
  END IF;
END $g308$;
--> statement-breakpoint
DO $g309$
BEGIN
  IF to_regclass('public."gl_journal_lines"') IS NOT NULL THEN
    EXECUTE $s309$
REVOKE ALL ON "gl_journal_lines" FROM PUBLIC
$s309$;
  END IF;
END $g309$;
--> statement-breakpoint
DO $g310$
BEGIN
  IF to_regclass('public."gl_journal_lines"') IS NOT NULL THEN
    EXECUTE $s310$
GRANT SELECT, INSERT, UPDATE, DELETE ON "gl_journal_lines" TO streamline_app
$s310$;
  END IF;
END $g310$;
--> statement-breakpoint
DO $g311$
BEGIN
  IF to_regclass('public."gl_journals"') IS NOT NULL THEN
    EXECUTE $s311$
ALTER TABLE "gl_journals" ENABLE ROW LEVEL SECURITY
$s311$;
  END IF;
END $g311$;
--> statement-breakpoint
DO $g312$
BEGIN
  IF to_regclass('public."gl_journals"') IS NOT NULL THEN
    EXECUTE $s312$
DROP POLICY IF EXISTS "tenant_isolation" ON "gl_journals"
$s312$;
  END IF;
END $g312$;
--> statement-breakpoint
DO $g313$
BEGIN
  IF to_regclass('public."gl_journals"') IS NOT NULL THEN
    EXECUTE $s313$
CREATE POLICY "tenant_isolation" ON "gl_journals"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s313$;
  END IF;
END $g313$;
--> statement-breakpoint
DO $g314$
BEGIN
  IF to_regclass('public."gl_journals"') IS NOT NULL THEN
    EXECUTE $s314$
REVOKE ALL ON "gl_journals" FROM PUBLIC
$s314$;
  END IF;
END $g314$;
--> statement-breakpoint
DO $g315$
BEGIN
  IF to_regclass('public."gl_journals"') IS NOT NULL THEN
    EXECUTE $s315$
GRANT SELECT, INSERT, UPDATE, DELETE ON "gl_journals" TO streamline_app
$s315$;
  END IF;
END $g315$;
--> statement-breakpoint
DO $g316$
BEGIN
  IF to_regclass('public."gl_parties"') IS NOT NULL THEN
    EXECUTE $s316$
ALTER TABLE "gl_parties" ENABLE ROW LEVEL SECURITY
$s316$;
  END IF;
END $g316$;
--> statement-breakpoint
DO $g317$
BEGIN
  IF to_regclass('public."gl_parties"') IS NOT NULL THEN
    EXECUTE $s317$
DROP POLICY IF EXISTS "tenant_isolation" ON "gl_parties"
$s317$;
  END IF;
END $g317$;
--> statement-breakpoint
DO $g318$
BEGIN
  IF to_regclass('public."gl_parties"') IS NOT NULL THEN
    EXECUTE $s318$
CREATE POLICY "tenant_isolation" ON "gl_parties"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s318$;
  END IF;
END $g318$;
--> statement-breakpoint
DO $g319$
BEGIN
  IF to_regclass('public."gl_parties"') IS NOT NULL THEN
    EXECUTE $s319$
REVOKE ALL ON "gl_parties" FROM PUBLIC
$s319$;
  END IF;
END $g319$;
--> statement-breakpoint
DO $g320$
BEGIN
  IF to_regclass('public."gl_parties"') IS NOT NULL THEN
    EXECUTE $s320$
GRANT SELECT, INSERT, UPDATE, DELETE ON "gl_parties" TO streamline_app
$s320$;
  END IF;
END $g320$;
--> statement-breakpoint
DO $g321$
BEGIN
  IF to_regclass('public."gl_periods"') IS NOT NULL THEN
    EXECUTE $s321$
ALTER TABLE "gl_periods" ENABLE ROW LEVEL SECURITY
$s321$;
  END IF;
END $g321$;
--> statement-breakpoint
DO $g322$
BEGIN
  IF to_regclass('public."gl_periods"') IS NOT NULL THEN
    EXECUTE $s322$
DROP POLICY IF EXISTS "tenant_isolation" ON "gl_periods"
$s322$;
  END IF;
END $g322$;
--> statement-breakpoint
DO $g323$
BEGIN
  IF to_regclass('public."gl_periods"') IS NOT NULL THEN
    EXECUTE $s323$
CREATE POLICY "tenant_isolation" ON "gl_periods"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s323$;
  END IF;
END $g323$;
--> statement-breakpoint
DO $g324$
BEGIN
  IF to_regclass('public."gl_periods"') IS NOT NULL THEN
    EXECUTE $s324$
REVOKE ALL ON "gl_periods" FROM PUBLIC
$s324$;
  END IF;
END $g324$;
--> statement-breakpoint
DO $g325$
BEGIN
  IF to_regclass('public."gl_periods"') IS NOT NULL THEN
    EXECUTE $s325$
GRANT SELECT, INSERT, UPDATE, DELETE ON "gl_periods" TO streamline_app
$s325$;
  END IF;
END $g325$;
--> statement-breakpoint
DO $g326$
BEGIN
  IF to_regclass('public."journal_entries"') IS NOT NULL THEN
    EXECUTE $s326$
ALTER TABLE "journal_entries" ENABLE ROW LEVEL SECURITY
$s326$;
  END IF;
END $g326$;
--> statement-breakpoint
DO $g327$
BEGIN
  IF to_regclass('public."journal_entries"') IS NOT NULL THEN
    EXECUTE $s327$
DROP POLICY IF EXISTS "tenant_isolation" ON "journal_entries"
$s327$;
  END IF;
END $g327$;
--> statement-breakpoint
DO $g328$
BEGIN
  IF to_regclass('public."journal_entries"') IS NOT NULL THEN
    EXECUTE $s328$
CREATE POLICY "tenant_isolation" ON "journal_entries"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s328$;
  END IF;
END $g328$;
--> statement-breakpoint
DO $g329$
BEGIN
  IF to_regclass('public."journal_entries"') IS NOT NULL THEN
    EXECUTE $s329$
REVOKE ALL ON "journal_entries" FROM PUBLIC
$s329$;
  END IF;
END $g329$;
--> statement-breakpoint
DO $g330$
BEGIN
  IF to_regclass('public."journal_entries"') IS NOT NULL THEN
    EXECUTE $s330$
GRANT SELECT, INSERT, UPDATE, DELETE ON "journal_entries" TO streamline_app
$s330$;
  END IF;
END $g330$;
--> statement-breakpoint
DO $g331$
BEGIN
  IF to_regclass('public."journal_lines"') IS NOT NULL THEN
    EXECUTE $s331$
ALTER TABLE "journal_lines" ENABLE ROW LEVEL SECURITY
$s331$;
  END IF;
END $g331$;
--> statement-breakpoint
DO $g332$
BEGIN
  IF to_regclass('public."journal_lines"') IS NOT NULL THEN
    EXECUTE $s332$
DROP POLICY IF EXISTS "tenant_isolation" ON "journal_lines"
$s332$;
  END IF;
END $g332$;
--> statement-breakpoint
DO $g333$
BEGIN
  IF to_regclass('public."journal_lines"') IS NOT NULL THEN
    EXECUTE $s333$
CREATE POLICY "tenant_isolation" ON "journal_lines"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s333$;
  END IF;
END $g333$;
--> statement-breakpoint
DO $g334$
BEGIN
  IF to_regclass('public."journal_lines"') IS NOT NULL THEN
    EXECUTE $s334$
REVOKE ALL ON "journal_lines" FROM PUBLIC
$s334$;
  END IF;
END $g334$;
--> statement-breakpoint
DO $g335$
BEGIN
  IF to_regclass('public."journal_lines"') IS NOT NULL THEN
    EXECUTE $s335$
GRANT SELECT, INSERT, UPDATE, DELETE ON "journal_lines" TO streamline_app
$s335$;
  END IF;
END $g335$;
--> statement-breakpoint
DO $g336$
BEGIN
  IF to_regclass('public."leads"') IS NOT NULL THEN
    EXECUTE $s336$
ALTER TABLE "leads" ENABLE ROW LEVEL SECURITY
$s336$;
  END IF;
END $g336$;
--> statement-breakpoint
DO $g337$
BEGIN
  IF to_regclass('public."leads"') IS NOT NULL THEN
    EXECUTE $s337$
DROP POLICY IF EXISTS "tenant_isolation" ON "leads"
$s337$;
  END IF;
END $g337$;
--> statement-breakpoint
DO $g338$
BEGIN
  IF to_regclass('public."leads"') IS NOT NULL THEN
    EXECUTE $s338$
CREATE POLICY "tenant_isolation" ON "leads"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s338$;
  END IF;
END $g338$;
--> statement-breakpoint
DO $g339$
BEGIN
  IF to_regclass('public."leads"') IS NOT NULL THEN
    EXECUTE $s339$
REVOKE ALL ON "leads" FROM PUBLIC
$s339$;
  END IF;
END $g339$;
--> statement-breakpoint
DO $g340$
BEGIN
  IF to_regclass('public."leads"') IS NOT NULL THEN
    EXECUTE $s340$
GRANT SELECT, INSERT, UPDATE, DELETE ON "leads" TO streamline_app
$s340$;
  END IF;
END $g340$;
--> statement-breakpoint
DO $g341$
BEGIN
  IF to_regclass('public."ledger_accounts"') IS NOT NULL THEN
    EXECUTE $s341$
ALTER TABLE "ledger_accounts" ENABLE ROW LEVEL SECURITY
$s341$;
  END IF;
END $g341$;
--> statement-breakpoint
DO $g342$
BEGIN
  IF to_regclass('public."ledger_accounts"') IS NOT NULL THEN
    EXECUTE $s342$
DROP POLICY IF EXISTS "tenant_isolation" ON "ledger_accounts"
$s342$;
  END IF;
END $g342$;
--> statement-breakpoint
DO $g343$
BEGIN
  IF to_regclass('public."ledger_accounts"') IS NOT NULL THEN
    EXECUTE $s343$
CREATE POLICY "tenant_isolation" ON "ledger_accounts"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s343$;
  END IF;
END $g343$;
--> statement-breakpoint
DO $g344$
BEGIN
  IF to_regclass('public."ledger_accounts"') IS NOT NULL THEN
    EXECUTE $s344$
REVOKE ALL ON "ledger_accounts" FROM PUBLIC
$s344$;
  END IF;
END $g344$;
--> statement-breakpoint
DO $g345$
BEGIN
  IF to_regclass('public."ledger_accounts"') IS NOT NULL THEN
    EXECUTE $s345$
GRANT SELECT, INSERT, UPDATE, DELETE ON "ledger_accounts" TO streamline_app
$s345$;
  END IF;
END $g345$;
--> statement-breakpoint
DO $g346$
BEGIN
  IF to_regclass('public."notification_read_watermarks"') IS NOT NULL THEN
    EXECUTE $s346$
ALTER TABLE "notification_read_watermarks" ENABLE ROW LEVEL SECURITY
$s346$;
  END IF;
END $g346$;
--> statement-breakpoint
DO $g347$
BEGIN
  IF to_regclass('public."notification_read_watermarks"') IS NOT NULL THEN
    EXECUTE $s347$
DROP POLICY IF EXISTS "tenant_isolation" ON "notification_read_watermarks"
$s347$;
  END IF;
END $g347$;
--> statement-breakpoint
DO $g348$
BEGIN
  IF to_regclass('public."notification_read_watermarks"') IS NOT NULL THEN
    EXECUTE $s348$
CREATE POLICY "tenant_isolation" ON "notification_read_watermarks"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s348$;
  END IF;
END $g348$;
--> statement-breakpoint
DO $g349$
BEGIN
  IF to_regclass('public."notification_read_watermarks"') IS NOT NULL THEN
    EXECUTE $s349$
REVOKE ALL ON "notification_read_watermarks" FROM PUBLIC
$s349$;
  END IF;
END $g349$;
--> statement-breakpoint
DO $g350$
BEGIN
  IF to_regclass('public."notification_read_watermarks"') IS NOT NULL THEN
    EXECUTE $s350$
GRANT SELECT, INSERT, UPDATE, DELETE ON "notification_read_watermarks" TO streamline_app
$s350$;
  END IF;
END $g350$;
--> statement-breakpoint
DO $g351$
BEGIN
  IF to_regclass('public."record_layout_adjustments"') IS NOT NULL THEN
    EXECUTE $s351$
ALTER TABLE "record_layout_adjustments" ENABLE ROW LEVEL SECURITY
$s351$;
  END IF;
END $g351$;
--> statement-breakpoint
DO $g352$
BEGIN
  IF to_regclass('public."record_layout_adjustments"') IS NOT NULL THEN
    EXECUTE $s352$
DROP POLICY IF EXISTS "tenant_isolation" ON "record_layout_adjustments"
$s352$;
  END IF;
END $g352$;
--> statement-breakpoint
DO $g353$
BEGIN
  IF to_regclass('public."record_layout_adjustments"') IS NOT NULL THEN
    EXECUTE $s353$
CREATE POLICY "tenant_isolation" ON "record_layout_adjustments"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s353$;
  END IF;
END $g353$;
--> statement-breakpoint
DO $g354$
BEGIN
  IF to_regclass('public."record_layout_adjustments"') IS NOT NULL THEN
    EXECUTE $s354$
REVOKE ALL ON "record_layout_adjustments" FROM PUBLIC
$s354$;
  END IF;
END $g354$;
--> statement-breakpoint
DO $g355$
BEGIN
  IF to_regclass('public."record_layout_adjustments"') IS NOT NULL THEN
    EXECUTE $s355$
GRANT SELECT, INSERT, UPDATE, DELETE ON "record_layout_adjustments" TO streamline_app
$s355$;
  END IF;
END $g355$;
--> statement-breakpoint
DO $g356$
BEGIN
  IF to_regclass('public."subprocessor_subscribers"') IS NOT NULL THEN
    EXECUTE $s356$
ALTER TABLE "subprocessor_subscribers" ENABLE ROW LEVEL SECURITY
$s356$;
  END IF;
END $g356$;
--> statement-breakpoint
DO $g357$
BEGIN
  IF to_regclass('public."subprocessor_subscribers"') IS NOT NULL THEN
    EXECUTE $s357$
DROP POLICY IF EXISTS "tenant_isolation" ON "subprocessor_subscribers"
$s357$;
  END IF;
END $g357$;
--> statement-breakpoint
DO $g358$
BEGIN
  IF to_regclass('public."subprocessor_subscribers"') IS NOT NULL THEN
    EXECUTE $s358$
CREATE POLICY "tenant_isolation" ON "subprocessor_subscribers"
  FOR ALL USING ("organization_id" = app.current_org_id())
  WITH CHECK ("organization_id" = app.current_org_id())
$s358$;
  END IF;
END $g358$;
--> statement-breakpoint
DO $g359$
BEGIN
  IF to_regclass('public."subprocessor_subscribers"') IS NOT NULL THEN
    EXECUTE $s359$
REVOKE ALL ON "subprocessor_subscribers" FROM PUBLIC
$s359$;
  END IF;
END $g359$;
--> statement-breakpoint
DO $g360$
BEGIN
  IF to_regclass('public."subprocessor_subscribers"') IS NOT NULL THEN
    EXECUTE $s360$
GRANT SELECT, INSERT, UPDATE, DELETE ON "subprocessor_subscribers" TO streamline_app
$s360$;
  END IF;
END $g360$;
--> statement-breakpoint
DO $g361$
BEGIN
  IF to_regclass('public."tax_codes"') IS NOT NULL THEN
    EXECUTE $s361$
ALTER TABLE "tax_codes" ENABLE ROW LEVEL SECURITY
$s361$;
  END IF;
END $g361$;
--> statement-breakpoint
DO $g362$
BEGIN
  IF to_regclass('public."tax_codes"') IS NOT NULL THEN
    EXECUTE $s362$
DROP POLICY IF EXISTS "tenant_isolation" ON "tax_codes"
$s362$;
  END IF;
END $g362$;
--> statement-breakpoint
DO $g363$
BEGIN
  IF to_regclass('public."tax_codes"') IS NOT NULL THEN
    EXECUTE $s363$
CREATE POLICY "tenant_isolation" ON "tax_codes"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s363$;
  END IF;
END $g363$;
--> statement-breakpoint
DO $g364$
BEGIN
  IF to_regclass('public."tax_codes"') IS NOT NULL THEN
    EXECUTE $s364$
REVOKE ALL ON "tax_codes" FROM PUBLIC
$s364$;
  END IF;
END $g364$;
--> statement-breakpoint
DO $g365$
BEGIN
  IF to_regclass('public."tax_codes"') IS NOT NULL THEN
    EXECUTE $s365$
GRANT SELECT, INSERT, UPDATE, DELETE ON "tax_codes" TO streamline_app
$s365$;
  END IF;
END $g365$;
--> statement-breakpoint
DO $g366$
BEGIN
  IF to_regclass('public."tax_document_lines"') IS NOT NULL THEN
    EXECUTE $s366$
ALTER TABLE "tax_document_lines" ENABLE ROW LEVEL SECURITY
$s366$;
  END IF;
END $g366$;
--> statement-breakpoint
DO $g367$
BEGIN
  IF to_regclass('public."tax_document_lines"') IS NOT NULL THEN
    EXECUTE $s367$
DROP POLICY IF EXISTS "tenant_isolation" ON "tax_document_lines"
$s367$;
  END IF;
END $g367$;
--> statement-breakpoint
DO $g368$
BEGIN
  IF to_regclass('public."tax_document_lines"') IS NOT NULL THEN
    EXECUTE $s368$
CREATE POLICY "tenant_isolation" ON "tax_document_lines"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s368$;
  END IF;
END $g368$;
--> statement-breakpoint
DO $g369$
BEGIN
  IF to_regclass('public."tax_document_lines"') IS NOT NULL THEN
    EXECUTE $s369$
REVOKE ALL ON "tax_document_lines" FROM PUBLIC
$s369$;
  END IF;
END $g369$;
--> statement-breakpoint
DO $g370$
BEGIN
  IF to_regclass('public."tax_document_lines"') IS NOT NULL THEN
    EXECUTE $s370$
GRANT SELECT, INSERT, UPDATE, DELETE ON "tax_document_lines" TO streamline_app
$s370$;
  END IF;
END $g370$;
--> statement-breakpoint
DO $g371$
BEGIN
  IF to_regclass('public."tax_gl_map"') IS NOT NULL THEN
    EXECUTE $s371$
ALTER TABLE "tax_gl_map" ENABLE ROW LEVEL SECURITY
$s371$;
  END IF;
END $g371$;
--> statement-breakpoint
DO $g372$
BEGIN
  IF to_regclass('public."tax_gl_map"') IS NOT NULL THEN
    EXECUTE $s372$
DROP POLICY IF EXISTS "tenant_isolation" ON "tax_gl_map"
$s372$;
  END IF;
END $g372$;
--> statement-breakpoint
DO $g373$
BEGIN
  IF to_regclass('public."tax_gl_map"') IS NOT NULL THEN
    EXECUTE $s373$
CREATE POLICY "tenant_isolation" ON "tax_gl_map"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s373$;
  END IF;
END $g373$;
--> statement-breakpoint
DO $g374$
BEGIN
  IF to_regclass('public."tax_gl_map"') IS NOT NULL THEN
    EXECUTE $s374$
REVOKE ALL ON "tax_gl_map" FROM PUBLIC
$s374$;
  END IF;
END $g374$;
--> statement-breakpoint
DO $g375$
BEGIN
  IF to_regclass('public."tax_gl_map"') IS NOT NULL THEN
    EXECUTE $s375$
GRANT SELECT, INSERT, UPDATE, DELETE ON "tax_gl_map" TO streamline_app
$s375$;
  END IF;
END $g375$;
--> statement-breakpoint
DO $g376$
BEGIN
  IF to_regclass('public."tax_rates"') IS NOT NULL THEN
    EXECUTE $s376$
ALTER TABLE "tax_rates" ENABLE ROW LEVEL SECURITY
$s376$;
  END IF;
END $g376$;
--> statement-breakpoint
DO $g377$
BEGIN
  IF to_regclass('public."tax_rates"') IS NOT NULL THEN
    EXECUTE $s377$
DROP POLICY IF EXISTS "tenant_isolation" ON "tax_rates"
$s377$;
  END IF;
END $g377$;
--> statement-breakpoint
DO $g378$
BEGIN
  IF to_regclass('public."tax_rates"') IS NOT NULL THEN
    EXECUTE $s378$
CREATE POLICY "tenant_isolation" ON "tax_rates"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s378$;
  END IF;
END $g378$;
--> statement-breakpoint
DO $g379$
BEGIN
  IF to_regclass('public."tax_rates"') IS NOT NULL THEN
    EXECUTE $s379$
REVOKE ALL ON "tax_rates" FROM PUBLIC
$s379$;
  END IF;
END $g379$;
--> statement-breakpoint
DO $g380$
BEGIN
  IF to_regclass('public."tax_rates"') IS NOT NULL THEN
    EXECUTE $s380$
GRANT SELECT, INSERT, UPDATE, DELETE ON "tax_rates" TO streamline_app
$s380$;
  END IF;
END $g380$;
--> statement-breakpoint
DO $g381$
BEGIN
  IF to_regclass('public."tax_registrations"') IS NOT NULL THEN
    EXECUTE $s381$
ALTER TABLE "tax_registrations" ENABLE ROW LEVEL SECURITY
$s381$;
  END IF;
END $g381$;
--> statement-breakpoint
DO $g382$
BEGIN
  IF to_regclass('public."tax_registrations"') IS NOT NULL THEN
    EXECUTE $s382$
DROP POLICY IF EXISTS "tenant_isolation" ON "tax_registrations"
$s382$;
  END IF;
END $g382$;
--> statement-breakpoint
DO $g383$
BEGIN
  IF to_regclass('public."tax_registrations"') IS NOT NULL THEN
    EXECUTE $s383$
CREATE POLICY "tenant_isolation" ON "tax_registrations"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s383$;
  END IF;
END $g383$;
--> statement-breakpoint
DO $g384$
BEGIN
  IF to_regclass('public."tax_registrations"') IS NOT NULL THEN
    EXECUTE $s384$
REVOKE ALL ON "tax_registrations" FROM PUBLIC
$s384$;
  END IF;
END $g384$;
--> statement-breakpoint
DO $g385$
BEGIN
  IF to_regclass('public."tax_registrations"') IS NOT NULL THEN
    EXECUTE $s385$
GRANT SELECT, INSERT, UPDATE, DELETE ON "tax_registrations" TO streamline_app
$s385$;
  END IF;
END $g385$;
--> statement-breakpoint
DO $g386$
BEGIN
  IF to_regclass('public."vendor_credits"') IS NOT NULL THEN
    EXECUTE $s386$
ALTER TABLE "vendor_credits" ENABLE ROW LEVEL SECURITY
$s386$;
  END IF;
END $g386$;
--> statement-breakpoint
DO $g387$
BEGIN
  IF to_regclass('public."vendor_credits"') IS NOT NULL THEN
    EXECUTE $s387$
DROP POLICY IF EXISTS "tenant_isolation" ON "vendor_credits"
$s387$;
  END IF;
END $g387$;
--> statement-breakpoint
DO $g388$
BEGIN
  IF to_regclass('public."vendor_credits"') IS NOT NULL THEN
    EXECUTE $s388$
CREATE POLICY "tenant_isolation" ON "vendor_credits"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id())
$s388$;
  END IF;
END $g388$;
--> statement-breakpoint
DO $g389$
BEGIN
  IF to_regclass('public."vendor_credits"') IS NOT NULL THEN
    EXECUTE $s389$
REVOKE ALL ON "vendor_credits" FROM PUBLIC
$s389$;
  END IF;
END $g389$;
--> statement-breakpoint
DO $g390$
BEGIN
  IF to_regclass('public."vendor_credits"') IS NOT NULL THEN
    EXECUTE $s390$
GRANT SELECT, INSERT, UPDATE, DELETE ON "vendor_credits" TO streamline_app
$s390$;
  END IF;
END $g390$;
--> statement-breakpoint
DO $g391$
BEGIN
  IF to_regclass('public."workflow_runs"') IS NOT NULL THEN
    EXECUTE $s391$
ALTER TABLE "workflow_runs" ENABLE ROW LEVEL SECURITY
$s391$;
  END IF;
END $g391$;
--> statement-breakpoint
DO $g392$
BEGIN
  IF to_regclass('public."workflow_runs"') IS NOT NULL THEN
    EXECUTE $s392$
DROP POLICY IF EXISTS "tenant_isolation" ON "workflow_runs"
$s392$;
  END IF;
END $g392$;
--> statement-breakpoint
DO $g393$
BEGIN
  IF to_regclass('public."workflow_runs"') IS NOT NULL THEN
    EXECUTE $s393$
CREATE POLICY "tenant_isolation" ON "workflow_runs"
  FOR ALL USING ("organization_id" = app.current_org_id())
  WITH CHECK ("organization_id" = app.current_org_id())
$s393$;
  END IF;
END $g393$;
--> statement-breakpoint
DO $g394$
BEGIN
  IF to_regclass('public."workflow_runs"') IS NOT NULL THEN
    EXECUTE $s394$
REVOKE ALL ON "workflow_runs" FROM PUBLIC
$s394$;
  END IF;
END $g394$;
--> statement-breakpoint
DO $g395$
BEGIN
  IF to_regclass('public."workflow_runs"') IS NOT NULL THEN
    EXECUTE $s395$
GRANT SELECT, INSERT, UPDATE, DELETE ON "workflow_runs" TO streamline_app
$s395$;
  END IF;
END $g395$;
--> statement-breakpoint
DO $g396$
BEGIN
  IF to_regclass('public."workflow_steps"') IS NOT NULL THEN
    EXECUTE $s396$
ALTER TABLE "workflow_steps" ENABLE ROW LEVEL SECURITY
$s396$;
  END IF;
END $g396$;
--> statement-breakpoint
DO $g397$
BEGIN
  IF to_regclass('public."workflow_steps"') IS NOT NULL THEN
    EXECUTE $s397$
DROP POLICY IF EXISTS "tenant_isolation" ON "workflow_steps"
$s397$;
  END IF;
END $g397$;
--> statement-breakpoint
DO $g398$
BEGIN
  IF to_regclass('public."workflow_steps"') IS NOT NULL THEN
    EXECUTE $s398$
CREATE POLICY "tenant_isolation" ON "workflow_steps"
  FOR ALL USING ("organization_id" = app.current_org_id())
  WITH CHECK ("organization_id" = app.current_org_id())
$s398$;
  END IF;
END $g398$;
--> statement-breakpoint
DO $g399$
BEGIN
  IF to_regclass('public."workflow_steps"') IS NOT NULL THEN
    EXECUTE $s399$
REVOKE ALL ON "workflow_steps" FROM PUBLIC
$s399$;
  END IF;
END $g399$;
--> statement-breakpoint
DO $g400$
BEGIN
  IF to_regclass('public."workflow_steps"') IS NOT NULL THEN
    EXECUTE $s400$
GRANT SELECT, INSERT, UPDATE, DELETE ON "workflow_steps" TO streamline_app
$s400$;
  END IF;
END $g400$;
