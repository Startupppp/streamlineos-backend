-- 0966_ar02_canonical_tenant_fks_4 DOWN — reverses the up migration; each restored constraint is rebuilt from the definition recorded in pg_catalog before it was dropped.

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE public.payslip_publications DROP CONSTRAINT IF EXISTS "fk_payslip_publications_run_id_org";
--> statement-breakpoint
ALTER TABLE public.payslip_publications
  ADD CONSTRAINT "fk_payslip_publications_run_id_org"
  FOREIGN KEY (org_id, run_id)
  REFERENCES public.payroll_runs (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payslip_publications DROP CONSTRAINT IF EXISTS "fk_payslip_publications_run_employee_id_org";
--> statement-breakpoint
ALTER TABLE public.payslip_publications
  ADD CONSTRAINT "fk_payslip_publications_run_employee_id_org"
  FOREIGN KEY (org_id, run_employee_id)
  REFERENCES public.payroll_run_employees (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payslip_publications DROP CONSTRAINT IF EXISTS "fk_payslip_publications_payslip_template_id_org";
--> statement-breakpoint
ALTER TABLE public.payslip_publications
  ADD CONSTRAINT "fk_payslip_publications_payslip_template_id_org"
  FOREIGN KEY (org_id, payslip_template_id)
  REFERENCES public.payslip_templates (org_id, id)
  ON DELETE SET NULL (payslip_template_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_template_activations DROP CONSTRAINT IF EXISTS "fk_payroll_template_activations_policy_version_id_org";
--> statement-breakpoint
ALTER TABLE public.payroll_template_activations
  ADD CONSTRAINT "fk_payroll_template_activations_policy_version_id_org"
  FOREIGN KEY (org_id, policy_version_id)
  REFERENCES public.payroll_policy_versions (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_statutory_rule_sets DROP CONSTRAINT IF EXISTS "fk_payroll_statutory_rule_sets_entity_id_org";
--> statement-breakpoint
ALTER TABLE public.payroll_runs DROP CONSTRAINT IF EXISTS "fk_payroll_runs_policy_version_id_org";
--> statement-breakpoint
ALTER TABLE public.payroll_runs
  ADD CONSTRAINT "fk_payroll_runs_policy_version_id_org"
  FOREIGN KEY (org_id, policy_version_id)
  REFERENCES public.payroll_policy_versions (org_id, id)
  ON DELETE SET NULL (policy_version_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_run_events DROP CONSTRAINT IF EXISTS "fk_payroll_run_events_run_id_org";
--> statement-breakpoint
ALTER TABLE public.payroll_run_events
  ADD CONSTRAINT "fk_payroll_run_events_run_id_org"
  FOREIGN KEY (org_id, run_id)
  REFERENCES public.payroll_runs (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_policy_versions DROP CONSTRAINT IF EXISTS "fk_payroll_policy_versions_policy_id_org";
--> statement-breakpoint
ALTER TABLE public.payroll_policy_versions
  ADD CONSTRAINT "fk_payroll_policy_versions_policy_id_org"
  FOREIGN KEY (org_id, policy_id)
  REFERENCES public.payroll_policies (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_periods DROP CONSTRAINT IF EXISTS "fk_payroll_periods_entity_id_org";
--> statement-breakpoint
ALTER TABLE public.payroll_periods
  ADD CONSTRAINT "fk_payroll_periods_entity_id_org"
  FOREIGN KEY (org_id, entity_id)
  REFERENCES public.payroll_entities (org_id, id)
  ON DELETE SET NULL (entity_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_loan_adjustments DROP CONSTRAINT IF EXISTS "fk_payroll_loan_adjustments_run_id_org";
--> statement-breakpoint
ALTER TABLE public.payroll_loan_adjustments
  ADD CONSTRAINT "fk_payroll_loan_adjustments_run_id_org"
  FOREIGN KEY (org_id, run_id)
  REFERENCES public.payroll_runs (org_id, id)
  ON DELETE SET NULL (run_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_loan_adjustments DROP CONSTRAINT IF EXISTS "fk_payroll_loan_adjustments_loan_id_org";
--> statement-breakpoint
ALTER TABLE public.payroll_loan_adjustments
  ADD CONSTRAINT "fk_payroll_loan_adjustments_loan_id_org"
  FOREIGN KEY (org_id, loan_id)
  REFERENCES public.salary_loans (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_line_items DROP CONSTRAINT IF EXISTS "fk_payroll_line_items_run_id_org";
--> statement-breakpoint
ALTER TABLE public.payroll_line_items
  ADD CONSTRAINT "fk_payroll_line_items_run_id_org"
  FOREIGN KEY (org_id, run_id)
  REFERENCES public.payroll_runs (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_line_items DROP CONSTRAINT IF EXISTS "fk_payroll_line_items_run_employee_id_org";
--> statement-breakpoint
ALTER TABLE public.payroll_line_items
  ADD CONSTRAINT "fk_payroll_line_items_run_employee_id_org"
  FOREIGN KEY (org_id, run_employee_id)
  REFERENCES public.payroll_run_employees (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_journal_batches DROP CONSTRAINT IF EXISTS "fk_payroll_journal_batches_run_id_org";
--> statement-breakpoint
ALTER TABLE public.payroll_journal_batches
  ADD CONSTRAINT "fk_payroll_journal_batches_run_id_org"
  FOREIGN KEY (org_id, run_id)
  REFERENCES public.payroll_runs (org_id, id)
  ON DELETE SET NULL (run_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_journal_batches DROP CONSTRAINT IF EXISTS "fk_payroll_journal_batches_entity_id_org";
--> statement-breakpoint
ALTER TABLE public.payroll_journal_batches
  ADD CONSTRAINT "fk_payroll_journal_batches_entity_id_org"
  FOREIGN KEY (org_id, entity_id)
  REFERENCES public.payroll_entities (org_id, id)
  ON DELETE SET NULL (entity_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_journal_batch_lines DROP CONSTRAINT IF EXISTS "fk_payroll_journal_batch_lines_batch_id_org";
--> statement-breakpoint
ALTER TABLE public.payroll_journal_batch_lines
  ADD CONSTRAINT "fk_payroll_journal_batch_lines_batch_id_org"
  FOREIGN KEY (org_id, batch_id)
  REFERENCES public.payroll_journal_batches (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_jobs DROP CONSTRAINT IF EXISTS "fk_payroll_jobs_entity_id_org";
--> statement-breakpoint
ALTER TABLE public.payroll_jobs
  ADD CONSTRAINT "fk_payroll_jobs_entity_id_org"
  FOREIGN KEY (org_id, entity_id)
  REFERENCES public.payroll_entities (org_id, id)
  ON DELETE SET NULL (entity_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_inputs DROP CONSTRAINT IF EXISTS "fk_payroll_inputs_run_id_org";
--> statement-breakpoint
ALTER TABLE public.payroll_inputs
  ADD CONSTRAINT "fk_payroll_inputs_run_id_org"
  FOREIGN KEY (org_id, run_id)
  REFERENCES public.payroll_runs (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_filings DROP CONSTRAINT IF EXISTS "fk_payroll_filings_period_id_org";
--> statement-breakpoint
ALTER TABLE public.payroll_filings
  ADD CONSTRAINT "fk_payroll_filings_period_id_org"
  FOREIGN KEY (org_id, period_id)
  REFERENCES public.payroll_periods (org_id, id)
  ON DELETE SET NULL (period_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_filings DROP CONSTRAINT IF EXISTS "fk_payroll_filings_entity_id_org";
--> statement-breakpoint
ALTER TABLE public.payroll_filings
  ADD CONSTRAINT "fk_payroll_filings_entity_id_org"
  FOREIGN KEY (org_id, entity_id)
  REFERENCES public.payroll_entities (org_id, id)
  ON DELETE SET NULL (entity_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_exceptions DROP CONSTRAINT IF EXISTS "fk_payroll_exceptions_run_id_org";
--> statement-breakpoint
ALTER TABLE public.payroll_exceptions
  ADD CONSTRAINT "fk_payroll_exceptions_run_id_org"
  FOREIGN KEY (org_id, run_id)
  REFERENCES public.payroll_runs (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_exceptions DROP CONSTRAINT IF EXISTS "fk_payroll_exceptions_run_employee_id_org";
--> statement-breakpoint
ALTER TABLE public.payroll_exceptions
  ADD CONSTRAINT "fk_payroll_exceptions_run_employee_id_org"
  FOREIGN KEY (org_id, run_employee_id)
  REFERENCES public.payroll_run_employees (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_entities DROP CONSTRAINT IF EXISTS "fk_payroll_entities_legal_entity_id_org";
--> statement-breakpoint
ALTER TABLE public.payroll_command_receipts DROP CONSTRAINT IF EXISTS "fk_payroll_command_receipts_run_id_org";
--> statement-breakpoint
ALTER TABLE public.payroll_command_receipts
  ADD CONSTRAINT "fk_payroll_command_receipts_run_id_org"
  FOREIGN KEY (org_id, run_id)
  REFERENCES public.payroll_runs (org_id, id)
  ON DELETE SET NULL (run_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_calendar_events DROP CONSTRAINT IF EXISTS "fk_payroll_calendar_events_policy_id_org";
--> statement-breakpoint
ALTER TABLE public.payroll_calendar_events
  ADD CONSTRAINT "fk_payroll_calendar_events_policy_id_org"
  FOREIGN KEY (org_id, policy_id)
  REFERENCES public.payroll_policies (org_id, id)
  ON DELETE SET NULL (policy_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_bank_batches DROP CONSTRAINT IF EXISTS "fk_payroll_bank_batches_run_id_org";
--> statement-breakpoint
ALTER TABLE public.payroll_bank_batches
  ADD CONSTRAINT "fk_payroll_bank_batches_run_id_org"
  FOREIGN KEY (org_id, run_id)
  REFERENCES public.payroll_runs (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_bank_batch_items DROP CONSTRAINT IF EXISTS "fk_payroll_bank_batch_items_run_employee_id_org";
--> statement-breakpoint
ALTER TABLE public.payroll_bank_batch_items
  ADD CONSTRAINT "fk_payroll_bank_batch_items_run_employee_id_org"
  FOREIGN KEY (org_id, run_employee_id)
  REFERENCES public.payroll_run_employees (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_bank_batch_items DROP CONSTRAINT IF EXISTS "fk_payroll_bank_batch_items_batch_id_org";
--> statement-breakpoint
ALTER TABLE public.payroll_bank_batch_items
  ADD CONSTRAINT "fk_payroll_bank_batch_items_batch_id_org"
  FOREIGN KEY (org_id, batch_id)
  REFERENCES public.payroll_bank_batches (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_approvals DROP CONSTRAINT IF EXISTS "fk_payroll_approvals_run_id_org";
--> statement-breakpoint
ALTER TABLE public.payroll_approvals
  ADD CONSTRAINT "fk_payroll_approvals_run_id_org"
  FOREIGN KEY (org_id, run_id)
  REFERENCES public.payroll_runs (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payments DROP CONSTRAINT IF EXISTS "fk_payments_invoice_id_org";
--> statement-breakpoint
ALTER TABLE public.payments
  ADD CONSTRAINT "fk_payments_invoice_id_org"
  FOREIGN KEY (org_id, invoice_id)
  REFERENCES public.invoices (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payment_webhook_events DROP CONSTRAINT IF EXISTS "fk_payment_webhook_events_provider_id_org";
--> statement-breakpoint
ALTER TABLE public.payment_webhook_events
  ADD CONSTRAINT "fk_payment_webhook_events_provider_id_org"
  FOREIGN KEY (org_id, provider_id)
  REFERENCES public.payment_providers (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payment_webhook_endpoints DROP CONSTRAINT IF EXISTS "fk_payment_webhook_endpoints_provider_id_org";
--> statement-breakpoint
ALTER TABLE public.payment_webhook_endpoints
  ADD CONSTRAINT "fk_payment_webhook_endpoints_provider_id_org"
  FOREIGN KEY (org_id, provider_id)
  REFERENCES public.payment_providers (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payment_test_transactions DROP CONSTRAINT IF EXISTS "fk_payment_test_transactions_provider_id_org";
--> statement-breakpoint
ALTER TABLE public.payment_test_transactions
  ADD CONSTRAINT "fk_payment_test_transactions_provider_id_org"
  FOREIGN KEY (org_id, provider_id)
  REFERENCES public.payment_providers (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payment_provider_credentials DROP CONSTRAINT IF EXISTS "fk_payment_provider_credentials_provider_id_org";
--> statement-breakpoint
ALTER TABLE public.payment_provider_credentials
  ADD CONSTRAINT "fk_payment_provider_credentials_provider_id_org"
  FOREIGN KEY (org_id, provider_id)
  REFERENCES public.payment_providers (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payment_provider_accounts DROP CONSTRAINT IF EXISTS "fk_payment_provider_accounts_provider_id_org";
--> statement-breakpoint
ALTER TABLE public.payment_provider_accounts
  ADD CONSTRAINT "fk_payment_provider_accounts_provider_id_org"
  FOREIGN KEY (org_id, provider_id)
  REFERENCES public.payment_providers (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payment_audit_events DROP CONSTRAINT IF EXISTS "fk_payment_audit_events_provider_id_org";
