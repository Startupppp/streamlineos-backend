-- 0953_ar02_hr_core_composite_fks_2 DOWN — drops every constraint and index the up migration added.

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE leave_requests DROP CONSTRAINT IF EXISTS "fk_leave_requests_org_leave_type";
--> statement-breakpoint
ALTER TABLE leave_policies DROP CONSTRAINT IF EXISTS "fk_leave_policies_org_leave_type";
--> statement-breakpoint
ALTER TABLE leave_balances DROP CONSTRAINT IF EXISTS "fk_leave_balances_org_leave_type";
--> statement-breakpoint
ALTER TABLE hr_workflow_steps DROP CONSTRAINT IF EXISTS "fk_hr_workflow_steps_org_definition";
--> statement-breakpoint
ALTER TABLE hr_workflow_step_actions DROP CONSTRAINT IF EXISTS "fk_hr_workflow_step_actions_org_instance";
--> statement-breakpoint
ALTER TABLE hr_workflow_instances DROP CONSTRAINT IF EXISTS "fk_hr_workflow_instances_org_definition";
--> statement-breakpoint
ALTER TABLE hr_work_authorizations DROP CONSTRAINT IF EXISTS "fk_hr_work_authorizations_org_employment";
--> statement-breakpoint
ALTER TABLE hr_webhook_deliveries DROP CONSTRAINT IF EXISTS "fk_hr_webhook_deliveries_org_subscription";
--> statement-breakpoint
ALTER TABLE hr_time_devices DROP CONSTRAINT IF EXISTS "fk_hr_time_devices_org_location";
--> statement-breakpoint
ALTER TABLE hr_template_renders DROP CONSTRAINT IF EXISTS "fk_hr_template_renders_org_template";
--> statement-breakpoint
ALTER TABLE hr_succession_plans DROP CONSTRAINT IF EXISTS "fk_hr_succession_plans_org_job_role";
--> statement-breakpoint
ALTER TABLE hr_role_skill_requirements DROP CONSTRAINT IF EXISTS "fk_hr_role_skill_requirements_org_job_role";
--> statement-breakpoint
ALTER TABLE hr_reporting_lines DROP CONSTRAINT IF EXISTS "fk_hr_reporting_lines_org_manager_employment";
--> statement-breakpoint
ALTER TABLE hr_reporting_lines DROP CONSTRAINT IF EXISTS "fk_hr_reporting_lines_org_employment";
--> statement-breakpoint
ALTER TABLE hr_probation_reviews DROP CONSTRAINT IF EXISTS "fk_hr_probation_reviews_org_review_template";
--> statement-breakpoint
ALTER TABLE hr_probation_reviews DROP CONSTRAINT IF EXISTS "fk_hr_probation_reviews_org_person";
--> statement-breakpoint
ALTER TABLE hr_probation_reviews DROP CONSTRAINT IF EXISTS "fk_hr_probation_reviews_org_employment";
--> statement-breakpoint
ALTER TABLE hr_positions DROP CONSTRAINT IF EXISTS "fk_hr_positions_org_department";
--> statement-breakpoint
ALTER TABLE hr_position_transitions DROP CONSTRAINT IF EXISTS "fk_hr_position_transitions_org_to_status";
--> statement-breakpoint
ALTER TABLE hr_position_transitions DROP CONSTRAINT IF EXISTS "fk_hr_position_transitions_org_from_status";
--> statement-breakpoint
ALTER TABLE hr_poll_votes DROP CONSTRAINT IF EXISTS "fk_hr_poll_votes_org_poll";
--> statement-breakpoint
ALTER TABLE hr_policy_scopes DROP CONSTRAINT IF EXISTS "fk_hr_policy_scopes_org_policy";
--> statement-breakpoint
ALTER TABLE hr_payroll_input_snapshots DROP CONSTRAINT IF EXISTS "fk_hr_payroll_input_snapshots_org_period";
--> statement-breakpoint
ALTER TABLE hr_payroll_adjustments DROP CONSTRAINT IF EXISTS "fk_hr_payroll_adjustments_org_period";
--> statement-breakpoint
ALTER TABLE hr_legal_hold_items DROP CONSTRAINT IF EXISTS "fk_hr_legal_hold_items_org_hold";
