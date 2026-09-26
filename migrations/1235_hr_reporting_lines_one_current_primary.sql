-- 1235 — HRM-15: exactly one primary manager at a time, enforced by the database
--
-- Before: `excl_hr_reporting_lines_no_overlap` compared half-open ranges per line_type with no
-- org_id, while every reader (and the canonical writer) treats `effective_to` as INCLUSIVE. Two
-- writers (`applyManager`, `applyImportedManager`) closed lines half-open (`effective_to = next
-- effective_from`), so on a change day both lines matched `from <= d AND to >= d`. The constraint
-- also forbade two concurrent secondary lines, which a matrix organisation needs.
--
-- This migration:
--   1. creates `hr_reporting_lines_superseded`, where a line that was replaced before it ever took
--      effect (a same-day correction, a cancelled scheduled change) is kept instead of deleted;
--   2. normalises legacy half-open closes to inclusive ends (`effective_to - 1`); a legacy line
--      whose half-open range was empty (closed the day it started) never took effect and is moved
--      to the archive with reason LEGACY_EMPTY_PERIOD — history is moved, never deleted;
--   3. RAISES, with a count, if any overlap remains — it never deletes a row to make a constraint fit;
--   4. replaces the exclusion constraint with an org-scoped inclusive one for primary lines and a
--      per-manager one for secondary lines, adds the partial unique index on the open primary line,
--      and the date-order and no-self-manager CHECKs.
--
-- Audit query for the rollout note (overlapping primary lines under inclusive semantics):
--   SELECT a.org_id, a.employment_id, a.id, b.id FROM hr_reporting_lines a
--   JOIN hr_reporting_lines b ON b.org_id = a.org_id AND b.employment_id = a.employment_id
--     AND b.id > a.id AND a.line_type = 'primary' AND b.line_type = 'primary'
--     AND daterange(a.effective_from, a.effective_to, '[]') && daterange(b.effective_from, b.effective_to, '[]');
--
-- Rollback: migrations/rollback/1235_hr_reporting_lines_one_current_primary.down.sql
SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'btree_gist') THEN
    RAISE EXCEPTION '1235 precondition: btree_gist is not installed (BE-67)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'hr_reporting_lines' AND column_name = 'source'
  ) THEN
    RAISE EXCEPTION '1235 precondition: hr_reporting_lines.source (1234) is absent';
  END IF;
END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "public"."hr_reporting_lines_superseded" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "org_id" text NOT NULL,
  "line_id" integer NOT NULL,
  "employment_id" integer NOT NULL,
  "manager_employment_id" integer NOT NULL,
  "line_type" "public"."hr_reporting_line_type" NOT NULL,
  "effective_from" date NOT NULL,
  "effective_to" date NOT NULL,
  "source" text NOT NULL,
  "change_reason" text,
  "relationship_label" text,
  "bulk_job_id" uuid,
  "request_id" uuid,
  "created_by" text,
  "created_at" timestamp without time zone NOT NULL,
  "superseded_reason" text NOT NULL,
  "superseded_by" text,
  "superseded_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "pk_hr_reporting_lines_superseded" PRIMARY KEY ("id"),
  CONSTRAINT "uniq_hr_rl_superseded_org_line" UNIQUE ("org_id", "line_id"),
  CONSTRAINT "chk_hr_rl_superseded_reason" CHECK ("superseded_reason" IN ('REPLACED', 'LEGACY_EMPTY_PERIOD'))
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_hr_rl_superseded_recent"
  ON "public"."hr_reporting_lines_superseded" ("org_id", "employment_id", "line_type", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hr_rl_superseded_manager"
  ON "public"."hr_reporting_lines_superseded" ("org_id", "manager_employment_id");
--> statement-breakpoint

ALTER TABLE "public"."hr_reporting_lines_superseded" DROP CONSTRAINT IF EXISTS "fk_hr_rl_superseded_org";
--> statement-breakpoint
ALTER TABLE "public"."hr_reporting_lines_superseded" ADD CONSTRAINT "fk_hr_rl_superseded_org"
  FOREIGN KEY ("org_id") REFERENCES "public"."organizations" ("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."hr_reporting_lines_superseded" VALIDATE CONSTRAINT "fk_hr_rl_superseded_org";
--> statement-breakpoint

ALTER TABLE "public"."hr_reporting_lines_superseded" DROP CONSTRAINT IF EXISTS "fk_hr_rl_superseded_employment";
--> statement-breakpoint
ALTER TABLE "public"."hr_reporting_lines_superseded" ADD CONSTRAINT "fk_hr_rl_superseded_employment"
  FOREIGN KEY ("org_id", "employment_id") REFERENCES "public"."hr_employments" ("org_id", "id")
  ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."hr_reporting_lines_superseded" VALIDATE CONSTRAINT "fk_hr_rl_superseded_employment";
--> statement-breakpoint

ALTER TABLE "public"."hr_reporting_lines_superseded" DROP CONSTRAINT IF EXISTS "fk_hr_rl_superseded_manager";
--> statement-breakpoint
ALTER TABLE "public"."hr_reporting_lines_superseded" ADD CONSTRAINT "fk_hr_rl_superseded_manager"
  FOREIGN KEY ("org_id", "manager_employment_id") REFERENCES "public"."hr_employments" ("org_id", "id")
  ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."hr_reporting_lines_superseded" VALIDATE CONSTRAINT "fk_hr_rl_superseded_manager";
--> statement-breakpoint

ALTER TABLE "public"."hr_reporting_lines_superseded" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "public"."hr_reporting_lines_superseded";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "public"."hr_reporting_lines_superseded"
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."hr_reporting_lines_superseded" TO streamline_app;
--> statement-breakpoint

LOCK TABLE "public"."hr_reporting_lines" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint

DO $$
DECLARE
  empty_moved integer;
  half_open_fixed integer;
  inverted integer;
  self_managed integer;
  primary_overlaps integer;
  secondary_overlaps integer;
BEGIN
  SELECT count(*) INTO inverted FROM "public"."hr_reporting_lines" WHERE "effective_to" < "effective_from";
  IF inverted > 0 THEN
    RAISE EXCEPTION '1235: % reporting line(s) end before they start; resolve them by hand before this migration', inverted;
  END IF;

  SELECT count(*) INTO self_managed FROM "public"."hr_reporting_lines" WHERE "employment_id" = "manager_employment_id";
  IF self_managed > 0 THEN
    RAISE EXCEPTION '1235: % reporting line(s) name the employee as their own manager; resolve them by hand before this migration', self_managed;
  END IF;

  WITH empty_period AS (
    SELECT line.id
    FROM "public"."hr_reporting_lines" line
    WHERE line.effective_from = line.effective_to
      AND EXISTS (
        SELECT 1 FROM "public"."hr_reporting_lines" successor
        WHERE successor.org_id = line.org_id
          AND successor.employment_id = line.employment_id
          AND successor.id <> line.id
          AND successor.effective_from = line.effective_to
          AND (
            (line.line_type = 'primary' AND successor.line_type = 'primary')
            OR (line.line_type <> 'primary' AND successor.line_type <> 'primary'
                AND successor.manager_employment_id = line.manager_employment_id)
          )
      )
  ),
  archived AS (
    INSERT INTO "public"."hr_reporting_lines_superseded" (
      org_id, line_id, employment_id, manager_employment_id, line_type, effective_from, effective_to,
      source, change_reason, relationship_label, bulk_job_id, request_id, created_by, created_at,
      superseded_reason
    )
    SELECT line.org_id, line.id, line.employment_id, line.manager_employment_id, line.line_type,
           line.effective_from, line.effective_to, line.source, line.change_reason,
           line.relationship_label, line.bulk_job_id, line.request_id, line.created_by, line.created_at,
           'LEGACY_EMPTY_PERIOD'
    FROM "public"."hr_reporting_lines" line
    WHERE line.id IN (SELECT id FROM empty_period)
    RETURNING line_id
  )
  DELETE FROM "public"."hr_reporting_lines" WHERE id IN (SELECT line_id FROM archived);
  GET DIAGNOSTICS empty_moved = ROW_COUNT;

  UPDATE "public"."hr_reporting_lines" line
  SET effective_to = line.effective_to - 1
  WHERE line.effective_to <> 'infinity'::date
    AND line.effective_from < line.effective_to
    AND EXISTS (
      SELECT 1 FROM "public"."hr_reporting_lines" successor
      WHERE successor.org_id = line.org_id
        AND successor.employment_id = line.employment_id
        AND successor.id <> line.id
        AND successor.effective_from = line.effective_to
        AND (
          (line.line_type = 'primary' AND successor.line_type = 'primary')
          OR (line.line_type <> 'primary' AND successor.line_type <> 'primary'
              AND successor.manager_employment_id = line.manager_employment_id)
        )
    );
  GET DIAGNOSTICS half_open_fixed = ROW_COUNT;

  RAISE NOTICE '1235: % legacy half-open line(s) closed inclusively; % empty-period line(s) moved to hr_reporting_lines_superseded',
    half_open_fixed, empty_moved;

  SELECT count(*) INTO primary_overlaps
  FROM "public"."hr_reporting_lines" a
  JOIN "public"."hr_reporting_lines" b
    ON b.org_id = a.org_id AND b.employment_id = a.employment_id AND b.id > a.id
   AND a.line_type = 'primary' AND b.line_type = 'primary'
   AND daterange(a.effective_from, a.effective_to, '[]') && daterange(b.effective_from, b.effective_to, '[]');

  SELECT count(*) INTO secondary_overlaps
  FROM "public"."hr_reporting_lines" a
  JOIN "public"."hr_reporting_lines" b
    ON b.org_id = a.org_id AND b.employment_id = a.employment_id AND b.id > a.id
   AND b.manager_employment_id = a.manager_employment_id
   AND a.line_type <> 'primary' AND b.line_type <> 'primary'
   AND daterange(a.effective_from, a.effective_to, '[]') && daterange(b.effective_from, b.effective_to, '[]');

  IF primary_overlaps > 0 OR secondary_overlaps > 0 THEN
    RAISE EXCEPTION '1235: % overlapping primary pair(s) and % overlapping secondary pair(s) remain after normalisation; run the audit query in this file''s header and resolve them by hand — this migration never deletes history to fit a constraint',
      primary_overlaps, secondary_overlaps;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "public"."hr_reporting_lines" DROP CONSTRAINT IF EXISTS "excl_hr_reporting_lines_no_overlap";
--> statement-breakpoint
ALTER TABLE "public"."hr_reporting_lines" DROP CONSTRAINT IF EXISTS "excl_hr_reporting_lines_primary_overlap";
--> statement-breakpoint
ALTER TABLE "public"."hr_reporting_lines" ADD CONSTRAINT "excl_hr_reporting_lines_primary_overlap"
  EXCLUDE USING gist (
    "org_id" WITH =,
    "employment_id" WITH =,
    daterange("effective_from", "effective_to", '[]') WITH &&
  ) WHERE ("line_type" = 'primary');
--> statement-breakpoint
ALTER TABLE "public"."hr_reporting_lines" DROP CONSTRAINT IF EXISTS "excl_hr_reporting_lines_secondary_overlap";
--> statement-breakpoint
ALTER TABLE "public"."hr_reporting_lines" ADD CONSTRAINT "excl_hr_reporting_lines_secondary_overlap"
  EXCLUDE USING gist (
    "org_id" WITH =,
    "employment_id" WITH =,
    "manager_employment_id" WITH =,
    daterange("effective_from", "effective_to", '[]') WITH &&
  ) WHERE ("line_type" <> 'primary');
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_hr_reporting_lines_open_primary"
  ON "public"."hr_reporting_lines" ("org_id", "employment_id")
  WHERE "line_type" = 'primary' AND "effective_to" = 'infinity'::date;
--> statement-breakpoint

ALTER TABLE "public"."hr_reporting_lines" DROP CONSTRAINT IF EXISTS "chk_hr_reporting_lines_dates";
--> statement-breakpoint
ALTER TABLE "public"."hr_reporting_lines" ADD CONSTRAINT "chk_hr_reporting_lines_dates"
  CHECK ("effective_from" <= "effective_to") NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."hr_reporting_lines" VALIDATE CONSTRAINT "chk_hr_reporting_lines_dates";
--> statement-breakpoint

ALTER TABLE "public"."hr_reporting_lines" DROP CONSTRAINT IF EXISTS "chk_hr_reporting_lines_not_self";
--> statement-breakpoint
ALTER TABLE "public"."hr_reporting_lines" ADD CONSTRAINT "chk_hr_reporting_lines_not_self"
  CHECK ("employment_id" <> "manager_employment_id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "public"."hr_reporting_lines" VALIDATE CONSTRAINT "chk_hr_reporting_lines_not_self";
--> statement-breakpoint

DO $$
BEGIN
  IF (
    SELECT count(*) FROM pg_constraint
    WHERE conrelid = 'public.hr_reporting_lines'::regclass
      AND conname IN ('excl_hr_reporting_lines_primary_overlap', 'excl_hr_reporting_lines_secondary_overlap',
                      'chk_hr_reporting_lines_dates', 'chk_hr_reporting_lines_not_self')
  ) <> 4 THEN
    RAISE EXCEPTION '1235 postcondition: a reporting-line constraint is missing';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.hr_reporting_lines'::regclass AND conname = 'excl_hr_reporting_lines_no_overlap'
  ) THEN
    RAISE EXCEPTION '1235 postcondition: the half-open exclusion constraint is still present';
  END IF;
END $$;
