-- Custom SQL migration file, put your code below! --

-- Scheduled reports, and who receives them.
--
-- CRM-P2-08. Two decisions belong in the schema rather than only in the service.
--
-- `run_as_user_id` is NOT NULL and is a security decision, not a setting.
-- Running a report requires `crm:reporting:run` AND the key that governs the
-- source's rows everywhere else, and the compiled statement is narrowed by that
-- person's DataScope. A schedule has no requester when it fires, so it must name
-- one. Unattended work with no subject would make a schedule a way to read rows
-- the person who created it could not; naming the creator also means a schedule
-- fails closed once their access is withdrawn, which is what a leaver should
-- produce.
--
-- Recipients are a table and not a jsonb array on the schedule. An address has
-- to be removable on its own, has to be indexable to answer "what does this
-- person receive", and is what an unsubscribe link acts on. None of that is
-- possible inside an array.

SET lock_timeout = '5s';

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crm_report_schedules" (
  "report_schedule_id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "report_definition_id" text NOT NULL,
  "cadence" text NOT NULL,
  -- In the organisation's own zone. A daily report at 08:00 for a Delhi tenant
  -- arrives at 08:00 in Delhi in January and in July; the zone is read from
  -- `organizations.timezone` at sweep time rather than copied here, so moving
  -- the organisation moves its reports.
  "hour_of_day" integer NOT NULL,
  "day_of_week" integer NOT NULL DEFAULT 1,
  -- Capped at 28 by the DTO. 29-31 are refused rather than clamped: "the 31st"
  -- either skips February or silently becomes the 28th for one month a year,
  -- and both are a report that did not arrive when somebody was told it would.
  "day_of_month" integer NOT NULL DEFAULT 1,
  "run_as_user_id" text NOT NULL,
  "enabled" boolean NOT NULL DEFAULT true,
  -- How many times this schedule has fired, and the outbox event's aggregate
  -- version. `outbox_events` is UNIQUE on (org, aggregate_type, aggregate_id,
  -- aggregate_version), so a repeat emitter that hardcodes version 1 succeeds
  -- exactly once and then violates the constraint on every later firing -- a
  -- report that arrives, once, and then silently never again. Incremented in
  -- the same UPDATE that advances `next_run_at`, so the version is monotonic
  -- per schedule by construction rather than by a counter somebody maintains.
  "run_count" integer NOT NULL DEFAULT 0,
  -- Precomputed rather than derived at sweep time. A sweep that recomputed every
  -- schedule's cadence to find the due ones would read every row on every tick;
  -- this makes it a bounded index range scan, and it is the value the sweep
  -- advances in the same transaction as the outbox emit so one report cannot go
  -- out twice.
  "next_run_at" timestamp NOT NULL,
  "last_run_at" timestamp,
  "last_error" text,
  "created_by_user_id" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "chk_crm_report_schedules_cadence"
    CHECK ("cadence" IN ('daily', 'weekly', 'monthly')),
  CONSTRAINT "chk_crm_report_schedules_hour"
    CHECK ("hour_of_day" BETWEEN 0 AND 23),
  CONSTRAINT "chk_crm_report_schedules_dow"
    CHECK ("day_of_week" BETWEEN 0 AND 6),
  CONSTRAINT "chk_crm_report_schedules_dom"
    CHECK ("day_of_month" BETWEEN 1 AND 28)
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crm_report_schedule_recipients" (
  "report_schedule_recipient_id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "report_schedule_id" text NOT NULL,
  "email" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
-- NOT VALID then VALIDATE, because ADD CONSTRAINT ... FOREIGN KEY takes ACCESS
-- EXCLUSIVE on BOTH tables while it installs its triggers.
ALTER TABLE "crm_report_schedules"
  ADD CONSTRAINT "fk_crm_report_schedules_org"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "crm_report_schedules" VALIDATE CONSTRAINT "fk_crm_report_schedules_org";

--> statement-breakpoint
ALTER TABLE "crm_report_schedule_recipients"
  ADD CONSTRAINT "fk_crm_report_schedule_recipients_org"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "crm_report_schedule_recipients"
  VALIDATE CONSTRAINT "fk_crm_report_schedule_recipients_org";

--> statement-breakpoint
-- The composite tenant key a child FK leads with.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_crm_report_schedules_org_id"
  ON "crm_report_schedules" ("organization_id", "report_schedule_id");

--> statement-breakpoint
-- CASCADE and not SET NULL, deliberately. A composite SET NULL nulls EVERY
-- column of the key including `organization_id`, which is NOT NULL, so the
-- parent delete would abort -- see 0662. Deleting a schedule genuinely should
-- take its recipient list with it: a recipient row for a schedule that no longer
-- exists is not a record of anything.
ALTER TABLE "crm_report_schedule_recipients"
  ADD CONSTRAINT "fk_crm_report_schedule_recipients_schedule"
  FOREIGN KEY ("organization_id", "report_schedule_id")
  REFERENCES "crm_report_schedules" ("organization_id", "report_schedule_id")
  ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "crm_report_schedule_recipients"
  VALIDATE CONSTRAINT "fk_crm_report_schedule_recipients_schedule";

--> statement-breakpoint
-- The sweep: this tenant's schedules that are due, in due order.
CREATE INDEX IF NOT EXISTS "idx_crm_report_schedules_due"
  ON "crm_report_schedules" ("organization_id", "next_run_at");

--> statement-breakpoint
-- "What is scheduled off this report", asked before deleting one.
CREATE INDEX IF NOT EXISTS "idx_crm_report_schedules_definition"
  ON "crm_report_schedules" ("organization_id", "report_definition_id");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_crm_report_schedule_recipients_schedule"
  ON "crm_report_schedule_recipients" ("organization_id", "report_schedule_id");

--> statement-breakpoint
-- One address per schedule. Two rows would send the same report twice to the
-- same person, which reads as the system malfunctioning.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_crm_report_schedule_recipients"
  ON "crm_report_schedule_recipients" ("organization_id", "report_schedule_id", "email");

--> statement-breakpoint
-- A schedule names the fields a tenant reports on and the addresses those
-- reports go to. Both are tenant data; a missing policy here is silent, because
-- grants arrive through ALTER DEFAULT PRIVILEGES.
ALTER TABLE "crm_report_schedules" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "crm_report_schedules";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "crm_report_schedules"
  FOR ALL USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "crm_report_schedules" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "crm_report_schedules" TO streamline_app;

--> statement-breakpoint
ALTER TABLE "crm_report_schedule_recipients" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "crm_report_schedule_recipients";
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "crm_report_schedule_recipients"
  FOR ALL USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
--> statement-breakpoint
REVOKE ALL ON "crm_report_schedule_recipients" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "crm_report_schedule_recipients" TO streamline_app;

--> statement-breakpoint
ANALYZE "crm_report_schedules";
--> statement-breakpoint
ANALYZE "crm_report_schedule_recipients";
