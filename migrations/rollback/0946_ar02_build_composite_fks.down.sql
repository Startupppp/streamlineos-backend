-- 0946_ar02_build_composite_fks DOWN — drops every constraint and index the up migration added.

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE build.ticket_checklists DROP CONSTRAINT IF EXISTS "fk_ticket_checklists_org_ticket";
--> statement-breakpoint
ALTER TABLE build.ticket_checklist_items DROP CONSTRAINT IF EXISTS "fk_ticket_checklist_items_org_checklist";
--> statement-breakpoint
ALTER TABLE build.ticket_attachments DROP CONSTRAINT IF EXISTS "fk_ticket_attachments_org_ticket";
--> statement-breakpoint
ALTER TABLE build.ticket_assignees DROP CONSTRAINT IF EXISTS "fk_ticket_assignees_org_ticket";
--> statement-breakpoint
ALTER TABLE build.test_suites DROP CONSTRAINT IF EXISTS "fk_test_suites_org_parent";
--> statement-breakpoint
ALTER TABLE build.test_suites DROP CONSTRAINT IF EXISTS "fk_test_suites_org_project";
--> statement-breakpoint
ALTER TABLE build.test_runs DROP CONSTRAINT IF EXISTS "fk_test_runs_org_sprint";
--> statement-breakpoint
ALTER TABLE build.test_runs DROP CONSTRAINT IF EXISTS "fk_test_runs_org_project";
--> statement-breakpoint
ALTER TABLE build.test_runs DROP CONSTRAINT IF EXISTS "fk_test_runs_org_release";
--> statement-breakpoint
ALTER TABLE build.test_run_results DROP CONSTRAINT IF EXISTS "fk_test_run_results_org_run";
--> statement-breakpoint
ALTER TABLE build.test_run_results DROP CONSTRAINT IF EXISTS "fk_test_run_results_org_case";
--> statement-breakpoint
ALTER TABLE build.test_run_results DROP CONSTRAINT IF EXISTS "fk_test_run_results_org_project";
--> statement-breakpoint
ALTER TABLE build.test_run_results DROP CONSTRAINT IF EXISTS "fk_test_run_results_org_bug";
--> statement-breakpoint
ALTER TABLE build.test_cases DROP CONSTRAINT IF EXISTS "fk_test_cases_org_ticket";
--> statement-breakpoint
ALTER TABLE build.test_cases DROP CONSTRAINT IF EXISTS "fk_test_cases_org_suite";
--> statement-breakpoint
ALTER TABLE build.test_cases DROP CONSTRAINT IF EXISTS "fk_test_cases_org_project";
--> statement-breakpoint
ALTER TABLE build.sprints DROP CONSTRAINT IF EXISTS "fk_sprints_org_project";
--> statement-breakpoint
ALTER TABLE build.roadmap_votes DROP CONSTRAINT IF EXISTS "fk_roadmap_votes_org_roadmap";
--> statement-breakpoint
ALTER TABLE build.roadmap_items DROP CONSTRAINT IF EXISTS "fk_roadmap_items_org_ticket";
--> statement-breakpoint
ALTER TABLE build.roadmap_items DROP CONSTRAINT IF EXISTS "fk_roadmap_items_org_project";
--> statement-breakpoint
ALTER TABLE build.release_tickets DROP CONSTRAINT IF EXISTS "fk_release_tickets_org_ticket";
--> statement-breakpoint
ALTER TABLE build.release_tickets DROP CONSTRAINT IF EXISTS "fk_release_tickets_org_release";
--> statement-breakpoint
ALTER TABLE build.projects DROP CONSTRAINT IF EXISTS "fk_projects_org_product";
--> statement-breakpoint
ALTER TABLE build.project_whiteboards DROP CONSTRAINT IF EXISTS "fk_project_whiteboards_org_project";
--> statement-breakpoint
ALTER TABLE build.project_whiteboard_shares DROP CONSTRAINT IF EXISTS "fk_project_whiteboard_shares_org_board";
--> statement-breakpoint
ALTER TABLE build.project_webhooks DROP CONSTRAINT IF EXISTS "fk_project_webhooks_org_project";
--> statement-breakpoint
ALTER TABLE build.project_views DROP CONSTRAINT IF EXISTS "fk_project_views_org_project";
--> statement-breakpoint
ALTER TABLE build.project_template_tickets DROP CONSTRAINT IF EXISTS "fk_project_template_tickets_org_template";
--> statement-breakpoint
ALTER TABLE build.project_team_members DROP CONSTRAINT IF EXISTS "fk_project_team_members_org_team";
--> statement-breakpoint
ALTER TABLE build.project_team_assignments DROP CONSTRAINT IF EXISTS "fk_project_team_assignments_org_project";
--> statement-breakpoint
ALTER TABLE build.project_team_assignments DROP CONSTRAINT IF EXISTS "fk_project_team_assignments_org_team";
--> statement-breakpoint
ALTER TABLE build.project_statuses DROP CONSTRAINT IF EXISTS "fk_project_statuses_org_project";
--> statement-breakpoint
ALTER TABLE build.project_risks DROP CONSTRAINT IF EXISTS "fk_project_risks_org_ticket";
--> statement-breakpoint
ALTER TABLE build.project_risks DROP CONSTRAINT IF EXISTS "fk_project_risks_org_project";
--> statement-breakpoint
ALTER TABLE build.project_releases DROP CONSTRAINT IF EXISTS "fk_project_releases_org_project";
--> statement-breakpoint
ALTER TABLE build.project_programs DROP CONSTRAINT IF EXISTS "fk_project_programs_org_portfolio";
