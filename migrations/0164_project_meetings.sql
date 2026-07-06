-- 0164_project_meetings.sql
-- Project Meetings, Standups & Action Items engine: 3 enum types + 4 tables with indexes.
-- Hand-authored; NOT applied by this session. Apply via psql or db:migrate in a TTY.
-- Chosen number: 0164 (0163 is taken by 0163_project_governance.sql).

DO $$ BEGIN CREATE TYPE "public"."meeting_type" AS ENUM('meeting','standup','retro','planning','review'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "public"."project_meeting_status" AS ENUM('scheduled','in_progress','completed','cancelled'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "public"."action_item_status" AS ENUM('open','in_progress','done','converted','cancelled'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "project_meetings" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "project_id" integer NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "meeting_number" integer NOT NULL,
  "title" text NOT NULL,
  "type" "meeting_type" NOT NULL DEFAULT 'meeting',
  "status" "project_meeting_status" NOT NULL DEFAULT 'scheduled',
  "agenda" text,
  "notes" text,
  "scheduled_at" timestamp,
  "duration_minutes" integer,
  "sprint_id" integer REFERENCES "sprints"("id") ON DELETE SET NULL,
  "created_by" text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  "deleted_at" timestamp
);
CREATE INDEX IF NOT EXISTS "idx_project_meetings_org_project_status" ON "project_meetings" ("org_id", "project_id", "status");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_project_meetings_project_number" ON "project_meetings" ("project_id", "meeting_number");
CREATE INDEX IF NOT EXISTS "idx_project_meetings_scheduled" ON "project_meetings" ("scheduled_at");

CREATE TABLE IF NOT EXISTS "meeting_attendees" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "meeting_id" integer NOT NULL REFERENCES "project_meetings"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "attended" boolean NOT NULL DEFAULT false,
  "created_at" timestamp DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_meeting_attendees_meeting_user" ON "meeting_attendees" ("meeting_id", "user_id");
CREATE INDEX IF NOT EXISTS "idx_meeting_attendees_user" ON "meeting_attendees" ("user_id");

CREATE TABLE IF NOT EXISTS "meeting_action_items" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "meeting_id" integer NOT NULL REFERENCES "project_meetings"("id") ON DELETE CASCADE,
  "project_id" integer NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "title" text NOT NULL,
  "description" text,
  "assignee_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "due_date" date,
  "status" "action_item_status" NOT NULL DEFAULT 'open',
  "converted_ticket_id" integer REFERENCES "tickets"("id") ON DELETE SET NULL,
  "created_by" text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  "deleted_at" timestamp
);
CREATE INDEX IF NOT EXISTS "idx_meeting_action_items_meeting" ON "meeting_action_items" ("meeting_id");
CREATE INDEX IF NOT EXISTS "idx_meeting_action_items_org_project_status" ON "meeting_action_items" ("org_id", "project_id", "status");
CREATE INDEX IF NOT EXISTS "idx_meeting_action_items_assignee" ON "meeting_action_items" ("assignee_id");

CREATE TABLE IF NOT EXISTS "meeting_standup_entries" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "meeting_id" integer NOT NULL REFERENCES "project_meetings"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "yesterday" text,
  "today" text,
  "blockers" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_meeting_standup_meeting_user" ON "meeting_standup_entries" ("meeting_id", "user_id");
