-- Migration: polymorphic tasks table for Sales Activities & Task Tracking
-- Adds: task_entity_type enum, task_type enum, task_status_new enum, tasks table

DO $$ BEGIN
  CREATE TYPE task_entity_type AS ENUM ('LEAD', 'DEAL', 'CONTACT', 'PROJECT');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE task_type AS ENUM ('CALL', 'EMAIL', 'MEETING', 'CUSTOM');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE task_status AS ENUM ('pending', 'completed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "tasks" (
  "id"           SERIAL PRIMARY KEY,
  "org_id"       TEXT NOT NULL REFERENCES "organizations"("id"),
  "title"        TEXT NOT NULL,
  "notes"        TEXT,
  "entity_type"  task_entity_type,
  "entity_id"    INTEGER,
  "type"         task_type NOT NULL DEFAULT 'CUSTOM',
  "status"       task_status NOT NULL DEFAULT 'pending',
  "assignee_id"  TEXT REFERENCES "users"("id"),
  "created_by"   TEXT REFERENCES "users"("id"),
  "due_date"     TIMESTAMP WITH TIME ZONE,
  "remind_at"    TIMESTAMP WITH TIME ZONE,
  "completed_at" TIMESTAMP WITH TIME ZONE,
  "timezone"     TEXT,
  "created_at"   TIMESTAMP DEFAULT now(),
  "updated_at"   TIMESTAMP DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_tasks_org" ON "tasks"("org_id");
CREATE INDEX IF NOT EXISTS "idx_tasks_assignee" ON "tasks"("assignee_id");
CREATE INDEX IF NOT EXISTS "idx_tasks_status" ON "tasks"("status");
CREATE INDEX IF NOT EXISTS "idx_tasks_due_date" ON "tasks"("due_date");
CREATE INDEX IF NOT EXISTS "idx_tasks_entity" ON "tasks"("entity_type", "entity_id");
