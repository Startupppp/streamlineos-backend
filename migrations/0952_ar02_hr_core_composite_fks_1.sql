-- AR-02: composite tenant FKs — HR core part 1
-- Covers: hr_accommodation_tasks, hr_automation_runs, hr_badge_awards,
--         hr_benefit_*, hr_calibration_entries, hr_case_*, hr_community_members,
--         hr_comp_*, hr_compliance_events, hr_contracts, hr_device_*,
--         hr_disciplinary_actions, hr_effective_dated_changes, hr_emergency_responses,
--         hr_employee_sensitive_fields, hr_employment_custom_field_values,
--         hr_employment_history, hr_employments, hr_equity_*, hr_form_submissions,
--         hr_headcount_plans, hr_helpdesk_comments, hr_import_rows,
--         hr_insurance_claims, hr_leave_ledger

SET lock_timeout = DEFAULT;

ALTER TABLE hr_accommodation_tasks
  ADD CONSTRAINT fk_hr_accommodation_tasks_org_request
  FOREIGN KEY (org_id, request_id)
  REFERENCES hr_accommodation_requests (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE hr_accommodation_tasks VALIDATE CONSTRAINT fk_hr_accommodation_tasks_org_request;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE hr_automation_runs
  ADD CONSTRAINT fk_hr_automation_runs_org_rule
  FOREIGN KEY (org_id, rule_id)
  REFERENCES hr_automation_rules (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE hr_automation_runs VALIDATE CONSTRAINT fk_hr_automation_runs_org_rule;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE hr_badge_awards
  ADD CONSTRAINT fk_hr_badge_awards_org_badge
  FOREIGN KEY (org_id, badge_id)
  REFERENCES hr_badges (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE hr_badge_awards VALIDATE CONSTRAINT fk_hr_badge_awards_org_badge;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE hr_benefit_enrollment_windows
  ADD CONSTRAINT fk_hr_benefit_enrollment_windows_org_plan
  FOREIGN KEY (org_id, plan_id)
  REFERENCES hr_benefit_plans (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE hr_benefit_enrollment_windows VALIDATE CONSTRAINT fk_hr_benefit_enrollment_windows_org_plan;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE hr_benefit_enrollments
  ADD CONSTRAINT fk_hr_benefit_enrollments_org_plan
  FOREIGN KEY (org_id, plan_id)
  REFERENCES hr_benefit_plans (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE hr_benefit_enrollments VALIDATE CONSTRAINT fk_hr_benefit_enrollments_org_plan;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE hr_calibration_entries
  ADD CONSTRAINT fk_hr_calibration_entries_org_cycle
  FOREIGN KEY (org_id, cycle_id)
  REFERENCES review_cycles (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE hr_calibration_entries VALIDATE CONSTRAINT fk_hr_calibration_entries_org_cycle;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE hr_case_documents
  ADD CONSTRAINT fk_hr_case_documents_org_case
  FOREIGN KEY (org_id, case_id)
  REFERENCES hr_cases (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE hr_case_documents VALIDATE CONSTRAINT fk_hr_case_documents_org_case;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE hr_case_notes
  ADD CONSTRAINT fk_hr_case_notes_org_case
  FOREIGN KEY (org_id, case_id)
  REFERENCES hr_cases (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE hr_case_notes VALIDATE CONSTRAINT fk_hr_case_notes_org_case;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE hr_community_members
  ADD CONSTRAINT fk_hr_community_members_org_community
  FOREIGN KEY (org_id, community_id)
  REFERENCES hr_communities (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE hr_community_members VALIDATE CONSTRAINT fk_hr_community_members_org_community;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE hr_comp_budget_pools
  ADD CONSTRAINT fk_hr_comp_budget_pools_org_cycle
  FOREIGN KEY (org_id, cycle_id)
  REFERENCES hr_comp_cycles (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE hr_comp_budget_pools VALIDATE CONSTRAINT fk_hr_comp_budget_pools_org_cycle;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE hr_comp_budget_pools
  ADD CONSTRAINT fk_hr_comp_budget_pools_org_department
  FOREIGN KEY (org_id, department_id)
  REFERENCES org_units (org_id, id)
  ON DELETE SET NULL (department_id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE hr_comp_budget_pools VALIDATE CONSTRAINT fk_hr_comp_budget_pools_org_department;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE hr_comp_recommendations
  ADD CONSTRAINT fk_hr_comp_recommendations_org_cycle
  FOREIGN KEY (org_id, cycle_id)
  REFERENCES hr_comp_cycles (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE hr_comp_recommendations VALIDATE CONSTRAINT fk_hr_comp_recommendations_org_cycle;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE hr_compliance_events
  ADD CONSTRAINT fk_hr_compliance_events_org_requirement
  FOREIGN KEY (org_id, requirement_id)
  REFERENCES hr_compliance_requirements (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE hr_compliance_events VALIDATE CONSTRAINT fk_hr_compliance_events_org_requirement;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE hr_contracts
  ADD CONSTRAINT fk_hr_contracts_org_employment
  FOREIGN KEY (org_id, employment_id)
  REFERENCES hr_employments (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE hr_contracts VALIDATE CONSTRAINT fk_hr_contracts_org_employment;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE hr_device_employee_mappings
  ADD CONSTRAINT fk_hr_device_employee_mappings_org_device
  FOREIGN KEY (org_id, device_id)
  REFERENCES hr_time_devices (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE hr_device_employee_mappings VALIDATE CONSTRAINT fk_hr_device_employee_mappings_org_device;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE hr_device_sync_logs
  ADD CONSTRAINT fk_hr_device_sync_logs_org_device
  FOREIGN KEY (org_id, device_id)
  REFERENCES hr_time_devices (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE hr_device_sync_logs VALIDATE CONSTRAINT fk_hr_device_sync_logs_org_device;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE hr_disciplinary_actions
  ADD CONSTRAINT fk_hr_disciplinary_actions_org_case
  FOREIGN KEY (org_id, case_id)
  REFERENCES hr_cases (org_id, id)
  ON DELETE SET NULL (case_id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE hr_disciplinary_actions VALIDATE CONSTRAINT fk_hr_disciplinary_actions_org_case;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE hr_effective_dated_changes
  ADD CONSTRAINT fk_hr_effective_dated_changes_org_employment
  FOREIGN KEY (org_id, employment_id)
  REFERENCES hr_employments (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE hr_effective_dated_changes VALIDATE CONSTRAINT fk_hr_effective_dated_changes_org_employment;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE hr_emergency_responses
  ADD CONSTRAINT fk_hr_emergency_responses_org_event
  FOREIGN KEY (org_id, event_id)
  REFERENCES hr_emergency_events (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE hr_emergency_responses VALIDATE CONSTRAINT fk_hr_emergency_responses_org_event;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE hr_employee_sensitive_fields
  ADD CONSTRAINT fk_hr_employee_sensitive_fields_org_employment
  FOREIGN KEY (org_id, employment_id)
  REFERENCES hr_employments (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE hr_employee_sensitive_fields VALIDATE CONSTRAINT fk_hr_employee_sensitive_fields_org_employment;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE hr_employment_custom_field_values
  ADD CONSTRAINT fk_hr_employment_custom_field_values_org_field_def
  FOREIGN KEY (org_id, field_definition_id)
  REFERENCES custom_field_definitions (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE hr_employment_custom_field_values VALIDATE CONSTRAINT fk_hr_employment_custom_field_values_org_field_def;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE hr_employment_custom_field_values
  ADD CONSTRAINT fk_hr_employment_custom_field_values_org_employment
  FOREIGN KEY (org_id, employment_id)
  REFERENCES hr_employments (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE hr_employment_custom_field_values VALIDATE CONSTRAINT fk_hr_employment_custom_field_values_org_employment;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE hr_employment_history
  ADD CONSTRAINT fk_hr_employment_history_org_employment
  FOREIGN KEY (org_id, employment_id)
  REFERENCES hr_employments (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE hr_employment_history VALIDATE CONSTRAINT fk_hr_employment_history_org_employment;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE hr_employments
  ADD CONSTRAINT fk_hr_employments_org_job_level
  FOREIGN KEY (org_id, job_level_id)
  REFERENCES hr_job_levels (org_id, id)
  ON DELETE SET NULL (job_level_id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE hr_employments VALIDATE CONSTRAINT fk_hr_employments_org_job_level;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE hr_employments
  ADD CONSTRAINT fk_hr_employments_org_job_role
  FOREIGN KEY (org_id, job_role_id)
  REFERENCES hr_job_roles (org_id, id)
  ON DELETE SET NULL (job_role_id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE hr_employments VALIDATE CONSTRAINT fk_hr_employments_org_job_role;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE hr_employments
  ADD CONSTRAINT fk_hr_employments_org_person
  FOREIGN KEY (org_id, person_id)
  REFERENCES hr_people (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE hr_employments VALIDATE CONSTRAINT fk_hr_employments_org_person;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE hr_employments
  ADD CONSTRAINT fk_hr_employments_org_department
  FOREIGN KEY (org_id, department_id)
  REFERENCES org_units (org_id, id)
  ON DELETE SET NULL (department_id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE hr_employments VALIDATE CONSTRAINT fk_hr_employments_org_department;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE hr_employments
  ADD CONSTRAINT fk_hr_employments_org_location
  FOREIGN KEY (org_id, location_id)
  REFERENCES org_units (org_id, id)
  ON DELETE SET NULL (location_id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE hr_employments VALIDATE CONSTRAINT fk_hr_employments_org_location;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE hr_equity_exercises
  ADD CONSTRAINT fk_hr_equity_exercises_org_grant
  FOREIGN KEY (org_id, grant_id)
  REFERENCES hr_equity_grants (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE hr_equity_exercises VALIDATE CONSTRAINT fk_hr_equity_exercises_org_grant;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE hr_equity_vesting_events
  ADD CONSTRAINT fk_hr_equity_vesting_events_org_grant
  FOREIGN KEY (org_id, grant_id)
  REFERENCES hr_equity_grants (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE hr_equity_vesting_events VALIDATE CONSTRAINT fk_hr_equity_vesting_events_org_grant;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE hr_form_submissions
  ADD CONSTRAINT fk_hr_form_submissions_org_form
  FOREIGN KEY (org_id, form_id)
  REFERENCES hr_forms (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE hr_form_submissions VALIDATE CONSTRAINT fk_hr_form_submissions_org_form;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE hr_headcount_plans
  ADD CONSTRAINT fk_hr_headcount_plans_org_department
  FOREIGN KEY (org_id, department_id)
  REFERENCES org_units (org_id, id)
  ON DELETE SET NULL (department_id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE hr_headcount_plans VALIDATE CONSTRAINT fk_hr_headcount_plans_org_department;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE hr_helpdesk_comments
  ADD CONSTRAINT fk_hr_helpdesk_comments_org_ticket
  FOREIGN KEY (org_id, ticket_id)
  REFERENCES helpdesk_tickets (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE hr_helpdesk_comments VALIDATE CONSTRAINT fk_hr_helpdesk_comments_org_ticket;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE hr_import_rows
  ADD CONSTRAINT fk_hr_import_rows_org_job
  FOREIGN KEY (org_id, job_id)
  REFERENCES hr_import_jobs (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE hr_import_rows VALIDATE CONSTRAINT fk_hr_import_rows_org_job;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE hr_insurance_claims
  ADD CONSTRAINT fk_hr_insurance_claims_org_plan
  FOREIGN KEY (org_id, plan_id)
  REFERENCES hr_benefit_plans (org_id, id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE hr_insurance_claims VALIDATE CONSTRAINT fk_hr_insurance_claims_org_plan;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE hr_leave_ledger
  ADD CONSTRAINT fk_hr_leave_ledger_org_leave_type
  FOREIGN KEY (org_id, leave_type_id)
  REFERENCES leave_types (org_id, id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE hr_leave_ledger VALIDATE CONSTRAINT fk_hr_leave_ledger_org_leave_type;
SET lock_timeout = DEFAULT;
