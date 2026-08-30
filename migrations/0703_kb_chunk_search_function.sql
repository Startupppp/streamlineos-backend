-- 0703: SECURITY DEFINER ANN helper for kb_article_chunks.
--
-- Under RLS the org_id policy qual is a post-filter on HNSW candidates.
-- When a tenant's rows are a minority of the ANN neighbourhood the query
-- returns fewer than LIMIT results — measured 0 rows for org-b (7,500
-- chunks) when the 393 HNSW candidates were all from the 15,000-row
-- seed-org (HNSW1.md, 2026-08-30).
--
-- The SECURITY DEFINER + BYPASSRLS technique used for GIN/trgm on
-- search_kb_article_ids (0453) and search_kb_page_ids (0498) applies here:
-- without the security barrier, the planner is free to choose a sequential
-- scan of the org's rows rather than traversing the global HNSW graph and
-- post-filtering, so the LIMIT is satisfied from that tenant's vectors.
--
-- Safety properties (identical to 0453/0498):
-- 1. org comes from app.current_org_id() inside the function — never a
--    parameter — so the call fails 42501 when the GUC is absent.
-- 2. returns ids only — never chunk content or embedding data.
-- 3. the caller's outer query still runs under RLS with its own ACL
--    predicates (space membership, acl_revision gate, status, visibility).
-- 4. EXECUTE revoked from PUBLIC, granted to streamline_app only.
-- 5. p_limit bounds the SRF; an unbounded SRF is materialised in full
--    before the caller's LIMIT applies (434 ms vs 1 ms, measured 0425).

SET lock_timeout = '5s';
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.search_kb_chunk_ids(p_vec vector, p_limit integer)
RETURNS SETOF integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
  WITH org_chunks AS MATERIALIZED (
    SELECT c.id, c.embedding
    FROM public.kb_article_chunks c
    WHERE c.org_id = app.current_org_id()
  )
  SELECT id
  FROM org_chunks
  ORDER BY embedding <=> p_vec
  LIMIT p_limit
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.search_kb_chunk_ids(vector, integer) FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION app.search_kb_chunk_ids(vector, integer) TO streamline_app;
