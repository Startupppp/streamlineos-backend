-- 0717: Restore app.search_kb_chunk_ids to SQL-language MATERIALIZED fence.
--
-- Migration 0714 rewrote this function in PL/pgSQL believing the ANN sub-query
-- inside the function would use the HNSW index. Measurement disproved this:
-- the planner sees an explicit WHERE org_id = v_org_id predicate with a precise
-- row-count estimate (from the org_id bitmap index), so it chooses a bitmap scan
-- + top-N heapsort rather than the HNSW graph. Both paths are correct but the
-- PL/pgSQL version adds unnecessary overhead (extra count query, function call
-- framing) and the conditional logic offers no real gain because the "fast path"
-- and the "fence" both end up doing the same bitmap scan of the org's rows.
--
-- Measurement (clustered and random fixtures, 30,000 rows, org-b 7,500):
--   0714 PL/pgSQL: ~22,000-23,000 buffers regardless of embedding distribution
--   0703 MATERIALIZED SQL: ~22,680 buffers regardless of embedding distribution
--
-- The real fast path comes from the SERVICE calling a plain ANN query under RLS
-- (no explicit org_id predicate → HNSW index used → ~258 buffers for semantically
-- clustered embeddings). The service detects under-retrieval and calls this fence.
-- Restoring the clean SQL function ensures the fence path is the minimal correct
-- fallback with no extra overhead.
--
-- Five safety properties remain unchanged from 0703:
--   1. org from app.current_org_id() inside the function — never a parameter.
--   2. returns ids only — never chunk content or embedding data.
--   3. caller's outer query runs under RLS with its own ACL predicates.
--   4. EXECUTE revoked from PUBLIC, granted to streamline_app only.
--   5. p_limit bounds the SRF.

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
