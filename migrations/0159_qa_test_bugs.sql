-- 0159_qa_test_bugs.sql
-- QA / Test-management + Bugs engine schema.
-- Hand-authored; NOT applied by this session. Apply via psql or db:migrate in a TTY.
-- Renumbered from 0156 to 0159 to avoid collision with sibling-session migrations
-- (0156_timesheets_standalone.sql, 0156_inventory_expansion.sql).

DO $$ BEGIN CREATE TYPE "public"."test_case_priority" AS ENUM('low','medium','high'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "public"."test_case_automation_status" AS ENUM('manual','automated','planned'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "public"."test_run_status" AS ENUM('not_started','in_progress','completed','aborted'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "public"."test_result_status" AS ENUM('not_run','passed','failed','blocked','skipped'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "public"."bug_severity" AS ENUM('blocker','critical','major','minor','trivial'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "public"."bug_priority" AS ENUM('low','medium','high','urgent'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "public"."bug_status" AS ENUM('new','triaged','assigned','in_progress','fixed','ready_for_qa','verified','reopened','closed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "test_suites" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "project_id" integer NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "description" text,
  "parent_id" integer REFERENCES "test_suites"("id") ON DELETE SET NULL,
  "position" integer DEFAULT 0 NOT NULL,
  "created_by" text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  "deleted_at" timestamp
);
CREATE INDEX IF NOT EXISTS "idx_test_suites_org_project" ON "test_suites" ("org_id", "project_id");
CREATE INDEX IF NOT EXISTS "idx_test_suites_parent" ON "test_suites" ("parent_id");

CREATE TABLE IF NOT EXISTS "test_cases" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "project_id" integer NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "suite_id" integer REFERENCES "test_suites"("id") ON DELETE SET NULL,
  "case_number" integer NOT NULL,
  "title" text NOT NULL,
  "preconditions" text,
  "steps" jsonb DEFAULT '[]'::jsonb,
  "expected_result" text,
  "priority" "test_case_priority" DEFAULT 'medium' NOT NULL,
  "component" text,
  "linked_ticket_id" integer REFERENCES "tickets"("id") ON DELETE SET NULL,
  "automation_status" "test_case_automation_status" DEFAULT 'manual' NOT NULL,
  "created_by" text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  "deleted_at" timestamp
);
CREATE INDEX IF NOT EXISTS "idx_test_cases_org_project_suite" ON "test_cases" ("org_id", "project_id", "suite_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_test_cases_project_number" ON "test_cases" ("project_id", "case_number");

CREATE TABLE IF NOT EXISTS "test_runs" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "project_id" integer NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "run_number" integer NOT NULL,
  "name" text NOT NULL,
  "sprint_id" integer REFERENCES "sprints"("id") ON DELETE SET NULL,
  "release_id" integer REFERENCES "project_releases"("id") ON DELETE SET NULL,
  "environment" text,
  "browser_device" text,
  "tester_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "status" "test_run_status" DEFAULT 'not_started' NOT NULL,
  "started_at" timestamp,
  "completed_at" timestamp,
  "created_by" text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  "deleted_at" timestamp
);
CREATE INDEX IF NOT EXISTS "idx_test_runs_org_project_status" ON "test_runs" ("org_id", "project_id", "status");
CREATE INDEX IF NOT EXISTS "idx_test_runs_sprint" ON "test_runs" ("sprint_id");
CREATE INDEX IF NOT EXISTS "idx_test_runs_release" ON "test_runs" ("release_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_test_runs_project_number" ON "test_runs" ("project_id", "run_number");

CREATE TABLE IF NOT EXISTS "bugs" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "project_id" integer NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "bug_number" integer NOT NULL,
  "title" text NOT NULL,
  "description" text,
  "severity" "bug_severity" DEFAULT 'major' NOT NULL,
  "priority" "bug_priority" DEFAULT 'medium' NOT NULL,
  "status" "bug_status" DEFAULT 'new' NOT NULL,
  "steps_to_reproduce" text,
  "expected_result" text,
  "actual_result" text,
  "environment" text,
  "browser_device" text,
  "affected_release_id" integer REFERENCES "project_releases"("id") ON DELETE SET NULL,
  "fixed_release_id" integer REFERENCES "project_releases"("id") ON DELETE SET NULL,
  "assignee_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "reporter_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "qa_owner_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "reopen_count" integer DEFAULT 0 NOT NULL,
  "linked_ticket_id" integer REFERENCES "tickets"("id") ON DELETE SET NULL,
  "linked_test_case_id" integer REFERENCES "test_cases"("id") ON DELETE SET NULL,
  "created_by" text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  "deleted_at" timestamp
);
CREATE INDEX IF NOT EXISTS "idx_bugs_org_project_status" ON "bugs" ("org_id", "project_id", "status");
CREATE INDEX IF NOT EXISTS "idx_bugs_org_project_severity" ON "bugs" ("org_id", "project_id", "severity");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_bugs_project_number" ON "bugs" ("project_id", "bug_number");
CREATE INDEX IF NOT EXISTS "idx_bugs_assignee" ON "bugs" ("assignee_id");

CREATE TABLE IF NOT EXISTS "test_run_results" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "project_id" integer NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "run_id" integer NOT NULL REFERENCES "test_runs"("id") ON DELETE CASCADE,
  "test_case_id" integer NOT NULL REFERENCES "test_cases"("id") ON DELETE CASCADE,
  "status" "test_result_status" DEFAULT 'not_run' NOT NULL,
  "notes" text,
  "executed_by" text REFERENCES "users"("id") ON DELETE SET NULL,
  "executed_at" timestamp,
  "linked_bug_id" integer REFERENCES "bugs"("id") ON DELETE SET NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_test_run_results_run_case" ON "test_run_results" ("run_id", "test_case_id");
CREATE INDEX IF NOT EXISTS "idx_test_run_results_org_project" ON "test_run_results" ("org_id", "project_id");
