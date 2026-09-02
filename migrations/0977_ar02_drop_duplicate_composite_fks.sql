-- AR-02: drop the redundant duplicate composite tenant foreign key in each pair, keeping the one that carries the referential action so one canonical constraint remains per relationship.

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE build.cycles DROP CONSTRAINT "fk_cycles_project_id_org";
--> statement-breakpoint
ALTER TABLE build.modules DROP CONSTRAINT "fk_modules_project_id_org";
--> statement-breakpoint
ALTER TABLE build.project_template_tickets DROP CONSTRAINT "fk_project_template_tickets_template_id_org";
--> statement-breakpoint
ALTER TABLE build.projects DROP CONSTRAINT "fk_projects_managed_product_id_org";
--> statement-breakpoint
ALTER TABLE build.sprints DROP CONSTRAINT "fk_sprints_project_id_org";
--> statement-breakpoint
ALTER TABLE build.project_automations DROP CONSTRAINT "fk_project_automations_project_id_org";
--> statement-breakpoint
ALTER TABLE build.project_releases DROP CONSTRAINT "fk_project_releases_project_id_org";
--> statement-breakpoint
ALTER TABLE build.project_webhooks DROP CONSTRAINT "fk_project_webhooks_project_id_org";
--> statement-breakpoint
ALTER TABLE build.release_tickets DROP CONSTRAINT "fk_release_tickets_release_id_org";
--> statement-breakpoint
ALTER TABLE build.release_tickets DROP CONSTRAINT "fk_release_tickets_ticket_id_org";
--> statement-breakpoint
ALTER TABLE build.ticket_assignees DROP CONSTRAINT "fk_ticket_assignees_ticket_id_org";
--> statement-breakpoint
ALTER TABLE build.ticket_attachments DROP CONSTRAINT "fk_ticket_attachments_ticket_id_org";
--> statement-breakpoint
ALTER TABLE build.ticket_checklist_items DROP CONSTRAINT "fk_ticket_checklist_items_checklist_id_org";
--> statement-breakpoint
ALTER TABLE build.ticket_checklists DROP CONSTRAINT "fk_ticket_checklists_ticket_id_org";
--> statement-breakpoint
ALTER TABLE build.ticket_comment_reactions DROP CONSTRAINT "fk_ticket_comment_reactions_comment_id_org";
--> statement-breakpoint
ALTER TABLE ticket_comments DROP CONSTRAINT "fk_ticket_comments_ticket_id_org";
--> statement-breakpoint
ALTER TABLE build.ticket_label_mappings DROP CONSTRAINT "fk_ticket_label_mappings_label_id_org";
--> statement-breakpoint
ALTER TABLE build.ticket_label_mappings DROP CONSTRAINT "fk_ticket_label_mappings_ticket_id_org";
--> statement-breakpoint
ALTER TABLE build.ticket_related_links DROP CONSTRAINT "fk_ticket_related_links_ticket_id_org";
--> statement-breakpoint
ALTER TABLE build.ticket_watchers DROP CONSTRAINT "fk_ticket_watchers_ticket_id_org";
--> statement-breakpoint
ALTER TABLE build.tickets DROP CONSTRAINT "fk_tickets_cycle_id_org";
--> statement-breakpoint
ALTER TABLE build.tickets DROP CONSTRAINT "fk_tickets_module_id_org";
--> statement-breakpoint
ALTER TABLE build.tickets DROP CONSTRAINT "fk_tickets_project_id_org";
--> statement-breakpoint
ALTER TABLE build.tickets DROP CONSTRAINT "fk_tickets_sprint_id_org";
--> statement-breakpoint
ALTER TABLE build.webhook_deliveries DROP CONSTRAINT "fk_webhook_deliveries_webhook_id_org";
--> statement-breakpoint
ALTER TABLE build.work_item_relations DROP CONSTRAINT "fk_work_item_relations_work_item_id_org";
--> statement-breakpoint
ALTER TABLE build.intake_items DROP CONSTRAINT "fk_intake_items_project_id_org";
--> statement-breakpoint
ALTER TABLE build.intake_items DROP CONSTRAINT "fk_intake_items_linked_work_item_id_org";
--> statement-breakpoint
ALTER TABLE build.pages DROP CONSTRAINT "fk_pages_project_id_org";
--> statement-breakpoint
ALTER TABLE build.project_members DROP CONSTRAINT "fk_project_members_project_id_org";
--> statement-breakpoint
ALTER TABLE build.project_milestones DROP CONSTRAINT "fk_project_milestones_project_id_org";
--> statement-breakpoint
ALTER TABLE build.project_statuses DROP CONSTRAINT "fk_project_statuses_project_id_org";
--> statement-breakpoint
ALTER TABLE build.project_views DROP CONSTRAINT "fk_project_views_project_id_org";
--> statement-breakpoint
ALTER TABLE build.project_daily_snapshots DROP CONSTRAINT "fk_project_daily_snapshots_project_id_org";
--> statement-breakpoint
ALTER TABLE build.okr_goals DROP CONSTRAINT "fk_okr_goals_project_id_org";
--> statement-breakpoint
ALTER TABLE build.okr_key_results DROP CONSTRAINT "fk_okr_key_results_goal_id_org";
--> statement-breakpoint
ALTER TABLE build.okr_links DROP CONSTRAINT "fk_okr_links_project_id_org";
--> statement-breakpoint
ALTER TABLE build.okr_links DROP CONSTRAINT "fk_okr_links_ticket_id_org";
--> statement-breakpoint
ALTER TABLE build.okr_links DROP CONSTRAINT "fk_okr_links_goal_id_org";
--> statement-breakpoint
ALTER TABLE build.okr_updates DROP CONSTRAINT "fk_okr_updates_goal_id_org";
--> statement-breakpoint
ALTER TABLE build.okr_updates DROP CONSTRAINT "fk_okr_updates_key_result_id_org";
--> statement-breakpoint
ALTER TABLE build.changelog_entries DROP CONSTRAINT "fk_changelog_entries_linked_roadmap_item_id_org";
--> statement-breakpoint
ALTER TABLE build.feedback_posts DROP CONSTRAINT "fk_feedback_posts_linked_roadmap_item_id_org";
--> statement-breakpoint
ALTER TABLE build.feedback_votes DROP CONSTRAINT "fk_feedback_votes_feedback_post_id_org";
--> statement-breakpoint
ALTER TABLE build.roadmap_items DROP CONSTRAINT "fk_roadmap_items_project_id_org";
--> statement-breakpoint
ALTER TABLE build.roadmap_items DROP CONSTRAINT "fk_roadmap_items_epic_ticket_id_org";
--> statement-breakpoint
ALTER TABLE build.roadmap_votes DROP CONSTRAINT "fk_roadmap_votes_roadmap_item_id_org";
--> statement-breakpoint
ALTER TABLE build.project_whiteboard_shares DROP CONSTRAINT "fk_project_whiteboard_shares_whiteboard_id_org";
--> statement-breakpoint
ALTER TABLE build.project_whiteboards DROP CONSTRAINT "fk_project_whiteboards_project_id_org";
--> statement-breakpoint
ALTER TABLE build.git_connections DROP CONSTRAINT "fk_git_connections_project_id_org";
--> statement-breakpoint
ALTER TABLE build.git_ticket_links DROP CONSTRAINT "fk_git_ticket_links_ticket_id_org";
--> statement-breakpoint
ALTER TABLE build.git_ticket_links DROP CONSTRAINT "fk_git_ticket_links_connection_id_org";
--> statement-breakpoint
ALTER TABLE ticket_activity_log DROP CONSTRAINT "fk_ticket_activity_log_ticket_id_org";
--> statement-breakpoint
ALTER TABLE build.ticket_comment_mentions DROP CONSTRAINT "fk_ticket_comment_mentions_comment_id_org";
--> statement-breakpoint
ALTER TABLE build.test_cases DROP CONSTRAINT "fk_test_cases_project_id_org";
--> statement-breakpoint
ALTER TABLE build.test_cases DROP CONSTRAINT "fk_test_cases_linked_ticket_id_org";
--> statement-breakpoint
ALTER TABLE build.test_cases DROP CONSTRAINT "fk_test_cases_suite_id_org";
--> statement-breakpoint
ALTER TABLE build.test_run_results DROP CONSTRAINT "fk_test_run_results_project_id_org";
--> statement-breakpoint
ALTER TABLE build.test_run_results DROP CONSTRAINT "fk_test_run_results_test_case_id_org";
--> statement-breakpoint
ALTER TABLE build.test_run_results DROP CONSTRAINT "fk_test_run_results_run_id_org";
--> statement-breakpoint
ALTER TABLE build.test_run_results DROP CONSTRAINT "fk_test_run_results_linked_bug_id_org";
--> statement-breakpoint
ALTER TABLE build.test_runs DROP CONSTRAINT "fk_test_runs_project_id_org";
--> statement-breakpoint
ALTER TABLE build.test_runs DROP CONSTRAINT "fk_test_runs_sprint_id_org";
--> statement-breakpoint
ALTER TABLE build.test_runs DROP CONSTRAINT "fk_test_runs_release_id_org";
--> statement-breakpoint
ALTER TABLE build.test_suites DROP CONSTRAINT "fk_test_suites_project_id_org";
--> statement-breakpoint
ALTER TABLE build.test_suites DROP CONSTRAINT "fk_test_suites_parent_id_org";
--> statement-breakpoint
ALTER TABLE build.bugs DROP CONSTRAINT "fk_bugs_project_id_org";
--> statement-breakpoint
ALTER TABLE build.bugs DROP CONSTRAINT "fk_bugs_affected_release_id_org";
--> statement-breakpoint
ALTER TABLE build.bugs DROP CONSTRAINT "fk_bugs_linked_ticket_id_org";
--> statement-breakpoint
ALTER TABLE build.bugs DROP CONSTRAINT "fk_bugs_linked_test_case_id_org";
--> statement-breakpoint
ALTER TABLE build.change_requests DROP CONSTRAINT "fk_change_requests_project_id_org";
--> statement-breakpoint
ALTER TABLE build.project_approvals DROP CONSTRAINT "fk_project_approvals_project_id_org";
--> statement-breakpoint
ALTER TABLE build.project_decisions DROP CONSTRAINT "fk_project_decisions_project_id_org";
--> statement-breakpoint
ALTER TABLE build.project_decisions DROP CONSTRAINT "fk_project_decisions_linked_ticket_id_org";
--> statement-breakpoint
ALTER TABLE build.project_risks DROP CONSTRAINT "fk_project_risks_project_id_org";
--> statement-breakpoint
ALTER TABLE build.project_risks DROP CONSTRAINT "fk_project_risks_linked_ticket_id_org";
--> statement-breakpoint
ALTER TABLE build.meeting_action_items DROP CONSTRAINT "fk_meeting_action_items_project_id_org";
--> statement-breakpoint
ALTER TABLE build.meeting_action_items DROP CONSTRAINT "fk_meeting_action_items_converted_ticket_id_org";
--> statement-breakpoint
ALTER TABLE build.meeting_action_items DROP CONSTRAINT "fk_meeting_action_items_meeting_id_org";
--> statement-breakpoint
ALTER TABLE build.meeting_attendees DROP CONSTRAINT "fk_meeting_attendees_meeting_id_org";
--> statement-breakpoint
ALTER TABLE build.meeting_standup_entries DROP CONSTRAINT "fk_meeting_standup_entries_meeting_id_org";
--> statement-breakpoint
ALTER TABLE build.project_meetings DROP CONSTRAINT "fk_project_meetings_project_id_org";
--> statement-breakpoint
ALTER TABLE build.project_meetings DROP CONSTRAINT "fk_project_meetings_sprint_id_org";
--> statement-breakpoint
ALTER TABLE build.incident_updates DROP CONSTRAINT "fk_incident_updates_incident_id_org";
--> statement-breakpoint
ALTER TABLE build.project_incidents DROP CONSTRAINT "fk_project_incidents_project_id_org";
--> statement-breakpoint
ALTER TABLE build.project_incidents DROP CONSTRAINT "fk_project_incidents_linked_ticket_id_org";
--> statement-breakpoint
ALTER TABLE build.form_submissions DROP CONSTRAINT "fk_form_submissions_project_id_org";
--> statement-breakpoint
ALTER TABLE build.form_submissions DROP CONSTRAINT "fk_form_submissions_converted_ticket_id_org";
--> statement-breakpoint
ALTER TABLE build.form_submissions DROP CONSTRAINT "fk_form_submissions_form_id_org";
--> statement-breakpoint
ALTER TABLE build.project_forms DROP CONSTRAINT "fk_project_forms_project_id_org";
--> statement-breakpoint
ALTER TABLE build.portfolio_projects DROP CONSTRAINT "fk_portfolio_projects_project_id_org";
--> statement-breakpoint
ALTER TABLE build.portfolio_projects DROP CONSTRAINT "fk_portfolio_projects_portfolio_id_org";
--> statement-breakpoint
ALTER TABLE build.program_projects DROP CONSTRAINT "fk_program_projects_project_id_org";
--> statement-breakpoint
ALTER TABLE build.program_projects DROP CONSTRAINT "fk_program_projects_program_id_org";
--> statement-breakpoint
ALTER TABLE build.project_programs DROP CONSTRAINT "fk_project_programs_portfolio_id_org";
--> statement-breakpoint
ALTER TABLE build.workflow_transitions DROP CONSTRAINT "fk_workflow_transitions_project_id_org";
--> statement-breakpoint
ALTER TABLE build.workflow_transitions DROP CONSTRAINT "fk_workflow_transitions_from_status_id_org";
--> statement-breakpoint
ALTER TABLE hr_effective_dated_changes DROP CONSTRAINT "fk_hr_effective_dated_changes_employment_id_org";
--> statement-breakpoint
ALTER TABLE hr_employee_sensitive_fields DROP CONSTRAINT "fk_hr_employee_sensitive_fields_employment_id_org";
--> statement-breakpoint
ALTER TABLE hr_employment_history DROP CONSTRAINT "fk_hr_employment_history_employment_id_org";
--> statement-breakpoint
ALTER TABLE hr_employments DROP CONSTRAINT "fk_hr_employments_person_id_org";
--> statement-breakpoint
ALTER TABLE hr_reporting_lines DROP CONSTRAINT "fk_hr_reporting_lines_employment_id_org";
--> statement-breakpoint
ALTER TABLE hr_automation_runs DROP CONSTRAINT "fk_hr_automation_runs_rule_id_org";
--> statement-breakpoint
ALTER TABLE hr_policy_scopes DROP CONSTRAINT "fk_hr_policy_scopes_policy_id_org";
--> statement-breakpoint
ALTER TABLE hr_workflow_instances DROP CONSTRAINT "fk_hr_workflow_instances_org_definition";
--> statement-breakpoint
ALTER TABLE hr_workflow_step_actions DROP CONSTRAINT "fk_hr_workflow_step_actions_instance_id_org";
--> statement-breakpoint
ALTER TABLE hr_workflow_steps DROP CONSTRAINT "fk_hr_workflow_steps_definition_id_org";
--> statement-breakpoint
ALTER TABLE hr_template_renders DROP CONSTRAINT "fk_hr_template_renders_template_id_org";
--> statement-breakpoint
ALTER TABLE hr_payroll_adjustments DROP CONSTRAINT "fk_hr_payroll_adjustments_period_id_org";
--> statement-breakpoint
ALTER TABLE hr_payroll_input_snapshots DROP CONSTRAINT "fk_hr_payroll_input_snapshots_period_id_org";
--> statement-breakpoint
ALTER TABLE hr_helpdesk_comments DROP CONSTRAINT "fk_hr_helpdesk_comments_ticket_id_org";
--> statement-breakpoint
ALTER TABLE leave_balances DROP CONSTRAINT "fk_leave_balances_leave_type_id_org";
--> statement-breakpoint
ALTER TABLE leave_requests DROP CONSTRAINT "fk_leave_requests_org_leave_type";
--> statement-breakpoint
ALTER TABLE hr_leave_ledger DROP CONSTRAINT "fk_hr_leave_ledger_org_leave_type";
--> statement-breakpoint
ALTER TABLE booking_link_interviewers DROP CONSTRAINT "fk_booking_link_interviewers_booking_link_id_org";
--> statement-breakpoint
ALTER TABLE calibration_participants DROP CONSTRAINT "fk_calibration_participants_session_id_org";
--> statement-breakpoint
ALTER TABLE calibration_sessions DROP CONSTRAINT "fk_calibration_sessions_candidate_id_org";
--> statement-breakpoint
ALTER TABLE calibration_sessions DROP CONSTRAINT "fk_calibration_sessions_org_job_posting";
--> statement-breakpoint
ALTER TABLE candidate_applications DROP CONSTRAINT "fk_candidate_applications_candidate_id_org";
--> statement-breakpoint
ALTER TABLE candidate_applications DROP CONSTRAINT "fk_candidate_applications_job_posting_id_org";
--> statement-breakpoint
ALTER TABLE candidate_documents_vault DROP CONSTRAINT "fk_candidate_documents_vault_candidate_id_org";
--> statement-breakpoint
ALTER TABLE candidate_messages DROP CONSTRAINT "fk_candidate_messages_candidate_id_org";
--> statement-breakpoint
ALTER TABLE candidate_offers DROP CONSTRAINT "fk_candidate_offers_candidate_id_org";
--> statement-breakpoint
ALTER TABLE candidate_offers DROP CONSTRAINT "fk_candidate_offers_org_job_posting";
--> statement-breakpoint
ALTER TABLE candidate_reference_checks DROP CONSTRAINT "fk_candidate_reference_checks_candidate_id_org";
--> statement-breakpoint
ALTER TABLE candidate_referrals DROP CONSTRAINT "fk_candidate_referrals_candidate_id_org";
--> statement-breakpoint
ALTER TABLE candidate_referrals DROP CONSTRAINT "fk_candidate_referrals_org_job_posting";
--> statement-breakpoint
ALTER TABLE candidate_sla_tracking DROP CONSTRAINT "fk_candidate_sla_tracking_candidate_id_org";
--> statement-breakpoint
ALTER TABLE email_sequence_enrollments DROP CONSTRAINT "fk_email_sequence_enrollments_candidate_id_org";
--> statement-breakpoint
ALTER TABLE email_sequence_enrollments DROP CONSTRAINT "fk_email_sequence_enrollments_sequence_id_org";
--> statement-breakpoint
ALTER TABLE headcount_requests DROP CONSTRAINT "fk_headcount_requests_linked_job_posting_id_org";
--> statement-breakpoint
ALTER TABLE hiring_flow_rounds DROP CONSTRAINT "fk_hiring_flow_rounds_flow_id_org";
--> statement-breakpoint
ALTER TABLE hiring_flow_rounds DROP CONSTRAINT "fk_hiring_flow_rounds_scorecard_template_id_org";
--> statement-breakpoint
ALTER TABLE interview_booking_links DROP CONSTRAINT "fk_interview_booking_links_candidate_id_org";
--> statement-breakpoint
ALTER TABLE interview_booking_links DROP CONSTRAINT "fk_interview_booking_links_org_job_posting";
--> statement-breakpoint
ALTER TABLE interview_panel_members DROP CONSTRAINT "fk_interview_panel_members_interview_id_org";
--> statement-breakpoint
ALTER TABLE interview_scorecards DROP CONSTRAINT "fk_interview_scorecards_interview_id_org";
--> statement-breakpoint
ALTER TABLE interview_scorecards DROP CONSTRAINT "fk_interview_scorecards_template_id_org";
--> statement-breakpoint
ALTER TABLE job_postings DROP CONSTRAINT "fk_job_postings_org_hiring_flow";
--> statement-breakpoint
ALTER TABLE job_recruiters DROP CONSTRAINT "fk_job_recruiters_job_posting_id_org";
--> statement-breakpoint
ALTER TABLE offer_negotiations DROP CONSTRAINT "fk_offer_negotiations_offer_id_org";
--> statement-breakpoint
ALTER TABLE offer_versions DROP CONSTRAINT "fk_offer_versions_offer_id_org";
--> statement-breakpoint
ALTER TABLE recruiter_activity_log DROP CONSTRAINT "fk_recruiter_activity_log_candidate_id_org";
--> statement-breakpoint
ALTER TABLE recruiter_activity_log DROP CONSTRAINT "fk_recruiter_activity_log_job_posting_id_org";
--> statement-breakpoint
ALTER TABLE vault_access_logs DROP CONSTRAINT "fk_vault_access_logs_vault_document_id_org";
--> statement-breakpoint
ALTER TABLE vault_access_logs DROP CONSTRAINT "fk_vault_access_logs_candidate_id_org";
--> statement-breakpoint
ALTER TABLE vendor_candidate_submissions DROP CONSTRAINT "fk_vendor_candidate_submissions_candidate_id_org";
--> statement-breakpoint
ALTER TABLE vendor_candidate_submissions DROP CONSTRAINT "fk_vendor_candidate_submissions_job_posting_id_org";
--> statement-breakpoint
ALTER TABLE vendor_candidate_submissions DROP CONSTRAINT "fk_vendor_candidate_submissions_vendor_id_org";
--> statement-breakpoint
ALTER TABLE candidate_documents DROP CONSTRAINT "fk_candidate_documents_candidate_id_org";
--> statement-breakpoint
ALTER TABLE candidate_documents DROP CONSTRAINT "fk_candidate_documents_template_id_org";
--> statement-breakpoint
ALTER TABLE job_board_postings DROP CONSTRAINT "fk_job_board_postings_job_posting_id_org";
--> statement-breakpoint
ALTER TABLE talent_pool_members DROP CONSTRAINT "fk_talent_pool_members_candidate_id_org";
--> statement-breakpoint
ALTER TABLE talent_pool_members DROP CONSTRAINT "fk_talent_pool_members_pool_id_org";
--> statement-breakpoint
ALTER TABLE external_referrals DROP CONSTRAINT "fk_external_referrals_candidate_id_org";
--> statement-breakpoint
ALTER TABLE external_referrals DROP CONSTRAINT "fk_external_referrals_org_job_posting";
--> statement-breakpoint
ALTER TABLE external_referrals DROP CONSTRAINT "fk_external_referrals_referrer_id_org";
--> statement-breakpoint
ALTER TABLE hr_calibration_entries DROP CONSTRAINT "fk_hr_calibration_entries_cycle_id_org";
--> statement-breakpoint
ALTER TABLE review_cycles DROP CONSTRAINT "fk_review_cycles_template_id_org";
--> statement-breakpoint
ALTER TABLE employee_shift_assignments DROP CONSTRAINT "fk_employee_shift_assignments_shift_id_org";
--> statement-breakpoint
ALTER TABLE roster_entries DROP CONSTRAINT "fk_roster_entries_shift_id_org";
--> statement-breakpoint
ALTER TABLE roster_entries DROP CONSTRAINT "fk_roster_entries_roster_id_org";
--> statement-breakpoint
ALTER TABLE employee_career_plans DROP CONSTRAINT "fk_employee_career_plans_path_id_org";
--> statement-breakpoint
ALTER TABLE leave_policies DROP CONSTRAINT "fk_leave_policies_leave_type_id_org";
--> statement-breakpoint
ALTER TABLE investment_proofs DROP CONSTRAINT "fk_investment_proofs_declaration_id_org";
--> statement-breakpoint
ALTER TABLE payroll_run_employees DROP CONSTRAINT "fk_payroll_run_employees_run_id_org";
--> statement-breakpoint
ALTER TABLE employee_salary_profile_components DROP CONSTRAINT "fk_employee_salary_profile_components_profile_id_org";
--> statement-breakpoint
ALTER TABLE employee_salary_profile_components DROP CONSTRAINT "fk_employee_salary_profile_components_org_component";
--> statement-breakpoint
ALTER TABLE hr_probation_reviews DROP CONSTRAINT "fk_hr_probation_reviews_employment_id_org";
--> statement-breakpoint
ALTER TABLE hr_probation_reviews DROP CONSTRAINT "fk_hr_probation_reviews_person_id_org";
--> statement-breakpoint
ALTER TABLE hr_probation_reviews DROP CONSTRAINT "fk_hr_probation_reviews_review_template_id_org";
--> statement-breakpoint
ALTER TABLE hr_role_skill_requirements DROP CONSTRAINT "fk_hr_role_skill_requirements_job_role_id_org";
--> statement-breakpoint
ALTER TABLE hr_succession_plans DROP CONSTRAINT "fk_hr_succession_plans_job_role_id_org";
--> statement-breakpoint
ALTER TABLE hr_badge_awards DROP CONSTRAINT "fk_hr_badge_awards_badge_id_org";
--> statement-breakpoint
ALTER TABLE hr_community_members DROP CONSTRAINT "fk_hr_community_members_community_id_org";
--> statement-breakpoint
ALTER TABLE hr_poll_votes DROP CONSTRAINT "fk_hr_poll_votes_poll_id_org";
--> statement-breakpoint
ALTER TABLE hr_case_documents DROP CONSTRAINT "fk_hr_case_documents_case_id_org";
--> statement-breakpoint
ALTER TABLE hr_case_notes DROP CONSTRAINT "fk_hr_case_notes_case_id_org";
--> statement-breakpoint
ALTER TABLE hr_disciplinary_actions DROP CONSTRAINT "fk_hr_disciplinary_actions_case_id_org";
--> statement-breakpoint
ALTER TABLE hr_benefit_enrollment_windows DROP CONSTRAINT "fk_hr_benefit_enrollment_windows_plan_id_org";
--> statement-breakpoint
ALTER TABLE hr_benefit_enrollments DROP CONSTRAINT "fk_hr_benefit_enrollments_plan_id_org";
--> statement-breakpoint
ALTER TABLE hr_insurance_claims DROP CONSTRAINT "fk_hr_insurance_claims_plan_id_org";
--> statement-breakpoint
ALTER TABLE hr_webhook_deliveries DROP CONSTRAINT "fk_hr_webhook_deliveries_subscription_id_org";
--> statement-breakpoint
ALTER TABLE hr_import_rows DROP CONSTRAINT "fk_hr_import_rows_job_id_org";
--> statement-breakpoint
ALTER TABLE hr_compliance_events DROP CONSTRAINT "fk_hr_compliance_events_requirement_id_org";
--> statement-breakpoint
ALTER TABLE hr_contracts DROP CONSTRAINT "fk_hr_contracts_employment_id_org";
--> statement-breakpoint
ALTER TABLE hr_work_authorizations DROP CONSTRAINT "fk_hr_work_authorizations_employment_id_org";
--> statement-breakpoint
ALTER TABLE hr_form_submissions DROP CONSTRAINT "fk_hr_form_submissions_form_id_org";
--> statement-breakpoint
ALTER TABLE hr_legal_hold_items DROP CONSTRAINT "fk_hr_legal_hold_items_hold_id_org";
--> statement-breakpoint
ALTER TABLE hr_comp_budget_pools DROP CONSTRAINT "fk_hr_comp_budget_pools_cycle_id_org";
--> statement-breakpoint
ALTER TABLE hr_comp_recommendations DROP CONSTRAINT "fk_hr_comp_recommendations_cycle_id_org";
--> statement-breakpoint
ALTER TABLE hr_device_employee_mappings DROP CONSTRAINT "fk_hr_device_employee_mappings_device_id_org";
--> statement-breakpoint
ALTER TABLE hr_device_sync_logs DROP CONSTRAINT "fk_hr_device_sync_logs_device_id_org";
--> statement-breakpoint
ALTER TABLE hr_equity_exercises DROP CONSTRAINT "fk_hr_equity_exercises_grant_id_org";
--> statement-breakpoint
ALTER TABLE hr_equity_vesting_events DROP CONSTRAINT "fk_hr_equity_vesting_events_grant_id_org";
--> statement-breakpoint
ALTER TABLE hr_accommodation_tasks DROP CONSTRAINT "fk_hr_accommodation_tasks_request_id_org";
--> statement-breakpoint
ALTER TABLE hr_emergency_responses DROP CONSTRAINT "fk_hr_emergency_responses_event_id_org";
--> statement-breakpoint
ALTER TABLE chat_channels DROP CONSTRAINT "fk_chat_channels_org_creator_membership";
--> statement-breakpoint
ALTER TABLE kb_categories DROP CONSTRAINT "fk_kb_categories_parent_id_org";
--> statement-breakpoint
ALTER TABLE kb_page_comments DROP CONSTRAINT "fk_kb_page_comments_parent_id_org";
--> statement-breakpoint
ALTER TABLE build.feedbucket_attachments DROP CONSTRAINT "fk_feedbucket_attachments_submission_id_org";
--> statement-breakpoint
ALTER TABLE build.feedbucket_submissions DROP CONSTRAINT "fk_feedbucket_submissions_linked_ticket_id_org";
--> statement-breakpoint
ALTER TABLE build.feedbucket_submissions DROP CONSTRAINT "fk_feedbucket_submissions_widget_id_org";
--> statement-breakpoint
ALTER TABLE build.feedbucket_widgets DROP CONSTRAINT "fk_feedbucket_widgets_project_id_org";
--> statement-breakpoint
ALTER TABLE build.project_team_members DROP CONSTRAINT "fk_project_team_members_team_id_org";
--> statement-breakpoint
ALTER TABLE build.comment_drafts DROP CONSTRAINT "fk_comment_drafts_ticket_id_org";
--> statement-breakpoint
ALTER TABLE build.project_team_assignments DROP CONSTRAINT "fk_project_team_assignments_project_id_org";
--> statement-breakpoint
ALTER TABLE build.project_team_assignments DROP CONSTRAINT "fk_project_team_assignments_team_id_org";
--> statement-breakpoint
ALTER TABLE build.pm_workspace_memberships DROP CONSTRAINT "fk_pm_memberships_org_member";
