-- Guarded per table: some of the tables this names no longer exist.
--
-- The accounting rewrite replaced the pre-kernel finance tables and the party
-- migration replaced `leads`, and a statement against an absent table aborts the
-- whole migration. Each statement below now runs only if every table it names
-- exists — its target and anything it references. Where all of them are present
-- this is exactly the original file.

-- Objects the migration chain creates that the running control plane never received.
--
-- Generated from pg_catalog by src/scripts/generate-chain-repair.mjs --direction=drift.
-- 0320_recon_phase_a_orgid.sql sweeps the catalogue rather than naming its tables, so its
-- outcome depends on the shape of the database at the moment it runs. It covered 66 tables
-- in the control plane and 69 in a cold cell. This file closes that difference.

--
-- columns on tables that already exist (3)
--
--> statement-breakpoint
DO $g1$
BEGIN
  IF to_regclass('public."credit_note_items"') IS NOT NULL THEN
    EXECUTE $s1$
ALTER TABLE "public"."credit_note_items" ADD COLUMN IF NOT EXISTS "org_id" text
$s1$;
  END IF;
END $g1$;
--> statement-breakpoint
DO $g2$
BEGIN
  IF to_regclass('public."credit_note_items"') IS NOT NULL THEN
    EXECUTE $s2$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'credit_note_items' AND a.attname = 'org_id' AND a.attnotnull) THEN
    ALTER TABLE "public"."credit_note_items" ALTER COLUMN "org_id" SET NOT NULL;
  END IF;
END $repair$
$s2$;
  END IF;
END $g2$;
--> statement-breakpoint
DO $g3$
BEGIN
  IF to_regclass('public."fin_payment_run_items"') IS NOT NULL THEN
    EXECUTE $s3$
ALTER TABLE "public"."fin_payment_run_items" ADD COLUMN IF NOT EXISTS "org_id" text
$s3$;
  END IF;
END $g3$;
--> statement-breakpoint
DO $g4$
BEGIN
  IF to_regclass('public."fin_payment_run_items"') IS NOT NULL THEN
    EXECUTE $s4$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_payment_run_items' AND a.attname = 'org_id' AND a.attnotnull) THEN
    ALTER TABLE "public"."fin_payment_run_items" ALTER COLUMN "org_id" SET NOT NULL;
  END IF;
END $repair$
$s4$;
  END IF;
END $g4$;
--> statement-breakpoint
DO $g5$
BEGIN
  IF to_regclass('public."vendor_credit_items"') IS NOT NULL THEN
    EXECUTE $s5$
ALTER TABLE "public"."vendor_credit_items" ADD COLUMN IF NOT EXISTS "org_id" text
$s5$;
  END IF;
END $g5$;
--> statement-breakpoint
DO $g6$
BEGIN
  IF to_regclass('public."vendor_credit_items"') IS NOT NULL THEN
    EXECUTE $s6$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'vendor_credit_items' AND a.attname = 'org_id' AND a.attnotnull) THEN
    ALTER TABLE "public"."vendor_credit_items" ALTER COLUMN "org_id" SET NOT NULL;
  END IF;
END $repair$
$s6$;
  END IF;
END $g6$;
--> statement-breakpoint
--
-- columns whose declared type drifted (2)
--
--> statement-breakpoint
DO $g8$
BEGIN
  IF to_regclass('public."fin_budget_lines"') IS NOT NULL THEN
    EXECUTE $s8$
ALTER TABLE "public"."fin_budget_lines" ALTER COLUMN "department_id" TYPE text USING "department_id"::text
$s8$;
  END IF;
END $g8$;
--> statement-breakpoint
DO $g9$
BEGIN
  IF to_regclass('public."journal_lines"') IS NOT NULL THEN
    EXECUTE $s9$
ALTER TABLE "public"."journal_lines" ALTER COLUMN "department_id" TYPE text USING "department_id"::text
$s9$;
  END IF;
END $g9$;
--> statement-breakpoint
--
-- columns whose nullability drifted (1)
--
--> statement-breakpoint
DO $g11$
BEGIN
  IF to_regclass('public."journal_lines"') IS NOT NULL THEN
    EXECUTE $s11$
ALTER TABLE "public"."journal_lines" ALTER COLUMN "org_id" SET NOT NULL
$s11$;
  END IF;
END $g11$;
--> statement-breakpoint
--
-- primary keys, unique and check constraints (46)
--
--> statement-breakpoint
DO $g13$
BEGIN
  IF to_regclass('public."vendor_credit_items"') IS NOT NULL THEN
    EXECUTE $s13$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'vendor_credit_items' AND k.conname = 'uniq_vendor_credit_items_org_id') THEN
    ALTER TABLE "public"."vendor_credit_items" ADD CONSTRAINT "uniq_vendor_credit_items_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$
$s13$;
  END IF;
END $g13$;
--> statement-breakpoint
DO $g14$
BEGIN
  IF to_regclass('public."credit_note_items"') IS NOT NULL THEN
    EXECUTE $s14$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'credit_note_items' AND k.conname = 'uniq_credit_note_items_org_id') THEN
    ALTER TABLE "public"."credit_note_items" ADD CONSTRAINT "uniq_credit_note_items_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$
$s14$;
  END IF;
END $g14$;
--> statement-breakpoint
DO $g15$
BEGIN
  IF to_regclass('public."fin_payment_run_items"') IS NOT NULL THEN
    EXECUTE $s15$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_payment_run_items' AND k.conname = 'uniq_fin_payment_run_items_org_id') THEN
    ALTER TABLE "public"."fin_payment_run_items" ADD CONSTRAINT "uniq_fin_payment_run_items_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$
$s15$;
  END IF;
END $g15$;
--> statement-breakpoint
DO $g16$
BEGIN
  IF to_regclass('public."contacts"') IS NOT NULL THEN
    EXECUTE $s16$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'contacts' AND k.conname = 'uniq_contacts_org_id') THEN
    ALTER TABLE "public"."contacts" ADD CONSTRAINT "uniq_contacts_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$
$s16$;
  END IF;
END $g16$;
--> statement-breakpoint
DO $g17$
BEGIN
  IF to_regclass('public."crm_organizations"') IS NOT NULL THEN
    EXECUTE $s17$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_organizations' AND k.conname = 'uniq_crm_organizations_org_id') THEN
    ALTER TABLE "public"."crm_organizations" ADD CONSTRAINT "uniq_crm_organizations_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$
$s17$;
  END IF;
END $g17$;
--> statement-breakpoint
DO $g18$
BEGIN
  IF to_regclass('public."acc_number_sequences"') IS NOT NULL THEN
    EXECUTE $s18$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'acc_number_sequences' AND k.conname = 'uniq_acc_number_sequences_org_id') THEN
    ALTER TABLE "public"."acc_number_sequences" ADD CONSTRAINT "uniq_acc_number_sequences_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$
$s18$;
  END IF;
END $g18$;
--> statement-breakpoint
DO $g19$
BEGIN
  IF to_regclass('public."journal_entries"') IS NOT NULL THEN
    EXECUTE $s19$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'journal_entries' AND k.conname = 'uniq_journal_entries_org_id') THEN
    ALTER TABLE "public"."journal_entries" ADD CONSTRAINT "uniq_journal_entries_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$
$s19$;
  END IF;
END $g19$;
--> statement-breakpoint
DO $g20$
BEGIN
  IF to_regclass('public."acc_system_account_map"') IS NOT NULL THEN
    EXECUTE $s20$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'acc_system_account_map' AND k.conname = 'uniq_acc_system_account_map_org_id') THEN
    ALTER TABLE "public"."acc_system_account_map" ADD CONSTRAINT "uniq_acc_system_account_map_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$
$s20$;
  END IF;
END $g20$;
--> statement-breakpoint
DO $g21$
BEGIN
  IF to_regclass('public."accounting_dimension_values"') IS NOT NULL THEN
    EXECUTE $s21$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'accounting_dimension_values' AND k.conname = 'uniq_accounting_dimension_values_org_id') THEN
    ALTER TABLE "public"."accounting_dimension_values" ADD CONSTRAINT "uniq_accounting_dimension_values_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$
$s21$;
  END IF;
END $g21$;
--> statement-breakpoint
DO $g22$
BEGIN
  IF to_regclass('public."accounting_dimensions"') IS NOT NULL THEN
    EXECUTE $s22$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'accounting_dimensions' AND k.conname = 'uniq_accounting_dimensions_org_id') THEN
    ALTER TABLE "public"."accounting_dimensions" ADD CONSTRAINT "uniq_accounting_dimensions_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$
$s22$;
  END IF;
END $g22$;
--> statement-breakpoint
DO $g23$
BEGIN
  IF to_regclass('public."ledger_accounts"') IS NOT NULL THEN
    EXECUTE $s23$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ledger_accounts' AND k.conname = 'uniq_ledger_accounts_org_id') THEN
    ALTER TABLE "public"."ledger_accounts" ADD CONSTRAINT "uniq_ledger_accounts_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$
$s23$;
  END IF;
END $g23$;
--> statement-breakpoint
DO $g24$
BEGIN
  IF to_regclass('public."fin_approval_policies"') IS NOT NULL THEN
    EXECUTE $s24$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_approval_policies' AND k.conname = 'uniq_fin_approval_policies_org_id') THEN
    ALTER TABLE "public"."fin_approval_policies" ADD CONSTRAINT "uniq_fin_approval_policies_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$
$s24$;
  END IF;
END $g24$;
--> statement-breakpoint
DO $g25$
BEGIN
  IF to_regclass('public."fin_approval_requests"') IS NOT NULL THEN
    EXECUTE $s25$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_approval_requests' AND k.conname = 'uniq_fin_approval_requests_org_id') THEN
    ALTER TABLE "public"."fin_approval_requests" ADD CONSTRAINT "uniq_fin_approval_requests_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$
$s25$;
  END IF;
END $g25$;
--> statement-breakpoint
DO $g26$
BEGIN
  IF to_regclass('public."fin_exchange_rates"') IS NOT NULL THEN
    EXECUTE $s26$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_exchange_rates' AND k.conname = 'uniq_fin_exchange_rates_org_id') THEN
    ALTER TABLE "public"."fin_exchange_rates" ADD CONSTRAINT "uniq_fin_exchange_rates_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$
$s26$;
  END IF;
END $g26$;
--> statement-breakpoint
DO $g27$
BEGIN
  IF to_regclass('public."fin_recurring_journal_templates"') IS NOT NULL THEN
    EXECUTE $s27$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_recurring_journal_templates' AND k.conname = 'uniq_fin_recurring_journal_templates_org_id') THEN
    ALTER TABLE "public"."fin_recurring_journal_templates" ADD CONSTRAINT "uniq_fin_recurring_journal_templates_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$
$s27$;
  END IF;
END $g27$;
--> statement-breakpoint
DO $g28$
BEGIN
  IF to_regclass('public."credit_notes"') IS NOT NULL THEN
    EXECUTE $s28$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'credit_notes' AND k.conname = 'uniq_credit_notes_org_id') THEN
    ALTER TABLE "public"."credit_notes" ADD CONSTRAINT "uniq_credit_notes_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$
$s28$;
  END IF;
END $g28$;
--> statement-breakpoint
DO $g29$
BEGIN
  IF to_regclass('public."fin_collection_activities"') IS NOT NULL THEN
    EXECUTE $s29$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_collection_activities' AND k.conname = 'uniq_fin_collection_activities_org_id') THEN
    ALTER TABLE "public"."fin_collection_activities" ADD CONSTRAINT "uniq_fin_collection_activities_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$
$s29$;
  END IF;
END $g29$;
--> statement-breakpoint
DO $g30$
BEGIN
  IF to_regclass('public."accounting_settings"') IS NOT NULL THEN
    EXECUTE $s30$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'accounting_settings' AND k.conname = 'uniq_accounting_settings_org_id') THEN
    ALTER TABLE "public"."accounting_settings" ADD CONSTRAINT "uniq_accounting_settings_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$
$s30$;
  END IF;
END $g30$;
--> statement-breakpoint
DO $g31$
BEGIN
  IF to_regclass('public."fin_payment_runs"') IS NOT NULL THEN
    EXECUTE $s31$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_payment_runs' AND k.conname = 'uniq_fin_payment_runs_org_id') THEN
    ALTER TABLE "public"."fin_payment_runs" ADD CONSTRAINT "uniq_fin_payment_runs_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$
$s31$;
  END IF;
END $g31$;
--> statement-breakpoint
DO $g32$
BEGIN
  IF to_regclass('public."fin_recurring_bill_templates"') IS NOT NULL THEN
    EXECUTE $s32$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_recurring_bill_templates' AND k.conname = 'uniq_fin_recurring_bill_templates_org_id') THEN
    ALTER TABLE "public"."fin_recurring_bill_templates" ADD CONSTRAINT "uniq_fin_recurring_bill_templates_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$
$s32$;
  END IF;
END $g32$;
--> statement-breakpoint
DO $g33$
BEGIN
  IF to_regclass('public."fin_recurring_invoice_templates"') IS NOT NULL THEN
    EXECUTE $s33$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_recurring_invoice_templates' AND k.conname = 'uniq_fin_recurring_invoice_templates_org_id') THEN
    ALTER TABLE "public"."fin_recurring_invoice_templates" ADD CONSTRAINT "uniq_fin_recurring_invoice_templates_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$
$s33$;
  END IF;
END $g33$;
--> statement-breakpoint
DO $g34$
BEGIN
  IF to_regclass('public."fin_reminder_log"') IS NOT NULL THEN
    EXECUTE $s34$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_reminder_log' AND k.conname = 'uniq_fin_reminder_log_org_id') THEN
    ALTER TABLE "public"."fin_reminder_log" ADD CONSTRAINT "uniq_fin_reminder_log_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$
$s34$;
  END IF;
END $g34$;
--> statement-breakpoint
DO $g35$
BEGIN
  IF to_regclass('public."fin_reminder_policies"') IS NOT NULL THEN
    EXECUTE $s35$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_reminder_policies' AND k.conname = 'uniq_fin_reminder_policies_org_id') THEN
    ALTER TABLE "public"."fin_reminder_policies" ADD CONSTRAINT "uniq_fin_reminder_policies_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$
$s35$;
  END IF;
END $g35$;
--> statement-breakpoint
DO $g36$
BEGIN
  IF to_regclass('public."fin_vendor_payment_allocations"') IS NOT NULL THEN
    EXECUTE $s36$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_vendor_payment_allocations' AND k.conname = 'uniq_fin_vendor_payment_allocations_org_id') THEN
    ALTER TABLE "public"."fin_vendor_payment_allocations" ADD CONSTRAINT "uniq_fin_vendor_payment_allocations_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$
$s36$;
  END IF;
END $g36$;
--> statement-breakpoint
DO $g37$
BEGIN
  IF to_regclass('public."fin_bank_imports"') IS NOT NULL THEN
    EXECUTE $s37$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_bank_imports' AND k.conname = 'uniq_fin_bank_imports_org_id') THEN
    ALTER TABLE "public"."fin_bank_imports" ADD CONSTRAINT "uniq_fin_bank_imports_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$
$s37$;
  END IF;
END $g37$;
--> statement-breakpoint
DO $g38$
BEGIN
  IF to_regclass('public."fin_bank_transactions"') IS NOT NULL THEN
    EXECUTE $s38$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_bank_transactions' AND k.conname = 'uniq_fin_bank_transactions_org_id') THEN
    ALTER TABLE "public"."fin_bank_transactions" ADD CONSTRAINT "uniq_fin_bank_transactions_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$
$s38$;
  END IF;
END $g38$;
--> statement-breakpoint
DO $g39$
BEGIN
  IF to_regclass('public."fin_bank_transfers"') IS NOT NULL THEN
    EXECUTE $s39$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_bank_transfers' AND k.conname = 'uniq_fin_bank_transfers_org_id') THEN
    ALTER TABLE "public"."fin_bank_transfers" ADD CONSTRAINT "uniq_fin_bank_transfers_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$
$s39$;
  END IF;
END $g39$;
--> statement-breakpoint
DO $g40$
BEGIN
  IF to_regclass('public."fin_reconciliation_matches"') IS NOT NULL THEN
    EXECUTE $s40$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_reconciliation_matches' AND k.conname = 'uniq_fin_reconciliation_matches_org_id') THEN
    ALTER TABLE "public"."fin_reconciliation_matches" ADD CONSTRAINT "uniq_fin_reconciliation_matches_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$
$s40$;
  END IF;
END $g40$;
--> statement-breakpoint
DO $g41$
BEGIN
  IF to_regclass('public."fin_reconciliation_rules"') IS NOT NULL THEN
    EXECUTE $s41$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_reconciliation_rules' AND k.conname = 'uniq_fin_reconciliation_rules_org_id') THEN
    ALTER TABLE "public"."fin_reconciliation_rules" ADD CONSTRAINT "uniq_fin_reconciliation_rules_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$
$s41$;
  END IF;
END $g41$;
--> statement-breakpoint
DO $g42$
BEGIN
  IF to_regclass('public."acc_tax_codes"') IS NOT NULL THEN
    EXECUTE $s42$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'acc_tax_codes' AND k.conname = 'uniq_acc_tax_codes_org_id') THEN
    ALTER TABLE "public"."acc_tax_codes" ADD CONSTRAINT "uniq_acc_tax_codes_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$
$s42$;
  END IF;
END $g42$;
--> statement-breakpoint
DO $g43$
BEGIN
  IF to_regclass('public."acc_tax_payments"') IS NOT NULL THEN
    EXECUTE $s43$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'acc_tax_payments' AND k.conname = 'uniq_acc_tax_payments_org_id') THEN
    ALTER TABLE "public"."acc_tax_payments" ADD CONSTRAINT "uniq_acc_tax_payments_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$
$s43$;
  END IF;
END $g43$;
--> statement-breakpoint
DO $g44$
BEGIN
  IF to_regclass('public."fin_bank_accounts"') IS NOT NULL THEN
    EXECUTE $s44$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_bank_accounts' AND k.conname = 'uniq_fin_bank_accounts_org_id') THEN
    ALTER TABLE "public"."fin_bank_accounts" ADD CONSTRAINT "uniq_fin_bank_accounts_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$
$s44$;
  END IF;
END $g44$;
--> statement-breakpoint
DO $g45$
BEGIN
  IF to_regclass('public."fin_budget_revisions"') IS NOT NULL THEN
    EXECUTE $s45$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_budget_revisions' AND k.conname = 'uniq_fin_budget_revisions_org_id') THEN
    ALTER TABLE "public"."fin_budget_revisions" ADD CONSTRAINT "uniq_fin_budget_revisions_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$
$s45$;
  END IF;
END $g45$;
--> statement-breakpoint
DO $g46$
BEGIN
  IF to_regclass('public."fin_cash_flow_scenarios"') IS NOT NULL THEN
    EXECUTE $s46$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_cash_flow_scenarios' AND k.conname = 'uniq_fin_cash_flow_scenarios_org_id') THEN
    ALTER TABLE "public"."fin_cash_flow_scenarios" ADD CONSTRAINT "uniq_fin_cash_flow_scenarios_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$
$s46$;
  END IF;
END $g46$;
--> statement-breakpoint
DO $g47$
BEGIN
  IF to_regclass('public."acc_asset_categories"') IS NOT NULL THEN
    EXECUTE $s47$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'acc_asset_categories' AND k.conname = 'uniq_acc_asset_categories_org_id') THEN
    ALTER TABLE "public"."acc_asset_categories" ADD CONSTRAINT "uniq_acc_asset_categories_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$
$s47$;
  END IF;
END $g47$;
--> statement-breakpoint
DO $g48$
BEGIN
  IF to_regclass('public."acc_depreciation_runs"') IS NOT NULL THEN
    EXECUTE $s48$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'acc_depreciation_runs' AND k.conname = 'uniq_acc_depreciation_runs_org_id') THEN
    ALTER TABLE "public"."acc_depreciation_runs" ADD CONSTRAINT "uniq_acc_depreciation_runs_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$
$s48$;
  END IF;
END $g48$;
--> statement-breakpoint
DO $g49$
BEGIN
  IF to_regclass('public."acc_depreciation_schedules"') IS NOT NULL THEN
    EXECUTE $s49$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'acc_depreciation_schedules' AND k.conname = 'uniq_acc_depreciation_schedules_org_id') THEN
    ALTER TABLE "public"."acc_depreciation_schedules" ADD CONSTRAINT "uniq_acc_depreciation_schedules_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$
$s49$;
  END IF;
END $g49$;
--> statement-breakpoint
DO $g50$
BEGIN
  IF to_regclass('public."acc_fixed_assets"') IS NOT NULL THEN
    EXECUTE $s50$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'acc_fixed_assets' AND k.conname = 'uniq_acc_fixed_assets_org_id') THEN
    ALTER TABLE "public"."acc_fixed_assets" ADD CONSTRAINT "uniq_acc_fixed_assets_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$
$s50$;
  END IF;
END $g50$;
--> statement-breakpoint
DO $g51$
BEGIN
  IF to_regclass('public."leads"') IS NOT NULL THEN
    EXECUTE $s51$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'leads' AND k.conname = 'uniq_leads_org_id') THEN
    ALTER TABLE "public"."leads" ADD CONSTRAINT "uniq_leads_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$
$s51$;
  END IF;
END $g51$;
--> statement-breakpoint
DO $g52$
BEGIN
  IF to_regclass('public."clients"') IS NOT NULL THEN
    EXECUTE $s52$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'clients' AND k.conname = 'uniq_clients_org_id') THEN
    ALTER TABLE "public"."clients" ADD CONSTRAINT "uniq_clients_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$
$s52$;
  END IF;
END $g52$;
--> statement-breakpoint
DO $g53$
BEGIN
  IF to_regclass('public."accounting_periods"') IS NOT NULL THEN
    EXECUTE $s53$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'accounting_periods' AND k.conname = 'uniq_accounting_periods_org_id') THEN
    ALTER TABLE "public"."accounting_periods" ADD CONSTRAINT "uniq_accounting_periods_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$
$s53$;
  END IF;
END $g53$;
--> statement-breakpoint
DO $g54$
BEGIN
  IF to_regclass('public."fin_payment_allocations"') IS NOT NULL THEN
    EXECUTE $s54$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_payment_allocations' AND k.conname = 'uniq_fin_payment_allocations_org_id') THEN
    ALTER TABLE "public"."fin_payment_allocations" ADD CONSTRAINT "uniq_fin_payment_allocations_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$
$s54$;
  END IF;
END $g54$;
--> statement-breakpoint
DO $g55$
BEGIN
  IF to_regclass('public."vendor_credits"') IS NOT NULL THEN
    EXECUTE $s55$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'vendor_credits' AND k.conname = 'uniq_vendor_credits_org_id') THEN
    ALTER TABLE "public"."vendor_credits" ADD CONSTRAINT "uniq_vendor_credits_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$
$s55$;
  END IF;
END $g55$;
--> statement-breakpoint
DO $g56$
BEGIN
  IF to_regclass('public."fin_budgets"') IS NOT NULL THEN
    EXECUTE $s56$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_budgets' AND k.conname = 'uniq_fin_budgets_org_id') THEN
    ALTER TABLE "public"."fin_budgets" ADD CONSTRAINT "uniq_fin_budgets_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$
$s56$;
  END IF;
END $g56$;
--> statement-breakpoint
DO $g57$
BEGIN
  IF to_regclass('public."fin_budget_lines"') IS NOT NULL THEN
    EXECUTE $s57$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_budget_lines' AND k.conname = 'uniq_fin_budget_lines_org_id') THEN
    ALTER TABLE "public"."fin_budget_lines" ADD CONSTRAINT "uniq_fin_budget_lines_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$
$s57$;
  END IF;
END $g57$;
--> statement-breakpoint
DO $g58$
BEGIN
  IF to_regclass('public."autonomy_holds"') IS NOT NULL THEN
    EXECUTE $s58$
DO $repair$ BEGIN
  -- Not restored where `chk_autonomy_holds_arc` has replaced it. 0535 dropped
  -- `chk_autonomy_holds_target` deliberately: CHECK (quote_id IS NOT NULL) is not
  -- an arc, it forbids the outbound arm outright, and holds carry an outbound
  -- message rather than a quote since ticket 07. Re-adding it here made every
  -- held send fail its own insert. The absence is the newer design, not drift.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'autonomy_holds' AND k.conname IN ('chk_autonomy_holds_target', 'chk_autonomy_holds_arc')) THEN
    ALTER TABLE "public"."autonomy_holds" ADD CONSTRAINT "chk_autonomy_holds_target" CHECK ((quote_id IS NOT NULL));
  END IF;
END $repair$
$s58$;
  END IF;
END $g58$;
--> statement-breakpoint
--
-- not-null constraints (4)
--
--> statement-breakpoint
DO $g60$
BEGIN
  IF to_regclass('public."journal_lines"') IS NOT NULL THEN
    EXECUTE $s60$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'journal_lines' AND k.conname = 'journal_lines_org_id_not_null') THEN
    ALTER TABLE "public"."journal_lines" ADD CONSTRAINT "journal_lines_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$
$s60$;
  END IF;
END $g60$;
--> statement-breakpoint
DO $g61$
BEGIN
  IF to_regclass('public."vendor_credit_items"') IS NOT NULL THEN
    EXECUTE $s61$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'vendor_credit_items' AND k.conname = 'vendor_credit_items_org_id_not_null') THEN
    ALTER TABLE "public"."vendor_credit_items" ADD CONSTRAINT "vendor_credit_items_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$
$s61$;
  END IF;
END $g61$;
--> statement-breakpoint
DO $g62$
BEGIN
  IF to_regclass('public."credit_note_items"') IS NOT NULL THEN
    EXECUTE $s62$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'credit_note_items' AND k.conname = 'credit_note_items_org_id_not_null') THEN
    ALTER TABLE "public"."credit_note_items" ADD CONSTRAINT "credit_note_items_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$
$s62$;
  END IF;
END $g62$;
--> statement-breakpoint
DO $g63$
BEGIN
  IF to_regclass('public."fin_payment_run_items"') IS NOT NULL THEN
    EXECUTE $s63$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_payment_run_items' AND k.conname = 'fin_payment_run_items_org_id_not_null') THEN
    ALTER TABLE "public"."fin_payment_run_items" ADD CONSTRAINT "fin_payment_run_items_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$
$s63$;
  END IF;
END $g63$;
--> statement-breakpoint
--
-- foreign keys (107)
--
--> statement-breakpoint
DO $g65$
BEGIN
  IF to_regclass('public."calendar_events"') IS NOT NULL AND to_regclass('public."leads"') IS NOT NULL THEN
    EXECUTE $s65$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'calendar_events' AND k.conname = 'fk_calendar_events_linked_lead') THEN
    ALTER TABLE "public"."calendar_events" ADD CONSTRAINT "fk_calendar_events_linked_lead" FOREIGN KEY (linked_lead_id) REFERENCES leads(id) ON DELETE SET NULL;
  END IF;
END $repair$
$s65$;
  END IF;
END $g65$;
--> statement-breakpoint
DO $g66$
BEGIN
  IF to_regclass('public."clients"') IS NOT NULL AND to_regclass('public."timesheet_rates"') IS NOT NULL THEN
    EXECUTE $s66$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'timesheet_rates' AND k.conname = 'fk_timesheet_rates_client') THEN
    ALTER TABLE "public"."timesheet_rates" ADD CONSTRAINT "fk_timesheet_rates_client" FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL;
  END IF;
END $repair$
$s66$;
  END IF;
END $g66$;
--> statement-breakpoint
DO $g67$
BEGIN
  IF to_regclass('public."journal_lines"') IS NOT NULL AND to_regclass('public."org_units"') IS NOT NULL THEN
    EXECUTE $s67$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'journal_lines' AND k.conname = 'fk_journal_lines_department') THEN
    ALTER TABLE "public"."journal_lines" ADD CONSTRAINT "fk_journal_lines_department" FOREIGN KEY (department_id) REFERENCES org_units(id) ON DELETE SET NULL;
  END IF;
END $repair$
$s67$;
  END IF;
END $g67$;
--> statement-breakpoint
DO $g68$
BEGIN
  IF to_regclass('public."fin_budget_lines"') IS NOT NULL AND to_regclass('public."org_units"') IS NOT NULL THEN
    EXECUTE $s68$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_budget_lines' AND k.conname = 'fk_fin_budget_lines_department') THEN
    ALTER TABLE "public"."fin_budget_lines" ADD CONSTRAINT "fk_fin_budget_lines_department" FOREIGN KEY (department_id) REFERENCES org_units(id) ON DELETE SET NULL;
  END IF;
END $repair$
$s68$;
  END IF;
END $g68$;
--> statement-breakpoint
DO $g69$
BEGIN
  IF to_regclass('public."journal_entries"') IS NOT NULL AND to_regclass('public."journal_lines"') IS NOT NULL THEN
    EXECUTE $s69$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'journal_lines' AND k.conname = 'fk_jl_org_entry') THEN
    ALTER TABLE "public"."journal_lines" ADD CONSTRAINT "fk_jl_org_entry" FOREIGN KEY (org_id, entry_id) REFERENCES journal_entries(org_id, id) ON DELETE CASCADE;
  END IF;
END $repair$
$s69$;
  END IF;
END $g69$;
--> statement-breakpoint
DO $g70$
BEGIN
  IF to_regclass('public."build"') IS NOT NULL AND to_regclass('public."contacts"') IS NOT NULL THEN
    EXECUTE $s70$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'build' AND c.relname = 'feedback_posts' AND k.conname = 'fk_feedback_posts_crm_contact') THEN
    ALTER TABLE "build"."feedback_posts" ADD CONSTRAINT "fk_feedback_posts_crm_contact" FOREIGN KEY (crm_contact_id) REFERENCES contacts(id) ON DELETE SET NULL;
  END IF;
END $repair$
$s70$;
  END IF;
END $g70$;
--> statement-breakpoint
DO $g71$
BEGIN
  IF to_regclass('public."fin_budget_lines"') IS NOT NULL THEN
    EXECUTE $s71$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_budget_lines' AND k.conname = 'fin_budget_lines_project_id_projects_id_fk') THEN
    ALTER TABLE "public"."fin_budget_lines" ADD CONSTRAINT "fin_budget_lines_project_id_projects_id_fk" FOREIGN KEY (project_id) REFERENCES build.projects(id);
  END IF;
END $repair$
$s71$;
  END IF;
END $g71$;
--> statement-breakpoint
DO $g72$
BEGIN
  IF to_regclass('public."fin_expense_policies"') IS NOT NULL AND to_regclass('public."organizations"') IS NOT NULL THEN
    EXECUTE $s72$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_expense_policies' AND k.conname = 'fin_expense_policies_org_id_organizations_id_fk') THEN
    ALTER TABLE "public"."fin_expense_policies" ADD CONSTRAINT "fin_expense_policies_org_id_organizations_id_fk" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$
$s72$;
  END IF;
END $g72$;
--> statement-breakpoint
DO $g73$
BEGIN
  IF to_regclass('public."expense_categories"') IS NOT NULL AND to_regclass('public."fin_expense_policies"') IS NOT NULL THEN
    EXECUTE $s73$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_expense_policies' AND k.conname = 'fin_expense_policies_category_id_expense_categories_id_fk') THEN
    ALTER TABLE "public"."fin_expense_policies" ADD CONSTRAINT "fin_expense_policies_category_id_expense_categories_id_fk" FOREIGN KEY (category_id) REFERENCES expense_categories(id) ON DELETE SET NULL;
  END IF;
END $repair$
$s73$;
  END IF;
END $g73$;
--> statement-breakpoint
DO $g74$
BEGIN
  IF to_regclass('public."fin_reimbursement_batches"') IS NOT NULL AND to_regclass('public."organizations"') IS NOT NULL THEN
    EXECUTE $s74$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_reimbursement_batches' AND k.conname = 'fin_reimbursement_batches_org_id_organizations_id_fk') THEN
    ALTER TABLE "public"."fin_reimbursement_batches" ADD CONSTRAINT "fin_reimbursement_batches_org_id_organizations_id_fk" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$
$s74$;
  END IF;
END $g74$;
--> statement-breakpoint
DO $g75$
BEGIN
  IF to_regclass('public."fin_reimbursement_batches"') IS NOT NULL AND to_regclass('public."journal_entries"') IS NOT NULL THEN
    EXECUTE $s75$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_reimbursement_batches' AND k.conname = 'fin_reimbursement_batches_journal_entry_id_journal_entries_id_f') THEN
    ALTER TABLE "public"."fin_reimbursement_batches" ADD CONSTRAINT "fin_reimbursement_batches_journal_entry_id_journal_entries_id_f" FOREIGN KEY (journal_entry_id) REFERENCES journal_entries(id);
  END IF;
END $repair$
$s75$;
  END IF;
END $g75$;
--> statement-breakpoint
DO $g76$
BEGIN
  IF to_regclass('public."fin_bank_accounts"') IS NOT NULL AND to_regclass('public."fin_reimbursement_batches"') IS NOT NULL THEN
    EXECUTE $s76$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_reimbursement_batches' AND k.conname = 'fin_reimbursement_batches_bank_account_id_fin_bank_accounts_id_') THEN
    ALTER TABLE "public"."fin_reimbursement_batches" ADD CONSTRAINT "fin_reimbursement_batches_bank_account_id_fin_bank_accounts_id_" FOREIGN KEY (bank_account_id) REFERENCES fin_bank_accounts(id);
  END IF;
END $repair$
$s76$;
  END IF;
END $g76$;
--> statement-breakpoint
DO $g77$
BEGIN
  IF to_regclass('public."fin_reimbursement_batches"') IS NOT NULL AND to_regclass('public."users"') IS NOT NULL THEN
    EXECUTE $s77$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_reimbursement_batches' AND k.conname = 'fin_reimbursement_batches_created_by_users_id_fk') THEN
    ALTER TABLE "public"."fin_reimbursement_batches" ADD CONSTRAINT "fin_reimbursement_batches_created_by_users_id_fk" FOREIGN KEY (created_by) REFERENCES users(id);
  END IF;
END $repair$
$s77$;
  END IF;
END $g77$;
--> statement-breakpoint
DO $g78$
BEGIN
  IF to_regclass('public."fin_reimbursement_batches"') IS NOT NULL AND to_regclass('public."users"') IS NOT NULL THEN
    EXECUTE $s78$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_reimbursement_batches' AND k.conname = 'fin_reimbursement_batches_approved_by_users_id_fk') THEN
    ALTER TABLE "public"."fin_reimbursement_batches" ADD CONSTRAINT "fin_reimbursement_batches_approved_by_users_id_fk" FOREIGN KEY (approved_by) REFERENCES users(id);
  END IF;
END $repair$
$s78$;
  END IF;
END $g78$;
--> statement-breakpoint
DO $g79$
BEGIN
  IF to_regclass('public."organizations"') IS NOT NULL AND to_regclass('public."vendor_credit_items"') IS NOT NULL THEN
    EXECUTE $s79$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'vendor_credit_items' AND k.conname = 'vendor_credit_items_org_id_fk') THEN
    ALTER TABLE "public"."vendor_credit_items" ADD CONSTRAINT "vendor_credit_items_org_id_fk" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$
$s79$;
  END IF;
END $g79$;
--> statement-breakpoint
DO $g80$
BEGIN
  IF to_regclass('public."credit_note_items"') IS NOT NULL AND to_regclass('public."organizations"') IS NOT NULL THEN
    EXECUTE $s80$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'credit_note_items' AND k.conname = 'credit_note_items_org_id_fk') THEN
    ALTER TABLE "public"."credit_note_items" ADD CONSTRAINT "credit_note_items_org_id_fk" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$
$s80$;
  END IF;
END $g80$;
--> statement-breakpoint
DO $g81$
BEGIN
  IF to_regclass('public."fin_payment_run_items"') IS NOT NULL AND to_regclass('public."organizations"') IS NOT NULL THEN
    EXECUTE $s81$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_payment_run_items' AND k.conname = 'fin_payment_run_items_org_id_fk') THEN
    ALTER TABLE "public"."fin_payment_run_items" ADD CONSTRAINT "fin_payment_run_items_org_id_fk" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$
$s81$;
  END IF;
END $g81$;
--> statement-breakpoint
DO $g82$
BEGIN
  IF to_regclass('public."expense_categories"') IS NOT NULL AND to_regclass('public."ledger_accounts"') IS NOT NULL THEN
    EXECUTE $s82$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'expense_categories' AND k.conname = 'fk_expense_categories_ledger_account_id_org') THEN
    ALTER TABLE "public"."expense_categories" ADD CONSTRAINT "fk_expense_categories_ledger_account_id_org" FOREIGN KEY (org_id, ledger_account_id) REFERENCES ledger_accounts(org_id, id);
  END IF;
END $repair$
$s82$;
  END IF;
END $g82$;
--> statement-breakpoint
DO $g83$
BEGIN
  IF to_regclass('public."expenses"') IS NOT NULL AND to_regclass('public."journal_entries"') IS NOT NULL THEN
    EXECUTE $s83$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'expenses' AND k.conname = 'fk_expenses_posted_journal_entry_id_org') THEN
    ALTER TABLE "public"."expenses" ADD CONSTRAINT "fk_expenses_posted_journal_entry_id_org" FOREIGN KEY (org_id, posted_journal_entry_id) REFERENCES journal_entries(org_id, id);
  END IF;
END $repair$
$s83$;
  END IF;
END $g83$;
--> statement-breakpoint
DO $g84$
BEGIN
  IF to_regclass('public."lead_activities"') IS NOT NULL AND to_regclass('public."leads"') IS NOT NULL THEN
    EXECUTE $s84$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'lead_activities' AND k.conname = 'fk_lead_activities_lead_id_org') THEN
    ALTER TABLE "public"."lead_activities" ADD CONSTRAINT "fk_lead_activities_lead_id_org" FOREIGN KEY (org_id, lead_id) REFERENCES leads(org_id, id);
  END IF;
END $repair$
$s84$;
  END IF;
END $g84$;
--> statement-breakpoint
DO $g85$
BEGIN
  IF to_regclass('public."lead_emails"') IS NOT NULL AND to_regclass('public."leads"') IS NOT NULL THEN
    EXECUTE $s85$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'lead_emails' AND k.conname = 'fk_lead_emails_lead_id_org') THEN
    ALTER TABLE "public"."lead_emails" ADD CONSTRAINT "fk_lead_emails_lead_id_org" FOREIGN KEY (org_id, lead_id) REFERENCES leads(org_id, id);
  END IF;
END $repair$
$s85$;
  END IF;
END $g85$;
--> statement-breakpoint
DO $g86$
BEGIN
  IF to_regclass('public."lead_notes"') IS NOT NULL AND to_regclass('public."leads"') IS NOT NULL THEN
    EXECUTE $s86$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'lead_notes' AND k.conname = 'fk_lead_notes_lead_id_org') THEN
    ALTER TABLE "public"."lead_notes" ADD CONSTRAINT "fk_lead_notes_lead_id_org" FOREIGN KEY (org_id, lead_id) REFERENCES leads(org_id, id);
  END IF;
END $repair$
$s86$;
  END IF;
END $g86$;
--> statement-breakpoint
DO $g87$
BEGIN
  IF to_regclass('public."lead_tasks"') IS NOT NULL AND to_regclass('public."leads"') IS NOT NULL THEN
    EXECUTE $s87$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'lead_tasks' AND k.conname = 'fk_lead_tasks_lead_id_org') THEN
    ALTER TABLE "public"."lead_tasks" ADD CONSTRAINT "fk_lead_tasks_lead_id_org" FOREIGN KEY (org_id, lead_id) REFERENCES leads(org_id, id);
  END IF;
END $repair$
$s87$;
  END IF;
END $g87$;
--> statement-breakpoint
DO $g88$
BEGIN
  IF to_regclass('public."crm_campaigns"') IS NOT NULL AND to_regclass('public."leads"') IS NOT NULL THEN
    EXECUTE $s88$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'leads' AND k.conname = 'fk_leads_campaign_id_org') THEN
    ALTER TABLE "public"."leads" ADD CONSTRAINT "fk_leads_campaign_id_org" FOREIGN KEY (org_id, campaign_id) REFERENCES crm_campaigns(org_id, id);
  END IF;
END $repair$
$s88$;
  END IF;
END $g88$;
--> statement-breakpoint
DO $g89$
BEGIN
  IF to_regclass('public."leads"') IS NOT NULL THEN
    EXECUTE $s89$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'leads' AND k.conname = 'fk_leads_merged_into_id_org') THEN
    ALTER TABLE "public"."leads" ADD CONSTRAINT "fk_leads_merged_into_id_org" FOREIGN KEY (org_id, merged_into_id) REFERENCES leads(org_id, id);
  END IF;
END $repair$
$s89$;
  END IF;
END $g89$;
--> statement-breakpoint
DO $g90$
BEGIN
  IF to_regclass('public."client_accounts"') IS NOT NULL AND to_regclass('public."leads"') IS NOT NULL THEN
    EXECUTE $s90$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'client_accounts' AND k.conname = 'fk_client_accounts_lead_id_org') THEN
    ALTER TABLE "public"."client_accounts" ADD CONSTRAINT "fk_client_accounts_lead_id_org" FOREIGN KEY (org_id, lead_id) REFERENCES leads(org_id, id);
  END IF;
END $repair$
$s90$;
  END IF;
END $g90$;
--> statement-breakpoint
DO $g91$
BEGIN
  IF to_regclass('public."client_onboarding_items"') IS NOT NULL AND to_regclass('public."clients"') IS NOT NULL THEN
    EXECUTE $s91$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'client_onboarding_items' AND k.conname = 'fk_client_onboarding_items_client_id_org') THEN
    ALTER TABLE "public"."client_onboarding_items" ADD CONSTRAINT "fk_client_onboarding_items_client_id_org" FOREIGN KEY (org_id, client_id) REFERENCES clients(org_id, id);
  END IF;
END $repair$
$s91$;
  END IF;
END $g91$;
--> statement-breakpoint
DO $g92$
BEGIN
  IF to_regclass('public."client_opportunities"') IS NOT NULL AND to_regclass('public."clients"') IS NOT NULL THEN
    EXECUTE $s92$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'client_opportunities' AND k.conname = 'fk_client_opportunities_client_id_org') THEN
    ALTER TABLE "public"."client_opportunities" ADD CONSTRAINT "fk_client_opportunities_client_id_org" FOREIGN KEY (org_id, client_id) REFERENCES clients(org_id, id);
  END IF;
END $repair$
$s92$;
  END IF;
END $g92$;
--> statement-breakpoint
DO $g93$
BEGIN
  IF to_regclass('public."clients"') IS NOT NULL AND to_regclass('public."leads"') IS NOT NULL THEN
    EXECUTE $s93$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'clients' AND k.conname = 'fk_clients_lead_id_org') THEN
    ALTER TABLE "public"."clients" ADD CONSTRAINT "fk_clients_lead_id_org" FOREIGN KEY (org_id, lead_id) REFERENCES leads(org_id, id);
  END IF;
END $repair$
$s93$;
  END IF;
END $g93$;
--> statement-breakpoint
DO $g94$
BEGIN
  IF to_regclass('public."contacts"') IS NOT NULL AND to_regclass('public."crm_organizations"') IS NOT NULL THEN
    EXECUTE $s94$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'contacts' AND k.conname = 'fk_contacts_organization_id_org') THEN
    ALTER TABLE "public"."contacts" ADD CONSTRAINT "fk_contacts_organization_id_org" FOREIGN KEY (org_id, organization_id) REFERENCES crm_organizations(org_id, id);
  END IF;
END $repair$
$s94$;
  END IF;
END $g94$;
--> statement-breakpoint
DO $g95$
BEGIN
  IF to_regclass('public."contacts"') IS NOT NULL AND to_regclass('public."leads"') IS NOT NULL THEN
    EXECUTE $s95$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'contacts' AND k.conname = 'fk_contacts_lead_id_org') THEN
    ALTER TABLE "public"."contacts" ADD CONSTRAINT "fk_contacts_lead_id_org" FOREIGN KEY (org_id, lead_id) REFERENCES leads(org_id, id);
  END IF;
END $repair$
$s95$;
  END IF;
END $g95$;
--> statement-breakpoint
DO $g96$
BEGIN
  IF to_regclass('public."crm_organizations"') IS NOT NULL THEN
    EXECUTE $s96$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_organizations' AND k.conname = 'fk_crm_organizations_parent_id_org') THEN
    ALTER TABLE "public"."crm_organizations" ADD CONSTRAINT "fk_crm_organizations_parent_id_org" FOREIGN KEY (org_id, parent_id) REFERENCES crm_organizations(org_id, id);
  END IF;
END $repair$
$s96$;
  END IF;
END $g96$;
--> statement-breakpoint
DO $g97$
BEGIN
  IF to_regclass('public."clients"') IS NOT NULL AND to_regclass('public."csat_surveys"') IS NOT NULL THEN
    EXECUTE $s97$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'csat_surveys' AND k.conname = 'fk_csat_surveys_client_id_org') THEN
    ALTER TABLE "public"."csat_surveys" ADD CONSTRAINT "fk_csat_surveys_client_id_org" FOREIGN KEY (org_id, client_id) REFERENCES clients(org_id, id);
  END IF;
END $repair$
$s97$;
  END IF;
END $g97$;
--> statement-breakpoint
DO $g98$
BEGIN
  IF to_regclass('public."contacts"') IS NOT NULL AND to_regclass('public."crm_contact_roles"') IS NOT NULL THEN
    EXECUTE $s98$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_contact_roles' AND k.conname = 'fk_crm_contact_roles_contact_id_org') THEN
    ALTER TABLE "public"."crm_contact_roles" ADD CONSTRAINT "fk_crm_contact_roles_contact_id_org" FOREIGN KEY (org_id, contact_id) REFERENCES contacts(org_id, id);
  END IF;
END $repair$
$s98$;
  END IF;
END $g98$;
--> statement-breakpoint
DO $g99$
BEGIN
  IF to_regclass('public."contacts"') IS NOT NULL AND to_regclass('public."crm_deal_stakeholders"') IS NOT NULL THEN
    EXECUTE $s99$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_deal_stakeholders' AND k.conname = 'fk_crm_deal_stakeholders_contact_id_org') THEN
    ALTER TABLE "public"."crm_deal_stakeholders" ADD CONSTRAINT "fk_crm_deal_stakeholders_contact_id_org" FOREIGN KEY (org_id, contact_id) REFERENCES contacts(org_id, id);
  END IF;
END $repair$
$s99$;
  END IF;
END $g99$;
--> statement-breakpoint
DO $g100$
BEGIN
  IF to_regclass('public."deals"') IS NOT NULL AND to_regclass('public."leads"') IS NOT NULL THEN
    EXECUTE $s100$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'deals' AND k.conname = 'fk_deals_lead_id_org') THEN
    ALTER TABLE "public"."deals" ADD CONSTRAINT "fk_deals_lead_id_org" FOREIGN KEY (org_id, lead_id) REFERENCES leads(org_id, id);
  END IF;
END $repair$
$s100$;
  END IF;
END $g100$;
--> statement-breakpoint
DO $g101$
BEGIN
  IF to_regclass('public."clients"') IS NOT NULL AND to_regclass('public."deals"') IS NOT NULL THEN
    EXECUTE $s101$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'deals' AND k.conname = 'fk_deals_client_id_org') THEN
    ALTER TABLE "public"."deals" ADD CONSTRAINT "fk_deals_client_id_org" FOREIGN KEY (org_id, client_id) REFERENCES clients(org_id, id);
  END IF;
END $repair$
$s101$;
  END IF;
END $g101$;
--> statement-breakpoint
DO $g102$
BEGIN
  IF to_regclass('public."clients"') IS NOT NULL AND to_regclass('public."invoices"') IS NOT NULL THEN
    EXECUTE $s102$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'invoices' AND k.conname = 'fk_invoices_client_id_org') THEN
    ALTER TABLE "public"."invoices" ADD CONSTRAINT "fk_invoices_client_id_org" FOREIGN KEY (org_id, client_id) REFERENCES clients(org_id, id);
  END IF;
END $repair$
$s102$;
  END IF;
END $g102$;
--> statement-breakpoint
DO $g103$
BEGIN
  IF to_regclass('public."clients"') IS NOT NULL AND to_regclass('public."purchase_bills"') IS NOT NULL THEN
    EXECUTE $s103$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'purchase_bills' AND k.conname = 'fk_purchase_bills_vendor_id_org') THEN
    ALTER TABLE "public"."purchase_bills" ADD CONSTRAINT "fk_purchase_bills_vendor_id_org" FOREIGN KEY (org_id, vendor_id) REFERENCES clients(org_id, id);
  END IF;
END $repair$
$s103$;
  END IF;
END $g103$;
--> statement-breakpoint
DO $g104$
BEGIN
  IF to_regclass('public."clients"') IS NOT NULL AND to_regclass('public."support_tickets"') IS NOT NULL THEN
    EXECUTE $s104$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'support_tickets' AND k.conname = 'fk_support_tickets_client_id_org') THEN
    ALTER TABLE "public"."support_tickets" ADD CONSTRAINT "fk_support_tickets_client_id_org" FOREIGN KEY (org_id, client_id) REFERENCES clients(org_id, id);
  END IF;
END $repair$
$s104$;
  END IF;
END $g104$;
--> statement-breakpoint
DO $g105$
BEGIN
  IF to_regclass('public."crm_lead_touchpoints"') IS NOT NULL AND to_regclass('public."leads"') IS NOT NULL THEN
    EXECUTE $s105$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_lead_touchpoints' AND k.conname = 'fk_crm_lead_touchpoints_lead_id_org') THEN
    ALTER TABLE "public"."crm_lead_touchpoints" ADD CONSTRAINT "fk_crm_lead_touchpoints_lead_id_org" FOREIGN KEY (org_id, lead_id) REFERENCES leads(org_id, id);
  END IF;
END $repair$
$s105$;
  END IF;
END $g105$;
--> statement-breakpoint
DO $g106$
BEGIN
  IF to_regclass('public."journal_entries"') IS NOT NULL THEN
    EXECUTE $s106$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'journal_entries' AND k.conname = 'fk_journal_entries_reversed_entry_id_org') THEN
    ALTER TABLE "public"."journal_entries" ADD CONSTRAINT "fk_journal_entries_reversed_entry_id_org" FOREIGN KEY (org_id, reversed_entry_id) REFERENCES journal_entries(org_id, id);
  END IF;
END $repair$
$s106$;
  END IF;
END $g106$;
--> statement-breakpoint
DO $g107$
BEGIN
  IF to_regclass('public."ledger_accounts"') IS NOT NULL THEN
    EXECUTE $s107$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ledger_accounts' AND k.conname = 'fk_ledger_accounts_parent_account_id_org') THEN
    ALTER TABLE "public"."ledger_accounts" ADD CONSTRAINT "fk_ledger_accounts_parent_account_id_org" FOREIGN KEY (org_id, parent_account_id) REFERENCES ledger_accounts(org_id, id);
  END IF;
END $repair$
$s107$;
  END IF;
END $g107$;
--> statement-breakpoint
DO $g108$
BEGIN
  IF to_regclass('public."acc_system_account_map"') IS NOT NULL AND to_regclass('public."ledger_accounts"') IS NOT NULL THEN
    EXECUTE $s108$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'acc_system_account_map' AND k.conname = 'fk_acc_system_account_map_account_id_org') THEN
    ALTER TABLE "public"."acc_system_account_map" ADD CONSTRAINT "fk_acc_system_account_map_account_id_org" FOREIGN KEY (org_id, account_id) REFERENCES ledger_accounts(org_id, id);
  END IF;
END $repair$
$s108$;
  END IF;
END $g108$;
--> statement-breakpoint
DO $g109$
BEGIN
  IF to_regclass('public."accounting_dimension_values"') IS NOT NULL AND to_regclass('public."accounting_dimensions"') IS NOT NULL THEN
    EXECUTE $s109$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'accounting_dimension_values' AND k.conname = 'fk_accounting_dimension_values_dimension_id_org') THEN
    ALTER TABLE "public"."accounting_dimension_values" ADD CONSTRAINT "fk_accounting_dimension_values_dimension_id_org" FOREIGN KEY (org_id, dimension_id) REFERENCES accounting_dimensions(org_id, id);
  END IF;
END $repair$
$s109$;
  END IF;
END $g109$;
--> statement-breakpoint
DO $g110$
BEGIN
  IF to_regclass('public."accounting_settings"') IS NOT NULL AND to_regclass('public."ledger_accounts"') IS NOT NULL THEN
    EXECUTE $s110$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'accounting_settings' AND k.conname = 'fk_accounting_settings_retained_earnings_account_id_org') THEN
    ALTER TABLE "public"."accounting_settings" ADD CONSTRAINT "fk_accounting_settings_retained_earnings_account_id_org" FOREIGN KEY (org_id, retained_earnings_account_id) REFERENCES ledger_accounts(org_id, id);
  END IF;
END $repair$
$s110$;
  END IF;
END $g110$;
--> statement-breakpoint
DO $g111$
BEGIN
  IF to_regclass('public."credit_note_items"') IS NOT NULL AND to_regclass('public."credit_notes"') IS NOT NULL THEN
    EXECUTE $s111$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'credit_note_items' AND k.conname = 'fk_credit_note_items_credit_note_id_org') THEN
    ALTER TABLE "public"."credit_note_items" ADD CONSTRAINT "fk_credit_note_items_credit_note_id_org" FOREIGN KEY (org_id, credit_note_id) REFERENCES credit_notes(org_id, id);
  END IF;
END $repair$
$s111$;
  END IF;
END $g111$;
--> statement-breakpoint
DO $g112$
BEGIN
  IF to_regclass('public."clients"') IS NOT NULL AND to_regclass('public."credit_notes"') IS NOT NULL THEN
    EXECUTE $s112$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'credit_notes' AND k.conname = 'fk_credit_notes_client_id_org') THEN
    ALTER TABLE "public"."credit_notes" ADD CONSTRAINT "fk_credit_notes_client_id_org" FOREIGN KEY (org_id, client_id) REFERENCES clients(org_id, id);
  END IF;
END $repair$
$s112$;
  END IF;
END $g112$;
--> statement-breakpoint
DO $g113$
BEGIN
  IF to_regclass('public."credit_notes"') IS NOT NULL AND to_regclass('public."invoices"') IS NOT NULL THEN
    EXECUTE $s113$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'credit_notes' AND k.conname = 'fk_credit_notes_invoice_id_org') THEN
    ALTER TABLE "public"."credit_notes" ADD CONSTRAINT "fk_credit_notes_invoice_id_org" FOREIGN KEY (org_id, invoice_id) REFERENCES invoices(org_id, id);
  END IF;
END $repair$
$s113$;
  END IF;
END $g113$;
--> statement-breakpoint
DO $g114$
BEGIN
  IF to_regclass('public."clients"') IS NOT NULL AND to_regclass('public."fin_collection_activities"') IS NOT NULL THEN
    EXECUTE $s114$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_collection_activities' AND k.conname = 'fk_fin_collection_activities_client_id_org') THEN
    ALTER TABLE "public"."fin_collection_activities" ADD CONSTRAINT "fk_fin_collection_activities_client_id_org" FOREIGN KEY (org_id, client_id) REFERENCES clients(org_id, id);
  END IF;
END $repair$
$s114$;
  END IF;
END $g114$;
--> statement-breakpoint
DO $g115$
BEGIN
  IF to_regclass('public."fin_collection_activities"') IS NOT NULL AND to_regclass('public."invoices"') IS NOT NULL THEN
    EXECUTE $s115$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_collection_activities' AND k.conname = 'fk_fin_collection_activities_invoice_id_org') THEN
    ALTER TABLE "public"."fin_collection_activities" ADD CONSTRAINT "fk_fin_collection_activities_invoice_id_org" FOREIGN KEY (org_id, invoice_id) REFERENCES invoices(org_id, id);
  END IF;
END $repair$
$s115$;
  END IF;
END $g115$;
--> statement-breakpoint
DO $g116$
BEGIN
  IF to_regclass('public."fin_payment_allocations"') IS NOT NULL AND to_regclass('public."payments"') IS NOT NULL THEN
    EXECUTE $s116$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_payment_allocations' AND k.conname = 'fk_fin_payment_allocations_payment_id_org') THEN
    ALTER TABLE "public"."fin_payment_allocations" ADD CONSTRAINT "fk_fin_payment_allocations_payment_id_org" FOREIGN KEY (org_id, payment_id) REFERENCES payments(org_id, id);
  END IF;
END $repair$
$s116$;
  END IF;
END $g116$;
--> statement-breakpoint
DO $g117$
BEGIN
  IF to_regclass('public."fin_payment_allocations"') IS NOT NULL AND to_regclass('public."invoices"') IS NOT NULL THEN
    EXECUTE $s117$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_payment_allocations' AND k.conname = 'fk_fin_payment_allocations_invoice_id_org') THEN
    ALTER TABLE "public"."fin_payment_allocations" ADD CONSTRAINT "fk_fin_payment_allocations_invoice_id_org" FOREIGN KEY (org_id, invoice_id) REFERENCES invoices(org_id, id);
  END IF;
END $repair$
$s117$;
  END IF;
END $g117$;
--> statement-breakpoint
DO $g118$
BEGIN
  IF to_regclass('public."fin_payment_run_items"') IS NOT NULL AND to_regclass('public."fin_payment_runs"') IS NOT NULL THEN
    EXECUTE $s118$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_payment_run_items' AND k.conname = 'fk_fin_payment_run_items_run_id_org') THEN
    ALTER TABLE "public"."fin_payment_run_items" ADD CONSTRAINT "fk_fin_payment_run_items_run_id_org" FOREIGN KEY (org_id, run_id) REFERENCES fin_payment_runs(org_id, id);
  END IF;
END $repair$
$s118$;
  END IF;
END $g118$;
--> statement-breakpoint
DO $g119$
BEGIN
  IF to_regclass('public."fin_payment_run_items"') IS NOT NULL AND to_regclass('public."purchase_bills"') IS NOT NULL THEN
    EXECUTE $s119$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_payment_run_items' AND k.conname = 'fk_fin_payment_run_items_bill_id_org') THEN
    ALTER TABLE "public"."fin_payment_run_items" ADD CONSTRAINT "fk_fin_payment_run_items_bill_id_org" FOREIGN KEY (org_id, bill_id) REFERENCES purchase_bills(org_id, id);
  END IF;
END $repair$
$s119$;
  END IF;
END $g119$;
--> statement-breakpoint
DO $g120$
BEGIN
  IF to_regclass('public."clients"') IS NOT NULL AND to_regclass('public."fin_payment_run_items"') IS NOT NULL THEN
    EXECUTE $s120$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_payment_run_items' AND k.conname = 'fk_fin_payment_run_items_vendor_id_org') THEN
    ALTER TABLE "public"."fin_payment_run_items" ADD CONSTRAINT "fk_fin_payment_run_items_vendor_id_org" FOREIGN KEY (org_id, vendor_id) REFERENCES clients(org_id, id);
  END IF;
END $repair$
$s120$;
  END IF;
END $g120$;
--> statement-breakpoint
DO $g121$
BEGIN
  IF to_regclass('public."fin_payment_run_items"') IS NOT NULL AND to_regclass('public."vendor_payments"') IS NOT NULL THEN
    EXECUTE $s121$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_payment_run_items' AND k.conname = 'fk_fin_payment_run_items_vendor_payment_id_org') THEN
    ALTER TABLE "public"."fin_payment_run_items" ADD CONSTRAINT "fk_fin_payment_run_items_vendor_payment_id_org" FOREIGN KEY (org_id, vendor_payment_id) REFERENCES vendor_payments(org_id, id);
  END IF;
END $repair$
$s121$;
  END IF;
END $g121$;
--> statement-breakpoint
DO $g122$
BEGIN
  IF to_regclass('public."clients"') IS NOT NULL AND to_regclass('public."fin_recurring_bill_templates"') IS NOT NULL THEN
    EXECUTE $s122$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_recurring_bill_templates' AND k.conname = 'fk_fin_recurring_bill_templates_vendor_id_org') THEN
    ALTER TABLE "public"."fin_recurring_bill_templates" ADD CONSTRAINT "fk_fin_recurring_bill_templates_vendor_id_org" FOREIGN KEY (org_id, vendor_id) REFERENCES clients(org_id, id);
  END IF;
END $repair$
$s122$;
  END IF;
END $g122$;
--> statement-breakpoint
DO $g123$
BEGIN
  IF to_regclass('public."clients"') IS NOT NULL AND to_regclass('public."fin_recurring_invoice_templates"') IS NOT NULL THEN
    EXECUTE $s123$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_recurring_invoice_templates' AND k.conname = 'fk_fin_recurring_invoice_templates_client_id_org') THEN
    ALTER TABLE "public"."fin_recurring_invoice_templates" ADD CONSTRAINT "fk_fin_recurring_invoice_templates_client_id_org" FOREIGN KEY (org_id, client_id) REFERENCES clients(org_id, id);
  END IF;
END $repair$
$s123$;
  END IF;
END $g123$;
--> statement-breakpoint
DO $g124$
BEGIN
  IF to_regclass('public."fin_reminder_log"') IS NOT NULL AND to_regclass('public."invoices"') IS NOT NULL THEN
    EXECUTE $s124$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_reminder_log' AND k.conname = 'fk_fin_reminder_log_invoice_id_org') THEN
    ALTER TABLE "public"."fin_reminder_log" ADD CONSTRAINT "fk_fin_reminder_log_invoice_id_org" FOREIGN KEY (org_id, invoice_id) REFERENCES invoices(org_id, id);
  END IF;
END $repair$
$s124$;
  END IF;
END $g124$;
--> statement-breakpoint
DO $g125$
BEGIN
  IF to_regclass('public."fin_vendor_payment_allocations"') IS NOT NULL AND to_regclass('public."vendor_payments"') IS NOT NULL THEN
    EXECUTE $s125$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_vendor_payment_allocations' AND k.conname = 'fk_fin_vendor_payment_allocations_vendor_payment_id_org') THEN
    ALTER TABLE "public"."fin_vendor_payment_allocations" ADD CONSTRAINT "fk_fin_vendor_payment_allocations_vendor_payment_id_org" FOREIGN KEY (org_id, vendor_payment_id) REFERENCES vendor_payments(org_id, id);
  END IF;
END $repair$
$s125$;
  END IF;
END $g125$;
--> statement-breakpoint
DO $g126$
BEGIN
  IF to_regclass('public."fin_vendor_payment_allocations"') IS NOT NULL AND to_regclass('public."purchase_bills"') IS NOT NULL THEN
    EXECUTE $s126$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_vendor_payment_allocations' AND k.conname = 'fk_fin_vendor_payment_allocations_bill_id_org') THEN
    ALTER TABLE "public"."fin_vendor_payment_allocations" ADD CONSTRAINT "fk_fin_vendor_payment_allocations_bill_id_org" FOREIGN KEY (org_id, bill_id) REFERENCES purchase_bills(org_id, id);
  END IF;
END $repair$
$s126$;
  END IF;
END $g126$;
--> statement-breakpoint
DO $g127$
BEGIN
  IF to_regclass('public."vendor_credit_items"') IS NOT NULL AND to_regclass('public."vendor_credits"') IS NOT NULL THEN
    EXECUTE $s127$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'vendor_credit_items' AND k.conname = 'fk_vendor_credit_items_vendor_credit_id_org') THEN
    ALTER TABLE "public"."vendor_credit_items" ADD CONSTRAINT "fk_vendor_credit_items_vendor_credit_id_org" FOREIGN KEY (org_id, vendor_credit_id) REFERENCES vendor_credits(org_id, id);
  END IF;
END $repair$
$s127$;
  END IF;
END $g127$;
--> statement-breakpoint
DO $g128$
BEGIN
  IF to_regclass('public."clients"') IS NOT NULL AND to_regclass('public."vendor_credits"') IS NOT NULL THEN
    EXECUTE $s128$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'vendor_credits' AND k.conname = 'fk_vendor_credits_vendor_id_org') THEN
    ALTER TABLE "public"."vendor_credits" ADD CONSTRAINT "fk_vendor_credits_vendor_id_org" FOREIGN KEY (org_id, vendor_id) REFERENCES clients(org_id, id);
  END IF;
END $repair$
$s128$;
  END IF;
END $g128$;
--> statement-breakpoint
DO $g129$
BEGIN
  IF to_regclass('public."purchase_bills"') IS NOT NULL AND to_regclass('public."vendor_credits"') IS NOT NULL THEN
    EXECUTE $s129$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'vendor_credits' AND k.conname = 'fk_vendor_credits_bill_id_org') THEN
    ALTER TABLE "public"."vendor_credits" ADD CONSTRAINT "fk_vendor_credits_bill_id_org" FOREIGN KEY (org_id, bill_id) REFERENCES purchase_bills(org_id, id);
  END IF;
END $repair$
$s129$;
  END IF;
END $g129$;
--> statement-breakpoint
DO $g130$
BEGIN
  IF to_regclass('public."fin_bank_accounts"') IS NOT NULL AND to_regclass('public."ledger_accounts"') IS NOT NULL THEN
    EXECUTE $s130$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_bank_accounts' AND k.conname = 'fk_fin_bank_accounts_ledger_account_id_org') THEN
    ALTER TABLE "public"."fin_bank_accounts" ADD CONSTRAINT "fk_fin_bank_accounts_ledger_account_id_org" FOREIGN KEY (org_id, ledger_account_id) REFERENCES ledger_accounts(org_id, id);
  END IF;
END $repair$
$s130$;
  END IF;
END $g130$;
--> statement-breakpoint
DO $g131$
BEGIN
  IF to_regclass('public."fin_bank_accounts"') IS NOT NULL AND to_regclass('public."fin_bank_imports"') IS NOT NULL THEN
    EXECUTE $s131$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_bank_imports' AND k.conname = 'fk_fin_bank_imports_bank_account_id_org') THEN
    ALTER TABLE "public"."fin_bank_imports" ADD CONSTRAINT "fk_fin_bank_imports_bank_account_id_org" FOREIGN KEY (org_id, bank_account_id) REFERENCES fin_bank_accounts(org_id, id);
  END IF;
END $repair$
$s131$;
  END IF;
END $g131$;
--> statement-breakpoint
DO $g132$
BEGIN
  IF to_regclass('public."fin_bank_accounts"') IS NOT NULL AND to_regclass('public."fin_bank_transactions"') IS NOT NULL THEN
    EXECUTE $s132$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_bank_transactions' AND k.conname = 'fk_fin_bank_transactions_bank_account_id_org') THEN
    ALTER TABLE "public"."fin_bank_transactions" ADD CONSTRAINT "fk_fin_bank_transactions_bank_account_id_org" FOREIGN KEY (org_id, bank_account_id) REFERENCES fin_bank_accounts(org_id, id);
  END IF;
END $repair$
$s132$;
  END IF;
END $g132$;
--> statement-breakpoint
DO $g133$
BEGIN
  IF to_regclass('public."fin_bank_imports"') IS NOT NULL AND to_regclass('public."fin_bank_transactions"') IS NOT NULL THEN
    EXECUTE $s133$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_bank_transactions' AND k.conname = 'fk_fin_bank_transactions_import_id_org') THEN
    ALTER TABLE "public"."fin_bank_transactions" ADD CONSTRAINT "fk_fin_bank_transactions_import_id_org" FOREIGN KEY (org_id, import_id) REFERENCES fin_bank_imports(org_id, id);
  END IF;
END $repair$
$s133$;
  END IF;
END $g133$;
--> statement-breakpoint
DO $g134$
BEGIN
  IF to_regclass('public."fin_bank_transactions"') IS NOT NULL AND to_regclass('public."journal_entries"') IS NOT NULL THEN
    EXECUTE $s134$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_bank_transactions' AND k.conname = 'fk_fin_bank_transactions_matched_journal_entry_id_org') THEN
    ALTER TABLE "public"."fin_bank_transactions" ADD CONSTRAINT "fk_fin_bank_transactions_matched_journal_entry_id_org" FOREIGN KEY (org_id, matched_journal_entry_id) REFERENCES journal_entries(org_id, id);
  END IF;
END $repair$
$s134$;
  END IF;
END $g134$;
--> statement-breakpoint
DO $g135$
BEGIN
  IF to_regclass('public."fin_bank_accounts"') IS NOT NULL AND to_regclass('public."fin_bank_transfers"') IS NOT NULL THEN
    EXECUTE $s135$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_bank_transfers' AND k.conname = 'fk_fin_bank_transfers_from_bank_account_id_org') THEN
    ALTER TABLE "public"."fin_bank_transfers" ADD CONSTRAINT "fk_fin_bank_transfers_from_bank_account_id_org" FOREIGN KEY (org_id, from_bank_account_id) REFERENCES fin_bank_accounts(org_id, id);
  END IF;
END $repair$
$s135$;
  END IF;
END $g135$;
--> statement-breakpoint
DO $g136$
BEGIN
  IF to_regclass('public."fin_bank_transfers"') IS NOT NULL AND to_regclass('public."journal_entries"') IS NOT NULL THEN
    EXECUTE $s136$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_bank_transfers' AND k.conname = 'fk_fin_bank_transfers_journal_entry_id_org') THEN
    ALTER TABLE "public"."fin_bank_transfers" ADD CONSTRAINT "fk_fin_bank_transfers_journal_entry_id_org" FOREIGN KEY (org_id, journal_entry_id) REFERENCES journal_entries(org_id, id);
  END IF;
END $repair$
$s136$;
  END IF;
END $g136$;
--> statement-breakpoint
DO $g137$
BEGIN
  IF to_regclass('public."fin_bank_transactions"') IS NOT NULL AND to_regclass('public."fin_reconciliation_matches"') IS NOT NULL THEN
    EXECUTE $s137$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_reconciliation_matches' AND k.conname = 'fk_fin_reconciliation_matches_bank_transaction_id_org') THEN
    ALTER TABLE "public"."fin_reconciliation_matches" ADD CONSTRAINT "fk_fin_reconciliation_matches_bank_transaction_id_org" FOREIGN KEY (org_id, bank_transaction_id) REFERENCES fin_bank_transactions(org_id, id);
  END IF;
END $repair$
$s137$;
  END IF;
END $g137$;
--> statement-breakpoint
DO $g138$
BEGIN
  IF to_regclass('public."fin_reconciliation_matches"') IS NOT NULL AND to_regclass('public."journal_entries"') IS NOT NULL THEN
    EXECUTE $s138$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_reconciliation_matches' AND k.conname = 'fk_fin_reconciliation_matches_journal_entry_id_org') THEN
    ALTER TABLE "public"."fin_reconciliation_matches" ADD CONSTRAINT "fk_fin_reconciliation_matches_journal_entry_id_org" FOREIGN KEY (org_id, journal_entry_id) REFERENCES journal_entries(org_id, id);
  END IF;
END $repair$
$s138$;
  END IF;
END $g138$;
--> statement-breakpoint
DO $g139$
BEGIN
  IF to_regclass('public."acc_tax_codes"') IS NOT NULL AND to_regclass('public."ledger_accounts"') IS NOT NULL THEN
    EXECUTE $s139$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'acc_tax_codes' AND k.conname = 'fk_acc_tax_codes_collected_account_id_org') THEN
    ALTER TABLE "public"."acc_tax_codes" ADD CONSTRAINT "fk_acc_tax_codes_collected_account_id_org" FOREIGN KEY (org_id, collected_account_id) REFERENCES ledger_accounts(org_id, id);
  END IF;
END $repair$
$s139$;
  END IF;
END $g139$;
--> statement-breakpoint
DO $g140$
BEGIN
  IF to_regclass('public."acc_tax_payments"') IS NOT NULL AND to_regclass('public."journal_entries"') IS NOT NULL THEN
    EXECUTE $s140$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'acc_tax_payments' AND k.conname = 'fk_acc_tax_payments_journal_entry_id_org') THEN
    ALTER TABLE "public"."acc_tax_payments" ADD CONSTRAINT "fk_acc_tax_payments_journal_entry_id_org" FOREIGN KEY (org_id, journal_entry_id) REFERENCES journal_entries(org_id, id);
  END IF;
END $repair$
$s140$;
  END IF;
END $g140$;
--> statement-breakpoint
DO $g141$
BEGIN
  IF to_regclass('public."fin_budget_lines"') IS NOT NULL AND to_regclass('public."fin_budgets"') IS NOT NULL THEN
    EXECUTE $s141$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_budget_lines' AND k.conname = 'fk_fin_budget_lines_budget_id_org') THEN
    ALTER TABLE "public"."fin_budget_lines" ADD CONSTRAINT "fk_fin_budget_lines_budget_id_org" FOREIGN KEY (org_id, budget_id) REFERENCES fin_budgets(org_id, id);
  END IF;
END $repair$
$s141$;
  END IF;
END $g141$;
--> statement-breakpoint
DO $g142$
BEGIN
  IF to_regclass('public."fin_budget_lines"') IS NOT NULL AND to_regclass('public."ledger_accounts"') IS NOT NULL THEN
    EXECUTE $s142$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_budget_lines' AND k.conname = 'fk_fin_budget_lines_account_id_org') THEN
    ALTER TABLE "public"."fin_budget_lines" ADD CONSTRAINT "fk_fin_budget_lines_account_id_org" FOREIGN KEY (org_id, account_id) REFERENCES ledger_accounts(org_id, id);
  END IF;
END $repair$
$s142$;
  END IF;
END $g142$;
--> statement-breakpoint
DO $g143$
BEGIN
  IF to_regclass('public."fin_budget_lines"') IS NOT NULL THEN
    EXECUTE $s143$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_budget_lines' AND k.conname = 'fk_fin_budget_lines_project_id_org') THEN
    ALTER TABLE "public"."fin_budget_lines" ADD CONSTRAINT "fk_fin_budget_lines_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES build.projects(org_id, id);
  END IF;
END $repair$
$s143$;
  END IF;
END $g143$;
--> statement-breakpoint
DO $g144$
BEGIN
  IF to_regclass('public."fin_budget_revisions"') IS NOT NULL AND to_regclass('public."fin_budgets"') IS NOT NULL THEN
    EXECUTE $s144$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_budget_revisions' AND k.conname = 'fk_fin_budget_revisions_budget_id_org') THEN
    ALTER TABLE "public"."fin_budget_revisions" ADD CONSTRAINT "fk_fin_budget_revisions_budget_id_org" FOREIGN KEY (org_id, budget_id) REFERENCES fin_budgets(org_id, id);
  END IF;
END $repair$
$s144$;
  END IF;
END $g144$;
--> statement-breakpoint
DO $g145$
BEGIN
  IF to_regclass('public."acc_asset_categories"') IS NOT NULL AND to_regclass('public."ledger_accounts"') IS NOT NULL THEN
    EXECUTE $s145$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'acc_asset_categories' AND k.conname = 'fk_acc_asset_categories_asset_account_id_org') THEN
    ALTER TABLE "public"."acc_asset_categories" ADD CONSTRAINT "fk_acc_asset_categories_asset_account_id_org" FOREIGN KEY (org_id, asset_account_id) REFERENCES ledger_accounts(org_id, id);
  END IF;
END $repair$
$s145$;
  END IF;
END $g145$;
--> statement-breakpoint
DO $g146$
BEGIN
  IF to_regclass('public."acc_depreciation_runs"') IS NOT NULL AND to_regclass('public."journal_entries"') IS NOT NULL THEN
    EXECUTE $s146$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'acc_depreciation_runs' AND k.conname = 'fk_acc_depreciation_runs_journal_entry_id_org') THEN
    ALTER TABLE "public"."acc_depreciation_runs" ADD CONSTRAINT "fk_acc_depreciation_runs_journal_entry_id_org" FOREIGN KEY (org_id, journal_entry_id) REFERENCES journal_entries(org_id, id);
  END IF;
END $repair$
$s146$;
  END IF;
END $g146$;
--> statement-breakpoint
DO $g147$
BEGIN
  IF to_regclass('public."acc_depreciation_schedules"') IS NOT NULL AND to_regclass('public."acc_fixed_assets"') IS NOT NULL THEN
    EXECUTE $s147$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'acc_depreciation_schedules' AND k.conname = 'fk_acc_depreciation_schedules_asset_id_org') THEN
    ALTER TABLE "public"."acc_depreciation_schedules" ADD CONSTRAINT "fk_acc_depreciation_schedules_asset_id_org" FOREIGN KEY (org_id, asset_id) REFERENCES acc_fixed_assets(org_id, id);
  END IF;
END $repair$
$s147$;
  END IF;
END $g147$;
--> statement-breakpoint
DO $g148$
BEGIN
  IF to_regclass('public."acc_depreciation_runs"') IS NOT NULL AND to_regclass('public."acc_depreciation_schedules"') IS NOT NULL THEN
    EXECUTE $s148$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'acc_depreciation_schedules' AND k.conname = 'fk_acc_depreciation_schedules_run_id_org') THEN
    ALTER TABLE "public"."acc_depreciation_schedules" ADD CONSTRAINT "fk_acc_depreciation_schedules_run_id_org" FOREIGN KEY (org_id, run_id) REFERENCES acc_depreciation_runs(org_id, id);
  END IF;
END $repair$
$s148$;
  END IF;
END $g148$;
--> statement-breakpoint
DO $g149$
BEGIN
  IF to_regclass('public."acc_depreciation_schedules"') IS NOT NULL AND to_regclass('public."journal_entries"') IS NOT NULL THEN
    EXECUTE $s149$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'acc_depreciation_schedules' AND k.conname = 'fk_acc_depreciation_schedules_journal_entry_id_org') THEN
    ALTER TABLE "public"."acc_depreciation_schedules" ADD CONSTRAINT "fk_acc_depreciation_schedules_journal_entry_id_org" FOREIGN KEY (org_id, journal_entry_id) REFERENCES journal_entries(org_id, id);
  END IF;
END $repair$
$s149$;
  END IF;
END $g149$;
--> statement-breakpoint
DO $g150$
BEGIN
  IF to_regclass('public."acc_asset_categories"') IS NOT NULL AND to_regclass('public."acc_fixed_assets"') IS NOT NULL THEN
    EXECUTE $s150$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'acc_fixed_assets' AND k.conname = 'fk_acc_fixed_assets_category_id_org') THEN
    ALTER TABLE "public"."acc_fixed_assets" ADD CONSTRAINT "fk_acc_fixed_assets_category_id_org" FOREIGN KEY (org_id, category_id) REFERENCES acc_asset_categories(org_id, id);
  END IF;
END $repair$
$s150$;
  END IF;
END $g150$;
--> statement-breakpoint
DO $g151$
BEGIN
  IF to_regclass('public."acc_fixed_assets"') IS NOT NULL AND to_regclass('public."clients"') IS NOT NULL THEN
    EXECUTE $s151$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'acc_fixed_assets' AND k.conname = 'fk_acc_fixed_assets_vendor_id_org') THEN
    ALTER TABLE "public"."acc_fixed_assets" ADD CONSTRAINT "fk_acc_fixed_assets_vendor_id_org" FOREIGN KEY (org_id, vendor_id) REFERENCES clients(org_id, id);
  END IF;
END $repair$
$s151$;
  END IF;
END $g151$;
--> statement-breakpoint
DO $g152$
BEGIN
  IF to_regclass('public."acc_fixed_assets"') IS NOT NULL AND to_regclass('public."purchase_bills"') IS NOT NULL THEN
    EXECUTE $s152$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'acc_fixed_assets' AND k.conname = 'fk_acc_fixed_assets_bill_id_org') THEN
    ALTER TABLE "public"."acc_fixed_assets" ADD CONSTRAINT "fk_acc_fixed_assets_bill_id_org" FOREIGN KEY (org_id, bill_id) REFERENCES purchase_bills(org_id, id);
  END IF;
END $repair$
$s152$;
  END IF;
END $g152$;
--> statement-breakpoint
DO $g153$
BEGIN
  IF to_regclass('public."acc_fixed_assets"') IS NOT NULL AND to_regclass('public."journal_entries"') IS NOT NULL THEN
    EXECUTE $s153$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'acc_fixed_assets' AND k.conname = 'fk_acc_fixed_assets_disposal_journal_entry_id_org') THEN
    ALTER TABLE "public"."acc_fixed_assets" ADD CONSTRAINT "fk_acc_fixed_assets_disposal_journal_entry_id_org" FOREIGN KEY (org_id, disposal_journal_entry_id) REFERENCES journal_entries(org_id, id);
  END IF;
END $repair$
$s153$;
  END IF;
END $g153$;
--> statement-breakpoint
DO $g154$
BEGIN
  IF to_regclass('public."expense_categories"') IS NOT NULL AND to_regclass('public."fin_expense_policies"') IS NOT NULL THEN
    EXECUTE $s154$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_expense_policies' AND k.conname = 'fk_fin_expense_policies_category_id_org') THEN
    ALTER TABLE "public"."fin_expense_policies" ADD CONSTRAINT "fk_fin_expense_policies_category_id_org" FOREIGN KEY (org_id, category_id) REFERENCES expense_categories(org_id, id);
  END IF;
END $repair$
$s154$;
  END IF;
END $g154$;
--> statement-breakpoint
DO $g155$
BEGIN
  IF to_regclass('public."fin_reimbursement_batches"') IS NOT NULL AND to_regclass('public."journal_entries"') IS NOT NULL THEN
    EXECUTE $s155$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_reimbursement_batches' AND k.conname = 'fk_fin_reimbursement_batches_journal_entry_id_org') THEN
    ALTER TABLE "public"."fin_reimbursement_batches" ADD CONSTRAINT "fk_fin_reimbursement_batches_journal_entry_id_org" FOREIGN KEY (org_id, journal_entry_id) REFERENCES journal_entries(org_id, id);
  END IF;
END $repair$
$s155$;
  END IF;
END $g155$;
--> statement-breakpoint
DO $g156$
BEGIN
  IF to_regclass('public."fin_bank_accounts"') IS NOT NULL AND to_regclass('public."fin_reimbursement_batches"') IS NOT NULL THEN
    EXECUTE $s156$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_reimbursement_batches' AND k.conname = 'fk_fin_reimbursement_batches_bank_account_id_org') THEN
    ALTER TABLE "public"."fin_reimbursement_batches" ADD CONSTRAINT "fk_fin_reimbursement_batches_bank_account_id_org" FOREIGN KEY (org_id, bank_account_id) REFERENCES fin_bank_accounts(org_id, id);
  END IF;
END $repair$
$s156$;
  END IF;
END $g156$;
--> statement-breakpoint
DO $g157$
BEGIN
  IF to_regclass('public."clients"') IS NOT NULL AND to_regclass('public."support_vip_clients"') IS NOT NULL THEN
    EXECUTE $s157$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'support_vip_clients' AND k.conname = 'fk_support_vip_clients_client_id_org') THEN
    ALTER TABLE "public"."support_vip_clients" ADD CONSTRAINT "fk_support_vip_clients_client_id_org" FOREIGN KEY (org_id, client_id) REFERENCES clients(org_id, id);
  END IF;
END $repair$
$s157$;
  END IF;
END $g157$;
--> statement-breakpoint
DO $g158$
BEGIN
  IF to_regclass('public."clients"') IS NOT NULL AND to_regclass('public."inv_vendors"') IS NOT NULL THEN
    EXECUTE $s158$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_vendors' AND k.conname = 'fk_inv_vendors_client_id_org') THEN
    ALTER TABLE "public"."inv_vendors" ADD CONSTRAINT "fk_inv_vendors_client_id_org" FOREIGN KEY (org_id, client_id) REFERENCES clients(org_id, id);
  END IF;
END $repair$
$s158$;
  END IF;
END $g158$;
--> statement-breakpoint
DO $g159$
BEGIN
  IF to_regclass('public."clients"') IS NOT NULL AND to_regclass('public."inv_sales_orders"') IS NOT NULL THEN
    EXECUTE $s159$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_sales_orders' AND k.conname = 'fk_inv_sales_orders_client_id_org') THEN
    ALTER TABLE "public"."inv_sales_orders" ADD CONSTRAINT "fk_inv_sales_orders_client_id_org" FOREIGN KEY (org_id, client_id) REFERENCES clients(org_id, id);
  END IF;
END $repair$
$s159$;
  END IF;
END $g159$;
--> statement-breakpoint
DO $g160$
BEGIN
  IF to_regclass('public."contacts"') IS NOT NULL AND to_regclass('public."survey_participants"') IS NOT NULL THEN
    EXECUTE $s160$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'survey_participants' AND k.conname = 'fk_survey_participants_contact_id_org') THEN
    ALTER TABLE "public"."survey_participants" ADD CONSTRAINT "fk_survey_participants_contact_id_org" FOREIGN KEY (org_id, contact_id) REFERENCES contacts(org_id, id);
  END IF;
END $repair$
$s160$;
  END IF;
END $g160$;
--> statement-breakpoint
DO $g161$
BEGIN
  IF to_regclass('public."leads"') IS NOT NULL AND to_regclass('public."survey_participants"') IS NOT NULL THEN
    EXECUTE $s161$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'survey_participants' AND k.conname = 'fk_survey_participants_lead_id_org') THEN
    ALTER TABLE "public"."survey_participants" ADD CONSTRAINT "fk_survey_participants_lead_id_org" FOREIGN KEY (org_id, lead_id) REFERENCES leads(org_id, id);
  END IF;
END $repair$
$s161$;
  END IF;
END $g161$;
--> statement-breakpoint
DO $g162$
BEGIN
  IF to_regclass('public."contacts"') IS NOT NULL AND to_regclass('public."crm_contact_channel_consent"') IS NOT NULL THEN
    EXECUTE $s162$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_contact_channel_consent' AND k.conname = 'crm_contact_channel_consent_contact_id_contacts_id_fk') THEN
    ALTER TABLE "public"."crm_contact_channel_consent" ADD CONSTRAINT "crm_contact_channel_consent_contact_id_contacts_id_fk" FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE;
  END IF;
END $repair$
$s162$;
  END IF;
END $g162$;
--> statement-breakpoint
DO $g163$
BEGIN
  IF to_regclass('public."contacts"') IS NOT NULL AND to_regclass('public."crm_contact_consent_events"') IS NOT NULL THEN
    EXECUTE $s163$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_contact_consent_events' AND k.conname = 'crm_contact_consent_events_contact_id_contacts_id_fk') THEN
    ALTER TABLE "public"."crm_contact_consent_events" ADD CONSTRAINT "crm_contact_consent_events_contact_id_contacts_id_fk" FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE;
  END IF;
END $repair$
$s163$;
  END IF;
END $g163$;
--> statement-breakpoint
DO $g164$
BEGIN
  IF to_regclass('public."build"') IS NOT NULL AND to_regclass('public."crm_organizations"') IS NOT NULL THEN
    EXECUTE $s164$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'build' AND c.relname = 'feedback_posts' AND k.conname = 'fk_feedback_posts_crm_organization') THEN
    ALTER TABLE "build"."feedback_posts" ADD CONSTRAINT "fk_feedback_posts_crm_organization" FOREIGN KEY (crm_organization_id) REFERENCES crm_organizations(id) ON DELETE SET NULL;
  END IF;
END $repair$
$s164$;
  END IF;
END $g164$;
--> statement-breakpoint
DO $g165$
BEGIN
  IF to_regclass('public."build"') IS NOT NULL AND to_regclass('public."contacts"') IS NOT NULL THEN
    EXECUTE $s165$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'build' AND c.relname = 'feedbucket_submissions' AND k.conname = 'fk_feedbucket_submissions_crm_contact') THEN
    ALTER TABLE "build"."feedbucket_submissions" ADD CONSTRAINT "fk_feedbucket_submissions_crm_contact" FOREIGN KEY (crm_contact_id) REFERENCES contacts(id) ON DELETE SET NULL;
  END IF;
END $repair$
$s165$;
  END IF;
END $g165$;
--> statement-breakpoint
DO $g166$
BEGIN
  IF to_regclass('public."build"') IS NOT NULL AND to_regclass('public."crm_organizations"') IS NOT NULL THEN
    EXECUTE $s166$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'build' AND c.relname = 'feedbucket_submissions' AND k.conname = 'fk_feedbucket_submissions_crm_org') THEN
    ALTER TABLE "build"."feedbucket_submissions" ADD CONSTRAINT "fk_feedbucket_submissions_crm_org" FOREIGN KEY (crm_organization_id) REFERENCES crm_organizations(id) ON DELETE SET NULL;
  END IF;
END $repair$
$s166$;
  END IF;
END $g166$;
--> statement-breakpoint
DO $g167$
BEGIN
  IF to_regclass('public."build"') IS NOT NULL AND to_regclass('public."clients"') IS NOT NULL THEN
    EXECUTE $s167$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'build' AND c.relname = 'tickets' AND k.conname = 'fk_tickets_customer') THEN
    ALTER TABLE "build"."tickets" ADD CONSTRAINT "fk_tickets_customer" FOREIGN KEY (customer_id) REFERENCES clients(id) ON DELETE SET NULL;
  END IF;
END $repair$
$s167$;
  END IF;
END $g167$;
--> statement-breakpoint
DO $g168$
BEGIN
  IF to_regclass('public."build"') IS NOT NULL AND to_regclass('public."crm_organizations"') IS NOT NULL THEN
    EXECUTE $s168$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'build' AND c.relname = 'tickets' AND k.conname = 'fk_tickets_customer_id_org') THEN
    ALTER TABLE "build"."tickets" ADD CONSTRAINT "fk_tickets_customer_id_org" FOREIGN KEY (org_id, customer_id) REFERENCES crm_organizations(org_id, id);
  END IF;
END $repair$
$s168$;
  END IF;
END $g168$;
--> statement-breakpoint
DO $g169$
BEGIN
  IF to_regclass('public."lead_party_map"') IS NOT NULL AND to_regclass('public."leads"') IS NOT NULL THEN
    EXECUTE $s169$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'lead_party_map' AND k.conname = 'fk_lead_party_map_legacy') THEN
    ALTER TABLE "public"."lead_party_map" ADD CONSTRAINT "fk_lead_party_map_legacy" FOREIGN KEY (organization_id, lead_id) REFERENCES leads(org_id, id) ON DELETE CASCADE;
  END IF;
END $repair$
$s169$;
  END IF;
END $g169$;
--> statement-breakpoint
DO $g170$
BEGIN
  IF to_regclass('public."client_party_map"') IS NOT NULL AND to_regclass('public."clients"') IS NOT NULL THEN
    EXECUTE $s170$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'client_party_map' AND k.conname = 'fk_client_party_map_legacy') THEN
    ALTER TABLE "public"."client_party_map" ADD CONSTRAINT "fk_client_party_map_legacy" FOREIGN KEY (organization_id, client_id) REFERENCES clients(org_id, id) ON DELETE CASCADE;
  END IF;
END $repair$
$s170$;
  END IF;
END $g170$;
--> statement-breakpoint
DO $g171$
BEGIN
  IF to_regclass('public."contact_party_map"') IS NOT NULL AND to_regclass('public."contacts"') IS NOT NULL THEN
    EXECUTE $s171$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'contact_party_map' AND k.conname = 'fk_contact_party_map_legacy') THEN
    ALTER TABLE "public"."contact_party_map" ADD CONSTRAINT "fk_contact_party_map_legacy" FOREIGN KEY (organization_id, contact_id) REFERENCES contacts(org_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$
$s171$;
  END IF;
END $g171$;
--> statement-breakpoint
--
-- indexes (14)
--
--> statement-breakpoint
DO $g173$
BEGIN
  IF to_regclass('public."journal_lines"') IS NOT NULL THEN
    EXECUTE $s173$
CREATE INDEX IF NOT EXISTS idx_jl_org_client ON public.journal_lines USING btree (org_id, client_id)
$s173$;
  END IF;
END $g173$;
--> statement-breakpoint
DO $g174$
BEGIN
  IF to_regclass('public."journal_lines"') IS NOT NULL THEN
    EXECUTE $s174$
CREATE INDEX IF NOT EXISTS idx_jl_org_vendor ON public.journal_lines USING btree (org_id, vendor_id)
$s174$;
  END IF;
END $g174$;
--> statement-breakpoint
DO $g175$
BEGIN
  IF to_regclass('public."journal_lines"') IS NOT NULL THEN
    EXECUTE $s175$
CREATE INDEX IF NOT EXISTS idx_jl_org_project ON public.journal_lines USING btree (org_id, project_id)
$s175$;
  END IF;
END $g175$;
--> statement-breakpoint
DO $g176$
BEGIN
  IF to_regclass('public."journal_lines"') IS NOT NULL THEN
    EXECUTE $s176$
CREATE INDEX IF NOT EXISTS idx_jl_org_department ON public.journal_lines USING btree (org_id, department_id)
$s176$;
  END IF;
END $g176$;
--> statement-breakpoint
DO $g177$
BEGIN
  IF to_regclass('public."journal_lines"') IS NOT NULL THEN
    EXECUTE $s177$
CREATE INDEX IF NOT EXISTS idx_jl_org_employee ON public.journal_lines USING btree (org_id, employee_id)
$s177$;
  END IF;
END $g177$;
--> statement-breakpoint
DO $g178$
BEGIN
  IF to_regclass('public."journal_lines"') IS NOT NULL THEN
    EXECUTE $s178$
CREATE INDEX IF NOT EXISTS idx_jl_org_tax_code ON public.journal_lines USING btree (org_id, tax_code_id)
$s178$;
  END IF;
END $g178$;
--> statement-breakpoint
DO $g179$
BEGIN
  IF to_regclass('public."journal_entries"') IS NOT NULL THEN
    EXECUTE $s179$
CREATE INDEX IF NOT EXISTS idx_je_org_status_date ON public.journal_entries USING btree (org_id, status, entry_date)
$s179$;
  END IF;
END $g179$;
--> statement-breakpoint
DO $g180$
BEGIN
  IF to_regclass('public."leads"') IS NOT NULL THEN
    EXECUTE $s180$
CREATE INDEX IF NOT EXISTS idx_leads_name_trgm ON public.leads USING gin (name gin_trgm_ops)
$s180$;
  END IF;
END $g180$;
--> statement-breakpoint
DO $g181$
BEGIN
  IF to_regclass('public."leads"') IS NOT NULL THEN
    EXECUTE $s181$
CREATE INDEX IF NOT EXISTS idx_leads_email_trgm ON public.leads USING gin (email gin_trgm_ops)
$s181$;
  END IF;
END $g181$;
--> statement-breakpoint
DO $g182$
BEGIN
  IF to_regclass('public."leads"') IS NOT NULL THEN
    EXECUTE $s182$
CREATE INDEX IF NOT EXISTS idx_leads_phone_trgm ON public.leads USING gin (phone gin_trgm_ops)
$s182$;
  END IF;
END $g182$;
--> statement-breakpoint
DO $g183$
BEGIN
  IF to_regclass('public."leads"') IS NOT NULL THEN
    EXECUTE $s183$
CREATE INDEX IF NOT EXISTS idx_leads_company_trgm ON public.leads USING gin (company gin_trgm_ops)
$s183$;
  END IF;
END $g183$;
--> statement-breakpoint
DO $g184$
BEGIN
  IF to_regclass('public."custom_field_definitions"') IS NOT NULL THEN
    EXECUTE $s184$
CREATE INDEX IF NOT EXISTS idx_cfd_org_entity ON public.custom_field_definitions USING btree (org_id, entity_type)
$s184$;
  END IF;
END $g184$;
--> statement-breakpoint
DO $g185$
BEGIN
  IF to_regclass('public."inv_product_variants"') IS NOT NULL THEN
    EXECUTE $s185$
CREATE UNIQUE INDEX IF NOT EXISTS uniq_inv_variants_org_sku ON public.inv_product_variants USING btree (org_id, sku)
$s185$;
  END IF;
END $g185$;
--> statement-breakpoint
DO $g186$
BEGIN
  IF to_regclass('public."inv_products"') IS NOT NULL THEN
    EXECUTE $s186$
CREATE UNIQUE INDEX IF NOT EXISTS uniq_inv_products_org_sku ON public.inv_products USING btree (org_id, sku)
$s186$;
  END IF;
END $g186$;
--> statement-breakpoint
--
-- triggers (3)
--
--> statement-breakpoint
DO $g188$
BEGIN
  IF to_regclass('public."vendor_credit_items"') IS NOT NULL THEN
    EXECUTE $s188$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'vendor_credit_items' AND t.tgname = 'trg_set_org_id') THEN
    CREATE TRIGGER trg_set_org_id BEFORE INSERT ON public.vendor_credit_items FOR EACH ROW EXECUTE FUNCTION set_org_id_from_parent('vendor_credits', 'id', 'org_id', 'vendor_credit_id');
  END IF;
END $repair$
$s188$;
  END IF;
END $g188$;
--> statement-breakpoint
DO $g189$
BEGIN
  IF to_regclass('public."credit_note_items"') IS NOT NULL THEN
    EXECUTE $s189$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'credit_note_items' AND t.tgname = 'trg_set_org_id') THEN
    CREATE TRIGGER trg_set_org_id BEFORE INSERT ON public.credit_note_items FOR EACH ROW EXECUTE FUNCTION set_org_id_from_parent('credit_notes', 'id', 'org_id', 'credit_note_id');
  END IF;
END $repair$
$s189$;
  END IF;
END $g189$;
--> statement-breakpoint
DO $g190$
BEGIN
  IF to_regclass('public."fin_payment_run_items"') IS NOT NULL THEN
    EXECUTE $s190$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_payment_run_items' AND t.tgname = 'trg_set_org_id') THEN
    CREATE TRIGGER trg_set_org_id BEFORE INSERT ON public.fin_payment_run_items FOR EACH ROW EXECUTE FUNCTION set_org_id_from_parent('fin_payment_runs', 'id', 'org_id', 'run_id');
  END IF;
END $repair$
$s190$;
  END IF;
END $g190$;
--> statement-breakpoint
--
-- row-level security (3)
--
--> statement-breakpoint
DO $g192$
BEGIN
  IF to_regclass('public."fin_payment_run_items"') IS NOT NULL THEN
    EXECUTE $s192$
ALTER TABLE "public"."fin_payment_run_items" ENABLE ROW LEVEL SECURITY
$s192$;
  END IF;
END $g192$;
--> statement-breakpoint
DO $g193$
BEGIN
  IF to_regclass('public."vendor_credit_items"') IS NOT NULL THEN
    EXECUTE $s193$
ALTER TABLE "public"."vendor_credit_items" ENABLE ROW LEVEL SECURITY
$s193$;
  END IF;
END $g193$;
--> statement-breakpoint
DO $g194$
BEGIN
  IF to_regclass('public."credit_note_items"') IS NOT NULL THEN
    EXECUTE $s194$
ALTER TABLE "public"."credit_note_items" ENABLE ROW LEVEL SECURITY
$s194$;
  END IF;
END $g194$;
--> statement-breakpoint
--
-- tenant isolation policies (3)
--
--> statement-breakpoint
DO $g196$
BEGIN
  IF to_regclass('public."fin_payment_run_items"') IS NOT NULL THEN
    EXECUTE $s196$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'fin_payment_run_items' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."fin_payment_run_items" AS PERMISSIVE FOR ALL TO "public" USING ((org_id = app.current_org_id())) WITH CHECK ((org_id = app.current_org_id()));
  END IF;
END $repair$
$s196$;
  END IF;
END $g196$;
--> statement-breakpoint
DO $g197$
BEGIN
  IF to_regclass('public."vendor_credit_items"') IS NOT NULL THEN
    EXECUTE $s197$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'vendor_credit_items' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."vendor_credit_items" AS PERMISSIVE FOR ALL TO "public" USING ((org_id = app.current_org_id())) WITH CHECK ((org_id = app.current_org_id()));
  END IF;
END $repair$
$s197$;
  END IF;
END $g197$;
--> statement-breakpoint
DO $g198$
BEGIN
  IF to_regclass('public."credit_note_items"') IS NOT NULL THEN
    EXECUTE $s198$
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'credit_note_items' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."credit_note_items" AS PERMISSIVE FOR ALL TO "public" USING ((org_id = app.current_org_id())) WITH CHECK ((org_id = app.current_org_id()));
  END IF;
END $repair$
$s198$;
  END IF;
END $g198$;
