-- 0969_ar02_canonical_tenant_fks_7 DOWN — reverses the up migration; each restored constraint is rebuilt from the definition recorded in pg_catalog before it was dropped.

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE public.webhook_logs DROP CONSTRAINT IF EXISTS "fk_webhook_logs_endpoint_id_org";
--> statement-breakpoint
ALTER TABLE public.webhook_logs
  ADD CONSTRAINT "fk_webhook_logs_endpoint_id_org"
  FOREIGN KEY (org_id, endpoint_id)
  REFERENCES public.webhook_endpoints (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.vendor_payments DROP CONSTRAINT IF EXISTS "fk_vendor_payments_bill_id_org";
--> statement-breakpoint
ALTER TABLE public.vendor_payments
  ADD CONSTRAINT "fk_vendor_payments_bill_id_org"
  FOREIGN KEY (org_id, bill_id)
  REFERENCES public.purchase_bills (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.timesheets DROP CONSTRAINT IF EXISTS "fk_timesheets_payroll_export_id_org";
--> statement-breakpoint
ALTER TABLE public.timesheets
  ADD CONSTRAINT "fk_timesheets_payroll_export_id_org"
  FOREIGN KEY (org_id, payroll_export_id)
  REFERENCES public.timesheet_exports (org_id, id)
  ON DELETE SET NULL (payroll_export_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.timer_sessions DROP CONSTRAINT IF EXISTS "fk_timer_sessions_project_id_org";
--> statement-breakpoint
ALTER TABLE public.timer_sessions
  ADD CONSTRAINT "fk_timer_sessions_project_id_org"
  FOREIGN KEY (org_id, project_id)
  REFERENCES build.projects (org_id, id)
  ON DELETE SET NULL (project_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.team_event_participants DROP CONSTRAINT IF EXISTS "fk_team_event_participants_event_id_org";
--> statement-breakpoint
ALTER TABLE public.team_event_participants
  ADD CONSTRAINT "fk_team_event_participants_event_id_org"
  FOREIGN KEY (org_id, event_id)
  REFERENCES public.team_events (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.tax_registrations DROP CONSTRAINT IF EXISTS "fk_tax_registrations_party_id_org";
--> statement-breakpoint
ALTER TABLE public.tax_registrations DROP CONSTRAINT IF EXISTS "fk_tax_registrations_book_id_org";
--> statement-breakpoint
ALTER TABLE public.tax_rates DROP CONSTRAINT IF EXISTS "fk_tax_rates_tax_code_id_org";
--> statement-breakpoint
ALTER TABLE public.tax_gl_map DROP CONSTRAINT IF EXISTS "fk_tax_gl_map_book_id_org";
--> statement-breakpoint
ALTER TABLE public.tax_gl_map DROP CONSTRAINT IF EXISTS "fk_tax_gl_map_account_id_org";
--> statement-breakpoint
ALTER TABLE public.tax_document_lines DROP CONSTRAINT IF EXISTS "fk_tax_document_lines_tax_code_id_org";
--> statement-breakpoint
ALTER TABLE public.tax_document_lines DROP CONSTRAINT IF EXISTS "fk_tax_document_lines_gl_account_id_org";
--> statement-breakpoint
ALTER TABLE public.tax_document_lines DROP CONSTRAINT IF EXISTS "fk_tax_document_lines_book_id_org";
--> statement-breakpoint
ALTER TABLE public.tax_codes DROP CONSTRAINT IF EXISTS "fk_tax_codes_book_id_org";
--> statement-breakpoint
ALTER TABLE public.tasks DROP CONSTRAINT IF EXISTS "fk_tasks_parent_task_id_org";
--> statement-breakpoint
ALTER TABLE public.tasks
  ADD CONSTRAINT "fk_tasks_parent_task_id_org"
  FOREIGN KEY (org_id, parent_task_id)
  REFERENCES public.tasks (org_id, id)
  ON DELETE SET NULL (parent_task_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.task_sequence_steps DROP CONSTRAINT IF EXISTS "fk_task_sequence_steps_sequence_id_org";
--> statement-breakpoint
ALTER TABLE public.task_sequence_steps
  ADD CONSTRAINT "fk_task_sequence_steps_sequence_id_org"
  FOREIGN KEY (org_id, sequence_id)
  REFERENCES public.task_sequences (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_versions DROP CONSTRAINT IF EXISTS "fk_survey_versions_survey_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_versions
  ADD CONSTRAINT "fk_survey_versions_survey_id_org"
  FOREIGN KEY (org_id, survey_id)
  REFERENCES public.survey_forms (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_sections DROP CONSTRAINT IF EXISTS "fk_survey_sections_version_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_sections
  ADD CONSTRAINT "fk_survey_sections_version_id_org"
  FOREIGN KEY (org_id, version_id)
  REFERENCES public.survey_versions (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
