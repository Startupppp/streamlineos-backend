-- 0167_project_portfolios.sql
-- Portfolio & Program governance engine: 2 enum types + 4 tables with indexes.
-- Hand-authored; NOT applied by this session. Apply via psql or db:migrate in a TTY.
-- Chosen number: 0167 (0166 is taken by 0166_project_forms.sql).
-- Enum names project_portfolio_status and project_portfolio_health are free in enums.ts; no collision.

DO $$ BEGIN CREATE TYPE "public"."project_portfolio_status" AS ENUM('active','on_hold','completed','archived'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "public"."project_portfolio_health" AS ENUM('on_track','at_risk','off_track'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "project_portfolios" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "description" text,
  "owner_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "status" "project_portfolio_status" NOT NULL DEFAULT 'active',
  "health" "project_portfolio_health",
  "strategic_goal" text,
  "created_by" text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  "deleted_at" timestamp
);
CREATE INDEX IF NOT EXISTS "idx_project_portfolios_org_status" ON "project_portfolios" ("org_id", "status");

CREATE TABLE IF NOT EXISTS "project_programs" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "portfolio_id" integer REFERENCES "project_portfolios"("id") ON DELETE SET NULL,
  "name" text NOT NULL,
  "description" text,
  "owner_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "status" "project_portfolio_status" NOT NULL DEFAULT 'active',
  "health" "project_portfolio_health",
  "created_by" text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  "deleted_at" timestamp
);
CREATE INDEX IF NOT EXISTS "idx_project_programs_org_status" ON "project_programs" ("org_id", "status");
CREATE INDEX IF NOT EXISTS "idx_project_programs_portfolio" ON "project_programs" ("portfolio_id");

CREATE TABLE IF NOT EXISTS "portfolio_projects" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "portfolio_id" integer NOT NULL REFERENCES "project_portfolios"("id") ON DELETE CASCADE,
  "project_id" integer NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "created_at" timestamp DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_portfolio_projects" ON "portfolio_projects" ("portfolio_id", "project_id");
CREATE INDEX IF NOT EXISTS "idx_portfolio_projects_project" ON "portfolio_projects" ("project_id");

CREATE TABLE IF NOT EXISTS "program_projects" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "program_id" integer NOT NULL REFERENCES "project_programs"("id") ON DELETE CASCADE,
  "project_id" integer NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "created_at" timestamp DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_program_projects" ON "program_projects" ("program_id", "project_id");
CREATE INDEX IF NOT EXISTS "idx_program_projects_project" ON "program_projects" ("project_id");
