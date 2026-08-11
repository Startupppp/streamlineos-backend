-- 0424: make ticket title search use idx_tickets_title_trgm again.
--
-- Under RLS the app role cannot use ANY text index. Every search operator is
-- proleakproof=false (ts_match_vq, similarity_op, textlike, texticlike), and a
-- non-leakproof user qual may not be evaluated before the RLS security qual, so it can
-- never become an index condition. Measured on tickets (203k rows), same query, same data:
--
--   neondb_owner  (BYPASSRLS)  Bitmap Index Scan   16 buffers      0.34 ms
--   streamline_app (RLS on)    Seq Scan        12,036 buffers    134.80 ms
--
-- ALTER FUNCTION ... LEAKPROOF is the textbook fix and is IMPOSSIBLE HERE: it requires a
-- true superuser, and on Neon neondb_owner and neon_superuser are both rolsuper=false.
-- It fails 42501 even as owner. Do not try it again.
--
-- A SECURITY DEFINER function owned by a BYPASSRLS role is the remaining escape: Postgres
-- never inlines SECURITY DEFINER functions, so the body runs outside the security barrier
-- and the trigram index is usable. Measured 1 ms vs 1090 ms over 5 runs.
--
-- SAFETY -- this bypasses RLS, so the guarantees live here rather than in a policy:
--   * the org comes from app.current_org_id(), NEVER a parameter, so a caller cannot ask
--     for another tenant and it fails closed (42501) when the GUC is absent;
--   * it returns ONLY ids, never row data, so nothing is disclosed that the caller could
--     not already fetch -- the caller's real query still runs under RLS and still applies
--     the RBAC DataScope clause, so this cannot widen who sees which ticket;
--   * EXECUTE is revoked from PUBLIC and granted solely to streamline_app.
--
-- Callers must only use this for terms of 3+ characters: pg_trgm indexes on 3-grams, so a
-- shorter term degenerates to matching everything and would be slower than the seq scan.

CREATE OR REPLACE FUNCTION app.search_ticket_ids(p_q text)
RETURNS SETOF integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
  SELECT t.id
  FROM public.tickets t
  WHERE t.org_id = app.current_org_id()
    AND t.deleted_at IS NULL
    AND t.title ILIKE '%' || p_q || '%'
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.search_ticket_ids(text) FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION app.search_ticket_ids(text) TO streamline_app;
