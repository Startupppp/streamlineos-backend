-- Retire the pre-rewrite accounting schema.
--
-- 0464 and 0465 built the ledger kernel and its source documents on `gl_*`,
-- `ar_*`, `ap_*`, `tax_*` and `bank_*` tables, and deliberately left the old
-- `ledger_accounts` / `journal_entries` / `journal_lines` set in place because
-- `finance/`, `invoices/` and `expenses/` still read them. Those modules are
-- gone, so the tables are now unreachable code with a schema attached — and
-- worse than inert: the old `@Controller("accounting")` collided with the new
-- kernel's routes, which is what forced this to happen now rather than later.
--
-- Safe to drop outright, verified against the live database immediately before
-- writing this: all 45 tables hold **zero rows**, no view, materialized view or
-- function depends on any of them, and every trigger involved sits on a table
-- being dropped. There is no book data to preserve, so there is nothing to
-- migrate into the new ledger.
--
-- Four foreign keys point in from tables that survive, all from `expenses` and
-- `expense_categories` (db/schema/hr/payroll.ts). Both referencing columns are
-- entirely NULL, so the constraints are dropped and the columns kept as plain
-- integers — the Drizzle schema still declares them, and dropping the columns
-- here would put the migration ahead of the code.
--
-- Hand-authored for the same reason as 0464 and 0465: `migrations/meta`
-- snapshots stop at 0231 while migrations run to 0465, so `drizzle-kit generate`
-- would diff against a baseline ~230 migrations stale and propose recreating
-- all of it.

SET lock_timeout = '5s';

--> statement-breakpoint
-- 1. Release the surviving tables first, so the DROP below needs no cascade
--    into anything outside the retired set.
ALTER TABLE "expenses"
  DROP CONSTRAINT IF EXISTS "expenses_posted_journal_entry_id_journal_entries_id_fk";
--> statement-breakpoint
ALTER TABLE "expenses"
  DROP CONSTRAINT IF EXISTS "fk_expenses_posted_journal_entry_id_org";
--> statement-breakpoint
ALTER TABLE "expense_categories"
  DROP CONSTRAINT IF EXISTS "expense_categories_ledger_account_id_ledger_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "expense_categories"
  DROP CONSTRAINT IF EXISTS "fk_expense_categories_ledger_account_id_org";

--> statement-breakpoint
-- 2. The 45 retired tables. One statement with CASCADE because they reference
--    each other heavily and nothing outside the list depends on them any more —
--    the only inbound edges were the four constraints dropped above.
DROP TABLE IF EXISTS
  "journal_lines",
  "journal_entries",
  "ledger_accounts",
  "indian_states",
  "accounting_periods",
  "accounting_dimension_values",
  "accounting_dimensions",
  "accounting_settings",
  "acc_number_sequences",
  "acc_system_account_map",
  "fin_exchange_rates",
  "fin_approval_requests",
  "fin_approval_policies",
  "fin_recurring_journal_templates",
  "credit_note_items",
  "credit_notes",
  "fin_payment_allocations",
  "vendor_credit_items",
  "vendor_credits",
  "fin_vendor_payment_allocations",
  "fin_recurring_invoice_templates",
  "fin_recurring_bill_templates",
  "fin_reminder_policies",
  "fin_reminder_log",
  "fin_collection_activities",
  "fin_payment_run_items",
  "fin_payment_runs",
  "fin_bank_transactions",
  "fin_bank_imports",
  "fin_bank_accounts",
  "fin_reconciliation_matches",
  "fin_reconciliation_rules",
  "fin_bank_transfers",
  "acc_tax_payments",
  "acc_tax_codes",
  "acc_depreciation_schedules",
  "acc_depreciation_runs",
  "acc_fixed_assets",
  "acc_asset_categories",
  "fin_budget_lines",
  "fin_budget_revisions",
  "fin_budgets",
  "fin_cash_flow_scenarios",
  "fin_reimbursement_batches",
  "fin_expense_policies"
  CASCADE;

--> statement-breakpoint
-- 3. The enum types those tables owned. Each was checked against pg_attribute
--    first: every one is referenced only by columns in the set dropped above,
--    so none is still in use. `account_type` and `journal_entry_status` are the
--    two that never carried an `acc_`/`fin_` prefix.
DROP TYPE IF EXISTS
  "public"."acc_asset_status",
  "public"."acc_basis",
  "public"."acc_depreciation_line_status",
  "public"."acc_depreciation_method",
  "public"."acc_depreciation_run_status",
  "public"."acc_normal_balance",
  "public"."acc_period_status",
  "public"."acc_system_purpose",
  "public"."acc_tax_type",
  "public"."account_type",
  "public"."fin_approval_record_type",
  "public"."fin_approval_status",
  "public"."fin_bank_account_type",
  "public"."fin_bank_import_format",
  "public"."fin_bank_import_status",
  "public"."fin_bank_txn_status",
  "public"."fin_budget_dimension",
  "public"."fin_budget_period",
  "public"."fin_budget_status",
  "public"."fin_collection_activity_type",
  "public"."fin_credit_note_status",
  "public"."fin_payment_run_item_status",
  "public"."fin_payment_run_status",
  "public"."fin_recon_match_type",
  "public"."fin_recur_frequency",
  "public"."fin_reimbursement_batch_status",
  "public"."fin_reminder_channel",
  "public"."fin_scenario_kind",
  "public"."journal_entry_status";
