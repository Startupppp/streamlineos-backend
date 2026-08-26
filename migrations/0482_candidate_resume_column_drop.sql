-- c16-06: Drop candidates.resume_text after verifying the sidecar is complete.
-- Aborts if any candidate with resume_text has no matching candidate_resumes row.
--
-- Operator action required after this migration applies:
--   VACUUM ANALYZE candidates;
-- A column drop marks the column as dropped in the catalog. VACUUM ANALYZE
-- updates statistics so the planner sees the narrower row width.

SET lock_timeout = '5s';

DO $$
DECLARE
  missing_count int;
BEGIN
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

ALTER TABLE candidates DROP COLUMN resume_text;

-- Operator action required after applying:
--   VACUUM ANALYZE candidates;
