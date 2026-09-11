// Generation script for build-schema AR-02 composite FK migrations
// Run: node src/scripts/gen-build-fk-migrations.mjs

const fks = [
  // === 0943: bugs, change_requests, changelog_entries, comment_drafts, cycles,
  //           feedback_posts, feedback_votes, feedbucket_*, form_submissions, git_*
  {cs:"build",t:"bugs",col:"affected_release_id",ps:"build",p:"project_releases",del:"SET_NULL",nm:"fk_bugs_org_affected_release"},
  {cs:"build",t:"bugs",col:"fixed_release_id",ps:"build",p:"project_releases",del:"SET_NULL",nm:"fk_bugs_org_fixed_release"},
  {cs:"build",t:"bugs",col:"project_id",ps:"build",p:"projects",del:"CASCADE",nm:"fk_bugs_org_project"},
  {cs:"build",t:"bugs",col:"linked_test_case_id",ps:"build",p:"test_cases",del:"SET_NULL",nm:"fk_bugs_org_test_case"},
  {cs:"build",t:"bugs",col:"linked_ticket_id",ps:"build",p:"tickets",del:"SET_NULL",nm:"fk_bugs_org_ticket"},
  {cs:"build",t:"change_requests",col:"project_id",ps:"build",p:"projects",del:"CASCADE",nm:"fk_change_requests_org_project"},
  {cs:"build",t:"changelog_entries",col:"linked_roadmap_item_id",ps:"build",p:"roadmap_items",del:"SET_NULL",nm:"fk_changelog_entries_org_roadmap"},
  {cs:"build",t:"comment_drafts",col:"ticket_id",ps:"build",p:"tickets",del:"CASCADE",nm:"fk_comment_drafts_org_ticket"},
  {cs:"build",t:"cycles",col:"project_id",ps:"build",p:"projects",del:"CASCADE",nm:"fk_cycles_org_project"},
  {cs:"build",t:"feedback_posts",col:"duplicate_of_id",ps:"build",p:"feedback_posts",del:"SET_NULL",nm:"fk_feedback_posts_org_dup"},
  {cs:"build",t:"feedback_posts",col:"linked_roadmap_item_id",ps:"build",p:"roadmap_items",del:"SET_NULL",nm:"fk_feedback_posts_org_roadmap"},
  {cs:"build",t:"feedback_votes",col:"feedback_post_id",ps:"build",p:"feedback_posts",del:"CASCADE",nm:"fk_feedback_votes_org_post"},
  {cs:"build",t:"feedbucket_attachments",col:"submission_id",ps:"build",p:"feedbucket_submissions",del:"CASCADE",nm:"fk_feedbucket_attachments_org_submission"},
  {cs:"build",t:"feedbucket_submissions",col:"widget_id",ps:"build",p:"feedbucket_widgets",del:"CASCADE",nm:"fk_feedbucket_submissions_org_widget"},
  {cs:"build",t:"feedbucket_submissions",col:"linked_ticket_id",ps:"build",p:"tickets",del:"SET_NULL",nm:"fk_feedbucket_submissions_org_ticket"},
  {cs:"build",t:"feedbucket_widgets",col:"managed_product_id",ps:"build",p:"managed_products",del:"SET_NULL",nm:"fk_feedbucket_widgets_org_product"},
  {cs:"build",t:"feedbucket_widgets",col:"project_id",ps:"build",p:"projects",del:"SET_NULL",nm:"fk_feedbucket_widgets_org_project"},
  {cs:"build",t:"form_submissions",col:"form_id",ps:"build",p:"project_forms",del:"CASCADE",nm:"fk_form_submissions_org_form"},
  {cs:"build",t:"form_submissions",col:"project_id",ps:"build",p:"projects",del:"CASCADE",nm:"fk_form_submissions_org_project"},
  {cs:"build",t:"form_submissions",col:"converted_ticket_id",ps:"build",p:"tickets",del:"SET_NULL",nm:"fk_form_submissions_org_ticket"},
  {cs:"build",t:"git_connections",col:"project_id",ps:"build",p:"projects",del:"SET_NULL",nm:"fk_git_connections_org_project"},
  {cs:"build",t:"git_ticket_links",col:"connection_id",ps:"build",p:"git_connections",del:"SET_NULL",nm:"fk_git_ticket_links_org_connection"},
  {cs:"build",t:"git_ticket_links",col:"ticket_id",ps:"build",p:"tickets",del:"CASCADE",nm:"fk_git_ticket_links_org_ticket"},

  // === 0944: incident_updates, intake_items, managed_product_releases,
  //           meeting_*, modules, okr_*, pages
  {cs:"build",t:"incident_updates",col:"incident_id",ps:"build",p:"project_incidents",del:"CASCADE",nm:"fk_incident_updates_org_incident"},
  {cs:"build",t:"intake_items",col:"project_id",ps:"build",p:"projects",del:"CASCADE",nm:"fk_intake_items_org_project"},
  {cs:"build",t:"intake_items",col:"linked_work_item_id",ps:"build",p:"tickets",del:"SET_NULL",nm:"fk_intake_items_org_ticket"},
  {cs:"build",t:"managed_product_releases",col:"managed_product_id",ps:"build",p:"managed_products",del:"CASCADE",nm:"fk_managed_product_releases_org_product"},
  {cs:"build",t:"meeting_action_items",col:"meeting_id",ps:"build",p:"project_meetings",del:"CASCADE",nm:"fk_meeting_action_items_org_meeting"},
  {cs:"build",t:"meeting_action_items",col:"project_id",ps:"build",p:"projects",del:"CASCADE",nm:"fk_meeting_action_items_org_project"},
  {cs:"build",t:"meeting_action_items",col:"converted_ticket_id",ps:"build",p:"tickets",del:"SET_NULL",nm:"fk_meeting_action_items_org_ticket"},
  {cs:"build",t:"meeting_attendees",col:"meeting_id",ps:"build",p:"project_meetings",del:"CASCADE",nm:"fk_meeting_attendees_org_meeting"},
  {cs:"build",t:"meeting_standup_entries",col:"meeting_id",ps:"build",p:"project_meetings",del:"CASCADE",nm:"fk_meeting_standup_entries_org_meeting"},
  {cs:"build",t:"modules",col:"project_id",ps:"build",p:"projects",del:"CASCADE",nm:"fk_modules_org_project"},
  {cs:"build",t:"okr_goals",col:"project_id",ps:"build",p:"projects",del:"SET_NULL",nm:"fk_okr_goals_org_project"},
  {cs:"build",t:"okr_key_results",col:"goal_id",ps:"build",p:"okr_goals",del:"CASCADE",nm:"fk_okr_key_results_org_goal"},
  {cs:"build",t:"okr_links",col:"goal_id",ps:"build",p:"okr_goals",del:"CASCADE",nm:"fk_okr_links_org_goal"},
  {cs:"build",t:"okr_links",col:"project_id",ps:"build",p:"projects",del:"CASCADE",nm:"fk_okr_links_org_project"},
  {cs:"build",t:"okr_links",col:"ticket_id",ps:"build",p:"tickets",del:"CASCADE",nm:"fk_okr_links_org_ticket"},
  {cs:"build",t:"okr_updates",col:"goal_id",ps:"build",p:"okr_goals",del:"CASCADE",nm:"fk_okr_updates_org_goal"},
  {cs:"build",t:"okr_updates",col:"key_result_id",ps:"build",p:"okr_key_results",del:"SET_NULL",nm:"fk_okr_updates_org_kr"},
  {cs:"build",t:"pages",col:"project_id",ps:"build",p:"projects",del:"CASCADE",nm:"fk_pages_org_project"},

  // === 0945: pm_workspace_memberships, portfolio_projects, program_projects,
  //           project_approvals..project_milestones
  {cs:"build",t:"pm_workspace_memberships",col:"organization_membership_id",ps:"public",p:"organization_members",del:"CASCADE",nm:"fk_pm_memberships_org_member"},
  {cs:"build",t:"portfolio_projects",col:"portfolio_id",ps:"build",p:"project_portfolios",del:"CASCADE",nm:"fk_portfolio_projects_org_portfolio"},
  {cs:"build",t:"portfolio_projects",col:"project_id",ps:"build",p:"projects",del:"CASCADE",nm:"fk_portfolio_projects_org_project"},
  {cs:"build",t:"program_projects",col:"program_id",ps:"build",p:"project_programs",del:"CASCADE",nm:"fk_program_projects_org_program"},
  {cs:"build",t:"program_projects",col:"project_id",ps:"build",p:"projects",del:"CASCADE",nm:"fk_program_projects_org_project"},
  {cs:"build",t:"project_approvals",col:"project_id",ps:"build",p:"projects",del:"CASCADE",nm:"fk_project_approvals_org_project"},
  {cs:"build",t:"project_automations",col:"project_id",ps:"build",p:"projects",del:"CASCADE",nm:"fk_project_automations_org_project"},
  {cs:"build",t:"project_daily_snapshots",col:"project_id",ps:"build",p:"projects",del:"CASCADE",nm:"fk_project_daily_snapshots_org_project"},
  {cs:"build",t:"project_decisions",col:"project_id",ps:"build",p:"projects",del:"CASCADE",nm:"fk_project_decisions_org_project"},
  {cs:"build",t:"project_decisions",col:"linked_ticket_id",ps:"build",p:"tickets",del:"SET_NULL",nm:"fk_project_decisions_org_ticket"},
  {cs:"build",t:"project_forms",col:"project_id",ps:"build",p:"projects",del:"CASCADE",nm:"fk_project_forms_org_project"},
  {cs:"build",t:"project_incidents",col:"project_id",ps:"build",p:"projects",del:"CASCADE",nm:"fk_project_incidents_org_project"},
  {cs:"build",t:"project_incidents",col:"linked_ticket_id",ps:"build",p:"tickets",del:"SET_NULL",nm:"fk_project_incidents_org_ticket"},
  {cs:"build",t:"project_meetings",col:"project_id",ps:"build",p:"projects",del:"CASCADE",nm:"fk_project_meetings_org_project"},
  {cs:"build",t:"project_meetings",col:"sprint_id",ps:"build",p:"sprints",del:"SET_NULL",nm:"fk_project_meetings_org_sprint"},
  {cs:"build",t:"project_members",col:"project_id",ps:"build",p:"projects",del:"CASCADE",nm:"fk_project_members_org_project"},
  {cs:"build",t:"project_milestones",col:"project_id",ps:"build",p:"projects",del:"CASCADE",nm:"fk_project_milestones_org_project"},

  // === 0946: project_programs..projects, release_tickets, roadmap_*, sprints,
  //           test_*, ticket_assignees, ticket_attachments, ticket_checklist_items, ticket_checklists
  {cs:"build",t:"project_programs",col:"portfolio_id",ps:"build",p:"project_portfolios",del:"SET_NULL",nm:"fk_project_programs_org_portfolio"},
  {cs:"build",t:"project_releases",col:"project_id",ps:"build",p:"projects",del:"CASCADE",nm:"fk_project_releases_org_project"},
  {cs:"build",t:"project_risks",col:"project_id",ps:"build",p:"projects",del:"CASCADE",nm:"fk_project_risks_org_project"},
  {cs:"build",t:"project_risks",col:"linked_ticket_id",ps:"build",p:"tickets",del:"SET_NULL",nm:"fk_project_risks_org_ticket"},
  {cs:"build",t:"project_statuses",col:"project_id",ps:"build",p:"projects",del:"CASCADE",nm:"fk_project_statuses_org_project"},
  {cs:"build",t:"project_team_assignments",col:"team_id",ps:"build",p:"project_teams",del:"CASCADE",nm:"fk_project_team_assignments_org_team"},
  {cs:"build",t:"project_team_assignments",col:"project_id",ps:"build",p:"projects",del:"CASCADE",nm:"fk_project_team_assignments_org_project"},
  {cs:"build",t:"project_team_members",col:"team_id",ps:"build",p:"project_teams",del:"CASCADE",nm:"fk_project_team_members_org_team"},
  {cs:"build",t:"project_template_tickets",col:"template_id",ps:"build",p:"project_templates",del:"CASCADE",nm:"fk_project_template_tickets_org_template"},
  {cs:"build",t:"project_views",col:"project_id",ps:"build",p:"projects",del:"CASCADE",nm:"fk_project_views_org_project"},
  {cs:"build",t:"project_webhooks",col:"project_id",ps:"build",p:"projects",del:"CASCADE",nm:"fk_project_webhooks_org_project"},
  {cs:"build",t:"project_whiteboard_shares",col:"whiteboard_id",ps:"build",p:"project_whiteboards",del:"CASCADE",nm:"fk_project_whiteboard_shares_org_board"},
  {cs:"build",t:"project_whiteboards",col:"project_id",ps:"build",p:"projects",del:"CASCADE",nm:"fk_project_whiteboards_org_project"},
  {cs:"build",t:"projects",col:"managed_product_id",ps:"build",p:"managed_products",del:"SET_NULL",nm:"fk_projects_org_product"},
  {cs:"build",t:"release_tickets",col:"release_id",ps:"build",p:"project_releases",del:"CASCADE",nm:"fk_release_tickets_org_release"},
  {cs:"build",t:"release_tickets",col:"ticket_id",ps:"build",p:"tickets",del:"CASCADE",nm:"fk_release_tickets_org_ticket"},
  {cs:"build",t:"roadmap_items",col:"project_id",ps:"build",p:"projects",del:"SET_NULL",nm:"fk_roadmap_items_org_project"},
  {cs:"build",t:"roadmap_items",col:"epic_ticket_id",ps:"build",p:"tickets",del:"SET_NULL",nm:"fk_roadmap_items_org_ticket"},
  {cs:"build",t:"roadmap_votes",col:"roadmap_item_id",ps:"build",p:"roadmap_items",del:"CASCADE",nm:"fk_roadmap_votes_org_roadmap"},
  {cs:"build",t:"sprints",col:"project_id",ps:"build",p:"projects",del:"CASCADE",nm:"fk_sprints_org_project"},
  {cs:"build",t:"test_cases",col:"project_id",ps:"build",p:"projects",del:"CASCADE",nm:"fk_test_cases_org_project"},
  {cs:"build",t:"test_cases",col:"suite_id",ps:"build",p:"test_suites",del:"SET_NULL",nm:"fk_test_cases_org_suite"},
  {cs:"build",t:"test_cases",col:"linked_ticket_id",ps:"build",p:"tickets",del:"SET_NULL",nm:"fk_test_cases_org_ticket"},
  {cs:"build",t:"test_run_results",col:"linked_bug_id",ps:"build",p:"bugs",del:"SET_NULL",nm:"fk_test_run_results_org_bug"},
  {cs:"build",t:"test_run_results",col:"project_id",ps:"build",p:"projects",del:"CASCADE",nm:"fk_test_run_results_org_project"},
  {cs:"build",t:"test_run_results",col:"test_case_id",ps:"build",p:"test_cases",del:"CASCADE",nm:"fk_test_run_results_org_case"},
  {cs:"build",t:"test_run_results",col:"run_id",ps:"build",p:"test_runs",del:"CASCADE",nm:"fk_test_run_results_org_run"},
  {cs:"build",t:"test_runs",col:"release_id",ps:"build",p:"project_releases",del:"SET_NULL",nm:"fk_test_runs_org_release"},
  {cs:"build",t:"test_runs",col:"project_id",ps:"build",p:"projects",del:"CASCADE",nm:"fk_test_runs_org_project"},
  {cs:"build",t:"test_runs",col:"sprint_id",ps:"build",p:"sprints",del:"SET_NULL",nm:"fk_test_runs_org_sprint"},
  {cs:"build",t:"test_suites",col:"project_id",ps:"build",p:"projects",del:"CASCADE",nm:"fk_test_suites_org_project"},
  {cs:"build",t:"test_suites",col:"parent_id",ps:"build",p:"test_suites",del:"SET_NULL",nm:"fk_test_suites_org_parent"},
  {cs:"build",t:"ticket_assignees",col:"ticket_id",ps:"build",p:"tickets",del:"CASCADE",nm:"fk_ticket_assignees_org_ticket"},
  {cs:"build",t:"ticket_attachments",col:"ticket_id",ps:"build",p:"tickets",del:"CASCADE",nm:"fk_ticket_attachments_org_ticket"},
  {cs:"build",t:"ticket_checklist_items",col:"checklist_id",ps:"build",p:"ticket_checklists",del:"CASCADE",nm:"fk_ticket_checklist_items_org_checklist"},
  {cs:"build",t:"ticket_checklists",col:"ticket_id",ps:"build",p:"tickets",del:"CASCADE",nm:"fk_ticket_checklists_org_ticket"},

  // === 0947: ticket_comment_mentions, ticket_comment_reactions,
  //           ticket_custom_field_values, ticket_label_mappings, ticket_related_links,
  //           ticket_watchers, tickets (4), webhook_deliveries, work_item_relations,
  //           workflow_transitions, build_events.*
  {cs:"build",t:"ticket_comment_mentions",col:"comment_id",ps:"build_events",p:"ticket_comments",del:"CASCADE",nm:"fk_ticket_comment_mentions_org_comment"},
  {cs:"build",t:"ticket_comment_reactions",col:"comment_id",ps:"build_events",p:"ticket_comments",del:"CASCADE",nm:"fk_ticket_comment_reactions_org_comment"},
  {cs:"build",t:"ticket_custom_field_values",col:"field_definition_id",ps:"public",p:"custom_field_definitions",del:"CASCADE",nm:"fk_ticket_cfield_values_org_def"},
  {cs:"build",t:"ticket_custom_field_values",col:"ticket_id",ps:"build",p:"tickets",del:"CASCADE",nm:"fk_ticket_cfield_values_org_ticket"},
  {cs:"build",t:"ticket_label_mappings",col:"label_id",ps:"build",p:"ticket_labels",del:"CASCADE",nm:"fk_ticket_label_mappings_org_label"},
  {cs:"build",t:"ticket_label_mappings",col:"ticket_id",ps:"build",p:"tickets",del:"CASCADE",nm:"fk_ticket_label_mappings_org_ticket"},
  {cs:"build",t:"ticket_related_links",col:"ticket_id",ps:"build",p:"tickets",del:"CASCADE",nm:"fk_ticket_related_links_org_ticket"},
  {cs:"build",t:"ticket_watchers",col:"ticket_id",ps:"build",p:"tickets",del:"CASCADE",nm:"fk_ticket_watchers_org_ticket"},
  // tickets: cycle/module/project/sprint (recurrence_parent handled in 0938)
  {cs:"build",t:"tickets",col:"cycle_id",ps:"build",p:"cycles",del:"SET_NULL",nm:"fk_tickets_org_cycle"},
  {cs:"build",t:"tickets",col:"module_id",ps:"build",p:"modules",del:"SET_NULL",nm:"fk_tickets_org_module"},
  {cs:"build",t:"tickets",col:"project_id",ps:"build",p:"projects",del:"CASCADE",nm:"fk_tickets_org_project"},
  {cs:"build",t:"tickets",col:"sprint_id",ps:"build",p:"sprints",del:"SET_NULL",nm:"fk_tickets_org_sprint"},
  {cs:"build",t:"webhook_deliveries",col:"webhook_id",ps:"build",p:"project_webhooks",del:"CASCADE",nm:"fk_webhook_deliveries_org_webhook"},
  {cs:"build",t:"work_item_relations",col:"related_work_item_id",ps:"build",p:"tickets",del:"CASCADE",nm:"fk_work_item_relations_org_related"},
  {cs:"build",t:"work_item_relations",col:"work_item_id",ps:"build",p:"tickets",del:"CASCADE",nm:"fk_work_item_relations_org_item"},
  {cs:"build",t:"workflow_transitions",col:"from_status_id",ps:"build",p:"project_statuses",del:"CASCADE",nm:"fk_workflow_transitions_org_from_status"},
  {cs:"build",t:"workflow_transitions",col:"to_status_id",ps:"build",p:"project_statuses",del:"CASCADE",nm:"fk_workflow_transitions_org_to_status"},
  {cs:"build",t:"workflow_transitions",col:"project_id",ps:"build",p:"projects",del:"CASCADE",nm:"fk_workflow_transitions_org_project"},
  {cs:"build_events",t:"sprint_scope_events",col:"sprint_id",ps:"build",p:"sprints",del:"CASCADE",nm:"fk_sprint_scope_events_org_sprint"},
  {cs:"build_events",t:"sprint_scope_events",col:"ticket_id",ps:"build",p:"tickets",del:"CASCADE",nm:"fk_sprint_scope_events_org_ticket"},
  {cs:"build_events",t:"ticket_activity_log",col:"ticket_id",ps:"build",p:"tickets",del:"CASCADE",nm:"fk_ticket_activity_log_org_ticket"},
  {cs:"build_events",t:"ticket_comments",col:"ticket_id",ps:"build",p:"tickets",del:"CASCADE",nm:"fk_ticket_comments_org_ticket"},
];

function fkBlock(f) {
  const cs = f.cs === "public" ? "" : `${f.cs}.`;
  const ps = f.ps === "public" ? "" : `${f.ps}.`;
  const delClause = f.del === "CASCADE"
    ? "ON DELETE CASCADE"
    : `ON DELETE SET NULL (${f.col})`;
  return [
    `ALTER TABLE ${cs}${f.t}`,
    `  ADD CONSTRAINT ${f.nm}`,
    `  FOREIGN KEY (org_id, ${f.col})`,
    `  REFERENCES ${ps}${f.p} (org_id, id)`,
    `  ${delClause}`,
    `  NOT VALID;`,
    `--> statement-breakpoint`,
    `SET lock_timeout = '5s';`,
    `ALTER TABLE ${cs}${f.t} VALIDATE CONSTRAINT ${f.nm};`,
    `SET lock_timeout = DEFAULT;`,
  ].join("\n");
}

function migrationBody(items, label) {
  const blocks = items.map(fkBlock).join("\n--> statement-breakpoint\n");
  return `-- AR-02: composite tenant FKs — ${label}\n-- Add NOT VALID composite FKs then VALIDATE; keeps lock window minimal.\n-- CRM and Inventory are excluded from this migration by scope.\n\nSET lock_timeout = DEFAULT;\n\n${blocks}\n`;
}

const waves = [
  {tag:"0943",label:"bugs, change_requests, changelog_entries, comment_drafts, cycles, feedback, feedbucket, form_submissions, git", items:fks.slice(0,23)},
  {tag:"0944",label:"incident_updates, intake_items, managed_product_releases, meeting_*, modules, okr_*, pages", items:fks.slice(23,41)},
  {tag:"0945",label:"pm_workspace_memberships, portfolio_projects, program_projects, project_approvals..project_milestones", items:fks.slice(41,58)},
  {tag:"0946",label:"project_programs..projects, release_tickets, roadmap_*, sprints, test_*, ticket_checklists", items:fks.slice(58,94)},
  {tag:"0947",label:"ticket_comment_mentions..workflow_transitions, build_events.*", items:fks.slice(94)},
];

for (const w of waves) {
  console.log(`${w.tag}: ${w.items.length} FKs`);
}
console.log(`Total: ${fks.length}`);

// Generate DROP migration for 0948
function dropBlock(f) {
  const cs = f.cs === "public" ? "" : `${f.cs}.`;
  return `ALTER TABLE ${cs}${f.t} DROP CONSTRAINT IF EXISTS ${f.nm.replace("fk_","old_")}; -- noop if already dropped`;
}

// Actual old constraint names from the DB (from our query output)
const dropFks = [
  // 0943 group old constraint names
  {cs:"build",t:"bugs",nm:"bugs_affected_release_id_project_releases_id_fk"},
  {cs:"build",t:"bugs",nm:"bugs_fixed_release_id_project_releases_id_fk"},
  {cs:"build",t:"bugs",nm:"bugs_project_id_projects_id_fk"},
  {cs:"build",t:"bugs",nm:"bugs_linked_test_case_id_test_cases_id_fk"},
  {cs:"build",t:"bugs",nm:"bugs_linked_ticket_id_tickets_id_fk"},
  {cs:"build",t:"change_requests",nm:"change_requests_project_id_projects_id_fk"},
  {cs:"build",t:"changelog_entries",nm:"changelog_entries_linked_roadmap_item_id_roadmap_items_id_fk"},
  {cs:"build",t:"comment_drafts",nm:"comment_drafts_ticket_id_fkey"},
  {cs:"build",t:"cycles",nm:"cycles_project_id_projects_id_fk"},
  {cs:"build",t:"feedback_posts",nm:"feedback_posts_duplicate_of_id_feedback_posts_id_fk"},
  {cs:"build",t:"feedback_posts",nm:"feedback_posts_linked_roadmap_item_id_roadmap_items_id_fk"},
  {cs:"build",t:"feedback_votes",nm:"feedback_votes_feedback_post_id_feedback_posts_id_fk"},
  {cs:"build",t:"feedbucket_attachments",nm:"feedbucket_attachments_submission_id_feedbucket_submissions_id_"},
  {cs:"build",t:"feedbucket_submissions",nm:"feedbucket_submissions_widget_id_feedbucket_widgets_id_fk"},
  {cs:"build",t:"feedbucket_submissions",nm:"feedbucket_submissions_linked_ticket_id_tickets_id_fk"},
  {cs:"build",t:"feedbucket_widgets",nm:"fk_feedbucket_widgets_managed_product"},
  {cs:"build",t:"feedbucket_widgets",nm:"feedbucket_widgets_project_id_projects_id_fk"},
  {cs:"build",t:"form_submissions",nm:"form_submissions_form_id_project_forms_id_fk"},
  {cs:"build",t:"form_submissions",nm:"form_submissions_project_id_projects_id_fk"},
  {cs:"build",t:"form_submissions",nm:"form_submissions_converted_ticket_id_tickets_id_fk"},
  {cs:"build",t:"git_connections",nm:"git_connections_project_id_projects_id_fk"},
  {cs:"build",t:"git_ticket_links",nm:"git_ticket_links_connection_id_git_connections_id_fk"},
  {cs:"build",t:"git_ticket_links",nm:"git_ticket_links_ticket_id_tickets_id_fk"},
  // 0944 group
  {cs:"build",t:"incident_updates",nm:"incident_updates_incident_id_project_incidents_id_fk"},
  {cs:"build",t:"intake_items",nm:"intake_items_project_id_projects_id_fk"},
  {cs:"build",t:"intake_items",nm:"intake_items_linked_work_item_id_tickets_id_fk"},
  {cs:"build",t:"managed_product_releases",nm:"fk_managed_product_releases_product"},
  {cs:"build",t:"meeting_action_items",nm:"meeting_action_items_meeting_id_project_meetings_id_fk"},
  {cs:"build",t:"meeting_action_items",nm:"meeting_action_items_project_id_projects_id_fk"},
  {cs:"build",t:"meeting_action_items",nm:"meeting_action_items_converted_ticket_id_tickets_id_fk"},
  {cs:"build",t:"meeting_attendees",nm:"meeting_attendees_meeting_id_project_meetings_id_fk"},
  {cs:"build",t:"meeting_standup_entries",nm:"meeting_standup_entries_meeting_id_project_meetings_id_fk"},
  {cs:"build",t:"modules",nm:"modules_project_id_projects_id_fk"},
  {cs:"build",t:"okr_goals",nm:"okr_goals_project_id_projects_id_fk"},
  {cs:"build",t:"okr_key_results",nm:"okr_key_results_goal_id_okr_goals_id_fk"},
  {cs:"build",t:"okr_links",nm:"okr_links_goal_id_okr_goals_id_fk"},
  {cs:"build",t:"okr_links",nm:"okr_links_project_id_projects_id_fk"},
  {cs:"build",t:"okr_links",nm:"okr_links_ticket_id_tickets_id_fk"},
  {cs:"build",t:"okr_updates",nm:"okr_updates_goal_id_okr_goals_id_fk"},
  {cs:"build",t:"okr_updates",nm:"okr_updates_key_result_id_okr_key_results_id_fk"},
  {cs:"build",t:"pages",nm:"pages_project_id_projects_id_fk"},
  // 0945 group
  {cs:"build",t:"pm_workspace_memberships",nm:"pm_workspace_memberships_organization_membership_id_fkey"},
  {cs:"build",t:"portfolio_projects",nm:"portfolio_projects_portfolio_id_project_portfolios_id_fk"},
  {cs:"build",t:"portfolio_projects",nm:"portfolio_projects_project_id_projects_id_fk"},
  {cs:"build",t:"program_projects",nm:"program_projects_program_id_project_programs_id_fk"},
  {cs:"build",t:"program_projects",nm:"program_projects_project_id_projects_id_fk"},
  {cs:"build",t:"project_approvals",nm:"project_approvals_project_id_projects_id_fk"},
  {cs:"build",t:"project_automations",nm:"project_automations_project_id_projects_id_fk"},
  {cs:"build",t:"project_daily_snapshots",nm:"project_daily_snapshots_project_id_projects_id_fk"},
  {cs:"build",t:"project_decisions",nm:"project_decisions_project_id_projects_id_fk"},
  {cs:"build",t:"project_decisions",nm:"project_decisions_linked_ticket_id_tickets_id_fk"},
  {cs:"build",t:"project_forms",nm:"project_forms_project_id_projects_id_fk"},
  {cs:"build",t:"project_incidents",nm:"project_incidents_project_id_projects_id_fk"},
  {cs:"build",t:"project_incidents",nm:"project_incidents_linked_ticket_id_tickets_id_fk"},
  {cs:"build",t:"project_meetings",nm:"project_meetings_project_id_projects_id_fk"},
  {cs:"build",t:"project_meetings",nm:"project_meetings_sprint_id_sprints_id_fk"},
  {cs:"build",t:"project_members",nm:"project_members_project_id_projects_id_fk"},
  {cs:"build",t:"project_milestones",nm:"project_milestones_project_id_projects_id_fk"},
  // 0946 group
  {cs:"build",t:"project_programs",nm:"project_programs_portfolio_id_project_portfolios_id_fk"},
  {cs:"build",t:"project_releases",nm:"project_releases_project_id_projects_id_fk"},
  {cs:"build",t:"project_risks",nm:"project_risks_project_id_projects_id_fk"},
  {cs:"build",t:"project_risks",nm:"project_risks_linked_ticket_id_tickets_id_fk"},
  {cs:"build",t:"project_statuses",nm:"project_statuses_project_id_projects_id_fk"},
  {cs:"build",t:"project_team_assignments",nm:"project_team_assignments_team_id_fkey"},
  {cs:"build",t:"project_team_assignments",nm:"project_team_assignments_project_id_fkey"},
  {cs:"build",t:"project_team_members",nm:"project_team_members_team_id_fkey"},
  {cs:"build",t:"project_template_tickets",nm:"project_template_tickets_template_id_project_templates_id_fk"},
  {cs:"build",t:"project_views",nm:"project_views_project_id_projects_id_fk"},
  {cs:"build",t:"project_webhooks",nm:"project_webhooks_project_id_projects_id_fk"},
  {cs:"build",t:"project_whiteboard_shares",nm:"project_whiteboard_shares_whiteboard_id_project_whiteboards_id_"},
  {cs:"build",t:"project_whiteboards",nm:"project_whiteboards_project_id_projects_id_fk"},
  {cs:"build",t:"projects",nm:"fk_projects_managed_product"},
  {cs:"build",t:"release_tickets",nm:"release_tickets_release_id_project_releases_id_fk"},
  {cs:"build",t:"release_tickets",nm:"release_tickets_ticket_id_tickets_id_fk"},
  {cs:"build",t:"roadmap_items",nm:"roadmap_items_project_id_projects_id_fk"},
  {cs:"build",t:"roadmap_items",nm:"roadmap_items_epic_ticket_id_tickets_id_fk"},
  {cs:"build",t:"roadmap_votes",nm:"roadmap_votes_roadmap_item_id_roadmap_items_id_fk"},
  {cs:"build",t:"sprints",nm:"sprints_project_id_projects_id_fk"},
  {cs:"build",t:"test_cases",nm:"test_cases_project_id_projects_id_fk"},
  {cs:"build",t:"test_cases",nm:"test_cases_suite_id_test_suites_id_fk"},
  {cs:"build",t:"test_cases",nm:"test_cases_linked_ticket_id_tickets_id_fk"},
  {cs:"build",t:"test_run_results",nm:"test_run_results_linked_bug_id_bugs_id_fk"},
  {cs:"build",t:"test_run_results",nm:"test_run_results_project_id_projects_id_fk"},
  {cs:"build",t:"test_run_results",nm:"test_run_results_test_case_id_test_cases_id_fk"},
  {cs:"build",t:"test_run_results",nm:"test_run_results_run_id_test_runs_id_fk"},
  {cs:"build",t:"test_runs",nm:"test_runs_release_id_project_releases_id_fk"},
  {cs:"build",t:"test_runs",nm:"test_runs_project_id_projects_id_fk"},
  {cs:"build",t:"test_runs",nm:"test_runs_sprint_id_sprints_id_fk"},
  {cs:"build",t:"test_suites",nm:"test_suites_project_id_projects_id_fk"},
  {cs:"build",t:"test_suites",nm:"test_suites_parent_id_test_suites_id_fk"},
  {cs:"build",t:"ticket_assignees",nm:"ticket_assignees_ticket_id_tickets_id_fk"},
  {cs:"build",t:"ticket_attachments",nm:"ticket_attachments_ticket_id_tickets_id_fk"},
  {cs:"build",t:"ticket_checklist_items",nm:"ticket_checklist_items_checklist_id_ticket_checklists_id_fk"},
  {cs:"build",t:"ticket_checklists",nm:"ticket_checklists_ticket_id_tickets_id_fk"},
  // 0947 group
  {cs:"build",t:"ticket_comment_mentions",nm:"ticket_comment_mentions_comment_id_ticket_comments_id_fk"},
  {cs:"build",t:"ticket_comment_reactions",nm:"ticket_comment_reactions_comment_id_ticket_comments_id_fk"},
  {cs:"build",t:"ticket_custom_field_values",nm:"ticket_custom_field_values_field_definition_id_fkey"},
  {cs:"build",t:"ticket_custom_field_values",nm:"ticket_custom_field_values_ticket_id_fkey"},
  {cs:"build",t:"ticket_label_mappings",nm:"ticket_label_mappings_label_id_ticket_labels_id_fk"},
  {cs:"build",t:"ticket_label_mappings",nm:"ticket_label_mappings_ticket_id_tickets_id_fk"},
  {cs:"build",t:"ticket_related_links",nm:"ticket_related_links_ticket_id_tickets_id_fk"},
  {cs:"build",t:"ticket_watchers",nm:"ticket_watchers_ticket_id_tickets_id_fk"},
  {cs:"build",t:"tickets",nm:"tickets_cycle_id_cycles_id_fk"},
  {cs:"build",t:"tickets",nm:"tickets_module_id_modules_id_fk"},
  {cs:"build",t:"tickets",nm:"tickets_project_id_projects_id_fk"},
  {cs:"build",t:"tickets",nm:"tickets_sprint_id_sprints_id_fk"},
  {cs:"build",t:"tickets",nm:"fk_tickets_recurrence_parent"},
  {cs:"build",t:"webhook_deliveries",nm:"webhook_deliveries_webhook_id_project_webhooks_id_fk"},
  {cs:"build",t:"work_item_relations",nm:"work_item_relations_related_work_item_id_tickets_id_fk"},
  {cs:"build",t:"work_item_relations",nm:"work_item_relations_work_item_id_tickets_id_fk"},
  {cs:"build",t:"workflow_transitions",nm:"workflow_transitions_from_status_id_project_statuses_id_fk"},
  {cs:"build",t:"workflow_transitions",nm:"workflow_transitions_to_status_id_project_statuses_id_fk"},
  {cs:"build",t:"workflow_transitions",nm:"workflow_transitions_project_id_projects_id_fk"},
  {cs:"build_events",t:"sprint_scope_events",nm:"sprint_scope_events_sprint_id_sprints_id_fk"},
  {cs:"build_events",t:"sprint_scope_events",nm:"sprint_scope_events_ticket_id_tickets_id_fk"},
  {cs:"build_events",t:"ticket_activity_log",nm:"ticket_activity_log_ticket_id_tickets_id_fk"},
  {cs:"build_events",t:"ticket_comments",nm:"ticket_comments_ticket_id_tickets_id_fk"},
];

import { writeFileSync } from "fs";
import { resolve } from "path";

const migrDir = resolve(process.cwd(), "migrations");

for (const w of waves) {
  const body = migrationBody(w.items, w.label);
  const path = resolve(migrDir, `${w.tag}_ar02_build_composite_fks.sql`);
  writeFileSync(path, body);
  console.log(`Written: ${path} (${w.items.length} FKs, ${body.split("\n").length} lines)`);
}

// Drop migration
const dropLines = dropFks.map(f => {
  const cs = f.cs === "public" ? "" : `${f.cs}.`;
  return `ALTER TABLE ${cs}${f.t} DROP CONSTRAINT IF EXISTS "${f.nm}";`;
});
const dropBody = `-- AR-02: drop redundant single-column tenant FKs (build schema, waves 0943-0947)\n-- All are superseded by composite (org_id, col) constraints added in 0943-0947.\n-- CRM and Inventory are not touched.\n\nSET lock_timeout = '5s';\n\n${dropLines.join("\n--> statement-breakpoint\n")}\n\nSET lock_timeout = DEFAULT;\n`;
const dropPath = resolve(migrDir, "0948_ar02_drop_build_single_fks.sql");
writeFileSync(dropPath, dropBody);
console.log(`Written: ${dropPath} (${dropFks.length} DROPs, ${dropBody.split("\n").length} lines)`);
