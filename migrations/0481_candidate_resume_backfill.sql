-- c16-06: Copy resume_text from candidates into candidate_resumes.
-- After this migration runs, verify the row count matches expectations before
-- running 0482, which drops candidates.resume_text.
-- VACUUM ANALYZE candidates is required after 0482 applies.

SET lock_timeout = '5s';

INSERT INTO candidate_resumes (candidate_id, resume_text)
SELECT id, resume_text
FROM candidates
WHERE resume_text IS NOT NULL
ON CONFLICT (candidate_id) DO NOTHING;
