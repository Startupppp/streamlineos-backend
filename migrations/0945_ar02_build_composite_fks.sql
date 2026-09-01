-- AR-02: composite tenant FKs — pm_workspace_memberships, portfolio_projects, program_projects, project_approvals..project_milestones
-- Add NOT VALID composite FKs then VALIDATE; keeps lock window minimal.
-- CRM and Inventory are excluded from this migration by scope.

SET lock_timeout = DEFAULT;

ALTER TABLE build.pm_workspace_memberships
  ADD CONSTRAINT fk_pm_memberships_org_member
  FOREIGN KEY (org_id, organization_membership_id)
  REFERENCES organization_members (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.pm_workspace_memberships VALIDATE CONSTRAINT fk_pm_memberships_org_member;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.portfolio_projects
  ADD CONSTRAINT fk_portfolio_projects_org_portfolio
  FOREIGN KEY (org_id, portfolio_id)
  REFERENCES build.project_portfolios (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.portfolio_projects VALIDATE CONSTRAINT fk_portfolio_projects_org_portfolio;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.portfolio_projects
  ADD CONSTRAINT fk_portfolio_projects_org_project
  FOREIGN KEY (org_id, project_id)
  REFERENCES build.projects (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.portfolio_projects VALIDATE CONSTRAINT fk_portfolio_projects_org_project;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.program_projects
  ADD CONSTRAINT fk_program_projects_org_program
  FOREIGN KEY (org_id, program_id)
  REFERENCES build.project_programs (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.program_projects VALIDATE CONSTRAINT fk_program_projects_org_program;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.program_projects
  ADD CONSTRAINT fk_program_projects_org_project
  FOREIGN KEY (org_id, project_id)
  REFERENCES build.projects (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.program_projects VALIDATE CONSTRAINT fk_program_projects_org_project;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.project_approvals
  ADD CONSTRAINT fk_project_approvals_org_project
  FOREIGN KEY (org_id, project_id)
  REFERENCES build.projects (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.project_approvals VALIDATE CONSTRAINT fk_project_approvals_org_project;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.project_automations
  ADD CONSTRAINT fk_project_automations_org_project
  FOREIGN KEY (org_id, project_id)
  REFERENCES build.projects (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.project_automations VALIDATE CONSTRAINT fk_project_automations_org_project;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.project_daily_snapshots
  ADD CONSTRAINT fk_project_daily_snapshots_org_project
  FOREIGN KEY (org_id, project_id)
  REFERENCES build.projects (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.project_daily_snapshots VALIDATE CONSTRAINT fk_project_daily_snapshots_org_project;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.project_decisions
  ADD CONSTRAINT fk_project_decisions_org_project
  FOREIGN KEY (org_id, project_id)
  REFERENCES build.projects (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.project_decisions VALIDATE CONSTRAINT fk_project_decisions_org_project;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.project_decisions
  ADD CONSTRAINT fk_project_decisions_org_ticket
  FOREIGN KEY (org_id, linked_ticket_id)
  REFERENCES build.tickets (org_id, id)
  ON DELETE SET NULL (linked_ticket_id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.project_decisions VALIDATE CONSTRAINT fk_project_decisions_org_ticket;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.project_forms
  ADD CONSTRAINT fk_project_forms_org_project
  FOREIGN KEY (org_id, project_id)
  REFERENCES build.projects (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.project_forms VALIDATE CONSTRAINT fk_project_forms_org_project;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.project_incidents
  ADD CONSTRAINT fk_project_incidents_org_project
  FOREIGN KEY (org_id, project_id)
  REFERENCES build.projects (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.project_incidents VALIDATE CONSTRAINT fk_project_incidents_org_project;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.project_incidents
  ADD CONSTRAINT fk_project_incidents_org_ticket
  FOREIGN KEY (org_id, linked_ticket_id)
  REFERENCES build.tickets (org_id, id)
  ON DELETE SET NULL (linked_ticket_id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.project_incidents VALIDATE CONSTRAINT fk_project_incidents_org_ticket;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.project_meetings
  ADD CONSTRAINT fk_project_meetings_org_project
  FOREIGN KEY (org_id, project_id)
  REFERENCES build.projects (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.project_meetings VALIDATE CONSTRAINT fk_project_meetings_org_project;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.project_meetings
  ADD CONSTRAINT fk_project_meetings_org_sprint
  FOREIGN KEY (org_id, sprint_id)
  REFERENCES build.sprints (org_id, id)
  ON DELETE SET NULL (sprint_id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.project_meetings VALIDATE CONSTRAINT fk_project_meetings_org_sprint;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.project_members
  ADD CONSTRAINT fk_project_members_org_project
  FOREIGN KEY (org_id, project_id)
  REFERENCES build.projects (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.project_members VALIDATE CONSTRAINT fk_project_members_org_project;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE build.project_milestones
  ADD CONSTRAINT fk_project_milestones_org_project
  FOREIGN KEY (org_id, project_id)
  REFERENCES build.projects (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE build.project_milestones VALIDATE CONSTRAINT fk_project_milestones_org_project;
SET lock_timeout = DEFAULT;
