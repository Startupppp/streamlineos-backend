-- 1227: SECURITY DEFINER id-only resolver for kb_pages full-text search,
-- taking an already-built tsquery rather than raw text.
--
-- Measured on production Aurora 2026-09-25, 100,000 kb_pages in one org,
-- EXPLAIN (ANALYZE, BUFFERS), fixtures planted inside a rolled-back
-- transaction:
--
--   as streamline_admin (BYPASSRLS)   375 buffers   1.4 ms   idx_kb_pages_fts USED
--   as streamline_app   (RLS live)  2,952 buffers  38.5 ms   idx_kb_pages_fts NOT used
--   as streamline_app, seqscan+indexscan off
--                                   4,649 buffers  72.7 ms   idx_kb_pages_fts NOT used
--
-- The kb_pages policy qual is
--   (org_id = app.current_org_id_or_null()) OR (public_token_hash = app.current_public_token_or_null())
-- and neither function is leakproof (pg_proc.proleakproof = false for both).
-- A non-leakproof security qual forbids promoting the user qual
-- `fts @@ <tsquery>` to an index condition, so the planner demotes it to a
-- Filter and idx_kb_pages_fts is unreachable from the application role. The
-- forced plan above confirms this: with both scan types disabled the planner
-- still refuses the GIN index and bitmap-scans an unrelated org_id index,
-- removing 99,911 rows by Filter.
--
-- ALTER FUNCTION ... LEAKPROOF is not available: it requires superuser and
-- streamline_admin has rolsuper = false on this cluster.
--
-- app.search_kb_page_ids(text, integer) (0498) already solves this for the
-- help-centre article surface, but it hardcodes websearch_to_tsquery, which
-- cannot express the `term:*` prefix terms that kbPagePrefixTsQuery builds for
-- type-ahead. Reusing it would silently narrow every prefix search to whole
-- words. This function takes the tsquery the application already built, so the
-- lexical semantics are unchanged and only the plan improves.
--
-- Safety properties (identical to 0453/0498/0703):
-- 1. org comes from app.current_org_id() inside the function — never a
--    parameter — so the call fails 42501 when the tenant GUC is absent.
-- 2. returns ids only — never title, content_text, fts or public_token_hash.
-- 3. the caller's outer query still runs under RLS with its own ACL predicate
--    (space membership, grants, status, visibility, deleted_at).
-- 4. EXECUTE revoked from PUBLIC, granted to streamline_app only.
-- 5. p_limit bounds the SRF; an unbounded SRF is materialised in full before
--    the caller's LIMIT applies.
-- 6. deleted_at IS NULL is applied inside the function, matching 0498, so a
--    soft-deleted page can never enter the candidate set.

SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('public.kb_pages') IS NULL THEN
    RAISE EXCEPTION '1227 precondition: public.kb_pages is absent — this is not a Knowledge database';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    WHERE i.indrelid = 'public.kb_pages'::regclass
      AND c.relname = 'idx_kb_pages_fts'
  ) THEN
    RAISE EXCEPTION '1227 precondition: idx_kb_pages_fts is absent — this resolver exists only to reach that index';
  END IF;
END $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.search_kb_page_ids_tsq(p_query tsquery, p_limit integer)
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
    AND p.fts @@ p_query
  LIMIT p_limit
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.search_kb_page_ids_tsq(tsquery, integer) FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION app.search_kb_page_ids_tsq(tsquery, integer) TO streamline_app;
