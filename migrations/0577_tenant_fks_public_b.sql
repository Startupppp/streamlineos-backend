-- Composite tenant FKs, public schema, part 2 of 3.
--
-- Split by size, not by meaning: the purpose is identical across all four. §3 warns a ~2000-op monolith ECONNRESETs on Neon, and 635 constraints is ~1266 statements.
--
-- backend/CLAUDE.md §3: every tenant edge carries a composite tenant FK, and
-- "applied to the Neon branch" is not migrated. 635 of the 799 composite
-- same-tenant foreign keys on this database were applied by hand and exist in
-- no migration file, so a database rebuilt from migrations/ has no cross-tenant
-- referential integrity at all -- nothing stops a row referencing another
-- organisation's parent. This file authors 171 of them.
--
-- Every constraint is added NOT VALID and validated in a separate statement:
-- one-step ADD CONSTRAINT ... FOREIGN KEY takes ACCESS EXCLUSIVE on BOTH tables
-- while it installs triggers, which on a populated database stalls every write
-- to both behind any long read.
--
-- Both halves are guarded on pg_constraint, because all of these already exist
-- on the database this was written against: the file must be a no-op there
-- while being the creating statement on a fresh build.
--
-- Every probe and every ALTER is SCHEMA-QUALIFIED, deliberately. to_regclass
-- returns NULL rather than throwing for a table in another schema, so an
-- unqualified 'public.x' probe against a build-schema table concludes "table
-- absent, skip" -- no error, no DDL, no trace. A guard whose failure mode is
-- silence is worse than no guard, because it reads as care.
--
-- statement_timeout is cleared: these are heavy catalog DO-blocks and Neon
-- cancels them on a cold build otherwise (§3, cold-DB rule 2).
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = '5s';
--> statement-breakpoint

DO $$ BEGIN
  IF to_regclass('public.fin_payment_run_items') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_payment_run_items_run_id_org'
                     AND conrelid = to_regclass('public.fin_payment_run_items')) THEN
    ALTER TABLE "public"."fin_payment_run_items" ADD CONSTRAINT "fk_fin_payment_run_items_run_id_org" FOREIGN KEY (org_id, run_id) REFERENCES fin_payment_runs(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_payment_run_items_run_id_org'
             AND conrelid = to_regclass('public.fin_payment_run_items') AND NOT convalidated) THEN
    ALTER TABLE "public"."fin_payment_run_items" VALIDATE CONSTRAINT "fk_fin_payment_run_items_run_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.fin_payment_run_items') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_payment_run_items_vendor_id_org'
                     AND conrelid = to_regclass('public.fin_payment_run_items')) THEN
    ALTER TABLE "public"."fin_payment_run_items" ADD CONSTRAINT "fk_fin_payment_run_items_vendor_id_org" FOREIGN KEY (org_id, vendor_id) REFERENCES clients(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_payment_run_items_vendor_id_org'
             AND conrelid = to_regclass('public.fin_payment_run_items') AND NOT convalidated) THEN
    ALTER TABLE "public"."fin_payment_run_items" VALIDATE CONSTRAINT "fk_fin_payment_run_items_vendor_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.fin_payment_run_items') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_payment_run_items_vendor_payment_id_org'
                     AND conrelid = to_regclass('public.fin_payment_run_items')) THEN
    ALTER TABLE "public"."fin_payment_run_items" ADD CONSTRAINT "fk_fin_payment_run_items_vendor_payment_id_org" FOREIGN KEY (org_id, vendor_payment_id) REFERENCES vendor_payments(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_payment_run_items_vendor_payment_id_org'
             AND conrelid = to_regclass('public.fin_payment_run_items') AND NOT convalidated) THEN
    ALTER TABLE "public"."fin_payment_run_items" VALIDATE CONSTRAINT "fk_fin_payment_run_items_vendor_payment_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.fin_reconciliation_matches') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_reconciliation_matches_bank_transaction_id_org'
                     AND conrelid = to_regclass('public.fin_reconciliation_matches')) THEN
    ALTER TABLE "public"."fin_reconciliation_matches" ADD CONSTRAINT "fk_fin_reconciliation_matches_bank_transaction_id_org" FOREIGN KEY (org_id, bank_transaction_id) REFERENCES fin_bank_transactions(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_reconciliation_matches_bank_transaction_id_org'
             AND conrelid = to_regclass('public.fin_reconciliation_matches') AND NOT convalidated) THEN
    ALTER TABLE "public"."fin_reconciliation_matches" VALIDATE CONSTRAINT "fk_fin_reconciliation_matches_bank_transaction_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.fin_reconciliation_matches') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_reconciliation_matches_journal_entry_id_org'
                     AND conrelid = to_regclass('public.fin_reconciliation_matches')) THEN
    ALTER TABLE "public"."fin_reconciliation_matches" ADD CONSTRAINT "fk_fin_reconciliation_matches_journal_entry_id_org" FOREIGN KEY (org_id, journal_entry_id) REFERENCES journal_entries(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_reconciliation_matches_journal_entry_id_org'
             AND conrelid = to_regclass('public.fin_reconciliation_matches') AND NOT convalidated) THEN
    ALTER TABLE "public"."fin_reconciliation_matches" VALIDATE CONSTRAINT "fk_fin_reconciliation_matches_journal_entry_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.fin_recurring_bill_templates') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_recurring_bill_templates_vendor_id_org'
                     AND conrelid = to_regclass('public.fin_recurring_bill_templates')) THEN
    ALTER TABLE "public"."fin_recurring_bill_templates" ADD CONSTRAINT "fk_fin_recurring_bill_templates_vendor_id_org" FOREIGN KEY (org_id, vendor_id) REFERENCES clients(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_recurring_bill_templates_vendor_id_org'
             AND conrelid = to_regclass('public.fin_recurring_bill_templates') AND NOT convalidated) THEN
    ALTER TABLE "public"."fin_recurring_bill_templates" VALIDATE CONSTRAINT "fk_fin_recurring_bill_templates_vendor_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.fin_recurring_invoice_templates') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_recurring_invoice_templates_client_id_org'
                     AND conrelid = to_regclass('public.fin_recurring_invoice_templates')) THEN
    ALTER TABLE "public"."fin_recurring_invoice_templates" ADD CONSTRAINT "fk_fin_recurring_invoice_templates_client_id_org" FOREIGN KEY (org_id, client_id) REFERENCES clients(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_recurring_invoice_templates_client_id_org'
             AND conrelid = to_regclass('public.fin_recurring_invoice_templates') AND NOT convalidated) THEN
    ALTER TABLE "public"."fin_recurring_invoice_templates" VALIDATE CONSTRAINT "fk_fin_recurring_invoice_templates_client_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.fin_reimbursement_batches') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_reimbursement_batches_bank_account_id_org'
                     AND conrelid = to_regclass('public.fin_reimbursement_batches')) THEN
    ALTER TABLE "public"."fin_reimbursement_batches" ADD CONSTRAINT "fk_fin_reimbursement_batches_bank_account_id_org" FOREIGN KEY (org_id, bank_account_id) REFERENCES fin_bank_accounts(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_reimbursement_batches_bank_account_id_org'
             AND conrelid = to_regclass('public.fin_reimbursement_batches') AND NOT convalidated) THEN
    ALTER TABLE "public"."fin_reimbursement_batches" VALIDATE CONSTRAINT "fk_fin_reimbursement_batches_bank_account_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.fin_reimbursement_batches') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_reimbursement_batches_journal_entry_id_org'
                     AND conrelid = to_regclass('public.fin_reimbursement_batches')) THEN
    ALTER TABLE "public"."fin_reimbursement_batches" ADD CONSTRAINT "fk_fin_reimbursement_batches_journal_entry_id_org" FOREIGN KEY (org_id, journal_entry_id) REFERENCES journal_entries(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_reimbursement_batches_journal_entry_id_org'
             AND conrelid = to_regclass('public.fin_reimbursement_batches') AND NOT convalidated) THEN
    ALTER TABLE "public"."fin_reimbursement_batches" VALIDATE CONSTRAINT "fk_fin_reimbursement_batches_journal_entry_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.fin_reminder_log') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_reminder_log_invoice_id_org'
                     AND conrelid = to_regclass('public.fin_reminder_log')) THEN
    ALTER TABLE "public"."fin_reminder_log" ADD CONSTRAINT "fk_fin_reminder_log_invoice_id_org" FOREIGN KEY (org_id, invoice_id) REFERENCES invoices(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_reminder_log_invoice_id_org'
             AND conrelid = to_regclass('public.fin_reminder_log') AND NOT convalidated) THEN
    ALTER TABLE "public"."fin_reminder_log" VALIDATE CONSTRAINT "fk_fin_reminder_log_invoice_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.fin_vendor_payment_allocations') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_vendor_payment_allocations_bill_id_org'
                     AND conrelid = to_regclass('public.fin_vendor_payment_allocations')) THEN
    ALTER TABLE "public"."fin_vendor_payment_allocations" ADD CONSTRAINT "fk_fin_vendor_payment_allocations_bill_id_org" FOREIGN KEY (org_id, bill_id) REFERENCES purchase_bills(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_vendor_payment_allocations_bill_id_org'
             AND conrelid = to_regclass('public.fin_vendor_payment_allocations') AND NOT convalidated) THEN
    ALTER TABLE "public"."fin_vendor_payment_allocations" VALIDATE CONSTRAINT "fk_fin_vendor_payment_allocations_bill_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.fin_vendor_payment_allocations') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_vendor_payment_allocations_vendor_payment_id_org'
                     AND conrelid = to_regclass('public.fin_vendor_payment_allocations')) THEN
    ALTER TABLE "public"."fin_vendor_payment_allocations" ADD CONSTRAINT "fk_fin_vendor_payment_allocations_vendor_payment_id_org" FOREIGN KEY (org_id, vendor_payment_id) REFERENCES vendor_payments(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fin_vendor_payment_allocations_vendor_payment_id_org'
             AND conrelid = to_regclass('public.fin_vendor_payment_allocations') AND NOT convalidated) THEN
    ALTER TABLE "public"."fin_vendor_payment_allocations" VALIDATE CONSTRAINT "fk_fin_vendor_payment_allocations_vendor_payment_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.fnf_settlements') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fnf_settlements_resignation_id_org'
                     AND conrelid = to_regclass('public.fnf_settlements')) THEN
    ALTER TABLE "public"."fnf_settlements" ADD CONSTRAINT "fk_fnf_settlements_resignation_id_org" FOREIGN KEY (org_id, resignation_id) REFERENCES resignations(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fnf_settlements_resignation_id_org'
             AND conrelid = to_regclass('public.fnf_settlements') AND NOT convalidated) THEN
    ALTER TABLE "public"."fnf_settlements" VALIDATE CONSTRAINT "fk_fnf_settlements_resignation_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.goals') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_goals_parent_goal_id_org'
                     AND conrelid = to_regclass('public.goals')) THEN
    ALTER TABLE "public"."goals" ADD CONSTRAINT "fk_goals_parent_goal_id_org" FOREIGN KEY (org_id, parent_goal_id) REFERENCES goals(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_goals_parent_goal_id_org'
             AND conrelid = to_regclass('public.goals') AND NOT convalidated) THEN
    ALTER TABLE "public"."goals" VALIDATE CONSTRAINT "fk_goals_parent_goal_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.handbook_versions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_handbook_versions_document_id_org'
                     AND conrelid = to_regclass('public.handbook_versions')) THEN
    ALTER TABLE "public"."handbook_versions" ADD CONSTRAINT "fk_handbook_versions_document_id_org" FOREIGN KEY (org_id, document_id) REFERENCES rich_documents(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_handbook_versions_document_id_org'
             AND conrelid = to_regclass('public.handbook_versions') AND NOT convalidated) THEN
    ALTER TABLE "public"."handbook_versions" VALIDATE CONSTRAINT "fk_handbook_versions_document_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.headcount_requests') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_headcount_requests_linked_job_posting_id_org'
                     AND conrelid = to_regclass('public.headcount_requests')) THEN
    ALTER TABLE "public"."headcount_requests" ADD CONSTRAINT "fk_headcount_requests_linked_job_posting_id_org" FOREIGN KEY (org_id, linked_job_posting_id) REFERENCES job_postings(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_headcount_requests_linked_job_posting_id_org'
             AND conrelid = to_regclass('public.headcount_requests') AND NOT convalidated) THEN
    ALTER TABLE "public"."headcount_requests" VALIDATE CONSTRAINT "fk_headcount_requests_linked_job_posting_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.helpdesk_tickets') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_helpdesk_tickets_assignee_actor'
                     AND conrelid = to_regclass('public.helpdesk_tickets')) THEN
    ALTER TABLE "public"."helpdesk_tickets" ADD CONSTRAINT "fk_helpdesk_tickets_assignee_actor" FOREIGN KEY (org_id, assignee_membership_id) REFERENCES organization_members(org_id, id) ON DELETE RESTRICT NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_helpdesk_tickets_assignee_actor'
             AND conrelid = to_regclass('public.helpdesk_tickets') AND NOT convalidated) THEN
    ALTER TABLE "public"."helpdesk_tickets" VALIDATE CONSTRAINT "fk_helpdesk_tickets_assignee_actor";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hiring_flow_rounds') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hiring_flow_rounds_flow_id_org'
                     AND conrelid = to_regclass('public.hiring_flow_rounds')) THEN
    ALTER TABLE "public"."hiring_flow_rounds" ADD CONSTRAINT "fk_hiring_flow_rounds_flow_id_org" FOREIGN KEY (org_id, flow_id) REFERENCES hiring_flows(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hiring_flow_rounds_flow_id_org'
             AND conrelid = to_regclass('public.hiring_flow_rounds') AND NOT convalidated) THEN
    ALTER TABLE "public"."hiring_flow_rounds" VALIDATE CONSTRAINT "fk_hiring_flow_rounds_flow_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hiring_flow_rounds') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hiring_flow_rounds_scorecard_template_id_org'
                     AND conrelid = to_regclass('public.hiring_flow_rounds')) THEN
    ALTER TABLE "public"."hiring_flow_rounds" ADD CONSTRAINT "fk_hiring_flow_rounds_scorecard_template_id_org" FOREIGN KEY (org_id, scorecard_template_id) REFERENCES scorecard_templates(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hiring_flow_rounds_scorecard_template_id_org'
             AND conrelid = to_regclass('public.hiring_flow_rounds') AND NOT convalidated) THEN
    ALTER TABLE "public"."hiring_flow_rounds" VALIDATE CONSTRAINT "fk_hiring_flow_rounds_scorecard_template_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_accommodation_tasks') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_accommodation_tasks_request_id_org'
                     AND conrelid = to_regclass('public.hr_accommodation_tasks')) THEN
    ALTER TABLE "public"."hr_accommodation_tasks" ADD CONSTRAINT "fk_hr_accommodation_tasks_request_id_org" FOREIGN KEY (org_id, request_id) REFERENCES hr_accommodation_requests(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_accommodation_tasks_request_id_org'
             AND conrelid = to_regclass('public.hr_accommodation_tasks') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_accommodation_tasks" VALIDATE CONSTRAINT "fk_hr_accommodation_tasks_request_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_automation_runs') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_automation_runs_rule_id_org'
                     AND conrelid = to_regclass('public.hr_automation_runs')) THEN
    ALTER TABLE "public"."hr_automation_runs" ADD CONSTRAINT "fk_hr_automation_runs_rule_id_org" FOREIGN KEY (org_id, rule_id) REFERENCES hr_automation_rules(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_automation_runs_rule_id_org'
             AND conrelid = to_regclass('public.hr_automation_runs') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_automation_runs" VALIDATE CONSTRAINT "fk_hr_automation_runs_rule_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_badge_awards') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_badge_awards_badge_id_org'
                     AND conrelid = to_regclass('public.hr_badge_awards')) THEN
    ALTER TABLE "public"."hr_badge_awards" ADD CONSTRAINT "fk_hr_badge_awards_badge_id_org" FOREIGN KEY (org_id, badge_id) REFERENCES hr_badges(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_badge_awards_badge_id_org'
             AND conrelid = to_regclass('public.hr_badge_awards') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_badge_awards" VALIDATE CONSTRAINT "fk_hr_badge_awards_badge_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_benefit_enrollment_windows') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_benefit_enrollment_windows_plan_id_org'
                     AND conrelid = to_regclass('public.hr_benefit_enrollment_windows')) THEN
    ALTER TABLE "public"."hr_benefit_enrollment_windows" ADD CONSTRAINT "fk_hr_benefit_enrollment_windows_plan_id_org" FOREIGN KEY (org_id, plan_id) REFERENCES hr_benefit_plans(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_benefit_enrollment_windows_plan_id_org'
             AND conrelid = to_regclass('public.hr_benefit_enrollment_windows') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_benefit_enrollment_windows" VALIDATE CONSTRAINT "fk_hr_benefit_enrollment_windows_plan_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_benefit_enrollments') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_benefit_enrollments_plan_id_org'
                     AND conrelid = to_regclass('public.hr_benefit_enrollments')) THEN
    ALTER TABLE "public"."hr_benefit_enrollments" ADD CONSTRAINT "fk_hr_benefit_enrollments_plan_id_org" FOREIGN KEY (org_id, plan_id) REFERENCES hr_benefit_plans(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_benefit_enrollments_plan_id_org'
             AND conrelid = to_regclass('public.hr_benefit_enrollments') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_benefit_enrollments" VALIDATE CONSTRAINT "fk_hr_benefit_enrollments_plan_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_calibration_entries') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_calibration_entries_cycle_id_org'
                     AND conrelid = to_regclass('public.hr_calibration_entries')) THEN
    ALTER TABLE "public"."hr_calibration_entries" ADD CONSTRAINT "fk_hr_calibration_entries_cycle_id_org" FOREIGN KEY (org_id, cycle_id) REFERENCES review_cycles(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_calibration_entries_cycle_id_org'
             AND conrelid = to_regclass('public.hr_calibration_entries') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_calibration_entries" VALIDATE CONSTRAINT "fk_hr_calibration_entries_cycle_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_case_documents') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_case_documents_case_id_org'
                     AND conrelid = to_regclass('public.hr_case_documents')) THEN
    ALTER TABLE "public"."hr_case_documents" ADD CONSTRAINT "fk_hr_case_documents_case_id_org" FOREIGN KEY (org_id, case_id) REFERENCES hr_cases(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_case_documents_case_id_org'
             AND conrelid = to_regclass('public.hr_case_documents') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_case_documents" VALIDATE CONSTRAINT "fk_hr_case_documents_case_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_case_notes') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_case_notes_case_id_org'
                     AND conrelid = to_regclass('public.hr_case_notes')) THEN
    ALTER TABLE "public"."hr_case_notes" ADD CONSTRAINT "fk_hr_case_notes_case_id_org" FOREIGN KEY (org_id, case_id) REFERENCES hr_cases(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_case_notes_case_id_org'
             AND conrelid = to_regclass('public.hr_case_notes') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_case_notes" VALIDATE CONSTRAINT "fk_hr_case_notes_case_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_community_members') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_community_members_community_id_org'
                     AND conrelid = to_regclass('public.hr_community_members')) THEN
    ALTER TABLE "public"."hr_community_members" ADD CONSTRAINT "fk_hr_community_members_community_id_org" FOREIGN KEY (org_id, community_id) REFERENCES hr_communities(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_community_members_community_id_org'
             AND conrelid = to_regclass('public.hr_community_members') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_community_members" VALIDATE CONSTRAINT "fk_hr_community_members_community_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_comp_budget_pools') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_comp_budget_pools_cycle_id_org'
                     AND conrelid = to_regclass('public.hr_comp_budget_pools')) THEN
    ALTER TABLE "public"."hr_comp_budget_pools" ADD CONSTRAINT "fk_hr_comp_budget_pools_cycle_id_org" FOREIGN KEY (org_id, cycle_id) REFERENCES hr_comp_cycles(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_comp_budget_pools_cycle_id_org'
             AND conrelid = to_regclass('public.hr_comp_budget_pools') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_comp_budget_pools" VALIDATE CONSTRAINT "fk_hr_comp_budget_pools_cycle_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_comp_recommendations') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_comp_recommendations_cycle_id_org'
                     AND conrelid = to_regclass('public.hr_comp_recommendations')) THEN
    ALTER TABLE "public"."hr_comp_recommendations" ADD CONSTRAINT "fk_hr_comp_recommendations_cycle_id_org" FOREIGN KEY (org_id, cycle_id) REFERENCES hr_comp_cycles(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_comp_recommendations_cycle_id_org'
             AND conrelid = to_regclass('public.hr_comp_recommendations') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_comp_recommendations" VALIDATE CONSTRAINT "fk_hr_comp_recommendations_cycle_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_compliance_events') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_compliance_events_requirement_id_org'
                     AND conrelid = to_regclass('public.hr_compliance_events')) THEN
    ALTER TABLE "public"."hr_compliance_events" ADD CONSTRAINT "fk_hr_compliance_events_requirement_id_org" FOREIGN KEY (org_id, requirement_id) REFERENCES hr_compliance_requirements(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_compliance_events_requirement_id_org'
             AND conrelid = to_regclass('public.hr_compliance_events') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_compliance_events" VALIDATE CONSTRAINT "fk_hr_compliance_events_requirement_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_contracts') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_contracts_employment_id_org'
                     AND conrelid = to_regclass('public.hr_contracts')) THEN
    ALTER TABLE "public"."hr_contracts" ADD CONSTRAINT "fk_hr_contracts_employment_id_org" FOREIGN KEY (org_id, employment_id) REFERENCES hr_employments(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_contracts_employment_id_org'
             AND conrelid = to_regclass('public.hr_contracts') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_contracts" VALIDATE CONSTRAINT "fk_hr_contracts_employment_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_device_employee_mappings') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_device_employee_mappings_device_id_org'
                     AND conrelid = to_regclass('public.hr_device_employee_mappings')) THEN
    ALTER TABLE "public"."hr_device_employee_mappings" ADD CONSTRAINT "fk_hr_device_employee_mappings_device_id_org" FOREIGN KEY (org_id, device_id) REFERENCES hr_time_devices(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_device_employee_mappings_device_id_org'
             AND conrelid = to_regclass('public.hr_device_employee_mappings') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_device_employee_mappings" VALIDATE CONSTRAINT "fk_hr_device_employee_mappings_device_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_device_sync_logs') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_device_sync_logs_device_id_org'
                     AND conrelid = to_regclass('public.hr_device_sync_logs')) THEN
    ALTER TABLE "public"."hr_device_sync_logs" ADD CONSTRAINT "fk_hr_device_sync_logs_device_id_org" FOREIGN KEY (org_id, device_id) REFERENCES hr_time_devices(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_device_sync_logs_device_id_org'
             AND conrelid = to_regclass('public.hr_device_sync_logs') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_device_sync_logs" VALIDATE CONSTRAINT "fk_hr_device_sync_logs_device_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_disciplinary_actions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_disciplinary_actions_case_id_org'
                     AND conrelid = to_regclass('public.hr_disciplinary_actions')) THEN
    ALTER TABLE "public"."hr_disciplinary_actions" ADD CONSTRAINT "fk_hr_disciplinary_actions_case_id_org" FOREIGN KEY (org_id, case_id) REFERENCES hr_cases(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_disciplinary_actions_case_id_org'
             AND conrelid = to_regclass('public.hr_disciplinary_actions') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_disciplinary_actions" VALIDATE CONSTRAINT "fk_hr_disciplinary_actions_case_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_effective_dated_changes') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_effective_dated_changes_employment_id_org'
                     AND conrelid = to_regclass('public.hr_effective_dated_changes')) THEN
    ALTER TABLE "public"."hr_effective_dated_changes" ADD CONSTRAINT "fk_hr_effective_dated_changes_employment_id_org" FOREIGN KEY (org_id, employment_id) REFERENCES hr_employments(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_effective_dated_changes_employment_id_org'
             AND conrelid = to_regclass('public.hr_effective_dated_changes') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_effective_dated_changes" VALIDATE CONSTRAINT "fk_hr_effective_dated_changes_employment_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_emergency_responses') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_emergency_responses_event_id_org'
                     AND conrelid = to_regclass('public.hr_emergency_responses')) THEN
    ALTER TABLE "public"."hr_emergency_responses" ADD CONSTRAINT "fk_hr_emergency_responses_event_id_org" FOREIGN KEY (org_id, event_id) REFERENCES hr_emergency_events(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_emergency_responses_event_id_org'
             AND conrelid = to_regclass('public.hr_emergency_responses') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_emergency_responses" VALIDATE CONSTRAINT "fk_hr_emergency_responses_event_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_employee_sensitive_fields') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_employee_sensitive_fields_employment_id_org'
                     AND conrelid = to_regclass('public.hr_employee_sensitive_fields')) THEN
    ALTER TABLE "public"."hr_employee_sensitive_fields" ADD CONSTRAINT "fk_hr_employee_sensitive_fields_employment_id_org" FOREIGN KEY (org_id, employment_id) REFERENCES hr_employments(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_employee_sensitive_fields_employment_id_org'
             AND conrelid = to_regclass('public.hr_employee_sensitive_fields') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_employee_sensitive_fields" VALIDATE CONSTRAINT "fk_hr_employee_sensitive_fields_employment_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_employment_history') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_employment_history_employment_id_org'
                     AND conrelid = to_regclass('public.hr_employment_history')) THEN
    ALTER TABLE "public"."hr_employment_history" ADD CONSTRAINT "fk_hr_employment_history_employment_id_org" FOREIGN KEY (org_id, employment_id) REFERENCES hr_employments(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_employment_history_employment_id_org'
             AND conrelid = to_regclass('public.hr_employment_history') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_employment_history" VALIDATE CONSTRAINT "fk_hr_employment_history_employment_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_employments') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_employments_person_id_org'
                     AND conrelid = to_regclass('public.hr_employments')) THEN
    ALTER TABLE "public"."hr_employments" ADD CONSTRAINT "fk_hr_employments_person_id_org" FOREIGN KEY (org_id, person_id) REFERENCES hr_people(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_employments_person_id_org'
             AND conrelid = to_regclass('public.hr_employments') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_employments" VALIDATE CONSTRAINT "fk_hr_employments_person_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_equity_exercises') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_equity_exercises_grant_id_org'
                     AND conrelid = to_regclass('public.hr_equity_exercises')) THEN
    ALTER TABLE "public"."hr_equity_exercises" ADD CONSTRAINT "fk_hr_equity_exercises_grant_id_org" FOREIGN KEY (org_id, grant_id) REFERENCES hr_equity_grants(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_equity_exercises_grant_id_org'
             AND conrelid = to_regclass('public.hr_equity_exercises') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_equity_exercises" VALIDATE CONSTRAINT "fk_hr_equity_exercises_grant_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_equity_vesting_events') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_equity_vesting_events_grant_id_org'
                     AND conrelid = to_regclass('public.hr_equity_vesting_events')) THEN
    ALTER TABLE "public"."hr_equity_vesting_events" ADD CONSTRAINT "fk_hr_equity_vesting_events_grant_id_org" FOREIGN KEY (org_id, grant_id) REFERENCES hr_equity_grants(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_equity_vesting_events_grant_id_org'
             AND conrelid = to_regclass('public.hr_equity_vesting_events') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_equity_vesting_events" VALIDATE CONSTRAINT "fk_hr_equity_vesting_events_grant_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_form_submissions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_form_submissions_form_id_org'
                     AND conrelid = to_regclass('public.hr_form_submissions')) THEN
    ALTER TABLE "public"."hr_form_submissions" ADD CONSTRAINT "fk_hr_form_submissions_form_id_org" FOREIGN KEY (org_id, form_id) REFERENCES hr_forms(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_form_submissions_form_id_org'
             AND conrelid = to_regclass('public.hr_form_submissions') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_form_submissions" VALIDATE CONSTRAINT "fk_hr_form_submissions_form_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_helpdesk_comments') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_helpdesk_comments_ticket_id_org'
                     AND conrelid = to_regclass('public.hr_helpdesk_comments')) THEN
    ALTER TABLE "public"."hr_helpdesk_comments" ADD CONSTRAINT "fk_hr_helpdesk_comments_ticket_id_org" FOREIGN KEY (org_id, ticket_id) REFERENCES helpdesk_tickets(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_helpdesk_comments_ticket_id_org'
             AND conrelid = to_regclass('public.hr_helpdesk_comments') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_helpdesk_comments" VALIDATE CONSTRAINT "fk_hr_helpdesk_comments_ticket_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_import_rows') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_import_rows_job_id_org'
                     AND conrelid = to_regclass('public.hr_import_rows')) THEN
    ALTER TABLE "public"."hr_import_rows" ADD CONSTRAINT "fk_hr_import_rows_job_id_org" FOREIGN KEY (org_id, job_id) REFERENCES hr_import_jobs(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_import_rows_job_id_org'
             AND conrelid = to_regclass('public.hr_import_rows') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_import_rows" VALIDATE CONSTRAINT "fk_hr_import_rows_job_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_insurance_claims') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_insurance_claims_plan_id_org'
                     AND conrelid = to_regclass('public.hr_insurance_claims')) THEN
    ALTER TABLE "public"."hr_insurance_claims" ADD CONSTRAINT "fk_hr_insurance_claims_plan_id_org" FOREIGN KEY (org_id, plan_id) REFERENCES hr_benefit_plans(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_insurance_claims_plan_id_org'
             AND conrelid = to_regclass('public.hr_insurance_claims') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_insurance_claims" VALIDATE CONSTRAINT "fk_hr_insurance_claims_plan_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_leave_ledger') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_leave_ledger_leave_type_id_org'
                     AND conrelid = to_regclass('public.hr_leave_ledger')) THEN
    ALTER TABLE "public"."hr_leave_ledger" ADD CONSTRAINT "fk_hr_leave_ledger_leave_type_id_org" FOREIGN KEY (org_id, leave_type_id) REFERENCES leave_types(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_leave_ledger_leave_type_id_org'
             AND conrelid = to_regclass('public.hr_leave_ledger') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_leave_ledger" VALIDATE CONSTRAINT "fk_hr_leave_ledger_leave_type_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_legal_hold_items') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_legal_hold_items_hold_id_org'
                     AND conrelid = to_regclass('public.hr_legal_hold_items')) THEN
    ALTER TABLE "public"."hr_legal_hold_items" ADD CONSTRAINT "fk_hr_legal_hold_items_hold_id_org" FOREIGN KEY (org_id, hold_id) REFERENCES hr_legal_holds(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_legal_hold_items_hold_id_org'
             AND conrelid = to_regclass('public.hr_legal_hold_items') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_legal_hold_items" VALIDATE CONSTRAINT "fk_hr_legal_hold_items_hold_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_payroll_adjustments') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_payroll_adjustments_period_id_org'
                     AND conrelid = to_regclass('public.hr_payroll_adjustments')) THEN
    ALTER TABLE "public"."hr_payroll_adjustments" ADD CONSTRAINT "fk_hr_payroll_adjustments_period_id_org" FOREIGN KEY (org_id, period_id) REFERENCES hr_payroll_input_periods(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_payroll_adjustments_period_id_org'
             AND conrelid = to_regclass('public.hr_payroll_adjustments') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_payroll_adjustments" VALIDATE CONSTRAINT "fk_hr_payroll_adjustments_period_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_payroll_input_snapshots') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_payroll_input_snapshots_period_id_org'
                     AND conrelid = to_regclass('public.hr_payroll_input_snapshots')) THEN
    ALTER TABLE "public"."hr_payroll_input_snapshots" ADD CONSTRAINT "fk_hr_payroll_input_snapshots_period_id_org" FOREIGN KEY (org_id, period_id) REFERENCES hr_payroll_input_periods(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_payroll_input_snapshots_period_id_org'
             AND conrelid = to_regclass('public.hr_payroll_input_snapshots') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_payroll_input_snapshots" VALIDATE CONSTRAINT "fk_hr_payroll_input_snapshots_period_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_policy_scopes') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_policy_scopes_policy_id_org'
                     AND conrelid = to_regclass('public.hr_policy_scopes')) THEN
    ALTER TABLE "public"."hr_policy_scopes" ADD CONSTRAINT "fk_hr_policy_scopes_policy_id_org" FOREIGN KEY (org_id, policy_id) REFERENCES hr_policies(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_policy_scopes_policy_id_org'
             AND conrelid = to_regclass('public.hr_policy_scopes') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_policy_scopes" VALIDATE CONSTRAINT "fk_hr_policy_scopes_policy_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_poll_votes') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_poll_votes_poll_id_org'
                     AND conrelid = to_regclass('public.hr_poll_votes')) THEN
    ALTER TABLE "public"."hr_poll_votes" ADD CONSTRAINT "fk_hr_poll_votes_poll_id_org" FOREIGN KEY (org_id, poll_id) REFERENCES hr_polls(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_poll_votes_poll_id_org'
             AND conrelid = to_regclass('public.hr_poll_votes') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_poll_votes" VALIDATE CONSTRAINT "fk_hr_poll_votes_poll_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_probation_reviews') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_probation_reviews_employment_id_org'
                     AND conrelid = to_regclass('public.hr_probation_reviews')) THEN
    ALTER TABLE "public"."hr_probation_reviews" ADD CONSTRAINT "fk_hr_probation_reviews_employment_id_org" FOREIGN KEY (org_id, employment_id) REFERENCES hr_employments(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_probation_reviews_employment_id_org'
             AND conrelid = to_regclass('public.hr_probation_reviews') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_probation_reviews" VALIDATE CONSTRAINT "fk_hr_probation_reviews_employment_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_probation_reviews') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_probation_reviews_person_id_org'
                     AND conrelid = to_regclass('public.hr_probation_reviews')) THEN
    ALTER TABLE "public"."hr_probation_reviews" ADD CONSTRAINT "fk_hr_probation_reviews_person_id_org" FOREIGN KEY (org_id, person_id) REFERENCES hr_people(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_probation_reviews_person_id_org'
             AND conrelid = to_regclass('public.hr_probation_reviews') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_probation_reviews" VALIDATE CONSTRAINT "fk_hr_probation_reviews_person_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_probation_reviews') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_probation_reviews_review_template_id_org'
                     AND conrelid = to_regclass('public.hr_probation_reviews')) THEN
    ALTER TABLE "public"."hr_probation_reviews" ADD CONSTRAINT "fk_hr_probation_reviews_review_template_id_org" FOREIGN KEY (org_id, review_template_id) REFERENCES hr_templates(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_probation_reviews_review_template_id_org'
             AND conrelid = to_regclass('public.hr_probation_reviews') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_probation_reviews" VALIDATE CONSTRAINT "fk_hr_probation_reviews_review_template_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_reporting_lines') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_reporting_lines_employment_id_org'
                     AND conrelid = to_regclass('public.hr_reporting_lines')) THEN
    ALTER TABLE "public"."hr_reporting_lines" ADD CONSTRAINT "fk_hr_reporting_lines_employment_id_org" FOREIGN KEY (org_id, employment_id) REFERENCES hr_employments(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_reporting_lines_employment_id_org'
             AND conrelid = to_regclass('public.hr_reporting_lines') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_reporting_lines" VALIDATE CONSTRAINT "fk_hr_reporting_lines_employment_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_role_skill_requirements') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_role_skill_requirements_job_role_id_org'
                     AND conrelid = to_regclass('public.hr_role_skill_requirements')) THEN
    ALTER TABLE "public"."hr_role_skill_requirements" ADD CONSTRAINT "fk_hr_role_skill_requirements_job_role_id_org" FOREIGN KEY (org_id, job_role_id) REFERENCES hr_job_roles(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_role_skill_requirements_job_role_id_org'
             AND conrelid = to_regclass('public.hr_role_skill_requirements') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_role_skill_requirements" VALIDATE CONSTRAINT "fk_hr_role_skill_requirements_job_role_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_succession_plans') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_succession_plans_job_role_id_org'
                     AND conrelid = to_regclass('public.hr_succession_plans')) THEN
    ALTER TABLE "public"."hr_succession_plans" ADD CONSTRAINT "fk_hr_succession_plans_job_role_id_org" FOREIGN KEY (org_id, job_role_id) REFERENCES hr_job_roles(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_succession_plans_job_role_id_org'
             AND conrelid = to_regclass('public.hr_succession_plans') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_succession_plans" VALIDATE CONSTRAINT "fk_hr_succession_plans_job_role_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_template_renders') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_template_renders_template_id_org'
                     AND conrelid = to_regclass('public.hr_template_renders')) THEN
    ALTER TABLE "public"."hr_template_renders" ADD CONSTRAINT "fk_hr_template_renders_template_id_org" FOREIGN KEY (org_id, template_id) REFERENCES hr_templates(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_template_renders_template_id_org'
             AND conrelid = to_regclass('public.hr_template_renders') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_template_renders" VALIDATE CONSTRAINT "fk_hr_template_renders_template_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_webhook_deliveries') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_webhook_deliveries_subscription_id_org'
                     AND conrelid = to_regclass('public.hr_webhook_deliveries')) THEN
    ALTER TABLE "public"."hr_webhook_deliveries" ADD CONSTRAINT "fk_hr_webhook_deliveries_subscription_id_org" FOREIGN KEY (org_id, subscription_id) REFERENCES hr_webhook_subscriptions(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_webhook_deliveries_subscription_id_org'
             AND conrelid = to_regclass('public.hr_webhook_deliveries') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_webhook_deliveries" VALIDATE CONSTRAINT "fk_hr_webhook_deliveries_subscription_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_work_authorizations') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_work_authorizations_employment_id_org'
                     AND conrelid = to_regclass('public.hr_work_authorizations')) THEN
    ALTER TABLE "public"."hr_work_authorizations" ADD CONSTRAINT "fk_hr_work_authorizations_employment_id_org" FOREIGN KEY (org_id, employment_id) REFERENCES hr_employments(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_work_authorizations_employment_id_org'
             AND conrelid = to_regclass('public.hr_work_authorizations') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_work_authorizations" VALIDATE CONSTRAINT "fk_hr_work_authorizations_employment_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_workflow_instances') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_workflow_instances_definition_id_org'
                     AND conrelid = to_regclass('public.hr_workflow_instances')) THEN
    ALTER TABLE "public"."hr_workflow_instances" ADD CONSTRAINT "fk_hr_workflow_instances_definition_id_org" FOREIGN KEY (org_id, definition_id) REFERENCES hr_workflow_definitions(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_workflow_instances_definition_id_org'
             AND conrelid = to_regclass('public.hr_workflow_instances') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_workflow_instances" VALIDATE CONSTRAINT "fk_hr_workflow_instances_definition_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_workflow_step_actions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_workflow_step_actions_instance_id_org'
                     AND conrelid = to_regclass('public.hr_workflow_step_actions')) THEN
    ALTER TABLE "public"."hr_workflow_step_actions" ADD CONSTRAINT "fk_hr_workflow_step_actions_instance_id_org" FOREIGN KEY (org_id, instance_id) REFERENCES hr_workflow_instances(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_workflow_step_actions_instance_id_org'
             AND conrelid = to_regclass('public.hr_workflow_step_actions') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_workflow_step_actions" VALIDATE CONSTRAINT "fk_hr_workflow_step_actions_instance_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.hr_workflow_steps') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_workflow_steps_definition_id_org'
                     AND conrelid = to_regclass('public.hr_workflow_steps')) THEN
    ALTER TABLE "public"."hr_workflow_steps" ADD CONSTRAINT "fk_hr_workflow_steps_definition_id_org" FOREIGN KEY (org_id, definition_id) REFERENCES hr_workflow_definitions(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hr_workflow_steps_definition_id_org'
             AND conrelid = to_regclass('public.hr_workflow_steps') AND NOT convalidated) THEN
    ALTER TABLE "public"."hr_workflow_steps" VALIDATE CONSTRAINT "fk_hr_workflow_steps_definition_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.incentives') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_incentives_client_account_id_org'
                     AND conrelid = to_regclass('public.incentives')) THEN
    ALTER TABLE "public"."incentives" ADD CONSTRAINT "fk_incentives_client_account_id_org" FOREIGN KEY (org_id, client_account_id) REFERENCES client_accounts(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_incentives_client_account_id_org'
             AND conrelid = to_regclass('public.incentives') AND NOT convalidated) THEN
    ALTER TABLE "public"."incentives" VALIDATE CONSTRAINT "fk_incentives_client_account_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.interview_booking_links') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_interview_booking_links_candidate_id_org'
                     AND conrelid = to_regclass('public.interview_booking_links')) THEN
    ALTER TABLE "public"."interview_booking_links" ADD CONSTRAINT "fk_interview_booking_links_candidate_id_org" FOREIGN KEY (org_id, candidate_id) REFERENCES candidates(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_interview_booking_links_candidate_id_org'
             AND conrelid = to_regclass('public.interview_booking_links') AND NOT convalidated) THEN
    ALTER TABLE "public"."interview_booking_links" VALIDATE CONSTRAINT "fk_interview_booking_links_candidate_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.interview_booking_links') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_interview_booking_links_job_posting_id_org'
                     AND conrelid = to_regclass('public.interview_booking_links')) THEN
    ALTER TABLE "public"."interview_booking_links" ADD CONSTRAINT "fk_interview_booking_links_job_posting_id_org" FOREIGN KEY (org_id, job_posting_id) REFERENCES job_postings(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_interview_booking_links_job_posting_id_org'
             AND conrelid = to_regclass('public.interview_booking_links') AND NOT convalidated) THEN
    ALTER TABLE "public"."interview_booking_links" VALIDATE CONSTRAINT "fk_interview_booking_links_job_posting_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.interview_panel_members') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_interview_panel_members_interview_id_org'
                     AND conrelid = to_regclass('public.interview_panel_members')) THEN
    ALTER TABLE "public"."interview_panel_members" ADD CONSTRAINT "fk_interview_panel_members_interview_id_org" FOREIGN KEY (org_id, interview_id) REFERENCES interviews(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_interview_panel_members_interview_id_org'
             AND conrelid = to_regclass('public.interview_panel_members') AND NOT convalidated) THEN
    ALTER TABLE "public"."interview_panel_members" VALIDATE CONSTRAINT "fk_interview_panel_members_interview_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.interview_scorecards') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_interview_scorecards_interview_id_org'
                     AND conrelid = to_regclass('public.interview_scorecards')) THEN
    ALTER TABLE "public"."interview_scorecards" ADD CONSTRAINT "fk_interview_scorecards_interview_id_org" FOREIGN KEY (org_id, interview_id) REFERENCES interviews(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_interview_scorecards_interview_id_org'
             AND conrelid = to_regclass('public.interview_scorecards') AND NOT convalidated) THEN
    ALTER TABLE "public"."interview_scorecards" VALIDATE CONSTRAINT "fk_interview_scorecards_interview_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.interview_scorecards') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_interview_scorecards_template_id_org'
                     AND conrelid = to_regclass('public.interview_scorecards')) THEN
    ALTER TABLE "public"."interview_scorecards" ADD CONSTRAINT "fk_interview_scorecards_template_id_org" FOREIGN KEY (org_id, template_id) REFERENCES scorecard_templates(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_interview_scorecards_template_id_org'
             AND conrelid = to_regclass('public.interview_scorecards') AND NOT convalidated) THEN
    ALTER TABLE "public"."interview_scorecards" VALIDATE CONSTRAINT "fk_interview_scorecards_template_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.interviews') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_interviews_candidate_id_org'
                     AND conrelid = to_regclass('public.interviews')) THEN
    ALTER TABLE "public"."interviews" ADD CONSTRAINT "fk_interviews_candidate_id_org" FOREIGN KEY (org_id, candidate_id) REFERENCES candidates(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_interviews_candidate_id_org'
             AND conrelid = to_regclass('public.interviews') AND NOT convalidated) THEN
    ALTER TABLE "public"."interviews" VALIDATE CONSTRAINT "fk_interviews_candidate_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.interviews') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_interviews_job_posting_id_org'
                     AND conrelid = to_regclass('public.interviews')) THEN
    ALTER TABLE "public"."interviews" ADD CONSTRAINT "fk_interviews_job_posting_id_org" FOREIGN KEY (org_id, job_posting_id) REFERENCES job_postings(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_interviews_job_posting_id_org'
             AND conrelid = to_regclass('public.interviews') AND NOT convalidated) THEN
    ALTER TABLE "public"."interviews" VALIDATE CONSTRAINT "fk_interviews_job_posting_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.investment_proofs') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_investment_proofs_declaration_id_org'
                     AND conrelid = to_regclass('public.investment_proofs')) THEN
    ALTER TABLE "public"."investment_proofs" ADD CONSTRAINT "fk_investment_proofs_declaration_id_org" FOREIGN KEY (org_id, declaration_id) REFERENCES tax_declarations(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_investment_proofs_declaration_id_org'
             AND conrelid = to_regclass('public.investment_proofs') AND NOT convalidated) THEN
    ALTER TABLE "public"."investment_proofs" VALIDATE CONSTRAINT "fk_investment_proofs_declaration_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.invoice_items') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_invoice_items_invoice_id_org'
                     AND conrelid = to_regclass('public.invoice_items')) THEN
    ALTER TABLE "public"."invoice_items" ADD CONSTRAINT "fk_invoice_items_invoice_id_org" FOREIGN KEY (org_id, invoice_id) REFERENCES invoices(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_invoice_items_invoice_id_org'
             AND conrelid = to_regclass('public.invoice_items') AND NOT convalidated) THEN
    ALTER TABLE "public"."invoice_items" VALIDATE CONSTRAINT "fk_invoice_items_invoice_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.invoices') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_invoices_client_id_org'
                     AND conrelid = to_regclass('public.invoices')) THEN
    ALTER TABLE "public"."invoices" ADD CONSTRAINT "fk_invoices_client_id_org" FOREIGN KEY (org_id, client_id) REFERENCES clients(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_invoices_client_id_org'
             AND conrelid = to_regclass('public.invoices') AND NOT convalidated) THEN
    ALTER TABLE "public"."invoices" VALIDATE CONSTRAINT "fk_invoices_client_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.invoices') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_invoices_client_party_id'
                     AND conrelid = to_regclass('public.invoices')) THEN
    ALTER TABLE "public"."invoices" ADD CONSTRAINT "fk_invoices_client_party_id" FOREIGN KEY (org_id, client_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_invoices_client_party_id'
             AND conrelid = to_regclass('public.invoices') AND NOT convalidated) THEN
    ALTER TABLE "public"."invoices" VALIDATE CONSTRAINT "fk_invoices_client_party_id";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.invoices') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_invoices_project_id_org'
                     AND conrelid = to_regclass('public.invoices')) THEN
    ALTER TABLE "public"."invoices" ADD CONSTRAINT "fk_invoices_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES build.projects(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_invoices_project_id_org'
             AND conrelid = to_regclass('public.invoices') AND NOT convalidated) THEN
    ALTER TABLE "public"."invoices" VALIDATE CONSTRAINT "fk_invoices_project_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.job_board_postings') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_job_board_postings_job_posting_id_org'
                     AND conrelid = to_regclass('public.job_board_postings')) THEN
    ALTER TABLE "public"."job_board_postings" ADD CONSTRAINT "fk_job_board_postings_job_posting_id_org" FOREIGN KEY (org_id, job_posting_id) REFERENCES job_postings(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_job_board_postings_job_posting_id_org'
             AND conrelid = to_regclass('public.job_board_postings') AND NOT convalidated) THEN
    ALTER TABLE "public"."job_board_postings" VALIDATE CONSTRAINT "fk_job_board_postings_job_posting_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.job_postings') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_job_postings_hiring_flow_id_org'
                     AND conrelid = to_regclass('public.job_postings')) THEN
    ALTER TABLE "public"."job_postings" ADD CONSTRAINT "fk_job_postings_hiring_flow_id_org" FOREIGN KEY (org_id, hiring_flow_id) REFERENCES hiring_flows(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_job_postings_hiring_flow_id_org'
             AND conrelid = to_regclass('public.job_postings') AND NOT convalidated) THEN
    ALTER TABLE "public"."job_postings" VALIDATE CONSTRAINT "fk_job_postings_hiring_flow_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.job_recruiters') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_job_recruiters_job_posting_id_org'
                     AND conrelid = to_regclass('public.job_recruiters')) THEN
    ALTER TABLE "public"."job_recruiters" ADD CONSTRAINT "fk_job_recruiters_job_posting_id_org" FOREIGN KEY (org_id, job_posting_id) REFERENCES job_postings(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_job_recruiters_job_posting_id_org'
             AND conrelid = to_regclass('public.job_recruiters') AND NOT convalidated) THEN
    ALTER TABLE "public"."job_recruiters" VALIDATE CONSTRAINT "fk_job_recruiters_job_posting_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.journal_entries') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_journal_entries_reversed_entry_id_org'
                     AND conrelid = to_regclass('public.journal_entries')) THEN
    ALTER TABLE "public"."journal_entries" ADD CONSTRAINT "fk_journal_entries_reversed_entry_id_org" FOREIGN KEY (org_id, reversed_entry_id) REFERENCES journal_entries(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_journal_entries_reversed_entry_id_org'
             AND conrelid = to_regclass('public.journal_entries') AND NOT convalidated) THEN
    ALTER TABLE "public"."journal_entries" VALIDATE CONSTRAINT "fk_journal_entries_reversed_entry_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_article_attachments') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_article_attachments_article_id_org'
                     AND conrelid = to_regclass('public.kb_article_attachments')) THEN
    ALTER TABLE "public"."kb_article_attachments" ADD CONSTRAINT "fk_kb_article_attachments_article_id_org" FOREIGN KEY (org_id, article_id) REFERENCES kb_articles(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_article_attachments_article_id_org'
             AND conrelid = to_regclass('public.kb_article_attachments') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_article_attachments" VALIDATE CONSTRAINT "fk_kb_article_attachments_article_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_article_attachments') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_article_attachments_org_article'
                     AND conrelid = to_regclass('public.kb_article_attachments')) THEN
    ALTER TABLE "public"."kb_article_attachments" ADD CONSTRAINT "fk_kb_article_attachments_org_article" FOREIGN KEY (org_id, article_id) REFERENCES kb_articles(org_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_article_attachments_org_article'
             AND conrelid = to_regclass('public.kb_article_attachments') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_article_attachments" VALIDATE CONSTRAINT "fk_kb_article_attachments_org_article";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_article_chunks') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_article_chunks_article_id_org'
                     AND conrelid = to_regclass('public.kb_article_chunks')) THEN
    ALTER TABLE "public"."kb_article_chunks" ADD CONSTRAINT "fk_kb_article_chunks_article_id_org" FOREIGN KEY (org_id, article_id) REFERENCES kb_articles(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_article_chunks_article_id_org'
             AND conrelid = to_regclass('public.kb_article_chunks') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_article_chunks" VALIDATE CONSTRAINT "fk_kb_article_chunks_article_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_article_chunks') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_article_chunks_attachment_id_org'
                     AND conrelid = to_regclass('public.kb_article_chunks')) THEN
    ALTER TABLE "public"."kb_article_chunks" ADD CONSTRAINT "fk_kb_article_chunks_attachment_id_org" FOREIGN KEY (org_id, attachment_id) REFERENCES kb_article_attachments(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_article_chunks_attachment_id_org'
             AND conrelid = to_regclass('public.kb_article_chunks') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_article_chunks" VALIDATE CONSTRAINT "fk_kb_article_chunks_attachment_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_article_chunks') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_article_chunks_page_id_org'
                     AND conrelid = to_regclass('public.kb_article_chunks')) THEN
    ALTER TABLE "public"."kb_article_chunks" ADD CONSTRAINT "fk_kb_article_chunks_page_id_org" FOREIGN KEY (org_id, page_id) REFERENCES kb_pages(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_article_chunks_page_id_org'
             AND conrelid = to_regclass('public.kb_article_chunks') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_article_chunks" VALIDATE CONSTRAINT "fk_kb_article_chunks_page_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_article_chunks') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_article_chunks_source_id_org'
                     AND conrelid = to_regclass('public.kb_article_chunks')) THEN
    ALTER TABLE "public"."kb_article_chunks" ADD CONSTRAINT "fk_kb_article_chunks_source_id_org" FOREIGN KEY (org_id, source_id) REFERENCES kb_sources(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_article_chunks_source_id_org'
             AND conrelid = to_regclass('public.kb_article_chunks') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_article_chunks" VALIDATE CONSTRAINT "fk_kb_article_chunks_source_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_article_chunks') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_chunks_org_article'
                     AND conrelid = to_regclass('public.kb_article_chunks')) THEN
    ALTER TABLE "public"."kb_article_chunks" ADD CONSTRAINT "fk_kb_chunks_org_article" FOREIGN KEY (org_id, article_id) REFERENCES kb_articles(org_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_chunks_org_article'
             AND conrelid = to_regclass('public.kb_article_chunks') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_article_chunks" VALIDATE CONSTRAINT "fk_kb_chunks_org_article";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_article_chunks') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_chunks_org_attachment'
                     AND conrelid = to_regclass('public.kb_article_chunks')) THEN
    ALTER TABLE "public"."kb_article_chunks" ADD CONSTRAINT "fk_kb_chunks_org_attachment" FOREIGN KEY (org_id, attachment_id) REFERENCES kb_article_attachments(org_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_chunks_org_attachment'
             AND conrelid = to_regclass('public.kb_article_chunks') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_article_chunks" VALIDATE CONSTRAINT "fk_kb_chunks_org_attachment";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_article_chunks') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_chunks_org_page'
                     AND conrelid = to_regclass('public.kb_article_chunks')) THEN
    ALTER TABLE "public"."kb_article_chunks" ADD CONSTRAINT "fk_kb_chunks_org_page" FOREIGN KEY (org_id, page_id) REFERENCES kb_pages(org_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_chunks_org_page'
             AND conrelid = to_regclass('public.kb_article_chunks') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_article_chunks" VALIDATE CONSTRAINT "fk_kb_chunks_org_page";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_article_chunks') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_chunks_org_source'
                     AND conrelid = to_regclass('public.kb_article_chunks')) THEN
    ALTER TABLE "public"."kb_article_chunks" ADD CONSTRAINT "fk_kb_chunks_org_source" FOREIGN KEY (org_id, source_id) REFERENCES kb_sources(org_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_chunks_org_source'
             AND conrelid = to_regclass('public.kb_article_chunks') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_article_chunks" VALIDATE CONSTRAINT "fk_kb_chunks_org_source";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_article_comments') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_article_comments_article_id_org'
                     AND conrelid = to_regclass('public.kb_article_comments')) THEN
    ALTER TABLE "public"."kb_article_comments" ADD CONSTRAINT "fk_kb_article_comments_article_id_org" FOREIGN KEY (org_id, article_id) REFERENCES kb_articles(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_article_comments_article_id_org'
             AND conrelid = to_regclass('public.kb_article_comments') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_article_comments" VALIDATE CONSTRAINT "fk_kb_article_comments_article_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_article_feedback') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_article_feedback_article_id_org'
                     AND conrelid = to_regclass('public.kb_article_feedback')) THEN
    ALTER TABLE "public"."kb_article_feedback" ADD CONSTRAINT "fk_kb_article_feedback_article_id_org" FOREIGN KEY (org_id, article_id) REFERENCES kb_articles(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_article_feedback_article_id_org'
             AND conrelid = to_regclass('public.kb_article_feedback') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_article_feedback" VALIDATE CONSTRAINT "fk_kb_article_feedback_article_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_article_feedback') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_article_feedback_org_article'
                     AND conrelid = to_regclass('public.kb_article_feedback')) THEN
    ALTER TABLE "public"."kb_article_feedback" ADD CONSTRAINT "fk_kb_article_feedback_org_article" FOREIGN KEY (org_id, article_id) REFERENCES kb_articles(org_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_article_feedback_org_article'
             AND conrelid = to_regclass('public.kb_article_feedback') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_article_feedback" VALIDATE CONSTRAINT "fk_kb_article_feedback_org_article";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_article_restrictions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_article_restrictions_article_id_org'
                     AND conrelid = to_regclass('public.kb_article_restrictions')) THEN
    ALTER TABLE "public"."kb_article_restrictions" ADD CONSTRAINT "fk_kb_article_restrictions_article_id_org" FOREIGN KEY (org_id, article_id) REFERENCES kb_articles(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_article_restrictions_article_id_org'
             AND conrelid = to_regclass('public.kb_article_restrictions') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_article_restrictions" VALIDATE CONSTRAINT "fk_kb_article_restrictions_article_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_article_restrictions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_article_restrictions_org_article'
                     AND conrelid = to_regclass('public.kb_article_restrictions')) THEN
    ALTER TABLE "public"."kb_article_restrictions" ADD CONSTRAINT "fk_kb_article_restrictions_org_article" FOREIGN KEY (org_id, article_id) REFERENCES kb_articles(org_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_article_restrictions_org_article'
             AND conrelid = to_regclass('public.kb_article_restrictions') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_article_restrictions" VALIDATE CONSTRAINT "fk_kb_article_restrictions_org_article";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_article_tags') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_article_tags_article_id_org'
                     AND conrelid = to_regclass('public.kb_article_tags')) THEN
    ALTER TABLE "public"."kb_article_tags" ADD CONSTRAINT "fk_kb_article_tags_article_id_org" FOREIGN KEY (org_id, article_id) REFERENCES kb_articles(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_article_tags_article_id_org'
             AND conrelid = to_regclass('public.kb_article_tags') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_article_tags" VALIDATE CONSTRAINT "fk_kb_article_tags_article_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_article_tags') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_article_tags_org_article'
                     AND conrelid = to_regclass('public.kb_article_tags')) THEN
    ALTER TABLE "public"."kb_article_tags" ADD CONSTRAINT "fk_kb_article_tags_org_article" FOREIGN KEY (org_id, article_id) REFERENCES kb_articles(org_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_article_tags_org_article'
             AND conrelid = to_regclass('public.kb_article_tags') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_article_tags" VALIDATE CONSTRAINT "fk_kb_article_tags_org_article";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_article_tags') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_article_tags_org_tag'
                     AND conrelid = to_regclass('public.kb_article_tags')) THEN
    ALTER TABLE "public"."kb_article_tags" ADD CONSTRAINT "fk_kb_article_tags_org_tag" FOREIGN KEY (org_id, tag_id) REFERENCES kb_tags(org_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_article_tags_org_tag'
             AND conrelid = to_regclass('public.kb_article_tags') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_article_tags" VALIDATE CONSTRAINT "fk_kb_article_tags_org_tag";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_article_tags') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_article_tags_tag_id_org'
                     AND conrelid = to_regclass('public.kb_article_tags')) THEN
    ALTER TABLE "public"."kb_article_tags" ADD CONSTRAINT "fk_kb_article_tags_tag_id_org" FOREIGN KEY (org_id, tag_id) REFERENCES kb_tags(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_article_tags_tag_id_org'
             AND conrelid = to_regclass('public.kb_article_tags') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_article_tags" VALIDATE CONSTRAINT "fk_kb_article_tags_tag_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_article_translations') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_article_translations_article_id_org'
                     AND conrelid = to_regclass('public.kb_article_translations')) THEN
    ALTER TABLE "public"."kb_article_translations" ADD CONSTRAINT "fk_kb_article_translations_article_id_org" FOREIGN KEY (org_id, article_id) REFERENCES kb_articles(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_article_translations_article_id_org'
             AND conrelid = to_regclass('public.kb_article_translations') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_article_translations" VALIDATE CONSTRAINT "fk_kb_article_translations_article_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_article_translations') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_article_translations_org_article'
                     AND conrelid = to_regclass('public.kb_article_translations')) THEN
    ALTER TABLE "public"."kb_article_translations" ADD CONSTRAINT "fk_kb_article_translations_org_article" FOREIGN KEY (org_id, article_id) REFERENCES kb_articles(org_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_article_translations_org_article'
             AND conrelid = to_regclass('public.kb_article_translations') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_article_translations" VALIDATE CONSTRAINT "fk_kb_article_translations_org_article";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_article_versions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_article_versions_article_id_org'
                     AND conrelid = to_regclass('public.kb_article_versions')) THEN
    ALTER TABLE "public"."kb_article_versions" ADD CONSTRAINT "fk_kb_article_versions_article_id_org" FOREIGN KEY (org_id, article_id) REFERENCES kb_articles(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_article_versions_article_id_org'
             AND conrelid = to_regclass('public.kb_article_versions') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_article_versions" VALIDATE CONSTRAINT "fk_kb_article_versions_article_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_article_versions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_article_versions_org_article'
                     AND conrelid = to_regclass('public.kb_article_versions')) THEN
    ALTER TABLE "public"."kb_article_versions" ADD CONSTRAINT "fk_kb_article_versions_org_article" FOREIGN KEY (org_id, article_id) REFERENCES kb_articles(org_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_article_versions_org_article'
             AND conrelid = to_regclass('public.kb_article_versions') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_article_versions" VALIDATE CONSTRAINT "fk_kb_article_versions_org_article";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_articles') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_articles_category_id_org'
                     AND conrelid = to_regclass('public.kb_articles')) THEN
    ALTER TABLE "public"."kb_articles" ADD CONSTRAINT "fk_kb_articles_category_id_org" FOREIGN KEY (org_id, category_id) REFERENCES kb_categories(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_articles_category_id_org'
             AND conrelid = to_regclass('public.kb_articles') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_articles" VALIDATE CONSTRAINT "fk_kb_articles_category_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_articles') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_articles_org_category'
                     AND conrelid = to_regclass('public.kb_articles')) THEN
    ALTER TABLE "public"."kb_articles" ADD CONSTRAINT "fk_kb_articles_org_category" FOREIGN KEY (org_id, category_id) REFERENCES kb_categories(org_id, id) ON DELETE SET NULL NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_articles_org_category'
             AND conrelid = to_regclass('public.kb_articles') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_articles" VALIDATE CONSTRAINT "fk_kb_articles_org_category";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_articles') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_articles_org_space'
                     AND conrelid = to_regclass('public.kb_articles')) THEN
    ALTER TABLE "public"."kb_articles" ADD CONSTRAINT "fk_kb_articles_org_space" FOREIGN KEY (org_id, space_id) REFERENCES kb_spaces(org_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_articles_org_space'
             AND conrelid = to_regclass('public.kb_articles') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_articles" VALIDATE CONSTRAINT "fk_kb_articles_org_space";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_articles') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_articles_space_id_org'
                     AND conrelid = to_regclass('public.kb_articles')) THEN
    ALTER TABLE "public"."kb_articles" ADD CONSTRAINT "fk_kb_articles_space_id_org" FOREIGN KEY (org_id, space_id) REFERENCES kb_spaces(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_articles_space_id_org'
             AND conrelid = to_regclass('public.kb_articles') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_articles" VALIDATE CONSTRAINT "fk_kb_articles_space_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_categories') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_categories_org_parent'
                     AND conrelid = to_regclass('public.kb_categories')) THEN
    ALTER TABLE "public"."kb_categories" ADD CONSTRAINT "fk_kb_categories_org_parent" FOREIGN KEY (org_id, parent_id) REFERENCES kb_categories(org_id, id) ON DELETE SET NULL NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_categories_org_parent'
             AND conrelid = to_regclass('public.kb_categories') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_categories" VALIDATE CONSTRAINT "fk_kb_categories_org_parent";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_categories') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_categories_org_space'
                     AND conrelid = to_regclass('public.kb_categories')) THEN
    ALTER TABLE "public"."kb_categories" ADD CONSTRAINT "fk_kb_categories_org_space" FOREIGN KEY (org_id, space_id) REFERENCES kb_spaces(org_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_categories_org_space'
             AND conrelid = to_regclass('public.kb_categories') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_categories" VALIDATE CONSTRAINT "fk_kb_categories_org_space";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_categories') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_categories_parent_id_org'
                     AND conrelid = to_regclass('public.kb_categories')) THEN
    ALTER TABLE "public"."kb_categories" ADD CONSTRAINT "fk_kb_categories_parent_id_org" FOREIGN KEY (org_id, parent_id) REFERENCES kb_categories(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_categories_parent_id_org'
             AND conrelid = to_regclass('public.kb_categories') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_categories" VALIDATE CONSTRAINT "fk_kb_categories_parent_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_categories') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_categories_space_id_org'
                     AND conrelid = to_regclass('public.kb_categories')) THEN
    ALTER TABLE "public"."kb_categories" ADD CONSTRAINT "fk_kb_categories_space_id_org" FOREIGN KEY (org_id, space_id) REFERENCES kb_spaces(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_categories_space_id_org'
             AND conrelid = to_regclass('public.kb_categories') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_categories" VALIDATE CONSTRAINT "fk_kb_categories_space_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_chat_messages') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_chat_messages_conversation_id_org'
                     AND conrelid = to_regclass('public.kb_chat_messages')) THEN
    ALTER TABLE "public"."kb_chat_messages" ADD CONSTRAINT "fk_kb_chat_messages_conversation_id_org" FOREIGN KEY (org_id, conversation_id) REFERENCES kb_chat_conversations(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_chat_messages_conversation_id_org'
             AND conrelid = to_regclass('public.kb_chat_messages') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_chat_messages" VALIDATE CONSTRAINT "fk_kb_chat_messages_conversation_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_chat_messages') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_chat_messages_org_conversation'
                     AND conrelid = to_regclass('public.kb_chat_messages')) THEN
    ALTER TABLE "public"."kb_chat_messages" ADD CONSTRAINT "fk_kb_chat_messages_org_conversation" FOREIGN KEY (org_id, conversation_id) REFERENCES kb_chat_conversations(org_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_chat_messages_org_conversation'
             AND conrelid = to_regclass('public.kb_chat_messages') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_chat_messages" VALIDATE CONSTRAINT "fk_kb_chat_messages_org_conversation";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_events') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_events_article_id_org'
                     AND conrelid = to_regclass('public.kb_events')) THEN
    ALTER TABLE "public"."kb_events" ADD CONSTRAINT "fk_kb_events_article_id_org" FOREIGN KEY (org_id, article_id) REFERENCES kb_articles(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_events_article_id_org'
             AND conrelid = to_regclass('public.kb_events') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_events" VALIDATE CONSTRAINT "fk_kb_events_article_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_events') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_events_org_article'
                     AND conrelid = to_regclass('public.kb_events')) THEN
    ALTER TABLE "public"."kb_events" ADD CONSTRAINT "fk_kb_events_org_article" FOREIGN KEY (org_id, article_id) REFERENCES kb_articles(org_id, id) ON DELETE SET NULL NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_events_org_article'
             AND conrelid = to_regclass('public.kb_events') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_events" VALIDATE CONSTRAINT "fk_kb_events_org_article";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_export_jobs') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_export_jobs_org_page'
                     AND conrelid = to_regclass('public.kb_export_jobs')) THEN
    ALTER TABLE "public"."kb_export_jobs" ADD CONSTRAINT "fk_kb_export_jobs_org_page" FOREIGN KEY (org_id, scope_id) REFERENCES kb_pages(org_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_export_jobs_org_page'
             AND conrelid = to_regclass('public.kb_export_jobs') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_export_jobs" VALIDATE CONSTRAINT "fk_kb_export_jobs_org_page";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_page_comments') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_page_comments_org_page'
                     AND conrelid = to_regclass('public.kb_page_comments')) THEN
    ALTER TABLE "public"."kb_page_comments" ADD CONSTRAINT "fk_kb_page_comments_org_page" FOREIGN KEY (org_id, page_id) REFERENCES kb_pages(org_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_page_comments_org_page'
             AND conrelid = to_regclass('public.kb_page_comments') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_page_comments" VALIDATE CONSTRAINT "fk_kb_page_comments_org_page";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_page_comments') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_page_comments_org_parent'
                     AND conrelid = to_regclass('public.kb_page_comments')) THEN
    ALTER TABLE "public"."kb_page_comments" ADD CONSTRAINT "fk_kb_page_comments_org_parent" FOREIGN KEY (org_id, parent_id) REFERENCES kb_page_comments(org_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_page_comments_org_parent'
             AND conrelid = to_regclass('public.kb_page_comments') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_page_comments" VALIDATE CONSTRAINT "fk_kb_page_comments_org_parent";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_page_comments') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_page_comments_page_id_org'
                     AND conrelid = to_regclass('public.kb_page_comments')) THEN
    ALTER TABLE "public"."kb_page_comments" ADD CONSTRAINT "fk_kb_page_comments_page_id_org" FOREIGN KEY (org_id, page_id) REFERENCES kb_pages(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_page_comments_page_id_org'
             AND conrelid = to_regclass('public.kb_page_comments') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_page_comments" VALIDATE CONSTRAINT "fk_kb_page_comments_page_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_page_comments') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_page_comments_parent_id_org'
                     AND conrelid = to_regclass('public.kb_page_comments')) THEN
    ALTER TABLE "public"."kb_page_comments" ADD CONSTRAINT "fk_kb_page_comments_parent_id_org" FOREIGN KEY (org_id, parent_id) REFERENCES kb_page_comments(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_page_comments_parent_id_org'
             AND conrelid = to_regclass('public.kb_page_comments') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_page_comments" VALIDATE CONSTRAINT "fk_kb_page_comments_parent_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_page_favorites') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_page_favorites_org_page'
                     AND conrelid = to_regclass('public.kb_page_favorites')) THEN
    ALTER TABLE "public"."kb_page_favorites" ADD CONSTRAINT "fk_kb_page_favorites_org_page" FOREIGN KEY (org_id, page_id) REFERENCES kb_pages(org_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_page_favorites_org_page'
             AND conrelid = to_regclass('public.kb_page_favorites') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_page_favorites" VALIDATE CONSTRAINT "fk_kb_page_favorites_org_page";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_page_favorites') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_page_favorites_page_id_org'
                     AND conrelid = to_regclass('public.kb_page_favorites')) THEN
    ALTER TABLE "public"."kb_page_favorites" ADD CONSTRAINT "fk_kb_page_favorites_page_id_org" FOREIGN KEY (org_id, page_id) REFERENCES kb_pages(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_page_favorites_page_id_org'
             AND conrelid = to_regclass('public.kb_page_favorites') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_page_favorites" VALIDATE CONSTRAINT "fk_kb_page_favorites_page_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_page_links') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_page_links_org_source'
                     AND conrelid = to_regclass('public.kb_page_links')) THEN
    ALTER TABLE "public"."kb_page_links" ADD CONSTRAINT "fk_kb_page_links_org_source" FOREIGN KEY (org_id, source_page_id) REFERENCES kb_pages(org_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_page_links_org_source'
             AND conrelid = to_regclass('public.kb_page_links') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_page_links" VALIDATE CONSTRAINT "fk_kb_page_links_org_source";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_page_links') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_page_links_org_target'
                     AND conrelid = to_regclass('public.kb_page_links')) THEN
    ALTER TABLE "public"."kb_page_links" ADD CONSTRAINT "fk_kb_page_links_org_target" FOREIGN KEY (org_id, target_page_id) REFERENCES kb_pages(org_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_page_links_org_target'
             AND conrelid = to_regclass('public.kb_page_links') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_page_links" VALIDATE CONSTRAINT "fk_kb_page_links_org_target";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_page_links') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_page_links_source_page_id_org'
                     AND conrelid = to_regclass('public.kb_page_links')) THEN
    ALTER TABLE "public"."kb_page_links" ADD CONSTRAINT "fk_kb_page_links_source_page_id_org" FOREIGN KEY (org_id, source_page_id) REFERENCES kb_pages(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_page_links_source_page_id_org'
             AND conrelid = to_regclass('public.kb_page_links') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_page_links" VALIDATE CONSTRAINT "fk_kb_page_links_source_page_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_page_reviews') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_page_reviews_org_page'
                     AND conrelid = to_regclass('public.kb_page_reviews')) THEN
    ALTER TABLE "public"."kb_page_reviews" ADD CONSTRAINT "fk_kb_page_reviews_org_page" FOREIGN KEY (org_id, page_id) REFERENCES kb_pages(org_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_page_reviews_org_page'
             AND conrelid = to_regclass('public.kb_page_reviews') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_page_reviews" VALIDATE CONSTRAINT "fk_kb_page_reviews_org_page";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_page_reviews') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_page_reviews_page_id_org'
                     AND conrelid = to_regclass('public.kb_page_reviews')) THEN
    ALTER TABLE "public"."kb_page_reviews" ADD CONSTRAINT "fk_kb_page_reviews_page_id_org" FOREIGN KEY (org_id, page_id) REFERENCES kb_pages(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_page_reviews_page_id_org'
             AND conrelid = to_regclass('public.kb_page_reviews') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_page_reviews" VALIDATE CONSTRAINT "fk_kb_page_reviews_page_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_page_versions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_page_versions_org_page'
                     AND conrelid = to_regclass('public.kb_page_versions')) THEN
    ALTER TABLE "public"."kb_page_versions" ADD CONSTRAINT "fk_kb_page_versions_org_page" FOREIGN KEY (org_id, page_id) REFERENCES kb_pages(org_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_page_versions_org_page'
             AND conrelid = to_regclass('public.kb_page_versions') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_page_versions" VALIDATE CONSTRAINT "fk_kb_page_versions_org_page";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_page_versions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_page_versions_page_id_org'
                     AND conrelid = to_regclass('public.kb_page_versions')) THEN
    ALTER TABLE "public"."kb_page_versions" ADD CONSTRAINT "fk_kb_page_versions_page_id_org" FOREIGN KEY (org_id, page_id) REFERENCES kb_pages(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_page_versions_page_id_org'
             AND conrelid = to_regclass('public.kb_page_versions') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_page_versions" VALIDATE CONSTRAINT "fk_kb_page_versions_page_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_page_visits') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_page_visits_org_page'
                     AND conrelid = to_regclass('public.kb_page_visits')) THEN
    ALTER TABLE "public"."kb_page_visits" ADD CONSTRAINT "fk_kb_page_visits_org_page" FOREIGN KEY (org_id, page_id) REFERENCES kb_pages(org_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_page_visits_org_page'
             AND conrelid = to_regclass('public.kb_page_visits') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_page_visits" VALIDATE CONSTRAINT "fk_kb_page_visits_org_page";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_page_visits') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_page_visits_page_id_org'
                     AND conrelid = to_regclass('public.kb_page_visits')) THEN
    ALTER TABLE "public"."kb_page_visits" ADD CONSTRAINT "fk_kb_page_visits_page_id_org" FOREIGN KEY (org_id, page_id) REFERENCES kb_pages(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_page_visits_page_id_org'
             AND conrelid = to_regclass('public.kb_page_visits') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_page_visits" VALIDATE CONSTRAINT "fk_kb_page_visits_page_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_pages') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_pages_org_created_membership'
                     AND conrelid = to_regclass('public.kb_pages')) THEN
    ALTER TABLE "public"."kb_pages" ADD CONSTRAINT "fk_kb_pages_org_created_membership" FOREIGN KEY (org_id, created_by_membership_id) REFERENCES organization_members(org_id, id) ON DELETE SET NULL NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
-- fk_kb_pages_org_created_membership is deliberately left NOT VALID: it is NOT VALID on the
-- source database, and WHY it was left that way is not established.
--
-- An earlier version of this comment said existing rows violate it. That was an
-- assumption, not a finding, and it is wrong as stated: there are zero violating
-- rows here. But that is not evidence the constraint holds either -- chat_channels,
-- chat_messages and kb_pages are all empty on this database, so zero violations
-- is entirely explained by zero rows, and nothing has been learned about real data.
--
-- So validating it here would succeed for a reason that says nothing, while the
-- same statement could fail on a populated database. Reproduce the source state
-- rather than improve on it. Whether these four can be validated is a decision
-- for the owners of chat and KB against data that exists; count the violations
-- first, with the FK columns' NULLs excluded.
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_pages') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_pages_org_owner_membership'
                     AND conrelid = to_regclass('public.kb_pages')) THEN
    ALTER TABLE "public"."kb_pages" ADD CONSTRAINT "fk_kb_pages_org_owner_membership" FOREIGN KEY (org_id, owner_membership_id) REFERENCES organization_members(org_id, id) ON DELETE SET NULL NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
-- fk_kb_pages_org_owner_membership is deliberately left NOT VALID: it is NOT VALID on the
-- source database, and WHY it was left that way is not established.
--
-- An earlier version of this comment said existing rows violate it. That was an
-- assumption, not a finding, and it is wrong as stated: there are zero violating
-- rows here. But that is not evidence the constraint holds either -- chat_channels,
-- chat_messages and kb_pages are all empty on this database, so zero violations
-- is entirely explained by zero rows, and nothing has been learned about real data.
--
-- So validating it here would succeed for a reason that says nothing, while the
-- same statement could fail on a populated database. Reproduce the source state
-- rather than improve on it. Whether these four can be validated is a decision
-- for the owners of chat and KB against data that exists; count the violations
-- first, with the FK columns' NULLs excluded.
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_pages') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_pages_org_parent'
                     AND conrelid = to_regclass('public.kb_pages')) THEN
    ALTER TABLE "public"."kb_pages" ADD CONSTRAINT "fk_kb_pages_org_parent" FOREIGN KEY (org_id, parent_page_id) REFERENCES kb_pages(org_id, id) ON DELETE SET NULL NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_pages_org_parent'
             AND conrelid = to_regclass('public.kb_pages') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_pages" VALIDATE CONSTRAINT "fk_kb_pages_org_parent";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_pages') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_pages_org_project'
                     AND conrelid = to_regclass('public.kb_pages')) THEN
    ALTER TABLE "public"."kb_pages" ADD CONSTRAINT "fk_kb_pages_org_project" FOREIGN KEY (org_id, project_id) REFERENCES build.projects(org_id, id) ON DELETE SET NULL NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_pages_org_project'
             AND conrelid = to_regclass('public.kb_pages') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_pages" VALIDATE CONSTRAINT "fk_kb_pages_org_project";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_pages') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_pages_org_source_article'
                     AND conrelid = to_regclass('public.kb_pages')) THEN
    ALTER TABLE "public"."kb_pages" ADD CONSTRAINT "fk_kb_pages_org_source_article" FOREIGN KEY (org_id, source_article_id) REFERENCES kb_articles(org_id, id) ON DELETE SET NULL NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_pages_org_source_article'
             AND conrelid = to_regclass('public.kb_pages') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_pages" VALIDATE CONSTRAINT "fk_kb_pages_org_source_article";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_pages') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_pages_org_space'
                     AND conrelid = to_regclass('public.kb_pages')) THEN
    ALTER TABLE "public"."kb_pages" ADD CONSTRAINT "fk_kb_pages_org_space" FOREIGN KEY (org_id, space_id) REFERENCES kb_spaces(org_id, id) ON DELETE SET NULL NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_pages_org_space'
             AND conrelid = to_regclass('public.kb_pages') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_pages" VALIDATE CONSTRAINT "fk_kb_pages_org_space";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_pages') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_pages_project_id_org'
                     AND conrelid = to_regclass('public.kb_pages')) THEN
    ALTER TABLE "public"."kb_pages" ADD CONSTRAINT "fk_kb_pages_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES build.projects(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_pages_project_id_org'
             AND conrelid = to_regclass('public.kb_pages') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_pages" VALIDATE CONSTRAINT "fk_kb_pages_project_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_pages') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_pages_space_id_org'
                     AND conrelid = to_regclass('public.kb_pages')) THEN
    ALTER TABLE "public"."kb_pages" ADD CONSTRAINT "fk_kb_pages_space_id_org" FOREIGN KEY (org_id, space_id) REFERENCES kb_spaces(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_pages_space_id_org'
             AND conrelid = to_regclass('public.kb_pages') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_pages" VALIDATE CONSTRAINT "fk_kb_pages_space_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_research_briefs') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_research_briefs_org_space'
                     AND conrelid = to_regclass('public.kb_research_briefs')) THEN
    ALTER TABLE "public"."kb_research_briefs" ADD CONSTRAINT "fk_kb_research_briefs_org_space" FOREIGN KEY (org_id, space_id) REFERENCES kb_spaces(org_id, id) ON DELETE SET NULL NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_research_briefs_org_space'
             AND conrelid = to_regclass('public.kb_research_briefs') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_research_briefs" VALIDATE CONSTRAINT "fk_kb_research_briefs_org_space";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_sources') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_sources_org_space'
                     AND conrelid = to_regclass('public.kb_sources')) THEN
    ALTER TABLE "public"."kb_sources" ADD CONSTRAINT "fk_kb_sources_org_space" FOREIGN KEY (org_id, space_id) REFERENCES kb_spaces(org_id, id) ON DELETE SET NULL NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_sources_org_space'
             AND conrelid = to_regclass('public.kb_sources') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_sources" VALIDATE CONSTRAINT "fk_kb_sources_org_space";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_sources') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_sources_space_id_org'
                     AND conrelid = to_regclass('public.kb_sources')) THEN
    ALTER TABLE "public"."kb_sources" ADD CONSTRAINT "fk_kb_sources_space_id_org" FOREIGN KEY (org_id, space_id) REFERENCES kb_spaces(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_sources_space_id_org'
             AND conrelid = to_regclass('public.kb_sources') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_sources" VALIDATE CONSTRAINT "fk_kb_sources_space_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_space_members') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_space_members_org_space'
                     AND conrelid = to_regclass('public.kb_space_members')) THEN
    ALTER TABLE "public"."kb_space_members" ADD CONSTRAINT "fk_kb_space_members_org_space" FOREIGN KEY (org_id, space_id) REFERENCES kb_spaces(org_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_space_members_org_space'
             AND conrelid = to_regclass('public.kb_space_members') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_space_members" VALIDATE CONSTRAINT "fk_kb_space_members_org_space";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_space_members') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_space_members_space_id_org'
                     AND conrelid = to_regclass('public.kb_space_members')) THEN
    ALTER TABLE "public"."kb_space_members" ADD CONSTRAINT "fk_kb_space_members_space_id_org" FOREIGN KEY (org_id, space_id) REFERENCES kb_spaces(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_space_members_space_id_org'
             AND conrelid = to_regclass('public.kb_space_members') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_space_members" VALIDATE CONSTRAINT "fk_kb_space_members_space_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.key_results') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_key_results_goal_id_org'
                     AND conrelid = to_regclass('public.key_results')) THEN
    ALTER TABLE "public"."key_results" ADD CONSTRAINT "fk_key_results_goal_id_org" FOREIGN KEY (org_id, goal_id) REFERENCES goals(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_key_results_goal_id_org'
             AND conrelid = to_regclass('public.key_results') AND NOT convalidated) THEN
    ALTER TABLE "public"."key_results" VALIDATE CONSTRAINT "fk_key_results_goal_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.lead_activities') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_lead_activities_lead_id_org'
                     AND conrelid = to_regclass('public.lead_activities')) THEN
    ALTER TABLE "public"."lead_activities" ADD CONSTRAINT "fk_lead_activities_lead_id_org" FOREIGN KEY (org_id, lead_id) REFERENCES leads(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_lead_activities_lead_id_org'
             AND conrelid = to_regclass('public.lead_activities') AND NOT convalidated) THEN
    ALTER TABLE "public"."lead_activities" VALIDATE CONSTRAINT "fk_lead_activities_lead_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.lead_activities') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_lead_activities_lead_party_id'
                     AND conrelid = to_regclass('public.lead_activities')) THEN
    ALTER TABLE "public"."lead_activities" ADD CONSTRAINT "fk_lead_activities_lead_party_id" FOREIGN KEY (org_id, lead_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_lead_activities_lead_party_id'
             AND conrelid = to_regclass('public.lead_activities') AND NOT convalidated) THEN
    ALTER TABLE "public"."lead_activities" VALIDATE CONSTRAINT "fk_lead_activities_lead_party_id";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.lead_emails') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_lead_emails_lead_id_org'
                     AND conrelid = to_regclass('public.lead_emails')) THEN
    ALTER TABLE "public"."lead_emails" ADD CONSTRAINT "fk_lead_emails_lead_id_org" FOREIGN KEY (org_id, lead_id) REFERENCES leads(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_lead_emails_lead_id_org'
             AND conrelid = to_regclass('public.lead_emails') AND NOT convalidated) THEN
    ALTER TABLE "public"."lead_emails" VALIDATE CONSTRAINT "fk_lead_emails_lead_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.lead_emails') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_lead_emails_lead_party_id'
                     AND conrelid = to_regclass('public.lead_emails')) THEN
    ALTER TABLE "public"."lead_emails" ADD CONSTRAINT "fk_lead_emails_lead_party_id" FOREIGN KEY (org_id, lead_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_lead_emails_lead_party_id'
             AND conrelid = to_regclass('public.lead_emails') AND NOT convalidated) THEN
    ALTER TABLE "public"."lead_emails" VALIDATE CONSTRAINT "fk_lead_emails_lead_party_id";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.lead_notes') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_lead_notes_lead_id_org'
                     AND conrelid = to_regclass('public.lead_notes')) THEN
    ALTER TABLE "public"."lead_notes" ADD CONSTRAINT "fk_lead_notes_lead_id_org" FOREIGN KEY (org_id, lead_id) REFERENCES leads(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_lead_notes_lead_id_org'
             AND conrelid = to_regclass('public.lead_notes') AND NOT convalidated) THEN
    ALTER TABLE "public"."lead_notes" VALIDATE CONSTRAINT "fk_lead_notes_lead_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.lead_notes') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_lead_notes_lead_party_id'
                     AND conrelid = to_regclass('public.lead_notes')) THEN
    ALTER TABLE "public"."lead_notes" ADD CONSTRAINT "fk_lead_notes_lead_party_id" FOREIGN KEY (org_id, lead_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_lead_notes_lead_party_id'
             AND conrelid = to_regclass('public.lead_notes') AND NOT convalidated) THEN
    ALTER TABLE "public"."lead_notes" VALIDATE CONSTRAINT "fk_lead_notes_lead_party_id";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.lead_tasks') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_lead_tasks_lead_id_org'
                     AND conrelid = to_regclass('public.lead_tasks')) THEN
    ALTER TABLE "public"."lead_tasks" ADD CONSTRAINT "fk_lead_tasks_lead_id_org" FOREIGN KEY (org_id, lead_id) REFERENCES leads(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_lead_tasks_lead_id_org'
             AND conrelid = to_regclass('public.lead_tasks') AND NOT convalidated) THEN
    ALTER TABLE "public"."lead_tasks" VALIDATE CONSTRAINT "fk_lead_tasks_lead_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.lead_tasks') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_lead_tasks_lead_party_id'
                     AND conrelid = to_regclass('public.lead_tasks')) THEN
    ALTER TABLE "public"."lead_tasks" ADD CONSTRAINT "fk_lead_tasks_lead_party_id" FOREIGN KEY (org_id, lead_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_lead_tasks_lead_party_id'
             AND conrelid = to_regclass('public.lead_tasks') AND NOT convalidated) THEN
    ALTER TABLE "public"."lead_tasks" VALIDATE CONSTRAINT "fk_lead_tasks_lead_party_id";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.leads') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_leads_campaign_id_org'
                     AND conrelid = to_regclass('public.leads')) THEN
    ALTER TABLE "public"."leads" ADD CONSTRAINT "fk_leads_campaign_id_org" FOREIGN KEY (org_id, campaign_id) REFERENCES crm_campaigns(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_leads_campaign_id_org'
             AND conrelid = to_regclass('public.leads') AND NOT convalidated) THEN
    ALTER TABLE "public"."leads" VALIDATE CONSTRAINT "fk_leads_campaign_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.leads') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_leads_merged_into_id_org'
                     AND conrelid = to_regclass('public.leads')) THEN
    ALTER TABLE "public"."leads" ADD CONSTRAINT "fk_leads_merged_into_id_org" FOREIGN KEY (org_id, merged_into_id) REFERENCES leads(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_leads_merged_into_id_org'
             AND conrelid = to_regclass('public.leads') AND NOT convalidated) THEN
    ALTER TABLE "public"."leads" VALIDATE CONSTRAINT "fk_leads_merged_into_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.leave_balances') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_leave_balances_leave_type_id_org'
                     AND conrelid = to_regclass('public.leave_balances')) THEN
    ALTER TABLE "public"."leave_balances" ADD CONSTRAINT "fk_leave_balances_leave_type_id_org" FOREIGN KEY (org_id, leave_type_id) REFERENCES leave_types(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_leave_balances_leave_type_id_org'
             AND conrelid = to_regclass('public.leave_balances') AND NOT convalidated) THEN
    ALTER TABLE "public"."leave_balances" VALIDATE CONSTRAINT "fk_leave_balances_leave_type_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.leave_policies') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_leave_policies_leave_type_id_org'
                     AND conrelid = to_regclass('public.leave_policies')) THEN
    ALTER TABLE "public"."leave_policies" ADD CONSTRAINT "fk_leave_policies_leave_type_id_org" FOREIGN KEY (org_id, leave_type_id) REFERENCES leave_types(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_leave_policies_leave_type_id_org'
             AND conrelid = to_regclass('public.leave_policies') AND NOT convalidated) THEN
    ALTER TABLE "public"."leave_policies" VALIDATE CONSTRAINT "fk_leave_policies_leave_type_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.leave_requests') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_leave_requests_approver_actor'
                     AND conrelid = to_regclass('public.leave_requests')) THEN
    ALTER TABLE "public"."leave_requests" ADD CONSTRAINT "fk_leave_requests_approver_actor" FOREIGN KEY (org_id, approver_membership_id) REFERENCES organization_members(org_id, id) ON DELETE RESTRICT NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_leave_requests_approver_actor'
             AND conrelid = to_regclass('public.leave_requests') AND NOT convalidated) THEN
    ALTER TABLE "public"."leave_requests" VALIDATE CONSTRAINT "fk_leave_requests_approver_actor";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.leave_requests') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_leave_requests_leave_type_id_org'
                     AND conrelid = to_regclass('public.leave_requests')) THEN
    ALTER TABLE "public"."leave_requests" ADD CONSTRAINT "fk_leave_requests_leave_type_id_org" FOREIGN KEY (org_id, leave_type_id) REFERENCES leave_types(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_leave_requests_leave_type_id_org'
             AND conrelid = to_regclass('public.leave_requests') AND NOT convalidated) THEN
    ALTER TABLE "public"."leave_requests" VALIDATE CONSTRAINT "fk_leave_requests_leave_type_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.ledger_accounts') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ledger_accounts_parent_account_id_org'
                     AND conrelid = to_regclass('public.ledger_accounts')) THEN
    ALTER TABLE "public"."ledger_accounts" ADD CONSTRAINT "fk_ledger_accounts_parent_account_id_org" FOREIGN KEY (org_id, parent_account_id) REFERENCES ledger_accounts(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ledger_accounts_parent_account_id_org'
             AND conrelid = to_regclass('public.ledger_accounts') AND NOT convalidated) THEN
    ALTER TABLE "public"."ledger_accounts" VALIDATE CONSTRAINT "fk_ledger_accounts_parent_account_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.module_setup_checklist_items') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_module_setup_checklist_items_checklist_id_org'
                     AND conrelid = to_regclass('public.module_setup_checklist_items')) THEN
    ALTER TABLE "public"."module_setup_checklist_items" ADD CONSTRAINT "fk_module_setup_checklist_items_checklist_id_org" FOREIGN KEY (org_id, checklist_id) REFERENCES module_setup_checklists(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_module_setup_checklist_items_checklist_id_org'
             AND conrelid = to_regclass('public.module_setup_checklist_items') AND NOT convalidated) THEN
    ALTER TABLE "public"."module_setup_checklist_items" VALIDATE CONSTRAINT "fk_module_setup_checklist_items_checklist_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.nps_responses') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_nps_responses_client_account_id_org'
                     AND conrelid = to_regclass('public.nps_responses')) THEN
    ALTER TABLE "public"."nps_responses" ADD CONSTRAINT "fk_nps_responses_client_account_id_org" FOREIGN KEY (org_id, client_account_id) REFERENCES client_accounts(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_nps_responses_client_account_id_org'
             AND conrelid = to_regclass('public.nps_responses') AND NOT convalidated) THEN
    ALTER TABLE "public"."nps_responses" VALIDATE CONSTRAINT "fk_nps_responses_client_account_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.nps_responses') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_nps_responses_survey_id_org'
                     AND conrelid = to_regclass('public.nps_responses')) THEN
    ALTER TABLE "public"."nps_responses" ADD CONSTRAINT "fk_nps_responses_survey_id_org" FOREIGN KEY (org_id, survey_id) REFERENCES nps_surveys(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_nps_responses_survey_id_org'
             AND conrelid = to_regclass('public.nps_responses') AND NOT convalidated) THEN
    ALTER TABLE "public"."nps_responses" VALIDATE CONSTRAINT "fk_nps_responses_survey_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.offer_negotiations') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_offer_negotiations_offer_id_org'
                     AND conrelid = to_regclass('public.offer_negotiations')) THEN
    ALTER TABLE "public"."offer_negotiations" ADD CONSTRAINT "fk_offer_negotiations_offer_id_org" FOREIGN KEY (org_id, offer_id) REFERENCES candidate_offers(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_offer_negotiations_offer_id_org'
             AND conrelid = to_regclass('public.offer_negotiations') AND NOT convalidated) THEN
    ALTER TABLE "public"."offer_negotiations" VALIDATE CONSTRAINT "fk_offer_negotiations_offer_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.offer_versions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_offer_versions_offer_id_org'
                     AND conrelid = to_regclass('public.offer_versions')) THEN
    ALTER TABLE "public"."offer_versions" ADD CONSTRAINT "fk_offer_versions_offer_id_org" FOREIGN KEY (org_id, offer_id) REFERENCES candidate_offers(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_offer_versions_offer_id_org'
             AND conrelid = to_regclass('public.offer_versions') AND NOT convalidated) THEN
    ALTER TABLE "public"."offer_versions" VALIDATE CONSTRAINT "fk_offer_versions_offer_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.onboarding_documents') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_onboarding_documents_document_type_id_org'
                     AND conrelid = to_regclass('public.onboarding_documents')) THEN
    ALTER TABLE "public"."onboarding_documents" ADD CONSTRAINT "fk_onboarding_documents_document_type_id_org" FOREIGN KEY (org_id, document_type_id) REFERENCES document_types(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_onboarding_documents_document_type_id_org'
             AND conrelid = to_regclass('public.onboarding_documents') AND NOT convalidated) THEN
    ALTER TABLE "public"."onboarding_documents" VALIDATE CONSTRAINT "fk_onboarding_documents_document_type_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.onboarding_tasks') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_onboarding_tasks_template_step_id_org'
                     AND conrelid = to_regclass('public.onboarding_tasks')) THEN
    ALTER TABLE "public"."onboarding_tasks" ADD CONSTRAINT "fk_onboarding_tasks_template_step_id_org" FOREIGN KEY (org_id, template_step_id) REFERENCES onboarding_template_steps(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_onboarding_tasks_template_step_id_org'
             AND conrelid = to_regclass('public.onboarding_tasks') AND NOT convalidated) THEN
    ALTER TABLE "public"."onboarding_tasks" VALIDATE CONSTRAINT "fk_onboarding_tasks_template_step_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.onboarding_template_steps') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_onboarding_template_steps_template_id_org'
                     AND conrelid = to_regclass('public.onboarding_template_steps')) THEN
    ALTER TABLE "public"."onboarding_template_steps" ADD CONSTRAINT "fk_onboarding_template_steps_template_id_org" FOREIGN KEY (org_id, template_id) REFERENCES onboarding_templates(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_onboarding_template_steps_template_id_org'
             AND conrelid = to_regclass('public.onboarding_template_steps') AND NOT convalidated) THEN
    ALTER TABLE "public"."onboarding_template_steps" VALIDATE CONSTRAINT "fk_onboarding_template_steps_template_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.ownership_transfers') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ownership_transfers_initiator'
                     AND conrelid = to_regclass('public.ownership_transfers')) THEN
    ALTER TABLE "public"."ownership_transfers" ADD CONSTRAINT "fk_ownership_transfers_initiator" FOREIGN KEY (org_id, initiated_by_membership_id) REFERENCES organization_members(org_id, id) ON DELETE RESTRICT NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ownership_transfers_initiator'
             AND conrelid = to_regclass('public.ownership_transfers') AND NOT convalidated) THEN
    ALTER TABLE "public"."ownership_transfers" VALIDATE CONSTRAINT "fk_ownership_transfers_initiator";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.payment_audit_events') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payment_audit_events_provider_id_org'
                     AND conrelid = to_regclass('public.payment_audit_events')) THEN
    ALTER TABLE "public"."payment_audit_events" ADD CONSTRAINT "fk_payment_audit_events_provider_id_org" FOREIGN KEY (org_id, provider_id) REFERENCES payment_providers(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payment_audit_events_provider_id_org'
             AND conrelid = to_regclass('public.payment_audit_events') AND NOT convalidated) THEN
    ALTER TABLE "public"."payment_audit_events" VALIDATE CONSTRAINT "fk_payment_audit_events_provider_id_org";
  END IF;
END $$;
--> statement-breakpoint
