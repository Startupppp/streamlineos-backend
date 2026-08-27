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
ALTER TABLE "acc_asset_categories" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "acc_asset_categories";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "acc_asset_categories"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "acc_asset_categories" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "acc_asset_categories" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "acc_depreciation_runs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "acc_depreciation_runs";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "acc_depreciation_runs"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "acc_depreciation_runs" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "acc_depreciation_runs" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "acc_depreciation_schedules" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "acc_depreciation_schedules";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "acc_depreciation_schedules"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "acc_depreciation_schedules" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "acc_depreciation_schedules" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "acc_fixed_assets" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "acc_fixed_assets";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "acc_fixed_assets"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "acc_fixed_assets" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "acc_fixed_assets" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "acc_number_sequences" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "acc_number_sequences";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "acc_number_sequences"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "acc_number_sequences" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "acc_number_sequences" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "acc_system_account_map" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "acc_system_account_map";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "acc_system_account_map"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "acc_system_account_map" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "acc_system_account_map" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "acc_tax_codes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "acc_tax_codes";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "acc_tax_codes"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "acc_tax_codes" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "acc_tax_codes" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "acc_tax_payments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "acc_tax_payments";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "acc_tax_payments"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "acc_tax_payments" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "acc_tax_payments" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "accounting_dimension_values" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "accounting_dimension_values";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "accounting_dimension_values"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "accounting_dimension_values" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "accounting_dimension_values" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "accounting_dimensions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "accounting_dimensions";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "accounting_dimensions"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "accounting_dimensions" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "accounting_dimensions" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "accounting_periods" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "accounting_periods";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "accounting_periods"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "accounting_periods" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "accounting_periods" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "accounting_settings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "accounting_settings";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "accounting_settings"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "accounting_settings" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "accounting_settings" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "ap_allocations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "ap_allocations";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ap_allocations"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "ap_allocations" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "ap_allocations" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "ap_document_lines" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "ap_document_lines";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ap_document_lines"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "ap_document_lines" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "ap_document_lines" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "ap_documents" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "ap_documents";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ap_documents"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "ap_documents" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "ap_documents" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "ap_payments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "ap_payments";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ap_payments"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "ap_payments" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "ap_payments" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "ap_withholding" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "ap_withholding";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ap_withholding"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "ap_withholding" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "ap_withholding" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "ar_allocations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "ar_allocations";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ar_allocations"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "ar_allocations" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "ar_allocations" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "ar_document_lines" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "ar_document_lines";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ar_document_lines"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "ar_document_lines" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "ar_document_lines" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "ar_documents" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "ar_documents";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ar_documents"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "ar_documents" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "ar_documents" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "ar_receipts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "ar_receipts";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ar_receipts"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "ar_receipts" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "ar_receipts" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "bank_matches" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "bank_matches";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "bank_matches"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "bank_matches" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "bank_matches" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "bank_profiles" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "bank_profiles";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "bank_profiles"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "bank_profiles" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "bank_profiles" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "bank_statement_lines" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "bank_statement_lines";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "bank_statement_lines"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "bank_statement_lines" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "bank_statement_lines" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "bank_statements" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "bank_statements";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "bank_statements"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "bank_statements" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "bank_statements" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "clients" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "clients";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "clients"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "clients" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "clients" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "contacts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "contacts";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "contacts"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "contacts" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "contacts" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "credit_notes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "credit_notes";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "credit_notes"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "credit_notes" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "credit_notes" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "crm_organizations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "crm_organizations";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "crm_organizations"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "crm_organizations" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "crm_organizations" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "fin_approval_policies" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "fin_approval_policies";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "fin_approval_policies"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "fin_approval_policies" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "fin_approval_policies" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "fin_approval_requests" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "fin_approval_requests";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "fin_approval_requests"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "fin_approval_requests" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "fin_approval_requests" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "fin_bank_accounts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "fin_bank_accounts";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "fin_bank_accounts"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "fin_bank_accounts" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "fin_bank_accounts" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "fin_bank_imports" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "fin_bank_imports";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "fin_bank_imports"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "fin_bank_imports" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "fin_bank_imports" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "fin_bank_transactions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "fin_bank_transactions";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "fin_bank_transactions"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "fin_bank_transactions" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "fin_bank_transactions" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "fin_bank_transfers" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "fin_bank_transfers";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "fin_bank_transfers"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "fin_bank_transfers" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "fin_bank_transfers" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "fin_budget_lines" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "fin_budget_lines";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "fin_budget_lines"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "fin_budget_lines" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "fin_budget_lines" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "fin_budget_revisions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "fin_budget_revisions";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "fin_budget_revisions"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "fin_budget_revisions" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "fin_budget_revisions" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "fin_budgets" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "fin_budgets";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "fin_budgets"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "fin_budgets" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "fin_budgets" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "fin_cash_flow_scenarios" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "fin_cash_flow_scenarios";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "fin_cash_flow_scenarios"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "fin_cash_flow_scenarios" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "fin_cash_flow_scenarios" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "fin_collection_activities" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "fin_collection_activities";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "fin_collection_activities"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "fin_collection_activities" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "fin_collection_activities" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "fin_exchange_rates" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "fin_exchange_rates";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "fin_exchange_rates"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "fin_exchange_rates" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "fin_exchange_rates" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "fin_expense_policies" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "fin_expense_policies";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "fin_expense_policies"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "fin_expense_policies" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "fin_expense_policies" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "fin_payment_allocations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "fin_payment_allocations";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "fin_payment_allocations"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "fin_payment_allocations" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "fin_payment_allocations" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "fin_payment_runs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "fin_payment_runs";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "fin_payment_runs"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "fin_payment_runs" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "fin_payment_runs" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "fin_reconciliation_matches" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "fin_reconciliation_matches";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "fin_reconciliation_matches"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "fin_reconciliation_matches" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "fin_reconciliation_matches" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "fin_reconciliation_rules" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "fin_reconciliation_rules";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "fin_reconciliation_rules"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "fin_reconciliation_rules" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "fin_reconciliation_rules" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "fin_recurring_bill_templates" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "fin_recurring_bill_templates";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "fin_recurring_bill_templates"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "fin_recurring_bill_templates" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "fin_recurring_bill_templates" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "fin_recurring_invoice_templates" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "fin_recurring_invoice_templates";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "fin_recurring_invoice_templates"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "fin_recurring_invoice_templates" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "fin_recurring_invoice_templates" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "fin_recurring_journal_templates" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "fin_recurring_journal_templates";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "fin_recurring_journal_templates"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "fin_recurring_journal_templates" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "fin_recurring_journal_templates" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "fin_reimbursement_batches" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "fin_reimbursement_batches";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "fin_reimbursement_batches"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "fin_reimbursement_batches" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "fin_reimbursement_batches" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "fin_reminder_log" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "fin_reminder_log";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "fin_reminder_log"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "fin_reminder_log" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "fin_reminder_log" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "fin_reminder_policies" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "fin_reminder_policies";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "fin_reminder_policies"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "fin_reminder_policies" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "fin_reminder_policies" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "fin_vendor_payment_allocations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "fin_vendor_payment_allocations";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "fin_vendor_payment_allocations"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "fin_vendor_payment_allocations" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "fin_vendor_payment_allocations" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "gl_accounts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "gl_accounts";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "gl_accounts"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "gl_accounts" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "gl_accounts" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "gl_book_currencies" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "gl_book_currencies";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "gl_book_currencies"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "gl_book_currencies" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "gl_book_currencies" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "gl_books" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "gl_books";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "gl_books"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "gl_books" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "gl_books" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "gl_document_attachments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "gl_document_attachments";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "gl_document_attachments"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "gl_document_attachments" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "gl_document_attachments" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "gl_document_compliance" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "gl_document_compliance";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "gl_document_compliance"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "gl_document_compliance" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "gl_document_compliance" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "gl_document_sequences" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "gl_document_sequences";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "gl_document_sequences"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "gl_document_sequences" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "gl_document_sequences" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "gl_fiscal_years" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "gl_fiscal_years";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "gl_fiscal_years"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "gl_fiscal_years" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "gl_fiscal_years" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "gl_fx_rates" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "gl_fx_rates";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "gl_fx_rates"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "gl_fx_rates" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "gl_fx_rates" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "gl_journal_lines" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "gl_journal_lines";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "gl_journal_lines"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "gl_journal_lines" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "gl_journal_lines" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "gl_journals" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "gl_journals";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "gl_journals"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "gl_journals" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "gl_journals" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "gl_parties" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "gl_parties";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "gl_parties"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "gl_parties" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "gl_parties" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "gl_periods" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "gl_periods";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "gl_periods"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "gl_periods" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "gl_periods" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "journal_entries" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "journal_entries";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "journal_entries"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "journal_entries" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "journal_entries" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "journal_lines" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "journal_lines";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "journal_lines"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "journal_lines" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "journal_lines" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "leads" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "leads";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "leads"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "leads" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "leads" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "ledger_accounts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "ledger_accounts";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ledger_accounts"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "ledger_accounts" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "ledger_accounts" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "notification_read_watermarks" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "notification_read_watermarks";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notification_read_watermarks"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "notification_read_watermarks" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "notification_read_watermarks" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "record_layout_adjustments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "record_layout_adjustments";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "record_layout_adjustments"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "record_layout_adjustments" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "record_layout_adjustments" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "subprocessor_subscribers" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "subprocessor_subscribers";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "subprocessor_subscribers"
  FOR ALL USING ("organization_id" = app.current_org_id())
  WITH CHECK ("organization_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "subprocessor_subscribers" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "subprocessor_subscribers" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "tax_codes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "tax_codes";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tax_codes"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "tax_codes" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "tax_codes" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "tax_document_lines" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "tax_document_lines";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tax_document_lines"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "tax_document_lines" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "tax_document_lines" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "tax_gl_map" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "tax_gl_map";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tax_gl_map"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "tax_gl_map" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "tax_gl_map" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "tax_rates" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "tax_rates";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tax_rates"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "tax_rates" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "tax_rates" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "tax_registrations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "tax_registrations";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tax_registrations"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "tax_registrations" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "tax_registrations" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "vendor_credits" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "vendor_credits";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "vendor_credits"
  FOR ALL USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "vendor_credits" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "vendor_credits" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "workflow_runs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "workflow_runs";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "workflow_runs"
  FOR ALL USING ("organization_id" = app.current_org_id())
  WITH CHECK ("organization_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "workflow_runs" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "workflow_runs" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "workflow_steps" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "workflow_steps";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "workflow_steps"
  FOR ALL USING ("organization_id" = app.current_org_id())
  WITH CHECK ("organization_id" = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "workflow_steps" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "workflow_steps" TO streamline_app;
