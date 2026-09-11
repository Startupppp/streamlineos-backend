-- AR-02: drop redundant single-column tenant FKs (build schema, waves 0943-0947)
-- All are superseded by composite (org_id, col) constraints added in 0943-0947.
-- CRM and Inventory are not touched.

SET lock_timeout = '5s';

ALTER TABLE build.bugs DROP CONSTRAINT IF EXISTS "bugs_affected_release_id_project_releases_id_fk";
--> statement-breakpoint
ALTER TABLE build.bugs DROP CONSTRAINT IF EXISTS "bugs_fixed_release_id_project_releases_id_fk";
--> statement-breakpoint
ALTER TABLE build.bugs DROP CONSTRAINT IF EXISTS "bugs_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE build.bugs DROP CONSTRAINT IF EXISTS "bugs_linked_test_case_id_test_cases_id_fk";
--> statement-breakpoint
ALTER TABLE build.bugs DROP CONSTRAINT IF EXISTS "bugs_linked_ticket_id_tickets_id_fk";
--> statement-breakpoint
ALTER TABLE build.change_requests DROP CONSTRAINT IF EXISTS "change_requests_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE build.changelog_entries DROP CONSTRAINT IF EXISTS "changelog_entries_linked_roadmap_item_id_roadmap_items_id_fk";
--> statement-breakpoint
ALTER TABLE build.comment_drafts DROP CONSTRAINT IF EXISTS "comment_drafts_ticket_id_fkey";
--> statement-breakpoint
ALTER TABLE build.cycles DROP CONSTRAINT IF EXISTS "cycles_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE build.feedback_posts DROP CONSTRAINT IF EXISTS "feedback_posts_duplicate_of_id_feedback_posts_id_fk";
--> statement-breakpoint
ALTER TABLE build.feedback_posts DROP CONSTRAINT IF EXISTS "feedback_posts_linked_roadmap_item_id_roadmap_items_id_fk";
--> statement-breakpoint
ALTER TABLE build.feedback_votes DROP CONSTRAINT IF EXISTS "feedback_votes_feedback_post_id_feedback_posts_id_fk";
--> statement-breakpoint
ALTER TABLE build.feedbucket_attachments DROP CONSTRAINT IF EXISTS "feedbucket_attachments_submission_id_feedbucket_submissions_id_";
--> statement-breakpoint
ALTER TABLE build.feedbucket_submissions DROP CONSTRAINT IF EXISTS "feedbucket_submissions_widget_id_feedbucket_widgets_id_fk";
--> statement-breakpoint
ALTER TABLE build.feedbucket_submissions DROP CONSTRAINT IF EXISTS "feedbucket_submissions_linked_ticket_id_tickets_id_fk";
--> statement-breakpoint
ALTER TABLE build.feedbucket_widgets DROP CONSTRAINT IF EXISTS "fk_feedbucket_widgets_managed_product";
--> statement-breakpoint
ALTER TABLE build.feedbucket_widgets DROP CONSTRAINT IF EXISTS "feedbucket_widgets_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE build.form_submissions DROP CONSTRAINT IF EXISTS "form_submissions_form_id_project_forms_id_fk";
--> statement-breakpoint
ALTER TABLE build.form_submissions DROP CONSTRAINT IF EXISTS "form_submissions_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE build.form_submissions DROP CONSTRAINT IF EXISTS "form_submissions_converted_ticket_id_tickets_id_fk";
--> statement-breakpoint
ALTER TABLE build.git_connections DROP CONSTRAINT IF EXISTS "git_connections_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE build.git_ticket_links DROP CONSTRAINT IF EXISTS "git_ticket_links_connection_id_git_connections_id_fk";
--> statement-breakpoint
ALTER TABLE build.git_ticket_links DROP CONSTRAINT IF EXISTS "git_ticket_links_ticket_id_tickets_id_fk";
--> statement-breakpoint
ALTER TABLE build.incident_updates DROP CONSTRAINT IF EXISTS "incident_updates_incident_id_project_incidents_id_fk";
--> statement-breakpoint
ALTER TABLE build.intake_items DROP CONSTRAINT IF EXISTS "intake_items_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE build.intake_items DROP CONSTRAINT IF EXISTS "intake_items_linked_work_item_id_tickets_id_fk";
--> statement-breakpoint
ALTER TABLE build.managed_product_releases DROP CONSTRAINT IF EXISTS "fk_managed_product_releases_product";
--> statement-breakpoint
ALTER TABLE build.meeting_action_items DROP CONSTRAINT IF EXISTS "meeting_action_items_meeting_id_project_meetings_id_fk";
--> statement-breakpoint
ALTER TABLE build.meeting_action_items DROP CONSTRAINT IF EXISTS "meeting_action_items_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE build.meeting_action_items DROP CONSTRAINT IF EXISTS "meeting_action_items_converted_ticket_id_tickets_id_fk";
--> statement-breakpoint
ALTER TABLE build.meeting_attendees DROP CONSTRAINT IF EXISTS "meeting_attendees_meeting_id_project_meetings_id_fk";
--> statement-breakpoint
ALTER TABLE build.meeting_standup_entries DROP CONSTRAINT IF EXISTS "meeting_standup_entries_meeting_id_project_meetings_id_fk";
--> statement-breakpoint
ALTER TABLE build.modules DROP CONSTRAINT IF EXISTS "modules_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE build.okr_goals DROP CONSTRAINT IF EXISTS "okr_goals_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE build.okr_key_results DROP CONSTRAINT IF EXISTS "okr_key_results_goal_id_okr_goals_id_fk";
--> statement-breakpoint
ALTER TABLE build.okr_links DROP CONSTRAINT IF EXISTS "okr_links_goal_id_okr_goals_id_fk";
--> statement-breakpoint
ALTER TABLE build.okr_links DROP CONSTRAINT IF EXISTS "okr_links_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE build.okr_links DROP CONSTRAINT IF EXISTS "okr_links_ticket_id_tickets_id_fk";
--> statement-breakpoint
ALTER TABLE build.okr_updates DROP CONSTRAINT IF EXISTS "okr_updates_goal_id_okr_goals_id_fk";
--> statement-breakpoint
ALTER TABLE build.okr_updates DROP CONSTRAINT IF EXISTS "okr_updates_key_result_id_okr_key_results_id_fk";
--> statement-breakpoint
ALTER TABLE build.pages DROP CONSTRAINT IF EXISTS "pages_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE build.pm_workspace_memberships DROP CONSTRAINT IF EXISTS "pm_workspace_memberships_organization_membership_id_fkey";
--> statement-breakpoint
ALTER TABLE build.portfolio_projects DROP CONSTRAINT IF EXISTS "portfolio_projects_portfolio_id_project_portfolios_id_fk";
--> statement-breakpoint
ALTER TABLE build.portfolio_projects DROP CONSTRAINT IF EXISTS "portfolio_projects_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE build.program_projects DROP CONSTRAINT IF EXISTS "program_projects_program_id_project_programs_id_fk";
--> statement-breakpoint
ALTER TABLE build.program_projects DROP CONSTRAINT IF EXISTS "program_projects_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE build.project_approvals DROP CONSTRAINT IF EXISTS "project_approvals_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE build.project_automations DROP CONSTRAINT IF EXISTS "project_automations_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE build.project_daily_snapshots DROP CONSTRAINT IF EXISTS "project_daily_snapshots_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE build.project_decisions DROP CONSTRAINT IF EXISTS "project_decisions_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE build.project_decisions DROP CONSTRAINT IF EXISTS "project_decisions_linked_ticket_id_tickets_id_fk";
--> statement-breakpoint
ALTER TABLE build.project_forms DROP CONSTRAINT IF EXISTS "project_forms_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE build.project_incidents DROP CONSTRAINT IF EXISTS "project_incidents_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE build.project_incidents DROP CONSTRAINT IF EXISTS "project_incidents_linked_ticket_id_tickets_id_fk";
--> statement-breakpoint
ALTER TABLE build.project_meetings DROP CONSTRAINT IF EXISTS "project_meetings_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE build.project_meetings DROP CONSTRAINT IF EXISTS "project_meetings_sprint_id_sprints_id_fk";
--> statement-breakpoint
ALTER TABLE build.project_members DROP CONSTRAINT IF EXISTS "project_members_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE build.project_milestones DROP CONSTRAINT IF EXISTS "project_milestones_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE build.project_programs DROP CONSTRAINT IF EXISTS "project_programs_portfolio_id_project_portfolios_id_fk";
--> statement-breakpoint
ALTER TABLE build.project_releases DROP CONSTRAINT IF EXISTS "project_releases_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE build.project_risks DROP CONSTRAINT IF EXISTS "project_risks_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE build.project_risks DROP CONSTRAINT IF EXISTS "project_risks_linked_ticket_id_tickets_id_fk";
--> statement-breakpoint
ALTER TABLE build.project_statuses DROP CONSTRAINT IF EXISTS "project_statuses_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE build.project_team_assignments DROP CONSTRAINT IF EXISTS "project_team_assignments_team_id_fkey";
--> statement-breakpoint
ALTER TABLE build.project_team_assignments DROP CONSTRAINT IF EXISTS "project_team_assignments_project_id_fkey";
--> statement-breakpoint
ALTER TABLE build.project_team_members DROP CONSTRAINT IF EXISTS "project_team_members_team_id_fkey";
--> statement-breakpoint
ALTER TABLE build.project_template_tickets DROP CONSTRAINT IF EXISTS "project_template_tickets_template_id_project_templates_id_fk";
--> statement-breakpoint
ALTER TABLE build.project_views DROP CONSTRAINT IF EXISTS "project_views_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE build.project_webhooks DROP CONSTRAINT IF EXISTS "project_webhooks_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE build.project_whiteboard_shares DROP CONSTRAINT IF EXISTS "project_whiteboard_shares_whiteboard_id_project_whiteboards_id_";
--> statement-breakpoint
ALTER TABLE build.project_whiteboards DROP CONSTRAINT IF EXISTS "project_whiteboards_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE build.projects DROP CONSTRAINT IF EXISTS "fk_projects_managed_product";
--> statement-breakpoint
ALTER TABLE build.release_tickets DROP CONSTRAINT IF EXISTS "release_tickets_release_id_project_releases_id_fk";
--> statement-breakpoint
ALTER TABLE build.release_tickets DROP CONSTRAINT IF EXISTS "release_tickets_ticket_id_tickets_id_fk";
--> statement-breakpoint
ALTER TABLE build.roadmap_items DROP CONSTRAINT IF EXISTS "roadmap_items_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE build.roadmap_items DROP CONSTRAINT IF EXISTS "roadmap_items_epic_ticket_id_tickets_id_fk";
--> statement-breakpoint
ALTER TABLE build.roadmap_votes DROP CONSTRAINT IF EXISTS "roadmap_votes_roadmap_item_id_roadmap_items_id_fk";
--> statement-breakpoint
ALTER TABLE build.sprints DROP CONSTRAINT IF EXISTS "sprints_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE build.test_cases DROP CONSTRAINT IF EXISTS "test_cases_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE build.test_cases DROP CONSTRAINT IF EXISTS "test_cases_suite_id_test_suites_id_fk";
--> statement-breakpoint
ALTER TABLE build.test_cases DROP CONSTRAINT IF EXISTS "test_cases_linked_ticket_id_tickets_id_fk";
--> statement-breakpoint
ALTER TABLE build.test_run_results DROP CONSTRAINT IF EXISTS "test_run_results_linked_bug_id_bugs_id_fk";
--> statement-breakpoint
ALTER TABLE build.test_run_results DROP CONSTRAINT IF EXISTS "test_run_results_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE build.test_run_results DROP CONSTRAINT IF EXISTS "test_run_results_test_case_id_test_cases_id_fk";
--> statement-breakpoint
ALTER TABLE build.test_run_results DROP CONSTRAINT IF EXISTS "test_run_results_run_id_test_runs_id_fk";
--> statement-breakpoint
ALTER TABLE build.test_runs DROP CONSTRAINT IF EXISTS "test_runs_release_id_project_releases_id_fk";
--> statement-breakpoint
ALTER TABLE build.test_runs DROP CONSTRAINT IF EXISTS "test_runs_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE build.test_runs DROP CONSTRAINT IF EXISTS "test_runs_sprint_id_sprints_id_fk";
--> statement-breakpoint
ALTER TABLE build.test_suites DROP CONSTRAINT IF EXISTS "test_suites_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE build.test_suites DROP CONSTRAINT IF EXISTS "test_suites_parent_id_test_suites_id_fk";
--> statement-breakpoint
ALTER TABLE build.ticket_assignees DROP CONSTRAINT IF EXISTS "ticket_assignees_ticket_id_tickets_id_fk";
--> statement-breakpoint
ALTER TABLE build.ticket_attachments DROP CONSTRAINT IF EXISTS "ticket_attachments_ticket_id_tickets_id_fk";
--> statement-breakpoint
ALTER TABLE build.ticket_checklist_items DROP CONSTRAINT IF EXISTS "ticket_checklist_items_checklist_id_ticket_checklists_id_fk";
--> statement-breakpoint
ALTER TABLE build.ticket_checklists DROP CONSTRAINT IF EXISTS "ticket_checklists_ticket_id_tickets_id_fk";
--> statement-breakpoint
ALTER TABLE build.ticket_comment_mentions DROP CONSTRAINT IF EXISTS "ticket_comment_mentions_comment_id_ticket_comments_id_fk";
--> statement-breakpoint
ALTER TABLE build.ticket_comment_reactions DROP CONSTRAINT IF EXISTS "ticket_comment_reactions_comment_id_ticket_comments_id_fk";
--> statement-breakpoint
ALTER TABLE build.ticket_custom_field_values DROP CONSTRAINT IF EXISTS "ticket_custom_field_values_field_definition_id_fkey";
--> statement-breakpoint
ALTER TABLE build.ticket_custom_field_values DROP CONSTRAINT IF EXISTS "ticket_custom_field_values_ticket_id_fkey";
--> statement-breakpoint
ALTER TABLE build.ticket_label_mappings DROP CONSTRAINT IF EXISTS "ticket_label_mappings_label_id_ticket_labels_id_fk";
--> statement-breakpoint
ALTER TABLE build.ticket_label_mappings DROP CONSTRAINT IF EXISTS "ticket_label_mappings_ticket_id_tickets_id_fk";
--> statement-breakpoint
ALTER TABLE build.ticket_related_links DROP CONSTRAINT IF EXISTS "ticket_related_links_ticket_id_tickets_id_fk";
--> statement-breakpoint
ALTER TABLE build.ticket_watchers DROP CONSTRAINT IF EXISTS "ticket_watchers_ticket_id_tickets_id_fk";
--> statement-breakpoint
ALTER TABLE build.tickets DROP CONSTRAINT IF EXISTS "tickets_cycle_id_cycles_id_fk";
--> statement-breakpoint
ALTER TABLE build.tickets DROP CONSTRAINT IF EXISTS "tickets_module_id_modules_id_fk";
--> statement-breakpoint
ALTER TABLE build.tickets DROP CONSTRAINT IF EXISTS "tickets_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE build.tickets DROP CONSTRAINT IF EXISTS "tickets_sprint_id_sprints_id_fk";
--> statement-breakpoint
ALTER TABLE build.tickets DROP CONSTRAINT IF EXISTS "fk_tickets_recurrence_parent";
--> statement-breakpoint
ALTER TABLE build.webhook_deliveries DROP CONSTRAINT IF EXISTS "webhook_deliveries_webhook_id_project_webhooks_id_fk";
--> statement-breakpoint
ALTER TABLE build.work_item_relations DROP CONSTRAINT IF EXISTS "work_item_relations_related_work_item_id_tickets_id_fk";
--> statement-breakpoint
ALTER TABLE build.work_item_relations DROP CONSTRAINT IF EXISTS "work_item_relations_work_item_id_tickets_id_fk";
--> statement-breakpoint
ALTER TABLE build.workflow_transitions DROP CONSTRAINT IF EXISTS "workflow_transitions_from_status_id_project_statuses_id_fk";
--> statement-breakpoint
ALTER TABLE build.workflow_transitions DROP CONSTRAINT IF EXISTS "workflow_transitions_to_status_id_project_statuses_id_fk";
--> statement-breakpoint
ALTER TABLE build.workflow_transitions DROP CONSTRAINT IF EXISTS "workflow_transitions_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE build_events.sprint_scope_events DROP CONSTRAINT IF EXISTS "sprint_scope_events_sprint_id_sprints_id_fk";
--> statement-breakpoint
ALTER TABLE build_events.sprint_scope_events DROP CONSTRAINT IF EXISTS "sprint_scope_events_ticket_id_tickets_id_fk";
--> statement-breakpoint
ALTER TABLE build_events.ticket_activity_log DROP CONSTRAINT IF EXISTS "ticket_activity_log_ticket_id_tickets_id_fk";
--> statement-breakpoint
ALTER TABLE build_events.ticket_comments DROP CONSTRAINT IF EXISTS "ticket_comments_ticket_id_tickets_id_fk";

SET lock_timeout = DEFAULT;
