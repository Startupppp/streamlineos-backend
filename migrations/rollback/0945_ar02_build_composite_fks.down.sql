-- 0945_ar02_build_composite_fks DOWN — drops every constraint and index the up migration added.

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE build.project_milestones DROP CONSTRAINT IF EXISTS "fk_project_milestones_org_project";
--> statement-breakpoint
ALTER TABLE build.project_members DROP CONSTRAINT IF EXISTS "fk_project_members_org_project";
--> statement-breakpoint
ALTER TABLE build.project_meetings DROP CONSTRAINT IF EXISTS "fk_project_meetings_org_sprint";
--> statement-breakpoint
ALTER TABLE build.project_meetings DROP CONSTRAINT IF EXISTS "fk_project_meetings_org_project";
--> statement-breakpoint
ALTER TABLE build.project_incidents DROP CONSTRAINT IF EXISTS "fk_project_incidents_org_ticket";
--> statement-breakpoint
ALTER TABLE build.project_incidents DROP CONSTRAINT IF EXISTS "fk_project_incidents_org_project";
--> statement-breakpoint
ALTER TABLE build.project_forms DROP CONSTRAINT IF EXISTS "fk_project_forms_org_project";
--> statement-breakpoint
ALTER TABLE build.project_decisions DROP CONSTRAINT IF EXISTS "fk_project_decisions_org_ticket";
--> statement-breakpoint
ALTER TABLE build.project_decisions DROP CONSTRAINT IF EXISTS "fk_project_decisions_org_project";
--> statement-breakpoint
ALTER TABLE build.project_daily_snapshots DROP CONSTRAINT IF EXISTS "fk_project_daily_snapshots_org_project";
--> statement-breakpoint
ALTER TABLE build.project_automations DROP CONSTRAINT IF EXISTS "fk_project_automations_org_project";
--> statement-breakpoint
ALTER TABLE build.project_approvals DROP CONSTRAINT IF EXISTS "fk_project_approvals_org_project";
--> statement-breakpoint
ALTER TABLE build.program_projects DROP CONSTRAINT IF EXISTS "fk_program_projects_org_project";
--> statement-breakpoint
ALTER TABLE build.program_projects DROP CONSTRAINT IF EXISTS "fk_program_projects_org_program";
--> statement-breakpoint
ALTER TABLE build.portfolio_projects DROP CONSTRAINT IF EXISTS "fk_portfolio_projects_org_project";
--> statement-breakpoint
ALTER TABLE build.portfolio_projects DROP CONSTRAINT IF EXISTS "fk_portfolio_projects_org_portfolio";
--> statement-breakpoint
ALTER TABLE build.pm_workspace_memberships DROP CONSTRAINT IF EXISTS "fk_pm_memberships_org_member";
