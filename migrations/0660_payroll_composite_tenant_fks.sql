-- =============================================================================
-- 0660 — Composite tenant foreign keys: payroll and time
-- =============================================================================
-- Payroll, timesheets and payments.
--
-- 50 composite tenant foreign keys.
-- Requires 0656, which authors the unique keys these reference.
--
-- Series 0656-0664. Part of one change: 458 composite tenant foreign keys and
-- the 165 unique keys they reference existed only on the shared Neon branch,
-- created by hand and authored by no migration. backend/CLAUDE.md §3 requires
-- them and says application predicates and RLS do not replace them, so on a
-- database rebuilt from migrations/ nothing stopped a child row referencing a
-- parent in another organisation.
--
-- Shape rules, all of them load-bearing:
--
--   * Every definition is taken verbatim from pg_get_constraintdef, so the
--     ON DELETE clauses that nine of them carry survive. The only edits are
--     mechanical: a trailing " NOT VALID" is stripped from the four that are
--     live-but-unvalidated (we append our own), and the REFERENCES target is
--     schema-qualified — see the next point.
--
--   * Every table name is schema-qualified in all three positions: the
--     to_regclass probe, the ALTER TABLE, and the REFERENCES target. 123 of
--     these constraints are outside public (120 build, 3 build_events), and
--     to_regclass('public.x') on a build table returns NULL — the guard would
--     conclude the table does not exist, skip, and never create the constraint
--     on a fresh build. That is the guard's protection inverted, producing
--     exactly the defect this series exists to fix. The same trap bites the
--     REFERENCES clause from the other side: this database's search_path is
--     '"$user", public, build_events, app', so pg_get_constraintdef renders
--     build_events.ticket_comments as a bare "ticket_comments", which resolves
--     to the wrong table (or to nothing) under any other search_path.
--
--   * ADD CONSTRAINT ... NOT VALID first, VALIDATE CONSTRAINT as a separate
--     statement. A one-step ADD takes ACCESS EXCLUSIVE on BOTH tables while it
--     installs the triggers, so it stalls every write to both behind any long
--     read.
--
--   * Both halves are guarded on pg_constraint via to_regclass — never
--     ::regclass, which throws on a missing table. All of these already exist
--     on the database this was written against, so each file must be a no-op
--     there and the creating statement anywhere else.
--
--   * lock_timeout so a blocked ALTER fails fast instead of queueing and
--     blocking the table behind it.
-- =============================================================================

SET lock_timeout = '5s';
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.booking_link_interviewers') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_booking_link_interviewers_booking_link_id_org'
                     AND conrelid = to_regclass('public.booking_link_interviewers')) THEN
    ALTER TABLE "public"."booking_link_interviewers" ADD CONSTRAINT "fk_booking_link_interviewers_booking_link_id_org" FOREIGN KEY (org_id, booking_link_id) REFERENCES "public"."interview_booking_links"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_booking_link_interviewers_booking_link_id_org'
             AND conrelid = to_regclass('public.booking_link_interviewers') AND NOT convalidated) THEN
    ALTER TABLE "public"."booking_link_interviewers" VALIDATE CONSTRAINT "fk_booking_link_interviewers_booking_link_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.commissions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_commissions_deal_id_org'
                     AND conrelid = to_regclass('public.commissions')) THEN
    ALTER TABLE "public"."commissions" ADD CONSTRAINT "fk_commissions_deal_id_org" FOREIGN KEY (org_id, deal_id) REFERENCES "public"."deals"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_commissions_deal_id_org'
             AND conrelid = to_regclass('public.commissions') AND NOT convalidated) THEN
    ALTER TABLE "public"."commissions" VALIDATE CONSTRAINT "fk_commissions_deal_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.commissions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_commissions_rule_id_org'
                     AND conrelid = to_regclass('public.commissions')) THEN
    ALTER TABLE "public"."commissions" ADD CONSTRAINT "fk_commissions_rule_id_org" FOREIGN KEY (org_id, rule_id) REFERENCES "public"."commission_rules"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_commissions_rule_id_org'
             AND conrelid = to_regclass('public.commissions') AND NOT convalidated) THEN
    ALTER TABLE "public"."commissions" VALIDATE CONSTRAINT "fk_commissions_rule_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.incentives') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_incentives_client_account_id_org'
                     AND conrelid = to_regclass('public.incentives')) THEN
    ALTER TABLE "public"."incentives" ADD CONSTRAINT "fk_incentives_client_account_id_org" FOREIGN KEY (org_id, client_account_id) REFERENCES "public"."client_accounts"(org_id, id) NOT VALID;
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
  IF to_regclass('public.investment_proofs') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_investment_proofs_declaration_id_org'
                     AND conrelid = to_regclass('public.investment_proofs')) THEN
    ALTER TABLE "public"."investment_proofs" ADD CONSTRAINT "fk_investment_proofs_declaration_id_org" FOREIGN KEY (org_id, declaration_id) REFERENCES "public"."tax_declarations"(org_id, id) NOT VALID;
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
  IF to_regclass('public.payment_audit_events') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payment_audit_events_provider_id_org'
                     AND conrelid = to_regclass('public.payment_audit_events')) THEN
    ALTER TABLE "public"."payment_audit_events" ADD CONSTRAINT "fk_payment_audit_events_provider_id_org" FOREIGN KEY (org_id, provider_id) REFERENCES "public"."payment_providers"(org_id, id) NOT VALID;
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
DO $$ BEGIN
  IF to_regclass('public.payment_provider_accounts') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payment_provider_accounts_provider_id_org'
                     AND conrelid = to_regclass('public.payment_provider_accounts')) THEN
    ALTER TABLE "public"."payment_provider_accounts" ADD CONSTRAINT "fk_payment_provider_accounts_provider_id_org" FOREIGN KEY (org_id, provider_id) REFERENCES "public"."payment_providers"(org_id, id) NOT VALID;
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
    ALTER TABLE "public"."payment_provider_credentials" ADD CONSTRAINT "fk_payment_provider_credentials_provider_id_org" FOREIGN KEY (org_id, provider_id) REFERENCES "public"."payment_providers"(org_id, id) NOT VALID;
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
    ALTER TABLE "public"."payment_test_transactions" ADD CONSTRAINT "fk_payment_test_transactions_provider_id_org" FOREIGN KEY (org_id, provider_id) REFERENCES "public"."payment_providers"(org_id, id) NOT VALID;
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
    ALTER TABLE "public"."payment_webhook_endpoints" ADD CONSTRAINT "fk_payment_webhook_endpoints_provider_id_org" FOREIGN KEY (org_id, provider_id) REFERENCES "public"."payment_providers"(org_id, id) NOT VALID;
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
    ALTER TABLE "public"."payment_webhook_events" ADD CONSTRAINT "fk_payment_webhook_events_provider_id_org" FOREIGN KEY (org_id, provider_id) REFERENCES "public"."payment_providers"(org_id, id) NOT VALID;
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
    ALTER TABLE "public"."payments" ADD CONSTRAINT "fk_payments_invoice_id_org" FOREIGN KEY (org_id, invoice_id) REFERENCES "public"."invoices"(org_id, id) NOT VALID;
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
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_approvals_run_id_org'
                     AND conrelid = to_regclass('public.payroll_approvals')) THEN
    ALTER TABLE "public"."payroll_approvals" ADD CONSTRAINT "fk_payroll_approvals_run_id_org" FOREIGN KEY (org_id, run_id) REFERENCES "public"."payroll_runs"(org_id, id) NOT VALID;
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
    ALTER TABLE "public"."payroll_bank_batch_items" ADD CONSTRAINT "fk_payroll_bank_batch_items_batch_id_org" FOREIGN KEY (org_id, batch_id) REFERENCES "public"."payroll_bank_batches"(org_id, id) NOT VALID;
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
    ALTER TABLE "public"."payroll_bank_batch_items" ADD CONSTRAINT "fk_payroll_bank_batch_items_run_employee_id_org" FOREIGN KEY (org_id, run_employee_id) REFERENCES "public"."payroll_run_employees"(org_id, id) NOT VALID;
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
    ALTER TABLE "public"."payroll_bank_batches" ADD CONSTRAINT "fk_payroll_bank_batches_run_id_org" FOREIGN KEY (org_id, run_id) REFERENCES "public"."payroll_runs"(org_id, id) NOT VALID;
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
    ALTER TABLE "public"."payroll_calendar_events" ADD CONSTRAINT "fk_payroll_calendar_events_policy_id_org" FOREIGN KEY (org_id, policy_id) REFERENCES "public"."payroll_policies"(org_id, id) NOT VALID;
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
    ALTER TABLE "public"."payroll_command_receipts" ADD CONSTRAINT "fk_payroll_command_receipts_run_id_org" FOREIGN KEY (org_id, run_id) REFERENCES "public"."payroll_runs"(org_id, id) NOT VALID;
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
    ALTER TABLE "public"."payroll_exceptions" ADD CONSTRAINT "fk_payroll_exceptions_run_employee_id_org" FOREIGN KEY (org_id, run_employee_id) REFERENCES "public"."payroll_run_employees"(org_id, id) NOT VALID;
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
    ALTER TABLE "public"."payroll_exceptions" ADD CONSTRAINT "fk_payroll_exceptions_run_id_org" FOREIGN KEY (org_id, run_id) REFERENCES "public"."payroll_runs"(org_id, id) NOT VALID;
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
    ALTER TABLE "public"."payroll_filings" ADD CONSTRAINT "fk_payroll_filings_entity_id_org" FOREIGN KEY (org_id, entity_id) REFERENCES "public"."payroll_entities"(org_id, id) NOT VALID;
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
    ALTER TABLE "public"."payroll_filings" ADD CONSTRAINT "fk_payroll_filings_period_id_org" FOREIGN KEY (org_id, period_id) REFERENCES "public"."payroll_periods"(org_id, id) NOT VALID;
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
    ALTER TABLE "public"."payroll_inputs" ADD CONSTRAINT "fk_payroll_inputs_run_id_org" FOREIGN KEY (org_id, run_id) REFERENCES "public"."payroll_runs"(org_id, id) NOT VALID;
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
    ALTER TABLE "public"."payroll_jobs" ADD CONSTRAINT "fk_payroll_jobs_entity_id_org" FOREIGN KEY (org_id, entity_id) REFERENCES "public"."payroll_entities"(org_id, id) NOT VALID;
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
    ALTER TABLE "public"."payroll_journal_batch_lines" ADD CONSTRAINT "fk_payroll_journal_batch_lines_batch_id_org" FOREIGN KEY (org_id, batch_id) REFERENCES "public"."payroll_journal_batches"(org_id, id) NOT VALID;
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
    ALTER TABLE "public"."payroll_journal_batches" ADD CONSTRAINT "fk_payroll_journal_batches_entity_id_org" FOREIGN KEY (org_id, entity_id) REFERENCES "public"."payroll_entities"(org_id, id) NOT VALID;
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
    ALTER TABLE "public"."payroll_journal_batches" ADD CONSTRAINT "fk_payroll_journal_batches_reversal_of_batch_id_org" FOREIGN KEY (org_id, reversal_of_batch_id) REFERENCES "public"."payroll_journal_batches"(org_id, id) NOT VALID;
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
    ALTER TABLE "public"."payroll_journal_batches" ADD CONSTRAINT "fk_payroll_journal_batches_run_id_org" FOREIGN KEY (org_id, run_id) REFERENCES "public"."payroll_runs"(org_id, id) NOT VALID;
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
    ALTER TABLE "public"."payroll_line_items" ADD CONSTRAINT "fk_payroll_line_items_run_employee_id_org" FOREIGN KEY (org_id, run_employee_id) REFERENCES "public"."payroll_run_employees"(org_id, id) NOT VALID;
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
    ALTER TABLE "public"."payroll_line_items" ADD CONSTRAINT "fk_payroll_line_items_run_id_org" FOREIGN KEY (org_id, run_id) REFERENCES "public"."payroll_runs"(org_id, id) NOT VALID;
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
    ALTER TABLE "public"."payroll_loan_adjustments" ADD CONSTRAINT "fk_payroll_loan_adjustments_loan_id_org" FOREIGN KEY (org_id, loan_id) REFERENCES "public"."salary_loans"(org_id, id) NOT VALID;
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
    ALTER TABLE "public"."payroll_loan_adjustments" ADD CONSTRAINT "fk_payroll_loan_adjustments_run_id_org" FOREIGN KEY (org_id, run_id) REFERENCES "public"."payroll_runs"(org_id, id) NOT VALID;
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
    ALTER TABLE "public"."payroll_periods" ADD CONSTRAINT "fk_payroll_periods_entity_id_org" FOREIGN KEY (org_id, entity_id) REFERENCES "public"."payroll_entities"(org_id, id) NOT VALID;
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
    ALTER TABLE "public"."payroll_policy_versions" ADD CONSTRAINT "fk_payroll_policy_versions_policy_id_org" FOREIGN KEY (org_id, policy_id) REFERENCES "public"."payroll_policies"(org_id, id) NOT VALID;
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
    ALTER TABLE "public"."payroll_run_employees" ADD CONSTRAINT "fk_payroll_run_employees_run_id_org" FOREIGN KEY (org_id, run_id) REFERENCES "public"."payroll_runs"(org_id, id) NOT VALID;
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
    ALTER TABLE "public"."payroll_run_events" ADD CONSTRAINT "fk_payroll_run_events_run_id_org" FOREIGN KEY (org_id, run_id) REFERENCES "public"."payroll_runs"(org_id, id) NOT VALID;
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
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payroll_runs_policy_version_id_org'
                     AND conrelid = to_regclass('public.payroll_runs')) THEN
    ALTER TABLE "public"."payroll_runs" ADD CONSTRAINT "fk_payroll_runs_policy_version_id_org" FOREIGN KEY (org_id, policy_version_id) REFERENCES "public"."payroll_policy_versions"(org_id, id) NOT VALID;
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
    ALTER TABLE "public"."payroll_template_activations" ADD CONSTRAINT "fk_payroll_template_activations_policy_version_id_org" FOREIGN KEY (org_id, policy_version_id) REFERENCES "public"."payroll_policy_versions"(org_id, id) NOT VALID;
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
    ALTER TABLE "public"."payslip_publications" ADD CONSTRAINT "fk_payslip_publications_payslip_template_id_org" FOREIGN KEY (org_id, payslip_template_id) REFERENCES "public"."payslip_templates"(org_id, id) NOT VALID;
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
    ALTER TABLE "public"."payslip_publications" ADD CONSTRAINT "fk_payslip_publications_run_employee_id_org" FOREIGN KEY (org_id, run_employee_id) REFERENCES "public"."payroll_run_employees"(org_id, id) NOT VALID;
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
    ALTER TABLE "public"."payslip_publications" ADD CONSTRAINT "fk_payslip_publications_run_id_org" FOREIGN KEY (org_id, run_id) REFERENCES "public"."payroll_runs"(org_id, id) NOT VALID;
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
  IF to_regclass('public.timer_sessions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_timer_sessions_project_id_org'
                     AND conrelid = to_regclass('public.timer_sessions')) THEN
    ALTER TABLE "public"."timer_sessions" ADD CONSTRAINT "fk_timer_sessions_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES "build"."projects"(org_id, id) NOT VALID;
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
    ALTER TABLE "public"."timesheet_budgets" ADD CONSTRAINT "fk_timesheet_budgets_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES "build"."projects"(org_id, id) NOT VALID;
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
  IF to_regclass('public.timesheet_rates') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_timesheet_rates_project_id_org'
                     AND conrelid = to_regclass('public.timesheet_rates')) THEN
    ALTER TABLE "public"."timesheet_rates" ADD CONSTRAINT "fk_timesheet_rates_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES "build"."projects"(org_id, id) NOT VALID;
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
    ALTER TABLE "public"."timesheet_rates" ADD CONSTRAINT "fk_timesheet_rates_rate_card_id_org" FOREIGN KEY (org_id, rate_card_id) REFERENCES "public"."timesheet_rate_cards"(org_id, id) NOT VALID;
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
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_timesheets_payroll_export_id_org'
                     AND conrelid = to_regclass('public.timesheets')) THEN
    ALTER TABLE "public"."timesheets" ADD CONSTRAINT "fk_timesheets_payroll_export_id_org" FOREIGN KEY (org_id, payroll_export_id) REFERENCES "public"."timesheet_exports"(org_id, id) NOT VALID;
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
    ALTER TABLE "public"."timesheets" ADD CONSTRAINT "fk_timesheets_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES "build"."projects"(org_id, id) NOT VALID;
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
    ALTER TABLE "public"."timesheets" ADD CONSTRAINT "fk_timesheets_ticket_id_org" FOREIGN KEY (org_id, ticket_id) REFERENCES "build"."tickets"(org_id, id) NOT VALID;
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
    ALTER TABLE "public"."timesheets" ADD CONSTRAINT "fk_timesheets_timer_session_id_org" FOREIGN KEY (org_id, timer_session_id) REFERENCES "public"."timer_sessions"(org_id, id) NOT VALID;
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
    ALTER TABLE "public"."timesheets" ADD CONSTRAINT "fk_timesheets_timesheet_period_id_org" FOREIGN KEY (org_id, timesheet_period_id) REFERENCES "public"."timesheet_periods"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_timesheets_timesheet_period_id_org'
             AND conrelid = to_regclass('public.timesheets') AND NOT convalidated) THEN
    ALTER TABLE "public"."timesheets" VALIDATE CONSTRAINT "fk_timesheets_timesheet_period_id_org";
  END IF;
END $$;
