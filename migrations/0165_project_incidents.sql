-- 0165_project_incidents.sql
-- Project Incidents & SLA engine: 2 enum types + 2 tables with indexes.
-- Hand-authored; NOT applied by this session. Apply via psql or db:migrate in a TTY.
-- Chosen number: 0165 (0164 is taken by 0164_project_meetings.sql).
-- Enum names incident_severity and incident_status are free in enums.ts; no collision.

DO $$ BEGIN CREATE TYPE "public"."incident_severity" AS ENUM('critical','high','medium','low'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "public"."incident_status" AS ENUM('detected','investigating','mitigating','resolved','postmortem','closed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "project_incidents" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "project_id" integer NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "incident_number" integer NOT NULL,
  "title" text NOT NULL,
  "description" text,
  "severity" "incident_severity" NOT NULL DEFAULT 'medium',
  "status" "incident_status" NOT NULL DEFAULT 'detected',
  "impact" text,
  "owner_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "root_cause" text,
  "customer_comms" text,
  "detected_at" timestamp,
  "responded_at" timestamp,
  "resolved_at" timestamp,
  "response_due_at" timestamp,
  "resolution_due_at" timestamp,
  "linked_ticket_id" integer REFERENCES "tickets"("id") ON DELETE SET NULL,
  "created_by" text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  "deleted_at" timestamp
);
CREATE INDEX IF NOT EXISTS "idx_project_incidents_org_project_status" ON "project_incidents" ("org_id", "project_id", "status");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_project_incidents_project_number" ON "project_incidents" ("project_id", "incident_number");
CREATE INDEX IF NOT EXISTS "idx_project_incidents_severity" ON "project_incidents" ("severity");

CREATE TABLE IF NOT EXISTS "incident_updates" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "incident_id" integer NOT NULL REFERENCES "project_incidents"("id") ON DELETE CASCADE,
  "message" text NOT NULL,
  "new_status" "incident_status",
  "created_by" text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_incident_updates_incident" ON "incident_updates" ("incident_id");
