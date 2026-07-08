DO $$ BEGIN
  CREATE TYPE "feedbucket_submission_type" AS ENUM ('bug', 'idea', 'question', 'praise', 'other');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "feedbucket_submission_status" AS ENUM ('open', 'in_progress', 'resolved', 'archived');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "feedbucket_submission_priority" AS ENUM ('low', 'medium', 'high', 'urgent');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "feedbucket_widgets" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "project_id" integer REFERENCES "projects"("id") ON DELETE set null,
  "name" text NOT NULL,
  "public_key" text NOT NULL,
  "allowed_domains" text[] NOT NULL DEFAULT '{}'::text[],
  "auto_create_ticket" boolean NOT NULL DEFAULT false,
  "default_ticket_type" text NOT NULL DEFAULT 'BUG',
  "is_active" boolean NOT NULL DEFAULT true,
  "theme" jsonb,
  "created_by" text REFERENCES "users"("id") ON DELETE set null,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  "deleted_at" timestamp
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "feedbucket_submissions" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "widget_id" integer NOT NULL REFERENCES "feedbucket_widgets"("id") ON DELETE cascade,
  "type" "feedbucket_submission_type" NOT NULL,
  "status" "feedbucket_submission_status" NOT NULL DEFAULT 'open',
  "priority" "feedbucket_submission_priority",
  "message" text NOT NULL,
  "page_url" text,
  "screenshot_url" text,
  "screenshot_key" text,
  "metadata" jsonb,
  "console_logs" jsonb,
  "reporter_name" text,
  "reporter_email" text,
  "assignee_id" text REFERENCES "users"("id") ON DELETE set null,
  "linked_ticket_id" integer REFERENCES "tickets"("id") ON DELETE set null,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  "deleted_at" timestamp
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "feedbucket_comments" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "submission_id" integer NOT NULL REFERENCES "feedbucket_submissions"("id") ON DELETE cascade,
  "user_id" text REFERENCES "users"("id") ON DELETE set null,
  "content" text NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "feedbucket_attachments" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "submission_id" integer NOT NULL REFERENCES "feedbucket_submissions"("id") ON DELETE cascade,
  "file_url" text NOT NULL,
  "file_key" text,
  "file_name" text,
  "file_size" integer,
  "mime_type" text,
  "created_at" timestamp NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_feedbucket_widgets_public_key" ON "feedbucket_widgets" ("public_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_feedbucket_widgets_org" ON "feedbucket_widgets" ("org_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_feedbucket_submissions_widget" ON "feedbucket_submissions" ("org_id","widget_id","status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_feedbucket_submissions_org_status" ON "feedbucket_submissions" ("org_id","status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_feedbucket_submissions_assignee" ON "feedbucket_submissions" ("org_id","assignee_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_feedbucket_comments_submission" ON "feedbucket_comments" ("org_id","submission_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_feedbucket_attachments_submission" ON "feedbucket_attachments" ("org_id","submission_id");
