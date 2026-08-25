-- Custom SQL migration file, put your code below! --

-- Durable workflow execution.
--
-- Deliberately outside row-level security, on the same footing as outbox_events:
-- a worker claims across every organisation, so a tenant policy would make the
-- claim query return nothing. Isolation lives a layer up — a run only ever
-- executes against its own organisation, and each step opens that
-- organisation's transaction, where RLS does apply to whatever it touches.
--
-- Authored via `generate --custom`; see 0205 for why db:generate cannot run here.

SET lock_timeout = '5s';

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workflow_runs" (
  "workflow_run_id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "workflow_name" text NOT NULL,
  "input" jsonb NOT NULL,
  "status" text DEFAULT 'PENDING' NOT NULL,
  "attempt" integer DEFAULT 0 NOT NULL,
  "max_attempts" integer DEFAULT 5 NOT NULL,
  "run_after" timestamp DEFAULT now() NOT NULL,
  "lease_expires_at" timestamp,
  "output" jsonb,
  "last_error" text,
  "dead_lettered_at" timestamp,
  "correlation_id" text,
  "causation_event_id" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  "completed_at" timestamp
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workflow_steps" (
  "workflow_step_id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "workflow_run_id" text NOT NULL,
  "organization_id" text NOT NULL,
  "step_name" text NOT NULL,
  "status" text DEFAULT 'COMPLETED' NOT NULL,
  "output" jsonb,
  "error" text,
  "attempt" integer DEFAULT 0 NOT NULL,
  "started_at" timestamp DEFAULT now() NOT NULL,
  "completed_at" timestamp
);

--> statement-breakpoint
-- NOT VALID then VALIDATE: adding a foreign key takes ACCESS EXCLUSIVE on both
-- tables while it installs triggers, so one long read on organizations would
-- stall every write to both.
ALTER TABLE "workflow_runs"
  ADD CONSTRAINT "fk_workflow_runs_org"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;

--> statement-breakpoint
ALTER TABLE "workflow_runs" VALIDATE CONSTRAINT "fk_workflow_runs_org";

--> statement-breakpoint
ALTER TABLE "workflow_steps"
  ADD CONSTRAINT "fk_workflow_steps_org"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;

--> statement-breakpoint
ALTER TABLE "workflow_steps" VALIDATE CONSTRAINT "fk_workflow_steps_org";

--> statement-breakpoint
-- One run per triggering event: a redelivered outbox event resumes the run it
-- already started rather than starting a second.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_workflow_runs_causation"
  ON "workflow_runs" ("organization_id", "workflow_name", "causation_event_id")
  WHERE "causation_event_id" IS NOT NULL;

--> statement-breakpoint
-- The claim predicate, in its own order: status first because it is the most
-- selective, then the two time columns the predicate compares.
CREATE INDEX IF NOT EXISTS "idx_workflow_runs_claim"
  ON "workflow_runs" ("status", "run_after", "lease_expires_at");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workflow_runs_org_status"
  ON "workflow_runs" ("organization_id", "status", "created_at");

--> statement-breakpoint
-- The memo lookup. Leading organization_id keeps it usable if these tables are
-- ever brought under a policy.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_workflow_steps_run_name"
  ON "workflow_steps" ("organization_id", "workflow_run_id", "step_name");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workflow_steps_run"
  ON "workflow_steps" ("organization_id", "workflow_run_id", "started_at");

--> statement-breakpoint
ANALYZE "workflow_runs";

--> statement-breakpoint
ANALYZE "workflow_steps";
