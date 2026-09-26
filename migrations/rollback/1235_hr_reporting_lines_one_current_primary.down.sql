-- Rollback for 1235_hr_reporting_lines_one_current_primary
--
-- Restores the half-open exclusion constraint and drops the inclusive constraints, the open-primary
-- unique index and the superseded-line archive. Legacy empty-period lines are moved back into
-- hr_reporting_lines (their half-open range is empty, so the old constraint accepts them).
--
-- Refuses when the archive holds a line the application superseded (REPLACED): dropping the archive
-- would destroy that history, and restoring it would overlap the line that replaced it.
--
-- The inclusive normalisation of legacy half-open ends is NOT reversed: `effective_to - 1` is what
-- every reader already assumed those rows meant.
SET lock_timeout = '5s';

DO $$
DECLARE
  replaced integer;
BEGIN
  SELECT count(*) INTO replaced FROM "public"."hr_reporting_lines_superseded" WHERE "superseded_reason" = 'REPLACED';
  IF replaced > 0 THEN
    RAISE EXCEPTION 'rollback 1235: % superseded line(s) were written by the application; export hr_reporting_lines_superseded before rolling back', replaced;
  END IF;
END $$;

ALTER TABLE "public"."hr_reporting_lines" DROP CONSTRAINT IF EXISTS "chk_hr_reporting_lines_not_self";
ALTER TABLE "public"."hr_reporting_lines" DROP CONSTRAINT IF EXISTS "chk_hr_reporting_lines_dates";
DROP INDEX IF EXISTS "public"."uniq_hr_reporting_lines_open_primary";
ALTER TABLE "public"."hr_reporting_lines" DROP CONSTRAINT IF EXISTS "excl_hr_reporting_lines_secondary_overlap";
ALTER TABLE "public"."hr_reporting_lines" DROP CONSTRAINT IF EXISTS "excl_hr_reporting_lines_primary_overlap";

INSERT INTO "public"."hr_reporting_lines" (
  id, org_id, employment_id, manager_employment_id, line_type, effective_from, effective_to,
  source, change_reason, relationship_label, bulk_job_id, request_id, created_by, created_at
)
SELECT line_id, org_id, employment_id, manager_employment_id, line_type, effective_from, effective_to,
       source, change_reason, relationship_label, bulk_job_id, request_id, created_by, created_at
FROM "public"."hr_reporting_lines_superseded"
WHERE "superseded_reason" = 'LEGACY_EMPTY_PERIOD'
ON CONFLICT (id) DO NOTHING;

ALTER TABLE "public"."hr_reporting_lines" ADD CONSTRAINT "excl_hr_reporting_lines_no_overlap"
  EXCLUDE USING gist (
    "employment_id" WITH =,
    "line_type" WITH =,
    daterange("effective_from", "effective_to", '[)') WITH &&
  );

DROP TABLE IF EXISTS "public"."hr_reporting_lines_superseded";
