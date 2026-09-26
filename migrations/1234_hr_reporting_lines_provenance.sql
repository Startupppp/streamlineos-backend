-- 1234 — HRM-15: provenance columns on `hr_reporting_lines`
--
-- Every reporting line now records how it came to exist (`source`), why (`change_reason`), the
-- label of a secondary relationship, HR's confirmation of a fallback primary, and the bulk job or
-- employee request that produced it. Existing rows become `source = 'MIGRATED'` through the column
-- default (PRD §8.4 step 3); a constant default is a catalog-only change, so no table rewrite.
--
-- CHECKs and FKs are added NOT VALID and validated separately (BE-62/63). `relationship_label` is
-- only meaningful on a secondary line, so the CHECK forbids it on a primary one.
--
-- Rollback: migrations/rollback/1234_hr_reporting_lines_provenance.down.sql
SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('public.hr_reporting_line_bulk_jobs') IS NULL THEN
    RAISE EXCEPTION '1234 precondition: hr_reporting_line_bulk_jobs (1232) is absent';
  END IF;
  IF to_regclass('public.hr_reporting_manager_requests') IS NULL THEN
    RAISE EXCEPTION '1234 precondition: hr_reporting_manager_requests (1233) is absent';
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "public"."hr_reporting_lines"
  ADD COLUMN IF NOT EXISTS "source" text NOT NULL DEFAULT 'MIGRATED',
  ADD COLUMN IF NOT EXISTS "change_reason" text,
  ADD COLUMN IF NOT EXISTS "relationship_label" text,
  ADD COLUMN IF NOT EXISTS "fallback_confirmed_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "fallback_confirmed_by" text,
  ADD COLUMN IF NOT EXISTS "bulk_job_id" uuid,
  ADD COLUMN IF NOT EXISTS "request_id" uuid,
  ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone NOT NULL DEFAULT now();
--> statement-breakpoint

ALTER TABLE "public"."hr_reporting_lines" DROP CONSTRAINT IF EXISTS "chk_hr_reporting_lines_source";
--> statement-breakpoint
ALTER TABLE "public"."hr_reporting_lines" ADD CONSTRAINT "chk_hr_reporting_lines_source" CHECK (
  "source" IN (
    'MANUAL', 'MIGRATED', 'ONBOARDING_SELECTED', 'ONBOARDING_FALLBACK', 'BULK_ONBOARDING',
    'STAGED_IMPORT', 'EMPLOYEE_REQUEST', 'BULK_REASSIGNMENT', 'EMERGENCY_OVERRIDE', 'EFFECTIVE_CHANGE'
  )
) NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."hr_reporting_lines" VALIDATE CONSTRAINT "chk_hr_reporting_lines_source";
--> statement-breakpoint

ALTER TABLE "public"."hr_reporting_lines" DROP CONSTRAINT IF EXISTS "chk_hr_reporting_lines_change_reason";
--> statement-breakpoint
ALTER TABLE "public"."hr_reporting_lines" ADD CONSTRAINT "chk_hr_reporting_lines_change_reason"
  CHECK ("change_reason" IS NULL OR char_length("change_reason") <= 1000) NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."hr_reporting_lines" VALIDATE CONSTRAINT "chk_hr_reporting_lines_change_reason";
--> statement-breakpoint

ALTER TABLE "public"."hr_reporting_lines" DROP CONSTRAINT IF EXISTS "chk_hr_reporting_lines_label";
--> statement-breakpoint
ALTER TABLE "public"."hr_reporting_lines" ADD CONSTRAINT "chk_hr_reporting_lines_label" CHECK (
  "relationship_label" IS NULL
  OR ("line_type" <> 'primary' AND char_length(btrim("relationship_label")) BETWEEN 1 AND 60)
) NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."hr_reporting_lines" VALIDATE CONSTRAINT "chk_hr_reporting_lines_label";
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_hr_reporting_lines_manager_type"
  ON "public"."hr_reporting_lines" ("org_id", "manager_employment_id", "line_type", "effective_to");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hr_reporting_lines_bulk_job"
  ON "public"."hr_reporting_lines" ("org_id", "bulk_job_id")
  WHERE "bulk_job_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hr_reporting_lines_request"
  ON "public"."hr_reporting_lines" ("org_id", "request_id")
  WHERE "request_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hr_reporting_lines_recent_primary"
  ON "public"."hr_reporting_lines" ("org_id", "employment_id", "created_at")
  WHERE "line_type" = 'primary';
--> statement-breakpoint

ALTER TABLE "public"."hr_reporting_lines" DROP CONSTRAINT IF EXISTS "fk_hr_reporting_lines_bulk_job";
--> statement-breakpoint
ALTER TABLE "public"."hr_reporting_lines" ADD CONSTRAINT "fk_hr_reporting_lines_bulk_job"
  FOREIGN KEY ("org_id", "bulk_job_id") REFERENCES "public"."hr_reporting_line_bulk_jobs" ("org_id", "id")
  ON DELETE SET NULL ("bulk_job_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."hr_reporting_lines" VALIDATE CONSTRAINT "fk_hr_reporting_lines_bulk_job";
--> statement-breakpoint

ALTER TABLE "public"."hr_reporting_lines" DROP CONSTRAINT IF EXISTS "fk_hr_reporting_lines_request";
--> statement-breakpoint
ALTER TABLE "public"."hr_reporting_lines" ADD CONSTRAINT "fk_hr_reporting_lines_request"
  FOREIGN KEY ("org_id", "request_id") REFERENCES "public"."hr_reporting_manager_requests" ("org_id", "id")
  ON DELETE SET NULL ("request_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."hr_reporting_lines" VALIDATE CONSTRAINT "fk_hr_reporting_lines_request";
--> statement-breakpoint

DO $$
DECLARE
  migrated integer;
BEGIN
  SELECT count(*) INTO migrated FROM "public"."hr_reporting_lines" WHERE "source" = 'MIGRATED';
  RAISE NOTICE '1234: % existing reporting line(s) carry source = MIGRATED', migrated;
END $$;
