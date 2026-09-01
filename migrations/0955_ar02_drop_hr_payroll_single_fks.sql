-- AR-02: drop superseded single-column tenant FKs — HR/payroll/timesheet cluster
-- Superseded by composite (org_id, col) constraints added in 0950-0954.
-- All DROP statements use IF EXISTS; wrong names are no-ops, not failures.
-- CRM, Inventory, and global-table FKs (→ users, → organizations) are not touched.

SET lock_timeout = '5s';

-- ── 0950: HR/recruitment cluster part 1 ─────────────────────────────────────

ALTER TABLE booking_link_interviewers DROP CONSTRAINT IF EXISTS "booking_link_interviewers_booking_link_id_interview_booking_lin";
--> statement-breakpoint
ALTER TABLE calibration_participants DROP CONSTRAINT IF EXISTS "calibration_participants_session_id_calibration_sessions_id_fk";
--> statement-breakpoint
ALTER TABLE calibration_sessions DROP CONSTRAINT IF EXISTS "calibration_sessions_candidate_id_candidates_id_fk";
--> statement-breakpoint
ALTER TABLE calibration_sessions DROP CONSTRAINT IF EXISTS "calibration_sessions_job_posting_id_job_postings_id_fk";
--> statement-breakpoint
ALTER TABLE candidate_applications DROP CONSTRAINT IF EXISTS "candidate_applications_candidate_id_candidates_id_fk";
--> statement-breakpoint
ALTER TABLE candidate_applications DROP CONSTRAINT IF EXISTS "candidate_applications_job_posting_id_job_postings_id_fk";
--> statement-breakpoint
ALTER TABLE candidate_documents DROP CONSTRAINT IF EXISTS "candidate_documents_candidate_id_candidates_id_fk";
--> statement-breakpoint
ALTER TABLE candidate_documents DROP CONSTRAINT IF EXISTS "candidate_documents_template_id_document_templates_id_fk";
--> statement-breakpoint
ALTER TABLE candidate_documents_vault DROP CONSTRAINT IF EXISTS "candidate_documents_vault_candidate_id_candidates_id_fk";
--> statement-breakpoint
ALTER TABLE candidate_messages DROP CONSTRAINT IF EXISTS "candidate_messages_candidate_id_candidates_id_fk";
--> statement-breakpoint
ALTER TABLE candidate_offers DROP CONSTRAINT IF EXISTS "candidate_offers_candidate_id_candidates_id_fk";
--> statement-breakpoint
ALTER TABLE candidate_offers DROP CONSTRAINT IF EXISTS "candidate_offers_job_posting_id_job_postings_id_fk";
--> statement-breakpoint
ALTER TABLE candidate_reference_checks DROP CONSTRAINT IF EXISTS "candidate_reference_checks_candidate_id_candidates_id_fk";
--> statement-breakpoint
ALTER TABLE candidate_referrals DROP CONSTRAINT IF EXISTS "candidate_referrals_candidate_id_candidates_id_fk";
--> statement-breakpoint
ALTER TABLE candidate_referrals DROP CONSTRAINT IF EXISTS "candidate_referrals_job_posting_id_job_postings_id_fk";
--> statement-breakpoint
ALTER TABLE candidate_resumes DROP CONSTRAINT IF EXISTS "candidate_resumes_candidate_id_candidates_id_fk";
--> statement-breakpoint
ALTER TABLE candidate_sla_tracking DROP CONSTRAINT IF EXISTS "candidate_sla_tracking_candidate_id_candidates_id_fk";
--> statement-breakpoint
ALTER TABLE email_sequence_enrollments DROP CONSTRAINT IF EXISTS "email_sequence_enrollments_candidate_id_candidates_id_fk";
--> statement-breakpoint
ALTER TABLE email_sequence_enrollments DROP CONSTRAINT IF EXISTS "email_sequence_enrollments_sequence_id_email_sequences_id_fk";
--> statement-breakpoint

-- ── 0951: HR/recruitment cluster part 2 ─────────────────────────────────────

ALTER TABLE employee_career_plans DROP CONSTRAINT IF EXISTS "employee_career_plans_path_id_career_paths_id_fk";
--> statement-breakpoint
-- Drizzle truncates at 63: profile_id → employee_salary_profiles
ALTER TABLE employee_salary_profile_components DROP CONSTRAINT IF EXISTS "employee_salary_profile_components_profile_id_employee_salary_p";
--> statement-breakpoint
-- Drizzle truncates at 63: component_id → salary_components
ALTER TABLE employee_salary_profile_components DROP CONSTRAINT IF EXISTS "employee_salary_profile_components_component_id_salary_componen";
--> statement-breakpoint
ALTER TABLE employee_shift_assignments DROP CONSTRAINT IF EXISTS "employee_shift_assignments_shift_id_shift_templates_id_fk";
--> statement-breakpoint
ALTER TABLE external_referrals DROP CONSTRAINT IF EXISTS "external_referrals_candidate_id_candidates_id_fk";
--> statement-breakpoint
ALTER TABLE external_referrals DROP CONSTRAINT IF EXISTS "external_referrals_referrer_id_external_referrers_id_fk";
--> statement-breakpoint
ALTER TABLE external_referrals DROP CONSTRAINT IF EXISTS "external_referrals_job_posting_id_job_postings_id_fk";
--> statement-breakpoint
ALTER TABLE headcount_requests DROP CONSTRAINT IF EXISTS "headcount_requests_linked_job_posting_id_job_postings_id_fk";
--> statement-breakpoint
ALTER TABLE headcount_requests DROP CONSTRAINT IF EXISTS "headcount_requests_org_department_id_org_units_id_fk";
--> statement-breakpoint
-- alt name if old column was department_id
ALTER TABLE headcount_requests DROP CONSTRAINT IF EXISTS "headcount_requests_department_id_org_units_id_fk";
--> statement-breakpoint
ALTER TABLE hiring_flow_rounds DROP CONSTRAINT IF EXISTS "hiring_flow_rounds_flow_id_hiring_flows_id_fk";
--> statement-breakpoint
-- Drizzle truncates at 63: scorecard_template_id → scorecard_templates
ALTER TABLE hiring_flow_rounds DROP CONSTRAINT IF EXISTS "hiring_flow_rounds_scorecard_template_id_scorecard_templates_id_";
--> statement-breakpoint
ALTER TABLE interview_booking_links DROP CONSTRAINT IF EXISTS "interview_booking_links_candidate_id_candidates_id_fk";
--> statement-breakpoint
ALTER TABLE interview_booking_links DROP CONSTRAINT IF EXISTS "interview_booking_links_job_posting_id_job_postings_id_fk";
--> statement-breakpoint
ALTER TABLE interview_panel_members DROP CONSTRAINT IF EXISTS "interview_panel_members_interview_id_interviews_id_fk";
--> statement-breakpoint
ALTER TABLE interview_scorecards DROP CONSTRAINT IF EXISTS "interview_scorecards_interview_id_interviews_id_fk";
--> statement-breakpoint
ALTER TABLE interview_scorecards DROP CONSTRAINT IF EXISTS "interview_scorecards_template_id_scorecard_templates_id_fk";
--> statement-breakpoint
ALTER TABLE investment_proofs DROP CONSTRAINT IF EXISTS "investment_proofs_declaration_id_tax_declarations_id_fk";
--> statement-breakpoint
-- alt name if old table reference was hr_investment_declarations
ALTER TABLE investment_proofs DROP CONSTRAINT IF EXISTS "investment_proofs_declaration_id_hr_investment_declarations_id_f";
--> statement-breakpoint
ALTER TABLE job_board_postings DROP CONSTRAINT IF EXISTS "job_board_postings_job_posting_id_job_postings_id_fk";
--> statement-breakpoint
ALTER TABLE job_postings DROP CONSTRAINT IF EXISTS "job_postings_hiring_flow_id_hiring_flows_id_fk";
--> statement-breakpoint
ALTER TABLE job_postings DROP CONSTRAINT IF EXISTS "job_postings_org_department_id_org_units_id_fk";
--> statement-breakpoint
-- alt name if old column was department_id
ALTER TABLE job_postings DROP CONSTRAINT IF EXISTS "job_postings_department_id_org_units_id_fk";
--> statement-breakpoint
ALTER TABLE job_recruiters DROP CONSTRAINT IF EXISTS "job_recruiters_job_posting_id_job_postings_id_fk";
--> statement-breakpoint
ALTER TABLE offer_negotiations DROP CONSTRAINT IF EXISTS "offer_negotiations_offer_id_candidate_offers_id_fk";
--> statement-breakpoint
ALTER TABLE offer_versions DROP CONSTRAINT IF EXISTS "offer_versions_offer_id_candidate_offers_id_fk";
--> statement-breakpoint
ALTER TABLE recruiter_activity_log DROP CONSTRAINT IF EXISTS "recruiter_activity_log_candidate_id_candidates_id_fk";
--> statement-breakpoint
ALTER TABLE recruiter_activity_log DROP CONSTRAINT IF EXISTS "recruiter_activity_log_job_posting_id_job_postings_id_fk";
--> statement-breakpoint
ALTER TABLE review_cycles DROP CONSTRAINT IF EXISTS "review_cycles_template_id_hr_templates_id_fk";
--> statement-breakpoint
-- alt name if old column was department_id → org_units
ALTER TABLE review_cycles DROP CONSTRAINT IF EXISTS "review_cycles_department_id_org_units_id_fk";
--> statement-breakpoint
ALTER TABLE roster_entries DROP CONSTRAINT IF EXISTS "roster_entries_roster_id_rosters_id_fk";
--> statement-breakpoint
-- alt name if old table was hr_rosters
ALTER TABLE roster_entries DROP CONSTRAINT IF EXISTS "roster_entries_roster_id_hr_rosters_id_fk";
--> statement-breakpoint
ALTER TABLE roster_entries DROP CONSTRAINT IF EXISTS "roster_entries_shift_id_shift_templates_id_fk";
--> statement-breakpoint
-- alt name if old table was hr_shifts
ALTER TABLE roster_entries DROP CONSTRAINT IF EXISTS "roster_entries_shift_id_hr_shifts_id_fk";
--> statement-breakpoint
ALTER TABLE talent_pool_members DROP CONSTRAINT IF EXISTS "talent_pool_members_candidate_id_candidates_id_fk";
--> statement-breakpoint
ALTER TABLE talent_pool_members DROP CONSTRAINT IF EXISTS "talent_pool_members_pool_id_talent_pools_id_fk";
--> statement-breakpoint
-- Drizzle truncates at 63: vault_document_id → candidate_documents_vault
ALTER TABLE vault_access_logs DROP CONSTRAINT IF EXISTS "vault_access_logs_vault_document_id_candidate_documents_vault_i";
--> statement-breakpoint
ALTER TABLE vault_access_logs DROP CONSTRAINT IF EXISTS "vault_access_logs_candidate_id_candidates_id_fk";
--> statement-breakpoint
ALTER TABLE vendor_candidate_submissions DROP CONSTRAINT IF EXISTS "vendor_candidate_submissions_candidate_id_candidates_id_fk";
--> statement-breakpoint
ALTER TABLE vendor_candidate_submissions DROP CONSTRAINT IF EXISTS "vendor_candidate_submissions_job_posting_id_job_postings_id_fk";
--> statement-breakpoint
-- Drizzle truncates at 63: vendor_id → recruitment_vendors
ALTER TABLE vendor_candidate_submissions DROP CONSTRAINT IF EXISTS "vendor_candidate_submissions_vendor_id_recruitment_vendors_id_f";
--> statement-breakpoint

-- ── 0952: HR core part 1 ────────────────────────────────────────────────────

-- Drizzle truncates at 63: request_id → hr_accommodation_requests
ALTER TABLE hr_accommodation_tasks DROP CONSTRAINT IF EXISTS "hr_accommodation_tasks_request_id_hr_accommodation_requests_id_";
--> statement-breakpoint
ALTER TABLE hr_automation_runs DROP CONSTRAINT IF EXISTS "hr_automation_runs_rule_id_hr_automation_rules_id_fk";
--> statement-breakpoint
-- alt name if old table was hr_automations
ALTER TABLE hr_automation_runs DROP CONSTRAINT IF EXISTS "hr_automation_runs_automation_id_hr_automations_id_fk";
--> statement-breakpoint
ALTER TABLE hr_badge_awards DROP CONSTRAINT IF EXISTS "hr_badge_awards_badge_id_hr_badges_id_fk";
--> statement-breakpoint
ALTER TABLE hr_benefit_enrollment_windows DROP CONSTRAINT IF EXISTS "hr_benefit_enrollment_windows_plan_id_hr_benefit_plans_id_fk";
--> statement-breakpoint
ALTER TABLE hr_benefit_enrollments DROP CONSTRAINT IF EXISTS "hr_benefit_enrollments_plan_id_hr_benefit_plans_id_fk";
--> statement-breakpoint
ALTER TABLE hr_calibration_entries DROP CONSTRAINT IF EXISTS "hr_calibration_entries_cycle_id_review_cycles_id_fk";
--> statement-breakpoint
-- alt name if old FK was to calibration_sessions
ALTER TABLE hr_calibration_entries DROP CONSTRAINT IF EXISTS "hr_calibration_entries_session_id_calibration_sessions_id_fk";
--> statement-breakpoint
ALTER TABLE hr_case_documents DROP CONSTRAINT IF EXISTS "hr_case_documents_case_id_hr_cases_id_fk";
--> statement-breakpoint
ALTER TABLE hr_case_notes DROP CONSTRAINT IF EXISTS "hr_case_notes_case_id_hr_cases_id_fk";
--> statement-breakpoint
ALTER TABLE hr_community_members DROP CONSTRAINT IF EXISTS "hr_community_members_community_id_hr_communities_id_fk";
--> statement-breakpoint
ALTER TABLE hr_comp_budget_pools DROP CONSTRAINT IF EXISTS "hr_comp_budget_pools_cycle_id_hr_comp_cycles_id_fk";
--> statement-breakpoint
-- alt name if old table was hr_compensation_cycles
ALTER TABLE hr_comp_budget_pools DROP CONSTRAINT IF EXISTS "hr_comp_budget_pools_cycle_id_hr_compensation_cycles_id_fk";
--> statement-breakpoint
ALTER TABLE hr_comp_budget_pools DROP CONSTRAINT IF EXISTS "hr_comp_budget_pools_department_id_org_units_id_fk";
--> statement-breakpoint
ALTER TABLE hr_comp_recommendations DROP CONSTRAINT IF EXISTS "hr_comp_recommendations_cycle_id_hr_comp_cycles_id_fk";
--> statement-breakpoint
-- alt name if old table was hr_compensation_cycles
ALTER TABLE hr_comp_recommendations DROP CONSTRAINT IF EXISTS "hr_comp_recommendations_employment_id_hr_employments_id_fk";
--> statement-breakpoint
-- Drizzle truncates at 63: requirement_id → hr_compliance_requirements
ALTER TABLE hr_compliance_events DROP CONSTRAINT IF EXISTS "hr_compliance_events_requirement_id_hr_compliance_requirements_";
--> statement-breakpoint
-- alt name if old FK was employment_id → hr_employments
ALTER TABLE hr_compliance_events DROP CONSTRAINT IF EXISTS "hr_compliance_events_employment_id_hr_employments_id_fk";
--> statement-breakpoint
ALTER TABLE hr_contracts DROP CONSTRAINT IF EXISTS "hr_contracts_employment_id_hr_employments_id_fk";
--> statement-breakpoint
ALTER TABLE hr_device_employee_mappings DROP CONSTRAINT IF EXISTS "hr_device_employee_mappings_device_id_hr_time_devices_id_fk";
--> statement-breakpoint
-- alt name if old FK referenced hr_devices
ALTER TABLE hr_device_employee_mappings DROP CONSTRAINT IF EXISTS "hr_device_employee_mappings_device_id_hr_devices_id_fk";
--> statement-breakpoint
ALTER TABLE hr_device_employee_mappings DROP CONSTRAINT IF EXISTS "hr_device_employee_mappings_person_id_hr_people_id_fk";
--> statement-breakpoint
ALTER TABLE hr_device_sync_logs DROP CONSTRAINT IF EXISTS "hr_device_sync_logs_device_id_hr_time_devices_id_fk";
--> statement-breakpoint
-- alt name if old FK referenced hr_devices
ALTER TABLE hr_device_sync_logs DROP CONSTRAINT IF EXISTS "hr_device_sync_logs_device_id_hr_devices_id_fk";
--> statement-breakpoint
ALTER TABLE hr_disciplinary_actions DROP CONSTRAINT IF EXISTS "hr_disciplinary_actions_case_id_hr_cases_id_fk";
--> statement-breakpoint
-- alt name if old FK was employment_id
ALTER TABLE hr_disciplinary_actions DROP CONSTRAINT IF EXISTS "hr_disciplinary_actions_employment_id_hr_employments_id_fk";
--> statement-breakpoint
ALTER TABLE hr_effective_dated_changes DROP CONSTRAINT IF EXISTS "hr_effective_dated_changes_employment_id_hr_employments_id_fk";
--> statement-breakpoint
ALTER TABLE hr_emergency_responses DROP CONSTRAINT IF EXISTS "hr_emergency_responses_event_id_hr_emergency_events_id_fk";
--> statement-breakpoint
-- alt name if old FK was drill_id → hr_emergency_drills
ALTER TABLE hr_emergency_responses DROP CONSTRAINT IF EXISTS "hr_emergency_responses_drill_id_hr_emergency_drills_id_fk";
--> statement-breakpoint
ALTER TABLE hr_employee_sensitive_fields DROP CONSTRAINT IF EXISTS "hr_employee_sensitive_fields_employment_id_hr_employments_id_fk";
--> statement-breakpoint
-- alt name if old FK was person_id → hr_people
ALTER TABLE hr_employee_sensitive_fields DROP CONSTRAINT IF EXISTS "hr_employee_sensitive_fields_person_id_hr_people_id_fk";
--> statement-breakpoint
-- Drizzle truncates at 63: field_definition_id → custom_field_definitions
ALTER TABLE hr_employment_custom_field_values DROP CONSTRAINT IF EXISTS "hr_employment_custom_field_values_field_definition_id_custom_fi";
--> statement-breakpoint
-- alt name if old col was definition_id → custom_field_definitions
ALTER TABLE hr_employment_custom_field_values DROP CONSTRAINT IF EXISTS "hr_employment_custom_field_values_definition_id_custom_field_de";
--> statement-breakpoint
-- Drizzle truncates at 63: employment_id → hr_employments
ALTER TABLE hr_employment_custom_field_values DROP CONSTRAINT IF EXISTS "hr_employment_custom_field_values_employment_id_hr_employments_";
--> statement-breakpoint
ALTER TABLE hr_employment_history DROP CONSTRAINT IF EXISTS "hr_employment_history_employment_id_hr_employments_id_fk";
--> statement-breakpoint
ALTER TABLE hr_employments DROP CONSTRAINT IF EXISTS "hr_employments_job_level_id_hr_job_levels_id_fk";
--> statement-breakpoint
ALTER TABLE hr_employments DROP CONSTRAINT IF EXISTS "hr_employments_job_role_id_hr_job_roles_id_fk";
--> statement-breakpoint
ALTER TABLE hr_employments DROP CONSTRAINT IF EXISTS "hr_employments_person_id_hr_people_id_fk";
--> statement-breakpoint
ALTER TABLE hr_employments DROP CONSTRAINT IF EXISTS "hr_employments_department_id_org_units_id_fk";
--> statement-breakpoint
ALTER TABLE hr_employments DROP CONSTRAINT IF EXISTS "hr_employments_location_id_org_units_id_fk";
--> statement-breakpoint
ALTER TABLE hr_equity_exercises DROP CONSTRAINT IF EXISTS "hr_equity_exercises_grant_id_hr_equity_grants_id_fk";
--> statement-breakpoint
ALTER TABLE hr_equity_vesting_events DROP CONSTRAINT IF EXISTS "hr_equity_vesting_events_grant_id_hr_equity_grants_id_fk";
--> statement-breakpoint
ALTER TABLE hr_form_submissions DROP CONSTRAINT IF EXISTS "hr_form_submissions_form_id_hr_forms_id_fk";
--> statement-breakpoint
ALTER TABLE hr_headcount_plans DROP CONSTRAINT IF EXISTS "hr_headcount_plans_department_id_org_units_id_fk";
--> statement-breakpoint
ALTER TABLE hr_helpdesk_comments DROP CONSTRAINT IF EXISTS "hr_helpdesk_comments_ticket_id_helpdesk_tickets_id_fk";
--> statement-breakpoint
-- alt name if old table was hr_helpdesk_tickets
ALTER TABLE hr_helpdesk_comments DROP CONSTRAINT IF EXISTS "hr_helpdesk_comments_ticket_id_hr_helpdesk_tickets_id_fk";
--> statement-breakpoint
ALTER TABLE hr_import_rows DROP CONSTRAINT IF EXISTS "hr_import_rows_job_id_hr_import_jobs_id_fk";
--> statement-breakpoint
-- alt name if old col was import_id → hr_imports
ALTER TABLE hr_import_rows DROP CONSTRAINT IF EXISTS "hr_import_rows_import_id_hr_imports_id_fk";
--> statement-breakpoint
ALTER TABLE hr_insurance_claims DROP CONSTRAINT IF EXISTS "hr_insurance_claims_plan_id_hr_benefit_plans_id_fk";
--> statement-breakpoint
-- alt name if old FK was policy_id → hr_insurance_policies
ALTER TABLE hr_insurance_claims DROP CONSTRAINT IF EXISTS "hr_insurance_claims_policy_id_hr_insurance_policies_id_fk";
--> statement-breakpoint
ALTER TABLE hr_leave_ledger DROP CONSTRAINT IF EXISTS "hr_leave_ledger_leave_type_id_leave_types_id_fk";
--> statement-breakpoint

-- ── 0953: HR core part 2 + leave ────────────────────────────────────────────

ALTER TABLE hr_legal_hold_items DROP CONSTRAINT IF EXISTS "hr_legal_hold_items_hold_id_hr_legal_holds_id_fk";
--> statement-breakpoint
ALTER TABLE hr_payroll_adjustments DROP CONSTRAINT IF EXISTS "hr_payroll_adjustments_period_id_hr_payroll_input_periods_id_fk";
--> statement-breakpoint
-- Drizzle truncates at 63: period_id → hr_payroll_input_periods (snapshots)
ALTER TABLE hr_payroll_input_snapshots DROP CONSTRAINT IF EXISTS "hr_payroll_input_snapshots_period_id_hr_payroll_input_periods_i";
--> statement-breakpoint
ALTER TABLE hr_policy_scopes DROP CONSTRAINT IF EXISTS "hr_policy_scopes_policy_id_hr_policies_id_fk";
--> statement-breakpoint
ALTER TABLE hr_poll_votes DROP CONSTRAINT IF EXISTS "hr_poll_votes_poll_id_hr_polls_id_fk";
--> statement-breakpoint
-- Drizzle truncates at 63: from_status_id → hr_position_statuses
ALTER TABLE hr_position_transitions DROP CONSTRAINT IF EXISTS "hr_position_transitions_from_status_id_hr_position_statuses_id_";
--> statement-breakpoint
-- alt name if created by raw migration (Postgres default _fkey suffix)
ALTER TABLE hr_position_transitions DROP CONSTRAINT IF EXISTS "hr_position_transitions_from_status_id_fkey";
--> statement-breakpoint
ALTER TABLE hr_position_transitions DROP CONSTRAINT IF EXISTS "hr_position_transitions_to_status_id_hr_position_statuses_id_fk";
--> statement-breakpoint
-- alt name if created by raw migration
ALTER TABLE hr_position_transitions DROP CONSTRAINT IF EXISTS "hr_position_transitions_to_status_id_fkey";
--> statement-breakpoint
ALTER TABLE hr_positions DROP CONSTRAINT IF EXISTS "hr_positions_department_id_org_units_id_fk";
--> statement-breakpoint
-- alt name if created by raw migration
ALTER TABLE hr_positions DROP CONSTRAINT IF EXISTS "fk_hr_positions_department";
--> statement-breakpoint
ALTER TABLE hr_probation_reviews DROP CONSTRAINT IF EXISTS "hr_probation_reviews_employment_id_hr_employments_id_fk";
--> statement-breakpoint
ALTER TABLE hr_probation_reviews DROP CONSTRAINT IF EXISTS "hr_probation_reviews_person_id_hr_people_id_fk";
--> statement-breakpoint
ALTER TABLE hr_probation_reviews DROP CONSTRAINT IF EXISTS "hr_probation_reviews_review_template_id_hr_templates_id_fk";
--> statement-breakpoint
ALTER TABLE hr_reporting_lines DROP CONSTRAINT IF EXISTS "hr_reporting_lines_employment_id_hr_employments_id_fk";
--> statement-breakpoint
ALTER TABLE hr_reporting_lines DROP CONSTRAINT IF EXISTS "hr_reporting_lines_manager_employment_id_hr_employments_id_fk";
--> statement-breakpoint
ALTER TABLE hr_role_skill_requirements DROP CONSTRAINT IF EXISTS "hr_role_skill_requirements_job_role_id_hr_job_roles_id_fk";
--> statement-breakpoint
ALTER TABLE hr_succession_plans DROP CONSTRAINT IF EXISTS "hr_succession_plans_job_role_id_hr_job_roles_id_fk";
--> statement-breakpoint
ALTER TABLE hr_template_renders DROP CONSTRAINT IF EXISTS "hr_template_renders_template_id_hr_templates_id_fk";
--> statement-breakpoint
ALTER TABLE hr_time_devices DROP CONSTRAINT IF EXISTS "hr_time_devices_location_id_org_units_id_fk";
--> statement-breakpoint
-- alt name if created by raw migration
ALTER TABLE hr_time_devices DROP CONSTRAINT IF EXISTS "fk_hr_time_devices_location";
--> statement-breakpoint
-- Drizzle truncates at 63: subscription_id → hr_webhook_subscriptions
ALTER TABLE hr_webhook_deliveries DROP CONSTRAINT IF EXISTS "hr_webhook_deliveries_subscription_id_hr_webhook_subscriptions_";
--> statement-breakpoint
ALTER TABLE hr_work_authorizations DROP CONSTRAINT IF EXISTS "hr_work_authorizations_employment_id_hr_employments_id_fk";
--> statement-breakpoint
-- Drizzle truncates at 63: definition_id → hr_workflow_definitions (instances)
ALTER TABLE hr_workflow_instances DROP CONSTRAINT IF EXISTS "hr_workflow_instances_definition_id_hr_workflow_definitions_id_";
--> statement-breakpoint
-- Drizzle truncates at 63: instance_id → hr_workflow_instances (step_actions)
ALTER TABLE hr_workflow_step_actions DROP CONSTRAINT IF EXISTS "hr_workflow_step_actions_instance_id_hr_workflow_instances_id_f";
--> statement-breakpoint
ALTER TABLE hr_workflow_steps DROP CONSTRAINT IF EXISTS "hr_workflow_steps_definition_id_hr_workflow_definitions_id_fk";
--> statement-breakpoint
ALTER TABLE leave_balances DROP CONSTRAINT IF EXISTS "leave_balances_leave_type_id_leave_types_id_fk";
--> statement-breakpoint
ALTER TABLE leave_policies DROP CONSTRAINT IF EXISTS "leave_policies_leave_type_id_leave_types_id_fk";
--> statement-breakpoint
ALTER TABLE leave_requests DROP CONSTRAINT IF EXISTS "leave_requests_leave_type_id_leave_types_id_fk";
--> statement-breakpoint

-- ── 0954: payroll + timesheet ────────────────────────────────────────────────

-- Drizzle truncates at 63: reversal_of_batch_id → payroll_journal_batches (self)
ALTER TABLE payroll_journal_batches DROP CONSTRAINT IF EXISTS "payroll_journal_batches_reversal_of_batch_id_payroll_journal_ba";
--> statement-breakpoint
ALTER TABLE payroll_journal_entries DROP CONSTRAINT IF EXISTS "payroll_journal_entries_batch_id_payroll_journal_batches_id_fk";
--> statement-breakpoint
ALTER TABLE payroll_run_employees DROP CONSTRAINT IF EXISTS "payroll_run_employees_run_id_payroll_runs_id_fk";
--> statement-breakpoint
ALTER TABLE payroll_run_items DROP CONSTRAINT IF EXISTS "payroll_run_items_run_id_payroll_runs_id_fk";
--> statement-breakpoint
ALTER TABLE payroll_runs DROP CONSTRAINT IF EXISTS "payroll_runs_legal_entity_id_legal_entities_id_fk";
--> statement-breakpoint
ALTER TABLE timesheet_exceptions DROP CONSTRAINT IF EXISTS "timesheet_exceptions_timesheet_id_timesheets_id_fk";
--> statement-breakpoint
-- Cross-schema FK: old single-col task_id → tickets (build schema)
ALTER TABLE timesheet_rates DROP CONSTRAINT IF EXISTS "fk_timesheet_rates_task";
ALTER TABLE timesheet_exceptions DROP CONSTRAINT IF EXISTS "timesheet_exceptions_entry_id_fkey";
ALTER TABLE timesheet_exceptions DROP CONSTRAINT IF EXISTS "timesheet_exceptions_period_id_fkey";
--> statement-breakpoint

-- ── Pre-existing composite FKs — drop superseded single-col originals ────────

-- candidates: self-referential duplicate_of_id
ALTER TABLE candidates DROP CONSTRAINT IF EXISTS "candidates_duplicate_of_id_candidates_id_fk";
--> statement-breakpoint
-- expenses
ALTER TABLE expenses DROP CONSTRAINT IF EXISTS "expenses_category_id_expense_categories_id_fk";
--> statement-breakpoint
ALTER TABLE expenses DROP CONSTRAINT IF EXISTS "expenses_journal_id_payroll_journal_batches_id_fk";
--> statement-breakpoint
ALTER TABLE expenses DROP CONSTRAINT IF EXISTS "expenses_project_id_projects_id_fk";
--> statement-breakpoint
-- fin_expense_policies
ALTER TABLE fin_expense_policies DROP CONSTRAINT IF EXISTS "fin_expense_policies_category_id_expense_categories_id_fk";
--> statement-breakpoint
-- interviews
ALTER TABLE interviews DROP CONSTRAINT IF EXISTS "interviews_candidate_id_candidates_id_fk";
--> statement-breakpoint
ALTER TABLE interviews DROP CONSTRAINT IF EXISTS "interviews_job_posting_id_job_postings_id_fk";
--> statement-breakpoint
-- timesheet_budgets
ALTER TABLE timesheet_budgets DROP CONSTRAINT IF EXISTS "timesheet_budgets_project_id_projects_id_fk";
--> statement-breakpoint
-- timesheet_rates
ALTER TABLE timesheet_rates DROP CONSTRAINT IF EXISTS "timesheet_rates_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE timesheet_rates DROP CONSTRAINT IF EXISTS "timesheet_rates_rate_card_id_timesheet_rate_cards_id_fk";
--> statement-breakpoint
-- timesheets
ALTER TABLE timesheets DROP CONSTRAINT IF EXISTS "timesheets_payroll_export_id_payroll_exports_id_fk";
--> statement-breakpoint
ALTER TABLE timesheets DROP CONSTRAINT IF EXISTS "timesheets_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE timesheets DROP CONSTRAINT IF EXISTS "timesheets_ticket_id_tickets_id_fk";
--> statement-breakpoint
ALTER TABLE timesheets DROP CONSTRAINT IF EXISTS "timesheets_timer_session_id_timer_sessions_id_fk";
--> statement-breakpoint
ALTER TABLE timesheets DROP CONSTRAINT IF EXISTS "timesheets_timesheet_period_id_timesheet_periods_id_fk";

SET lock_timeout = DEFAULT;
