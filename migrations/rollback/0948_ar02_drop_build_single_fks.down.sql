-- 0948_ar02_drop_build_single_fks DOWN
SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE build.bugs
  ADD CONSTRAINT "bugs_affected_release_id_project_releases_id_fk"
  FOREIGN KEY (affected_release_id) REFERENCES build.project_releases (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.bugs
  ADD CONSTRAINT "bugs_fixed_release_id_project_releases_id_fk"
  FOREIGN KEY (fixed_release_id) REFERENCES build.project_releases (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.bugs
  ADD CONSTRAINT "bugs_project_id_projects_id_fk"
  FOREIGN KEY (project_id) REFERENCES build.projects (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.bugs
  ADD CONSTRAINT "bugs_linked_test_case_id_test_cases_id_fk"
  FOREIGN KEY (linked_test_case_id) REFERENCES build.test_cases (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.bugs
  ADD CONSTRAINT "bugs_linked_ticket_id_tickets_id_fk"
  FOREIGN KEY (linked_ticket_id) REFERENCES build.tickets (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.change_requests
  ADD CONSTRAINT "change_requests_project_id_projects_id_fk"
  FOREIGN KEY (project_id) REFERENCES build.projects (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.changelog_entries
  ADD CONSTRAINT "changelog_entries_linked_roadmap_item_id_roadmap_items_id_fk"
  FOREIGN KEY (linked_roadmap_item_id) REFERENCES build.roadmap_items (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.comment_drafts
  ADD CONSTRAINT "comment_drafts_ticket_id_fkey"
  FOREIGN KEY (ticket_id) REFERENCES build.tickets (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.cycles
  ADD CONSTRAINT "cycles_project_id_projects_id_fk"
  FOREIGN KEY (project_id) REFERENCES build.projects (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.feedback_posts
  ADD CONSTRAINT "feedback_posts_duplicate_of_id_feedback_posts_id_fk"
  FOREIGN KEY (duplicate_of_id) REFERENCES build.feedback_posts (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.feedback_posts
  ADD CONSTRAINT "feedback_posts_linked_roadmap_item_id_roadmap_items_id_fk"
  FOREIGN KEY (linked_roadmap_item_id) REFERENCES build.roadmap_items (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.feedback_votes
  ADD CONSTRAINT "feedback_votes_feedback_post_id_feedback_posts_id_fk"
  FOREIGN KEY (feedback_post_id) REFERENCES build.feedback_posts (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.feedbucket_attachments
  ADD CONSTRAINT "feedbucket_attachments_submission_id_feedbucket_submissions_id_"
  FOREIGN KEY (submission_id) REFERENCES build.feedbucket_submissions (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.feedbucket_submissions
  ADD CONSTRAINT "feedbucket_submissions_widget_id_feedbucket_widgets_id_fk"
  FOREIGN KEY (widget_id) REFERENCES build.feedbucket_widgets (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.feedbucket_submissions
  ADD CONSTRAINT "feedbucket_submissions_linked_ticket_id_tickets_id_fk"
  FOREIGN KEY (linked_ticket_id) REFERENCES build.tickets (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.feedbucket_widgets
  ADD CONSTRAINT "fk_feedbucket_widgets_managed_product"
  FOREIGN KEY (managed_product_id) REFERENCES build.managed_products (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.feedbucket_widgets
  ADD CONSTRAINT "feedbucket_widgets_project_id_projects_id_fk"
  FOREIGN KEY (project_id) REFERENCES build.projects (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.form_submissions
  ADD CONSTRAINT "form_submissions_form_id_project_forms_id_fk"
  FOREIGN KEY (form_id) REFERENCES build.project_forms (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.form_submissions
  ADD CONSTRAINT "form_submissions_project_id_projects_id_fk"
  FOREIGN KEY (project_id) REFERENCES build.projects (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.form_submissions
  ADD CONSTRAINT "form_submissions_converted_ticket_id_tickets_id_fk"
  FOREIGN KEY (converted_ticket_id) REFERENCES build.tickets (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.git_connections
  ADD CONSTRAINT "git_connections_project_id_projects_id_fk"
  FOREIGN KEY (project_id) REFERENCES build.projects (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.git_ticket_links
  ADD CONSTRAINT "git_ticket_links_connection_id_git_connections_id_fk"
  FOREIGN KEY (connection_id) REFERENCES build.git_connections (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.git_ticket_links
  ADD CONSTRAINT "git_ticket_links_ticket_id_tickets_id_fk"
  FOREIGN KEY (ticket_id) REFERENCES build.tickets (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.incident_updates
  ADD CONSTRAINT "incident_updates_incident_id_project_incidents_id_fk"
  FOREIGN KEY (incident_id) REFERENCES build.project_incidents (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.intake_items
  ADD CONSTRAINT "intake_items_project_id_projects_id_fk"
  FOREIGN KEY (project_id) REFERENCES build.projects (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.intake_items
  ADD CONSTRAINT "intake_items_linked_work_item_id_tickets_id_fk"
  FOREIGN KEY (linked_work_item_id) REFERENCES build.tickets (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.managed_product_releases
  ADD CONSTRAINT "fk_managed_product_releases_product"
  FOREIGN KEY (managed_product_id) REFERENCES build.managed_products (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.meeting_action_items
  ADD CONSTRAINT "meeting_action_items_meeting_id_project_meetings_id_fk"
  FOREIGN KEY (meeting_id) REFERENCES build.project_meetings (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.meeting_action_items
  ADD CONSTRAINT "meeting_action_items_project_id_projects_id_fk"
  FOREIGN KEY (project_id) REFERENCES build.projects (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.meeting_action_items
  ADD CONSTRAINT "meeting_action_items_converted_ticket_id_tickets_id_fk"
  FOREIGN KEY (converted_ticket_id) REFERENCES build.tickets (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.meeting_attendees
  ADD CONSTRAINT "meeting_attendees_meeting_id_project_meetings_id_fk"
  FOREIGN KEY (meeting_id) REFERENCES build.project_meetings (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.meeting_standup_entries
  ADD CONSTRAINT "meeting_standup_entries_meeting_id_project_meetings_id_fk"
  FOREIGN KEY (meeting_id) REFERENCES build.project_meetings (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.modules
  ADD CONSTRAINT "modules_project_id_projects_id_fk"
  FOREIGN KEY (project_id) REFERENCES build.projects (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.okr_goals
  ADD CONSTRAINT "okr_goals_project_id_projects_id_fk"
  FOREIGN KEY (project_id) REFERENCES build.projects (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.okr_key_results
  ADD CONSTRAINT "okr_key_results_goal_id_okr_goals_id_fk"
  FOREIGN KEY (goal_id) REFERENCES build.okr_goals (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.okr_links
  ADD CONSTRAINT "okr_links_goal_id_okr_goals_id_fk"
  FOREIGN KEY (goal_id) REFERENCES build.okr_goals (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.okr_links
  ADD CONSTRAINT "okr_links_project_id_projects_id_fk"
  FOREIGN KEY (project_id) REFERENCES build.projects (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.okr_links
  ADD CONSTRAINT "okr_links_ticket_id_tickets_id_fk"
  FOREIGN KEY (ticket_id) REFERENCES build.tickets (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.okr_updates
  ADD CONSTRAINT "okr_updates_goal_id_okr_goals_id_fk"
  FOREIGN KEY (goal_id) REFERENCES build.okr_goals (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.okr_updates
  ADD CONSTRAINT "okr_updates_key_result_id_okr_key_results_id_fk"
  FOREIGN KEY (key_result_id) REFERENCES build.okr_key_results (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.pages
  ADD CONSTRAINT "pages_project_id_projects_id_fk"
  FOREIGN KEY (project_id) REFERENCES build.projects (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.pm_workspace_memberships
  ADD CONSTRAINT "pm_workspace_memberships_organization_membership_id_fkey"
  FOREIGN KEY (organization_membership_id) REFERENCES organization_members (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.portfolio_projects
  ADD CONSTRAINT "portfolio_projects_portfolio_id_project_portfolios_id_fk"
  FOREIGN KEY (portfolio_id) REFERENCES build.project_portfolios (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.portfolio_projects
  ADD CONSTRAINT "portfolio_projects_project_id_projects_id_fk"
  FOREIGN KEY (project_id) REFERENCES build.projects (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.program_projects
  ADD CONSTRAINT "program_projects_program_id_project_programs_id_fk"
  FOREIGN KEY (program_id) REFERENCES build.project_programs (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.program_projects
  ADD CONSTRAINT "program_projects_project_id_projects_id_fk"
  FOREIGN KEY (project_id) REFERENCES build.projects (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.project_approvals
  ADD CONSTRAINT "project_approvals_project_id_projects_id_fk"
  FOREIGN KEY (project_id) REFERENCES build.projects (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.project_automations
  ADD CONSTRAINT "project_automations_project_id_projects_id_fk"
  FOREIGN KEY (project_id) REFERENCES build.projects (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.project_daily_snapshots
  ADD CONSTRAINT "project_daily_snapshots_project_id_projects_id_fk"
  FOREIGN KEY (project_id) REFERENCES build.projects (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.project_decisions
  ADD CONSTRAINT "project_decisions_project_id_projects_id_fk"
  FOREIGN KEY (project_id) REFERENCES build.projects (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.project_decisions
  ADD CONSTRAINT "project_decisions_linked_ticket_id_tickets_id_fk"
  FOREIGN KEY (linked_ticket_id) REFERENCES build.tickets (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.project_forms
  ADD CONSTRAINT "project_forms_project_id_projects_id_fk"
  FOREIGN KEY (project_id) REFERENCES build.projects (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.project_incidents
  ADD CONSTRAINT "project_incidents_project_id_projects_id_fk"
  FOREIGN KEY (project_id) REFERENCES build.projects (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.project_incidents
  ADD CONSTRAINT "project_incidents_linked_ticket_id_tickets_id_fk"
  FOREIGN KEY (linked_ticket_id) REFERENCES build.tickets (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.project_meetings
  ADD CONSTRAINT "project_meetings_project_id_projects_id_fk"
  FOREIGN KEY (project_id) REFERENCES build.projects (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.project_meetings
  ADD CONSTRAINT "project_meetings_sprint_id_sprints_id_fk"
  FOREIGN KEY (sprint_id) REFERENCES build.sprints (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.project_members
  ADD CONSTRAINT "project_members_project_id_projects_id_fk"
  FOREIGN KEY (project_id) REFERENCES build.projects (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.project_milestones
  ADD CONSTRAINT "project_milestones_project_id_projects_id_fk"
  FOREIGN KEY (project_id) REFERENCES build.projects (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.project_programs
  ADD CONSTRAINT "project_programs_portfolio_id_project_portfolios_id_fk"
  FOREIGN KEY (portfolio_id) REFERENCES build.project_portfolios (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.project_releases
  ADD CONSTRAINT "project_releases_project_id_projects_id_fk"
  FOREIGN KEY (project_id) REFERENCES build.projects (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.project_risks
  ADD CONSTRAINT "project_risks_project_id_projects_id_fk"
  FOREIGN KEY (project_id) REFERENCES build.projects (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.project_risks
  ADD CONSTRAINT "project_risks_linked_ticket_id_tickets_id_fk"
  FOREIGN KEY (linked_ticket_id) REFERENCES build.tickets (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.project_statuses
  ADD CONSTRAINT "project_statuses_project_id_projects_id_fk"
  FOREIGN KEY (project_id) REFERENCES build.projects (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.project_team_assignments
  ADD CONSTRAINT "project_team_assignments_team_id_fkey"
  FOREIGN KEY (team_id) REFERENCES build.project_teams (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.project_team_assignments
  ADD CONSTRAINT "project_team_assignments_project_id_fkey"
  FOREIGN KEY (project_id) REFERENCES build.projects (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.project_team_members
  ADD CONSTRAINT "project_team_members_team_id_fkey"
  FOREIGN KEY (team_id) REFERENCES build.project_teams (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.project_template_tickets
  ADD CONSTRAINT "project_template_tickets_template_id_project_templates_id_fk"
  FOREIGN KEY (template_id) REFERENCES build.project_templates (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.project_views
  ADD CONSTRAINT "project_views_project_id_projects_id_fk"
  FOREIGN KEY (project_id) REFERENCES build.projects (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.project_webhooks
  ADD CONSTRAINT "project_webhooks_project_id_projects_id_fk"
  FOREIGN KEY (project_id) REFERENCES build.projects (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.project_whiteboard_shares
  ADD CONSTRAINT "project_whiteboard_shares_whiteboard_id_project_whiteboards_id_"
  FOREIGN KEY (whiteboard_id) REFERENCES build.project_whiteboards (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.project_whiteboards
  ADD CONSTRAINT "project_whiteboards_project_id_projects_id_fk"
  FOREIGN KEY (project_id) REFERENCES build.projects (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.projects
  ADD CONSTRAINT "fk_projects_managed_product"
  FOREIGN KEY (managed_product_id) REFERENCES build.managed_products (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.release_tickets
  ADD CONSTRAINT "release_tickets_release_id_project_releases_id_fk"
  FOREIGN KEY (release_id) REFERENCES build.project_releases (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.release_tickets
  ADD CONSTRAINT "release_tickets_ticket_id_tickets_id_fk"
  FOREIGN KEY (ticket_id) REFERENCES build.tickets (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.roadmap_items
  ADD CONSTRAINT "roadmap_items_project_id_projects_id_fk"
  FOREIGN KEY (project_id) REFERENCES build.projects (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.roadmap_items
  ADD CONSTRAINT "roadmap_items_epic_ticket_id_tickets_id_fk"
  FOREIGN KEY (epic_ticket_id) REFERENCES build.tickets (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.roadmap_votes
  ADD CONSTRAINT "roadmap_votes_roadmap_item_id_roadmap_items_id_fk"
  FOREIGN KEY (roadmap_item_id) REFERENCES build.roadmap_items (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.sprints
  ADD CONSTRAINT "sprints_project_id_projects_id_fk"
  FOREIGN KEY (project_id) REFERENCES build.projects (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.test_cases
  ADD CONSTRAINT "test_cases_project_id_projects_id_fk"
  FOREIGN KEY (project_id) REFERENCES build.projects (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.test_cases
  ADD CONSTRAINT "test_cases_suite_id_test_suites_id_fk"
  FOREIGN KEY (suite_id) REFERENCES build.test_suites (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.test_cases
  ADD CONSTRAINT "test_cases_linked_ticket_id_tickets_id_fk"
  FOREIGN KEY (linked_ticket_id) REFERENCES build.tickets (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.test_run_results
  ADD CONSTRAINT "test_run_results_linked_bug_id_bugs_id_fk"
  FOREIGN KEY (linked_bug_id) REFERENCES build.bugs (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.test_run_results
  ADD CONSTRAINT "test_run_results_project_id_projects_id_fk"
  FOREIGN KEY (project_id) REFERENCES build.projects (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.test_run_results
  ADD CONSTRAINT "test_run_results_test_case_id_test_cases_id_fk"
  FOREIGN KEY (test_case_id) REFERENCES build.test_cases (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.test_run_results
  ADD CONSTRAINT "test_run_results_run_id_test_runs_id_fk"
  FOREIGN KEY (run_id) REFERENCES build.test_runs (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.test_runs
  ADD CONSTRAINT "test_runs_release_id_project_releases_id_fk"
  FOREIGN KEY (release_id) REFERENCES build.project_releases (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.test_runs
  ADD CONSTRAINT "test_runs_project_id_projects_id_fk"
  FOREIGN KEY (project_id) REFERENCES build.projects (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.test_runs
  ADD CONSTRAINT "test_runs_sprint_id_sprints_id_fk"
  FOREIGN KEY (sprint_id) REFERENCES build.sprints (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.test_suites
  ADD CONSTRAINT "test_suites_project_id_projects_id_fk"
  FOREIGN KEY (project_id) REFERENCES build.projects (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.test_suites
  ADD CONSTRAINT "test_suites_parent_id_test_suites_id_fk"
  FOREIGN KEY (parent_id) REFERENCES build.test_suites (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.ticket_assignees
  ADD CONSTRAINT "ticket_assignees_ticket_id_tickets_id_fk"
  FOREIGN KEY (ticket_id) REFERENCES build.tickets (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.ticket_attachments
  ADD CONSTRAINT "ticket_attachments_ticket_id_tickets_id_fk"
  FOREIGN KEY (ticket_id) REFERENCES build.tickets (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.ticket_checklist_items
  ADD CONSTRAINT "ticket_checklist_items_checklist_id_ticket_checklists_id_fk"
  FOREIGN KEY (checklist_id) REFERENCES build.ticket_checklists (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.ticket_checklists
  ADD CONSTRAINT "ticket_checklists_ticket_id_tickets_id_fk"
  FOREIGN KEY (ticket_id) REFERENCES build.tickets (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.ticket_comment_mentions
  ADD CONSTRAINT "ticket_comment_mentions_comment_id_ticket_comments_id_fk"
  FOREIGN KEY (comment_id) REFERENCES build_events.ticket_comments (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.ticket_comment_reactions
  ADD CONSTRAINT "ticket_comment_reactions_comment_id_ticket_comments_id_fk"
  FOREIGN KEY (comment_id) REFERENCES build_events.ticket_comments (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.ticket_custom_field_values
  ADD CONSTRAINT "ticket_custom_field_values_field_definition_id_fkey"
  FOREIGN KEY (field_definition_id) REFERENCES custom_field_definitions (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.ticket_custom_field_values
  ADD CONSTRAINT "ticket_custom_field_values_ticket_id_fkey"
  FOREIGN KEY (ticket_id) REFERENCES build.tickets (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.ticket_label_mappings
  ADD CONSTRAINT "ticket_label_mappings_label_id_ticket_labels_id_fk"
  FOREIGN KEY (label_id) REFERENCES build.ticket_labels (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.ticket_label_mappings
  ADD CONSTRAINT "ticket_label_mappings_ticket_id_tickets_id_fk"
  FOREIGN KEY (ticket_id) REFERENCES build.tickets (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.ticket_related_links
  ADD CONSTRAINT "ticket_related_links_ticket_id_tickets_id_fk"
  FOREIGN KEY (ticket_id) REFERENCES build.tickets (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.ticket_watchers
  ADD CONSTRAINT "ticket_watchers_ticket_id_tickets_id_fk"
  FOREIGN KEY (ticket_id) REFERENCES build.tickets (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.tickets
  ADD CONSTRAINT "tickets_cycle_id_cycles_id_fk"
  FOREIGN KEY (cycle_id) REFERENCES build.cycles (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.tickets
  ADD CONSTRAINT "tickets_module_id_modules_id_fk"
  FOREIGN KEY (module_id) REFERENCES build.modules (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.tickets
  ADD CONSTRAINT "tickets_project_id_projects_id_fk"
  FOREIGN KEY (project_id) REFERENCES build.projects (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.tickets
  ADD CONSTRAINT "tickets_sprint_id_sprints_id_fk"
  FOREIGN KEY (sprint_id) REFERENCES build.sprints (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.tickets
  ADD CONSTRAINT "fk_tickets_recurrence_parent"
  FOREIGN KEY (recurrence_parent_id) REFERENCES build.tickets (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.webhook_deliveries
  ADD CONSTRAINT "webhook_deliveries_webhook_id_project_webhooks_id_fk"
  FOREIGN KEY (webhook_id) REFERENCES build.project_webhooks (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.work_item_relations
  ADD CONSTRAINT "work_item_relations_related_work_item_id_tickets_id_fk"
  FOREIGN KEY (related_work_item_id) REFERENCES build.tickets (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.work_item_relations
  ADD CONSTRAINT "work_item_relations_work_item_id_tickets_id_fk"
  FOREIGN KEY (work_item_id) REFERENCES build.tickets (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.workflow_transitions
  ADD CONSTRAINT "workflow_transitions_from_status_id_project_statuses_id_fk"
  FOREIGN KEY (from_status_id) REFERENCES build.project_statuses (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.workflow_transitions
  ADD CONSTRAINT "workflow_transitions_to_status_id_project_statuses_id_fk"
  FOREIGN KEY (to_status_id) REFERENCES build.project_statuses (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build.workflow_transitions
  ADD CONSTRAINT "workflow_transitions_project_id_projects_id_fk"
  FOREIGN KEY (project_id) REFERENCES build.projects (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build_events.sprint_scope_events
  ADD CONSTRAINT "sprint_scope_events_sprint_id_sprints_id_fk"
  FOREIGN KEY (sprint_id) REFERENCES build.sprints (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build_events.sprint_scope_events
  ADD CONSTRAINT "sprint_scope_events_ticket_id_tickets_id_fk"
  FOREIGN KEY (ticket_id) REFERENCES build.tickets (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build_events.ticket_activity_log
  ADD CONSTRAINT "ticket_activity_log_ticket_id_tickets_id_fk"
  FOREIGN KEY (ticket_id) REFERENCES build.tickets (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE build_events.ticket_comments
  ADD CONSTRAINT "ticket_comments_ticket_id_tickets_id_fk"
  FOREIGN KEY (ticket_id) REFERENCES build.tickets (id) ON DELETE CASCADE
  NOT VALID;
