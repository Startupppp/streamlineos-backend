-- PARTIAL ROLLBACK — this file restores 138 of the 164 constraints 0955 drops.
--
-- The 26 below cannot be reconstructed. Their definitions appear in no migration file: they were
-- created out-of-band by db:push (the drift guard-db-push.mjs was written to stop), so the only
-- record of them was the live catalog, and 0955 has removed that. The Drizzle auto-generated names
-- encode a parent table that no longer resolves against the catalog, and deriving a parent from the
-- superseding composite produced demonstrably wrong answers when tried, so nothing is guessed here.
--
--   headcount_requests_department_id_org_units_id_fk  (no split verifies against the catalog)
--   investment_proofs_declaration_id_hr_investment_declarations_id_f  (constraint name is custom and encodes no parent)
--   job_postings_department_id_org_units_id_fk  (no split verifies against the catalog)
--   roster_entries_roster_id_hr_rosters_id_fk  (no split verifies against the catalog)
--   roster_entries_shift_id_hr_shifts_id_fk  (no split verifies against the catalog)
--   hr_automation_runs_automation_id_hr_automations_id_fk  (no split verifies against the catalog)
--   hr_calibration_entries_session_id_calibration_sessions_id_fk  (no split verifies against the catalog)
--   hr_comp_budget_pools_cycle_id_hr_compensation_cycles_id_fk  (no split verifies against the catalog)
--   hr_compliance_events_employment_id_hr_employments_id_fk  (no split verifies against the catalog)
--   hr_device_employee_mappings_device_id_hr_devices_id_fk  (no split verifies against the catalog)
--   hr_device_sync_logs_device_id_hr_devices_id_fk  (no split verifies against the catalog)
--   hr_disciplinary_actions_employment_id_hr_employments_id_fk  (no split verifies against the catalog)
--   hr_emergency_responses_drill_id_hr_emergency_drills_id_fk  (no split verifies against the catalog)
--   hr_employee_sensitive_fields_person_id_hr_people_id_fk  (no split verifies against the catalog)
--   hr_employment_custom_field_values_definition_id_custom_field_de  (constraint name is custom and encodes no parent)
--   hr_helpdesk_comments_ticket_id_hr_helpdesk_tickets_id_fk  (no split verifies against the catalog)
--   hr_import_rows_import_id_hr_imports_id_fk  (no split verifies against the catalog)
--   hr_insurance_claims_policy_id_hr_insurance_policies_id_fk  (no split verifies against the catalog)
--   hr_position_transitions_from_status_id_fkey  (constraint name is custom and encodes no parent)
--   hr_position_transitions_to_status_id_fkey  (constraint name is custom and encodes no parent)
--   fk_hr_positions_department  (constraint name is custom and encodes no parent)
--   fk_hr_time_devices_location  (constraint name is custom and encodes no parent)
--   payroll_journal_entries_batch_id_payroll_journal_batches_id_fk  (child table does not exist in any database)
--   payroll_run_items_run_id_payroll_runs_id_fk  (child table does not exist in any database)
--   payroll_runs_legal_entity_id_legal_entities_id_fk  (no split verifies against the catalog)
--   timesheet_exceptions_timesheet_id_timesheets_id_fk  (no split verifies against the catalog)
--
-- Restoring them requires a catalog dump taken before 0955 was applied.

-- 0955_ar02_drop_hr_payroll_single_fks DOWN
-- Skips: timesheet_exceptions.timesheet_id (col renamed to entry_id), payroll_runs.legal_entity_id (col renamed to entity_id),
--        payroll_journal_entries / payroll_run_items (tables do not exist), alt-name-only drops (IF EXISTS no-ops).
SET lock_timeout = '5s';

-- ── 0950: HR/recruitment cluster part 1 ─────────────────────────────────────

--> statement-breakpoint
ALTER TABLE booking_link_interviewers
  ADD CONSTRAINT "booking_link_interviewers_booking_link_id_interview_booking_lin"
  FOREIGN KEY (booking_link_id) REFERENCES interview_booking_links (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE calibration_participants
  ADD CONSTRAINT "calibration_participants_session_id_calibration_sessions_id_fk"
  FOREIGN KEY (session_id) REFERENCES calibration_sessions (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE calibration_sessions
  ADD CONSTRAINT "calibration_sessions_candidate_id_candidates_id_fk"
  FOREIGN KEY (candidate_id) REFERENCES candidates (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE calibration_sessions
  ADD CONSTRAINT "calibration_sessions_job_posting_id_job_postings_id_fk"
  FOREIGN KEY (job_posting_id) REFERENCES job_postings (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE candidate_applications
  ADD CONSTRAINT "candidate_applications_candidate_id_candidates_id_fk"
  FOREIGN KEY (candidate_id) REFERENCES candidates (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE candidate_applications
  ADD CONSTRAINT "candidate_applications_job_posting_id_job_postings_id_fk"
  FOREIGN KEY (job_posting_id) REFERENCES job_postings (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE candidate_documents
  ADD CONSTRAINT "candidate_documents_candidate_id_candidates_id_fk"
  FOREIGN KEY (candidate_id) REFERENCES candidates (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE candidate_documents
  ADD CONSTRAINT "candidate_documents_template_id_document_templates_id_fk"
  FOREIGN KEY (template_id) REFERENCES document_templates (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE candidate_documents_vault
  ADD CONSTRAINT "candidate_documents_vault_candidate_id_candidates_id_fk"
  FOREIGN KEY (candidate_id) REFERENCES candidates (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE candidate_messages
  ADD CONSTRAINT "candidate_messages_candidate_id_candidates_id_fk"
  FOREIGN KEY (candidate_id) REFERENCES candidates (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE candidate_offers
  ADD CONSTRAINT "candidate_offers_candidate_id_candidates_id_fk"
  FOREIGN KEY (candidate_id) REFERENCES candidates (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE candidate_offers
  ADD CONSTRAINT "candidate_offers_job_posting_id_job_postings_id_fk"
  FOREIGN KEY (job_posting_id) REFERENCES job_postings (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE candidate_reference_checks
  ADD CONSTRAINT "candidate_reference_checks_candidate_id_candidates_id_fk"
  FOREIGN KEY (candidate_id) REFERENCES candidates (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE candidate_referrals
  ADD CONSTRAINT "candidate_referrals_candidate_id_candidates_id_fk"
  FOREIGN KEY (candidate_id) REFERENCES candidates (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE candidate_referrals
  ADD CONSTRAINT "candidate_referrals_job_posting_id_job_postings_id_fk"
  FOREIGN KEY (job_posting_id) REFERENCES job_postings (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE candidate_resumes
  ADD CONSTRAINT "candidate_resumes_candidate_id_candidates_id_fk"
  FOREIGN KEY (candidate_id) REFERENCES candidates (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE candidate_sla_tracking
  ADD CONSTRAINT "candidate_sla_tracking_candidate_id_candidates_id_fk"
  FOREIGN KEY (candidate_id) REFERENCES candidates (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE email_sequence_enrollments
  ADD CONSTRAINT "email_sequence_enrollments_candidate_id_candidates_id_fk"
  FOREIGN KEY (candidate_id) REFERENCES candidates (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE email_sequence_enrollments
  ADD CONSTRAINT "email_sequence_enrollments_sequence_id_email_sequences_id_fk"
  FOREIGN KEY (sequence_id) REFERENCES email_sequences (id)
  NOT VALID;

-- ── 0951: HR/recruitment cluster part 2 ─────────────────────────────────────

--> statement-breakpoint
ALTER TABLE employee_career_plans
  ADD CONSTRAINT "employee_career_plans_path_id_career_paths_id_fk"
  FOREIGN KEY (path_id) REFERENCES career_paths (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE employee_salary_profile_components
  ADD CONSTRAINT "employee_salary_profile_components_profile_id_employee_salary_p"
  FOREIGN KEY (profile_id) REFERENCES employee_salary_profiles (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE employee_salary_profile_components
  ADD CONSTRAINT "employee_salary_profile_components_component_id_salary_componen"
  FOREIGN KEY (component_id) REFERENCES salary_components (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE employee_shift_assignments
  ADD CONSTRAINT "employee_shift_assignments_shift_id_shift_templates_id_fk"
  FOREIGN KEY (shift_id) REFERENCES shift_templates (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE external_referrals
  ADD CONSTRAINT "external_referrals_candidate_id_candidates_id_fk"
  FOREIGN KEY (candidate_id) REFERENCES candidates (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE external_referrals
  ADD CONSTRAINT "external_referrals_referrer_id_external_referrers_id_fk"
  FOREIGN KEY (referrer_id) REFERENCES external_referrers (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE external_referrals
  ADD CONSTRAINT "external_referrals_job_posting_id_job_postings_id_fk"
  FOREIGN KEY (job_posting_id) REFERENCES job_postings (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE headcount_requests
  ADD CONSTRAINT "headcount_requests_linked_job_posting_id_job_postings_id_fk"
  FOREIGN KEY (linked_job_posting_id) REFERENCES job_postings (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE headcount_requests
  ADD CONSTRAINT "headcount_requests_org_department_id_org_units_id_fk"
  FOREIGN KEY (org_department_id) REFERENCES org_units (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hiring_flow_rounds
  ADD CONSTRAINT "hiring_flow_rounds_flow_id_hiring_flows_id_fk"
  FOREIGN KEY (flow_id) REFERENCES hiring_flows (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hiring_flow_rounds
  ADD CONSTRAINT "hiring_flow_rounds_scorecard_template_id_scorecard_templates_id_"
  FOREIGN KEY (scorecard_template_id) REFERENCES scorecard_templates (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE interview_booking_links
  ADD CONSTRAINT "interview_booking_links_candidate_id_candidates_id_fk"
  FOREIGN KEY (candidate_id) REFERENCES candidates (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE interview_booking_links
  ADD CONSTRAINT "interview_booking_links_job_posting_id_job_postings_id_fk"
  FOREIGN KEY (job_posting_id) REFERENCES job_postings (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE interview_panel_members
  ADD CONSTRAINT "interview_panel_members_interview_id_interviews_id_fk"
  FOREIGN KEY (interview_id) REFERENCES interviews (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE interview_scorecards
  ADD CONSTRAINT "interview_scorecards_interview_id_interviews_id_fk"
  FOREIGN KEY (interview_id) REFERENCES interviews (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE interview_scorecards
  ADD CONSTRAINT "interview_scorecards_template_id_scorecard_templates_id_fk"
  FOREIGN KEY (template_id) REFERENCES scorecard_templates (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE investment_proofs
  ADD CONSTRAINT "investment_proofs_declaration_id_tax_declarations_id_fk"
  FOREIGN KEY (declaration_id) REFERENCES tax_declarations (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE job_board_postings
  ADD CONSTRAINT "job_board_postings_job_posting_id_job_postings_id_fk"
  FOREIGN KEY (job_posting_id) REFERENCES job_postings (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE job_postings
  ADD CONSTRAINT "job_postings_hiring_flow_id_hiring_flows_id_fk"
  FOREIGN KEY (hiring_flow_id) REFERENCES hiring_flows (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE job_postings
  ADD CONSTRAINT "job_postings_org_department_id_org_units_id_fk"
  FOREIGN KEY (org_department_id) REFERENCES org_units (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE job_recruiters
  ADD CONSTRAINT "job_recruiters_job_posting_id_job_postings_id_fk"
  FOREIGN KEY (job_posting_id) REFERENCES job_postings (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE offer_negotiations
  ADD CONSTRAINT "offer_negotiations_offer_id_candidate_offers_id_fk"
  FOREIGN KEY (offer_id) REFERENCES candidate_offers (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE offer_versions
  ADD CONSTRAINT "offer_versions_offer_id_candidate_offers_id_fk"
  FOREIGN KEY (offer_id) REFERENCES candidate_offers (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE recruiter_activity_log
  ADD CONSTRAINT "recruiter_activity_log_candidate_id_candidates_id_fk"
  FOREIGN KEY (candidate_id) REFERENCES candidates (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE recruiter_activity_log
  ADD CONSTRAINT "recruiter_activity_log_job_posting_id_job_postings_id_fk"
  FOREIGN KEY (job_posting_id) REFERENCES job_postings (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE review_cycles
  ADD CONSTRAINT "review_cycles_template_id_hr_templates_id_fk"
  FOREIGN KEY (template_id) REFERENCES hr_templates (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE review_cycles
  ADD CONSTRAINT "review_cycles_department_id_org_units_id_fk"
  FOREIGN KEY (department_id) REFERENCES org_units (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE roster_entries
  ADD CONSTRAINT "roster_entries_roster_id_rosters_id_fk"
  FOREIGN KEY (roster_id) REFERENCES rosters (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE roster_entries
  ADD CONSTRAINT "roster_entries_shift_id_shift_templates_id_fk"
  FOREIGN KEY (shift_id) REFERENCES shift_templates (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE talent_pool_members
  ADD CONSTRAINT "talent_pool_members_candidate_id_candidates_id_fk"
  FOREIGN KEY (candidate_id) REFERENCES candidates (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE talent_pool_members
  ADD CONSTRAINT "talent_pool_members_pool_id_talent_pools_id_fk"
  FOREIGN KEY (pool_id) REFERENCES talent_pools (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE vault_access_logs
  ADD CONSTRAINT "vault_access_logs_vault_document_id_candidate_documents_vault_i"
  FOREIGN KEY (vault_document_id) REFERENCES candidate_documents_vault (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE vault_access_logs
  ADD CONSTRAINT "vault_access_logs_candidate_id_candidates_id_fk"
  FOREIGN KEY (candidate_id) REFERENCES candidates (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE vendor_candidate_submissions
  ADD CONSTRAINT "vendor_candidate_submissions_candidate_id_candidates_id_fk"
  FOREIGN KEY (candidate_id) REFERENCES candidates (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE vendor_candidate_submissions
  ADD CONSTRAINT "vendor_candidate_submissions_job_posting_id_job_postings_id_fk"
  FOREIGN KEY (job_posting_id) REFERENCES job_postings (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE vendor_candidate_submissions
  ADD CONSTRAINT "vendor_candidate_submissions_vendor_id_recruitment_vendors_id_f"
  FOREIGN KEY (vendor_id) REFERENCES recruitment_vendors (id)
  NOT VALID;

-- ── 0952: HR core part 1 ────────────────────────────────────────────────────

--> statement-breakpoint
ALTER TABLE hr_accommodation_tasks
  ADD CONSTRAINT "hr_accommodation_tasks_request_id_hr_accommodation_requests_id_"
  FOREIGN KEY (request_id) REFERENCES hr_accommodation_requests (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_automation_runs
  ADD CONSTRAINT "hr_automation_runs_rule_id_hr_automation_rules_id_fk"
  FOREIGN KEY (rule_id) REFERENCES hr_automation_rules (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_badge_awards
  ADD CONSTRAINT "hr_badge_awards_badge_id_hr_badges_id_fk"
  FOREIGN KEY (badge_id) REFERENCES hr_badges (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_benefit_enrollment_windows
  ADD CONSTRAINT "hr_benefit_enrollment_windows_plan_id_hr_benefit_plans_id_fk"
  FOREIGN KEY (plan_id) REFERENCES hr_benefit_plans (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_benefit_enrollments
  ADD CONSTRAINT "hr_benefit_enrollments_plan_id_hr_benefit_plans_id_fk"
  FOREIGN KEY (plan_id) REFERENCES hr_benefit_plans (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_calibration_entries
  ADD CONSTRAINT "hr_calibration_entries_cycle_id_review_cycles_id_fk"
  FOREIGN KEY (cycle_id) REFERENCES review_cycles (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_case_documents
  ADD CONSTRAINT "hr_case_documents_case_id_hr_cases_id_fk"
  FOREIGN KEY (case_id) REFERENCES hr_cases (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_case_notes
  ADD CONSTRAINT "hr_case_notes_case_id_hr_cases_id_fk"
  FOREIGN KEY (case_id) REFERENCES hr_cases (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_community_members
  ADD CONSTRAINT "hr_community_members_community_id_hr_communities_id_fk"
  FOREIGN KEY (community_id) REFERENCES hr_communities (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_comp_budget_pools
  ADD CONSTRAINT "hr_comp_budget_pools_cycle_id_hr_comp_cycles_id_fk"
  FOREIGN KEY (cycle_id) REFERENCES hr_comp_cycles (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_comp_budget_pools
  ADD CONSTRAINT "hr_comp_budget_pools_department_id_org_units_id_fk"
  FOREIGN KEY (department_id) REFERENCES org_units (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_comp_recommendations
  ADD CONSTRAINT "hr_comp_recommendations_cycle_id_hr_comp_cycles_id_fk"
  FOREIGN KEY (cycle_id) REFERENCES hr_comp_cycles (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_comp_recommendations
  ADD CONSTRAINT "hr_comp_recommendations_employment_id_hr_employments_id_fk"
  FOREIGN KEY (employment_id) REFERENCES hr_employments (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_compliance_events
  ADD CONSTRAINT "hr_compliance_events_requirement_id_hr_compliance_requirements_"
  FOREIGN KEY (requirement_id) REFERENCES hr_compliance_requirements (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_contracts
  ADD CONSTRAINT "hr_contracts_employment_id_hr_employments_id_fk"
  FOREIGN KEY (employment_id) REFERENCES hr_employments (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_device_employee_mappings
  ADD CONSTRAINT "hr_device_employee_mappings_device_id_hr_time_devices_id_fk"
  FOREIGN KEY (device_id) REFERENCES hr_time_devices (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_device_employee_mappings
  ADD CONSTRAINT "hr_device_employee_mappings_person_id_hr_people_id_fk"
  FOREIGN KEY (person_id) REFERENCES hr_people (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_device_sync_logs
  ADD CONSTRAINT "hr_device_sync_logs_device_id_hr_time_devices_id_fk"
  FOREIGN KEY (device_id) REFERENCES hr_time_devices (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_disciplinary_actions
  ADD CONSTRAINT "hr_disciplinary_actions_case_id_hr_cases_id_fk"
  FOREIGN KEY (case_id) REFERENCES hr_cases (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_effective_dated_changes
  ADD CONSTRAINT "hr_effective_dated_changes_employment_id_hr_employments_id_fk"
  FOREIGN KEY (employment_id) REFERENCES hr_employments (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_emergency_responses
  ADD CONSTRAINT "hr_emergency_responses_event_id_hr_emergency_events_id_fk"
  FOREIGN KEY (event_id) REFERENCES hr_emergency_events (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_employee_sensitive_fields
  ADD CONSTRAINT "hr_employee_sensitive_fields_employment_id_hr_employments_id_fk"
  FOREIGN KEY (employment_id) REFERENCES hr_employments (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_employment_custom_field_values
  ADD CONSTRAINT "hr_employment_custom_field_values_field_definition_id_custom_fi"
  FOREIGN KEY (field_definition_id) REFERENCES custom_field_definitions (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_employment_custom_field_values
  ADD CONSTRAINT "hr_employment_custom_field_values_employment_id_hr_employments_"
  FOREIGN KEY (employment_id) REFERENCES hr_employments (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_employment_history
  ADD CONSTRAINT "hr_employment_history_employment_id_hr_employments_id_fk"
  FOREIGN KEY (employment_id) REFERENCES hr_employments (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_employments
  ADD CONSTRAINT "hr_employments_job_level_id_hr_job_levels_id_fk"
  FOREIGN KEY (job_level_id) REFERENCES hr_job_levels (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_employments
  ADD CONSTRAINT "hr_employments_job_role_id_hr_job_roles_id_fk"
  FOREIGN KEY (job_role_id) REFERENCES hr_job_roles (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_employments
  ADD CONSTRAINT "hr_employments_person_id_hr_people_id_fk"
  FOREIGN KEY (person_id) REFERENCES hr_people (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_employments
  ADD CONSTRAINT "hr_employments_department_id_org_units_id_fk"
  FOREIGN KEY (department_id) REFERENCES org_units (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_employments
  ADD CONSTRAINT "hr_employments_location_id_org_units_id_fk"
  FOREIGN KEY (location_id) REFERENCES org_units (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_equity_exercises
  ADD CONSTRAINT "hr_equity_exercises_grant_id_hr_equity_grants_id_fk"
  FOREIGN KEY (grant_id) REFERENCES hr_equity_grants (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_equity_vesting_events
  ADD CONSTRAINT "hr_equity_vesting_events_grant_id_hr_equity_grants_id_fk"
  FOREIGN KEY (grant_id) REFERENCES hr_equity_grants (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_form_submissions
  ADD CONSTRAINT "hr_form_submissions_form_id_hr_forms_id_fk"
  FOREIGN KEY (form_id) REFERENCES hr_forms (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_headcount_plans
  ADD CONSTRAINT "hr_headcount_plans_department_id_org_units_id_fk"
  FOREIGN KEY (department_id) REFERENCES org_units (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_helpdesk_comments
  ADD CONSTRAINT "hr_helpdesk_comments_ticket_id_helpdesk_tickets_id_fk"
  FOREIGN KEY (ticket_id) REFERENCES helpdesk_tickets (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_import_rows
  ADD CONSTRAINT "hr_import_rows_job_id_hr_import_jobs_id_fk"
  FOREIGN KEY (job_id) REFERENCES hr_import_jobs (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_insurance_claims
  ADD CONSTRAINT "hr_insurance_claims_plan_id_hr_benefit_plans_id_fk"
  FOREIGN KEY (plan_id) REFERENCES hr_benefit_plans (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_leave_ledger
  ADD CONSTRAINT "hr_leave_ledger_leave_type_id_leave_types_id_fk"
  FOREIGN KEY (leave_type_id) REFERENCES leave_types (id)
  NOT VALID;

-- ── 0953: HR core part 2 + leave ────────────────────────────────────────────

--> statement-breakpoint
ALTER TABLE hr_legal_hold_items
  ADD CONSTRAINT "hr_legal_hold_items_hold_id_hr_legal_holds_id_fk"
  FOREIGN KEY (hold_id) REFERENCES hr_legal_holds (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_payroll_adjustments
  ADD CONSTRAINT "hr_payroll_adjustments_period_id_hr_payroll_input_periods_id_fk"
  FOREIGN KEY (period_id) REFERENCES hr_payroll_input_periods (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_payroll_input_snapshots
  ADD CONSTRAINT "hr_payroll_input_snapshots_period_id_hr_payroll_input_periods_i"
  FOREIGN KEY (period_id) REFERENCES hr_payroll_input_periods (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_policy_scopes
  ADD CONSTRAINT "hr_policy_scopes_policy_id_hr_policies_id_fk"
  FOREIGN KEY (policy_id) REFERENCES hr_policies (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_poll_votes
  ADD CONSTRAINT "hr_poll_votes_poll_id_hr_polls_id_fk"
  FOREIGN KEY (poll_id) REFERENCES hr_polls (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_position_transitions
  ADD CONSTRAINT "hr_position_transitions_from_status_id_hr_position_statuses_id_"
  FOREIGN KEY (from_status_id) REFERENCES hr_position_statuses (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_position_transitions
  ADD CONSTRAINT "hr_position_transitions_to_status_id_hr_position_statuses_id_fk"
  FOREIGN KEY (to_status_id) REFERENCES hr_position_statuses (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_positions
  ADD CONSTRAINT "hr_positions_department_id_org_units_id_fk"
  FOREIGN KEY (department_id) REFERENCES org_units (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_probation_reviews
  ADD CONSTRAINT "hr_probation_reviews_employment_id_hr_employments_id_fk"
  FOREIGN KEY (employment_id) REFERENCES hr_employments (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_probation_reviews
  ADD CONSTRAINT "hr_probation_reviews_person_id_hr_people_id_fk"
  FOREIGN KEY (person_id) REFERENCES hr_people (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_probation_reviews
  ADD CONSTRAINT "hr_probation_reviews_review_template_id_hr_templates_id_fk"
  FOREIGN KEY (review_template_id) REFERENCES hr_templates (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_reporting_lines
  ADD CONSTRAINT "hr_reporting_lines_employment_id_hr_employments_id_fk"
  FOREIGN KEY (employment_id) REFERENCES hr_employments (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_reporting_lines
  ADD CONSTRAINT "hr_reporting_lines_manager_employment_id_hr_employments_id_fk"
  FOREIGN KEY (manager_employment_id) REFERENCES hr_employments (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_role_skill_requirements
  ADD CONSTRAINT "hr_role_skill_requirements_job_role_id_hr_job_roles_id_fk"
  FOREIGN KEY (job_role_id) REFERENCES hr_job_roles (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_succession_plans
  ADD CONSTRAINT "hr_succession_plans_job_role_id_hr_job_roles_id_fk"
  FOREIGN KEY (job_role_id) REFERENCES hr_job_roles (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_template_renders
  ADD CONSTRAINT "hr_template_renders_template_id_hr_templates_id_fk"
  FOREIGN KEY (template_id) REFERENCES hr_templates (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_time_devices
  ADD CONSTRAINT "hr_time_devices_location_id_org_units_id_fk"
  FOREIGN KEY (location_id) REFERENCES org_units (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_webhook_deliveries
  ADD CONSTRAINT "hr_webhook_deliveries_subscription_id_hr_webhook_subscriptions_"
  FOREIGN KEY (subscription_id) REFERENCES hr_webhook_subscriptions (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_work_authorizations
  ADD CONSTRAINT "hr_work_authorizations_employment_id_hr_employments_id_fk"
  FOREIGN KEY (employment_id) REFERENCES hr_employments (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_workflow_instances
  ADD CONSTRAINT "hr_workflow_instances_definition_id_hr_workflow_definitions_id_"
  FOREIGN KEY (definition_id) REFERENCES hr_workflow_definitions (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_workflow_step_actions
  ADD CONSTRAINT "hr_workflow_step_actions_instance_id_hr_workflow_instances_id_f"
  FOREIGN KEY (instance_id) REFERENCES hr_workflow_instances (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_workflow_steps
  ADD CONSTRAINT "hr_workflow_steps_definition_id_hr_workflow_definitions_id_fk"
  FOREIGN KEY (definition_id) REFERENCES hr_workflow_definitions (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE leave_balances
  ADD CONSTRAINT "leave_balances_leave_type_id_leave_types_id_fk"
  FOREIGN KEY (leave_type_id) REFERENCES leave_types (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE leave_policies
  ADD CONSTRAINT "leave_policies_leave_type_id_leave_types_id_fk"
  FOREIGN KEY (leave_type_id) REFERENCES leave_types (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE leave_requests
  ADD CONSTRAINT "leave_requests_leave_type_id_leave_types_id_fk"
  FOREIGN KEY (leave_type_id) REFERENCES leave_types (id)
  NOT VALID;

-- ── 0954: payroll + timesheet ────────────────────────────────────────────────

--> statement-breakpoint
ALTER TABLE payroll_journal_batches
  ADD CONSTRAINT "payroll_journal_batches_reversal_of_batch_id_payroll_journal_ba"
  FOREIGN KEY (reversal_of_batch_id) REFERENCES payroll_journal_batches (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE payroll_run_employees
  ADD CONSTRAINT "payroll_run_employees_run_id_payroll_runs_id_fk"
  FOREIGN KEY (run_id) REFERENCES payroll_runs (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE timesheet_rates
  ADD CONSTRAINT "fk_timesheet_rates_task"
  FOREIGN KEY (task_id) REFERENCES build.tickets (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE timesheet_exceptions
  ADD CONSTRAINT "timesheet_exceptions_entry_id_fkey"
  FOREIGN KEY (entry_id) REFERENCES timesheets (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE timesheet_exceptions
  ADD CONSTRAINT "timesheet_exceptions_period_id_fkey"
  FOREIGN KEY (period_id) REFERENCES timesheet_periods (id) ON DELETE CASCADE
  NOT VALID;

-- ── Pre-existing composite FKs — single-col originals ────────────────────────

--> statement-breakpoint
ALTER TABLE candidates
  ADD CONSTRAINT "candidates_duplicate_of_id_candidates_id_fk"
  FOREIGN KEY (duplicate_of_id) REFERENCES candidates (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE expenses
  ADD CONSTRAINT "expenses_category_id_expense_categories_id_fk"
  FOREIGN KEY (category_id) REFERENCES expense_categories (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE expenses
  ADD CONSTRAINT "expenses_journal_id_payroll_journal_batches_id_fk"
  FOREIGN KEY (journal_id) REFERENCES payroll_journal_batches (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE expenses
  ADD CONSTRAINT "expenses_project_id_projects_id_fk"
  FOREIGN KEY (project_id) REFERENCES build.projects (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE fin_expense_policies
  ADD CONSTRAINT "fin_expense_policies_category_id_expense_categories_id_fk"
  FOREIGN KEY (category_id) REFERENCES expense_categories (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE interviews
  ADD CONSTRAINT "interviews_candidate_id_candidates_id_fk"
  FOREIGN KEY (candidate_id) REFERENCES candidates (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE interviews
  ADD CONSTRAINT "interviews_job_posting_id_job_postings_id_fk"
  FOREIGN KEY (job_posting_id) REFERENCES job_postings (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE timesheet_budgets
  ADD CONSTRAINT "timesheet_budgets_project_id_projects_id_fk"
  FOREIGN KEY (project_id) REFERENCES build.projects (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE timesheet_rates
  ADD CONSTRAINT "timesheet_rates_project_id_projects_id_fk"
  FOREIGN KEY (project_id) REFERENCES build.projects (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE timesheet_rates
  ADD CONSTRAINT "timesheet_rates_rate_card_id_timesheet_rate_cards_id_fk"
  FOREIGN KEY (rate_card_id) REFERENCES timesheet_rate_cards (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE timesheets
  ADD CONSTRAINT "timesheets_payroll_export_id_payroll_exports_id_fk"
  FOREIGN KEY (payroll_export_id) REFERENCES timesheet_exports (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE timesheets
  ADD CONSTRAINT "timesheets_project_id_projects_id_fk"
  FOREIGN KEY (project_id) REFERENCES build.projects (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE timesheets
  ADD CONSTRAINT "timesheets_ticket_id_tickets_id_fk"
  FOREIGN KEY (ticket_id) REFERENCES build.tickets (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE timesheets
  ADD CONSTRAINT "timesheets_timer_session_id_timer_sessions_id_fk"
  FOREIGN KEY (timer_session_id) REFERENCES timer_sessions (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE timesheets
  ADD CONSTRAINT "timesheets_timesheet_period_id_timesheet_periods_id_fk"
  FOREIGN KEY (timesheet_period_id) REFERENCES timesheet_periods (id)
  NOT VALID;
