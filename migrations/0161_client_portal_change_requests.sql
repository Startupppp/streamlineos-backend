-- 0160_client_portal_change_requests.sql
-- Client Portal + Change Requests engine schema: additive columns + new table.
-- Hand-authored; NOT applied by this session. Apply via psql or db:migrate in a TTY.
-- COLLISION NOTE: 0160_timesheets_standalone.sql already occupies sequence 0160.
-- Rename this file to 0161_client_portal_change_requests.sql before applying.

DO $$ BEGIN CREATE TYPE "public"."change_request_status" AS ENUM('submitted','under_review','estimated','awaiting_approval','approved','rejected','in_progress','completed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "client_visible" boolean NOT NULL DEFAULT false;
ALTER TABLE "ticket_comments" ADD COLUMN IF NOT EXISTS "client_visible" boolean NOT NULL DEFAULT false;
ALTER TABLE "ticket_attachments" ADD COLUMN IF NOT EXISTS "client_visible" boolean NOT NULL DEFAULT false;
ALTER TABLE "project_milestones" ADD COLUMN IF NOT EXISTS "client_visible" boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "change_requests" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "project_id" integer NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "cr_number" integer NOT NULL,
  "title" text NOT NULL,
  "description" text,
  "impact" text,
  "estimate_minutes" integer,
  "budget_impact_cents" integer,
  "timeline_impact_days" integer,
  "status" "change_request_status" NOT NULL DEFAULT 'submitted',
  "requested_by_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "approval_owner_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "decision_comment" text,
  "decided_at" timestamp,
  "created_by" text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  "deleted_at" timestamp
);
CREATE INDEX IF NOT EXISTS "idx_change_requests_org_project_status" ON "change_requests" ("org_id", "project_id", "status");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_change_requests_project_number" ON "change_requests" ("project_id", "cr_number");
CREATE INDEX IF NOT EXISTS "idx_change_requests_requested_by" ON "change_requests" ("requested_by_id");
