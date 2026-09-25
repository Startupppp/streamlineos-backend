-- Rollback for 1217_hr_reporting_lines_provenance
-- Roll back 1218 first. Drops the provenance columns with their constraints and indexes; the
-- source, reason, label, fallback confirmation and job/request links recorded since are lost.
SET lock_timeout = '5s';

DROP INDEX IF EXISTS "public"."idx_hr_reporting_lines_recent_primary";
DROP INDEX IF EXISTS "public"."idx_hr_reporting_lines_request";
DROP INDEX IF EXISTS "public"."idx_hr_reporting_lines_bulk_job";
DROP INDEX IF EXISTS "public"."idx_hr_reporting_lines_manager_type";

ALTER TABLE "public"."hr_reporting_lines" DROP CONSTRAINT IF EXISTS "fk_hr_reporting_lines_request";
ALTER TABLE "public"."hr_reporting_lines" DROP CONSTRAINT IF EXISTS "fk_hr_reporting_lines_bulk_job";
ALTER TABLE "public"."hr_reporting_lines" DROP CONSTRAINT IF EXISTS "chk_hr_reporting_lines_label";
ALTER TABLE "public"."hr_reporting_lines" DROP CONSTRAINT IF EXISTS "chk_hr_reporting_lines_change_reason";
ALTER TABLE "public"."hr_reporting_lines" DROP CONSTRAINT IF EXISTS "chk_hr_reporting_lines_source";

ALTER TABLE "public"."hr_reporting_lines"
  DROP COLUMN IF EXISTS "updated_at",
  DROP COLUMN IF EXISTS "request_id",
  DROP COLUMN IF EXISTS "bulk_job_id",
  DROP COLUMN IF EXISTS "fallback_confirmed_by",
  DROP COLUMN IF EXISTS "fallback_confirmed_at",
  DROP COLUMN IF EXISTS "relationship_label",
  DROP COLUMN IF EXISTS "change_reason",
  DROP COLUMN IF EXISTS "source";
