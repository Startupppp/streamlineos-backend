-- 0498: KB ingestion hardening — wiki page id probe + acl/content revision columns.
--
-- Part A: SECURITY DEFINER id probe for wiki pages (ticket c27-01).
--
-- idx_kb_pages_fts is a GIN index on the generated `fts` tsvector column.
-- Under RLS the ts_match_vq operator is proleakproof=false, so the planner cannot
-- use the index for streamline_app (same problem as tickets solved on 0424/0453).
-- A SECURITY DEFINER function owned by the BYPASSRLS owner escapes the barrier:
-- org comes from app.current_org_id() inside the function and never from a
-- parameter (fails closed 42501 with no GUC), returns ids only and never row data,
-- the caller re-reads those ids under RLS with its own visibility predicates, and
-- EXECUTE is revoked from PUBLIC.
--
-- The caller requests cap+1 ids. Getting cap+1 back means the term is too broad;
-- the caller falls back to fts @@ tsquery which is a seq scan under LIMIT and
-- stops as soon as enough rows are found — fast in exactly the broad case.
--
-- Part B: acl_revision and content_revision integer columns on kb_pages and
-- kb_articles. These back the (content, revision, ACL revision, model) uniqueness
-- criterion for idempotent ingestion replay.
-- NOTE: Drizzle schema files that must be updated by a second agent:
--   backend/src/db/schema/kb/pages.ts       — add aclRevision + contentRevision to kbPages
--   backend/src/db/schema/support/kb.ts     — same on kbArticles
--   backend/src/db/schema/support/kb-chunks.ts — same on kbArticleChunks
-- Until those schema files are updated, services reference these columns via
-- sql`` raw templates only.

SET lock_timeout = '5s';
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.search_kb_page_ids(p_q text, p_limit integer)
RETURNS SETOF integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
  SELECT p.id
  FROM public.kb_pages p
  WHERE p.org_id = app.current_org_id()
    AND p.deleted_at IS NULL
    AND p.fts @@ websearch_to_tsquery('english', p_q)
  LIMIT p_limit
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.search_kb_page_ids(text, integer) FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION app.search_kb_page_ids(text, integer) TO streamline_app;
--> statement-breakpoint

ALTER TABLE kb_pages
  ADD COLUMN IF NOT EXISTS acl_revision integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS content_revision integer NOT NULL DEFAULT 1;
--> statement-breakpoint

ALTER TABLE kb_articles
  ADD COLUMN IF NOT EXISTS acl_revision integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS content_revision integer NOT NULL DEFAULT 1;
--> statement-breakpoint

ALTER TABLE kb_article_chunks
  ADD COLUMN IF NOT EXISTS acl_revision integer,
  ADD COLUMN IF NOT EXISTS content_revision integer;
