-- 0952_ar02_hr_core_composite_fks_1 DOWN — drops every constraint and index the up migration added.

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE hr_leave_ledger DROP CONSTRAINT IF EXISTS "fk_hr_leave_ledger_org_leave_type";
--> statement-breakpoint
ALTER TABLE hr_insurance_claims DROP CONSTRAINT IF EXISTS "fk_hr_insurance_claims_org_plan";
--> statement-breakpoint
ALTER TABLE hr_import_rows DROP CONSTRAINT IF EXISTS "fk_hr_import_rows_org_job";
--> statement-breakpoint
ALTER TABLE hr_helpdesk_comments DROP CONSTRAINT IF EXISTS "fk_hr_helpdesk_comments_org_ticket";
--> statement-breakpoint
ALTER TABLE hr_headcount_plans DROP CONSTRAINT IF EXISTS "fk_hr_headcount_plans_org_department";
--> statement-breakpoint
ALTER TABLE hr_form_submissions DROP CONSTRAINT IF EXISTS "fk_hr_form_submissions_org_form";
--> statement-breakpoint
ALTER TABLE hr_equity_vesting_events DROP CONSTRAINT IF EXISTS "fk_hr_equity_vesting_events_org_grant";
--> statement-breakpoint
ALTER TABLE hr_equity_exercises DROP CONSTRAINT IF EXISTS "fk_hr_equity_exercises_org_grant";
--> statement-breakpoint
ALTER TABLE hr_employments DROP CONSTRAINT IF EXISTS "fk_hr_employments_org_location";
--> statement-breakpoint
ALTER TABLE hr_employments DROP CONSTRAINT IF EXISTS "fk_hr_employments_org_department";
--> statement-breakpoint
ALTER TABLE hr_employments DROP CONSTRAINT IF EXISTS "fk_hr_employments_org_person";
--> statement-breakpoint
ALTER TABLE hr_employments DROP CONSTRAINT IF EXISTS "fk_hr_employments_org_job_role";
--> statement-breakpoint
ALTER TABLE hr_employments DROP CONSTRAINT IF EXISTS "fk_hr_employments_org_job_level";
--> statement-breakpoint
ALTER TABLE hr_employment_history DROP CONSTRAINT IF EXISTS "fk_hr_employment_history_org_employment";
--> statement-breakpoint
ALTER TABLE hr_employment_custom_field_values DROP CONSTRAINT IF EXISTS "fk_hr_employment_custom_field_values_org_employment";
--> statement-breakpoint
ALTER TABLE hr_employment_custom_field_values DROP CONSTRAINT IF EXISTS "fk_hr_employment_custom_field_values_org_field_def";
--> statement-breakpoint
ALTER TABLE hr_employee_sensitive_fields DROP CONSTRAINT IF EXISTS "fk_hr_employee_sensitive_fields_org_employment";
--> statement-breakpoint
ALTER TABLE hr_emergency_responses DROP CONSTRAINT IF EXISTS "fk_hr_emergency_responses_org_event";
--> statement-breakpoint
ALTER TABLE hr_effective_dated_changes DROP CONSTRAINT IF EXISTS "fk_hr_effective_dated_changes_org_employment";
--> statement-breakpoint
ALTER TABLE hr_disciplinary_actions DROP CONSTRAINT IF EXISTS "fk_hr_disciplinary_actions_org_case";
--> statement-breakpoint
ALTER TABLE hr_device_sync_logs DROP CONSTRAINT IF EXISTS "fk_hr_device_sync_logs_org_device";
--> statement-breakpoint
ALTER TABLE hr_device_employee_mappings DROP CONSTRAINT IF EXISTS "fk_hr_device_employee_mappings_org_device";
--> statement-breakpoint
ALTER TABLE hr_contracts DROP CONSTRAINT IF EXISTS "fk_hr_contracts_org_employment";
--> statement-breakpoint
ALTER TABLE hr_compliance_events DROP CONSTRAINT IF EXISTS "fk_hr_compliance_events_org_requirement";
--> statement-breakpoint
ALTER TABLE hr_comp_recommendations DROP CONSTRAINT IF EXISTS "fk_hr_comp_recommendations_org_cycle";
--> statement-breakpoint
ALTER TABLE hr_comp_budget_pools DROP CONSTRAINT IF EXISTS "fk_hr_comp_budget_pools_org_department";
--> statement-breakpoint
ALTER TABLE hr_comp_budget_pools DROP CONSTRAINT IF EXISTS "fk_hr_comp_budget_pools_org_cycle";
--> statement-breakpoint
ALTER TABLE hr_community_members DROP CONSTRAINT IF EXISTS "fk_hr_community_members_org_community";
--> statement-breakpoint
ALTER TABLE hr_case_notes DROP CONSTRAINT IF EXISTS "fk_hr_case_notes_org_case";
--> statement-breakpoint
ALTER TABLE hr_case_documents DROP CONSTRAINT IF EXISTS "fk_hr_case_documents_org_case";
--> statement-breakpoint
ALTER TABLE hr_calibration_entries DROP CONSTRAINT IF EXISTS "fk_hr_calibration_entries_org_cycle";
--> statement-breakpoint
ALTER TABLE hr_benefit_enrollments DROP CONSTRAINT IF EXISTS "fk_hr_benefit_enrollments_org_plan";
--> statement-breakpoint
ALTER TABLE hr_benefit_enrollment_windows DROP CONSTRAINT IF EXISTS "fk_hr_benefit_enrollment_windows_org_plan";
--> statement-breakpoint
ALTER TABLE hr_badge_awards DROP CONSTRAINT IF EXISTS "fk_hr_badge_awards_org_badge";
--> statement-breakpoint
ALTER TABLE hr_automation_runs DROP CONSTRAINT IF EXISTS "fk_hr_automation_runs_org_rule";
--> statement-breakpoint
ALTER TABLE hr_accommodation_tasks DROP CONSTRAINT IF EXISTS "fk_hr_accommodation_tasks_org_request";
