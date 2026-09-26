-- 1232 — HRM-15: `hr_reporting_line_bulk_jobs` and `hr_reporting_line_bulk_job_rows`
--
-- A bulk reporting change (PRD D4, §7.6) is previewed, persisted, then committed. The job row holds
-- the job-level reason and the counts; each employee in the upload is one normalised row, never a
-- JSONB array (BE-42). Secondary managers are three nullable columns rather than an array, because
-- the policy caps them at three and a column can be indexed, validated and displayed as-is.
--
-- `before_line_id` / `after_line_id` are trace ids into `hr_reporting_lines` and deliberately carry
-- no foreign key: a later same-day correction moves the line it replaced into
-- `hr_reporting_lines_superseded` (1235), and the job's record of what it wrote must survive that.
--
-- Rollback: migrations/rollback/1232_hr_reporting_line_bulk_jobs.down.sql
SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.hr_employments'::regclass AND contype IN ('u', 'p')
      AND pg_get_constraintdef(oid) = 'UNIQUE (org_id, id)'
  ) THEN
    RAISE EXCEPTION '1232 precondition: hr_employments has no UNIQUE (org_id, id) for the org-composite FKs';
  END IF;
END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "public"."hr_reporting_line_bulk_jobs" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "org_id" text NOT NULL,
  "status" text NOT NULL DEFAULT 'PREVIEWED',
  "job_reason" text NOT NULL,
  "effective_from" date,
  "row_count" integer NOT NULL DEFAULT 0,
  "ready_count" integer NOT NULL DEFAULT 0,
  "warning_count" integer NOT NULL DEFAULT 0,
  "error_count" integer NOT NULL DEFAULT 0,
  "committed_count" integer NOT NULL DEFAULT 0,
  "created_by" text NOT NULL,
  "committed_by" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "committed_at" timestamp with time zone,
  "deleted_at" timestamp with time zone,
  CONSTRAINT "pk_hr_reporting_line_bulk_jobs" PRIMARY KEY ("id"),
  CONSTRAINT "uniq_hr_rl_bulk_jobs_org_id" UNIQUE ("org_id", "id"),
  CONSTRAINT "chk_hr_rl_bulk_jobs_status" CHECK (
    "status" IN ('PREVIEWED', 'COMMITTING', 'COMMITTED', 'FAILED', 'EXPIRED')
  ),
  CONSTRAINT "chk_hr_rl_bulk_jobs_reason" CHECK (char_length(btrim("job_reason")) BETWEEN 10 AND 1000),
  CONSTRAINT "chk_hr_rl_bulk_jobs_counts" CHECK (
    "row_count" >= 0 AND "ready_count" >= 0 AND "warning_count" >= 0
    AND "error_count" >= 0 AND "committed_count" >= 0
  )
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_hr_rl_bulk_jobs_org_created"
  ON "public"."hr_reporting_line_bulk_jobs" ("org_id", "created_at" DESC, "id" DESC)
  WHERE "deleted_at" IS NULL;
--> statement-breakpoint

ALTER TABLE "public"."hr_reporting_line_bulk_jobs" DROP CONSTRAINT IF EXISTS "fk_hr_rl_bulk_jobs_org";
--> statement-breakpoint
ALTER TABLE "public"."hr_reporting_line_bulk_jobs" ADD CONSTRAINT "fk_hr_rl_bulk_jobs_org"
  FOREIGN KEY ("org_id") REFERENCES "public"."organizations" ("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."hr_reporting_line_bulk_jobs" VALIDATE CONSTRAINT "fk_hr_rl_bulk_jobs_org";
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "public"."hr_reporting_line_bulk_job_rows" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "org_id" text NOT NULL,
  "job_id" uuid NOT NULL,
  "row_number" integer NOT NULL,
  "employee_email" text NOT NULL,
  "employee_employment_id" integer,
  "requested_primary_manager_email" text,
  "requested_primary_manager_employment_id" integer,
  "current_primary_manager_employment_id" integer,
  "secondary_manager_email_1" text,
  "secondary_manager_email_2" text,
  "secondary_manager_email_3" text,
  "effective_from" date,
  "row_reason" text,
  "changes_last_24h" integer NOT NULL DEFAULT 0,
  "status" text NOT NULL,
  "codes" text,
  "message" text,
  "before_line_id" integer,
  "after_line_id" integer,
  CONSTRAINT "pk_hr_reporting_line_bulk_job_rows" PRIMARY KEY ("id"),
  CONSTRAINT "uniq_hr_rl_bulk_job_rows_job_row" UNIQUE ("org_id", "job_id", "row_number"),
  CONSTRAINT "chk_hr_rl_bulk_job_rows_row_number" CHECK ("row_number" >= 1),
  CONSTRAINT "chk_hr_rl_bulk_job_rows_status" CHECK (
    "status" IN ('READY', 'WARNING', 'ERROR', 'SKIPPED', 'COMMITTED', 'FAILED')
  ),
  CONSTRAINT "chk_hr_rl_bulk_job_rows_reason" CHECK ("row_reason" IS NULL OR char_length("row_reason") <= 1000),
  CONSTRAINT "chk_hr_rl_bulk_job_rows_changes" CHECK ("changes_last_24h" >= 0)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_hr_rl_bulk_job_rows_employee"
  ON "public"."hr_reporting_line_bulk_job_rows" ("org_id", "employee_employment_id")
  WHERE "employee_employment_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hr_rl_bulk_job_rows_requested_manager"
  ON "public"."hr_reporting_line_bulk_job_rows" ("org_id", "requested_primary_manager_employment_id")
  WHERE "requested_primary_manager_employment_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hr_rl_bulk_job_rows_current_manager"
  ON "public"."hr_reporting_line_bulk_job_rows" ("org_id", "current_primary_manager_employment_id")
  WHERE "current_primary_manager_employment_id" IS NOT NULL;
--> statement-breakpoint

ALTER TABLE "public"."hr_reporting_line_bulk_job_rows" DROP CONSTRAINT IF EXISTS "fk_hr_rl_bulk_job_rows_org";
--> statement-breakpoint
ALTER TABLE "public"."hr_reporting_line_bulk_job_rows" ADD CONSTRAINT "fk_hr_rl_bulk_job_rows_org"
  FOREIGN KEY ("org_id") REFERENCES "public"."organizations" ("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."hr_reporting_line_bulk_job_rows" VALIDATE CONSTRAINT "fk_hr_rl_bulk_job_rows_org";
--> statement-breakpoint

ALTER TABLE "public"."hr_reporting_line_bulk_job_rows" DROP CONSTRAINT IF EXISTS "fk_hr_rl_bulk_job_rows_job";
--> statement-breakpoint
ALTER TABLE "public"."hr_reporting_line_bulk_job_rows" ADD CONSTRAINT "fk_hr_rl_bulk_job_rows_job"
  FOREIGN KEY ("org_id", "job_id") REFERENCES "public"."hr_reporting_line_bulk_jobs" ("org_id", "id")
  ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."hr_reporting_line_bulk_job_rows" VALIDATE CONSTRAINT "fk_hr_rl_bulk_job_rows_job";
--> statement-breakpoint

ALTER TABLE "public"."hr_reporting_line_bulk_job_rows" DROP CONSTRAINT IF EXISTS "fk_hr_rl_bulk_job_rows_employee";
--> statement-breakpoint
ALTER TABLE "public"."hr_reporting_line_bulk_job_rows" ADD CONSTRAINT "fk_hr_rl_bulk_job_rows_employee"
  FOREIGN KEY ("org_id", "employee_employment_id") REFERENCES "public"."hr_employments" ("org_id", "id")
  ON DELETE SET NULL ("employee_employment_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."hr_reporting_line_bulk_job_rows" VALIDATE CONSTRAINT "fk_hr_rl_bulk_job_rows_employee";
--> statement-breakpoint

ALTER TABLE "public"."hr_reporting_line_bulk_job_rows" DROP CONSTRAINT IF EXISTS "fk_hr_rl_bulk_job_rows_requested_manager";
--> statement-breakpoint
ALTER TABLE "public"."hr_reporting_line_bulk_job_rows" ADD CONSTRAINT "fk_hr_rl_bulk_job_rows_requested_manager"
  FOREIGN KEY ("org_id", "requested_primary_manager_employment_id") REFERENCES "public"."hr_employments" ("org_id", "id")
  ON DELETE SET NULL ("requested_primary_manager_employment_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."hr_reporting_line_bulk_job_rows" VALIDATE CONSTRAINT "fk_hr_rl_bulk_job_rows_requested_manager";
--> statement-breakpoint

ALTER TABLE "public"."hr_reporting_line_bulk_job_rows" DROP CONSTRAINT IF EXISTS "fk_hr_rl_bulk_job_rows_current_manager";
--> statement-breakpoint
ALTER TABLE "public"."hr_reporting_line_bulk_job_rows" ADD CONSTRAINT "fk_hr_rl_bulk_job_rows_current_manager"
  FOREIGN KEY ("org_id", "current_primary_manager_employment_id") REFERENCES "public"."hr_employments" ("org_id", "id")
  ON DELETE SET NULL ("current_primary_manager_employment_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."hr_reporting_line_bulk_job_rows" VALIDATE CONSTRAINT "fk_hr_rl_bulk_job_rows_current_manager";
--> statement-breakpoint

ALTER TABLE "public"."hr_reporting_line_bulk_jobs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "public"."hr_reporting_line_bulk_jobs";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "public"."hr_reporting_line_bulk_jobs"
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint

ALTER TABLE "public"."hr_reporting_line_bulk_job_rows" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "public"."hr_reporting_line_bulk_job_rows";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "public"."hr_reporting_line_bulk_job_rows"
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."hr_reporting_line_bulk_jobs" TO streamline_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."hr_reporting_line_bulk_job_rows" TO streamline_app;
--> statement-breakpoint

DO $$
BEGIN
  IF (
    SELECT count(*) FROM pg_policies
    WHERE schemaname = 'public' AND policyname = 'tenant_isolation'
      AND tablename IN ('hr_reporting_line_bulk_jobs', 'hr_reporting_line_bulk_job_rows')
  ) <> 2 THEN
    RAISE EXCEPTION '1232 postcondition: tenant_isolation is missing on a bulk job table';
  END IF;
END $$;
