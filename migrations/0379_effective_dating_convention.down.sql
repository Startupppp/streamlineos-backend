-- Rollback for 0379_effective_dating_convention.sql
--
-- CAUTION: The data backfill (NULL → 'infinity') cannot be perfectly reversed.
-- This script performs a best-effort semantic reversal: rows where effective_to
-- is 'infinity'::date are set back to NULL. This is correct for rows that were
-- originally NULL; rows that the application explicitly set to 'infinity' after
-- the forward migration was applied will also be set to NULL, which changes their
-- meaning. Audit the data before relying on the reverted state.

-- ─── hr_reporting_lines (reverse order: constraint → NOT NULL → data) ─────────
ALTER TABLE hr_reporting_lines
  DROP CONSTRAINT IF EXISTS excl_hr_reporting_lines_no_overlap;

ALTER TABLE hr_reporting_lines
  ALTER COLUMN effective_to DROP NOT NULL,
  ALTER COLUMN effective_to DROP DEFAULT;

UPDATE hr_reporting_lines
  SET effective_to = NULL
  WHERE effective_to = 'infinity'::date;

-- ─── hr_effective_dated_changes ───────────────────────────────────────────────
ALTER TABLE hr_effective_dated_changes
  DROP CONSTRAINT IF EXISTS excl_hr_eff_changes_no_overlap;

ALTER TABLE hr_effective_dated_changes
  ALTER COLUMN effective_to DROP NOT NULL,
  ALTER COLUMN effective_to DROP DEFAULT;

UPDATE hr_effective_dated_changes
  SET effective_to = NULL
  WHERE effective_to = 'infinity'::date;
