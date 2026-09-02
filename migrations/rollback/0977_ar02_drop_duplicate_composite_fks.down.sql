-- 0977_ar02_drop_duplicate_composite_fks DOWN — reverses the up migration; each restored constraint is rebuilt from the definition recorded in pg_catalog before it was dropped.

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE build.pm_workspace_memberships
  ADD CONSTRAINT "fk_pm_memberships_org_member"
  FOREIGN KEY (org_id, organization_membership_id) REFERENCES organization_members (org_id, id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.project_team_assignments
  ADD CONSTRAINT "fk_project_team_assignments_team_id_org"
  FOREIGN KEY (org_id, team_id) REFERENCES build.project_teams (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.project_team_assignments
  ADD CONSTRAINT "fk_project_team_assignments_project_id_org"
  FOREIGN KEY (org_id, project_id) REFERENCES build.projects (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.comment_drafts
  ADD CONSTRAINT "fk_comment_drafts_ticket_id_org"
  FOREIGN KEY (org_id, ticket_id) REFERENCES build.tickets (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.project_team_members
  ADD CONSTRAINT "fk_project_team_members_team_id_org"
  FOREIGN KEY (org_id, team_id) REFERENCES build.project_teams (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.feedbucket_widgets
  ADD CONSTRAINT "fk_feedbucket_widgets_project_id_org"
  FOREIGN KEY (org_id, project_id) REFERENCES build.projects (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.feedbucket_submissions
  ADD CONSTRAINT "fk_feedbucket_submissions_widget_id_org"
  FOREIGN KEY (org_id, widget_id) REFERENCES build.feedbucket_widgets (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.feedbucket_submissions
  ADD CONSTRAINT "fk_feedbucket_submissions_linked_ticket_id_org"
  FOREIGN KEY (org_id, linked_ticket_id) REFERENCES build.tickets (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.feedbucket_attachments
  ADD CONSTRAINT "fk_feedbucket_attachments_submission_id_org"
  FOREIGN KEY (org_id, submission_id) REFERENCES build.feedbucket_submissions (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE kb_page_comments
  ADD CONSTRAINT "fk_kb_page_comments_parent_id_org"
  FOREIGN KEY (org_id, parent_id) REFERENCES kb_page_comments (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE kb_categories
  ADD CONSTRAINT "fk_kb_categories_parent_id_org"
  FOREIGN KEY (org_id, parent_id) REFERENCES kb_categories (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE chat_channels
  ADD CONSTRAINT "fk_chat_channels_org_creator_membership"
  FOREIGN KEY (org_id, created_by_membership_id) REFERENCES organization_members (org_id, id) ON DELETE SET NULL (created_by_membership_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_emergency_responses
  ADD CONSTRAINT "fk_hr_emergency_responses_event_id_org"
  FOREIGN KEY (org_id, event_id) REFERENCES hr_emergency_events (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_accommodation_tasks
  ADD CONSTRAINT "fk_hr_accommodation_tasks_request_id_org"
  FOREIGN KEY (org_id, request_id) REFERENCES hr_accommodation_requests (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_equity_vesting_events
  ADD CONSTRAINT "fk_hr_equity_vesting_events_grant_id_org"
  FOREIGN KEY (org_id, grant_id) REFERENCES hr_equity_grants (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_equity_exercises
  ADD CONSTRAINT "fk_hr_equity_exercises_grant_id_org"
  FOREIGN KEY (org_id, grant_id) REFERENCES hr_equity_grants (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_device_sync_logs
  ADD CONSTRAINT "fk_hr_device_sync_logs_device_id_org"
  FOREIGN KEY (org_id, device_id) REFERENCES hr_time_devices (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_device_employee_mappings
  ADD CONSTRAINT "fk_hr_device_employee_mappings_device_id_org"
  FOREIGN KEY (org_id, device_id) REFERENCES hr_time_devices (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_comp_recommendations
  ADD CONSTRAINT "fk_hr_comp_recommendations_cycle_id_org"
  FOREIGN KEY (org_id, cycle_id) REFERENCES hr_comp_cycles (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_comp_budget_pools
  ADD CONSTRAINT "fk_hr_comp_budget_pools_cycle_id_org"
  FOREIGN KEY (org_id, cycle_id) REFERENCES hr_comp_cycles (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_legal_hold_items
  ADD CONSTRAINT "fk_hr_legal_hold_items_hold_id_org"
  FOREIGN KEY (org_id, hold_id) REFERENCES hr_legal_holds (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_form_submissions
  ADD CONSTRAINT "fk_hr_form_submissions_form_id_org"
  FOREIGN KEY (org_id, form_id) REFERENCES hr_forms (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_work_authorizations
  ADD CONSTRAINT "fk_hr_work_authorizations_employment_id_org"
  FOREIGN KEY (org_id, employment_id) REFERENCES hr_employments (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_contracts
  ADD CONSTRAINT "fk_hr_contracts_employment_id_org"
  FOREIGN KEY (org_id, employment_id) REFERENCES hr_employments (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_compliance_events
  ADD CONSTRAINT "fk_hr_compliance_events_requirement_id_org"
  FOREIGN KEY (org_id, requirement_id) REFERENCES hr_compliance_requirements (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_import_rows
  ADD CONSTRAINT "fk_hr_import_rows_job_id_org"
  FOREIGN KEY (org_id, job_id) REFERENCES hr_import_jobs (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_webhook_deliveries
  ADD CONSTRAINT "fk_hr_webhook_deliveries_subscription_id_org"
  FOREIGN KEY (org_id, subscription_id) REFERENCES hr_webhook_subscriptions (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_insurance_claims
  ADD CONSTRAINT "fk_hr_insurance_claims_plan_id_org"
  FOREIGN KEY (org_id, plan_id) REFERENCES hr_benefit_plans (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_benefit_enrollments
  ADD CONSTRAINT "fk_hr_benefit_enrollments_plan_id_org"
  FOREIGN KEY (org_id, plan_id) REFERENCES hr_benefit_plans (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_benefit_enrollment_windows
  ADD CONSTRAINT "fk_hr_benefit_enrollment_windows_plan_id_org"
  FOREIGN KEY (org_id, plan_id) REFERENCES hr_benefit_plans (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_disciplinary_actions
  ADD CONSTRAINT "fk_hr_disciplinary_actions_case_id_org"
  FOREIGN KEY (org_id, case_id) REFERENCES hr_cases (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_case_notes
  ADD CONSTRAINT "fk_hr_case_notes_case_id_org"
  FOREIGN KEY (org_id, case_id) REFERENCES hr_cases (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_case_documents
  ADD CONSTRAINT "fk_hr_case_documents_case_id_org"
  FOREIGN KEY (org_id, case_id) REFERENCES hr_cases (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_poll_votes
  ADD CONSTRAINT "fk_hr_poll_votes_poll_id_org"
  FOREIGN KEY (org_id, poll_id) REFERENCES hr_polls (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_community_members
  ADD CONSTRAINT "fk_hr_community_members_community_id_org"
  FOREIGN KEY (org_id, community_id) REFERENCES hr_communities (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_badge_awards
  ADD CONSTRAINT "fk_hr_badge_awards_badge_id_org"
  FOREIGN KEY (org_id, badge_id) REFERENCES hr_badges (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_succession_plans
  ADD CONSTRAINT "fk_hr_succession_plans_job_role_id_org"
  FOREIGN KEY (org_id, job_role_id) REFERENCES hr_job_roles (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_role_skill_requirements
  ADD CONSTRAINT "fk_hr_role_skill_requirements_job_role_id_org"
  FOREIGN KEY (org_id, job_role_id) REFERENCES hr_job_roles (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_probation_reviews
  ADD CONSTRAINT "fk_hr_probation_reviews_review_template_id_org"
  FOREIGN KEY (org_id, review_template_id) REFERENCES hr_templates (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_probation_reviews
  ADD CONSTRAINT "fk_hr_probation_reviews_person_id_org"
  FOREIGN KEY (org_id, person_id) REFERENCES hr_people (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_probation_reviews
  ADD CONSTRAINT "fk_hr_probation_reviews_employment_id_org"
  FOREIGN KEY (org_id, employment_id) REFERENCES hr_employments (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE employee_salary_profile_components
  ADD CONSTRAINT "fk_employee_salary_profile_components_org_component"
  FOREIGN KEY (org_id, component_id) REFERENCES salary_components (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE employee_salary_profile_components
  ADD CONSTRAINT "fk_employee_salary_profile_components_profile_id_org"
  FOREIGN KEY (org_id, profile_id) REFERENCES employee_salary_profiles (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE payroll_run_employees
  ADD CONSTRAINT "fk_payroll_run_employees_run_id_org"
  FOREIGN KEY (org_id, run_id) REFERENCES payroll_runs (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE investment_proofs
  ADD CONSTRAINT "fk_investment_proofs_declaration_id_org"
  FOREIGN KEY (org_id, declaration_id) REFERENCES tax_declarations (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE leave_policies
  ADD CONSTRAINT "fk_leave_policies_leave_type_id_org"
  FOREIGN KEY (org_id, leave_type_id) REFERENCES leave_types (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE employee_career_plans
  ADD CONSTRAINT "fk_employee_career_plans_path_id_org"
  FOREIGN KEY (org_id, path_id) REFERENCES career_paths (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE roster_entries
  ADD CONSTRAINT "fk_roster_entries_roster_id_org"
  FOREIGN KEY (org_id, roster_id) REFERENCES rosters (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE roster_entries
  ADD CONSTRAINT "fk_roster_entries_shift_id_org"
  FOREIGN KEY (org_id, shift_id) REFERENCES shift_templates (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE employee_shift_assignments
  ADD CONSTRAINT "fk_employee_shift_assignments_shift_id_org"
  FOREIGN KEY (org_id, shift_id) REFERENCES shift_templates (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE review_cycles
  ADD CONSTRAINT "fk_review_cycles_template_id_org"
  FOREIGN KEY (org_id, template_id) REFERENCES hr_templates (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_calibration_entries
  ADD CONSTRAINT "fk_hr_calibration_entries_cycle_id_org"
  FOREIGN KEY (org_id, cycle_id) REFERENCES review_cycles (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE external_referrals
  ADD CONSTRAINT "fk_external_referrals_referrer_id_org"
  FOREIGN KEY (org_id, referrer_id) REFERENCES external_referrers (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE external_referrals
  ADD CONSTRAINT "fk_external_referrals_org_job_posting"
  FOREIGN KEY (org_id, job_posting_id) REFERENCES job_postings (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE external_referrals
  ADD CONSTRAINT "fk_external_referrals_candidate_id_org"
  FOREIGN KEY (org_id, candidate_id) REFERENCES candidates (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE talent_pool_members
  ADD CONSTRAINT "fk_talent_pool_members_pool_id_org"
  FOREIGN KEY (org_id, pool_id) REFERENCES talent_pools (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE talent_pool_members
  ADD CONSTRAINT "fk_talent_pool_members_candidate_id_org"
  FOREIGN KEY (org_id, candidate_id) REFERENCES candidates (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE job_board_postings
  ADD CONSTRAINT "fk_job_board_postings_job_posting_id_org"
  FOREIGN KEY (org_id, job_posting_id) REFERENCES job_postings (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE candidate_documents
  ADD CONSTRAINT "fk_candidate_documents_template_id_org"
  FOREIGN KEY (org_id, template_id) REFERENCES document_templates (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE candidate_documents
  ADD CONSTRAINT "fk_candidate_documents_candidate_id_org"
  FOREIGN KEY (org_id, candidate_id) REFERENCES candidates (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE vendor_candidate_submissions
  ADD CONSTRAINT "fk_vendor_candidate_submissions_vendor_id_org"
  FOREIGN KEY (org_id, vendor_id) REFERENCES recruitment_vendors (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE vendor_candidate_submissions
  ADD CONSTRAINT "fk_vendor_candidate_submissions_job_posting_id_org"
  FOREIGN KEY (org_id, job_posting_id) REFERENCES job_postings (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE vendor_candidate_submissions
  ADD CONSTRAINT "fk_vendor_candidate_submissions_candidate_id_org"
  FOREIGN KEY (org_id, candidate_id) REFERENCES candidates (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE vault_access_logs
  ADD CONSTRAINT "fk_vault_access_logs_candidate_id_org"
  FOREIGN KEY (org_id, candidate_id) REFERENCES candidates (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE vault_access_logs
  ADD CONSTRAINT "fk_vault_access_logs_vault_document_id_org"
  FOREIGN KEY (org_id, vault_document_id) REFERENCES candidate_documents_vault (org_id, id) ON DELETE SET NULL (vault_document_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE recruiter_activity_log
  ADD CONSTRAINT "fk_recruiter_activity_log_job_posting_id_org"
  FOREIGN KEY (org_id, job_posting_id) REFERENCES job_postings (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE recruiter_activity_log
  ADD CONSTRAINT "fk_recruiter_activity_log_candidate_id_org"
  FOREIGN KEY (org_id, candidate_id) REFERENCES candidates (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE offer_versions
  ADD CONSTRAINT "fk_offer_versions_offer_id_org"
  FOREIGN KEY (org_id, offer_id) REFERENCES candidate_offers (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE offer_negotiations
  ADD CONSTRAINT "fk_offer_negotiations_offer_id_org"
  FOREIGN KEY (org_id, offer_id) REFERENCES candidate_offers (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE job_recruiters
  ADD CONSTRAINT "fk_job_recruiters_job_posting_id_org"
  FOREIGN KEY (org_id, job_posting_id) REFERENCES job_postings (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE job_postings
  ADD CONSTRAINT "fk_job_postings_org_hiring_flow"
  FOREIGN KEY (org_id, hiring_flow_id) REFERENCES hiring_flows (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE interview_scorecards
  ADD CONSTRAINT "fk_interview_scorecards_template_id_org"
  FOREIGN KEY (org_id, template_id) REFERENCES scorecard_templates (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE interview_scorecards
  ADD CONSTRAINT "fk_interview_scorecards_interview_id_org"
  FOREIGN KEY (org_id, interview_id) REFERENCES interviews (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE interview_panel_members
  ADD CONSTRAINT "fk_interview_panel_members_interview_id_org"
  FOREIGN KEY (org_id, interview_id) REFERENCES interviews (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE interview_booking_links
  ADD CONSTRAINT "fk_interview_booking_links_org_job_posting"
  FOREIGN KEY (org_id, job_posting_id) REFERENCES job_postings (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE interview_booking_links
  ADD CONSTRAINT "fk_interview_booking_links_candidate_id_org"
  FOREIGN KEY (org_id, candidate_id) REFERENCES candidates (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hiring_flow_rounds
  ADD CONSTRAINT "fk_hiring_flow_rounds_scorecard_template_id_org"
  FOREIGN KEY (org_id, scorecard_template_id) REFERENCES scorecard_templates (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hiring_flow_rounds
  ADD CONSTRAINT "fk_hiring_flow_rounds_flow_id_org"
  FOREIGN KEY (org_id, flow_id) REFERENCES hiring_flows (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE headcount_requests
  ADD CONSTRAINT "fk_headcount_requests_linked_job_posting_id_org"
  FOREIGN KEY (org_id, linked_job_posting_id) REFERENCES job_postings (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE email_sequence_enrollments
  ADD CONSTRAINT "fk_email_sequence_enrollments_sequence_id_org"
  FOREIGN KEY (org_id, sequence_id) REFERENCES email_sequences (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE email_sequence_enrollments
  ADD CONSTRAINT "fk_email_sequence_enrollments_candidate_id_org"
  FOREIGN KEY (org_id, candidate_id) REFERENCES candidates (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE candidate_sla_tracking
  ADD CONSTRAINT "fk_candidate_sla_tracking_candidate_id_org"
  FOREIGN KEY (org_id, candidate_id) REFERENCES candidates (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE candidate_referrals
  ADD CONSTRAINT "fk_candidate_referrals_org_job_posting"
  FOREIGN KEY (org_id, job_posting_id) REFERENCES job_postings (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE candidate_referrals
  ADD CONSTRAINT "fk_candidate_referrals_candidate_id_org"
  FOREIGN KEY (org_id, candidate_id) REFERENCES candidates (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE candidate_reference_checks
  ADD CONSTRAINT "fk_candidate_reference_checks_candidate_id_org"
  FOREIGN KEY (org_id, candidate_id) REFERENCES candidates (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE candidate_offers
  ADD CONSTRAINT "fk_candidate_offers_org_job_posting"
  FOREIGN KEY (org_id, job_posting_id) REFERENCES job_postings (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE candidate_offers
  ADD CONSTRAINT "fk_candidate_offers_candidate_id_org"
  FOREIGN KEY (org_id, candidate_id) REFERENCES candidates (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE candidate_messages
  ADD CONSTRAINT "fk_candidate_messages_candidate_id_org"
  FOREIGN KEY (org_id, candidate_id) REFERENCES candidates (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE candidate_documents_vault
  ADD CONSTRAINT "fk_candidate_documents_vault_candidate_id_org"
  FOREIGN KEY (org_id, candidate_id) REFERENCES candidates (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE candidate_applications
  ADD CONSTRAINT "fk_candidate_applications_job_posting_id_org"
  FOREIGN KEY (org_id, job_posting_id) REFERENCES job_postings (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE candidate_applications
  ADD CONSTRAINT "fk_candidate_applications_candidate_id_org"
  FOREIGN KEY (org_id, candidate_id) REFERENCES candidates (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE calibration_sessions
  ADD CONSTRAINT "fk_calibration_sessions_org_job_posting"
  FOREIGN KEY (org_id, job_posting_id) REFERENCES job_postings (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE calibration_sessions
  ADD CONSTRAINT "fk_calibration_sessions_candidate_id_org"
  FOREIGN KEY (org_id, candidate_id) REFERENCES candidates (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE calibration_participants
  ADD CONSTRAINT "fk_calibration_participants_session_id_org"
  FOREIGN KEY (org_id, session_id) REFERENCES calibration_sessions (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE booking_link_interviewers
  ADD CONSTRAINT "fk_booking_link_interviewers_booking_link_id_org"
  FOREIGN KEY (org_id, booking_link_id) REFERENCES interview_booking_links (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_leave_ledger
  ADD CONSTRAINT "fk_hr_leave_ledger_org_leave_type"
  FOREIGN KEY (org_id, leave_type_id) REFERENCES leave_types (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE leave_requests
  ADD CONSTRAINT "fk_leave_requests_org_leave_type"
  FOREIGN KEY (org_id, leave_type_id) REFERENCES leave_types (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE leave_balances
  ADD CONSTRAINT "fk_leave_balances_leave_type_id_org"
  FOREIGN KEY (org_id, leave_type_id) REFERENCES leave_types (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_helpdesk_comments
  ADD CONSTRAINT "fk_hr_helpdesk_comments_ticket_id_org"
  FOREIGN KEY (org_id, ticket_id) REFERENCES helpdesk_tickets (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_payroll_input_snapshots
  ADD CONSTRAINT "fk_hr_payroll_input_snapshots_period_id_org"
  FOREIGN KEY (org_id, period_id) REFERENCES hr_payroll_input_periods (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_payroll_adjustments
  ADD CONSTRAINT "fk_hr_payroll_adjustments_period_id_org"
  FOREIGN KEY (org_id, period_id) REFERENCES hr_payroll_input_periods (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_template_renders
  ADD CONSTRAINT "fk_hr_template_renders_template_id_org"
  FOREIGN KEY (org_id, template_id) REFERENCES hr_templates (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_workflow_steps
  ADD CONSTRAINT "fk_hr_workflow_steps_definition_id_org"
  FOREIGN KEY (org_id, definition_id) REFERENCES hr_workflow_definitions (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_workflow_step_actions
  ADD CONSTRAINT "fk_hr_workflow_step_actions_instance_id_org"
  FOREIGN KEY (org_id, instance_id) REFERENCES hr_workflow_instances (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_workflow_instances
  ADD CONSTRAINT "fk_hr_workflow_instances_org_definition"
  FOREIGN KEY (org_id, definition_id) REFERENCES hr_workflow_definitions (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_policy_scopes
  ADD CONSTRAINT "fk_hr_policy_scopes_policy_id_org"
  FOREIGN KEY (org_id, policy_id) REFERENCES hr_policies (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_automation_runs
  ADD CONSTRAINT "fk_hr_automation_runs_rule_id_org"
  FOREIGN KEY (org_id, rule_id) REFERENCES hr_automation_rules (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_reporting_lines
  ADD CONSTRAINT "fk_hr_reporting_lines_employment_id_org"
  FOREIGN KEY (org_id, employment_id) REFERENCES hr_employments (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_employments
  ADD CONSTRAINT "fk_hr_employments_person_id_org"
  FOREIGN KEY (org_id, person_id) REFERENCES hr_people (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_employment_history
  ADD CONSTRAINT "fk_hr_employment_history_employment_id_org"
  FOREIGN KEY (org_id, employment_id) REFERENCES hr_employments (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_employee_sensitive_fields
  ADD CONSTRAINT "fk_hr_employee_sensitive_fields_employment_id_org"
  FOREIGN KEY (org_id, employment_id) REFERENCES hr_employments (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE hr_effective_dated_changes
  ADD CONSTRAINT "fk_hr_effective_dated_changes_employment_id_org"
  FOREIGN KEY (org_id, employment_id) REFERENCES hr_employments (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.workflow_transitions
  ADD CONSTRAINT "fk_workflow_transitions_from_status_id_org"
  FOREIGN KEY (org_id, from_status_id) REFERENCES build.project_statuses (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.workflow_transitions
  ADD CONSTRAINT "fk_workflow_transitions_project_id_org"
  FOREIGN KEY (org_id, project_id) REFERENCES build.projects (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.project_programs
  ADD CONSTRAINT "fk_project_programs_portfolio_id_org"
  FOREIGN KEY (org_id, portfolio_id) REFERENCES build.project_portfolios (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.program_projects
  ADD CONSTRAINT "fk_program_projects_program_id_org"
  FOREIGN KEY (org_id, program_id) REFERENCES build.project_programs (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.program_projects
  ADD CONSTRAINT "fk_program_projects_project_id_org"
  FOREIGN KEY (org_id, project_id) REFERENCES build.projects (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.portfolio_projects
  ADD CONSTRAINT "fk_portfolio_projects_portfolio_id_org"
  FOREIGN KEY (org_id, portfolio_id) REFERENCES build.project_portfolios (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.portfolio_projects
  ADD CONSTRAINT "fk_portfolio_projects_project_id_org"
  FOREIGN KEY (org_id, project_id) REFERENCES build.projects (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.project_forms
  ADD CONSTRAINT "fk_project_forms_project_id_org"
  FOREIGN KEY (org_id, project_id) REFERENCES build.projects (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.form_submissions
  ADD CONSTRAINT "fk_form_submissions_form_id_org"
  FOREIGN KEY (org_id, form_id) REFERENCES build.project_forms (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.form_submissions
  ADD CONSTRAINT "fk_form_submissions_converted_ticket_id_org"
  FOREIGN KEY (org_id, converted_ticket_id) REFERENCES build.tickets (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.form_submissions
  ADD CONSTRAINT "fk_form_submissions_project_id_org"
  FOREIGN KEY (org_id, project_id) REFERENCES build.projects (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.project_incidents
  ADD CONSTRAINT "fk_project_incidents_linked_ticket_id_org"
  FOREIGN KEY (org_id, linked_ticket_id) REFERENCES build.tickets (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.project_incidents
  ADD CONSTRAINT "fk_project_incidents_project_id_org"
  FOREIGN KEY (org_id, project_id) REFERENCES build.projects (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.incident_updates
  ADD CONSTRAINT "fk_incident_updates_incident_id_org"
  FOREIGN KEY (org_id, incident_id) REFERENCES build.project_incidents (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.project_meetings
  ADD CONSTRAINT "fk_project_meetings_sprint_id_org"
  FOREIGN KEY (org_id, sprint_id) REFERENCES build.sprints (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.project_meetings
  ADD CONSTRAINT "fk_project_meetings_project_id_org"
  FOREIGN KEY (org_id, project_id) REFERENCES build.projects (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.meeting_standup_entries
  ADD CONSTRAINT "fk_meeting_standup_entries_meeting_id_org"
  FOREIGN KEY (org_id, meeting_id) REFERENCES build.project_meetings (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.meeting_attendees
  ADD CONSTRAINT "fk_meeting_attendees_meeting_id_org"
  FOREIGN KEY (org_id, meeting_id) REFERENCES build.project_meetings (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.meeting_action_items
  ADD CONSTRAINT "fk_meeting_action_items_meeting_id_org"
  FOREIGN KEY (org_id, meeting_id) REFERENCES build.project_meetings (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.meeting_action_items
  ADD CONSTRAINT "fk_meeting_action_items_converted_ticket_id_org"
  FOREIGN KEY (org_id, converted_ticket_id) REFERENCES build.tickets (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.meeting_action_items
  ADD CONSTRAINT "fk_meeting_action_items_project_id_org"
  FOREIGN KEY (org_id, project_id) REFERENCES build.projects (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.project_risks
  ADD CONSTRAINT "fk_project_risks_linked_ticket_id_org"
  FOREIGN KEY (org_id, linked_ticket_id) REFERENCES build.tickets (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.project_risks
  ADD CONSTRAINT "fk_project_risks_project_id_org"
  FOREIGN KEY (org_id, project_id) REFERENCES build.projects (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.project_decisions
  ADD CONSTRAINT "fk_project_decisions_linked_ticket_id_org"
  FOREIGN KEY (org_id, linked_ticket_id) REFERENCES build.tickets (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.project_decisions
  ADD CONSTRAINT "fk_project_decisions_project_id_org"
  FOREIGN KEY (org_id, project_id) REFERENCES build.projects (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.project_approvals
  ADD CONSTRAINT "fk_project_approvals_project_id_org"
  FOREIGN KEY (org_id, project_id) REFERENCES build.projects (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.change_requests
  ADD CONSTRAINT "fk_change_requests_project_id_org"
  FOREIGN KEY (org_id, project_id) REFERENCES build.projects (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.bugs
  ADD CONSTRAINT "fk_bugs_linked_test_case_id_org"
  FOREIGN KEY (org_id, linked_test_case_id) REFERENCES build.test_cases (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.bugs
  ADD CONSTRAINT "fk_bugs_linked_ticket_id_org"
  FOREIGN KEY (org_id, linked_ticket_id) REFERENCES build.tickets (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.bugs
  ADD CONSTRAINT "fk_bugs_affected_release_id_org"
  FOREIGN KEY (org_id, affected_release_id) REFERENCES build.project_releases (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.bugs
  ADD CONSTRAINT "fk_bugs_project_id_org"
  FOREIGN KEY (org_id, project_id) REFERENCES build.projects (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.test_suites
  ADD CONSTRAINT "fk_test_suites_parent_id_org"
  FOREIGN KEY (org_id, parent_id) REFERENCES build.test_suites (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.test_suites
  ADD CONSTRAINT "fk_test_suites_project_id_org"
  FOREIGN KEY (org_id, project_id) REFERENCES build.projects (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.test_runs
  ADD CONSTRAINT "fk_test_runs_release_id_org"
  FOREIGN KEY (org_id, release_id) REFERENCES build.project_releases (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.test_runs
  ADD CONSTRAINT "fk_test_runs_sprint_id_org"
  FOREIGN KEY (org_id, sprint_id) REFERENCES build.sprints (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.test_runs
  ADD CONSTRAINT "fk_test_runs_project_id_org"
  FOREIGN KEY (org_id, project_id) REFERENCES build.projects (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.test_run_results
  ADD CONSTRAINT "fk_test_run_results_linked_bug_id_org"
  FOREIGN KEY (org_id, linked_bug_id) REFERENCES build.bugs (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.test_run_results
  ADD CONSTRAINT "fk_test_run_results_run_id_org"
  FOREIGN KEY (org_id, run_id) REFERENCES build.test_runs (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.test_run_results
  ADD CONSTRAINT "fk_test_run_results_test_case_id_org"
  FOREIGN KEY (org_id, test_case_id) REFERENCES build.test_cases (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.test_run_results
  ADD CONSTRAINT "fk_test_run_results_project_id_org"
  FOREIGN KEY (org_id, project_id) REFERENCES build.projects (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.test_cases
  ADD CONSTRAINT "fk_test_cases_suite_id_org"
  FOREIGN KEY (org_id, suite_id) REFERENCES build.test_suites (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.test_cases
  ADD CONSTRAINT "fk_test_cases_linked_ticket_id_org"
  FOREIGN KEY (org_id, linked_ticket_id) REFERENCES build.tickets (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.test_cases
  ADD CONSTRAINT "fk_test_cases_project_id_org"
  FOREIGN KEY (org_id, project_id) REFERENCES build.projects (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.ticket_comment_mentions
  ADD CONSTRAINT "fk_ticket_comment_mentions_comment_id_org"
  FOREIGN KEY (org_id, comment_id) REFERENCES ticket_comments (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE ticket_activity_log
  ADD CONSTRAINT "fk_ticket_activity_log_ticket_id_org"
  FOREIGN KEY (org_id, ticket_id) REFERENCES build.tickets (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.git_ticket_links
  ADD CONSTRAINT "fk_git_ticket_links_connection_id_org"
  FOREIGN KEY (org_id, connection_id) REFERENCES build.git_connections (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.git_ticket_links
  ADD CONSTRAINT "fk_git_ticket_links_ticket_id_org"
  FOREIGN KEY (org_id, ticket_id) REFERENCES build.tickets (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.git_connections
  ADD CONSTRAINT "fk_git_connections_project_id_org"
  FOREIGN KEY (org_id, project_id) REFERENCES build.projects (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.project_whiteboards
  ADD CONSTRAINT "fk_project_whiteboards_project_id_org"
  FOREIGN KEY (org_id, project_id) REFERENCES build.projects (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.project_whiteboard_shares
  ADD CONSTRAINT "fk_project_whiteboard_shares_whiteboard_id_org"
  FOREIGN KEY (org_id, whiteboard_id) REFERENCES build.project_whiteboards (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.roadmap_votes
  ADD CONSTRAINT "fk_roadmap_votes_roadmap_item_id_org"
  FOREIGN KEY (org_id, roadmap_item_id) REFERENCES build.roadmap_items (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.roadmap_items
  ADD CONSTRAINT "fk_roadmap_items_epic_ticket_id_org"
  FOREIGN KEY (org_id, epic_ticket_id) REFERENCES build.tickets (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.roadmap_items
  ADD CONSTRAINT "fk_roadmap_items_project_id_org"
  FOREIGN KEY (org_id, project_id) REFERENCES build.projects (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.feedback_votes
  ADD CONSTRAINT "fk_feedback_votes_feedback_post_id_org"
  FOREIGN KEY (org_id, feedback_post_id) REFERENCES build.feedback_posts (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.feedback_posts
  ADD CONSTRAINT "fk_feedback_posts_linked_roadmap_item_id_org"
  FOREIGN KEY (org_id, linked_roadmap_item_id) REFERENCES build.roadmap_items (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.changelog_entries
  ADD CONSTRAINT "fk_changelog_entries_linked_roadmap_item_id_org"
  FOREIGN KEY (org_id, linked_roadmap_item_id) REFERENCES build.roadmap_items (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.okr_updates
  ADD CONSTRAINT "fk_okr_updates_key_result_id_org"
  FOREIGN KEY (org_id, key_result_id) REFERENCES build.okr_key_results (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.okr_updates
  ADD CONSTRAINT "fk_okr_updates_goal_id_org"
  FOREIGN KEY (org_id, goal_id) REFERENCES build.okr_goals (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.okr_links
  ADD CONSTRAINT "fk_okr_links_goal_id_org"
  FOREIGN KEY (org_id, goal_id) REFERENCES build.okr_goals (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.okr_links
  ADD CONSTRAINT "fk_okr_links_ticket_id_org"
  FOREIGN KEY (org_id, ticket_id) REFERENCES build.tickets (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.okr_links
  ADD CONSTRAINT "fk_okr_links_project_id_org"
  FOREIGN KEY (org_id, project_id) REFERENCES build.projects (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.okr_key_results
  ADD CONSTRAINT "fk_okr_key_results_goal_id_org"
  FOREIGN KEY (org_id, goal_id) REFERENCES build.okr_goals (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.okr_goals
  ADD CONSTRAINT "fk_okr_goals_project_id_org"
  FOREIGN KEY (org_id, project_id) REFERENCES build.projects (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.project_daily_snapshots
  ADD CONSTRAINT "fk_project_daily_snapshots_project_id_org"
  FOREIGN KEY (org_id, project_id) REFERENCES build.projects (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.project_views
  ADD CONSTRAINT "fk_project_views_project_id_org"
  FOREIGN KEY (org_id, project_id) REFERENCES build.projects (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.project_statuses
  ADD CONSTRAINT "fk_project_statuses_project_id_org"
  FOREIGN KEY (org_id, project_id) REFERENCES build.projects (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.project_milestones
  ADD CONSTRAINT "fk_project_milestones_project_id_org"
  FOREIGN KEY (org_id, project_id) REFERENCES build.projects (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.project_members
  ADD CONSTRAINT "fk_project_members_project_id_org"
  FOREIGN KEY (org_id, project_id) REFERENCES build.projects (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.pages
  ADD CONSTRAINT "fk_pages_project_id_org"
  FOREIGN KEY (org_id, project_id) REFERENCES build.projects (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.intake_items
  ADD CONSTRAINT "fk_intake_items_linked_work_item_id_org"
  FOREIGN KEY (org_id, linked_work_item_id) REFERENCES build.tickets (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.intake_items
  ADD CONSTRAINT "fk_intake_items_project_id_org"
  FOREIGN KEY (org_id, project_id) REFERENCES build.projects (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.work_item_relations
  ADD CONSTRAINT "fk_work_item_relations_work_item_id_org"
  FOREIGN KEY (org_id, work_item_id) REFERENCES build.tickets (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.webhook_deliveries
  ADD CONSTRAINT "fk_webhook_deliveries_webhook_id_org"
  FOREIGN KEY (org_id, webhook_id) REFERENCES build.project_webhooks (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.tickets
  ADD CONSTRAINT "fk_tickets_sprint_id_org"
  FOREIGN KEY (org_id, sprint_id) REFERENCES build.sprints (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.tickets
  ADD CONSTRAINT "fk_tickets_project_id_org"
  FOREIGN KEY (org_id, project_id) REFERENCES build.projects (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.tickets
  ADD CONSTRAINT "fk_tickets_module_id_org"
  FOREIGN KEY (org_id, module_id) REFERENCES build.modules (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.tickets
  ADD CONSTRAINT "fk_tickets_cycle_id_org"
  FOREIGN KEY (org_id, cycle_id) REFERENCES build.cycles (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.ticket_watchers
  ADD CONSTRAINT "fk_ticket_watchers_ticket_id_org"
  FOREIGN KEY (org_id, ticket_id) REFERENCES build.tickets (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.ticket_related_links
  ADD CONSTRAINT "fk_ticket_related_links_ticket_id_org"
  FOREIGN KEY (org_id, ticket_id) REFERENCES build.tickets (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.ticket_label_mappings
  ADD CONSTRAINT "fk_ticket_label_mappings_ticket_id_org"
  FOREIGN KEY (org_id, ticket_id) REFERENCES build.tickets (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.ticket_label_mappings
  ADD CONSTRAINT "fk_ticket_label_mappings_label_id_org"
  FOREIGN KEY (org_id, label_id) REFERENCES build.ticket_labels (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE ticket_comments
  ADD CONSTRAINT "fk_ticket_comments_ticket_id_org"
  FOREIGN KEY (org_id, ticket_id) REFERENCES build.tickets (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.ticket_comment_reactions
  ADD CONSTRAINT "fk_ticket_comment_reactions_comment_id_org"
  FOREIGN KEY (org_id, comment_id) REFERENCES ticket_comments (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.ticket_checklists
  ADD CONSTRAINT "fk_ticket_checklists_ticket_id_org"
  FOREIGN KEY (org_id, ticket_id) REFERENCES build.tickets (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.ticket_checklist_items
  ADD CONSTRAINT "fk_ticket_checklist_items_checklist_id_org"
  FOREIGN KEY (org_id, checklist_id) REFERENCES build.ticket_checklists (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.ticket_attachments
  ADD CONSTRAINT "fk_ticket_attachments_ticket_id_org"
  FOREIGN KEY (org_id, ticket_id) REFERENCES build.tickets (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.ticket_assignees
  ADD CONSTRAINT "fk_ticket_assignees_ticket_id_org"
  FOREIGN KEY (org_id, ticket_id) REFERENCES build.tickets (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.release_tickets
  ADD CONSTRAINT "fk_release_tickets_ticket_id_org"
  FOREIGN KEY (org_id, ticket_id) REFERENCES build.tickets (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.release_tickets
  ADD CONSTRAINT "fk_release_tickets_release_id_org"
  FOREIGN KEY (org_id, release_id) REFERENCES build.project_releases (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.project_webhooks
  ADD CONSTRAINT "fk_project_webhooks_project_id_org"
  FOREIGN KEY (org_id, project_id) REFERENCES build.projects (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.project_releases
  ADD CONSTRAINT "fk_project_releases_project_id_org"
  FOREIGN KEY (org_id, project_id) REFERENCES build.projects (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.project_automations
  ADD CONSTRAINT "fk_project_automations_project_id_org"
  FOREIGN KEY (org_id, project_id) REFERENCES build.projects (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.sprints
  ADD CONSTRAINT "fk_sprints_project_id_org"
  FOREIGN KEY (org_id, project_id) REFERENCES build.projects (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.projects
  ADD CONSTRAINT "fk_projects_managed_product_id_org"
  FOREIGN KEY (org_id, managed_product_id) REFERENCES build.managed_products (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.project_template_tickets
  ADD CONSTRAINT "fk_project_template_tickets_template_id_org"
  FOREIGN KEY (org_id, template_id) REFERENCES build.project_templates (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.modules
  ADD CONSTRAINT "fk_modules_project_id_org"
  FOREIGN KEY (org_id, project_id) REFERENCES build.projects (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.cycles
  ADD CONSTRAINT "fk_cycles_project_id_org"
  FOREIGN KEY (org_id, project_id) REFERENCES build.projects (org_id, id)
  NOT VALID;
