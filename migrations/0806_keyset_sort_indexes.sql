SET lock_timeout = '5s';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_fin_recurring_journal_templates_name_id
  ON public.fin_recurring_journal_templates (org_id, name, id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_clients_vendor_name_id
  ON public.clients (org_id, name, id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_ts_periods_org_status_submitted
  ON public.timesheet_periods (org_id, status, submitted_at DESC, id DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_timesheets_org_date_id
  ON public.timesheets (org_id, date DESC, id DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_ts_exceptions_org_created_id
  ON public.timesheet_exceptions (org_id, created_at DESC, id DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_ts_audit_org_created_id
  ON public.timesheet_audit_events (org_id, created_at DESC, id DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_ts_exports_org_created_id
  ON public.timesheet_exports (org_id, created_at DESC, id DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_fin_payment_runs_org_created_id
  ON public.fin_payment_runs (org_id, created_at DESC, id DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_fin_recurring_bill_templates_name_id
  ON public.fin_recurring_bill_templates (org_id, name, id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_vendor_credits_org_created_id
  ON public.vendor_credits (org_id, created_at DESC, id DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_vendor_payments_org_date_id
  ON public.vendor_payments (org_id, payment_date DESC, id DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_payments_org_date_id
  ON public.payments (org_id, payment_date DESC, id DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_fin_collection_activities_org_created_id
  ON public.fin_collection_activities (org_id, created_at DESC, id DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_credit_notes_org_created_id
  ON public.credit_notes (org_id, created_at DESC, id DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_fin_recurring_invoice_templates_org_created_id
  ON public.fin_recurring_invoice_templates (org_id, created_at DESC, id DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_acc_asset_categories_name_id
  ON public.acc_asset_categories (org_id, name, id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_acc_fixed_assets_org_created_id
  ON public.acc_fixed_assets (org_id, created_at DESC, id DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_acc_depreciation_runs_org_created_id
  ON public.acc_depreciation_runs (org_id, created_at DESC, id DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_fin_bank_accounts_name_id
  ON public.fin_bank_accounts (org_id, name, id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_fin_bank_transactions_txn_date_id
  ON public.fin_bank_transactions (org_id, txn_date DESC, id DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_fin_bank_imports_org_created_id
  ON public.fin_bank_imports (org_id, created_at DESC, id DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_fin_reconciliation_rules_priority_id
  ON public.fin_reconciliation_rules (org_id, priority DESC, id DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_fin_bank_transfers_date_id
  ON public.fin_bank_transfers (org_id, transfer_date DESC, id DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_fin_approval_policies_org_created_id
  ON public.fin_approval_policies (org_id, created_at DESC, id DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_fin_approval_requests_org_created_id
  ON public.fin_approval_requests (org_id, created_at DESC, id DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_fin_exchange_rates_as_of_date_id
  ON public.fin_exchange_rates (org_id, as_of_date DESC, id DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_fin_budgets_org_created_id
  ON public.fin_budgets (org_id, created_at DESC, id DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_acc_tax_codes_code_id
  ON public.acc_tax_codes (org_id, code, id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_project_teams_org_created_id
  ON build.project_teams (org_id, created_at DESC, id DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_project_team_members_org_team_joined
  ON build.project_team_members (org_id, team_id, joined_at, id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_project_portfolios_org_created_id
  ON build.project_portfolios (org_id, created_at DESC, id DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_managed_products_org_created_id
  ON build.managed_products (org_id, created_at DESC, id DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_pm_workspaces_org_created_slug
  ON build.pm_workspaces (org_id, created_at, slug);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_pm_workspace_memberships_org_ws_added
  ON build.pm_workspace_memberships (org_id, pm_workspace_id, added_at, organization_membership_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_project_workspace_members_org_added_user
  ON build.project_workspace_members (org_id, added_at, user_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_intake_items_org_project_created_id
  ON build.intake_items (org_id, project_id, created_at DESC, id DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_projects_org_id_desc
  ON build.projects (org_id, id DESC);
--> statement-breakpoint

DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(expected.name, ', ') INTO missing
  FROM (VALUES
    ('idx_fin_recurring_journal_templates_name_id'),
    ('idx_clients_vendor_name_id'),
    ('idx_ts_periods_org_status_submitted'),
    ('idx_timesheets_org_date_id'),
    ('idx_ts_exceptions_org_created_id'),
    ('idx_ts_audit_org_created_id'),
    ('idx_ts_exports_org_created_id'),
    ('idx_fin_payment_runs_org_created_id'),
    ('idx_fin_recurring_bill_templates_name_id'),
    ('idx_vendor_credits_org_created_id'),
    ('idx_vendor_payments_org_date_id'),
    ('idx_payments_org_date_id'),
    ('idx_fin_collection_activities_org_created_id'),
    ('idx_credit_notes_org_created_id'),
    ('idx_fin_recurring_invoice_templates_org_created_id'),
    ('idx_acc_asset_categories_name_id'),
    ('idx_acc_fixed_assets_org_created_id'),
    ('idx_acc_depreciation_runs_org_created_id'),
    ('idx_fin_bank_accounts_name_id'),
    ('idx_fin_bank_transactions_txn_date_id'),
    ('idx_fin_bank_imports_org_created_id'),
    ('idx_fin_reconciliation_rules_priority_id'),
    ('idx_fin_bank_transfers_date_id'),
    ('idx_fin_approval_policies_org_created_id'),
    ('idx_fin_approval_requests_org_created_id'),
    ('idx_fin_exchange_rates_as_of_date_id'),
    ('idx_fin_budgets_org_created_id'),
    ('idx_acc_tax_codes_code_id'),
    ('idx_project_teams_org_created_id'),
    ('idx_project_team_members_org_team_joined'),
    ('idx_project_portfolios_org_created_id'),
    ('idx_managed_products_org_created_id'),
    ('idx_pm_workspaces_org_created_slug'),
    ('idx_pm_workspace_memberships_org_ws_added'),
    ('idx_project_workspace_members_org_added_user'),
    ('idx_intake_items_org_project_created_id'),
    ('idx_projects_org_id_desc')
  ) AS expected(name)
  WHERE NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = expected.name);

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '0806: keyset sort index missing, page-2 sorts fall back to a full sort: %', missing;
  END IF;
END $$;
