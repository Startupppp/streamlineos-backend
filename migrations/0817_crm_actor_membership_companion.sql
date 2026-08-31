SET lock_timeout = '5s';
--> statement-breakpoint

-- ============================================================
-- 0817 — CRM legacy-actor membership companion columns
-- ============================================================
-- Additive migration: adds INTEGER membership_id companion columns to every
-- CRM table that currently references users.id in an organisational-actor
-- role (assigned_to, created_by, approved_by, owner, etc.).
--
-- Pattern: ADD COLUMN IF NOT EXISTS → composite FK NOT VALID → partial index
-- → backfill (re-runnable, WHERE companion IS NULL) → VALIDATE CONSTRAINT.
-- No legacy user_id columns are dropped here; 0818 handles inventory and
-- subsequent lanes will handle drops once every reader is updated.
--
-- CRITICAL SQL RULES applied:
--   • Every ADD CONSTRAINT preceded by DROP CONSTRAINT IF EXISTS (42710)
--   • Composite ON DELETE SET NULL carries explicit column list (23502)
--   • VALIDATE uses ALTER TABLE t VALIDATE CONSTRAINT c; form (42601)
--   • No statement-breakpoint inside DO $$ ... $$ blocks
--   • Backfills guarded on information_schema + WHERE companion IS NULL
-- ============================================================

-- ============================================================
-- SECTION 1 — ADD COMPANION COLUMNS
-- ============================================================

ALTER TABLE clients ADD COLUMN IF NOT EXISTS account_manager_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE client_accounts ADD COLUMN IF NOT EXISTS sales_rep_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE client_accounts ADD COLUMN IF NOT EXISTS assigned_crm_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE client_account_activities ADD COLUMN IF NOT EXISTS user_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE client_opportunities ADD COLUMN IF NOT EXISTS created_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE client_onboarding_templates ADD COLUMN IF NOT EXISTS created_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE client_onboarding_items ADD COLUMN IF NOT EXISTS assigned_to_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE client_onboarding_items ADD COLUMN IF NOT EXISTS completed_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE csat_surveys ADD COLUMN IF NOT EXISTS created_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE deals ADD COLUMN IF NOT EXISTS assigned_to_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE deal_activities ADD COLUMN IF NOT EXISTS user_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE deal_meetings ADD COLUMN IF NOT EXISTS created_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE deal_approval_rules ADD COLUMN IF NOT EXISTS approver_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE deal_approvals ADD COLUMN IF NOT EXISTS requested_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE deal_approvals ADD COLUMN IF NOT EXISTS approved_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE crm_forecast_snapshots ADD COLUMN IF NOT EXISTS created_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE crm_forecast_snapshots ADD COLUMN IF NOT EXISTS overridden_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE leads ADD COLUMN IF NOT EXISTS assigned_to_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE leads ADD COLUMN IF NOT EXISTS assigned_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE leads ADD COLUMN IF NOT EXISTS verified_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE lead_activities ADD COLUMN IF NOT EXISTS user_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE lead_notes ADD COLUMN IF NOT EXISTS author_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE lead_tasks ADD COLUMN IF NOT EXISTS assignee_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE lead_assignment_rules ADD COLUMN IF NOT EXISTS assign_to_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE lead_import_batches ADD COLUMN IF NOT EXISTS created_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE web_lead_forms ADD COLUMN IF NOT EXISTS created_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE crm_email_templates ADD COLUMN IF NOT EXISTS created_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE crm_campaigns ADD COLUMN IF NOT EXISTS owner_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE crm_contact_channel_consent ADD COLUMN IF NOT EXISTS recorded_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE crm_contact_consent_events ADD COLUMN IF NOT EXISTS recorded_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE health_score_config ADD COLUMN IF NOT EXISTS updated_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE territories ADD COLUMN IF NOT EXISTS created_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS created_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS collection_owner_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE payments ADD COLUMN IF NOT EXISTS created_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE purchase_bills ADD COLUMN IF NOT EXISTS created_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE purchase_bills ADD COLUMN IF NOT EXISTS approved_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE vendor_payments ADD COLUMN IF NOT EXISTS created_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS created_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS approved_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE nps_surveys ADD COLUMN IF NOT EXISTS created_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE playbook_entries ADD COLUMN IF NOT EXISTS created_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assignee_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS created_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE task_sequences ADD COLUMN IF NOT EXISTS created_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE sales_quotas ADD COLUMN IF NOT EXISTS user_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE sales_quotas ADD COLUMN IF NOT EXISTS set_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE commissions ADD COLUMN IF NOT EXISTS user_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE incentive_config ADD COLUMN IF NOT EXISTS created_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE incentives ADD COLUMN IF NOT EXISTS sales_rep_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE incentives ADD COLUMN IF NOT EXISTS approved_by_membership_id INTEGER;
--> statement-breakpoint

-- ============================================================
-- SECTION 2 — FOREIGN KEY CONSTRAINTS (NOT VALID)
-- Composite FK for all tables — client_account_activities
-- carries org_id so it uses the same composite form.
-- ============================================================

ALTER TABLE clients DROP CONSTRAINT IF EXISTS fk_clients_acct_mgr_mbr;
--> statement-breakpoint
ALTER TABLE clients ADD CONSTRAINT fk_clients_acct_mgr_mbr
  FOREIGN KEY (org_id, account_manager_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (account_manager_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE client_accounts DROP CONSTRAINT IF EXISTS fk_client_accts_sales_rep_mbr;
--> statement-breakpoint
ALTER TABLE client_accounts ADD CONSTRAINT fk_client_accts_sales_rep_mbr
  FOREIGN KEY (org_id, sales_rep_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (sales_rep_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE client_accounts DROP CONSTRAINT IF EXISTS fk_client_accts_assigned_crm_mbr;
--> statement-breakpoint
ALTER TABLE client_accounts ADD CONSTRAINT fk_client_accts_assigned_crm_mbr
  FOREIGN KEY (org_id, assigned_crm_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (assigned_crm_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE client_account_activities DROP CONSTRAINT IF EXISTS fk_caa_user_mbr;
--> statement-breakpoint
ALTER TABLE client_account_activities ADD CONSTRAINT fk_caa_user_mbr
  FOREIGN KEY (org_id, user_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (user_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE client_opportunities DROP CONSTRAINT IF EXISTS fk_client_opps_created_by_mbr;
--> statement-breakpoint
ALTER TABLE client_opportunities ADD CONSTRAINT fk_client_opps_created_by_mbr
  FOREIGN KEY (org_id, created_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (created_by_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE client_onboarding_templates DROP CONSTRAINT IF EXISTS fk_cob_tmpls_created_by_mbr;
--> statement-breakpoint
ALTER TABLE client_onboarding_templates ADD CONSTRAINT fk_cob_tmpls_created_by_mbr
  FOREIGN KEY (org_id, created_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (created_by_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE client_onboarding_items DROP CONSTRAINT IF EXISTS fk_cob_items_assigned_to_mbr;
--> statement-breakpoint
ALTER TABLE client_onboarding_items ADD CONSTRAINT fk_cob_items_assigned_to_mbr
  FOREIGN KEY (org_id, assigned_to_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (assigned_to_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE client_onboarding_items DROP CONSTRAINT IF EXISTS fk_cob_items_completed_by_mbr;
--> statement-breakpoint
ALTER TABLE client_onboarding_items ADD CONSTRAINT fk_cob_items_completed_by_mbr
  FOREIGN KEY (org_id, completed_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (completed_by_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE csat_surveys DROP CONSTRAINT IF EXISTS fk_csat_surveys_created_by_mbr;
--> statement-breakpoint
ALTER TABLE csat_surveys ADD CONSTRAINT fk_csat_surveys_created_by_mbr
  FOREIGN KEY (org_id, created_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (created_by_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE deals DROP CONSTRAINT IF EXISTS fk_deals_assigned_to_mbr;
--> statement-breakpoint
ALTER TABLE deals ADD CONSTRAINT fk_deals_assigned_to_mbr
  FOREIGN KEY (org_id, assigned_to_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (assigned_to_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE deal_activities DROP CONSTRAINT IF EXISTS fk_deal_activities_user_mbr;
--> statement-breakpoint
ALTER TABLE deal_activities ADD CONSTRAINT fk_deal_activities_user_mbr
  FOREIGN KEY (org_id, user_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (user_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE deal_meetings DROP CONSTRAINT IF EXISTS fk_deal_meetings_created_by_mbr;
--> statement-breakpoint
ALTER TABLE deal_meetings ADD CONSTRAINT fk_deal_meetings_created_by_mbr
  FOREIGN KEY (org_id, created_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (created_by_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE deal_approval_rules DROP CONSTRAINT IF EXISTS fk_deal_appr_rules_approver_mbr;
--> statement-breakpoint
ALTER TABLE deal_approval_rules ADD CONSTRAINT fk_deal_appr_rules_approver_mbr
  FOREIGN KEY (org_id, approver_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (approver_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE deal_approvals DROP CONSTRAINT IF EXISTS fk_deal_approvals_req_by_mbr;
--> statement-breakpoint
ALTER TABLE deal_approvals ADD CONSTRAINT fk_deal_approvals_req_by_mbr
  FOREIGN KEY (org_id, requested_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (requested_by_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE deal_approvals DROP CONSTRAINT IF EXISTS fk_deal_approvals_appr_by_mbr;
--> statement-breakpoint
ALTER TABLE deal_approvals ADD CONSTRAINT fk_deal_approvals_appr_by_mbr
  FOREIGN KEY (org_id, approved_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (approved_by_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE crm_forecast_snapshots DROP CONSTRAINT IF EXISTS fk_crm_fcast_snap_created_by_mbr;
--> statement-breakpoint
ALTER TABLE crm_forecast_snapshots ADD CONSTRAINT fk_crm_fcast_snap_created_by_mbr
  FOREIGN KEY (org_id, created_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (created_by_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE crm_forecast_snapshots DROP CONSTRAINT IF EXISTS fk_crm_fcast_snap_overr_by_mbr;
--> statement-breakpoint
ALTER TABLE crm_forecast_snapshots ADD CONSTRAINT fk_crm_fcast_snap_overr_by_mbr
  FOREIGN KEY (org_id, overridden_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (overridden_by_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE leads DROP CONSTRAINT IF EXISTS fk_leads_assigned_to_mbr;
--> statement-breakpoint
ALTER TABLE leads ADD CONSTRAINT fk_leads_assigned_to_mbr
  FOREIGN KEY (org_id, assigned_to_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (assigned_to_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE leads DROP CONSTRAINT IF EXISTS fk_leads_assigned_by_mbr;
--> statement-breakpoint
ALTER TABLE leads ADD CONSTRAINT fk_leads_assigned_by_mbr
  FOREIGN KEY (org_id, assigned_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (assigned_by_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE leads DROP CONSTRAINT IF EXISTS fk_leads_verified_by_mbr;
--> statement-breakpoint
ALTER TABLE leads ADD CONSTRAINT fk_leads_verified_by_mbr
  FOREIGN KEY (org_id, verified_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (verified_by_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE lead_activities DROP CONSTRAINT IF EXISTS fk_lead_activities_user_mbr;
--> statement-breakpoint
ALTER TABLE lead_activities ADD CONSTRAINT fk_lead_activities_user_mbr
  FOREIGN KEY (org_id, user_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (user_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE lead_notes DROP CONSTRAINT IF EXISTS fk_lead_notes_author_mbr;
--> statement-breakpoint
ALTER TABLE lead_notes ADD CONSTRAINT fk_lead_notes_author_mbr
  FOREIGN KEY (org_id, author_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (author_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE lead_tasks DROP CONSTRAINT IF EXISTS fk_lead_tasks_assignee_mbr;
--> statement-breakpoint
ALTER TABLE lead_tasks ADD CONSTRAINT fk_lead_tasks_assignee_mbr
  FOREIGN KEY (org_id, assignee_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (assignee_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE lead_assignment_rules DROP CONSTRAINT IF EXISTS fk_lead_assign_rules_assign_mbr;
--> statement-breakpoint
ALTER TABLE lead_assignment_rules ADD CONSTRAINT fk_lead_assign_rules_assign_mbr
  FOREIGN KEY (org_id, assign_to_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (assign_to_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE lead_import_batches DROP CONSTRAINT IF EXISTS fk_lead_import_batches_cre_mbr;
--> statement-breakpoint
ALTER TABLE lead_import_batches ADD CONSTRAINT fk_lead_import_batches_cre_mbr
  FOREIGN KEY (org_id, created_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (created_by_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE web_lead_forms DROP CONSTRAINT IF EXISTS fk_web_lead_forms_created_mbr;
--> statement-breakpoint
ALTER TABLE web_lead_forms ADD CONSTRAINT fk_web_lead_forms_created_mbr
  FOREIGN KEY (org_id, created_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (created_by_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE crm_email_templates DROP CONSTRAINT IF EXISTS fk_crm_email_tmpls_cre_mbr;
--> statement-breakpoint
ALTER TABLE crm_email_templates ADD CONSTRAINT fk_crm_email_tmpls_cre_mbr
  FOREIGN KEY (org_id, created_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (created_by_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE crm_campaigns DROP CONSTRAINT IF EXISTS fk_crm_campaigns_owner_mbr;
--> statement-breakpoint
ALTER TABLE crm_campaigns ADD CONSTRAINT fk_crm_campaigns_owner_mbr
  FOREIGN KEY (org_id, owner_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (owner_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE crm_contact_channel_consent DROP CONSTRAINT IF EXISTS fk_crm_chan_consent_rec_by_mbr;
--> statement-breakpoint
ALTER TABLE crm_contact_channel_consent ADD CONSTRAINT fk_crm_chan_consent_rec_by_mbr
  FOREIGN KEY (org_id, recorded_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (recorded_by_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE crm_contact_consent_events DROP CONSTRAINT IF EXISTS fk_crm_consent_events_rec_mbr;
--> statement-breakpoint
ALTER TABLE crm_contact_consent_events ADD CONSTRAINT fk_crm_consent_events_rec_mbr
  FOREIGN KEY (org_id, recorded_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (recorded_by_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE health_score_config DROP CONSTRAINT IF EXISTS fk_health_score_cfg_upd_mbr;
--> statement-breakpoint
ALTER TABLE health_score_config ADD CONSTRAINT fk_health_score_cfg_upd_mbr
  FOREIGN KEY (org_id, updated_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (updated_by_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE territories DROP CONSTRAINT IF EXISTS fk_territories_created_by_mbr;
--> statement-breakpoint
ALTER TABLE territories ADD CONSTRAINT fk_territories_created_by_mbr
  FOREIGN KEY (org_id, created_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (created_by_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE invoices DROP CONSTRAINT IF EXISTS fk_invoices_created_by_mbr;
--> statement-breakpoint
ALTER TABLE invoices ADD CONSTRAINT fk_invoices_created_by_mbr
  FOREIGN KEY (org_id, created_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (created_by_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE invoices DROP CONSTRAINT IF EXISTS fk_invoices_coll_owner_mbr;
--> statement-breakpoint
ALTER TABLE invoices ADD CONSTRAINT fk_invoices_coll_owner_mbr
  FOREIGN KEY (org_id, collection_owner_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (collection_owner_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE payments DROP CONSTRAINT IF EXISTS fk_payments_created_by_mbr;
--> statement-breakpoint
ALTER TABLE payments ADD CONSTRAINT fk_payments_created_by_mbr
  FOREIGN KEY (org_id, created_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (created_by_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE purchase_bills DROP CONSTRAINT IF EXISTS fk_purchase_bills_created_mbr;
--> statement-breakpoint
ALTER TABLE purchase_bills ADD CONSTRAINT fk_purchase_bills_created_mbr
  FOREIGN KEY (org_id, created_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (created_by_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE purchase_bills DROP CONSTRAINT IF EXISTS fk_purchase_bills_appr_by_mbr;
--> statement-breakpoint
ALTER TABLE purchase_bills ADD CONSTRAINT fk_purchase_bills_appr_by_mbr
  FOREIGN KEY (org_id, approved_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (approved_by_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE vendor_payments DROP CONSTRAINT IF EXISTS fk_vendor_payments_cre_mbr;
--> statement-breakpoint
ALTER TABLE vendor_payments ADD CONSTRAINT fk_vendor_payments_cre_mbr
  FOREIGN KEY (org_id, created_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (created_by_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE quotes DROP CONSTRAINT IF EXISTS fk_quotes_created_by_mbr;
--> statement-breakpoint
ALTER TABLE quotes ADD CONSTRAINT fk_quotes_created_by_mbr
  FOREIGN KEY (org_id, created_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (created_by_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE quotes DROP CONSTRAINT IF EXISTS fk_quotes_appr_by_mbr;
--> statement-breakpoint
ALTER TABLE quotes ADD CONSTRAINT fk_quotes_appr_by_mbr
  FOREIGN KEY (org_id, approved_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (approved_by_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE nps_surveys DROP CONSTRAINT IF EXISTS fk_nps_surveys_created_by_mbr;
--> statement-breakpoint
ALTER TABLE nps_surveys ADD CONSTRAINT fk_nps_surveys_created_by_mbr
  FOREIGN KEY (org_id, created_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (created_by_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE playbook_entries DROP CONSTRAINT IF EXISTS fk_playbook_entries_cre_mbr;
--> statement-breakpoint
ALTER TABLE playbook_entries ADD CONSTRAINT fk_playbook_entries_cre_mbr
  FOREIGN KEY (org_id, created_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (created_by_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS fk_tasks_assignee_mbr;
--> statement-breakpoint
ALTER TABLE tasks ADD CONSTRAINT fk_tasks_assignee_mbr
  FOREIGN KEY (org_id, assignee_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (assignee_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS fk_tasks_created_by_mbr;
--> statement-breakpoint
ALTER TABLE tasks ADD CONSTRAINT fk_tasks_created_by_mbr
  FOREIGN KEY (org_id, created_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (created_by_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE task_sequences DROP CONSTRAINT IF EXISTS fk_task_sequences_created_mbr;
--> statement-breakpoint
ALTER TABLE task_sequences ADD CONSTRAINT fk_task_sequences_created_mbr
  FOREIGN KEY (org_id, created_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (created_by_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE sales_quotas DROP CONSTRAINT IF EXISTS fk_sales_quotas_user_mbr;
--> statement-breakpoint
ALTER TABLE sales_quotas ADD CONSTRAINT fk_sales_quotas_user_mbr
  FOREIGN KEY (org_id, user_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (user_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE sales_quotas DROP CONSTRAINT IF EXISTS fk_sales_quotas_set_by_mbr;
--> statement-breakpoint
ALTER TABLE sales_quotas ADD CONSTRAINT fk_sales_quotas_set_by_mbr
  FOREIGN KEY (org_id, set_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (set_by_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE commissions DROP CONSTRAINT IF EXISTS fk_commissions_user_mbr;
--> statement-breakpoint
ALTER TABLE commissions ADD CONSTRAINT fk_commissions_user_mbr
  FOREIGN KEY (org_id, user_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (user_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE incentive_config DROP CONSTRAINT IF EXISTS fk_incentive_cfg_created_mbr;
--> statement-breakpoint
ALTER TABLE incentive_config ADD CONSTRAINT fk_incentive_cfg_created_mbr
  FOREIGN KEY (org_id, created_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (created_by_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE incentives DROP CONSTRAINT IF EXISTS fk_incentives_sales_rep_mbr;
--> statement-breakpoint
ALTER TABLE incentives ADD CONSTRAINT fk_incentives_sales_rep_mbr
  FOREIGN KEY (org_id, sales_rep_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (sales_rep_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE incentives DROP CONSTRAINT IF EXISTS fk_incentives_appr_by_mbr;
--> statement-breakpoint
ALTER TABLE incentives ADD CONSTRAINT fk_incentives_appr_by_mbr
  FOREIGN KEY (org_id, approved_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (approved_by_membership_id)
  NOT VALID;
--> statement-breakpoint

-- ============================================================
-- SECTION 3 — PARTIAL INDEXES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_clients_acct_mgr_mbr ON clients (org_id, account_manager_membership_id) WHERE account_manager_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_client_accts_sales_rep_mbr ON client_accounts (org_id, sales_rep_membership_id) WHERE sales_rep_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_client_accts_assigned_crm_mbr ON client_accounts (org_id, assigned_crm_membership_id) WHERE assigned_crm_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_caa_user_mbr ON client_account_activities (org_id, user_membership_id) WHERE user_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_client_opps_created_by_mbr ON client_opportunities (org_id, created_by_membership_id) WHERE created_by_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_cob_tmpls_created_by_mbr ON client_onboarding_templates (org_id, created_by_membership_id) WHERE created_by_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_cob_items_assigned_to_mbr ON client_onboarding_items (org_id, assigned_to_membership_id) WHERE assigned_to_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_cob_items_completed_by_mbr ON client_onboarding_items (org_id, completed_by_membership_id) WHERE completed_by_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_csat_surveys_created_mbr ON csat_surveys (org_id, created_by_membership_id) WHERE created_by_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_deals_assigned_to_mbr ON deals (org_id, assigned_to_membership_id) WHERE assigned_to_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_deal_activities_user_mbr ON deal_activities (org_id, user_membership_id) WHERE user_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_deal_meetings_created_mbr ON deal_meetings (org_id, created_by_membership_id) WHERE created_by_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_deal_appr_rules_approver_mbr ON deal_approval_rules (org_id, approver_membership_id) WHERE approver_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_deal_approvals_req_by_mbr ON deal_approvals (org_id, requested_by_membership_id) WHERE requested_by_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_deal_approvals_appr_by_mbr ON deal_approvals (org_id, approved_by_membership_id) WHERE approved_by_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_fcast_snap_cre_mbr ON crm_forecast_snapshots (org_id, created_by_membership_id) WHERE created_by_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_fcast_snap_overr_mbr ON crm_forecast_snapshots (org_id, overridden_by_membership_id) WHERE overridden_by_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_leads_assigned_to_mbr ON leads (org_id, assigned_to_membership_id) WHERE assigned_to_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_leads_assigned_by_mbr ON leads (org_id, assigned_by_membership_id) WHERE assigned_by_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_leads_verified_by_mbr ON leads (org_id, verified_by_membership_id) WHERE verified_by_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_lead_activities_user_mbr ON lead_activities (org_id, user_membership_id) WHERE user_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_lead_notes_author_mbr ON lead_notes (org_id, author_membership_id) WHERE author_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_lead_tasks_assignee_mbr ON lead_tasks (org_id, assignee_membership_id) WHERE assignee_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_lead_assign_rules_assign_mbr ON lead_assignment_rules (org_id, assign_to_membership_id) WHERE assign_to_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_lead_import_batches_cre_mbr ON lead_import_batches (org_id, created_by_membership_id) WHERE created_by_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_web_lead_forms_created_mbr ON web_lead_forms (org_id, created_by_membership_id) WHERE created_by_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_email_tmpls_cre_mbr ON crm_email_templates (org_id, created_by_membership_id) WHERE created_by_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_campaigns_owner_mbr ON crm_campaigns (org_id, owner_membership_id) WHERE owner_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_chan_consent_rec_mbr ON crm_contact_channel_consent (org_id, recorded_by_membership_id) WHERE recorded_by_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_consent_events_rec_mbr ON crm_contact_consent_events (org_id, recorded_by_membership_id) WHERE recorded_by_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_health_score_cfg_upd_mbr ON health_score_config (org_id, updated_by_membership_id) WHERE updated_by_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_territories_created_mbr ON territories (org_id, created_by_membership_id) WHERE created_by_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_invoices_created_by_mbr ON invoices (org_id, created_by_membership_id) WHERE created_by_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_invoices_coll_owner_mbr ON invoices (org_id, collection_owner_membership_id) WHERE collection_owner_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_payments_created_by_mbr ON payments (org_id, created_by_membership_id) WHERE created_by_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_purchase_bills_created_mbr ON purchase_bills (org_id, created_by_membership_id) WHERE created_by_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_purchase_bills_appr_mbr ON purchase_bills (org_id, approved_by_membership_id) WHERE approved_by_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_vendor_payments_cre_mbr ON vendor_payments (org_id, created_by_membership_id) WHERE created_by_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_quotes_created_by_mbr ON quotes (org_id, created_by_membership_id) WHERE created_by_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_quotes_appr_by_mbr ON quotes (org_id, approved_by_membership_id) WHERE approved_by_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_nps_surveys_created_mbr ON nps_surveys (org_id, created_by_membership_id) WHERE created_by_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_playbook_entries_created_mbr ON playbook_entries (org_id, created_by_membership_id) WHERE created_by_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tasks_assignee_mbr ON tasks (org_id, assignee_membership_id) WHERE assignee_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tasks_created_by_mbr ON tasks (org_id, created_by_membership_id) WHERE created_by_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_task_sequences_created_mbr ON task_sequences (org_id, created_by_membership_id) WHERE created_by_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_sales_quotas_user_mbr ON sales_quotas (org_id, user_membership_id) WHERE user_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_sales_quotas_set_by_mbr ON sales_quotas (org_id, set_by_membership_id) WHERE set_by_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_commissions_user_mbr ON commissions (org_id, user_membership_id) WHERE user_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_incentive_cfg_created_mbr ON incentive_config (org_id, created_by_membership_id) WHERE created_by_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_incentives_sales_rep_mbr ON incentives (org_id, sales_rep_membership_id) WHERE sales_rep_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_incentives_appr_by_mbr ON incentives (org_id, approved_by_membership_id) WHERE approved_by_membership_id IS NOT NULL;
--> statement-breakpoint

-- ============================================================
-- SECTION 4 — BACKFILL (re-runnable: WHERE companion IS NULL)
-- All guarded on information_schema so this block is idempotent.
-- No statement-breakpoints inside the DO block.
-- ============================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='clients' AND column_name='account_manager_membership_id') THEN
    UPDATE clients SET account_manager_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = clients.org_id AND om.user_id = clients.account_manager_id AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE account_manager_membership_id IS NULL AND account_manager_id IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='client_accounts' AND column_name='sales_rep_membership_id') THEN
    UPDATE client_accounts SET sales_rep_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = client_accounts.org_id AND om.user_id = client_accounts.sales_rep_id AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE sales_rep_membership_id IS NULL AND sales_rep_id IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='client_accounts' AND column_name='assigned_crm_membership_id') THEN
    UPDATE client_accounts SET assigned_crm_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = client_accounts.org_id AND om.user_id = client_accounts.assigned_crm_id AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE assigned_crm_membership_id IS NULL AND assigned_crm_id IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='client_account_activities' AND column_name='user_membership_id') THEN
    UPDATE client_account_activities caa SET user_membership_id = (
      SELECT om.id FROM organization_members om
      JOIN client_accounts ca ON ca.id = caa.client_account_id AND ca.org_id = om.org_id
      WHERE om.user_id = caa.user_id AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE user_membership_id IS NULL AND user_id IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='client_opportunities' AND column_name='created_by_membership_id') THEN
    UPDATE client_opportunities SET created_by_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = client_opportunities.org_id AND om.user_id = client_opportunities.created_by AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE created_by_membership_id IS NULL AND created_by IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='client_onboarding_templates' AND column_name='created_by_membership_id') THEN
    UPDATE client_onboarding_templates SET created_by_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = client_onboarding_templates.org_id AND om.user_id = client_onboarding_templates.created_by AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE created_by_membership_id IS NULL AND created_by IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='client_onboarding_items' AND column_name='assigned_to_membership_id') THEN
    UPDATE client_onboarding_items SET assigned_to_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = client_onboarding_items.org_id AND om.user_id = client_onboarding_items.assigned_to AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE assigned_to_membership_id IS NULL AND assigned_to IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='client_onboarding_items' AND column_name='completed_by_membership_id') THEN
    UPDATE client_onboarding_items SET completed_by_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = client_onboarding_items.org_id AND om.user_id = client_onboarding_items.completed_by AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE completed_by_membership_id IS NULL AND completed_by IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='csat_surveys' AND column_name='created_by_membership_id') THEN
    UPDATE csat_surveys SET created_by_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = csat_surveys.org_id AND om.user_id = csat_surveys.created_by AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE created_by_membership_id IS NULL AND created_by IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='deals' AND column_name='assigned_to_membership_id') THEN
    UPDATE deals SET assigned_to_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = deals.org_id AND om.user_id = deals.assigned_to_id AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE assigned_to_membership_id IS NULL AND assigned_to_id IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='deal_activities' AND column_name='user_membership_id') THEN
    UPDATE deal_activities SET user_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = deal_activities.org_id AND om.user_id = deal_activities.user_id AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE user_membership_id IS NULL AND user_id IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='deal_meetings' AND column_name='created_by_membership_id') THEN
    UPDATE deal_meetings SET created_by_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = deal_meetings.org_id AND om.user_id = deal_meetings.created_by AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE created_by_membership_id IS NULL AND created_by IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='deal_approval_rules' AND column_name='approver_membership_id') THEN
    UPDATE deal_approval_rules SET approver_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = deal_approval_rules.org_id AND om.user_id = deal_approval_rules.approver_user_id AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE approver_membership_id IS NULL AND approver_user_id IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='deal_approvals' AND column_name='requested_by_membership_id') THEN
    UPDATE deal_approvals SET requested_by_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = deal_approvals.org_id AND om.user_id = deal_approvals.requested_by AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE requested_by_membership_id IS NULL AND requested_by IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='deal_approvals' AND column_name='approved_by_membership_id') THEN
    UPDATE deal_approvals SET approved_by_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = deal_approvals.org_id AND om.user_id = deal_approvals.approved_by AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE approved_by_membership_id IS NULL AND approved_by IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='crm_forecast_snapshots' AND column_name='created_by_membership_id') THEN
    UPDATE crm_forecast_snapshots SET created_by_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = crm_forecast_snapshots.org_id AND om.user_id = crm_forecast_snapshots.created_by_id AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE created_by_membership_id IS NULL AND created_by_id IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='crm_forecast_snapshots' AND column_name='overridden_by_membership_id') THEN
    UPDATE crm_forecast_snapshots SET overridden_by_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = crm_forecast_snapshots.org_id AND om.user_id = crm_forecast_snapshots.overridden_by AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE overridden_by_membership_id IS NULL AND overridden_by IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='leads' AND column_name='assigned_to_membership_id') THEN
    UPDATE leads SET assigned_to_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = leads.org_id AND om.user_id = leads.assigned_to_id AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE assigned_to_membership_id IS NULL AND assigned_to_id IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='leads' AND column_name='assigned_by_membership_id') THEN
    UPDATE leads SET assigned_by_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = leads.org_id AND om.user_id = leads.assigned_by_id AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE assigned_by_membership_id IS NULL AND assigned_by_id IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='leads' AND column_name='verified_by_membership_id') THEN
    UPDATE leads SET verified_by_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = leads.org_id AND om.user_id = leads.verified_by_id AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE verified_by_membership_id IS NULL AND verified_by_id IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='lead_activities' AND column_name='user_membership_id') THEN
    UPDATE lead_activities SET user_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = lead_activities.org_id AND om.user_id = lead_activities.user_id AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE user_membership_id IS NULL AND user_id IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='lead_notes' AND column_name='author_membership_id') THEN
    UPDATE lead_notes SET author_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = lead_notes.org_id AND om.user_id = lead_notes.author_id AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE author_membership_id IS NULL AND author_id IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='lead_tasks' AND column_name='assignee_membership_id') THEN
    UPDATE lead_tasks SET assignee_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = lead_tasks.org_id AND om.user_id = lead_tasks.assignee_id AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE assignee_membership_id IS NULL AND assignee_id IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='lead_assignment_rules' AND column_name='assign_to_membership_id') THEN
    UPDATE lead_assignment_rules SET assign_to_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = lead_assignment_rules.org_id AND om.user_id = lead_assignment_rules.assign_to_user_id AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE assign_to_membership_id IS NULL AND assign_to_user_id IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='lead_import_batches' AND column_name='created_by_membership_id') THEN
    UPDATE lead_import_batches SET created_by_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = lead_import_batches.org_id AND om.user_id = lead_import_batches.created_by AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE created_by_membership_id IS NULL AND created_by IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='web_lead_forms' AND column_name='created_by_membership_id') THEN
    UPDATE web_lead_forms SET created_by_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = web_lead_forms.org_id AND om.user_id = web_lead_forms.created_by AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE created_by_membership_id IS NULL AND created_by IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='crm_email_templates' AND column_name='created_by_membership_id') THEN
    UPDATE crm_email_templates SET created_by_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = crm_email_templates.org_id AND om.user_id = crm_email_templates.created_by AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE created_by_membership_id IS NULL AND created_by IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='crm_campaigns' AND column_name='owner_membership_id') THEN
    UPDATE crm_campaigns SET owner_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = crm_campaigns.org_id AND om.user_id = crm_campaigns.owner_id AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE owner_membership_id IS NULL AND owner_id IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='crm_contact_channel_consent' AND column_name='recorded_by_membership_id') THEN
    UPDATE crm_contact_channel_consent SET recorded_by_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = crm_contact_channel_consent.org_id AND om.user_id = crm_contact_channel_consent.recorded_by_user_id AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE recorded_by_membership_id IS NULL AND recorded_by_user_id IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='crm_contact_consent_events' AND column_name='recorded_by_membership_id') THEN
    UPDATE crm_contact_consent_events SET recorded_by_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = crm_contact_consent_events.org_id AND om.user_id = crm_contact_consent_events.recorded_by_user_id AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE recorded_by_membership_id IS NULL AND recorded_by_user_id IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='health_score_config' AND column_name='updated_by_membership_id') THEN
    UPDATE health_score_config SET updated_by_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = health_score_config.org_id AND om.user_id = health_score_config.updated_by AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE updated_by_membership_id IS NULL AND updated_by IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='territories' AND column_name='created_by_membership_id') THEN
    UPDATE territories SET created_by_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = territories.org_id AND om.user_id = territories.created_by AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE created_by_membership_id IS NULL AND created_by IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='invoices' AND column_name='created_by_membership_id') THEN
    UPDATE invoices SET created_by_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = invoices.org_id AND om.user_id = invoices.created_by AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE created_by_membership_id IS NULL AND created_by IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='invoices' AND column_name='collection_owner_membership_id') THEN
    UPDATE invoices SET collection_owner_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = invoices.org_id AND om.user_id = invoices.collection_owner_id AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE collection_owner_membership_id IS NULL AND collection_owner_id IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='payments' AND column_name='created_by_membership_id') THEN
    UPDATE payments SET created_by_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = payments.org_id AND om.user_id = payments.created_by AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE created_by_membership_id IS NULL AND created_by IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='purchase_bills' AND column_name='created_by_membership_id') THEN
    UPDATE purchase_bills SET created_by_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = purchase_bills.org_id AND om.user_id = purchase_bills.created_by AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE created_by_membership_id IS NULL AND created_by IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='purchase_bills' AND column_name='approved_by_membership_id') THEN
    UPDATE purchase_bills SET approved_by_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = purchase_bills.org_id AND om.user_id = purchase_bills.approved_by AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE approved_by_membership_id IS NULL AND approved_by IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='vendor_payments' AND column_name='created_by_membership_id') THEN
    UPDATE vendor_payments SET created_by_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = vendor_payments.org_id AND om.user_id = vendor_payments.created_by AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE created_by_membership_id IS NULL AND created_by IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='quotes' AND column_name='created_by_membership_id') THEN
    UPDATE quotes SET created_by_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = quotes.org_id AND om.user_id = quotes.created_by_id AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE created_by_membership_id IS NULL AND created_by_id IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='quotes' AND column_name='approved_by_membership_id') THEN
    UPDATE quotes SET approved_by_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = quotes.org_id AND om.user_id = quotes.approved_by_id AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE approved_by_membership_id IS NULL AND approved_by_id IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='nps_surveys' AND column_name='created_by_membership_id') THEN
    UPDATE nps_surveys SET created_by_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = nps_surveys.org_id AND om.user_id = nps_surveys.created_by AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE created_by_membership_id IS NULL AND created_by IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='playbook_entries' AND column_name='created_by_membership_id') THEN
    UPDATE playbook_entries SET created_by_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = playbook_entries.org_id AND om.user_id = playbook_entries.created_by AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE created_by_membership_id IS NULL AND created_by IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tasks' AND column_name='assignee_membership_id') THEN
    UPDATE tasks SET assignee_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = tasks.org_id AND om.user_id = tasks.assignee_id AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE assignee_membership_id IS NULL AND assignee_id IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tasks' AND column_name='created_by_membership_id') THEN
    UPDATE tasks SET created_by_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = tasks.org_id AND om.user_id = tasks.created_by AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE created_by_membership_id IS NULL AND created_by IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='task_sequences' AND column_name='created_by_membership_id') THEN
    UPDATE task_sequences SET created_by_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = task_sequences.org_id AND om.user_id = task_sequences.created_by AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE created_by_membership_id IS NULL AND created_by IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='sales_quotas' AND column_name='user_membership_id') THEN
    UPDATE sales_quotas SET user_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = sales_quotas.org_id AND om.user_id = sales_quotas.user_id AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE user_membership_id IS NULL AND user_id IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='sales_quotas' AND column_name='set_by_membership_id') THEN
    UPDATE sales_quotas SET set_by_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = sales_quotas.org_id AND om.user_id = sales_quotas.set_by_id AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE set_by_membership_id IS NULL AND set_by_id IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='commissions' AND column_name='user_membership_id') THEN
    UPDATE commissions SET user_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = commissions.org_id AND om.user_id = commissions.user_id AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE user_membership_id IS NULL AND user_id IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='incentive_config' AND column_name='created_by_membership_id') THEN
    UPDATE incentive_config SET created_by_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = incentive_config.org_id AND om.user_id = incentive_config.created_by AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE created_by_membership_id IS NULL AND created_by IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='incentives' AND column_name='sales_rep_membership_id') THEN
    UPDATE incentives SET sales_rep_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = incentives.org_id AND om.user_id = incentives.sales_rep_id AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE sales_rep_membership_id IS NULL AND sales_rep_id IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='incentives' AND column_name='approved_by_membership_id') THEN
    UPDATE incentives SET approved_by_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = incentives.org_id AND om.user_id = incentives.approved_by AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE approved_by_membership_id IS NULL AND approved_by IS NOT NULL;
  END IF;
END $$;
--> statement-breakpoint

-- ============================================================
-- SECTION 5 — VALIDATE CONSTRAINTS
-- ============================================================

ALTER TABLE clients VALIDATE CONSTRAINT fk_clients_acct_mgr_mbr;
--> statement-breakpoint
ALTER TABLE client_accounts VALIDATE CONSTRAINT fk_client_accts_sales_rep_mbr;
--> statement-breakpoint
ALTER TABLE client_accounts VALIDATE CONSTRAINT fk_client_accts_assigned_crm_mbr;
--> statement-breakpoint
ALTER TABLE client_account_activities VALIDATE CONSTRAINT fk_caa_user_mbr;
--> statement-breakpoint
ALTER TABLE client_opportunities VALIDATE CONSTRAINT fk_client_opps_created_by_mbr;
--> statement-breakpoint
ALTER TABLE client_onboarding_templates VALIDATE CONSTRAINT fk_cob_tmpls_created_by_mbr;
--> statement-breakpoint
ALTER TABLE client_onboarding_items VALIDATE CONSTRAINT fk_cob_items_assigned_to_mbr;
--> statement-breakpoint
ALTER TABLE client_onboarding_items VALIDATE CONSTRAINT fk_cob_items_completed_by_mbr;
--> statement-breakpoint
ALTER TABLE csat_surveys VALIDATE CONSTRAINT fk_csat_surveys_created_by_mbr;
--> statement-breakpoint
ALTER TABLE deals VALIDATE CONSTRAINT fk_deals_assigned_to_mbr;
--> statement-breakpoint
ALTER TABLE deal_activities VALIDATE CONSTRAINT fk_deal_activities_user_mbr;
--> statement-breakpoint
ALTER TABLE deal_meetings VALIDATE CONSTRAINT fk_deal_meetings_created_by_mbr;
--> statement-breakpoint
ALTER TABLE deal_approval_rules VALIDATE CONSTRAINT fk_deal_appr_rules_approver_mbr;
--> statement-breakpoint
ALTER TABLE deal_approvals VALIDATE CONSTRAINT fk_deal_approvals_req_by_mbr;
--> statement-breakpoint
ALTER TABLE deal_approvals VALIDATE CONSTRAINT fk_deal_approvals_appr_by_mbr;
--> statement-breakpoint
ALTER TABLE crm_forecast_snapshots VALIDATE CONSTRAINT fk_crm_fcast_snap_created_by_mbr;
--> statement-breakpoint
ALTER TABLE crm_forecast_snapshots VALIDATE CONSTRAINT fk_crm_fcast_snap_overr_by_mbr;
--> statement-breakpoint
ALTER TABLE leads VALIDATE CONSTRAINT fk_leads_assigned_to_mbr;
--> statement-breakpoint
ALTER TABLE leads VALIDATE CONSTRAINT fk_leads_assigned_by_mbr;
--> statement-breakpoint
ALTER TABLE leads VALIDATE CONSTRAINT fk_leads_verified_by_mbr;
--> statement-breakpoint
ALTER TABLE lead_activities VALIDATE CONSTRAINT fk_lead_activities_user_mbr;
--> statement-breakpoint
ALTER TABLE lead_notes VALIDATE CONSTRAINT fk_lead_notes_author_mbr;
--> statement-breakpoint
ALTER TABLE lead_tasks VALIDATE CONSTRAINT fk_lead_tasks_assignee_mbr;
--> statement-breakpoint
ALTER TABLE lead_assignment_rules VALIDATE CONSTRAINT fk_lead_assign_rules_assign_mbr;
--> statement-breakpoint
ALTER TABLE lead_import_batches VALIDATE CONSTRAINT fk_lead_import_batches_cre_mbr;
--> statement-breakpoint
ALTER TABLE web_lead_forms VALIDATE CONSTRAINT fk_web_lead_forms_created_mbr;
--> statement-breakpoint
ALTER TABLE crm_email_templates VALIDATE CONSTRAINT fk_crm_email_tmpls_cre_mbr;
--> statement-breakpoint
ALTER TABLE crm_campaigns VALIDATE CONSTRAINT fk_crm_campaigns_owner_mbr;
--> statement-breakpoint
ALTER TABLE crm_contact_channel_consent VALIDATE CONSTRAINT fk_crm_chan_consent_rec_by_mbr;
--> statement-breakpoint
ALTER TABLE crm_contact_consent_events VALIDATE CONSTRAINT fk_crm_consent_events_rec_mbr;
--> statement-breakpoint
ALTER TABLE health_score_config VALIDATE CONSTRAINT fk_health_score_cfg_upd_mbr;
--> statement-breakpoint
ALTER TABLE territories VALIDATE CONSTRAINT fk_territories_created_by_mbr;
--> statement-breakpoint
ALTER TABLE invoices VALIDATE CONSTRAINT fk_invoices_created_by_mbr;
--> statement-breakpoint
ALTER TABLE invoices VALIDATE CONSTRAINT fk_invoices_coll_owner_mbr;
--> statement-breakpoint
ALTER TABLE payments VALIDATE CONSTRAINT fk_payments_created_by_mbr;
--> statement-breakpoint
ALTER TABLE purchase_bills VALIDATE CONSTRAINT fk_purchase_bills_created_mbr;
--> statement-breakpoint
ALTER TABLE purchase_bills VALIDATE CONSTRAINT fk_purchase_bills_appr_by_mbr;
--> statement-breakpoint
ALTER TABLE vendor_payments VALIDATE CONSTRAINT fk_vendor_payments_cre_mbr;
--> statement-breakpoint
ALTER TABLE quotes VALIDATE CONSTRAINT fk_quotes_created_by_mbr;
--> statement-breakpoint
ALTER TABLE quotes VALIDATE CONSTRAINT fk_quotes_appr_by_mbr;
--> statement-breakpoint
ALTER TABLE nps_surveys VALIDATE CONSTRAINT fk_nps_surveys_created_by_mbr;
--> statement-breakpoint
ALTER TABLE playbook_entries VALIDATE CONSTRAINT fk_playbook_entries_cre_mbr;
--> statement-breakpoint
ALTER TABLE tasks VALIDATE CONSTRAINT fk_tasks_assignee_mbr;
--> statement-breakpoint
ALTER TABLE tasks VALIDATE CONSTRAINT fk_tasks_created_by_mbr;
--> statement-breakpoint
ALTER TABLE task_sequences VALIDATE CONSTRAINT fk_task_sequences_created_mbr;
--> statement-breakpoint
ALTER TABLE sales_quotas VALIDATE CONSTRAINT fk_sales_quotas_user_mbr;
--> statement-breakpoint
ALTER TABLE sales_quotas VALIDATE CONSTRAINT fk_sales_quotas_set_by_mbr;
--> statement-breakpoint
ALTER TABLE commissions VALIDATE CONSTRAINT fk_commissions_user_mbr;
--> statement-breakpoint
ALTER TABLE incentive_config VALIDATE CONSTRAINT fk_incentive_cfg_created_mbr;
--> statement-breakpoint
ALTER TABLE incentives VALIDATE CONSTRAINT fk_incentives_sales_rep_mbr;
--> statement-breakpoint
ALTER TABLE incentives VALIDATE CONSTRAINT fk_incentives_appr_by_mbr;
--> statement-breakpoint

-- ============================================================
-- SECTION 6 — INTEGRITY CHECK
-- Verifies that every composite FK uses a single-column SET NULL
-- list so it cannot accidentally null org_id (23502).
-- ============================================================

DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(c.conname, ', ') INTO bad
  FROM pg_constraint c
  WHERE c.conname IN (
    'fk_clients_acct_mgr_mbr',
    'fk_client_accts_sales_rep_mbr',
    'fk_client_accts_assigned_crm_mbr',
    'fk_caa_user_mbr',
    'fk_client_opps_created_by_mbr',
    'fk_cob_tmpls_created_by_mbr',
    'fk_cob_items_assigned_to_mbr',
    'fk_cob_items_completed_by_mbr',
    'fk_csat_surveys_created_by_mbr',
    'fk_deals_assigned_to_mbr',
    'fk_deal_activities_user_mbr',
    'fk_deal_meetings_created_by_mbr',
    'fk_deal_appr_rules_approver_mbr',
    'fk_deal_approvals_req_by_mbr',
    'fk_deal_approvals_appr_by_mbr',
    'fk_crm_fcast_snap_created_by_mbr',
    'fk_crm_fcast_snap_overr_by_mbr',
    'fk_leads_assigned_to_mbr',
    'fk_leads_assigned_by_mbr',
    'fk_leads_verified_by_mbr',
    'fk_lead_activities_user_mbr',
    'fk_lead_notes_author_mbr',
    'fk_lead_tasks_assignee_mbr',
    'fk_lead_assign_rules_assign_mbr',
    'fk_lead_import_batches_cre_mbr',
    'fk_web_lead_forms_created_mbr',
    'fk_crm_email_tmpls_cre_mbr',
    'fk_crm_campaigns_owner_mbr',
    'fk_crm_chan_consent_rec_by_mbr',
    'fk_crm_consent_events_rec_mbr',
    'fk_health_score_cfg_upd_mbr',
    'fk_territories_created_by_mbr',
    'fk_invoices_created_by_mbr',
    'fk_invoices_coll_owner_mbr',
    'fk_payments_created_by_mbr',
    'fk_purchase_bills_created_mbr',
    'fk_purchase_bills_appr_by_mbr',
    'fk_vendor_payments_cre_mbr',
    'fk_quotes_created_by_mbr',
    'fk_quotes_appr_by_mbr',
    'fk_nps_surveys_created_by_mbr',
    'fk_playbook_entries_cre_mbr',
    'fk_tasks_assignee_mbr',
    'fk_tasks_created_by_mbr',
    'fk_task_sequences_created_mbr',
    'fk_sales_quotas_user_mbr',
    'fk_sales_quotas_set_by_mbr',
    'fk_commissions_user_mbr',
    'fk_incentive_cfg_created_mbr',
    'fk_incentives_sales_rep_mbr',
    'fk_incentives_appr_by_mbr'
  )
  AND c.contype = 'f'
  AND c.confdeltype = 'n'
  AND (c.confdelsetcols IS NULL OR cardinality(c.confdelsetcols) <> 1);

  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '0817: composite ON DELETE SET NULL without a single-column list would null org_id (23502): %', bad;
  END IF;
END $$;
