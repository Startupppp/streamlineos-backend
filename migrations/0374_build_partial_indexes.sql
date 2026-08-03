-- 0374 — Build: Convert full indexes to partial indexes (WHERE deleted_at IS NULL)
--
-- Rationale: ~20 Build tables carry a deleted_at soft-delete column. Their primary
-- list-serving indexes (leading with org_id) were built over ALL rows, including
-- deleted ones. Every list query that already filters `WHERE deleted_at IS NULL`
-- (66 confirmed call-sites in src/modules/build/) was paying to scan dead entries.
-- Converting to partial indexes shrinks each index to live rows only, reducing
-- index size and making list scans faster with no change to query semantics.
--
-- Only non-unique indexes leading with org_id are converted. Point-lookup indexes
-- (assignee, owner, parent, sprint, release, FK-only) are left alone — partial
-- predicates buy nothing for single-record fetches and could hurt reverse lookups.
-- Unique/uniqueIndex constraints are never touched — partial uniqueness changes
-- uniqueness semantics and those constraints serve as composite-FK targets.
--
-- NOTE ON CONCURRENCY: On a large production table, CREATE INDEX should be run as
-- CREATE INDEX CONCURRENTLY so it does not take a ShareLock. CONCURRENTLY cannot
-- run inside a transaction block, so it must be executed outside a transaction.
-- The statements below do NOT use CONCURRENTLY so that they can run inside the
-- standard migration transaction. On a live production database with large tables,
-- run each pair (DROP + CREATE) manually outside a transaction with CONCURRENTLY
-- before applying the migration, then the migration will be a no-op (IF NOT EXISTS /
-- IF EXISTS guards make it idempotent).

SET statement_timeout = 0;

-- project_approvals
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_project_approvals_org_project_status";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_project_approvals_org_project_status" ON "project_approvals" ("org_id", "project_id", "status") WHERE deleted_at IS NULL;

-- bugs (two list-serving indexes)
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_bugs_org_project_status";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_bugs_org_project_status" ON "bugs" ("org_id", "project_id", "status") WHERE deleted_at IS NULL;

--> statement-breakpoint
DROP INDEX IF EXISTS "idx_bugs_org_project_severity";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_bugs_org_project_severity" ON "bugs" ("org_id", "project_id", "severity") WHERE deleted_at IS NULL;

-- change_requests
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_change_requests_org_project_status";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_change_requests_org_project_status" ON "change_requests" ("org_id", "project_id", "status") WHERE deleted_at IS NULL;

-- feedbucket_widgets
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_feedbucket_widgets_org";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_feedbucket_widgets_org" ON "feedbucket_widgets" ("org_id", "created_at") WHERE deleted_at IS NULL;

-- feedbucket_submissions (three list-serving indexes)
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_feedbucket_submissions_widget";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_feedbucket_submissions_widget" ON "feedbucket_submissions" ("org_id", "widget_id", "status", "created_at") WHERE deleted_at IS NULL;

--> statement-breakpoint
DROP INDEX IF EXISTS "idx_feedbucket_submissions_org_status";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_feedbucket_submissions_org_status" ON "feedbucket_submissions" ("org_id", "status", "created_at") WHERE deleted_at IS NULL;

--> statement-breakpoint
DROP INDEX IF EXISTS "idx_feedbucket_submissions_assignee";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_feedbucket_submissions_assignee" ON "feedbucket_submissions" ("org_id", "assignee_id") WHERE deleted_at IS NULL;

-- project_forms
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_project_forms_org_project";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_project_forms_org_project" ON "project_forms" ("org_id", "project_id") WHERE deleted_at IS NULL;

-- project_risks
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_project_risks_org_project_status";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_project_risks_org_project_status" ON "project_risks" ("org_id", "project_id", "status") WHERE deleted_at IS NULL;

-- project_decisions
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_project_decisions_org_project_status";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_project_decisions_org_project_status" ON "project_decisions" ("org_id", "project_id", "status") WHERE deleted_at IS NULL;

-- project_incidents
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_project_incidents_org_project_status";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_project_incidents_org_project_status" ON "project_incidents" ("org_id", "project_id", "status") WHERE deleted_at IS NULL;

-- managed_products
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_managed_products_org_status";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_managed_products_org_status" ON "managed_products" ("org_id", "status") WHERE deleted_at IS NULL;

-- project_meetings
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_project_meetings_org_project_status";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_project_meetings_org_project_status" ON "project_meetings" ("org_id", "project_id", "status") WHERE deleted_at IS NULL;

-- meeting_action_items
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_meeting_action_items_org_project_status";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_meeting_action_items_org_project_status" ON "meeting_action_items" ("org_id", "project_id", "status") WHERE deleted_at IS NULL;

-- pm_workspaces
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_pm_workspaces_org";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pm_workspaces_org" ON "pm_workspaces" ("org_id") WHERE deleted_at IS NULL;

-- project_portfolios
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_project_portfolios_org_status";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_project_portfolios_org_status" ON "project_portfolios" ("org_id", "status") WHERE deleted_at IS NULL;

-- project_programs
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_project_programs_org_status";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_project_programs_org_status" ON "project_programs" ("org_id", "status") WHERE deleted_at IS NULL;

-- test_suites
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_test_suites_org_project";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_test_suites_org_project" ON "test_suites" ("org_id", "project_id") WHERE deleted_at IS NULL;

-- test_cases
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_test_cases_org_project_suite";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_test_cases_org_project_suite" ON "test_cases" ("org_id", "project_id", "suite_id") WHERE deleted_at IS NULL;

-- test_runs
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_test_runs_org_project_status";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_test_runs_org_project_status" ON "test_runs" ("org_id", "project_id", "status") WHERE deleted_at IS NULL;

-- project_teams
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_project_teams_org";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_project_teams_org" ON "project_teams" ("org_id") WHERE deleted_at IS NULL;

-- workflow_transitions
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_workflow_transitions_org_project";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workflow_transitions_org_project" ON "workflow_transitions" ("org_id", "project_id") WHERE deleted_at IS NULL;
