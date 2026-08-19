-- 0424: restore index-backed ticket title search under RLS.
--
-- Search operators are not leakproof, so under an RLS security qual they can never become an index
-- condition: measured Seq Scan 12,036 buffers / 134.8ms as streamline_app vs Bitmap Index Scan
-- 16 buffers / 0.34ms as owner. ALTER FUNCTION ... LEAKPROOF is impossible on Neon (no superuser).
--
-- A SECURITY DEFINER function owned by the BYPASSRLS role is the remaining escape. Safety rests
-- here rather than in a policy: org comes from app.current_org_id() and never a parameter (fails
-- closed 42501), it returns ids only, the caller's query still runs under RLS with its DataScope,
-- and EXECUTE is revoked from PUBLIC.
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
