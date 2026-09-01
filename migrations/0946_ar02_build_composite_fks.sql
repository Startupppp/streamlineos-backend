-- AR-02: composite tenant FKs — project_programs..projects, release_tickets, roadmap_*, sprints, test_*, ticket_checklists
-- Add NOT VALID composite FKs then VALIDATE; keeps lock window minimal.
-- CRM and Inventory are excluded from this migration by scope.

SET lock_timeout = DEFAULT;

ALTER TABLE build.project_programs
  ADD CONSTRAINT fk_project_programs_org_portfolio
  FOREIGN KEY (org_id, portfolio_id)
  REFERENCES build.project_portfolios (org_id, id)
  ON DELETE SET NULL (portfolio_id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.project_programs VALIDATE CONSTRAINT fk_project_programs_org_portfolio;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.project_releases
  ADD CONSTRAINT fk_project_releases_org_project
  FOREIGN KEY (org_id, project_id)
  REFERENCES build.projects (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.project_releases VALIDATE CONSTRAINT fk_project_releases_org_project;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.project_risks
  ADD CONSTRAINT fk_project_risks_org_project
  FOREIGN KEY (org_id, project_id)
  REFERENCES build.projects (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.project_risks VALIDATE CONSTRAINT fk_project_risks_org_project;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.project_risks
  ADD CONSTRAINT fk_project_risks_org_ticket
  FOREIGN KEY (org_id, linked_ticket_id)
  REFERENCES build.tickets (org_id, id)
  ON DELETE SET NULL (linked_ticket_id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.project_risks VALIDATE CONSTRAINT fk_project_risks_org_ticket;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.project_statuses
  ADD CONSTRAINT fk_project_statuses_org_project
  FOREIGN KEY (org_id, project_id)
  REFERENCES build.projects (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.project_statuses VALIDATE CONSTRAINT fk_project_statuses_org_project;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.project_team_assignments
  ADD CONSTRAINT fk_project_team_assignments_org_team
  FOREIGN KEY (org_id, team_id)
  REFERENCES build.project_teams (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.project_team_assignments VALIDATE CONSTRAINT fk_project_team_assignments_org_team;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.project_team_assignments
  ADD CONSTRAINT fk_project_team_assignments_org_project
  FOREIGN KEY (org_id, project_id)
  REFERENCES build.projects (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.project_team_assignments VALIDATE CONSTRAINT fk_project_team_assignments_org_project;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.project_team_members
  ADD CONSTRAINT fk_project_team_members_org_team
  FOREIGN KEY (org_id, team_id)
  REFERENCES build.project_teams (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.project_team_members VALIDATE CONSTRAINT fk_project_team_members_org_team;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.project_template_tickets
  ADD CONSTRAINT fk_project_template_tickets_org_template
  FOREIGN KEY (org_id, template_id)
  REFERENCES build.project_templates (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.project_template_tickets VALIDATE CONSTRAINT fk_project_template_tickets_org_template;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.project_views
  ADD CONSTRAINT fk_project_views_org_project
  FOREIGN KEY (org_id, project_id)
  REFERENCES build.projects (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.project_views VALIDATE CONSTRAINT fk_project_views_org_project;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.project_webhooks
  ADD CONSTRAINT fk_project_webhooks_org_project
  FOREIGN KEY (org_id, project_id)
  REFERENCES build.projects (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.project_webhooks VALIDATE CONSTRAINT fk_project_webhooks_org_project;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.project_whiteboard_shares
  ADD CONSTRAINT fk_project_whiteboard_shares_org_board
  FOREIGN KEY (org_id, whiteboard_id)
  REFERENCES build.project_whiteboards (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.project_whiteboard_shares VALIDATE CONSTRAINT fk_project_whiteboard_shares_org_board;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.project_whiteboards
  ADD CONSTRAINT fk_project_whiteboards_org_project
  FOREIGN KEY (org_id, project_id)
  REFERENCES build.projects (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.project_whiteboards VALIDATE CONSTRAINT fk_project_whiteboards_org_project;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.projects
  ADD CONSTRAINT fk_projects_org_product
  FOREIGN KEY (org_id, managed_product_id)
  REFERENCES build.managed_products (org_id, id)
  ON DELETE SET NULL (managed_product_id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.projects VALIDATE CONSTRAINT fk_projects_org_product;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.release_tickets
  ADD CONSTRAINT fk_release_tickets_org_release
  FOREIGN KEY (org_id, release_id)
  REFERENCES build.project_releases (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.release_tickets VALIDATE CONSTRAINT fk_release_tickets_org_release;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.release_tickets
  ADD CONSTRAINT fk_release_tickets_org_ticket
  FOREIGN KEY (org_id, ticket_id)
  REFERENCES build.tickets (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.release_tickets VALIDATE CONSTRAINT fk_release_tickets_org_ticket;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.roadmap_items
  ADD CONSTRAINT fk_roadmap_items_org_project
  FOREIGN KEY (org_id, project_id)
  REFERENCES build.projects (org_id, id)
  ON DELETE SET NULL (project_id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.roadmap_items VALIDATE CONSTRAINT fk_roadmap_items_org_project;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.roadmap_items
  ADD CONSTRAINT fk_roadmap_items_org_ticket
  FOREIGN KEY (org_id, epic_ticket_id)
  REFERENCES build.tickets (org_id, id)
  ON DELETE SET NULL (epic_ticket_id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.roadmap_items VALIDATE CONSTRAINT fk_roadmap_items_org_ticket;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.roadmap_votes
  ADD CONSTRAINT fk_roadmap_votes_org_roadmap
  FOREIGN KEY (org_id, roadmap_item_id)
  REFERENCES build.roadmap_items (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.roadmap_votes VALIDATE CONSTRAINT fk_roadmap_votes_org_roadmap;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.sprints
  ADD CONSTRAINT fk_sprints_org_project
  FOREIGN KEY (org_id, project_id)
  REFERENCES build.projects (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.sprints VALIDATE CONSTRAINT fk_sprints_org_project;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.test_cases
  ADD CONSTRAINT fk_test_cases_org_project
  FOREIGN KEY (org_id, project_id)
  REFERENCES build.projects (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.test_cases VALIDATE CONSTRAINT fk_test_cases_org_project;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.test_cases
  ADD CONSTRAINT fk_test_cases_org_suite
  FOREIGN KEY (org_id, suite_id)
  REFERENCES build.test_suites (org_id, id)
  ON DELETE SET NULL (suite_id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.test_cases VALIDATE CONSTRAINT fk_test_cases_org_suite;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.test_cases
  ADD CONSTRAINT fk_test_cases_org_ticket
  FOREIGN KEY (org_id, linked_ticket_id)
  REFERENCES build.tickets (org_id, id)
  ON DELETE SET NULL (linked_ticket_id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.test_cases VALIDATE CONSTRAINT fk_test_cases_org_ticket;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.test_run_results
  ADD CONSTRAINT fk_test_run_results_org_bug
  FOREIGN KEY (org_id, linked_bug_id)
  REFERENCES build.bugs (org_id, id)
  ON DELETE SET NULL (linked_bug_id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.test_run_results VALIDATE CONSTRAINT fk_test_run_results_org_bug;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.test_run_results
  ADD CONSTRAINT fk_test_run_results_org_project
  FOREIGN KEY (org_id, project_id)
  REFERENCES build.projects (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.test_run_results VALIDATE CONSTRAINT fk_test_run_results_org_project;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.test_run_results
  ADD CONSTRAINT fk_test_run_results_org_case
  FOREIGN KEY (org_id, test_case_id)
  REFERENCES build.test_cases (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.test_run_results VALIDATE CONSTRAINT fk_test_run_results_org_case;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.test_run_results
  ADD CONSTRAINT fk_test_run_results_org_run
  FOREIGN KEY (org_id, run_id)
  REFERENCES build.test_runs (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.test_run_results VALIDATE CONSTRAINT fk_test_run_results_org_run;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.test_runs
  ADD CONSTRAINT fk_test_runs_org_release
  FOREIGN KEY (org_id, release_id)
  REFERENCES build.project_releases (org_id, id)
  ON DELETE SET NULL (release_id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.test_runs VALIDATE CONSTRAINT fk_test_runs_org_release;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.test_runs
  ADD CONSTRAINT fk_test_runs_org_project
  FOREIGN KEY (org_id, project_id)
  REFERENCES build.projects (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.test_runs VALIDATE CONSTRAINT fk_test_runs_org_project;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.test_runs
  ADD CONSTRAINT fk_test_runs_org_sprint
  FOREIGN KEY (org_id, sprint_id)
  REFERENCES build.sprints (org_id, id)
  ON DELETE SET NULL (sprint_id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.test_runs VALIDATE CONSTRAINT fk_test_runs_org_sprint;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.test_suites
  ADD CONSTRAINT fk_test_suites_org_project
  FOREIGN KEY (org_id, project_id)
  REFERENCES build.projects (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.test_suites VALIDATE CONSTRAINT fk_test_suites_org_project;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.test_suites
  ADD CONSTRAINT fk_test_suites_org_parent
  FOREIGN KEY (org_id, parent_id)
  REFERENCES build.test_suites (org_id, id)
  ON DELETE SET NULL (parent_id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.test_suites VALIDATE CONSTRAINT fk_test_suites_org_parent;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.ticket_assignees
  ADD CONSTRAINT fk_ticket_assignees_org_ticket
  FOREIGN KEY (org_id, ticket_id)
  REFERENCES build.tickets (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.ticket_assignees VALIDATE CONSTRAINT fk_ticket_assignees_org_ticket;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.ticket_attachments
  ADD CONSTRAINT fk_ticket_attachments_org_ticket
  FOREIGN KEY (org_id, ticket_id)
  REFERENCES build.tickets (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.ticket_attachments VALIDATE CONSTRAINT fk_ticket_attachments_org_ticket;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.ticket_checklist_items
  ADD CONSTRAINT fk_ticket_checklist_items_org_checklist
  FOREIGN KEY (org_id, checklist_id)
  REFERENCES build.ticket_checklists (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.ticket_checklist_items VALIDATE CONSTRAINT fk_ticket_checklist_items_org_checklist;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.ticket_checklists
  ADD CONSTRAINT fk_ticket_checklists_org_ticket
  FOREIGN KEY (org_id, ticket_id)
  REFERENCES build.tickets (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.ticket_checklists VALIDATE CONSTRAINT fk_ticket_checklists_org_ticket;
SET lock_timeout = DEFAULT;
