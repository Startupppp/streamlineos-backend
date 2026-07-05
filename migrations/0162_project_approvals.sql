-- 0162_project_approvals.sql
-- Project Approvals engine: two new enum types + project_approvals table with 3 indexes.
-- Hand-authored; NOT applied by this session. Apply via psql or db:migrate in a TTY.
-- Chosen number: 0162 (0161 is taken by 0161_client_portal_change_requests.sql).

DO $$ BEGIN CREATE TYPE "public"."approval_entity_type" AS ENUM('task','milestone','budget','release','change_request','document','timesheet','client_approval'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "public"."approval_status" AS ENUM('requested','pending','approved','rejected','changes_requested','escalated','cancelled'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "project_approvals" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "project_id" integer NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "entity_type" "approval_entity_type" NOT NULL,
  "entity_id" integer NOT NULL,
  "title" text NOT NULL,
  "requested_by_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "approver_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "status" "approval_status" NOT NULL DEFAULT 'pending',
  "level" integer NOT NULL DEFAULT 1,
  "due_at" timestamp,
  "decision_comment" text,
  "decided_at" timestamp,
  "created_by" text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  "deleted_at" timestamp
);
CREATE INDEX IF NOT EXISTS "idx_project_approvals_org_project_status" ON "project_approvals" ("org_id", "project_id", "status");
CREATE INDEX IF NOT EXISTS "idx_project_approvals_approver_status" ON "project_approvals" ("approver_id", "status");
CREATE INDEX IF NOT EXISTS "idx_project_approvals_entity" ON "project_approvals" ("entity_type", "entity_id");
