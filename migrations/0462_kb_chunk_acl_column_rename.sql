-- Reconciles a migration that was edited after it had been applied.
--
-- 0461 originally added `visibility`, `project_id` and `created_by_id` and was applied
-- in that form. It was then rewritten to add `page_visibility`, `page_project_id` and
-- `page_created_by_id` — the clearer names, since these mirror the page rather than
-- describing the chunk. Drizzle skips by timestamp, so the rewritten 0461 will never
-- run, and the schema now expects columns the database does not have.
--
-- Renaming forward rather than re-editing 0461: an applied migration is history, and a
-- database that took the first form needs a second step, not a rewritten first one.
-- Guarded both ways so it is a no-op on a database built from the rewritten 0461.

SET lock_timeout = '5s';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'kb_article_chunks' AND column_name = 'visibility')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name = 'kb_article_chunks' AND column_name = 'page_visibility') THEN
    ALTER TABLE kb_article_chunks RENAME COLUMN visibility TO page_visibility;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'kb_article_chunks' AND column_name = 'project_id')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name = 'kb_article_chunks' AND column_name = 'page_project_id') THEN
    ALTER TABLE kb_article_chunks RENAME COLUMN project_id TO page_project_id;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'kb_article_chunks' AND column_name = 'created_by_id')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name = 'kb_article_chunks' AND column_name = 'page_created_by_id') THEN
    ALTER TABLE kb_article_chunks RENAME COLUMN created_by_id TO page_created_by_id;
  END IF;
END $$;
