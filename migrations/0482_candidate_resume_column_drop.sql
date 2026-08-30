-- c16-06: Drop candidates.resume_text after verifying the sidecar is complete.
-- Aborts if any candidate with resume_text has no matching candidate_resumes row.
--
-- Operator action required after this migration applies:
--   VACUUM ANALYZE candidates;
-- A column drop marks the column as dropped in the catalog. VACUUM ANALYZE
-- updates statistics so the planner sees the narrower row width.

SET lock_timeout = '5s';

-- PEND-DB: this file was one of fifteen missing from `_journal.json`, so it has
-- never run anywhere and is about to run everywhere. On a database where the
-- candidate resumes cutover was completed by hand the column is already gone, and both
-- the verification block and the DROP below read it by name — so the whole file
-- is short-circuited when there is nothing left to drop. The guards themselves
-- are unchanged: where the column is present they still refuse rather than
-- destroy.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'candidates' AND column_name = 'resume_text'
  ) THEN
    RAISE NOTICE '0482: candidates.resume_text is already gone; nothing to do.';
  END IF;
END $$;
--> statement-breakpoint

DO $$
DECLARE
  missing_count int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'candidates' AND column_name = 'resume_text') THEN
    RETURN;
  END IF;

  SELECT count(*) INTO missing_count
  FROM candidates c
  WHERE c.resume_text IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM candidate_resumes cr WHERE cr.candidate_id = c.id
    );

  IF missing_count > 0 THEN
    RAISE EXCEPTION
      'Resume back-fill incomplete: % candidate(s) have resume_text but no candidate_resumes row. Run 0481 before re-attempting this migration.',
      missing_count;
  END IF;
END $$;

ALTER TABLE candidates DROP COLUMN IF EXISTS resume_text;

-- Operator action required after applying:
--   VACUUM ANALYZE candidates;
