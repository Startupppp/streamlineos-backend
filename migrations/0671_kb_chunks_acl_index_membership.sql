-- Re-create the retrieval ACL index with the membership arm added by 0670. Every column the
-- visibility predicate touches must be IN the index, `org_id` first, or the RLS qual forces a heap
-- fetch and the planner refuses an index-only scan outright (backend/CLAUDE.md §7).
--
-- Not CONCURRENTLY: db:migrate wraps each file in a transaction and CONCURRENTLY is rejected inside
-- one (same reasoning as 0475/0497). On a large live table, run the CONCURRENTLY pair by hand
-- first — the IF EXISTS / IF NOT EXISTS guards make this file a no-op afterwards.
SET lock_timeout = '5s';
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_kb_chunks_org_page_acl";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_chunks_org_page_acl"
  ON "kb_article_chunks" (
    "org_id",
    "page_visibility",
    "page_project_id",
    "page_created_by_id",
    "page_created_by_membership_id"
  )
  WHERE "page_id" IS NOT NULL;
