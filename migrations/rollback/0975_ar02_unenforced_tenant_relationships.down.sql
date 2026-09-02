-- 0975_ar02_unenforced_tenant_relationships DOWN — reverses the up migration; each restored constraint is rebuilt from the definition recorded in pg_catalog before it was dropped.

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE timer_sessions DROP CONSTRAINT IF EXISTS "fk_timer_sessions_ticket_id_org";
--> statement-breakpoint
ALTER TABLE support_sla_policies DROP CONSTRAINT IF EXISTS "fk_support_sla_policies_business_hours_id_org";
--> statement-breakpoint
ALTER TABLE payroll_runs DROP CONSTRAINT IF EXISTS "fk_payroll_runs_period_id_org";
--> statement-breakpoint
ALTER TABLE journal_lines DROP CONSTRAINT IF EXISTS "fk_journal_lines_project_id_org";
--> statement-breakpoint
ALTER TABLE job_requisitions DROP CONSTRAINT IF EXISTS "fk_job_requisitions_linked_job_id_org";
--> statement-breakpoint
ALTER TABLE hr_travel_visit_logs DROP CONSTRAINT IF EXISTS "fk_hr_travel_visit_logs_travel_request_id_org";
--> statement-breakpoint
ALTER TABLE hr_template_renders DROP CONSTRAINT IF EXISTS "fk_hr_template_renders_rendered_for_employee_id_org";
--> statement-breakpoint
ALTER TABLE hr_positions DROP CONSTRAINT IF EXISTS "fk_hr_positions_job_level_id_org";
--> statement-breakpoint
ALTER TABLE hr_loan_repayments DROP CONSTRAINT IF EXISTS "fk_hr_loan_repayments_loan_id_org";
--> statement-breakpoint
ALTER TABLE hr_form_submissions DROP CONSTRAINT IF EXISTS "fk_hr_form_submissions_workflow_instance_id_org";
--> statement-breakpoint
ALTER TABLE hr_disciplinary_actions DROP CONSTRAINT IF EXISTS "fk_hr_disciplinary_actions_letter_render_id_org";
--> statement-breakpoint
ALTER TABLE hr_attendance_regularizations DROP CONSTRAINT IF EXISTS "fk_hr_attendance_regularizations_attendance_id_org";
--> statement-breakpoint
ALTER TABLE employee_salary_profiles DROP CONSTRAINT IF EXISTS "fk_employee_salary_profiles_policy_version_id_org";
