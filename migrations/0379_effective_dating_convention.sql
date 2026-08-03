-- Batch 12 / S1 Wave 5: Effective-dating convention — NULL → 'infinity', NOT NULL,
-- EXCLUDE non-overlap constraints on hr_effective_dated_changes and hr_reporting_lines.
--
-- *** RUN THE PRE-FLIGHT OVERLAP QUERIES BEFORE APPLYING THIS MIGRATION ***
-- See orchestrator report for the two pre-flight SELECT statements.
-- Zero rows from each query = safe to proceed.
-- Any rows = overlapping data exists and MUST be resolved before this migration;
-- the EXCLUDE constraints will fail to add if overlaps are present.
--
-- IRREVERSIBILITY WARNING:
--   Steps 2 and 5 (ALTER COLUMN ... SET NOT NULL) are structurally irreversible
--   without a compensating migration that re-allows NULL.
--   The data backfill (NULL → 'infinity') is semantically irreversible: the companion
--   .down.sql does a best-effort reversal (infinity → NULL) but cannot distinguish
--   rows that were originally NULL from those explicitly set to infinity by the app.
--   Steps 3 and 6 (EXCLUDE constraints) ARE reversible (DROP CONSTRAINT).

SET statement_timeout = 0;  -- backfill may be slow on large tables

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ─── hr_effective_dated_changes ───────────────────────────────────────────────

-- Step 1: Backfill — NULL meant "currently active" (no end date).
--         Map that semantic to the half-open convention: effective_to = 'infinity'.
UPDATE hr_effective_dated_changes
  SET effective_to = 'infinity'::date
  WHERE effective_to IS NULL;

-- Step 2: Enforce NOT NULL with 'infinity' as the default for future inserts.
--         IRREVERSIBLE structural change.
ALTER TABLE hr_effective_dated_changes
  ALTER COLUMN effective_to SET DEFAULT 'infinity'::date,
  ALTER COLUMN effective_to SET NOT NULL;

-- Step 3: Non-overlap exclusion constraint on APPLIED rows only.
--         "Two applied changes for the same (employment, change_type) must not
--          have overlapping validity intervals."
--         This makes "two salaries active on the same day" a DB error, not a
--         support ticket. Partial WHERE keeps draft/approved rows unaffected.
ALTER TABLE hr_effective_dated_changes
  ADD CONSTRAINT excl_hr_eff_changes_no_overlap
  EXCLUDE USING gist (
    employment_id WITH =,
    change_type   WITH =,
    daterange(effective_from, effective_to, '[)') WITH &&
  )
  WHERE (status = 'applied');

-- ─── hr_reporting_lines ───────────────────────────────────────────────────────

-- Step 4: Backfill
UPDATE hr_reporting_lines
  SET effective_to = 'infinity'::date
  WHERE effective_to IS NULL;

-- Step 5: Enforce NOT NULL. IRREVERSIBLE structural change.
ALTER TABLE hr_reporting_lines
  ALTER COLUMN effective_to SET DEFAULT 'infinity'::date,
  ALTER COLUMN effective_to SET NOT NULL;

-- Step 6: Non-overlap exclusion constraint — no partial WHERE (all rows participate).
--         "One active reporting line of each type per (employment, line_type) at a time."
--         Enables dotted-line / matrix managers: each line_type has its own non-overlap
--         envelope, so primary + dotted can coexist for the same employment.
ALTER TABLE hr_reporting_lines
  ADD CONSTRAINT excl_hr_reporting_lines_no_overlap
  EXCLUDE USING gist (
    employment_id WITH =,
    line_type     WITH =,
    daterange(effective_from, effective_to, '[)') WITH &&
  );
