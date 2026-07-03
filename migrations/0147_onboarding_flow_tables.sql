-- Onboarding flow: org setup / module checklists / guided tours / payment setup.
-- Hand-authored (drizzle-kit's migration journal has been stale since 0005; this repo
-- syncs schema via `drizzle-kit push`, see MIGRATION.md). Applied directly with psql
-- to avoid drizzle-kit push bundling unrelated pre-existing schema drift in this diff.
-- Names are prefixed "onboarding_flow_*" to avoid colliding with the pre-existing HR
-- employee onboarding tables (onboarding_templates, onboarding_template_steps,
-- onboarding_tasks, onboarding_steps).

BEGIN;

CREATE TYPE "onboarding_flow_type" AS ENUM ('org_setup', 'member_setup', 'employee_onboarding', 'module_setup', 'guided_tour', 'payment_setup');
CREATE TYPE "onboarding_flow_session_status" AS ENUM ('not_started', 'in_progress', 'completed', 'skipped', 'abandoned');
CREATE TYPE "onboarding_flow_step_status" AS ENUM ('todo', 'in_progress', 'done', 'skipped', 'blocked');
CREATE TYPE "onboarding_flow_task_status" AS ENUM ('todo', 'in_progress', 'done', 'skipped');
CREATE TYPE "onboarding_flow_task_category" AS ENUM ('profile', 'document', 'training', 'system_access', 'equipment', 'policy', 'module_setup', 'guided_action', 'payment_setup');
CREATE TYPE "module_setup_checklist_status" AS ENUM ('not_started', 'in_progress', 'completed');
CREATE TYPE "guided_tour_progress_status" AS ENUM ('not_started', 'in_progress', 'completed', 'dismissed');

CREATE TABLE "onboarding_flow_sessions" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "type" "onboarding_flow_type" NOT NULL,
  "status" "onboarding_flow_session_status" NOT NULL DEFAULT 'not_started',
  "current_step" text,
  "completed_steps" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "skipped_steps" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "data" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "source" text,
  "started_at" timestamp,
  "completed_at" timestamp,
  "last_seen_at" timestamp NOT NULL DEFAULT now(),
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX "idx_onb_flow_sessions_org_user_type" ON "onboarding_flow_sessions" ("org_id", "user_id", "type");
CREATE INDEX "idx_onb_flow_sessions_status" ON "onboarding_flow_sessions" ("org_id", "status");

CREATE TABLE "onboarding_flow_steps" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "session_id" integer NOT NULL REFERENCES "onboarding_flow_sessions"("id") ON DELETE CASCADE,
  "step_key" text NOT NULL,
  "title" text,
  "status" "onboarding_flow_step_status" NOT NULL DEFAULT 'todo',
  "required" boolean NOT NULL DEFAULT true,
  "owner_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "due_at" timestamp,
  "completed_at" timestamp,
  "skipped_at" timestamp,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "uq_onb_flow_steps_session_key" UNIQUE ("session_id", "step_key")
);
CREATE INDEX "idx_onb_flow_steps_session" ON "onboarding_flow_steps" ("session_id");

CREATE TABLE "onboarding_flow_templates" (
  "id" serial PRIMARY KEY,
  "org_id" text REFERENCES "organizations"("id") ON DELETE CASCADE,
  "type" "onboarding_flow_type" NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "industry" text,
  "department_id" integer REFERENCES "departments"("id") ON DELETE SET NULL,
  "job_role" text,
  "module_key" text,
  "steps" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "is_system" boolean NOT NULL DEFAULT false,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_by_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  "deleted_at" timestamp
);
CREATE INDEX "idx_onb_flow_templates_org_type" ON "onboarding_flow_templates" ("org_id", "type");
CREATE INDEX "idx_onb_flow_templates_industry" ON "onboarding_flow_templates" ("industry");

CREATE TABLE "onboarding_flow_tasks" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "assignee_user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "owner_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "template_id" integer REFERENCES "onboarding_flow_templates"("id") ON DELETE SET NULL,
  "source_type" text,
  "source_id" text,
  "title" text NOT NULL,
  "description" text,
  "status" "onboarding_flow_task_status" NOT NULL DEFAULT 'todo',
  "category" "onboarding_flow_task_category" NOT NULL,
  "due_at" timestamp,
  "completed_at" timestamp,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  "deleted_at" timestamp
);
CREATE INDEX "idx_onb_flow_tasks_assignee" ON "onboarding_flow_tasks" ("org_id", "assignee_user_id");
CREATE INDEX "idx_onb_flow_tasks_status" ON "onboarding_flow_tasks" ("org_id", "status");

CREATE TABLE "module_setup_checklists" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "module_key" text NOT NULL,
  "status" "module_setup_checklist_status" NOT NULL DEFAULT 'not_started',
  "progress" integer NOT NULL DEFAULT 0,
  "dismissed_at" timestamp,
  "completed_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "uq_module_setup_checklists_org_module" UNIQUE ("org_id", "module_key")
);

CREATE TABLE "module_setup_checklist_items" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "checklist_id" integer NOT NULL REFERENCES "module_setup_checklists"("id") ON DELETE CASCADE,
  "item_key" text NOT NULL,
  "title" text NOT NULL,
  "description" text,
  "action_href" text,
  "status" "onboarding_flow_step_status" NOT NULL DEFAULT 'todo',
  "required" boolean NOT NULL DEFAULT true,
  "sort_order" integer NOT NULL DEFAULT 0,
  "completed_at" timestamp,
  "skipped_at" timestamp,
  CONSTRAINT "uq_module_checklist_items_checklist_key" UNIQUE ("checklist_id", "item_key")
);
CREATE INDEX "idx_module_checklist_items_checklist" ON "module_setup_checklist_items" ("checklist_id");

CREATE TABLE "guided_tours" (
  "id" serial PRIMARY KEY,
  "org_id" text REFERENCES "organizations"("id") ON DELETE CASCADE,
  "tour_key" text NOT NULL,
  "module_key" text,
  "role" text,
  "steps" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX "idx_guided_tours_org_key" ON "guided_tours" ("org_id", "tour_key");

CREATE TABLE "user_tour_progress" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "tour_key" text NOT NULL,
  "status" "guided_tour_progress_status" NOT NULL DEFAULT 'not_started',
  "current_step" integer NOT NULL DEFAULT 0,
  "completed_at" timestamp,
  "dismissed_at" timestamp,
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "uq_user_tour_progress_org_user_tour" UNIQUE ("org_id", "user_id", "tour_key")
);

CREATE TABLE "onboarding_analytics_events" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "event_type" text NOT NULL,
  "source" text,
  "step_key" text,
  "module_key" text,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX "idx_onb_analytics_org_event" ON "onboarding_analytics_events" ("org_id", "event_type");
CREATE INDEX "idx_onb_analytics_org_created" ON "onboarding_analytics_events" ("org_id", "created_at");

COMMIT;
