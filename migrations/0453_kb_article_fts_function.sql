-- 0453: restore GIN-index-backed full-text search on kb_articles under RLS.
--
-- idx_kb_articles_fts is a GIN index on the generated `fts` tsvector column.
-- Under RLS the ts_match_vq operator is proleakproof=false, so the planner must
-- evaluate the security qual before the search qual and cannot use the index:
-- measured Seq Scan / ~80ms as streamline_app vs Bitmap Index Scan / 1.73ms
-- as the BYPASSRLS owner. ALTER FUNCTION ... LEAKPROOF is impossible on Neon
-- (no true superuser; neondb_owner/neon_superuser are rolsuper=false).
--
-- A SECURITY DEFINER function owned by the BYPASSRLS owner runs outside the
-- security barrier: the planner evaluates the search qual first and the GIN
-- index becomes usable again. Safety rests here rather than in a policy:
-- org comes from app.current_org_id() inside the function and never from a
-- parameter (fails closed 42501 with no GUC), returns ids only and never row
-- data, the caller's outer query still runs under RLS with its own access
-- restrictions (space membership, article restrictions, status filter), and
-- EXECUTE is revoked from PUBLIC.
--
-- The caller requests cap+1 ids. Getting cap+1 back means the term matches too
-- many articles to be worth an id list, so the caller falls back to the
-- original fts @@ tsquery condition (same pattern as 0425 on tickets).

SET lock_timeout = '5s';

CREATE OR REPLACE FUNCTION app.search_kb_article_ids(p_q text, p_limit integer)
RETURNS SETOF integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
  SELECT a.id
  FROM public.kb_articles a
  WHERE a.org_id = app.current_org_id()
    AND a.fts @@ websearch_to_tsquery('english', p_q)
  LIMIT p_limit
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.search_kb_article_ids(text, integer) FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION app.search_kb_article_ids(text, integer) TO streamline_app;
