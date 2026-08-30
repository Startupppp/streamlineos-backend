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
ALTER TABLE "public"."credit_note_items" ADD COLUMN IF NOT EXISTS "org_id" text;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'credit_note_items' AND a.attname = 'org_id' AND a.attnotnull) THEN
    ALTER TABLE "public"."credit_note_items" ALTER COLUMN "org_id" SET NOT NULL;
  END IF;
END $repair$;
--> statement-breakpoint
ALTER TABLE "public"."fin_payment_run_items" ADD COLUMN IF NOT EXISTS "org_id" text;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_payment_run_items' AND a.attname = 'org_id' AND a.attnotnull) THEN
    ALTER TABLE "public"."fin_payment_run_items" ALTER COLUMN "org_id" SET NOT NULL;
  END IF;
END $repair$;
--> statement-breakpoint
ALTER TABLE "public"."vendor_credit_items" ADD COLUMN IF NOT EXISTS "org_id" text;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'vendor_credit_items' AND a.attname = 'org_id' AND a.attnotnull) THEN
    ALTER TABLE "public"."vendor_credit_items" ALTER COLUMN "org_id" SET NOT NULL;
  END IF;
END $repair$;
--> statement-breakpoint
--
-- columns whose declared type drifted (2)
--
--> statement-breakpoint
ALTER TABLE "public"."fin_budget_lines" ALTER COLUMN "department_id" TYPE text USING "department_id"::text;
--> statement-breakpoint
ALTER TABLE "public"."journal_lines" ALTER COLUMN "department_id" TYPE text USING "department_id"::text;
--> statement-breakpoint
--
-- columns whose nullability drifted (1)
--
--> statement-breakpoint
ALTER TABLE "public"."journal_lines" ALTER COLUMN "org_id" SET NOT NULL;
--> statement-breakpoint
--
-- primary keys, unique and check constraints (46)
--
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'vendor_credit_items' AND k.conname = 'uniq_vendor_credit_items_org_id') THEN
    ALTER TABLE "public"."vendor_credit_items" ADD CONSTRAINT "uniq_vendor_credit_items_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'credit_note_items' AND k.conname = 'uniq_credit_note_items_org_id') THEN
    ALTER TABLE "public"."credit_note_items" ADD CONSTRAINT "uniq_credit_note_items_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_payment_run_items' AND k.conname = 'uniq_fin_payment_run_items_org_id') THEN
    ALTER TABLE "public"."fin_payment_run_items" ADD CONSTRAINT "uniq_fin_payment_run_items_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'contacts' AND k.conname = 'uniq_contacts_org_id') THEN
    ALTER TABLE "public"."contacts" ADD CONSTRAINT "uniq_contacts_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_organizations' AND k.conname = 'uniq_crm_organizations_org_id') THEN
    ALTER TABLE "public"."crm_organizations" ADD CONSTRAINT "uniq_crm_organizations_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'acc_number_sequences' AND k.conname = 'uniq_acc_number_sequences_org_id') THEN
    ALTER TABLE "public"."acc_number_sequences" ADD CONSTRAINT "uniq_acc_number_sequences_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'journal_entries' AND k.conname = 'uniq_journal_entries_org_id') THEN
    ALTER TABLE "public"."journal_entries" ADD CONSTRAINT "uniq_journal_entries_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'acc_system_account_map' AND k.conname = 'uniq_acc_system_account_map_org_id') THEN
    ALTER TABLE "public"."acc_system_account_map" ADD CONSTRAINT "uniq_acc_system_account_map_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'accounting_dimension_values' AND k.conname = 'uniq_accounting_dimension_values_org_id') THEN
    ALTER TABLE "public"."accounting_dimension_values" ADD CONSTRAINT "uniq_accounting_dimension_values_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'accounting_dimensions' AND k.conname = 'uniq_accounting_dimensions_org_id') THEN
    ALTER TABLE "public"."accounting_dimensions" ADD CONSTRAINT "uniq_accounting_dimensions_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ledger_accounts' AND k.conname = 'uniq_ledger_accounts_org_id') THEN
    ALTER TABLE "public"."ledger_accounts" ADD CONSTRAINT "uniq_ledger_accounts_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_approval_policies' AND k.conname = 'uniq_fin_approval_policies_org_id') THEN
    ALTER TABLE "public"."fin_approval_policies" ADD CONSTRAINT "uniq_fin_approval_policies_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_approval_requests' AND k.conname = 'uniq_fin_approval_requests_org_id') THEN
    ALTER TABLE "public"."fin_approval_requests" ADD CONSTRAINT "uniq_fin_approval_requests_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_exchange_rates' AND k.conname = 'uniq_fin_exchange_rates_org_id') THEN
    ALTER TABLE "public"."fin_exchange_rates" ADD CONSTRAINT "uniq_fin_exchange_rates_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_recurring_journal_templates' AND k.conname = 'uniq_fin_recurring_journal_templates_org_id') THEN
    ALTER TABLE "public"."fin_recurring_journal_templates" ADD CONSTRAINT "uniq_fin_recurring_journal_templates_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'credit_notes' AND k.conname = 'uniq_credit_notes_org_id') THEN
    ALTER TABLE "public"."credit_notes" ADD CONSTRAINT "uniq_credit_notes_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_collection_activities' AND k.conname = 'uniq_fin_collection_activities_org_id') THEN
    ALTER TABLE "public"."fin_collection_activities" ADD CONSTRAINT "uniq_fin_collection_activities_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'accounting_settings' AND k.conname = 'uniq_accounting_settings_org_id') THEN
    ALTER TABLE "public"."accounting_settings" ADD CONSTRAINT "uniq_accounting_settings_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_payment_runs' AND k.conname = 'uniq_fin_payment_runs_org_id') THEN
    ALTER TABLE "public"."fin_payment_runs" ADD CONSTRAINT "uniq_fin_payment_runs_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_recurring_bill_templates' AND k.conname = 'uniq_fin_recurring_bill_templates_org_id') THEN
    ALTER TABLE "public"."fin_recurring_bill_templates" ADD CONSTRAINT "uniq_fin_recurring_bill_templates_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_recurring_invoice_templates' AND k.conname = 'uniq_fin_recurring_invoice_templates_org_id') THEN
    ALTER TABLE "public"."fin_recurring_invoice_templates" ADD CONSTRAINT "uniq_fin_recurring_invoice_templates_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_reminder_log' AND k.conname = 'uniq_fin_reminder_log_org_id') THEN
    ALTER TABLE "public"."fin_reminder_log" ADD CONSTRAINT "uniq_fin_reminder_log_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_reminder_policies' AND k.conname = 'uniq_fin_reminder_policies_org_id') THEN
    ALTER TABLE "public"."fin_reminder_policies" ADD CONSTRAINT "uniq_fin_reminder_policies_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_vendor_payment_allocations' AND k.conname = 'uniq_fin_vendor_payment_allocations_org_id') THEN
    ALTER TABLE "public"."fin_vendor_payment_allocations" ADD CONSTRAINT "uniq_fin_vendor_payment_allocations_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_bank_imports' AND k.conname = 'uniq_fin_bank_imports_org_id') THEN
    ALTER TABLE "public"."fin_bank_imports" ADD CONSTRAINT "uniq_fin_bank_imports_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_bank_transactions' AND k.conname = 'uniq_fin_bank_transactions_org_id') THEN
    ALTER TABLE "public"."fin_bank_transactions" ADD CONSTRAINT "uniq_fin_bank_transactions_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_bank_transfers' AND k.conname = 'uniq_fin_bank_transfers_org_id') THEN
    ALTER TABLE "public"."fin_bank_transfers" ADD CONSTRAINT "uniq_fin_bank_transfers_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_reconciliation_matches' AND k.conname = 'uniq_fin_reconciliation_matches_org_id') THEN
    ALTER TABLE "public"."fin_reconciliation_matches" ADD CONSTRAINT "uniq_fin_reconciliation_matches_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_reconciliation_rules' AND k.conname = 'uniq_fin_reconciliation_rules_org_id') THEN
    ALTER TABLE "public"."fin_reconciliation_rules" ADD CONSTRAINT "uniq_fin_reconciliation_rules_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'acc_tax_codes' AND k.conname = 'uniq_acc_tax_codes_org_id') THEN
    ALTER TABLE "public"."acc_tax_codes" ADD CONSTRAINT "uniq_acc_tax_codes_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'acc_tax_payments' AND k.conname = 'uniq_acc_tax_payments_org_id') THEN
    ALTER TABLE "public"."acc_tax_payments" ADD CONSTRAINT "uniq_acc_tax_payments_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_bank_accounts' AND k.conname = 'uniq_fin_bank_accounts_org_id') THEN
    ALTER TABLE "public"."fin_bank_accounts" ADD CONSTRAINT "uniq_fin_bank_accounts_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_budget_revisions' AND k.conname = 'uniq_fin_budget_revisions_org_id') THEN
    ALTER TABLE "public"."fin_budget_revisions" ADD CONSTRAINT "uniq_fin_budget_revisions_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_cash_flow_scenarios' AND k.conname = 'uniq_fin_cash_flow_scenarios_org_id') THEN
    ALTER TABLE "public"."fin_cash_flow_scenarios" ADD CONSTRAINT "uniq_fin_cash_flow_scenarios_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'acc_asset_categories' AND k.conname = 'uniq_acc_asset_categories_org_id') THEN
    ALTER TABLE "public"."acc_asset_categories" ADD CONSTRAINT "uniq_acc_asset_categories_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'acc_depreciation_runs' AND k.conname = 'uniq_acc_depreciation_runs_org_id') THEN
    ALTER TABLE "public"."acc_depreciation_runs" ADD CONSTRAINT "uniq_acc_depreciation_runs_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'acc_depreciation_schedules' AND k.conname = 'uniq_acc_depreciation_schedules_org_id') THEN
    ALTER TABLE "public"."acc_depreciation_schedules" ADD CONSTRAINT "uniq_acc_depreciation_schedules_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'acc_fixed_assets' AND k.conname = 'uniq_acc_fixed_assets_org_id') THEN
    ALTER TABLE "public"."acc_fixed_assets" ADD CONSTRAINT "uniq_acc_fixed_assets_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'leads' AND k.conname = 'uniq_leads_org_id') THEN
    ALTER TABLE "public"."leads" ADD CONSTRAINT "uniq_leads_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'clients' AND k.conname = 'uniq_clients_org_id') THEN
    ALTER TABLE "public"."clients" ADD CONSTRAINT "uniq_clients_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'accounting_periods' AND k.conname = 'uniq_accounting_periods_org_id') THEN
    ALTER TABLE "public"."accounting_periods" ADD CONSTRAINT "uniq_accounting_periods_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_payment_allocations' AND k.conname = 'uniq_fin_payment_allocations_org_id') THEN
    ALTER TABLE "public"."fin_payment_allocations" ADD CONSTRAINT "uniq_fin_payment_allocations_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'vendor_credits' AND k.conname = 'uniq_vendor_credits_org_id') THEN
    ALTER TABLE "public"."vendor_credits" ADD CONSTRAINT "uniq_vendor_credits_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_budgets' AND k.conname = 'uniq_fin_budgets_org_id') THEN
    ALTER TABLE "public"."fin_budgets" ADD CONSTRAINT "uniq_fin_budgets_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_budget_lines' AND k.conname = 'uniq_fin_budget_lines_org_id') THEN
    ALTER TABLE "public"."fin_budget_lines" ADD CONSTRAINT "uniq_fin_budget_lines_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'autonomy_holds' AND k.conname = 'chk_autonomy_holds_target') THEN
    ALTER TABLE "public"."autonomy_holds" ADD CONSTRAINT "chk_autonomy_holds_target" CHECK ((quote_id IS NOT NULL));
  END IF;
END $repair$;
--> statement-breakpoint
--
-- not-null constraints (4)
--
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'journal_lines' AND k.conname = 'journal_lines_org_id_not_null') THEN
    ALTER TABLE "public"."journal_lines" ADD CONSTRAINT "journal_lines_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'vendor_credit_items' AND k.conname = 'vendor_credit_items_org_id_not_null') THEN
    ALTER TABLE "public"."vendor_credit_items" ADD CONSTRAINT "vendor_credit_items_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'credit_note_items' AND k.conname = 'credit_note_items_org_id_not_null') THEN
    ALTER TABLE "public"."credit_note_items" ADD CONSTRAINT "credit_note_items_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_payment_run_items' AND k.conname = 'fin_payment_run_items_org_id_not_null') THEN
    ALTER TABLE "public"."fin_payment_run_items" ADD CONSTRAINT "fin_payment_run_items_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
--
-- foreign keys (107)
--
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'calendar_events' AND k.conname = 'fk_calendar_events_linked_lead') THEN
    ALTER TABLE "public"."calendar_events" ADD CONSTRAINT "fk_calendar_events_linked_lead" FOREIGN KEY (linked_lead_id) REFERENCES leads(id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'timesheet_rates' AND k.conname = 'fk_timesheet_rates_client') THEN
    ALTER TABLE "public"."timesheet_rates" ADD CONSTRAINT "fk_timesheet_rates_client" FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'journal_lines' AND k.conname = 'fk_journal_lines_department') THEN
    ALTER TABLE "public"."journal_lines" ADD CONSTRAINT "fk_journal_lines_department" FOREIGN KEY (department_id) REFERENCES org_units(id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_budget_lines' AND k.conname = 'fk_fin_budget_lines_department') THEN
    ALTER TABLE "public"."fin_budget_lines" ADD CONSTRAINT "fk_fin_budget_lines_department" FOREIGN KEY (department_id) REFERENCES org_units(id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'journal_lines' AND k.conname = 'fk_jl_org_entry') THEN
    ALTER TABLE "public"."journal_lines" ADD CONSTRAINT "fk_jl_org_entry" FOREIGN KEY (org_id, entry_id) REFERENCES journal_entries(org_id, id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'build' AND c.relname = 'feedback_posts' AND k.conname = 'fk_feedback_posts_crm_contact') THEN
    ALTER TABLE "build"."feedback_posts" ADD CONSTRAINT "fk_feedback_posts_crm_contact" FOREIGN KEY (crm_contact_id) REFERENCES contacts(id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_budget_lines' AND k.conname = 'fin_budget_lines_project_id_projects_id_fk') THEN
    ALTER TABLE "public"."fin_budget_lines" ADD CONSTRAINT "fin_budget_lines_project_id_projects_id_fk" FOREIGN KEY (project_id) REFERENCES build.projects(id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_expense_policies' AND k.conname = 'fin_expense_policies_org_id_organizations_id_fk') THEN
    ALTER TABLE "public"."fin_expense_policies" ADD CONSTRAINT "fin_expense_policies_org_id_organizations_id_fk" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_expense_policies' AND k.conname = 'fin_expense_policies_category_id_expense_categories_id_fk') THEN
    ALTER TABLE "public"."fin_expense_policies" ADD CONSTRAINT "fin_expense_policies_category_id_expense_categories_id_fk" FOREIGN KEY (category_id) REFERENCES expense_categories(id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_reimbursement_batches' AND k.conname = 'fin_reimbursement_batches_org_id_organizations_id_fk') THEN
    ALTER TABLE "public"."fin_reimbursement_batches" ADD CONSTRAINT "fin_reimbursement_batches_org_id_organizations_id_fk" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_reimbursement_batches' AND k.conname = 'fin_reimbursement_batches_journal_entry_id_journal_entries_id_f') THEN
    ALTER TABLE "public"."fin_reimbursement_batches" ADD CONSTRAINT "fin_reimbursement_batches_journal_entry_id_journal_entries_id_f" FOREIGN KEY (journal_entry_id) REFERENCES journal_entries(id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_reimbursement_batches' AND k.conname = 'fin_reimbursement_batches_bank_account_id_fin_bank_accounts_id_') THEN
    ALTER TABLE "public"."fin_reimbursement_batches" ADD CONSTRAINT "fin_reimbursement_batches_bank_account_id_fin_bank_accounts_id_" FOREIGN KEY (bank_account_id) REFERENCES fin_bank_accounts(id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_reimbursement_batches' AND k.conname = 'fin_reimbursement_batches_created_by_users_id_fk') THEN
    ALTER TABLE "public"."fin_reimbursement_batches" ADD CONSTRAINT "fin_reimbursement_batches_created_by_users_id_fk" FOREIGN KEY (created_by) REFERENCES users(id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_reimbursement_batches' AND k.conname = 'fin_reimbursement_batches_approved_by_users_id_fk') THEN
    ALTER TABLE "public"."fin_reimbursement_batches" ADD CONSTRAINT "fin_reimbursement_batches_approved_by_users_id_fk" FOREIGN KEY (approved_by) REFERENCES users(id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'vendor_credit_items' AND k.conname = 'vendor_credit_items_org_id_fk') THEN
    ALTER TABLE "public"."vendor_credit_items" ADD CONSTRAINT "vendor_credit_items_org_id_fk" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'credit_note_items' AND k.conname = 'credit_note_items_org_id_fk') THEN
    ALTER TABLE "public"."credit_note_items" ADD CONSTRAINT "credit_note_items_org_id_fk" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_payment_run_items' AND k.conname = 'fin_payment_run_items_org_id_fk') THEN
    ALTER TABLE "public"."fin_payment_run_items" ADD CONSTRAINT "fin_payment_run_items_org_id_fk" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'expense_categories' AND k.conname = 'fk_expense_categories_ledger_account_id_org') THEN
    ALTER TABLE "public"."expense_categories" ADD CONSTRAINT "fk_expense_categories_ledger_account_id_org" FOREIGN KEY (org_id, ledger_account_id) REFERENCES ledger_accounts(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'expenses' AND k.conname = 'fk_expenses_posted_journal_entry_id_org') THEN
    ALTER TABLE "public"."expenses" ADD CONSTRAINT "fk_expenses_posted_journal_entry_id_org" FOREIGN KEY (org_id, posted_journal_entry_id) REFERENCES journal_entries(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'lead_activities' AND k.conname = 'fk_lead_activities_lead_id_org') THEN
    ALTER TABLE "public"."lead_activities" ADD CONSTRAINT "fk_lead_activities_lead_id_org" FOREIGN KEY (org_id, lead_id) REFERENCES leads(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'lead_emails' AND k.conname = 'fk_lead_emails_lead_id_org') THEN
    ALTER TABLE "public"."lead_emails" ADD CONSTRAINT "fk_lead_emails_lead_id_org" FOREIGN KEY (org_id, lead_id) REFERENCES leads(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'lead_notes' AND k.conname = 'fk_lead_notes_lead_id_org') THEN
    ALTER TABLE "public"."lead_notes" ADD CONSTRAINT "fk_lead_notes_lead_id_org" FOREIGN KEY (org_id, lead_id) REFERENCES leads(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'lead_tasks' AND k.conname = 'fk_lead_tasks_lead_id_org') THEN
    ALTER TABLE "public"."lead_tasks" ADD CONSTRAINT "fk_lead_tasks_lead_id_org" FOREIGN KEY (org_id, lead_id) REFERENCES leads(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'leads' AND k.conname = 'fk_leads_campaign_id_org') THEN
    ALTER TABLE "public"."leads" ADD CONSTRAINT "fk_leads_campaign_id_org" FOREIGN KEY (org_id, campaign_id) REFERENCES crm_campaigns(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'leads' AND k.conname = 'fk_leads_merged_into_id_org') THEN
    ALTER TABLE "public"."leads" ADD CONSTRAINT "fk_leads_merged_into_id_org" FOREIGN KEY (org_id, merged_into_id) REFERENCES leads(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'client_accounts' AND k.conname = 'fk_client_accounts_lead_id_org') THEN
    ALTER TABLE "public"."client_accounts" ADD CONSTRAINT "fk_client_accounts_lead_id_org" FOREIGN KEY (org_id, lead_id) REFERENCES leads(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'client_onboarding_items' AND k.conname = 'fk_client_onboarding_items_client_id_org') THEN
    ALTER TABLE "public"."client_onboarding_items" ADD CONSTRAINT "fk_client_onboarding_items_client_id_org" FOREIGN KEY (org_id, client_id) REFERENCES clients(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'client_opportunities' AND k.conname = 'fk_client_opportunities_client_id_org') THEN
    ALTER TABLE "public"."client_opportunities" ADD CONSTRAINT "fk_client_opportunities_client_id_org" FOREIGN KEY (org_id, client_id) REFERENCES clients(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'clients' AND k.conname = 'fk_clients_lead_id_org') THEN
    ALTER TABLE "public"."clients" ADD CONSTRAINT "fk_clients_lead_id_org" FOREIGN KEY (org_id, lead_id) REFERENCES leads(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'contacts' AND k.conname = 'fk_contacts_organization_id_org') THEN
    ALTER TABLE "public"."contacts" ADD CONSTRAINT "fk_contacts_organization_id_org" FOREIGN KEY (org_id, organization_id) REFERENCES crm_organizations(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'contacts' AND k.conname = 'fk_contacts_lead_id_org') THEN
    ALTER TABLE "public"."contacts" ADD CONSTRAINT "fk_contacts_lead_id_org" FOREIGN KEY (org_id, lead_id) REFERENCES leads(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_organizations' AND k.conname = 'fk_crm_organizations_parent_id_org') THEN
    ALTER TABLE "public"."crm_organizations" ADD CONSTRAINT "fk_crm_organizations_parent_id_org" FOREIGN KEY (org_id, parent_id) REFERENCES crm_organizations(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'csat_surveys' AND k.conname = 'fk_csat_surveys_client_id_org') THEN
    ALTER TABLE "public"."csat_surveys" ADD CONSTRAINT "fk_csat_surveys_client_id_org" FOREIGN KEY (org_id, client_id) REFERENCES clients(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_contact_roles' AND k.conname = 'fk_crm_contact_roles_contact_id_org') THEN
    ALTER TABLE "public"."crm_contact_roles" ADD CONSTRAINT "fk_crm_contact_roles_contact_id_org" FOREIGN KEY (org_id, contact_id) REFERENCES contacts(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_deal_stakeholders' AND k.conname = 'fk_crm_deal_stakeholders_contact_id_org') THEN
    ALTER TABLE "public"."crm_deal_stakeholders" ADD CONSTRAINT "fk_crm_deal_stakeholders_contact_id_org" FOREIGN KEY (org_id, contact_id) REFERENCES contacts(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'deals' AND k.conname = 'fk_deals_lead_id_org') THEN
    ALTER TABLE "public"."deals" ADD CONSTRAINT "fk_deals_lead_id_org" FOREIGN KEY (org_id, lead_id) REFERENCES leads(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'deals' AND k.conname = 'fk_deals_client_id_org') THEN
    ALTER TABLE "public"."deals" ADD CONSTRAINT "fk_deals_client_id_org" FOREIGN KEY (org_id, client_id) REFERENCES clients(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'invoices' AND k.conname = 'fk_invoices_client_id_org') THEN
    ALTER TABLE "public"."invoices" ADD CONSTRAINT "fk_invoices_client_id_org" FOREIGN KEY (org_id, client_id) REFERENCES clients(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'purchase_bills' AND k.conname = 'fk_purchase_bills_vendor_id_org') THEN
    ALTER TABLE "public"."purchase_bills" ADD CONSTRAINT "fk_purchase_bills_vendor_id_org" FOREIGN KEY (org_id, vendor_id) REFERENCES clients(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'support_tickets' AND k.conname = 'fk_support_tickets_client_id_org') THEN
    ALTER TABLE "public"."support_tickets" ADD CONSTRAINT "fk_support_tickets_client_id_org" FOREIGN KEY (org_id, client_id) REFERENCES clients(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_lead_touchpoints' AND k.conname = 'fk_crm_lead_touchpoints_lead_id_org') THEN
    ALTER TABLE "public"."crm_lead_touchpoints" ADD CONSTRAINT "fk_crm_lead_touchpoints_lead_id_org" FOREIGN KEY (org_id, lead_id) REFERENCES leads(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'journal_entries' AND k.conname = 'fk_journal_entries_reversed_entry_id_org') THEN
    ALTER TABLE "public"."journal_entries" ADD CONSTRAINT "fk_journal_entries_reversed_entry_id_org" FOREIGN KEY (org_id, reversed_entry_id) REFERENCES journal_entries(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ledger_accounts' AND k.conname = 'fk_ledger_accounts_parent_account_id_org') THEN
    ALTER TABLE "public"."ledger_accounts" ADD CONSTRAINT "fk_ledger_accounts_parent_account_id_org" FOREIGN KEY (org_id, parent_account_id) REFERENCES ledger_accounts(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'acc_system_account_map' AND k.conname = 'fk_acc_system_account_map_account_id_org') THEN
    ALTER TABLE "public"."acc_system_account_map" ADD CONSTRAINT "fk_acc_system_account_map_account_id_org" FOREIGN KEY (org_id, account_id) REFERENCES ledger_accounts(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'accounting_dimension_values' AND k.conname = 'fk_accounting_dimension_values_dimension_id_org') THEN
    ALTER TABLE "public"."accounting_dimension_values" ADD CONSTRAINT "fk_accounting_dimension_values_dimension_id_org" FOREIGN KEY (org_id, dimension_id) REFERENCES accounting_dimensions(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'accounting_settings' AND k.conname = 'fk_accounting_settings_retained_earnings_account_id_org') THEN
    ALTER TABLE "public"."accounting_settings" ADD CONSTRAINT "fk_accounting_settings_retained_earnings_account_id_org" FOREIGN KEY (org_id, retained_earnings_account_id) REFERENCES ledger_accounts(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'credit_note_items' AND k.conname = 'fk_credit_note_items_credit_note_id_org') THEN
    ALTER TABLE "public"."credit_note_items" ADD CONSTRAINT "fk_credit_note_items_credit_note_id_org" FOREIGN KEY (org_id, credit_note_id) REFERENCES credit_notes(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'credit_notes' AND k.conname = 'fk_credit_notes_client_id_org') THEN
    ALTER TABLE "public"."credit_notes" ADD CONSTRAINT "fk_credit_notes_client_id_org" FOREIGN KEY (org_id, client_id) REFERENCES clients(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'credit_notes' AND k.conname = 'fk_credit_notes_invoice_id_org') THEN
    ALTER TABLE "public"."credit_notes" ADD CONSTRAINT "fk_credit_notes_invoice_id_org" FOREIGN KEY (org_id, invoice_id) REFERENCES invoices(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_collection_activities' AND k.conname = 'fk_fin_collection_activities_client_id_org') THEN
    ALTER TABLE "public"."fin_collection_activities" ADD CONSTRAINT "fk_fin_collection_activities_client_id_org" FOREIGN KEY (org_id, client_id) REFERENCES clients(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_collection_activities' AND k.conname = 'fk_fin_collection_activities_invoice_id_org') THEN
    ALTER TABLE "public"."fin_collection_activities" ADD CONSTRAINT "fk_fin_collection_activities_invoice_id_org" FOREIGN KEY (org_id, invoice_id) REFERENCES invoices(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_payment_allocations' AND k.conname = 'fk_fin_payment_allocations_payment_id_org') THEN
    ALTER TABLE "public"."fin_payment_allocations" ADD CONSTRAINT "fk_fin_payment_allocations_payment_id_org" FOREIGN KEY (org_id, payment_id) REFERENCES payments(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_payment_allocations' AND k.conname = 'fk_fin_payment_allocations_invoice_id_org') THEN
    ALTER TABLE "public"."fin_payment_allocations" ADD CONSTRAINT "fk_fin_payment_allocations_invoice_id_org" FOREIGN KEY (org_id, invoice_id) REFERENCES invoices(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_payment_run_items' AND k.conname = 'fk_fin_payment_run_items_run_id_org') THEN
    ALTER TABLE "public"."fin_payment_run_items" ADD CONSTRAINT "fk_fin_payment_run_items_run_id_org" FOREIGN KEY (org_id, run_id) REFERENCES fin_payment_runs(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_payment_run_items' AND k.conname = 'fk_fin_payment_run_items_bill_id_org') THEN
    ALTER TABLE "public"."fin_payment_run_items" ADD CONSTRAINT "fk_fin_payment_run_items_bill_id_org" FOREIGN KEY (org_id, bill_id) REFERENCES purchase_bills(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_payment_run_items' AND k.conname = 'fk_fin_payment_run_items_vendor_id_org') THEN
    ALTER TABLE "public"."fin_payment_run_items" ADD CONSTRAINT "fk_fin_payment_run_items_vendor_id_org" FOREIGN KEY (org_id, vendor_id) REFERENCES clients(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_payment_run_items' AND k.conname = 'fk_fin_payment_run_items_vendor_payment_id_org') THEN
    ALTER TABLE "public"."fin_payment_run_items" ADD CONSTRAINT "fk_fin_payment_run_items_vendor_payment_id_org" FOREIGN KEY (org_id, vendor_payment_id) REFERENCES vendor_payments(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_recurring_bill_templates' AND k.conname = 'fk_fin_recurring_bill_templates_vendor_id_org') THEN
    ALTER TABLE "public"."fin_recurring_bill_templates" ADD CONSTRAINT "fk_fin_recurring_bill_templates_vendor_id_org" FOREIGN KEY (org_id, vendor_id) REFERENCES clients(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_recurring_invoice_templates' AND k.conname = 'fk_fin_recurring_invoice_templates_client_id_org') THEN
    ALTER TABLE "public"."fin_recurring_invoice_templates" ADD CONSTRAINT "fk_fin_recurring_invoice_templates_client_id_org" FOREIGN KEY (org_id, client_id) REFERENCES clients(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_reminder_log' AND k.conname = 'fk_fin_reminder_log_invoice_id_org') THEN
    ALTER TABLE "public"."fin_reminder_log" ADD CONSTRAINT "fk_fin_reminder_log_invoice_id_org" FOREIGN KEY (org_id, invoice_id) REFERENCES invoices(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_vendor_payment_allocations' AND k.conname = 'fk_fin_vendor_payment_allocations_vendor_payment_id_org') THEN
    ALTER TABLE "public"."fin_vendor_payment_allocations" ADD CONSTRAINT "fk_fin_vendor_payment_allocations_vendor_payment_id_org" FOREIGN KEY (org_id, vendor_payment_id) REFERENCES vendor_payments(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_vendor_payment_allocations' AND k.conname = 'fk_fin_vendor_payment_allocations_bill_id_org') THEN
    ALTER TABLE "public"."fin_vendor_payment_allocations" ADD CONSTRAINT "fk_fin_vendor_payment_allocations_bill_id_org" FOREIGN KEY (org_id, bill_id) REFERENCES purchase_bills(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'vendor_credit_items' AND k.conname = 'fk_vendor_credit_items_vendor_credit_id_org') THEN
    ALTER TABLE "public"."vendor_credit_items" ADD CONSTRAINT "fk_vendor_credit_items_vendor_credit_id_org" FOREIGN KEY (org_id, vendor_credit_id) REFERENCES vendor_credits(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'vendor_credits' AND k.conname = 'fk_vendor_credits_vendor_id_org') THEN
    ALTER TABLE "public"."vendor_credits" ADD CONSTRAINT "fk_vendor_credits_vendor_id_org" FOREIGN KEY (org_id, vendor_id) REFERENCES clients(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'vendor_credits' AND k.conname = 'fk_vendor_credits_bill_id_org') THEN
    ALTER TABLE "public"."vendor_credits" ADD CONSTRAINT "fk_vendor_credits_bill_id_org" FOREIGN KEY (org_id, bill_id) REFERENCES purchase_bills(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_bank_accounts' AND k.conname = 'fk_fin_bank_accounts_ledger_account_id_org') THEN
    ALTER TABLE "public"."fin_bank_accounts" ADD CONSTRAINT "fk_fin_bank_accounts_ledger_account_id_org" FOREIGN KEY (org_id, ledger_account_id) REFERENCES ledger_accounts(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_bank_imports' AND k.conname = 'fk_fin_bank_imports_bank_account_id_org') THEN
    ALTER TABLE "public"."fin_bank_imports" ADD CONSTRAINT "fk_fin_bank_imports_bank_account_id_org" FOREIGN KEY (org_id, bank_account_id) REFERENCES fin_bank_accounts(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_bank_transactions' AND k.conname = 'fk_fin_bank_transactions_bank_account_id_org') THEN
    ALTER TABLE "public"."fin_bank_transactions" ADD CONSTRAINT "fk_fin_bank_transactions_bank_account_id_org" FOREIGN KEY (org_id, bank_account_id) REFERENCES fin_bank_accounts(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_bank_transactions' AND k.conname = 'fk_fin_bank_transactions_import_id_org') THEN
    ALTER TABLE "public"."fin_bank_transactions" ADD CONSTRAINT "fk_fin_bank_transactions_import_id_org" FOREIGN KEY (org_id, import_id) REFERENCES fin_bank_imports(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_bank_transactions' AND k.conname = 'fk_fin_bank_transactions_matched_journal_entry_id_org') THEN
    ALTER TABLE "public"."fin_bank_transactions" ADD CONSTRAINT "fk_fin_bank_transactions_matched_journal_entry_id_org" FOREIGN KEY (org_id, matched_journal_entry_id) REFERENCES journal_entries(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_bank_transfers' AND k.conname = 'fk_fin_bank_transfers_from_bank_account_id_org') THEN
    ALTER TABLE "public"."fin_bank_transfers" ADD CONSTRAINT "fk_fin_bank_transfers_from_bank_account_id_org" FOREIGN KEY (org_id, from_bank_account_id) REFERENCES fin_bank_accounts(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_bank_transfers' AND k.conname = 'fk_fin_bank_transfers_journal_entry_id_org') THEN
    ALTER TABLE "public"."fin_bank_transfers" ADD CONSTRAINT "fk_fin_bank_transfers_journal_entry_id_org" FOREIGN KEY (org_id, journal_entry_id) REFERENCES journal_entries(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_reconciliation_matches' AND k.conname = 'fk_fin_reconciliation_matches_bank_transaction_id_org') THEN
    ALTER TABLE "public"."fin_reconciliation_matches" ADD CONSTRAINT "fk_fin_reconciliation_matches_bank_transaction_id_org" FOREIGN KEY (org_id, bank_transaction_id) REFERENCES fin_bank_transactions(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_reconciliation_matches' AND k.conname = 'fk_fin_reconciliation_matches_journal_entry_id_org') THEN
    ALTER TABLE "public"."fin_reconciliation_matches" ADD CONSTRAINT "fk_fin_reconciliation_matches_journal_entry_id_org" FOREIGN KEY (org_id, journal_entry_id) REFERENCES journal_entries(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'acc_tax_codes' AND k.conname = 'fk_acc_tax_codes_collected_account_id_org') THEN
    ALTER TABLE "public"."acc_tax_codes" ADD CONSTRAINT "fk_acc_tax_codes_collected_account_id_org" FOREIGN KEY (org_id, collected_account_id) REFERENCES ledger_accounts(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'acc_tax_payments' AND k.conname = 'fk_acc_tax_payments_journal_entry_id_org') THEN
    ALTER TABLE "public"."acc_tax_payments" ADD CONSTRAINT "fk_acc_tax_payments_journal_entry_id_org" FOREIGN KEY (org_id, journal_entry_id) REFERENCES journal_entries(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_budget_lines' AND k.conname = 'fk_fin_budget_lines_budget_id_org') THEN
    ALTER TABLE "public"."fin_budget_lines" ADD CONSTRAINT "fk_fin_budget_lines_budget_id_org" FOREIGN KEY (org_id, budget_id) REFERENCES fin_budgets(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_budget_lines' AND k.conname = 'fk_fin_budget_lines_account_id_org') THEN
    ALTER TABLE "public"."fin_budget_lines" ADD CONSTRAINT "fk_fin_budget_lines_account_id_org" FOREIGN KEY (org_id, account_id) REFERENCES ledger_accounts(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_budget_lines' AND k.conname = 'fk_fin_budget_lines_project_id_org') THEN
    ALTER TABLE "public"."fin_budget_lines" ADD CONSTRAINT "fk_fin_budget_lines_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES build.projects(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_budget_revisions' AND k.conname = 'fk_fin_budget_revisions_budget_id_org') THEN
    ALTER TABLE "public"."fin_budget_revisions" ADD CONSTRAINT "fk_fin_budget_revisions_budget_id_org" FOREIGN KEY (org_id, budget_id) REFERENCES fin_budgets(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'acc_asset_categories' AND k.conname = 'fk_acc_asset_categories_asset_account_id_org') THEN
    ALTER TABLE "public"."acc_asset_categories" ADD CONSTRAINT "fk_acc_asset_categories_asset_account_id_org" FOREIGN KEY (org_id, asset_account_id) REFERENCES ledger_accounts(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'acc_depreciation_runs' AND k.conname = 'fk_acc_depreciation_runs_journal_entry_id_org') THEN
    ALTER TABLE "public"."acc_depreciation_runs" ADD CONSTRAINT "fk_acc_depreciation_runs_journal_entry_id_org" FOREIGN KEY (org_id, journal_entry_id) REFERENCES journal_entries(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'acc_depreciation_schedules' AND k.conname = 'fk_acc_depreciation_schedules_asset_id_org') THEN
    ALTER TABLE "public"."acc_depreciation_schedules" ADD CONSTRAINT "fk_acc_depreciation_schedules_asset_id_org" FOREIGN KEY (org_id, asset_id) REFERENCES acc_fixed_assets(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'acc_depreciation_schedules' AND k.conname = 'fk_acc_depreciation_schedules_run_id_org') THEN
    ALTER TABLE "public"."acc_depreciation_schedules" ADD CONSTRAINT "fk_acc_depreciation_schedules_run_id_org" FOREIGN KEY (org_id, run_id) REFERENCES acc_depreciation_runs(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'acc_depreciation_schedules' AND k.conname = 'fk_acc_depreciation_schedules_journal_entry_id_org') THEN
    ALTER TABLE "public"."acc_depreciation_schedules" ADD CONSTRAINT "fk_acc_depreciation_schedules_journal_entry_id_org" FOREIGN KEY (org_id, journal_entry_id) REFERENCES journal_entries(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'acc_fixed_assets' AND k.conname = 'fk_acc_fixed_assets_category_id_org') THEN
    ALTER TABLE "public"."acc_fixed_assets" ADD CONSTRAINT "fk_acc_fixed_assets_category_id_org" FOREIGN KEY (org_id, category_id) REFERENCES acc_asset_categories(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'acc_fixed_assets' AND k.conname = 'fk_acc_fixed_assets_vendor_id_org') THEN
    ALTER TABLE "public"."acc_fixed_assets" ADD CONSTRAINT "fk_acc_fixed_assets_vendor_id_org" FOREIGN KEY (org_id, vendor_id) REFERENCES clients(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'acc_fixed_assets' AND k.conname = 'fk_acc_fixed_assets_bill_id_org') THEN
    ALTER TABLE "public"."acc_fixed_assets" ADD CONSTRAINT "fk_acc_fixed_assets_bill_id_org" FOREIGN KEY (org_id, bill_id) REFERENCES purchase_bills(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'acc_fixed_assets' AND k.conname = 'fk_acc_fixed_assets_disposal_journal_entry_id_org') THEN
    ALTER TABLE "public"."acc_fixed_assets" ADD CONSTRAINT "fk_acc_fixed_assets_disposal_journal_entry_id_org" FOREIGN KEY (org_id, disposal_journal_entry_id) REFERENCES journal_entries(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_expense_policies' AND k.conname = 'fk_fin_expense_policies_category_id_org') THEN
    ALTER TABLE "public"."fin_expense_policies" ADD CONSTRAINT "fk_fin_expense_policies_category_id_org" FOREIGN KEY (org_id, category_id) REFERENCES expense_categories(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_reimbursement_batches' AND k.conname = 'fk_fin_reimbursement_batches_journal_entry_id_org') THEN
    ALTER TABLE "public"."fin_reimbursement_batches" ADD CONSTRAINT "fk_fin_reimbursement_batches_journal_entry_id_org" FOREIGN KEY (org_id, journal_entry_id) REFERENCES journal_entries(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_reimbursement_batches' AND k.conname = 'fk_fin_reimbursement_batches_bank_account_id_org') THEN
    ALTER TABLE "public"."fin_reimbursement_batches" ADD CONSTRAINT "fk_fin_reimbursement_batches_bank_account_id_org" FOREIGN KEY (org_id, bank_account_id) REFERENCES fin_bank_accounts(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'support_vip_clients' AND k.conname = 'fk_support_vip_clients_client_id_org') THEN
    ALTER TABLE "public"."support_vip_clients" ADD CONSTRAINT "fk_support_vip_clients_client_id_org" FOREIGN KEY (org_id, client_id) REFERENCES clients(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_vendors' AND k.conname = 'fk_inv_vendors_client_id_org') THEN
    ALTER TABLE "public"."inv_vendors" ADD CONSTRAINT "fk_inv_vendors_client_id_org" FOREIGN KEY (org_id, client_id) REFERENCES clients(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_sales_orders' AND k.conname = 'fk_inv_sales_orders_client_id_org') THEN
    ALTER TABLE "public"."inv_sales_orders" ADD CONSTRAINT "fk_inv_sales_orders_client_id_org" FOREIGN KEY (org_id, client_id) REFERENCES clients(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'survey_participants' AND k.conname = 'fk_survey_participants_contact_id_org') THEN
    ALTER TABLE "public"."survey_participants" ADD CONSTRAINT "fk_survey_participants_contact_id_org" FOREIGN KEY (org_id, contact_id) REFERENCES contacts(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'survey_participants' AND k.conname = 'fk_survey_participants_lead_id_org') THEN
    ALTER TABLE "public"."survey_participants" ADD CONSTRAINT "fk_survey_participants_lead_id_org" FOREIGN KEY (org_id, lead_id) REFERENCES leads(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_contact_channel_consent' AND k.conname = 'crm_contact_channel_consent_contact_id_contacts_id_fk') THEN
    ALTER TABLE "public"."crm_contact_channel_consent" ADD CONSTRAINT "crm_contact_channel_consent_contact_id_contacts_id_fk" FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_contact_consent_events' AND k.conname = 'crm_contact_consent_events_contact_id_contacts_id_fk') THEN
    ALTER TABLE "public"."crm_contact_consent_events" ADD CONSTRAINT "crm_contact_consent_events_contact_id_contacts_id_fk" FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'build' AND c.relname = 'feedback_posts' AND k.conname = 'fk_feedback_posts_crm_organization') THEN
    ALTER TABLE "build"."feedback_posts" ADD CONSTRAINT "fk_feedback_posts_crm_organization" FOREIGN KEY (crm_organization_id) REFERENCES crm_organizations(id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'build' AND c.relname = 'feedbucket_submissions' AND k.conname = 'fk_feedbucket_submissions_crm_contact') THEN
    ALTER TABLE "build"."feedbucket_submissions" ADD CONSTRAINT "fk_feedbucket_submissions_crm_contact" FOREIGN KEY (crm_contact_id) REFERENCES contacts(id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'build' AND c.relname = 'feedbucket_submissions' AND k.conname = 'fk_feedbucket_submissions_crm_org') THEN
    ALTER TABLE "build"."feedbucket_submissions" ADD CONSTRAINT "fk_feedbucket_submissions_crm_org" FOREIGN KEY (crm_organization_id) REFERENCES crm_organizations(id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'build' AND c.relname = 'tickets' AND k.conname = 'fk_tickets_customer') THEN
    ALTER TABLE "build"."tickets" ADD CONSTRAINT "fk_tickets_customer" FOREIGN KEY (customer_id) REFERENCES clients(id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'build' AND c.relname = 'tickets' AND k.conname = 'fk_tickets_customer_id_org') THEN
    ALTER TABLE "build"."tickets" ADD CONSTRAINT "fk_tickets_customer_id_org" FOREIGN KEY (org_id, customer_id) REFERENCES crm_organizations(org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'lead_party_map' AND k.conname = 'fk_lead_party_map_legacy') THEN
    ALTER TABLE "public"."lead_party_map" ADD CONSTRAINT "fk_lead_party_map_legacy" FOREIGN KEY (organization_id, lead_id) REFERENCES leads(org_id, id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'client_party_map' AND k.conname = 'fk_client_party_map_legacy') THEN
    ALTER TABLE "public"."client_party_map" ADD CONSTRAINT "fk_client_party_map_legacy" FOREIGN KEY (organization_id, client_id) REFERENCES clients(org_id, id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'contact_party_map' AND k.conname = 'fk_contact_party_map_legacy') THEN
    ALTER TABLE "public"."contact_party_map" ADD CONSTRAINT "fk_contact_party_map_legacy" FOREIGN KEY (organization_id, contact_id) REFERENCES contacts(org_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $repair$;
--> statement-breakpoint
--
-- indexes (14)
--
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_jl_org_client ON public.journal_lines USING btree (org_id, client_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_jl_org_vendor ON public.journal_lines USING btree (org_id, vendor_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_jl_org_project ON public.journal_lines USING btree (org_id, project_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_jl_org_department ON public.journal_lines USING btree (org_id, department_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_jl_org_employee ON public.journal_lines USING btree (org_id, employee_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_jl_org_tax_code ON public.journal_lines USING btree (org_id, tax_code_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_je_org_status_date ON public.journal_entries USING btree (org_id, status, entry_date);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_leads_name_trgm ON public.leads USING gin (name gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_leads_email_trgm ON public.leads USING gin (email gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_leads_phone_trgm ON public.leads USING gin (phone gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_leads_company_trgm ON public.leads USING gin (company gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_cfd_org_entity ON public.custom_field_definitions USING btree (org_id, entity_type);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_inv_variants_org_sku ON public.inv_product_variants USING btree (org_id, sku);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_inv_products_org_sku ON public.inv_products USING btree (org_id, sku);
--> statement-breakpoint
--
-- triggers (3)
--
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'vendor_credit_items' AND t.tgname = 'trg_set_org_id') THEN
    CREATE TRIGGER trg_set_org_id BEFORE INSERT ON public.vendor_credit_items FOR EACH ROW EXECUTE FUNCTION set_org_id_from_parent('vendor_credits', 'id', 'org_id', 'vendor_credit_id');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'credit_note_items' AND t.tgname = 'trg_set_org_id') THEN
    CREATE TRIGGER trg_set_org_id BEFORE INSERT ON public.credit_note_items FOR EACH ROW EXECUTE FUNCTION set_org_id_from_parent('credit_notes', 'id', 'org_id', 'credit_note_id');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_payment_run_items' AND t.tgname = 'trg_set_org_id') THEN
    CREATE TRIGGER trg_set_org_id BEFORE INSERT ON public.fin_payment_run_items FOR EACH ROW EXECUTE FUNCTION set_org_id_from_parent('fin_payment_runs', 'id', 'org_id', 'run_id');
  END IF;
END $repair$;
--> statement-breakpoint
--
-- row-level security (3)
--
--> statement-breakpoint
ALTER TABLE "public"."fin_payment_run_items" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."vendor_credit_items" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."credit_note_items" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
--
-- tenant isolation policies (3)
--
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'fin_payment_run_items' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."fin_payment_run_items" AS PERMISSIVE FOR ALL TO "public" USING ((org_id = current_org_id())) WITH CHECK ((org_id = current_org_id()));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'vendor_credit_items' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."vendor_credit_items" AS PERMISSIVE FOR ALL TO "public" USING ((org_id = current_org_id())) WITH CHECK ((org_id = current_org_id()));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'credit_note_items' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."credit_note_items" AS PERMISSIVE FOR ALL TO "public" USING ((org_id = current_org_id())) WITH CHECK ((org_id = current_org_id()));
  END IF;
END $repair$;
