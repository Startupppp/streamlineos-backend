SET statement_timeout = 0;

-- =============================================================================
-- 0368 — remove the job title "CEO" from the offboarding schema
-- =============================================================================
-- Wave 24 collapsed the role model to six STRUCTURAL roles; job titles became
-- user-created role groups. The offboarding tables still encoded a job title in
-- their column names and status values, implying a "CEO" role that no longer
-- exists in the model.
--
-- `hr_*` is kept — `hr` is a real module. Only `ceo_*` (a job title) is renamed,
-- to the neutral `final_*` — it is the FINAL review stage, whoever performs it.
-- Who may perform that stage was already permission-gated (`hr:exit:approve`),
-- so this migration changes naming only, never authorisation.
--
-- Column renames are metadata-only. Enum value renames use ALTER TYPE ...
-- RENAME VALUE, which rewrites the label in place — existing rows keep pointing
-- at the same value and need no UPDATE.
-- =============================================================================

ALTER TABLE "resignations" RENAME COLUMN "ceo_reviewed_by" TO "final_reviewed_by";
--> statement-breakpoint
ALTER TABLE "resignations" RENAME COLUMN "ceo_reviewed_at" TO "final_reviewed_at";
--> statement-breakpoint
ALTER TABLE "resignations" RENAME COLUMN "ceo_remarks" TO "final_remarks";
--> statement-breakpoint

ALTER TABLE "terminations" RENAME COLUMN "ceo_reviewed_by" TO "final_reviewed_by";
--> statement-breakpoint
ALTER TABLE "terminations" RENAME COLUMN "ceo_reviewed_at" TO "final_reviewed_at";
--> statement-breakpoint
ALTER TABLE "terminations" RENAME COLUMN "ceo_remarks" TO "final_remarks";
--> statement-breakpoint

-- resignation_status: CEO_APPROVED -> FINAL_APPROVED
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'resignation_status' AND e.enumlabel = 'CEO_APPROVED'
  ) THEN
    ALTER TYPE "resignation_status" RENAME VALUE 'CEO_APPROVED' TO 'FINAL_APPROVED';
  END IF;
END $$;
--> statement-breakpoint

-- termination_status: PENDING_CEO -> PENDING_FINAL
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'termination_status' AND e.enumlabel = 'PENDING_CEO'
  ) THEN
    ALTER TYPE "termination_status" RENAME VALUE 'PENDING_CEO' TO 'PENDING_FINAL';
  END IF;
END $$;
--> statement-breakpoint

-- Fail loudly if any 'CEO' remnant survived in either enum or as a column.
DO $$
DECLARE
  leftover integer;
BEGIN
  SELECT count(*) INTO leftover
  FROM pg_enum e
  JOIN pg_type t ON t.oid = e.enumtypid
  WHERE t.typname IN ('resignation_status', 'termination_status')
    AND e.enumlabel LIKE '%CEO%';

  IF leftover > 0 THEN
    RAISE EXCEPTION '0368: % CEO enum label(s) still present', leftover;
  END IF;

  SELECT count(*) INTO leftover
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name IN ('resignations', 'terminations')
    AND column_name LIKE 'ceo%';

  IF leftover > 0 THEN
    RAISE EXCEPTION '0368: % ceo_* column(s) still present', leftover;
  END IF;
END $$;
