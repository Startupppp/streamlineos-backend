-- AR-02: enforce in the database the tenant relationships that only the Drizzle model declared; each had no foreign key at all. Parents are taken from the committed declaration, not inferred from the column name.

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE employee_salary_profiles DROP CONSTRAINT IF EXISTS "fk_employee_salary_profiles_policy_version_id_org";
--> statement-breakpoint
ALTER TABLE employee_salary_profiles
  ADD CONSTRAINT "fk_employee_salary_profiles_policy_version_id_org"
  FOREIGN KEY (org_id, policy_version_id)
  REFERENCES payroll_policy_versions (org_id, id)
  ON DELETE SET NULL (policy_version_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE employee_salary_profiles VALIDATE CONSTRAINT "fk_employee_salary_profiles_policy_version_id_org";
--> statement-breakpoint
ALTER TABLE hr_attendance_regularizations DROP CONSTRAINT IF EXISTS "fk_hr_attendance_regularizations_attendance_id_org";
--> statement-breakpoint
ALTER TABLE hr_attendance_regularizations
  ADD CONSTRAINT "fk_hr_attendance_regularizations_attendance_id_org"
  FOREIGN KEY (org_id, attendance_id)
  REFERENCES attendance (org_id, id)
  ON DELETE SET NULL (attendance_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_attendance_regularizations VALIDATE CONSTRAINT "fk_hr_attendance_regularizations_attendance_id_org";
--> statement-breakpoint
ALTER TABLE hr_disciplinary_actions DROP CONSTRAINT IF EXISTS "fk_hr_disciplinary_actions_letter_render_id_org";
--> statement-breakpoint
ALTER TABLE hr_disciplinary_actions
  ADD CONSTRAINT "fk_hr_disciplinary_actions_letter_render_id_org"
  FOREIGN KEY (org_id, letter_render_id)
  REFERENCES hr_template_renders (org_id, id)
  ON DELETE SET NULL (letter_render_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_disciplinary_actions VALIDATE CONSTRAINT "fk_hr_disciplinary_actions_letter_render_id_org";
--> statement-breakpoint
ALTER TABLE hr_form_submissions DROP CONSTRAINT IF EXISTS "fk_hr_form_submissions_workflow_instance_id_org";
--> statement-breakpoint
ALTER TABLE hr_form_submissions
  ADD CONSTRAINT "fk_hr_form_submissions_workflow_instance_id_org"
  FOREIGN KEY (org_id, workflow_instance_id)
  REFERENCES hr_workflow_instances (org_id, id)
  ON DELETE SET NULL (workflow_instance_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_form_submissions VALIDATE CONSTRAINT "fk_hr_form_submissions_workflow_instance_id_org";
--> statement-breakpoint
ALTER TABLE hr_loan_repayments DROP CONSTRAINT IF EXISTS "fk_hr_loan_repayments_loan_id_org";
--> statement-breakpoint
ALTER TABLE hr_loan_repayments
  ADD CONSTRAINT "fk_hr_loan_repayments_loan_id_org"
  FOREIGN KEY (org_id, loan_id)
  REFERENCES salary_loans (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_loan_repayments VALIDATE CONSTRAINT "fk_hr_loan_repayments_loan_id_org";
--> statement-breakpoint
ALTER TABLE hr_positions DROP CONSTRAINT IF EXISTS "fk_hr_positions_job_level_id_org";
--> statement-breakpoint
ALTER TABLE hr_positions
  ADD CONSTRAINT "fk_hr_positions_job_level_id_org"
  FOREIGN KEY (org_id, job_level_id)
  REFERENCES hr_job_levels (org_id, id)
  ON DELETE SET NULL (job_level_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_positions VALIDATE CONSTRAINT "fk_hr_positions_job_level_id_org";
--> statement-breakpoint
ALTER TABLE hr_template_renders DROP CONSTRAINT IF EXISTS "fk_hr_template_renders_rendered_for_employee_id_org";
--> statement-breakpoint
ALTER TABLE hr_template_renders
  ADD CONSTRAINT "fk_hr_template_renders_rendered_for_employee_id_org"
  FOREIGN KEY (org_id, rendered_for_employee_id)
  REFERENCES hr_employments (org_id, id)
  ON DELETE SET NULL (rendered_for_employee_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_template_renders VALIDATE CONSTRAINT "fk_hr_template_renders_rendered_for_employee_id_org";
--> statement-breakpoint
ALTER TABLE hr_travel_visit_logs DROP CONSTRAINT IF EXISTS "fk_hr_travel_visit_logs_travel_request_id_org";
--> statement-breakpoint
ALTER TABLE hr_travel_visit_logs
  ADD CONSTRAINT "fk_hr_travel_visit_logs_travel_request_id_org"
  FOREIGN KEY (org_id, travel_request_id)
  REFERENCES travel_requests (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_travel_visit_logs VALIDATE CONSTRAINT "fk_hr_travel_visit_logs_travel_request_id_org";
--> statement-breakpoint
ALTER TABLE job_requisitions DROP CONSTRAINT IF EXISTS "fk_job_requisitions_linked_job_id_org";
--> statement-breakpoint
ALTER TABLE job_requisitions
  ADD CONSTRAINT "fk_job_requisitions_linked_job_id_org"
  FOREIGN KEY (org_id, linked_job_id)
  REFERENCES job_postings (org_id, id)
  ON DELETE SET NULL (linked_job_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE job_requisitions VALIDATE CONSTRAINT "fk_job_requisitions_linked_job_id_org";
--> statement-breakpoint
ALTER TABLE journal_lines DROP CONSTRAINT IF EXISTS "fk_journal_lines_project_id_org";
--> statement-breakpoint
ALTER TABLE journal_lines
  ADD CONSTRAINT "fk_journal_lines_project_id_org"
  FOREIGN KEY (org_id, project_id)
  REFERENCES build.projects (org_id, id)
  ON DELETE SET NULL (project_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE journal_lines VALIDATE CONSTRAINT "fk_journal_lines_project_id_org";
--> statement-breakpoint
ALTER TABLE payroll_runs DROP CONSTRAINT IF EXISTS "fk_payroll_runs_period_id_org";
--> statement-breakpoint
ALTER TABLE payroll_runs
  ADD CONSTRAINT "fk_payroll_runs_period_id_org"
  FOREIGN KEY (org_id, period_id)
  REFERENCES hr_payroll_input_periods (org_id, id)
  ON DELETE SET NULL (period_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE payroll_runs VALIDATE CONSTRAINT "fk_payroll_runs_period_id_org";
--> statement-breakpoint
ALTER TABLE support_sla_policies DROP CONSTRAINT IF EXISTS "fk_support_sla_policies_business_hours_id_org";
--> statement-breakpoint
ALTER TABLE support_sla_policies
  ADD CONSTRAINT "fk_support_sla_policies_business_hours_id_org"
  FOREIGN KEY (org_id, business_hours_id)
  REFERENCES support_business_hours (org_id, id)
  ON DELETE SET NULL (business_hours_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE support_sla_policies VALIDATE CONSTRAINT "fk_support_sla_policies_business_hours_id_org";
--> statement-breakpoint
ALTER TABLE timer_sessions DROP CONSTRAINT IF EXISTS "fk_timer_sessions_ticket_id_org";
--> statement-breakpoint
ALTER TABLE timer_sessions
  ADD CONSTRAINT "fk_timer_sessions_ticket_id_org"
  FOREIGN KEY (org_id, ticket_id)
  REFERENCES build.tickets (org_id, id)
  ON DELETE SET NULL (ticket_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE timer_sessions VALIDATE CONSTRAINT "fk_timer_sessions_ticket_id_org";
