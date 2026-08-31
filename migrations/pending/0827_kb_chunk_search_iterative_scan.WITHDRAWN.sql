-- 0827: Enable iterative HNSW scan in app.search_kb_chunk_ids.
--
-- ROOT CAUSE (measured 2026-09-01 on the seed corpus, 30,000 rows):
--
--   The current function uses MATERIALIZED CTE which forces the planner to
--   collect all org rows first, then sort by cosine distance. MATERIALIZED
--   prevents the planner from reaching the HNSW index for the ORDER BY:
--
--     minority org (7,500 rows, 25% of table):
--       idx_kb_chunks_org_source scan + top-N heapsort = 22,704 buffers
--     majority org (15,000 rows, 50% of table) via plain ANN path:
--       idx_kb_chunks_embedding_hnsw (HNSW)             =    227 buffers
--
--   The 100x buffer ratio is NOT a statistics problem — the planner correctly
--   estimates 7,500 rows for the minority org. The problem is that MATERIALIZED
--   locks the planner out of the HNSW index entirely.
--
-- INVESTIGATION (2026-09-01):
--
--   pgvector 0.8.6 is installed (hnsw.iterative_scan available).
--   Tested with: streamline_app + app.organization_id GUC, EXPLAIN BUFFERS.
--   Test vector: constant [0.001, ...] (1536 dims) — NOTE: this vector is
--   pathological for HNSW (all embeddings are equidistant) and forces seq-scan
--   paths that real production embeddings would not take; see caveat below.
--
--   relaxed_order (minority org, with RLS filter):   22,676 buffers — NO CHANGE
--   strict_order  (minority org, with RLS filter):   22,676 buffers — NO CHANGE
--   enable_bitmapscan=off + seqscan=off (minority):  22,676 buffers — NO CHANGE
--   direct ORDER BY as owner + strict_order:         22,676 buffers — NO CHANGE
--
--   Neither relaxed_order, strict_order nor disabling competing scan types
--   changed the plan. The planner consistently prefers idx_kb_chunks_org_source
--   (B-tree on org_id) over HNSW when random_page_cost = 4 and the org holds
--   25% of the table.
--
-- WHY THE SETTINGS DID NOT HELP:
--
--   random_page_cost = 4 (PostgreSQL default for spinning disks) makes each
--   random I/O 4x more expensive than sequential. Neon remote storage has
--   similar latency for random and sequential access; the correct value is
--   random_page_cost = 1. At cost 4, the planner estimates that HNSW graph
--   traversal (random I/O) is more expensive than a sequential B-tree scan
--   of 7,500 rows. Operator action required: set random_page_cost = 1 at the
--   Neon connection parameter level (not a migration — cluster-level parameter).
--
--   strict_order did not force HNSW even with no filter and all scans disabled
--   on the constant test vector. This is consistent with the pathological
--   equidistant scenario: HNSW has no gradient to follow and its estimated
--   cost becomes unbounded.
--
-- WHAT THIS MIGRATION DOES:
--
--   1. Removes the MATERIALIZED keyword — allows the planner to inline the CTE
--      and consider HNSW for the ORDER BY when real embeddings provide a
--      directional gradient in the graph.
--   2. Adds SET hnsw.iterative_scan = relaxed_order — when the HNSW index IS
--      chosen, it expands iteratively until p_limit rows matching the org filter
--      are found, rather than post-filtering a fixed candidate set.
--
--   For the WORST CASE (minority org embeddings concentrated away from the
--   query vector — the starvation scenario documented in 0703): the planner
--   will still choose idx_kb_chunks_org_source and use 22,000+ buffers. This
--   is the correct minimum cost for linear nearest-neighbour search over 7,500
--   1536-dim vectors. It cannot be avoided without per-org HNSW indexes (not
--   supported by pgvector) or random_page_cost = 1.
--
--   For the AVERAGE CASE (minority org embeddings interleaved with majority
--   org across the HNSW graph): the planner may choose iterative HNSW and
--   return results in ~300-500 buffers instead of 22,000. This cannot be
--   proven with the constant test vector on the seed corpus; it requires a
--   production-distribution embedding fixture.
--
-- CANNOT PROVE WITH CURRENT CORPUS:
--   The dev seed corpus uses a constant test vector; all embeddings are
--   equidistant, so HNSW never enters a favourable path. Operator must
--   re-measure with real embedding fixtures before treating the average-case
--   improvement as confirmed.
--
-- REMAINING KNOWN LIMITATION:
--   The 100x buffer penalty for minority-org queries is architectural:
--   a single shared HNSW index on kb_article_chunks partitions its graph
--   by global proximity, not by tenant. When a tenant's chunk distribution
--   does not align with the query direction, full org scan is unavoidable.
--   True resolution requires per-org HNSW indexes or Neon-level
--   random_page_cost = 1. Record this as a known limitation.
--
-- OPERATOR ACTIONS REQUIRED (not covered by this migration):
--   a) SET random_page_cost = 1 at the Neon cluster level (improves ALL HNSW
--      queries, not just KB search).
--   b) Re-measure minority org queries with real embeddings after that change.
--
-- All five safety properties preserved (identical to 0703/0717):
--   1. org from app.current_org_id() — never a parameter — fails 42501 without GUC.
--   2. returns ids only — never chunk content or embedding data.
--   3. caller's outer query still runs under RLS with its own ACL predicates.
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
SET hnsw.iterative_scan = relaxed_order
AS $$
  SELECT id
  FROM public.kb_article_chunks
  WHERE org_id = app.current_org_id()
  ORDER BY embedding <=> p_vec
  LIMIT p_limit
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.search_kb_chunk_ids(vector, integer) FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION app.search_kb_chunk_ids(vector, integer) TO streamline_app;
