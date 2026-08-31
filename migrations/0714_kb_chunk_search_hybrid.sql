-- 0714: KB chunk search hybrid — ANN fast path with MATERIALIZED fence fallback.
--
-- Migration 0703 ships a MATERIALIZED CTE that is correct in all cases but
-- abandons the HNSW index entirely: measured at 22,680 buffers for a 7,500-row
-- tenant versus 258 buffers for the same tenant with plain ANN on semantically
-- clustered vectors (S07d.md).  Cost grows linearly with tenant size.
--
-- The hybrid replaces the unconditional fence with an ANN fast path first.
-- The SECURITY DEFINER + BYPASSRLS context means no RLS security barrier, so
-- org_id = v_org_id is a plain predicate the planner evaluates against heap
-- tuples fetched by the HNSW scan.  The planner still uses the HNSW index for
-- ORDER BY and post-filters by org_id — same as the original broken path — but
-- now we DETECT when that post-filter starves the result and fall back.
--
-- Algorithm:
--   1. Request p_limit * 5 (min 50) candidates from the HNSW index.
--   2. Count survivors after the org_id filter (v_fast_n).
--   3. If v_fast_n >= p_limit: fast path succeeded; return first p_limit.
--   4. Fetch the org's total chunk count (v_count).
--   5. If v_count <= v_fast_n: org has few rows; fast path returned everything.
--   6. Otherwise: v_fast_n < p_limit AND v_count > v_fast_n — under-retrieval
--      confirmed; fall back to the MATERIALIZED fence.
--
-- Detection cannot false-negative:
--   - The WHERE clause guarantees all returned rows belong to the org, so
--     v_fast_n can never exceed v_count.
--   - If v_fast_n >= p_limit, p_limit org rows genuinely appeared in the ANN
--     top candidates, and returning them is correct.
--   - If v_count <= v_fast_n, every org row was returned; no rows can be
--     missing.
--   - Only when v_fast_n < p_limit AND v_count > v_fast_n is it possible that
--     the ANN missed org rows — and in that branch the fence is invoked.
--
-- Five safety properties (unchanged from 0703):
--   1. org from app.current_org_id() inside the function — never a parameter
--      (fails closed 42501 when the GUC is absent).
--   2. returns ids only — never chunk content or embedding data.
--   3. caller's outer query runs under RLS with its own ACL predicates
--      (space membership, acl_revision gate, status, visibility).
--   4. EXECUTE revoked from PUBLIC, granted to streamline_app only.
--   5. p_limit bounds the SRF.

SET lock_timeout = '5s';
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.search_kb_chunk_ids(p_vec vector, p_limit integer)
RETURNS SETOF integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
DECLARE
  v_org_id text;
  v_boost  integer;
  v_fast   integer[];
  v_fast_n integer;
  v_count  bigint;
BEGIN
  v_org_id := app.current_org_id();
  v_boost  := GREATEST(p_limit * 5, 50);

  v_fast := ARRAY(
    SELECT id
    FROM public.kb_article_chunks
    WHERE org_id = v_org_id
    ORDER BY embedding <=> p_vec
    LIMIT v_boost
  );

  v_fast_n := COALESCE(array_length(v_fast, 1), 0);

  IF v_fast_n >= p_limit THEN
    RETURN QUERY SELECT unnest(v_fast[1:p_limit]);
    RETURN;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.kb_article_chunks
  WHERE org_id = v_org_id;

  IF v_count <= v_fast_n THEN
    RETURN QUERY SELECT unnest(v_fast);
    RETURN;
  END IF;

  RETURN QUERY
  WITH org_chunks AS MATERIALIZED (
    SELECT c.id, c.embedding
    FROM public.kb_article_chunks c
    WHERE c.org_id = v_org_id
  )
  SELECT id
  FROM org_chunks
  ORDER BY embedding <=> p_vec
  LIMIT p_limit;
END;
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.search_kb_chunk_ids(vector, integer) FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION app.search_kb_chunk_ids(vector, integer) TO streamline_app;
