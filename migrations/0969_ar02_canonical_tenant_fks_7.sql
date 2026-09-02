-- AR-02: canonical (org_id, child_id) -> (org_id, id) tenant foreign keys, part 7 of 7; the referential action of the single-column constraint being superseded is preserved.

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE public.survey_sections DROP CONSTRAINT "fk_survey_sections_version_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_sections
  ADD CONSTRAINT "fk_survey_sections_version_id_org"
  FOREIGN KEY (org_id, version_id)
  REFERENCES public.survey_versions (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_sections VALIDATE CONSTRAINT "fk_survey_sections_version_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_versions DROP CONSTRAINT "fk_survey_versions_survey_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_versions
  ADD CONSTRAINT "fk_survey_versions_survey_id_org"
  FOREIGN KEY (org_id, survey_id)
  REFERENCES public.survey_forms (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_versions VALIDATE CONSTRAINT "fk_survey_versions_survey_id_org";
--> statement-breakpoint
ALTER TABLE public.task_sequence_steps DROP CONSTRAINT "fk_task_sequence_steps_sequence_id_org";
--> statement-breakpoint
ALTER TABLE public.task_sequence_steps
  ADD CONSTRAINT "fk_task_sequence_steps_sequence_id_org"
  FOREIGN KEY (org_id, sequence_id)
  REFERENCES public.task_sequences (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.task_sequence_steps VALIDATE CONSTRAINT "fk_task_sequence_steps_sequence_id_org";
--> statement-breakpoint
ALTER TABLE public.tasks DROP CONSTRAINT "fk_tasks_parent_task_id_org";
--> statement-breakpoint
ALTER TABLE public.tasks
  ADD CONSTRAINT "fk_tasks_parent_task_id_org"
  FOREIGN KEY (org_id, parent_task_id)
  REFERENCES public.tasks (org_id, id)
  ON DELETE SET NULL (parent_task_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.tasks VALIDATE CONSTRAINT "fk_tasks_parent_task_id_org";
--> statement-breakpoint
ALTER TABLE public.tax_codes
  ADD CONSTRAINT "fk_tax_codes_book_id_org"
  FOREIGN KEY (org_id, book_id)
  REFERENCES public.gl_books (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.tax_codes VALIDATE CONSTRAINT "fk_tax_codes_book_id_org";
--> statement-breakpoint
ALTER TABLE public.tax_document_lines
  ADD CONSTRAINT "fk_tax_document_lines_book_id_org"
  FOREIGN KEY (org_id, book_id)
  REFERENCES public.gl_books (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.tax_document_lines VALIDATE CONSTRAINT "fk_tax_document_lines_book_id_org";
--> statement-breakpoint
ALTER TABLE public.tax_document_lines
  ADD CONSTRAINT "fk_tax_document_lines_gl_account_id_org"
  FOREIGN KEY (org_id, gl_account_id)
  REFERENCES public.gl_accounts (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.tax_document_lines VALIDATE CONSTRAINT "fk_tax_document_lines_gl_account_id_org";
--> statement-breakpoint
ALTER TABLE public.tax_document_lines
  ADD CONSTRAINT "fk_tax_document_lines_tax_code_id_org"
  FOREIGN KEY (org_id, tax_code_id)
  REFERENCES public.tax_codes (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.tax_document_lines VALIDATE CONSTRAINT "fk_tax_document_lines_tax_code_id_org";
--> statement-breakpoint
ALTER TABLE public.tax_gl_map
  ADD CONSTRAINT "fk_tax_gl_map_account_id_org"
  FOREIGN KEY (org_id, account_id)
  REFERENCES public.gl_accounts (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.tax_gl_map VALIDATE CONSTRAINT "fk_tax_gl_map_account_id_org";
--> statement-breakpoint
ALTER TABLE public.tax_gl_map
  ADD CONSTRAINT "fk_tax_gl_map_book_id_org"
  FOREIGN KEY (org_id, book_id)
  REFERENCES public.gl_books (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.tax_gl_map VALIDATE CONSTRAINT "fk_tax_gl_map_book_id_org";
--> statement-breakpoint
ALTER TABLE public.tax_rates
  ADD CONSTRAINT "fk_tax_rates_tax_code_id_org"
  FOREIGN KEY (org_id, tax_code_id)
  REFERENCES public.tax_codes (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.tax_rates VALIDATE CONSTRAINT "fk_tax_rates_tax_code_id_org";
--> statement-breakpoint
ALTER TABLE public.tax_registrations
  ADD CONSTRAINT "fk_tax_registrations_book_id_org"
  FOREIGN KEY (org_id, book_id)
  REFERENCES public.gl_books (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.tax_registrations VALIDATE CONSTRAINT "fk_tax_registrations_book_id_org";
--> statement-breakpoint
ALTER TABLE public.tax_registrations
  ADD CONSTRAINT "fk_tax_registrations_party_id_org"
  FOREIGN KEY (org_id, party_id)
  REFERENCES public.gl_parties (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.tax_registrations VALIDATE CONSTRAINT "fk_tax_registrations_party_id_org";
--> statement-breakpoint
ALTER TABLE public.team_event_participants DROP CONSTRAINT "fk_team_event_participants_event_id_org";
--> statement-breakpoint
ALTER TABLE public.team_event_participants
  ADD CONSTRAINT "fk_team_event_participants_event_id_org"
  FOREIGN KEY (org_id, event_id)
  REFERENCES public.team_events (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.team_event_participants VALIDATE CONSTRAINT "fk_team_event_participants_event_id_org";
--> statement-breakpoint
ALTER TABLE public.timer_sessions DROP CONSTRAINT "fk_timer_sessions_project_id_org";
--> statement-breakpoint
ALTER TABLE public.timer_sessions
  ADD CONSTRAINT "fk_timer_sessions_project_id_org"
  FOREIGN KEY (org_id, project_id)
  REFERENCES build.projects (org_id, id)
  ON DELETE SET NULL (project_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.timer_sessions VALIDATE CONSTRAINT "fk_timer_sessions_project_id_org";
--> statement-breakpoint
ALTER TABLE public.timesheets DROP CONSTRAINT "fk_timesheets_payroll_export_id_org";
--> statement-breakpoint
ALTER TABLE public.timesheets
  ADD CONSTRAINT "fk_timesheets_payroll_export_id_org"
  FOREIGN KEY (org_id, payroll_export_id)
  REFERENCES public.timesheet_exports (org_id, id)
  ON DELETE SET NULL (payroll_export_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.timesheets VALIDATE CONSTRAINT "fk_timesheets_payroll_export_id_org";
--> statement-breakpoint
ALTER TABLE public.vendor_payments DROP CONSTRAINT "fk_vendor_payments_bill_id_org";
--> statement-breakpoint
ALTER TABLE public.vendor_payments
  ADD CONSTRAINT "fk_vendor_payments_bill_id_org"
  FOREIGN KEY (org_id, bill_id)
  REFERENCES public.purchase_bills (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.vendor_payments VALIDATE CONSTRAINT "fk_vendor_payments_bill_id_org";
--> statement-breakpoint
ALTER TABLE public.webhook_logs DROP CONSTRAINT "fk_webhook_logs_endpoint_id_org";
--> statement-breakpoint
ALTER TABLE public.webhook_logs
  ADD CONSTRAINT "fk_webhook_logs_endpoint_id_org"
  FOREIGN KEY (org_id, endpoint_id)
  REFERENCES public.webhook_endpoints (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.webhook_logs VALIDATE CONSTRAINT "fk_webhook_logs_endpoint_id_org";
