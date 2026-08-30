-- Composite tenant FKs, public schema, part 3 of 3.
--
-- Split by size, not by meaning: the purpose is identical across all four. §3 warns a ~2000-op monolith ECONNRESETs on Neon, and 635 constraints is ~1266 statements.
--
-- backend/CLAUDE.md §3: every tenant edge carries a composite tenant FK, and
-- "applied to the Neon branch" is not migrated. 635 of the 799 composite
-- same-tenant foreign keys on this database were applied by hand and exist in
-- no migration file, so a database rebuilt from migrations/ has no cross-tenant
-- referential integrity at all -- nothing stops a row referencing another
-- organisation's parent. This file authors 170 of them.
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
  IF to_regclass('public.payment_provider_accounts') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payment_provider_accounts_provider_id_org'
                     AND conrelid = to_regclass('public.payment_provider_accounts')) THEN
    ALTER TABLE "public"."payment_provider_accounts" ADD CONSTRAINT "fk_payment_provider_accounts_provider_id_org" FOREIGN KEY (org_id, provider_id) REFERENCES payment_providers(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payment_provider_accounts_provider_id_org'
             AND conrelid = to_regclass('public.payment_provider_accounts') AND NOT convalidated) THEN
    ALTER TABLE "public"."payment_provider_accounts" VALIDATE CONSTRAINT "fk_payment_provider_accounts_provider_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.payment_provider_credentials') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payment_provider_credentials_provider_id_org'
                     AND conrelid = to_regclass('public.payment_provider_credentials')) THEN
    ALTER TABLE "public"."payment_provider_credentials" ADD CONSTRAINT "fk_payment_provider_credentials_provider_id_org" FOREIGN KEY (org_id, provider_id) REFERENCES payment_providers(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payment_provider_credentials_provider_id_org'
             AND conrelid = to_regclass('public.payment_provider_credentials') AND NOT convalidated) THEN
    ALTER TABLE "public"."payment_provider_credentials" VALIDATE CONSTRAINT "fk_payment_provider_credentials_provider_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.payment_test_transactions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payment_test_transactions_provider_id_org'
                     AND conrelid = to_regclass('public.payment_test_transactions')) THEN
    ALTER TABLE "public"."payment_test_transactions" ADD CONSTRAINT "fk_payment_test_transactions_provider_id_org" FOREIGN KEY (org_id, provider_id) REFERENCES payment_providers(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payment_test_transactions_provider_id_org'
             AND conrelid = to_regclass('public.payment_test_transactions') AND NOT convalidated) THEN
    ALTER TABLE "public"."payment_test_transactions" VALIDATE CONSTRAINT "fk_payment_test_transactions_provider_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.payment_webhook_endpoints') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payment_webhook_endpoints_provider_id_org'
                     AND conrelid = to_regclass('public.payment_webhook_endpoints')) THEN
    ALTER TABLE "public"."payment_webhook_endpoints" ADD CONSTRAINT "fk_payment_webhook_endpoints_provider_id_org" FOREIGN KEY (org_id, provider_id) REFERENCES payment_providers(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payment_webhook_endpoints_provider_id_org'
             AND conrelid = to_regclass('public.payment_webhook_endpoints') AND NOT convalidated) THEN
    ALTER TABLE "public"."payment_webhook_endpoints" VALIDATE CONSTRAINT "fk_payment_webhook_endpoints_provider_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.payment_webhook_events') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payment_webhook_events_provider_id_org'
                     AND conrelid = to_regclass('public.payment_webhook_events')) THEN
    ALTER TABLE "public"."payment_webhook_events" ADD CONSTRAINT "fk_payment_webhook_events_provider_id_org" FOREIGN KEY (org_id, provider_id) REFERENCES payment_providers(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payment_webhook_events_provider_id_org'
             AND conrelid = to_regclass('public.payment_webhook_events') AND NOT convalidated) THEN
    ALTER TABLE "public"."payment_webhook_events" VALIDATE CONSTRAINT "fk_payment_webhook_events_provider_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.payments') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payments_invoice_id_org'
                     AND conrelid = to_regclass('public.payments')) THEN
    ALTER TABLE "public"."payments" ADD CONSTRAINT "fk_payments_invoice_id_org" FOREIGN KEY (org_id, invoice_id) REFERENCES invoices(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payments_invoice_id_org'
             AND conrelid = to_regclass('public.payments') AND NOT convalidated) THEN
    ALTER TABLE "public"."payments" VALIDATE CONSTRAINT "fk_payments_invoice_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.payroll_approvals') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_approvals_acted_actor'
                     AND conrelid = to_regclass('public.payroll_approvals')) THEN
    ALTER TABLE "public"."payroll_approvals" ADD CONSTRAINT "fk_payroll_approvals_acted_actor" FOREIGN KEY (org_id, acted_by_membership_id) REFERENCES organization_members(org_id, id) ON DELETE RESTRICT NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_approvals_acted_actor'
             AND conrelid = to_regclass('public.payroll_approvals') AND NOT convalidated) THEN
    ALTER TABLE "public"."payroll_approvals" VALIDATE CONSTRAINT "fk_payroll_approvals_acted_actor";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.payroll_approvals') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_approvals_run_id_org'
                     AND conrelid = to_regclass('public.payroll_approvals')) THEN
    ALTER TABLE "public"."payroll_approvals" ADD CONSTRAINT "fk_payroll_approvals_run_id_org" FOREIGN KEY (org_id, run_id) REFERENCES payroll_runs(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_approvals_run_id_org'
             AND conrelid = to_regclass('public.payroll_approvals') AND NOT convalidated) THEN
    ALTER TABLE "public"."payroll_approvals" VALIDATE CONSTRAINT "fk_payroll_approvals_run_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.payroll_bank_batch_items') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_bank_batch_items_batch_id_org'
                     AND conrelid = to_regclass('public.payroll_bank_batch_items')) THEN
    ALTER TABLE "public"."payroll_bank_batch_items" ADD CONSTRAINT "fk_payroll_bank_batch_items_batch_id_org" FOREIGN KEY (org_id, batch_id) REFERENCES payroll_bank_batches(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_bank_batch_items_batch_id_org'
             AND conrelid = to_regclass('public.payroll_bank_batch_items') AND NOT convalidated) THEN
    ALTER TABLE "public"."payroll_bank_batch_items" VALIDATE CONSTRAINT "fk_payroll_bank_batch_items_batch_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.payroll_bank_batch_items') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_bank_batch_items_run_employee_id_org'
                     AND conrelid = to_regclass('public.payroll_bank_batch_items')) THEN
    ALTER TABLE "public"."payroll_bank_batch_items" ADD CONSTRAINT "fk_payroll_bank_batch_items_run_employee_id_org" FOREIGN KEY (org_id, run_employee_id) REFERENCES payroll_run_employees(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_bank_batch_items_run_employee_id_org'
             AND conrelid = to_regclass('public.payroll_bank_batch_items') AND NOT convalidated) THEN
    ALTER TABLE "public"."payroll_bank_batch_items" VALIDATE CONSTRAINT "fk_payroll_bank_batch_items_run_employee_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.payroll_bank_batches') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_bank_batches_run_id_org'
                     AND conrelid = to_regclass('public.payroll_bank_batches')) THEN
    ALTER TABLE "public"."payroll_bank_batches" ADD CONSTRAINT "fk_payroll_bank_batches_run_id_org" FOREIGN KEY (org_id, run_id) REFERENCES payroll_runs(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_bank_batches_run_id_org'
             AND conrelid = to_regclass('public.payroll_bank_batches') AND NOT convalidated) THEN
    ALTER TABLE "public"."payroll_bank_batches" VALIDATE CONSTRAINT "fk_payroll_bank_batches_run_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.payroll_calendar_events') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_calendar_events_policy_id_org'
                     AND conrelid = to_regclass('public.payroll_calendar_events')) THEN
    ALTER TABLE "public"."payroll_calendar_events" ADD CONSTRAINT "fk_payroll_calendar_events_policy_id_org" FOREIGN KEY (org_id, policy_id) REFERENCES payroll_policies(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_calendar_events_policy_id_org'
             AND conrelid = to_regclass('public.payroll_calendar_events') AND NOT convalidated) THEN
    ALTER TABLE "public"."payroll_calendar_events" VALIDATE CONSTRAINT "fk_payroll_calendar_events_policy_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.payroll_command_receipts') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_command_receipts_run_id_org'
                     AND conrelid = to_regclass('public.payroll_command_receipts')) THEN
    ALTER TABLE "public"."payroll_command_receipts" ADD CONSTRAINT "fk_payroll_command_receipts_run_id_org" FOREIGN KEY (org_id, run_id) REFERENCES payroll_runs(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_command_receipts_run_id_org'
             AND conrelid = to_regclass('public.payroll_command_receipts') AND NOT convalidated) THEN
    ALTER TABLE "public"."payroll_command_receipts" VALIDATE CONSTRAINT "fk_payroll_command_receipts_run_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.payroll_exceptions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_exceptions_run_employee_id_org'
                     AND conrelid = to_regclass('public.payroll_exceptions')) THEN
    ALTER TABLE "public"."payroll_exceptions" ADD CONSTRAINT "fk_payroll_exceptions_run_employee_id_org" FOREIGN KEY (org_id, run_employee_id) REFERENCES payroll_run_employees(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_exceptions_run_employee_id_org'
             AND conrelid = to_regclass('public.payroll_exceptions') AND NOT convalidated) THEN
    ALTER TABLE "public"."payroll_exceptions" VALIDATE CONSTRAINT "fk_payroll_exceptions_run_employee_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.payroll_exceptions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_exceptions_run_id_org'
                     AND conrelid = to_regclass('public.payroll_exceptions')) THEN
    ALTER TABLE "public"."payroll_exceptions" ADD CONSTRAINT "fk_payroll_exceptions_run_id_org" FOREIGN KEY (org_id, run_id) REFERENCES payroll_runs(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_exceptions_run_id_org'
             AND conrelid = to_regclass('public.payroll_exceptions') AND NOT convalidated) THEN
    ALTER TABLE "public"."payroll_exceptions" VALIDATE CONSTRAINT "fk_payroll_exceptions_run_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.payroll_filings') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_filings_entity_id_org'
                     AND conrelid = to_regclass('public.payroll_filings')) THEN
    ALTER TABLE "public"."payroll_filings" ADD CONSTRAINT "fk_payroll_filings_entity_id_org" FOREIGN KEY (org_id, entity_id) REFERENCES payroll_entities(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_filings_entity_id_org'
             AND conrelid = to_regclass('public.payroll_filings') AND NOT convalidated) THEN
    ALTER TABLE "public"."payroll_filings" VALIDATE CONSTRAINT "fk_payroll_filings_entity_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.payroll_filings') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_filings_period_id_org'
                     AND conrelid = to_regclass('public.payroll_filings')) THEN
    ALTER TABLE "public"."payroll_filings" ADD CONSTRAINT "fk_payroll_filings_period_id_org" FOREIGN KEY (org_id, period_id) REFERENCES payroll_periods(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_filings_period_id_org'
             AND conrelid = to_regclass('public.payroll_filings') AND NOT convalidated) THEN
    ALTER TABLE "public"."payroll_filings" VALIDATE CONSTRAINT "fk_payroll_filings_period_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.payroll_inputs') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_inputs_run_id_org'
                     AND conrelid = to_regclass('public.payroll_inputs')) THEN
    ALTER TABLE "public"."payroll_inputs" ADD CONSTRAINT "fk_payroll_inputs_run_id_org" FOREIGN KEY (org_id, run_id) REFERENCES payroll_runs(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_inputs_run_id_org'
             AND conrelid = to_regclass('public.payroll_inputs') AND NOT convalidated) THEN
    ALTER TABLE "public"."payroll_inputs" VALIDATE CONSTRAINT "fk_payroll_inputs_run_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.payroll_jobs') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_jobs_entity_id_org'
                     AND conrelid = to_regclass('public.payroll_jobs')) THEN
    ALTER TABLE "public"."payroll_jobs" ADD CONSTRAINT "fk_payroll_jobs_entity_id_org" FOREIGN KEY (org_id, entity_id) REFERENCES payroll_entities(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_jobs_entity_id_org'
             AND conrelid = to_regclass('public.payroll_jobs') AND NOT convalidated) THEN
    ALTER TABLE "public"."payroll_jobs" VALIDATE CONSTRAINT "fk_payroll_jobs_entity_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.payroll_journal_batch_lines') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_journal_batch_lines_batch_id_org'
                     AND conrelid = to_regclass('public.payroll_journal_batch_lines')) THEN
    ALTER TABLE "public"."payroll_journal_batch_lines" ADD CONSTRAINT "fk_payroll_journal_batch_lines_batch_id_org" FOREIGN KEY (org_id, batch_id) REFERENCES payroll_journal_batches(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_journal_batch_lines_batch_id_org'
             AND conrelid = to_regclass('public.payroll_journal_batch_lines') AND NOT convalidated) THEN
    ALTER TABLE "public"."payroll_journal_batch_lines" VALIDATE CONSTRAINT "fk_payroll_journal_batch_lines_batch_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.payroll_journal_batches') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_journal_batches_entity_id_org'
                     AND conrelid = to_regclass('public.payroll_journal_batches')) THEN
    ALTER TABLE "public"."payroll_journal_batches" ADD CONSTRAINT "fk_payroll_journal_batches_entity_id_org" FOREIGN KEY (org_id, entity_id) REFERENCES payroll_entities(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_journal_batches_entity_id_org'
             AND conrelid = to_regclass('public.payroll_journal_batches') AND NOT convalidated) THEN
    ALTER TABLE "public"."payroll_journal_batches" VALIDATE CONSTRAINT "fk_payroll_journal_batches_entity_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.payroll_journal_batches') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_journal_batches_reversal_of_batch_id_org'
                     AND conrelid = to_regclass('public.payroll_journal_batches')) THEN
    ALTER TABLE "public"."payroll_journal_batches" ADD CONSTRAINT "fk_payroll_journal_batches_reversal_of_batch_id_org" FOREIGN KEY (org_id, reversal_of_batch_id) REFERENCES payroll_journal_batches(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_journal_batches_reversal_of_batch_id_org'
             AND conrelid = to_regclass('public.payroll_journal_batches') AND NOT convalidated) THEN
    ALTER TABLE "public"."payroll_journal_batches" VALIDATE CONSTRAINT "fk_payroll_journal_batches_reversal_of_batch_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.payroll_journal_batches') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_journal_batches_run_id_org'
                     AND conrelid = to_regclass('public.payroll_journal_batches')) THEN
    ALTER TABLE "public"."payroll_journal_batches" ADD CONSTRAINT "fk_payroll_journal_batches_run_id_org" FOREIGN KEY (org_id, run_id) REFERENCES payroll_runs(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_journal_batches_run_id_org'
             AND conrelid = to_regclass('public.payroll_journal_batches') AND NOT convalidated) THEN
    ALTER TABLE "public"."payroll_journal_batches" VALIDATE CONSTRAINT "fk_payroll_journal_batches_run_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.payroll_line_items') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_line_items_run_employee_id_org'
                     AND conrelid = to_regclass('public.payroll_line_items')) THEN
    ALTER TABLE "public"."payroll_line_items" ADD CONSTRAINT "fk_payroll_line_items_run_employee_id_org" FOREIGN KEY (org_id, run_employee_id) REFERENCES payroll_run_employees(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_line_items_run_employee_id_org'
             AND conrelid = to_regclass('public.payroll_line_items') AND NOT convalidated) THEN
    ALTER TABLE "public"."payroll_line_items" VALIDATE CONSTRAINT "fk_payroll_line_items_run_employee_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.payroll_line_items') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_line_items_run_id_org'
                     AND conrelid = to_regclass('public.payroll_line_items')) THEN
    ALTER TABLE "public"."payroll_line_items" ADD CONSTRAINT "fk_payroll_line_items_run_id_org" FOREIGN KEY (org_id, run_id) REFERENCES payroll_runs(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_line_items_run_id_org'
             AND conrelid = to_regclass('public.payroll_line_items') AND NOT convalidated) THEN
    ALTER TABLE "public"."payroll_line_items" VALIDATE CONSTRAINT "fk_payroll_line_items_run_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.payroll_loan_adjustments') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_loan_adjustments_loan_id_org'
                     AND conrelid = to_regclass('public.payroll_loan_adjustments')) THEN
    ALTER TABLE "public"."payroll_loan_adjustments" ADD CONSTRAINT "fk_payroll_loan_adjustments_loan_id_org" FOREIGN KEY (org_id, loan_id) REFERENCES salary_loans(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_loan_adjustments_loan_id_org'
             AND conrelid = to_regclass('public.payroll_loan_adjustments') AND NOT convalidated) THEN
    ALTER TABLE "public"."payroll_loan_adjustments" VALIDATE CONSTRAINT "fk_payroll_loan_adjustments_loan_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.payroll_loan_adjustments') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_loan_adjustments_run_id_org'
                     AND conrelid = to_regclass('public.payroll_loan_adjustments')) THEN
    ALTER TABLE "public"."payroll_loan_adjustments" ADD CONSTRAINT "fk_payroll_loan_adjustments_run_id_org" FOREIGN KEY (org_id, run_id) REFERENCES payroll_runs(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_loan_adjustments_run_id_org'
             AND conrelid = to_regclass('public.payroll_loan_adjustments') AND NOT convalidated) THEN
    ALTER TABLE "public"."payroll_loan_adjustments" VALIDATE CONSTRAINT "fk_payroll_loan_adjustments_run_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.payroll_periods') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_periods_entity_id_org'
                     AND conrelid = to_regclass('public.payroll_periods')) THEN
    ALTER TABLE "public"."payroll_periods" ADD CONSTRAINT "fk_payroll_periods_entity_id_org" FOREIGN KEY (org_id, entity_id) REFERENCES payroll_entities(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_periods_entity_id_org'
             AND conrelid = to_regclass('public.payroll_periods') AND NOT convalidated) THEN
    ALTER TABLE "public"."payroll_periods" VALIDATE CONSTRAINT "fk_payroll_periods_entity_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.payroll_policy_versions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_policy_versions_policy_id_org'
                     AND conrelid = to_regclass('public.payroll_policy_versions')) THEN
    ALTER TABLE "public"."payroll_policy_versions" ADD CONSTRAINT "fk_payroll_policy_versions_policy_id_org" FOREIGN KEY (org_id, policy_id) REFERENCES payroll_policies(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_policy_versions_policy_id_org'
             AND conrelid = to_regclass('public.payroll_policy_versions') AND NOT convalidated) THEN
    ALTER TABLE "public"."payroll_policy_versions" VALIDATE CONSTRAINT "fk_payroll_policy_versions_policy_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.payroll_run_employees') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_run_employees_run_id_org'
                     AND conrelid = to_regclass('public.payroll_run_employees')) THEN
    ALTER TABLE "public"."payroll_run_employees" ADD CONSTRAINT "fk_payroll_run_employees_run_id_org" FOREIGN KEY (org_id, run_id) REFERENCES payroll_runs(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_run_employees_run_id_org'
             AND conrelid = to_regclass('public.payroll_run_employees') AND NOT convalidated) THEN
    ALTER TABLE "public"."payroll_run_employees" VALIDATE CONSTRAINT "fk_payroll_run_employees_run_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.payroll_run_events') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_run_events_run_id_org'
                     AND conrelid = to_regclass('public.payroll_run_events')) THEN
    ALTER TABLE "public"."payroll_run_events" ADD CONSTRAINT "fk_payroll_run_events_run_id_org" FOREIGN KEY (org_id, run_id) REFERENCES payroll_runs(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_run_events_run_id_org'
             AND conrelid = to_regclass('public.payroll_run_events') AND NOT convalidated) THEN
    ALTER TABLE "public"."payroll_run_events" VALIDATE CONSTRAINT "fk_payroll_run_events_run_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.payroll_runs') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_runs_approved_actor'
                     AND conrelid = to_regclass('public.payroll_runs')) THEN
    ALTER TABLE "public"."payroll_runs" ADD CONSTRAINT "fk_payroll_runs_approved_actor" FOREIGN KEY (org_id, approved_by_membership_id) REFERENCES organization_members(org_id, id) ON DELETE RESTRICT NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_runs_approved_actor'
             AND conrelid = to_regclass('public.payroll_runs') AND NOT convalidated) THEN
    ALTER TABLE "public"."payroll_runs" VALIDATE CONSTRAINT "fk_payroll_runs_approved_actor";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.payroll_runs') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_runs_policy_version_id_org'
                     AND conrelid = to_regclass('public.payroll_runs')) THEN
    ALTER TABLE "public"."payroll_runs" ADD CONSTRAINT "fk_payroll_runs_policy_version_id_org" FOREIGN KEY (org_id, policy_version_id) REFERENCES payroll_policy_versions(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_runs_policy_version_id_org'
             AND conrelid = to_regclass('public.payroll_runs') AND NOT convalidated) THEN
    ALTER TABLE "public"."payroll_runs" VALIDATE CONSTRAINT "fk_payroll_runs_policy_version_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.payroll_template_activations') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_template_activations_policy_version_id_org'
                     AND conrelid = to_regclass('public.payroll_template_activations')) THEN
    ALTER TABLE "public"."payroll_template_activations" ADD CONSTRAINT "fk_payroll_template_activations_policy_version_id_org" FOREIGN KEY (org_id, policy_version_id) REFERENCES payroll_policy_versions(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_template_activations_policy_version_id_org'
             AND conrelid = to_regclass('public.payroll_template_activations') AND NOT convalidated) THEN
    ALTER TABLE "public"."payroll_template_activations" VALIDATE CONSTRAINT "fk_payroll_template_activations_policy_version_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.payslip_publications') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payslip_publications_payslip_template_id_org'
                     AND conrelid = to_regclass('public.payslip_publications')) THEN
    ALTER TABLE "public"."payslip_publications" ADD CONSTRAINT "fk_payslip_publications_payslip_template_id_org" FOREIGN KEY (org_id, payslip_template_id) REFERENCES payslip_templates(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payslip_publications_payslip_template_id_org'
             AND conrelid = to_regclass('public.payslip_publications') AND NOT convalidated) THEN
    ALTER TABLE "public"."payslip_publications" VALIDATE CONSTRAINT "fk_payslip_publications_payslip_template_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.payslip_publications') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payslip_publications_run_employee_id_org'
                     AND conrelid = to_regclass('public.payslip_publications')) THEN
    ALTER TABLE "public"."payslip_publications" ADD CONSTRAINT "fk_payslip_publications_run_employee_id_org" FOREIGN KEY (org_id, run_employee_id) REFERENCES payroll_run_employees(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payslip_publications_run_employee_id_org'
             AND conrelid = to_regclass('public.payslip_publications') AND NOT convalidated) THEN
    ALTER TABLE "public"."payslip_publications" VALIDATE CONSTRAINT "fk_payslip_publications_run_employee_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.payslip_publications') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payslip_publications_run_id_org'
                     AND conrelid = to_regclass('public.payslip_publications')) THEN
    ALTER TABLE "public"."payslip_publications" ADD CONSTRAINT "fk_payslip_publications_run_id_org" FOREIGN KEY (org_id, run_id) REFERENCES payroll_runs(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payslip_publications_run_id_org'
             AND conrelid = to_regclass('public.payslip_publications') AND NOT convalidated) THEN
    ALTER TABLE "public"."payslip_publications" VALIDATE CONSTRAINT "fk_payslip_publications_run_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.performance_reviews') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_performance_reviews_cycle_id_org'
                     AND conrelid = to_regclass('public.performance_reviews')) THEN
    ALTER TABLE "public"."performance_reviews" ADD CONSTRAINT "fk_performance_reviews_cycle_id_org" FOREIGN KEY (org_id, cycle_id) REFERENCES review_cycles(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_performance_reviews_cycle_id_org'
             AND conrelid = to_regclass('public.performance_reviews') AND NOT convalidated) THEN
    ALTER TABLE "public"."performance_reviews" VALIDATE CONSTRAINT "fk_performance_reviews_cycle_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.performance_reviews') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_performance_reviews_reviewer_actor'
                     AND conrelid = to_regclass('public.performance_reviews')) THEN
    ALTER TABLE "public"."performance_reviews" ADD CONSTRAINT "fk_performance_reviews_reviewer_actor" FOREIGN KEY (org_id, reviewer_membership_id) REFERENCES organization_members(org_id, id) ON DELETE RESTRICT NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_performance_reviews_reviewer_actor'
             AND conrelid = to_regclass('public.performance_reviews') AND NOT convalidated) THEN
    ALTER TABLE "public"."performance_reviews" VALIDATE CONSTRAINT "fk_performance_reviews_reviewer_actor";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.policy_acknowledgments') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_policy_acknowledgments_document_id_org'
                     AND conrelid = to_regclass('public.policy_acknowledgments')) THEN
    ALTER TABLE "public"."policy_acknowledgments" ADD CONSTRAINT "fk_policy_acknowledgments_document_id_org" FOREIGN KEY (org_id, document_id) REFERENCES documents(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_policy_acknowledgments_document_id_org'
             AND conrelid = to_regclass('public.policy_acknowledgments') AND NOT convalidated) THEN
    ALTER TABLE "public"."policy_acknowledgments" VALIDATE CONSTRAINT "fk_policy_acknowledgments_document_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.principal_group_members') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'principal_group_members_org_id_organization_membership_id_fkey'
                     AND conrelid = to_regclass('public.principal_group_members')) THEN
    ALTER TABLE "public"."principal_group_members" ADD CONSTRAINT "principal_group_members_org_id_organization_membership_id_fkey" FOREIGN KEY (org_id, organization_membership_id) REFERENCES organization_members(org_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'principal_group_members_org_id_organization_membership_id_fkey'
             AND conrelid = to_regclass('public.principal_group_members') AND NOT convalidated) THEN
    ALTER TABLE "public"."principal_group_members" VALIDATE CONSTRAINT "principal_group_members_org_id_organization_membership_id_fkey";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.purchase_bill_items') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_purchase_bill_items_bill_id_org'
                     AND conrelid = to_regclass('public.purchase_bill_items')) THEN
    ALTER TABLE "public"."purchase_bill_items" ADD CONSTRAINT "fk_purchase_bill_items_bill_id_org" FOREIGN KEY (org_id, bill_id) REFERENCES purchase_bills(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_purchase_bill_items_bill_id_org'
             AND conrelid = to_regclass('public.purchase_bill_items') AND NOT convalidated) THEN
    ALTER TABLE "public"."purchase_bill_items" VALIDATE CONSTRAINT "fk_purchase_bill_items_bill_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.purchase_bills') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_purchase_bills_vendor_id_org'
                     AND conrelid = to_regclass('public.purchase_bills')) THEN
    ALTER TABLE "public"."purchase_bills" ADD CONSTRAINT "fk_purchase_bills_vendor_id_org" FOREIGN KEY (org_id, vendor_id) REFERENCES clients(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_purchase_bills_vendor_id_org'
             AND conrelid = to_regclass('public.purchase_bills') AND NOT convalidated) THEN
    ALTER TABLE "public"."purchase_bills" VALIDATE CONSTRAINT "fk_purchase_bills_vendor_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.purchase_bills') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_purchase_bills_vendor_party_id'
                     AND conrelid = to_regclass('public.purchase_bills')) THEN
    ALTER TABLE "public"."purchase_bills" ADD CONSTRAINT "fk_purchase_bills_vendor_party_id" FOREIGN KEY (org_id, vendor_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_purchase_bills_vendor_party_id'
             AND conrelid = to_regclass('public.purchase_bills') AND NOT convalidated) THEN
    ALTER TABLE "public"."purchase_bills" VALIDATE CONSTRAINT "fk_purchase_bills_vendor_party_id";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.quote_line_items') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_quote_line_items_quote_id_org'
                     AND conrelid = to_regclass('public.quote_line_items')) THEN
    ALTER TABLE "public"."quote_line_items" ADD CONSTRAINT "fk_quote_line_items_quote_id_org" FOREIGN KEY (org_id, quote_id) REFERENCES quotes(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_quote_line_items_quote_id_org'
             AND conrelid = to_regclass('public.quote_line_items') AND NOT convalidated) THEN
    ALTER TABLE "public"."quote_line_items" VALIDATE CONSTRAINT "fk_quote_line_items_quote_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.quotes') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_quotes_client_id_org'
                     AND conrelid = to_regclass('public.quotes')) THEN
    ALTER TABLE "public"."quotes" ADD CONSTRAINT "fk_quotes_client_id_org" FOREIGN KEY (org_id, client_id) REFERENCES client_accounts(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_quotes_client_id_org'
             AND conrelid = to_regclass('public.quotes') AND NOT convalidated) THEN
    ALTER TABLE "public"."quotes" VALIDATE CONSTRAINT "fk_quotes_client_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.quotes') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_quotes_converted_invoice_id_org'
                     AND conrelid = to_regclass('public.quotes')) THEN
    ALTER TABLE "public"."quotes" ADD CONSTRAINT "fk_quotes_converted_invoice_id_org" FOREIGN KEY (org_id, converted_invoice_id) REFERENCES invoices(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_quotes_converted_invoice_id_org'
             AND conrelid = to_regclass('public.quotes') AND NOT convalidated) THEN
    ALTER TABLE "public"."quotes" VALIDATE CONSTRAINT "fk_quotes_converted_invoice_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.quotes') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_quotes_deal_id_org'
                     AND conrelid = to_regclass('public.quotes')) THEN
    ALTER TABLE "public"."quotes" ADD CONSTRAINT "fk_quotes_deal_id_org" FOREIGN KEY (org_id, deal_id) REFERENCES deals(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_quotes_deal_id_org'
             AND conrelid = to_regclass('public.quotes') AND NOT convalidated) THEN
    ALTER TABLE "public"."quotes" VALIDATE CONSTRAINT "fk_quotes_deal_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.recruiter_activity_log') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_recruiter_activity_log_candidate_id_org'
                     AND conrelid = to_regclass('public.recruiter_activity_log')) THEN
    ALTER TABLE "public"."recruiter_activity_log" ADD CONSTRAINT "fk_recruiter_activity_log_candidate_id_org" FOREIGN KEY (org_id, candidate_id) REFERENCES candidates(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_recruiter_activity_log_candidate_id_org'
             AND conrelid = to_regclass('public.recruiter_activity_log') AND NOT convalidated) THEN
    ALTER TABLE "public"."recruiter_activity_log" VALIDATE CONSTRAINT "fk_recruiter_activity_log_candidate_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.recruiter_activity_log') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_recruiter_activity_log_job_posting_id_org'
                     AND conrelid = to_regclass('public.recruiter_activity_log')) THEN
    ALTER TABLE "public"."recruiter_activity_log" ADD CONSTRAINT "fk_recruiter_activity_log_job_posting_id_org" FOREIGN KEY (org_id, job_posting_id) REFERENCES job_postings(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_recruiter_activity_log_job_posting_id_org'
             AND conrelid = to_regclass('public.recruiter_activity_log') AND NOT convalidated) THEN
    ALTER TABLE "public"."recruiter_activity_log" VALIDATE CONSTRAINT "fk_recruiter_activity_log_job_posting_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.reimbursements') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_reimbursements_approved_actor'
                     AND conrelid = to_regclass('public.reimbursements')) THEN
    ALTER TABLE "public"."reimbursements" ADD CONSTRAINT "fk_reimbursements_approved_actor" FOREIGN KEY (org_id, approved_by_membership_id) REFERENCES organization_members(org_id, id) ON DELETE RESTRICT NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_reimbursements_approved_actor'
             AND conrelid = to_regclass('public.reimbursements') AND NOT convalidated) THEN
    ALTER TABLE "public"."reimbursements" VALIDATE CONSTRAINT "fk_reimbursements_approved_actor";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.review_cycles') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_review_cycles_template_id_org'
                     AND conrelid = to_regclass('public.review_cycles')) THEN
    ALTER TABLE "public"."review_cycles" ADD CONSTRAINT "fk_review_cycles_template_id_org" FOREIGN KEY (org_id, template_id) REFERENCES hr_templates(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_review_cycles_template_id_org'
             AND conrelid = to_regclass('public.review_cycles') AND NOT convalidated) THEN
    ALTER TABLE "public"."review_cycles" VALIDATE CONSTRAINT "fk_review_cycles_template_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.role_assignments') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_role_assignments_assigner_membership'
                     AND conrelid = to_regclass('public.role_assignments')) THEN
    ALTER TABLE "public"."role_assignments" ADD CONSTRAINT "fk_role_assignments_assigner_membership" FOREIGN KEY (org_id, assigned_by_membership_id) REFERENCES organization_members(org_id, id) ON DELETE SET NULL (assigned_by_membership_id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_role_assignments_assigner_membership'
             AND conrelid = to_regclass('public.role_assignments') AND NOT convalidated) THEN
    ALTER TABLE "public"."role_assignments" VALIDATE CONSTRAINT "fk_role_assignments_assigner_membership";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.role_permission_grants') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_role_permission_grants_role_id_org'
                     AND conrelid = to_regclass('public.role_permission_grants')) THEN
    ALTER TABLE "public"."role_permission_grants" ADD CONSTRAINT "fk_role_permission_grants_role_id_org" FOREIGN KEY (org_id, role_id) REFERENCES roles(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_role_permission_grants_role_id_org'
             AND conrelid = to_regclass('public.role_permission_grants') AND NOT convalidated) THEN
    ALTER TABLE "public"."role_permission_grants" VALIDATE CONSTRAINT "fk_role_permission_grants_role_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.roster_entries') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_roster_entries_roster_id_org'
                     AND conrelid = to_regclass('public.roster_entries')) THEN
    ALTER TABLE "public"."roster_entries" ADD CONSTRAINT "fk_roster_entries_roster_id_org" FOREIGN KEY (org_id, roster_id) REFERENCES rosters(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_roster_entries_roster_id_org'
             AND conrelid = to_regclass('public.roster_entries') AND NOT convalidated) THEN
    ALTER TABLE "public"."roster_entries" VALIDATE CONSTRAINT "fk_roster_entries_roster_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.roster_entries') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_roster_entries_shift_id_org'
                     AND conrelid = to_regclass('public.roster_entries')) THEN
    ALTER TABLE "public"."roster_entries" ADD CONSTRAINT "fk_roster_entries_shift_id_org" FOREIGN KEY (org_id, shift_id) REFERENCES shift_templates(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_roster_entries_shift_id_org'
             AND conrelid = to_regclass('public.roster_entries') AND NOT convalidated) THEN
    ALTER TABLE "public"."roster_entries" VALIDATE CONSTRAINT "fk_roster_entries_shift_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.sign_audit_events') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_audit_events_envelope_id_org'
                     AND conrelid = to_regclass('public.sign_audit_events')) THEN
    ALTER TABLE "public"."sign_audit_events" ADD CONSTRAINT "fk_sign_audit_events_envelope_id_org" FOREIGN KEY (org_id, envelope_id) REFERENCES sign_envelopes(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_audit_events_envelope_id_org'
             AND conrelid = to_regclass('public.sign_audit_events') AND NOT convalidated) THEN
    ALTER TABLE "public"."sign_audit_events" VALIDATE CONSTRAINT "fk_sign_audit_events_envelope_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.sign_audit_events') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_audit_events_recipient_id_org'
                     AND conrelid = to_regclass('public.sign_audit_events')) THEN
    ALTER TABLE "public"."sign_audit_events" ADD CONSTRAINT "fk_sign_audit_events_recipient_id_org" FOREIGN KEY (org_id, recipient_id) REFERENCES sign_recipients(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_audit_events_recipient_id_org'
             AND conrelid = to_regclass('public.sign_audit_events') AND NOT convalidated) THEN
    ALTER TABLE "public"."sign_audit_events" VALIDATE CONSTRAINT "fk_sign_audit_events_recipient_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.sign_bulk_send_jobs') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_bulk_send_jobs_template_id_org'
                     AND conrelid = to_regclass('public.sign_bulk_send_jobs')) THEN
    ALTER TABLE "public"."sign_bulk_send_jobs" ADD CONSTRAINT "fk_sign_bulk_send_jobs_template_id_org" FOREIGN KEY (org_id, template_id) REFERENCES sign_templates(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_bulk_send_jobs_template_id_org'
             AND conrelid = to_regclass('public.sign_bulk_send_jobs') AND NOT convalidated) THEN
    ALTER TABLE "public"."sign_bulk_send_jobs" VALIDATE CONSTRAINT "fk_sign_bulk_send_jobs_template_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.sign_bulk_send_rows') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_bulk_send_rows_envelope_id_org'
                     AND conrelid = to_regclass('public.sign_bulk_send_rows')) THEN
    ALTER TABLE "public"."sign_bulk_send_rows" ADD CONSTRAINT "fk_sign_bulk_send_rows_envelope_id_org" FOREIGN KEY (org_id, envelope_id) REFERENCES sign_envelopes(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_bulk_send_rows_envelope_id_org'
             AND conrelid = to_regclass('public.sign_bulk_send_rows') AND NOT convalidated) THEN
    ALTER TABLE "public"."sign_bulk_send_rows" VALIDATE CONSTRAINT "fk_sign_bulk_send_rows_envelope_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.sign_bulk_send_rows') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_bulk_send_rows_job_id_org'
                     AND conrelid = to_regclass('public.sign_bulk_send_rows')) THEN
    ALTER TABLE "public"."sign_bulk_send_rows" ADD CONSTRAINT "fk_sign_bulk_send_rows_job_id_org" FOREIGN KEY (org_id, job_id) REFERENCES sign_bulk_send_jobs(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_bulk_send_rows_job_id_org'
             AND conrelid = to_regclass('public.sign_bulk_send_rows') AND NOT convalidated) THEN
    ALTER TABLE "public"."sign_bulk_send_rows" VALIDATE CONSTRAINT "fk_sign_bulk_send_rows_job_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.sign_certificates') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_certificates_envelope_id_org'
                     AND conrelid = to_regclass('public.sign_certificates')) THEN
    ALTER TABLE "public"."sign_certificates" ADD CONSTRAINT "fk_sign_certificates_envelope_id_org" FOREIGN KEY (org_id, envelope_id) REFERENCES sign_envelopes(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_certificates_envelope_id_org'
             AND conrelid = to_regclass('public.sign_certificates') AND NOT convalidated) THEN
    ALTER TABLE "public"."sign_certificates" VALIDATE CONSTRAINT "fk_sign_certificates_envelope_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.sign_documents') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_documents_envelope_id_org'
                     AND conrelid = to_regclass('public.sign_documents')) THEN
    ALTER TABLE "public"."sign_documents" ADD CONSTRAINT "fk_sign_documents_envelope_id_org" FOREIGN KEY (org_id, envelope_id) REFERENCES sign_envelopes(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_documents_envelope_id_org'
             AND conrelid = to_regclass('public.sign_documents') AND NOT convalidated) THEN
    ALTER TABLE "public"."sign_documents" VALIDATE CONSTRAINT "fk_sign_documents_envelope_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.sign_envelopes') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_envelopes_public_form_id_org'
                     AND conrelid = to_regclass('public.sign_envelopes')) THEN
    ALTER TABLE "public"."sign_envelopes" ADD CONSTRAINT "fk_sign_envelopes_public_form_id_org" FOREIGN KEY (org_id, public_form_id) REFERENCES sign_public_forms(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_envelopes_public_form_id_org'
             AND conrelid = to_regclass('public.sign_envelopes') AND NOT convalidated) THEN
    ALTER TABLE "public"."sign_envelopes" VALIDATE CONSTRAINT "fk_sign_envelopes_public_form_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.sign_envelopes') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_envelopes_template_id_org'
                     AND conrelid = to_regclass('public.sign_envelopes')) THEN
    ALTER TABLE "public"."sign_envelopes" ADD CONSTRAINT "fk_sign_envelopes_template_id_org" FOREIGN KEY (org_id, template_id) REFERENCES sign_templates(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_envelopes_template_id_org'
             AND conrelid = to_regclass('public.sign_envelopes') AND NOT convalidated) THEN
    ALTER TABLE "public"."sign_envelopes" VALIDATE CONSTRAINT "fk_sign_envelopes_template_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.sign_envelopes') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_envelopes_watermark_policy_id_org'
                     AND conrelid = to_regclass('public.sign_envelopes')) THEN
    ALTER TABLE "public"."sign_envelopes" ADD CONSTRAINT "fk_sign_envelopes_watermark_policy_id_org" FOREIGN KEY (org_id, watermark_policy_id) REFERENCES sign_watermark_policies(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_envelopes_watermark_policy_id_org'
             AND conrelid = to_regclass('public.sign_envelopes') AND NOT convalidated) THEN
    ALTER TABLE "public"."sign_envelopes" VALIDATE CONSTRAINT "fk_sign_envelopes_watermark_policy_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.sign_fields') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_fields_document_id_org'
                     AND conrelid = to_regclass('public.sign_fields')) THEN
    ALTER TABLE "public"."sign_fields" ADD CONSTRAINT "fk_sign_fields_document_id_org" FOREIGN KEY (org_id, document_id) REFERENCES sign_documents(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_fields_document_id_org'
             AND conrelid = to_regclass('public.sign_fields') AND NOT convalidated) THEN
    ALTER TABLE "public"."sign_fields" VALIDATE CONSTRAINT "fk_sign_fields_document_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.sign_fields') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_fields_envelope_id_org'
                     AND conrelid = to_regclass('public.sign_fields')) THEN
    ALTER TABLE "public"."sign_fields" ADD CONSTRAINT "fk_sign_fields_envelope_id_org" FOREIGN KEY (org_id, envelope_id) REFERENCES sign_envelopes(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_fields_envelope_id_org'
             AND conrelid = to_regclass('public.sign_fields') AND NOT convalidated) THEN
    ALTER TABLE "public"."sign_fields" VALIDATE CONSTRAINT "fk_sign_fields_envelope_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.sign_fields') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_fields_recipient_id_org'
                     AND conrelid = to_regclass('public.sign_fields')) THEN
    ALTER TABLE "public"."sign_fields" ADD CONSTRAINT "fk_sign_fields_recipient_id_org" FOREIGN KEY (org_id, recipient_id) REFERENCES sign_recipients(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_fields_recipient_id_org'
             AND conrelid = to_regclass('public.sign_fields') AND NOT convalidated) THEN
    ALTER TABLE "public"."sign_fields" VALIDATE CONSTRAINT "fk_sign_fields_recipient_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.sign_public_forms') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_public_forms_template_id_org'
                     AND conrelid = to_regclass('public.sign_public_forms')) THEN
    ALTER TABLE "public"."sign_public_forms" ADD CONSTRAINT "fk_sign_public_forms_template_id_org" FOREIGN KEY (org_id, template_id) REFERENCES sign_templates(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_public_forms_template_id_org'
             AND conrelid = to_regclass('public.sign_public_forms') AND NOT convalidated) THEN
    ALTER TABLE "public"."sign_public_forms" VALIDATE CONSTRAINT "fk_sign_public_forms_template_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.sign_recipients') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_recipients_envelope_id_org'
                     AND conrelid = to_regclass('public.sign_recipients')) THEN
    ALTER TABLE "public"."sign_recipients" ADD CONSTRAINT "fk_sign_recipients_envelope_id_org" FOREIGN KEY (org_id, envelope_id) REFERENCES sign_envelopes(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_recipients_envelope_id_org'
             AND conrelid = to_regclass('public.sign_recipients') AND NOT convalidated) THEN
    ALTER TABLE "public"."sign_recipients" VALIDATE CONSTRAINT "fk_sign_recipients_envelope_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.sign_signature_assets') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_signature_assets_envelope_id_org'
                     AND conrelid = to_regclass('public.sign_signature_assets')) THEN
    ALTER TABLE "public"."sign_signature_assets" ADD CONSTRAINT "fk_sign_signature_assets_envelope_id_org" FOREIGN KEY (org_id, envelope_id) REFERENCES sign_envelopes(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_signature_assets_envelope_id_org'
             AND conrelid = to_regclass('public.sign_signature_assets') AND NOT convalidated) THEN
    ALTER TABLE "public"."sign_signature_assets" VALIDATE CONSTRAINT "fk_sign_signature_assets_envelope_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.sign_signature_assets') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_signature_assets_recipient_id_org'
                     AND conrelid = to_regclass('public.sign_signature_assets')) THEN
    ALTER TABLE "public"."sign_signature_assets" ADD CONSTRAINT "fk_sign_signature_assets_recipient_id_org" FOREIGN KEY (org_id, recipient_id) REFERENCES sign_recipients(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sign_signature_assets_recipient_id_org'
             AND conrelid = to_regclass('public.sign_signature_assets') AND NOT convalidated) THEN
    ALTER TABLE "public"."sign_signature_assets" VALIDATE CONSTRAINT "fk_sign_signature_assets_recipient_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.subscription_payments') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_subscription_payments_subscription_id_org'
                     AND conrelid = to_regclass('public.subscription_payments')) THEN
    ALTER TABLE "public"."subscription_payments" ADD CONSTRAINT "fk_subscription_payments_subscription_id_org" FOREIGN KEY (org_id, subscription_id) REFERENCES subscriptions(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_subscription_payments_subscription_id_org'
             AND conrelid = to_regclass('public.subscription_payments') AND NOT convalidated) THEN
    ALTER TABLE "public"."subscription_payments" VALIDATE CONSTRAINT "fk_subscription_payments_subscription_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.support_ai_suggestions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_support_ai_suggestions_ticket_id_org'
                     AND conrelid = to_regclass('public.support_ai_suggestions')) THEN
    ALTER TABLE "public"."support_ai_suggestions" ADD CONSTRAINT "fk_support_ai_suggestions_ticket_id_org" FOREIGN KEY (org_id, ticket_id) REFERENCES support_tickets(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_support_ai_suggestions_ticket_id_org'
             AND conrelid = to_regclass('public.support_ai_suggestions') AND NOT convalidated) THEN
    ALTER TABLE "public"."support_ai_suggestions" VALIDATE CONSTRAINT "fk_support_ai_suggestions_ticket_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.support_csat_requests') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_support_csat_requests_ticket_id_org'
                     AND conrelid = to_regclass('public.support_csat_requests')) THEN
    ALTER TABLE "public"."support_csat_requests" ADD CONSTRAINT "fk_support_csat_requests_ticket_id_org" FOREIGN KEY (org_id, ticket_id) REFERENCES support_tickets(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_support_csat_requests_ticket_id_org'
             AND conrelid = to_regclass('public.support_csat_requests') AND NOT convalidated) THEN
    ALTER TABLE "public"."support_csat_requests" VALIDATE CONSTRAINT "fk_support_csat_requests_ticket_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.support_knowledge_gaps') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_support_knowledge_gaps_proposed_article_id_org'
                     AND conrelid = to_regclass('public.support_knowledge_gaps')) THEN
    ALTER TABLE "public"."support_knowledge_gaps" ADD CONSTRAINT "fk_support_knowledge_gaps_proposed_article_id_org" FOREIGN KEY (org_id, proposed_article_id) REFERENCES kb_articles(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_support_knowledge_gaps_proposed_article_id_org'
             AND conrelid = to_regclass('public.support_knowledge_gaps') AND NOT convalidated) THEN
    ALTER TABLE "public"."support_knowledge_gaps" VALIDATE CONSTRAINT "fk_support_knowledge_gaps_proposed_article_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.support_message_mentions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_support_message_mentions_message_id_org'
                     AND conrelid = to_regclass('public.support_message_mentions')) THEN
    ALTER TABLE "public"."support_message_mentions" ADD CONSTRAINT "fk_support_message_mentions_message_id_org" FOREIGN KEY (org_id, message_id) REFERENCES support_ticket_messages(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_support_message_mentions_message_id_org'
             AND conrelid = to_regclass('public.support_message_mentions') AND NOT convalidated) THEN
    ALTER TABLE "public"."support_message_mentions" VALIDATE CONSTRAINT "fk_support_message_mentions_message_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.support_ticket_activity') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_support_ticket_activity_support_ticket_id_org'
                     AND conrelid = to_regclass('public.support_ticket_activity')) THEN
    ALTER TABLE "public"."support_ticket_activity" ADD CONSTRAINT "fk_support_ticket_activity_support_ticket_id_org" FOREIGN KEY (org_id, support_ticket_id) REFERENCES support_tickets(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_support_ticket_activity_support_ticket_id_org'
             AND conrelid = to_regclass('public.support_ticket_activity') AND NOT convalidated) THEN
    ALTER TABLE "public"."support_ticket_activity" VALIDATE CONSTRAINT "fk_support_ticket_activity_support_ticket_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.support_ticket_drafts') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_support_ticket_drafts_ticket_id_org'
                     AND conrelid = to_regclass('public.support_ticket_drafts')) THEN
    ALTER TABLE "public"."support_ticket_drafts" ADD CONSTRAINT "fk_support_ticket_drafts_ticket_id_org" FOREIGN KEY (org_id, ticket_id) REFERENCES support_tickets(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_support_ticket_drafts_ticket_id_org'
             AND conrelid = to_regclass('public.support_ticket_drafts') AND NOT convalidated) THEN
    ALTER TABLE "public"."support_ticket_drafts" VALIDATE CONSTRAINT "fk_support_ticket_drafts_ticket_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.support_ticket_embeddings') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_support_ticket_embeddings_ticket_id_org'
                     AND conrelid = to_regclass('public.support_ticket_embeddings')) THEN
    ALTER TABLE "public"."support_ticket_embeddings" ADD CONSTRAINT "fk_support_ticket_embeddings_ticket_id_org" FOREIGN KEY (org_id, ticket_id) REFERENCES support_tickets(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_support_ticket_embeddings_ticket_id_org'
             AND conrelid = to_regclass('public.support_ticket_embeddings') AND NOT convalidated) THEN
    ALTER TABLE "public"."support_ticket_embeddings" VALIDATE CONSTRAINT "fk_support_ticket_embeddings_ticket_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.support_ticket_external_links') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_support_ticket_external_links_ticket_id_org'
                     AND conrelid = to_regclass('public.support_ticket_external_links')) THEN
    ALTER TABLE "public"."support_ticket_external_links" ADD CONSTRAINT "fk_support_ticket_external_links_ticket_id_org" FOREIGN KEY (org_id, ticket_id) REFERENCES support_tickets(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_support_ticket_external_links_ticket_id_org'
             AND conrelid = to_regclass('public.support_ticket_external_links') AND NOT convalidated) THEN
    ALTER TABLE "public"."support_ticket_external_links" VALIDATE CONSTRAINT "fk_support_ticket_external_links_ticket_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.support_ticket_links') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_support_ticket_links_linked_ticket_id_org'
                     AND conrelid = to_regclass('public.support_ticket_links')) THEN
    ALTER TABLE "public"."support_ticket_links" ADD CONSTRAINT "fk_support_ticket_links_linked_ticket_id_org" FOREIGN KEY (org_id, linked_ticket_id) REFERENCES support_tickets(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_support_ticket_links_linked_ticket_id_org'
             AND conrelid = to_regclass('public.support_ticket_links') AND NOT convalidated) THEN
    ALTER TABLE "public"."support_ticket_links" VALIDATE CONSTRAINT "fk_support_ticket_links_linked_ticket_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.support_ticket_messages') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_support_ticket_messages_ticket_id_org'
                     AND conrelid = to_regclass('public.support_ticket_messages')) THEN
    ALTER TABLE "public"."support_ticket_messages" ADD CONSTRAINT "fk_support_ticket_messages_ticket_id_org" FOREIGN KEY (org_id, ticket_id) REFERENCES support_tickets(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_support_ticket_messages_ticket_id_org'
             AND conrelid = to_regclass('public.support_ticket_messages') AND NOT convalidated) THEN
    ALTER TABLE "public"."support_ticket_messages" VALIDATE CONSTRAINT "fk_support_ticket_messages_ticket_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.support_ticket_tags') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_support_ticket_tags_tag_id_org'
                     AND conrelid = to_regclass('public.support_ticket_tags')) THEN
    ALTER TABLE "public"."support_ticket_tags" ADD CONSTRAINT "fk_support_ticket_tags_tag_id_org" FOREIGN KEY (org_id, tag_id) REFERENCES support_tags(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_support_ticket_tags_tag_id_org'
             AND conrelid = to_regclass('public.support_ticket_tags') AND NOT convalidated) THEN
    ALTER TABLE "public"."support_ticket_tags" VALIDATE CONSTRAINT "fk_support_ticket_tags_tag_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.support_ticket_tags') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_support_ticket_tags_ticket_id_org'
                     AND conrelid = to_regclass('public.support_ticket_tags')) THEN
    ALTER TABLE "public"."support_ticket_tags" ADD CONSTRAINT "fk_support_ticket_tags_ticket_id_org" FOREIGN KEY (org_id, ticket_id) REFERENCES support_tickets(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_support_ticket_tags_ticket_id_org'
             AND conrelid = to_regclass('public.support_ticket_tags') AND NOT convalidated) THEN
    ALTER TABLE "public"."support_ticket_tags" VALIDATE CONSTRAINT "fk_support_ticket_tags_ticket_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.support_ticket_watchers') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_support_ticket_watchers_ticket_id_org'
                     AND conrelid = to_regclass('public.support_ticket_watchers')) THEN
    ALTER TABLE "public"."support_ticket_watchers" ADD CONSTRAINT "fk_support_ticket_watchers_ticket_id_org" FOREIGN KEY (org_id, ticket_id) REFERENCES support_tickets(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_support_ticket_watchers_ticket_id_org'
             AND conrelid = to_regclass('public.support_ticket_watchers') AND NOT convalidated) THEN
    ALTER TABLE "public"."support_ticket_watchers" VALIDATE CONSTRAINT "fk_support_ticket_watchers_ticket_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.support_tickets') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_support_tickets_client_id_org'
                     AND conrelid = to_regclass('public.support_tickets')) THEN
    ALTER TABLE "public"."support_tickets" ADD CONSTRAINT "fk_support_tickets_client_id_org" FOREIGN KEY (org_id, client_id) REFERENCES clients(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_support_tickets_client_id_org'
             AND conrelid = to_regclass('public.support_tickets') AND NOT convalidated) THEN
    ALTER TABLE "public"."support_tickets" VALIDATE CONSTRAINT "fk_support_tickets_client_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.support_tickets') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_support_tickets_client_party_id'
                     AND conrelid = to_regclass('public.support_tickets')) THEN
    ALTER TABLE "public"."support_tickets" ADD CONSTRAINT "fk_support_tickets_client_party_id" FOREIGN KEY (org_id, client_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_support_tickets_client_party_id'
             AND conrelid = to_regclass('public.support_tickets') AND NOT convalidated) THEN
    ALTER TABLE "public"."support_tickets" VALIDATE CONSTRAINT "fk_support_tickets_client_party_id";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.support_vip_clients') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_support_vip_clients_client_id_org'
                     AND conrelid = to_regclass('public.support_vip_clients')) THEN
    ALTER TABLE "public"."support_vip_clients" ADD CONSTRAINT "fk_support_vip_clients_client_id_org" FOREIGN KEY (org_id, client_id) REFERENCES clients(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_support_vip_clients_client_id_org'
             AND conrelid = to_regclass('public.support_vip_clients') AND NOT convalidated) THEN
    ALTER TABLE "public"."support_vip_clients" VALIDATE CONSTRAINT "fk_support_vip_clients_client_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.support_vip_clients') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_support_vip_clients_client_party_id'
                     AND conrelid = to_regclass('public.support_vip_clients')) THEN
    ALTER TABLE "public"."support_vip_clients" ADD CONSTRAINT "fk_support_vip_clients_client_party_id" FOREIGN KEY (org_id, client_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_support_vip_clients_client_party_id'
             AND conrelid = to_regclass('public.support_vip_clients') AND NOT convalidated) THEN
    ALTER TABLE "public"."support_vip_clients" VALIDATE CONSTRAINT "fk_support_vip_clients_client_party_id";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_answers') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_answers_question_id_org'
                     AND conrelid = to_regclass('public.survey_answers')) THEN
    ALTER TABLE "public"."survey_answers" ADD CONSTRAINT "fk_survey_answers_question_id_org" FOREIGN KEY (org_id, question_id) REFERENCES survey_questions(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_answers_question_id_org'
             AND conrelid = to_regclass('public.survey_answers') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_answers" VALIDATE CONSTRAINT "fk_survey_answers_question_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_answers') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_answers_session_id_org'
                     AND conrelid = to_regclass('public.survey_answers')) THEN
    ALTER TABLE "public"."survey_answers" ADD CONSTRAINT "fk_survey_answers_session_id_org" FOREIGN KEY (org_id, session_id) REFERENCES survey_response_sessions(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_answers_session_id_org'
             AND conrelid = to_regclass('public.survey_answers') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_answers" VALIDATE CONSTRAINT "fk_survey_answers_session_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_answers') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_answers_survey_id_org'
                     AND conrelid = to_regclass('public.survey_answers')) THEN
    ALTER TABLE "public"."survey_answers" ADD CONSTRAINT "fk_survey_answers_survey_id_org" FOREIGN KEY (org_id, survey_id) REFERENCES survey_forms(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_answers_survey_id_org'
             AND conrelid = to_regclass('public.survey_answers') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_answers" VALIDATE CONSTRAINT "fk_survey_answers_survey_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_answers') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_answers_version_id_org'
                     AND conrelid = to_regclass('public.survey_answers')) THEN
    ALTER TABLE "public"."survey_answers" ADD CONSTRAINT "fk_survey_answers_version_id_org" FOREIGN KEY (org_id, version_id) REFERENCES survey_versions(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_answers_version_id_org'
             AND conrelid = to_regclass('public.survey_answers') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_answers" VALIDATE CONSTRAINT "fk_survey_answers_version_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_assessment_attempts') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_assessment_attempts_participant_id_org'
                     AND conrelid = to_regclass('public.survey_assessment_attempts')) THEN
    ALTER TABLE "public"."survey_assessment_attempts" ADD CONSTRAINT "fk_survey_assessment_attempts_participant_id_org" FOREIGN KEY (org_id, participant_id) REFERENCES survey_participants(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_assessment_attempts_participant_id_org'
             AND conrelid = to_regclass('public.survey_assessment_attempts') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_assessment_attempts" VALIDATE CONSTRAINT "fk_survey_assessment_attempts_participant_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_assessment_attempts') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_assessment_attempts_session_id_org'
                     AND conrelid = to_regclass('public.survey_assessment_attempts')) THEN
    ALTER TABLE "public"."survey_assessment_attempts" ADD CONSTRAINT "fk_survey_assessment_attempts_session_id_org" FOREIGN KEY (org_id, session_id) REFERENCES survey_response_sessions(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_assessment_attempts_session_id_org'
             AND conrelid = to_regclass('public.survey_assessment_attempts') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_assessment_attempts" VALIDATE CONSTRAINT "fk_survey_assessment_attempts_session_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_assessment_attempts') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_assessment_attempts_survey_id_org'
                     AND conrelid = to_regclass('public.survey_assessment_attempts')) THEN
    ALTER TABLE "public"."survey_assessment_attempts" ADD CONSTRAINT "fk_survey_assessment_attempts_survey_id_org" FOREIGN KEY (org_id, survey_id) REFERENCES survey_forms(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_assessment_attempts_survey_id_org'
             AND conrelid = to_regclass('public.survey_assessment_attempts') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_assessment_attempts" VALIDATE CONSTRAINT "fk_survey_assessment_attempts_survey_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_assessment_attempts') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_assessment_attempts_version_id_org'
                     AND conrelid = to_regclass('public.survey_assessment_attempts')) THEN
    ALTER TABLE "public"."survey_assessment_attempts" ADD CONSTRAINT "fk_survey_assessment_attempts_version_id_org" FOREIGN KEY (org_id, version_id) REFERENCES survey_versions(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_assessment_attempts_version_id_org'
             AND conrelid = to_regclass('public.survey_assessment_attempts') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_assessment_attempts" VALIDATE CONSTRAINT "fk_survey_assessment_attempts_version_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_automation_events') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_automation_events_session_id_org'
                     AND conrelid = to_regclass('public.survey_automation_events')) THEN
    ALTER TABLE "public"."survey_automation_events" ADD CONSTRAINT "fk_survey_automation_events_session_id_org" FOREIGN KEY (org_id, session_id) REFERENCES survey_response_sessions(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_automation_events_session_id_org'
             AND conrelid = to_regclass('public.survey_automation_events') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_automation_events" VALIDATE CONSTRAINT "fk_survey_automation_events_session_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_automation_events') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_automation_events_survey_id_org'
                     AND conrelid = to_regclass('public.survey_automation_events')) THEN
    ALTER TABLE "public"."survey_automation_events" ADD CONSTRAINT "fk_survey_automation_events_survey_id_org" FOREIGN KEY (org_id, survey_id) REFERENCES survey_forms(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_automation_events_survey_id_org'
             AND conrelid = to_regclass('public.survey_automation_events') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_automation_events" VALIDATE CONSTRAINT "fk_survey_automation_events_survey_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_certificates') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_certificates_attempt_id_org'
                     AND conrelid = to_regclass('public.survey_certificates')) THEN
    ALTER TABLE "public"."survey_certificates" ADD CONSTRAINT "fk_survey_certificates_attempt_id_org" FOREIGN KEY (org_id, attempt_id) REFERENCES survey_assessment_attempts(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_certificates_attempt_id_org'
             AND conrelid = to_regclass('public.survey_certificates') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_certificates" VALIDATE CONSTRAINT "fk_survey_certificates_attempt_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_certificates') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_certificates_participant_id_org'
                     AND conrelid = to_regclass('public.survey_certificates')) THEN
    ALTER TABLE "public"."survey_certificates" ADD CONSTRAINT "fk_survey_certificates_participant_id_org" FOREIGN KEY (org_id, participant_id) REFERENCES survey_participants(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_certificates_participant_id_org'
             AND conrelid = to_regclass('public.survey_certificates') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_certificates" VALIDATE CONSTRAINT "fk_survey_certificates_participant_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_certificates') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_certificates_survey_id_org'
                     AND conrelid = to_regclass('public.survey_certificates')) THEN
    ALTER TABLE "public"."survey_certificates" ADD CONSTRAINT "fk_survey_certificates_survey_id_org" FOREIGN KEY (org_id, survey_id) REFERENCES survey_forms(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_certificates_survey_id_org'
             AND conrelid = to_regclass('public.survey_certificates') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_certificates" VALIDATE CONSTRAINT "fk_survey_certificates_survey_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_collectors') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_collectors_survey_id_org'
                     AND conrelid = to_regclass('public.survey_collectors')) THEN
    ALTER TABLE "public"."survey_collectors" ADD CONSTRAINT "fk_survey_collectors_survey_id_org" FOREIGN KEY (org_id, survey_id) REFERENCES survey_forms(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_collectors_survey_id_org'
             AND conrelid = to_regclass('public.survey_collectors') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_collectors" VALIDATE CONSTRAINT "fk_survey_collectors_survey_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_collectors') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_collectors_version_id_org'
                     AND conrelid = to_regclass('public.survey_collectors')) THEN
    ALTER TABLE "public"."survey_collectors" ADD CONSTRAINT "fk_survey_collectors_version_id_org" FOREIGN KEY (org_id, version_id) REFERENCES survey_versions(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_collectors_version_id_org'
             AND conrelid = to_regclass('public.survey_collectors') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_collectors" VALIDATE CONSTRAINT "fk_survey_collectors_version_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_live_sessions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_live_sessions_current_question_id_org'
                     AND conrelid = to_regclass('public.survey_live_sessions')) THEN
    ALTER TABLE "public"."survey_live_sessions" ADD CONSTRAINT "fk_survey_live_sessions_current_question_id_org" FOREIGN KEY (org_id, current_question_id) REFERENCES survey_questions(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_live_sessions_current_question_id_org'
             AND conrelid = to_regclass('public.survey_live_sessions') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_live_sessions" VALIDATE CONSTRAINT "fk_survey_live_sessions_current_question_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_live_sessions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_live_sessions_survey_id_org'
                     AND conrelid = to_regclass('public.survey_live_sessions')) THEN
    ALTER TABLE "public"."survey_live_sessions" ADD CONSTRAINT "fk_survey_live_sessions_survey_id_org" FOREIGN KEY (org_id, survey_id) REFERENCES survey_forms(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_live_sessions_survey_id_org'
             AND conrelid = to_regclass('public.survey_live_sessions') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_live_sessions" VALIDATE CONSTRAINT "fk_survey_live_sessions_survey_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_live_sessions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_live_sessions_version_id_org'
                     AND conrelid = to_regclass('public.survey_live_sessions')) THEN
    ALTER TABLE "public"."survey_live_sessions" ADD CONSTRAINT "fk_survey_live_sessions_version_id_org" FOREIGN KEY (org_id, version_id) REFERENCES survey_versions(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_live_sessions_version_id_org'
             AND conrelid = to_regclass('public.survey_live_sessions') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_live_sessions" VALIDATE CONSTRAINT "fk_survey_live_sessions_version_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_logic_rules') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_logic_rules_source_question_id_org'
                     AND conrelid = to_regclass('public.survey_logic_rules')) THEN
    ALTER TABLE "public"."survey_logic_rules" ADD CONSTRAINT "fk_survey_logic_rules_source_question_id_org" FOREIGN KEY (org_id, source_question_id) REFERENCES survey_questions(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_logic_rules_source_question_id_org'
             AND conrelid = to_regclass('public.survey_logic_rules') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_logic_rules" VALIDATE CONSTRAINT "fk_survey_logic_rules_source_question_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_logic_rules') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_logic_rules_survey_id_org'
                     AND conrelid = to_regclass('public.survey_logic_rules')) THEN
    ALTER TABLE "public"."survey_logic_rules" ADD CONSTRAINT "fk_survey_logic_rules_survey_id_org" FOREIGN KEY (org_id, survey_id) REFERENCES survey_forms(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_logic_rules_survey_id_org'
             AND conrelid = to_regclass('public.survey_logic_rules') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_logic_rules" VALIDATE CONSTRAINT "fk_survey_logic_rules_survey_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_logic_rules') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_logic_rules_version_id_org'
                     AND conrelid = to_regclass('public.survey_logic_rules')) THEN
    ALTER TABLE "public"."survey_logic_rules" ADD CONSTRAINT "fk_survey_logic_rules_version_id_org" FOREIGN KEY (org_id, version_id) REFERENCES survey_versions(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_logic_rules_version_id_org'
             AND conrelid = to_regclass('public.survey_logic_rules') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_logic_rules" VALIDATE CONSTRAINT "fk_survey_logic_rules_version_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_participants') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_participants_client_id_org'
                     AND conrelid = to_regclass('public.survey_participants')) THEN
    ALTER TABLE "public"."survey_participants" ADD CONSTRAINT "fk_survey_participants_client_id_org" FOREIGN KEY (org_id, client_id) REFERENCES client_accounts(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_participants_client_id_org'
             AND conrelid = to_regclass('public.survey_participants') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_participants" VALIDATE CONSTRAINT "fk_survey_participants_client_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_participants') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_participants_collector_id_org'
                     AND conrelid = to_regclass('public.survey_participants')) THEN
    ALTER TABLE "public"."survey_participants" ADD CONSTRAINT "fk_survey_participants_collector_id_org" FOREIGN KEY (org_id, collector_id) REFERENCES survey_collectors(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_participants_collector_id_org'
             AND conrelid = to_regclass('public.survey_participants') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_participants" VALIDATE CONSTRAINT "fk_survey_participants_collector_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_participants') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_participants_contact_id_org'
                     AND conrelid = to_regclass('public.survey_participants')) THEN
    ALTER TABLE "public"."survey_participants" ADD CONSTRAINT "fk_survey_participants_contact_id_org" FOREIGN KEY (org_id, contact_id) REFERENCES contacts(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_participants_contact_id_org'
             AND conrelid = to_regclass('public.survey_participants') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_participants" VALIDATE CONSTRAINT "fk_survey_participants_contact_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_participants') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_participants_contact_party_id'
                     AND conrelid = to_regclass('public.survey_participants')) THEN
    ALTER TABLE "public"."survey_participants" ADD CONSTRAINT "fk_survey_participants_contact_party_id" FOREIGN KEY (org_id, contact_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_participants_contact_party_id'
             AND conrelid = to_regclass('public.survey_participants') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_participants" VALIDATE CONSTRAINT "fk_survey_participants_contact_party_id";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_participants') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_participants_lead_id_org'
                     AND conrelid = to_regclass('public.survey_participants')) THEN
    ALTER TABLE "public"."survey_participants" ADD CONSTRAINT "fk_survey_participants_lead_id_org" FOREIGN KEY (org_id, lead_id) REFERENCES leads(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_participants_lead_id_org'
             AND conrelid = to_regclass('public.survey_participants') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_participants" VALIDATE CONSTRAINT "fk_survey_participants_lead_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_participants') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_participants_lead_party_id'
                     AND conrelid = to_regclass('public.survey_participants')) THEN
    ALTER TABLE "public"."survey_participants" ADD CONSTRAINT "fk_survey_participants_lead_party_id" FOREIGN KEY (org_id, lead_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_participants_lead_party_id'
             AND conrelid = to_regclass('public.survey_participants') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_participants" VALIDATE CONSTRAINT "fk_survey_participants_lead_party_id";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_participants') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_participants_survey_id_org'
                     AND conrelid = to_regclass('public.survey_participants')) THEN
    ALTER TABLE "public"."survey_participants" ADD CONSTRAINT "fk_survey_participants_survey_id_org" FOREIGN KEY (org_id, survey_id) REFERENCES survey_forms(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_participants_survey_id_org'
             AND conrelid = to_regclass('public.survey_participants') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_participants" VALIDATE CONSTRAINT "fk_survey_participants_survey_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_question_choices') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_question_choices_question_id_org'
                     AND conrelid = to_regclass('public.survey_question_choices')) THEN
    ALTER TABLE "public"."survey_question_choices" ADD CONSTRAINT "fk_survey_question_choices_question_id_org" FOREIGN KEY (org_id, question_id) REFERENCES survey_questions(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_question_choices_question_id_org'
             AND conrelid = to_regclass('public.survey_question_choices') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_question_choices" VALIDATE CONSTRAINT "fk_survey_question_choices_question_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_questions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_questions_section_id_org'
                     AND conrelid = to_regclass('public.survey_questions')) THEN
    ALTER TABLE "public"."survey_questions" ADD CONSTRAINT "fk_survey_questions_section_id_org" FOREIGN KEY (org_id, section_id) REFERENCES survey_sections(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_questions_section_id_org'
             AND conrelid = to_regclass('public.survey_questions') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_questions" VALIDATE CONSTRAINT "fk_survey_questions_section_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_questions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_questions_survey_id_org'
                     AND conrelid = to_regclass('public.survey_questions')) THEN
    ALTER TABLE "public"."survey_questions" ADD CONSTRAINT "fk_survey_questions_survey_id_org" FOREIGN KEY (org_id, survey_id) REFERENCES survey_forms(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_questions_survey_id_org'
             AND conrelid = to_regclass('public.survey_questions') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_questions" VALIDATE CONSTRAINT "fk_survey_questions_survey_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_questions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_questions_version_id_org'
                     AND conrelid = to_regclass('public.survey_questions')) THEN
    ALTER TABLE "public"."survey_questions" ADD CONSTRAINT "fk_survey_questions_version_id_org" FOREIGN KEY (org_id, version_id) REFERENCES survey_versions(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_questions_version_id_org'
             AND conrelid = to_regclass('public.survey_questions') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_questions" VALIDATE CONSTRAINT "fk_survey_questions_version_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_response_sessions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_response_sessions_collector_id_org'
                     AND conrelid = to_regclass('public.survey_response_sessions')) THEN
    ALTER TABLE "public"."survey_response_sessions" ADD CONSTRAINT "fk_survey_response_sessions_collector_id_org" FOREIGN KEY (org_id, collector_id) REFERENCES survey_collectors(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_response_sessions_collector_id_org'
             AND conrelid = to_regclass('public.survey_response_sessions') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_response_sessions" VALIDATE CONSTRAINT "fk_survey_response_sessions_collector_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_response_sessions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_response_sessions_participant_id_org'
                     AND conrelid = to_regclass('public.survey_response_sessions')) THEN
    ALTER TABLE "public"."survey_response_sessions" ADD CONSTRAINT "fk_survey_response_sessions_participant_id_org" FOREIGN KEY (org_id, participant_id) REFERENCES survey_participants(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_response_sessions_participant_id_org'
             AND conrelid = to_regclass('public.survey_response_sessions') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_response_sessions" VALIDATE CONSTRAINT "fk_survey_response_sessions_participant_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_response_sessions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_response_sessions_survey_id_org'
                     AND conrelid = to_regclass('public.survey_response_sessions')) THEN
    ALTER TABLE "public"."survey_response_sessions" ADD CONSTRAINT "fk_survey_response_sessions_survey_id_org" FOREIGN KEY (org_id, survey_id) REFERENCES survey_forms(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_response_sessions_survey_id_org'
             AND conrelid = to_regclass('public.survey_response_sessions') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_response_sessions" VALIDATE CONSTRAINT "fk_survey_response_sessions_survey_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_response_sessions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_response_sessions_version_id_org'
                     AND conrelid = to_regclass('public.survey_response_sessions')) THEN
    ALTER TABLE "public"."survey_response_sessions" ADD CONSTRAINT "fk_survey_response_sessions_version_id_org" FOREIGN KEY (org_id, version_id) REFERENCES survey_versions(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_response_sessions_version_id_org'
             AND conrelid = to_regclass('public.survey_response_sessions') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_response_sessions" VALIDATE CONSTRAINT "fk_survey_response_sessions_version_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_responses') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_responses_survey_id_org'
                     AND conrelid = to_regclass('public.survey_responses')) THEN
    ALTER TABLE "public"."survey_responses" ADD CONSTRAINT "fk_survey_responses_survey_id_org" FOREIGN KEY (org_id, survey_id) REFERENCES pulse_surveys(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_responses_survey_id_org'
             AND conrelid = to_regclass('public.survey_responses') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_responses" VALIDATE CONSTRAINT "fk_survey_responses_survey_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_sections') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_sections_survey_id_org'
                     AND conrelid = to_regclass('public.survey_sections')) THEN
    ALTER TABLE "public"."survey_sections" ADD CONSTRAINT "fk_survey_sections_survey_id_org" FOREIGN KEY (org_id, survey_id) REFERENCES survey_forms(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_sections_survey_id_org'
             AND conrelid = to_regclass('public.survey_sections') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_sections" VALIDATE CONSTRAINT "fk_survey_sections_survey_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_sections') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_sections_version_id_org'
                     AND conrelid = to_regclass('public.survey_sections')) THEN
    ALTER TABLE "public"."survey_sections" ADD CONSTRAINT "fk_survey_sections_version_id_org" FOREIGN KEY (org_id, version_id) REFERENCES survey_versions(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_sections_version_id_org'
             AND conrelid = to_regclass('public.survey_sections') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_sections" VALIDATE CONSTRAINT "fk_survey_sections_version_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_versions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_versions_survey_id_org'
                     AND conrelid = to_regclass('public.survey_versions')) THEN
    ALTER TABLE "public"."survey_versions" ADD CONSTRAINT "fk_survey_versions_survey_id_org" FOREIGN KEY (org_id, survey_id) REFERENCES survey_forms(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_versions_survey_id_org'
             AND conrelid = to_regclass('public.survey_versions') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_versions" VALIDATE CONSTRAINT "fk_survey_versions_survey_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.talent_pool_members') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_talent_pool_members_candidate_id_org'
                     AND conrelid = to_regclass('public.talent_pool_members')) THEN
    ALTER TABLE "public"."talent_pool_members" ADD CONSTRAINT "fk_talent_pool_members_candidate_id_org" FOREIGN KEY (org_id, candidate_id) REFERENCES candidates(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_talent_pool_members_candidate_id_org'
             AND conrelid = to_regclass('public.talent_pool_members') AND NOT convalidated) THEN
    ALTER TABLE "public"."talent_pool_members" VALIDATE CONSTRAINT "fk_talent_pool_members_candidate_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.talent_pool_members') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_talent_pool_members_pool_id_org'
                     AND conrelid = to_regclass('public.talent_pool_members')) THEN
    ALTER TABLE "public"."talent_pool_members" ADD CONSTRAINT "fk_talent_pool_members_pool_id_org" FOREIGN KEY (org_id, pool_id) REFERENCES talent_pools(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_talent_pool_members_pool_id_org'
             AND conrelid = to_regclass('public.talent_pool_members') AND NOT convalidated) THEN
    ALTER TABLE "public"."talent_pool_members" VALIDATE CONSTRAINT "fk_talent_pool_members_pool_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.task_sequence_steps') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_task_sequence_steps_sequence_id_org'
                     AND conrelid = to_regclass('public.task_sequence_steps')) THEN
    ALTER TABLE "public"."task_sequence_steps" ADD CONSTRAINT "fk_task_sequence_steps_sequence_id_org" FOREIGN KEY (org_id, sequence_id) REFERENCES task_sequences(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_task_sequence_steps_sequence_id_org'
             AND conrelid = to_regclass('public.task_sequence_steps') AND NOT convalidated) THEN
    ALTER TABLE "public"."task_sequence_steps" VALIDATE CONSTRAINT "fk_task_sequence_steps_sequence_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.tasks') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_tasks_parent_task_id_org'
                     AND conrelid = to_regclass('public.tasks')) THEN
    ALTER TABLE "public"."tasks" ADD CONSTRAINT "fk_tasks_parent_task_id_org" FOREIGN KEY (org_id, parent_task_id) REFERENCES tasks(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_tasks_parent_task_id_org'
             AND conrelid = to_regclass('public.tasks') AND NOT convalidated) THEN
    ALTER TABLE "public"."tasks" VALIDATE CONSTRAINT "fk_tasks_parent_task_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.team_event_participants') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_team_event_participants_event_id_org'
                     AND conrelid = to_regclass('public.team_event_participants')) THEN
    ALTER TABLE "public"."team_event_participants" ADD CONSTRAINT "fk_team_event_participants_event_id_org" FOREIGN KEY (org_id, event_id) REFERENCES team_events(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_team_event_participants_event_id_org'
             AND conrelid = to_regclass('public.team_event_participants') AND NOT convalidated) THEN
    ALTER TABLE "public"."team_event_participants" VALIDATE CONSTRAINT "fk_team_event_participants_event_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.timer_sessions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_timer_sessions_project_id_org'
                     AND conrelid = to_regclass('public.timer_sessions')) THEN
    ALTER TABLE "public"."timer_sessions" ADD CONSTRAINT "fk_timer_sessions_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES build.projects(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_timer_sessions_project_id_org'
             AND conrelid = to_regclass('public.timer_sessions') AND NOT convalidated) THEN
    ALTER TABLE "public"."timer_sessions" VALIDATE CONSTRAINT "fk_timer_sessions_project_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.timesheet_budgets') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_timesheet_budgets_project_id_org'
                     AND conrelid = to_regclass('public.timesheet_budgets')) THEN
    ALTER TABLE "public"."timesheet_budgets" ADD CONSTRAINT "fk_timesheet_budgets_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES build.projects(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_timesheet_budgets_project_id_org'
             AND conrelid = to_regclass('public.timesheet_budgets') AND NOT convalidated) THEN
    ALTER TABLE "public"."timesheet_budgets" VALIDATE CONSTRAINT "fk_timesheet_budgets_project_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.timesheet_periods') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_timesheet_periods_approved_actor'
                     AND conrelid = to_regclass('public.timesheet_periods')) THEN
    ALTER TABLE "public"."timesheet_periods" ADD CONSTRAINT "fk_timesheet_periods_approved_actor" FOREIGN KEY (org_id, approved_by_membership_id) REFERENCES organization_members(org_id, id) ON DELETE RESTRICT NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_timesheet_periods_approved_actor'
             AND conrelid = to_regclass('public.timesheet_periods') AND NOT convalidated) THEN
    ALTER TABLE "public"."timesheet_periods" VALIDATE CONSTRAINT "fk_timesheet_periods_approved_actor";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.timesheet_rates') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_timesheet_rates_client_party_id'
                     AND conrelid = to_regclass('public.timesheet_rates')) THEN
    ALTER TABLE "public"."timesheet_rates" ADD CONSTRAINT "fk_timesheet_rates_client_party_id" FOREIGN KEY (org_id, client_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_timesheet_rates_client_party_id'
             AND conrelid = to_regclass('public.timesheet_rates') AND NOT convalidated) THEN
    ALTER TABLE "public"."timesheet_rates" VALIDATE CONSTRAINT "fk_timesheet_rates_client_party_id";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.timesheet_rates') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_timesheet_rates_project_id_org'
                     AND conrelid = to_regclass('public.timesheet_rates')) THEN
    ALTER TABLE "public"."timesheet_rates" ADD CONSTRAINT "fk_timesheet_rates_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES build.projects(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_timesheet_rates_project_id_org'
             AND conrelid = to_regclass('public.timesheet_rates') AND NOT convalidated) THEN
    ALTER TABLE "public"."timesheet_rates" VALIDATE CONSTRAINT "fk_timesheet_rates_project_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.timesheet_rates') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_timesheet_rates_rate_card_id_org'
                     AND conrelid = to_regclass('public.timesheet_rates')) THEN
    ALTER TABLE "public"."timesheet_rates" ADD CONSTRAINT "fk_timesheet_rates_rate_card_id_org" FOREIGN KEY (org_id, rate_card_id) REFERENCES timesheet_rate_cards(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_timesheet_rates_rate_card_id_org'
             AND conrelid = to_regclass('public.timesheet_rates') AND NOT convalidated) THEN
    ALTER TABLE "public"."timesheet_rates" VALIDATE CONSTRAINT "fk_timesheet_rates_rate_card_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.timesheets') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_timesheets_approved_actor'
                     AND conrelid = to_regclass('public.timesheets')) THEN
    ALTER TABLE "public"."timesheets" ADD CONSTRAINT "fk_timesheets_approved_actor" FOREIGN KEY (org_id, approved_by_membership_id) REFERENCES organization_members(org_id, id) ON DELETE RESTRICT NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_timesheets_approved_actor'
             AND conrelid = to_regclass('public.timesheets') AND NOT convalidated) THEN
    ALTER TABLE "public"."timesheets" VALIDATE CONSTRAINT "fk_timesheets_approved_actor";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.timesheets') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_timesheets_payroll_export_id_org'
                     AND conrelid = to_regclass('public.timesheets')) THEN
    ALTER TABLE "public"."timesheets" ADD CONSTRAINT "fk_timesheets_payroll_export_id_org" FOREIGN KEY (org_id, payroll_export_id) REFERENCES timesheet_exports(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_timesheets_payroll_export_id_org'
             AND conrelid = to_regclass('public.timesheets') AND NOT convalidated) THEN
    ALTER TABLE "public"."timesheets" VALIDATE CONSTRAINT "fk_timesheets_payroll_export_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.timesheets') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_timesheets_project_id_org'
                     AND conrelid = to_regclass('public.timesheets')) THEN
    ALTER TABLE "public"."timesheets" ADD CONSTRAINT "fk_timesheets_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES build.projects(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_timesheets_project_id_org'
             AND conrelid = to_regclass('public.timesheets') AND NOT convalidated) THEN
    ALTER TABLE "public"."timesheets" VALIDATE CONSTRAINT "fk_timesheets_project_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.timesheets') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_timesheets_ticket_id_org'
                     AND conrelid = to_regclass('public.timesheets')) THEN
    ALTER TABLE "public"."timesheets" ADD CONSTRAINT "fk_timesheets_ticket_id_org" FOREIGN KEY (org_id, ticket_id) REFERENCES build.tickets(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_timesheets_ticket_id_org'
             AND conrelid = to_regclass('public.timesheets') AND NOT convalidated) THEN
    ALTER TABLE "public"."timesheets" VALIDATE CONSTRAINT "fk_timesheets_ticket_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.timesheets') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_timesheets_timer_session_id_org'
                     AND conrelid = to_regclass('public.timesheets')) THEN
    ALTER TABLE "public"."timesheets" ADD CONSTRAINT "fk_timesheets_timer_session_id_org" FOREIGN KEY (org_id, timer_session_id) REFERENCES timer_sessions(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_timesheets_timer_session_id_org'
             AND conrelid = to_regclass('public.timesheets') AND NOT convalidated) THEN
    ALTER TABLE "public"."timesheets" VALIDATE CONSTRAINT "fk_timesheets_timer_session_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.timesheets') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_timesheets_timesheet_period_id_org'
                     AND conrelid = to_regclass('public.timesheets')) THEN
    ALTER TABLE "public"."timesheets" ADD CONSTRAINT "fk_timesheets_timesheet_period_id_org" FOREIGN KEY (org_id, timesheet_period_id) REFERENCES timesheet_periods(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_timesheets_timesheet_period_id_org'
             AND conrelid = to_regclass('public.timesheets') AND NOT convalidated) THEN
    ALTER TABLE "public"."timesheets" VALIDATE CONSTRAINT "fk_timesheets_timesheet_period_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.user_permission_grants') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_user_permission_grants_granter_membership'
                     AND conrelid = to_regclass('public.user_permission_grants')) THEN
    ALTER TABLE "public"."user_permission_grants" ADD CONSTRAINT "fk_user_permission_grants_granter_membership" FOREIGN KEY (org_id, granted_by_membership_id) REFERENCES organization_members(org_id, id) ON DELETE SET NULL (granted_by_membership_id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_user_permission_grants_granter_membership'
             AND conrelid = to_regclass('public.user_permission_grants') AND NOT convalidated) THEN
    ALTER TABLE "public"."user_permission_grants" VALIDATE CONSTRAINT "fk_user_permission_grants_granter_membership";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.vault_access_logs') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_vault_access_logs_candidate_id_org'
                     AND conrelid = to_regclass('public.vault_access_logs')) THEN
    ALTER TABLE "public"."vault_access_logs" ADD CONSTRAINT "fk_vault_access_logs_candidate_id_org" FOREIGN KEY (org_id, candidate_id) REFERENCES candidates(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_vault_access_logs_candidate_id_org'
             AND conrelid = to_regclass('public.vault_access_logs') AND NOT convalidated) THEN
    ALTER TABLE "public"."vault_access_logs" VALIDATE CONSTRAINT "fk_vault_access_logs_candidate_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.vault_access_logs') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_vault_access_logs_vault_document_id_org'
                     AND conrelid = to_regclass('public.vault_access_logs')) THEN
    ALTER TABLE "public"."vault_access_logs" ADD CONSTRAINT "fk_vault_access_logs_vault_document_id_org" FOREIGN KEY (org_id, vault_document_id) REFERENCES candidate_documents_vault(org_id, id) ON DELETE SET NULL (vault_document_id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_vault_access_logs_vault_document_id_org'
             AND conrelid = to_regclass('public.vault_access_logs') AND NOT convalidated) THEN
    ALTER TABLE "public"."vault_access_logs" VALIDATE CONSTRAINT "fk_vault_access_logs_vault_document_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.vendor_candidate_submissions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_vendor_candidate_submissions_candidate_id_org'
                     AND conrelid = to_regclass('public.vendor_candidate_submissions')) THEN
    ALTER TABLE "public"."vendor_candidate_submissions" ADD CONSTRAINT "fk_vendor_candidate_submissions_candidate_id_org" FOREIGN KEY (org_id, candidate_id) REFERENCES candidates(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_vendor_candidate_submissions_candidate_id_org'
             AND conrelid = to_regclass('public.vendor_candidate_submissions') AND NOT convalidated) THEN
    ALTER TABLE "public"."vendor_candidate_submissions" VALIDATE CONSTRAINT "fk_vendor_candidate_submissions_candidate_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.vendor_candidate_submissions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_vendor_candidate_submissions_job_posting_id_org'
                     AND conrelid = to_regclass('public.vendor_candidate_submissions')) THEN
    ALTER TABLE "public"."vendor_candidate_submissions" ADD CONSTRAINT "fk_vendor_candidate_submissions_job_posting_id_org" FOREIGN KEY (org_id, job_posting_id) REFERENCES job_postings(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_vendor_candidate_submissions_job_posting_id_org'
             AND conrelid = to_regclass('public.vendor_candidate_submissions') AND NOT convalidated) THEN
    ALTER TABLE "public"."vendor_candidate_submissions" VALIDATE CONSTRAINT "fk_vendor_candidate_submissions_job_posting_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.vendor_candidate_submissions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_vendor_candidate_submissions_vendor_id_org'
                     AND conrelid = to_regclass('public.vendor_candidate_submissions')) THEN
    ALTER TABLE "public"."vendor_candidate_submissions" ADD CONSTRAINT "fk_vendor_candidate_submissions_vendor_id_org" FOREIGN KEY (org_id, vendor_id) REFERENCES recruitment_vendors(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_vendor_candidate_submissions_vendor_id_org'
             AND conrelid = to_regclass('public.vendor_candidate_submissions') AND NOT convalidated) THEN
    ALTER TABLE "public"."vendor_candidate_submissions" VALIDATE CONSTRAINT "fk_vendor_candidate_submissions_vendor_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.vendor_credit_items') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_vendor_credit_items_vendor_credit_id_org'
                     AND conrelid = to_regclass('public.vendor_credit_items')) THEN
    ALTER TABLE "public"."vendor_credit_items" ADD CONSTRAINT "fk_vendor_credit_items_vendor_credit_id_org" FOREIGN KEY (org_id, vendor_credit_id) REFERENCES vendor_credits(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_vendor_credit_items_vendor_credit_id_org'
             AND conrelid = to_regclass('public.vendor_credit_items') AND NOT convalidated) THEN
    ALTER TABLE "public"."vendor_credit_items" VALIDATE CONSTRAINT "fk_vendor_credit_items_vendor_credit_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.vendor_credits') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_vendor_credits_bill_id_org'
                     AND conrelid = to_regclass('public.vendor_credits')) THEN
    ALTER TABLE "public"."vendor_credits" ADD CONSTRAINT "fk_vendor_credits_bill_id_org" FOREIGN KEY (org_id, bill_id) REFERENCES purchase_bills(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_vendor_credits_bill_id_org'
             AND conrelid = to_regclass('public.vendor_credits') AND NOT convalidated) THEN
    ALTER TABLE "public"."vendor_credits" VALIDATE CONSTRAINT "fk_vendor_credits_bill_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.vendor_credits') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_vendor_credits_vendor_id_org'
                     AND conrelid = to_regclass('public.vendor_credits')) THEN
    ALTER TABLE "public"."vendor_credits" ADD CONSTRAINT "fk_vendor_credits_vendor_id_org" FOREIGN KEY (org_id, vendor_id) REFERENCES clients(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_vendor_credits_vendor_id_org'
             AND conrelid = to_regclass('public.vendor_credits') AND NOT convalidated) THEN
    ALTER TABLE "public"."vendor_credits" VALIDATE CONSTRAINT "fk_vendor_credits_vendor_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.vendor_payments') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_vendor_payments_bill_id_org'
                     AND conrelid = to_regclass('public.vendor_payments')) THEN
    ALTER TABLE "public"."vendor_payments" ADD CONSTRAINT "fk_vendor_payments_bill_id_org" FOREIGN KEY (org_id, bill_id) REFERENCES purchase_bills(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_vendor_payments_bill_id_org'
             AND conrelid = to_regclass('public.vendor_payments') AND NOT convalidated) THEN
    ALTER TABLE "public"."vendor_payments" VALIDATE CONSTRAINT "fk_vendor_payments_bill_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.webhook_logs') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_webhook_logs_endpoint_id_org'
                     AND conrelid = to_regclass('public.webhook_logs')) THEN
    ALTER TABLE "public"."webhook_logs" ADD CONSTRAINT "fk_webhook_logs_endpoint_id_org" FOREIGN KEY (org_id, endpoint_id) REFERENCES webhook_endpoints(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_webhook_logs_endpoint_id_org'
             AND conrelid = to_regclass('public.webhook_logs') AND NOT convalidated) THEN
    ALTER TABLE "public"."webhook_logs" VALIDATE CONSTRAINT "fk_webhook_logs_endpoint_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.wfh_requests') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_wfh_requests_approver_actor'
                     AND conrelid = to_regclass('public.wfh_requests')) THEN
    ALTER TABLE "public"."wfh_requests" ADD CONSTRAINT "fk_wfh_requests_approver_actor" FOREIGN KEY (org_id, approver_membership_id) REFERENCES organization_members(org_id, id) ON DELETE RESTRICT NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_wfh_requests_approver_actor'
             AND conrelid = to_regclass('public.wfh_requests') AND NOT convalidated) THEN
    ALTER TABLE "public"."wfh_requests" VALIDATE CONSTRAINT "fk_wfh_requests_approver_actor";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.workflow_approvals') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_workflow_approvals_execution_id_org'
                     AND conrelid = to_regclass('public.workflow_approvals')) THEN
    ALTER TABLE "public"."workflow_approvals" ADD CONSTRAINT "fk_workflow_approvals_execution_id_org" FOREIGN KEY (org_id, execution_id) REFERENCES workflow_executions(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_workflow_approvals_execution_id_org'
             AND conrelid = to_regclass('public.workflow_approvals') AND NOT convalidated) THEN
    ALTER TABLE "public"."workflow_approvals" VALIDATE CONSTRAINT "fk_workflow_approvals_execution_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.workflow_approvals') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_workflow_approvals_step_id_org'
                     AND conrelid = to_regclass('public.workflow_approvals')) THEN
    ALTER TABLE "public"."workflow_approvals" ADD CONSTRAINT "fk_workflow_approvals_step_id_org" FOREIGN KEY (org_id, step_id) REFERENCES workflow_execution_steps(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_workflow_approvals_step_id_org'
             AND conrelid = to_regclass('public.workflow_approvals') AND NOT convalidated) THEN
    ALTER TABLE "public"."workflow_approvals" VALIDATE CONSTRAINT "fk_workflow_approvals_step_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.workflow_audit_logs') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_workflow_audit_logs_execution_id_org'
                     AND conrelid = to_regclass('public.workflow_audit_logs')) THEN
    ALTER TABLE "public"."workflow_audit_logs" ADD CONSTRAINT "fk_workflow_audit_logs_execution_id_org" FOREIGN KEY (org_id, execution_id) REFERENCES workflow_executions(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_workflow_audit_logs_execution_id_org'
             AND conrelid = to_regclass('public.workflow_audit_logs') AND NOT convalidated) THEN
    ALTER TABLE "public"."workflow_audit_logs" VALIDATE CONSTRAINT "fk_workflow_audit_logs_execution_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.workflow_audit_logs') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_workflow_audit_logs_workflow_id_org'
                     AND conrelid = to_regclass('public.workflow_audit_logs')) THEN
    ALTER TABLE "public"."workflow_audit_logs" ADD CONSTRAINT "fk_workflow_audit_logs_workflow_id_org" FOREIGN KEY (org_id, workflow_id) REFERENCES workflows(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_workflow_audit_logs_workflow_id_org'
             AND conrelid = to_regclass('public.workflow_audit_logs') AND NOT convalidated) THEN
    ALTER TABLE "public"."workflow_audit_logs" VALIDATE CONSTRAINT "fk_workflow_audit_logs_workflow_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.workflow_execution_steps') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_workflow_execution_steps_execution_id_org'
                     AND conrelid = to_regclass('public.workflow_execution_steps')) THEN
    ALTER TABLE "public"."workflow_execution_steps" ADD CONSTRAINT "fk_workflow_execution_steps_execution_id_org" FOREIGN KEY (org_id, execution_id) REFERENCES workflow_executions(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_workflow_execution_steps_execution_id_org'
             AND conrelid = to_regclass('public.workflow_execution_steps') AND NOT convalidated) THEN
    ALTER TABLE "public"."workflow_execution_steps" VALIDATE CONSTRAINT "fk_workflow_execution_steps_execution_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.workflow_executions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_workflow_executions_workflow_id_org'
                     AND conrelid = to_regclass('public.workflow_executions')) THEN
    ALTER TABLE "public"."workflow_executions" ADD CONSTRAINT "fk_workflow_executions_workflow_id_org" FOREIGN KEY (org_id, workflow_id) REFERENCES workflows(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_workflow_executions_workflow_id_org'
             AND conrelid = to_regclass('public.workflow_executions') AND NOT convalidated) THEN
    ALTER TABLE "public"."workflow_executions" VALIDATE CONSTRAINT "fk_workflow_executions_workflow_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.workflow_executions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_workflow_executions_workflow_version_id_org'
                     AND conrelid = to_regclass('public.workflow_executions')) THEN
    ALTER TABLE "public"."workflow_executions" ADD CONSTRAINT "fk_workflow_executions_workflow_version_id_org" FOREIGN KEY (org_id, workflow_version_id) REFERENCES workflow_versions(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_workflow_executions_workflow_version_id_org'
             AND conrelid = to_regclass('public.workflow_executions') AND NOT convalidated) THEN
    ALTER TABLE "public"."workflow_executions" VALIDATE CONSTRAINT "fk_workflow_executions_workflow_version_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.workflow_schedules') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_workflow_schedules_workflow_id_org'
                     AND conrelid = to_regclass('public.workflow_schedules')) THEN
    ALTER TABLE "public"."workflow_schedules" ADD CONSTRAINT "fk_workflow_schedules_workflow_id_org" FOREIGN KEY (org_id, workflow_id) REFERENCES workflows(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_workflow_schedules_workflow_id_org'
             AND conrelid = to_regclass('public.workflow_schedules') AND NOT convalidated) THEN
    ALTER TABLE "public"."workflow_schedules" VALIDATE CONSTRAINT "fk_workflow_schedules_workflow_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.workflow_variables') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_workflow_variables_workflow_version_id_org'
                     AND conrelid = to_regclass('public.workflow_variables')) THEN
    ALTER TABLE "public"."workflow_variables" ADD CONSTRAINT "fk_workflow_variables_workflow_version_id_org" FOREIGN KEY (org_id, workflow_version_id) REFERENCES workflow_versions(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_workflow_variables_workflow_version_id_org'
             AND conrelid = to_regclass('public.workflow_variables') AND NOT convalidated) THEN
    ALTER TABLE "public"."workflow_variables" VALIDATE CONSTRAINT "fk_workflow_variables_workflow_version_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.workflow_versions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_workflow_versions_workflow_id_org'
                     AND conrelid = to_regclass('public.workflow_versions')) THEN
    ALTER TABLE "public"."workflow_versions" ADD CONSTRAINT "fk_workflow_versions_workflow_id_org" FOREIGN KEY (org_id, workflow_id) REFERENCES workflows(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_workflow_versions_workflow_id_org'
             AND conrelid = to_regclass('public.workflow_versions') AND NOT convalidated) THEN
    ALTER TABLE "public"."workflow_versions" VALIDATE CONSTRAINT "fk_workflow_versions_workflow_id_org";
  END IF;
END $$;
--> statement-breakpoint
