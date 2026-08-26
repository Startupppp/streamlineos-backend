-- c16-06: Create the candidate_resumes sidecar table.
-- resume_text is large text on a table that is listed and filtered constantly.
-- Moving it to a one-to-one sidecar lets list scans read narrower rows.
-- 0481 back-fills existing text; 0482 drops candidates.resume_text after verification.

SET lock_timeout = '5s';

CREATE TABLE candidate_resumes (
  id          serial        PRIMARY KEY,
  candidate_id integer      NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  resume_text text          NOT NULL,
  created_at  timestamp     NOT NULL DEFAULT now(),
  updated_at  timestamp     NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uniq_candidate_resumes_candidate_id
  ON candidate_resumes (candidate_id);
