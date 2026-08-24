SET lock_timeout = '5s';

-- Add the three ACL columns the page visibility predicate uses.
-- All three are nullable so the ADD COLUMN is non-blocking.
-- Backfill below; the search query filter handles NULL as "not visible"
-- naturally because NULL IN ('org','public') evaluates to NULL (false).
ALTER TABLE kb_article_chunks
  ADD COLUMN IF NOT EXISTS visibility    text,
  ADD COLUMN IF NOT EXISTS project_id    integer,
  ADD COLUMN IF NOT EXISTS created_by_id text;

-- Backfill from kb_pages for every chunk that originates from a page.
-- Runs in id-range batches to keep individual UPDATE statements small.
-- In a fresh dev environment this is a no-op (no rows with page_id set).
DO $$
DECLARE
  batch_size INT := 500;
  min_id     INT;
  max_id     INT;
  cur        INT;
BEGIN
  SELECT MIN(id), MAX(id)
    INTO min_id, max_id
    FROM kb_article_chunks
   WHERE page_id IS NOT NULL;

  IF min_id IS NULL THEN RETURN; END IF;

  cur := min_id;
  WHILE cur <= max_id LOOP
    UPDATE kb_article_chunks c
       SET visibility    = p.visibility,
           project_id    = p.project_id,
           created_by_id = p.created_by_id
      FROM kb_pages p
     WHERE c.page_id = p.id
       AND c.id >= cur
       AND c.id <  cur + batch_size
       AND c.page_id IS NOT NULL;

    cur := cur + batch_size;
  END LOOP;
END $$;

-- Covering index for the ACL predicate on page-sourced chunks.
-- org_id MUST lead: the RLS policy qual is not leakproof, so the planner
-- refuses an index whose scan would expose org_id before the policy fires.
-- VACUUM ANALYZE kb_article_chunks after this migration is applied:
-- a table rewrite empties the visibility map and stale stats can turn
-- a 53-block scan into 200 000 blocks (observed on this codebase twice).
CREATE INDEX IF NOT EXISTS idx_kb_chunks_org_page_acl
  ON kb_article_chunks (org_id, visibility, project_id, created_by_id)
 WHERE page_id IS NOT NULL;
