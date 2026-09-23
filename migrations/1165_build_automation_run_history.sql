SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('build.project_automations') IS NULL THEN
    RAISE EXCEPTION '1165 precondition: build.project_automations is absent — this is not a Build database';
  END IF;
  IF to_regclass('build.projects') IS NULL THEN
    RAISE EXCEPTION '1165 precondition: build.projects is absent — this is not a Build database';
  END IF;
  IF to_regclass('build.tickets') IS NULL THEN
    RAISE EXCEPTION '1165 precondition: build.tickets is absent — this is not a Build database';
  END IF;
  IF to_regclass('build.project_automation_runs') IS NOT NULL THEN
    RAISE EXCEPTION '1165 precondition: build.project_automation_runs already exists — this migration has run';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_projects_org_id') THEN
    RAISE EXCEPTION '1165 precondition: uniq_projects_org_id is absent — the tenant-safe composite foreign key cannot be declared';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_project_automations_org_id') THEN
    RAISE EXCEPTION '1165 precondition: uniq_project_automations_org_id is absent — the tenant-safe composite foreign key cannot be declared';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_tickets_org_id') THEN
    RAISE EXCEPTION '1165 precondition: uniq_tickets_org_id is absent — the tenant-safe composite foreign key cannot be declared';
  END IF;
END $$;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'automation_run_outcome') THEN
    CREATE TYPE "public"."automation_run_outcome" AS ENUM (
      'matched_success', 'matched_partial_failure', 'matched_failed',
      'not_matched', 'blocked_loop_guard', 'blocked_rate_limit', 'error'
    );
  END IF;
END $$;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'automation_action_outcome') THEN
    CREATE TYPE "public"."automation_action_outcome" AS ENUM ('success', 'failure');
  END IF;
END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "build"."project_automation_runs" (
  "id" integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "org_id" text NOT NULL,
  "project_id" integer NOT NULL,
  "automation_id" integer,
  "ticket_id" integer,
  "trigger_event" text NOT NULL,
  "matched" boolean NOT NULL,
  "outcome" "public"."automation_run_outcome" NOT NULL,
  "error_message" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "uniq_project_automation_runs_org_id" UNIQUE ("org_id", "id")
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_project_automation_runs_org_project_created"
  ON "build"."project_automation_runs" ("org_id", "project_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_project_automation_runs_org_automation_created"
  ON "build"."project_automation_runs" ("org_id", "automation_id", "created_at");
--> statement-breakpoint

ALTER TABLE "build"."project_automation_runs"
  ADD CONSTRAINT "project_automation_runs_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "public"."organizations" ("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."project_automation_runs"
  VALIDATE CONSTRAINT "project_automation_runs_org_id_organizations_id_fk";
--> statement-breakpoint

ALTER TABLE "build"."project_automation_runs"
  ADD CONSTRAINT "fk_project_automation_runs_org_project"
  FOREIGN KEY ("org_id", "project_id") REFERENCES "build"."projects" ("org_id", "id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."project_automation_runs"
  VALIDATE CONSTRAINT "fk_project_automation_runs_org_project";
--> statement-breakpoint

ALTER TABLE "build"."project_automation_runs"
  ADD CONSTRAINT "fk_project_automation_runs_org_automation"
  FOREIGN KEY ("org_id", "automation_id") REFERENCES "build"."project_automations" ("org_id", "id") ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."project_automation_runs"
  VALIDATE CONSTRAINT "fk_project_automation_runs_org_automation";
--> statement-breakpoint

ALTER TABLE "build"."project_automation_runs"
  ADD CONSTRAINT "fk_project_automation_runs_org_ticket"
  FOREIGN KEY ("org_id", "ticket_id") REFERENCES "build"."tickets" ("org_id", "id") ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."project_automation_runs"
  VALIDATE CONSTRAINT "fk_project_automation_runs_org_ticket";
--> statement-breakpoint

ALTER TABLE "build"."project_automation_runs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "build"."project_automation_runs";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "build"."project_automation_runs"
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "build"."project_automation_runs" TO streamline_app;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "build"."project_automation_run_actions" (
  "id" integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "org_id" text NOT NULL,
  "run_id" integer NOT NULL,
  "action_index" integer NOT NULL,
  "action_type" text NOT NULL,
  "outcome" "public"."automation_action_outcome" NOT NULL,
  "error_message" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "uniq_project_automation_run_actions_org_id" UNIQUE ("org_id", "id")
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_project_automation_run_actions_run"
  ON "build"."project_automation_run_actions" ("run_id");
--> statement-breakpoint

ALTER TABLE "build"."project_automation_run_actions"
  ADD CONSTRAINT "project_automation_run_actions_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "public"."organizations" ("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."project_automation_run_actions"
  VALIDATE CONSTRAINT "project_automation_run_actions_org_id_organizations_id_fk";
--> statement-breakpoint

ALTER TABLE "build"."project_automation_run_actions"
  ADD CONSTRAINT "fk_project_automation_run_actions_org_run"
  FOREIGN KEY ("org_id", "run_id") REFERENCES "build"."project_automation_runs" ("org_id", "id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "build"."project_automation_run_actions"
  VALIDATE CONSTRAINT "fk_project_automation_run_actions_org_run";
--> statement-breakpoint

ALTER TABLE "build"."project_automation_run_actions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "build"."project_automation_run_actions";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "build"."project_automation_run_actions"
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "build"."project_automation_run_actions" TO streamline_app;
