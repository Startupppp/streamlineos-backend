-- 0374.down — Revert Build partial indexes to full indexes (drop WHERE deleted_at IS NULL)

SET statement_timeout = 0;

-- project_approvals
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_project_approvals_org_project_status";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_project_approvals_org_project_status" ON "project_approvals" ("org_id", "project_id", "status");

-- bugs
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_bugs_org_project_status";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_bugs_org_project_status" ON "bugs" ("org_id", "project_id", "status");

--> statement-breakpoint
DROP INDEX IF EXISTS "idx_bugs_org_project_severity";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_bugs_org_project_severity" ON "bugs" ("org_id", "project_id", "severity");

-- change_requests
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_change_requests_org_project_status";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_change_requests_org_project_status" ON "change_requests" ("org_id", "project_id", "status");

-- feedbucket_widgets
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_feedbucket_widgets_org";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_feedbucket_widgets_org" ON "feedbucket_widgets" ("org_id", "created_at");

-- feedbucket_submissions
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_feedbucket_submissions_widget";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_feedbucket_submissions_widget" ON "feedbucket_submissions" ("org_id", "widget_id", "status", "created_at");

--> statement-breakpoint
DROP INDEX IF EXISTS "idx_feedbucket_submissions_org_status";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_feedbucket_submissions_org_status" ON "feedbucket_submissions" ("org_id", "status", "created_at");

--> statement-breakpoint
DROP INDEX IF EXISTS "idx_feedbucket_submissions_assignee";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_feedbucket_submissions_assignee" ON "feedbucket_submissions" ("org_id", "assignee_id");

-- project_forms
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_project_forms_org_project";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_project_forms_org_project" ON "project_forms" ("org_id", "project_id");

-- project_risks
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_project_risks_org_project_status";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_project_risks_org_project_status" ON "project_risks" ("org_id", "project_id", "status");

-- project_decisions
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_project_decisions_org_project_status";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_project_decisions_org_project_status" ON "project_decisions" ("org_id", "project_id", "status");

-- project_incidents
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_project_incidents_org_project_status";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_project_incidents_org_project_status" ON "project_incidents" ("org_id", "project_id", "status");

-- managed_products
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_managed_products_org_status";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_managed_products_org_status" ON "managed_products" ("org_id", "status");

-- project_meetings
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_project_meetings_org_project_status";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_project_meetings_org_project_status" ON "project_meetings" ("org_id", "project_id", "status");

-- meeting_action_items
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_meeting_action_items_org_project_status";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_meeting_action_items_org_project_status" ON "meeting_action_items" ("org_id", "project_id", "status");

-- pm_workspaces
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_pm_workspaces_org";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pm_workspaces_org" ON "pm_workspaces" ("org_id");

-- project_portfolios
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_project_portfolios_org_status";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_project_portfolios_org_status" ON "project_portfolios" ("org_id", "status");

-- project_programs
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_project_programs_org_status";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_project_programs_org_status" ON "project_programs" ("org_id", "status");

-- test_suites
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_test_suites_org_project";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_test_suites_org_project" ON "test_suites" ("org_id", "project_id");

-- test_cases
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_test_cases_org_project_suite";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_test_cases_org_project_suite" ON "test_cases" ("org_id", "project_id", "suite_id");

-- test_runs
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_test_runs_org_project_status";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_test_runs_org_project_status" ON "test_runs" ("org_id", "project_id", "status");

-- project_teams
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_project_teams_org";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_project_teams_org" ON "project_teams" ("org_id");

-- workflow_transitions
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_workflow_transitions_org_project";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workflow_transitions_org_project" ON "workflow_transitions" ("org_id", "project_id");
