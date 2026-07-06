-- 0163_project_governance.sql
-- Project Risks and Decisions (governance) register: 4 enum types + 2 tables with indexes.
-- Hand-authored; NOT applied by this session. Apply via psql or db:migrate in a TTY.
-- Chosen number: 0163 (0162 is taken by 0162_project_approvals.sql).

DO $$ BEGIN CREATE TYPE "public"."risk_probability" AS ENUM('low','medium','high'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "public"."risk_impact" AS ENUM('low','medium','high'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "public"."risk_status" AS ENUM('open','mitigating','monitoring','accepted','closed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "public"."decision_status" AS ENUM('proposed','accepted','superseded','revisit'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "project_risks" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "project_id" integer NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "risk_number" integer NOT NULL,
  "title" text NOT NULL,
  "description" text,
  "probability" "risk_probability" NOT NULL DEFAULT 'medium',
  "impact" "risk_impact" NOT NULL DEFAULT 'medium',
  "status" "risk_status" NOT NULL DEFAULT 'open',
  "owner_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "mitigation" text,
  "linked_ticket_id" integer REFERENCES "tickets"("id") ON DELETE SET NULL,
  "created_by" text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  "deleted_at" timestamp
);
CREATE INDEX IF NOT EXISTS "idx_project_risks_org_project_status" ON "project_risks" ("org_id", "project_id", "status");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_project_risks_project_number" ON "project_risks" ("project_id", "risk_number");
CREATE INDEX IF NOT EXISTS "idx_project_risks_owner" ON "project_risks" ("owner_id");

CREATE TABLE IF NOT EXISTS "project_decisions" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "project_id" integer NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "decision_number" integer NOT NULL,
  "title" text NOT NULL,
  "context" text,
  "decision" text,
  "options_considered" text,
  "status" "decision_status" NOT NULL DEFAULT 'proposed',
  "owner_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "decided_at" timestamp,
  "revisit_at" timestamp,
  "linked_ticket_id" integer REFERENCES "tickets"("id") ON DELETE SET NULL,
  "created_by" text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  "deleted_at" timestamp
);
CREATE INDEX IF NOT EXISTS "idx_project_decisions_org_project_status" ON "project_decisions" ("org_id", "project_id", "status");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_project_decisions_project_number" ON "project_decisions" ("project_id", "decision_number");
